const { Telegraf, Markup, session } = require("telegraf");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const qs = require("querystring");
const FormData = require("form-data");
const archiver = require("archiver");
const QRCode = require("qrcode");
const config = require("./config");
const { Client } = require('ssh2');
const { createdQris, cekStatus, toRupiah, getNevapediaWdMethods, createNevapediaWd, cekNevapediaWdStatus, getGatewayStatus, testNevapediaConnectivity, getNevapediaBalance } = require("./lib/payment");
const ExtAPI = require("./lib/externalApis");

const bot = new Telegraf(config.botToken);
bot.use(session());

// ================= SAFETY NET GLOBAL =================
// Payment itu kritikal — satu error tak tertangani di fitur MANAPUN (bahkan
// yang gak ada hubungannya sama sekali dengan payment) gak boleh sampai
// mematikan seluruh proses bot, karena itu berarti payment ikut mati juga.
// Node.js (v15+) defaultnya MEMATIKAN seluruh proses kalau ada promise
// rejection yang gak ditangkap .catch()-nya. Dua handler ini jadi jaring
// pengaman terakhir: log errornya, tapi proses tetap hidup.
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION] Bot tetap jalan, tapi ada promise yang gagal tanpa .catch():", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION] Bot tetap jalan, tapi ada error yang gak ketangkep try/catch:", err);
});

const randomEffectId = config.menuEffects[Math.floor(Math.random() * config.menuEffects.length)];

const globalNokos = {
  cachedServices: [],
  cachedCountries: {},
  lastServicePhoto: {},
  activeOrders: {}
};

function isPrivateChat(ctx) {
  return ctx.chat.type === 'private';
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readAutoReactDB() {
    try {
        if (!fs.existsSync(AUTO_REACT_DB)) {
            fs.writeFileSync(AUTO_REACT_DB, JSON.stringify({}));
            return {};
        }
        const data = fs.readFileSync(AUTO_REACT_DB, 'utf8');
        return JSON.parse(data || "{}");
    } catch (error) {
        console.error('[AUTO-REACT DB ERROR]', error);
        return {};
    }
}

// Fungsi untuk menyimpan database auto react
function saveAutoReactDB(data) {
    try {
        fs.writeFileSync(AUTO_REACT_DB, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('[AUTO-REACT SAVE ERROR]', error);
    }
}

// Fungsi untuk mendapatkan status auto react per grup
function getAutoReactStatus(chatId) {
    const db = readAutoReactDB();
    // Default: false (off) kecuali di-set true
    return db[chatId] === true;
}

// Fungsi untuk mengubah status auto react per grup
function setAutoReactStatus(chatId, status) {
    const db = readAutoReactDB();
    db[chatId] = status === true;
    saveAutoReactDB(db);
    return status;
}

// Daftar emoji yang akan digunakan untuk auto react
const autoReactEmojis = [
    '👍', '❤️', '🔥', '🎉', '😂', '😮', '😢', '🤔', '👏',
    '🙏', '🤣', '😍', '😎', '🤩', '🥳', '🤯', '😱', '🤗'
];

// Fungsi helper untuk efek typing
async function sendWithTyping(ctx, message, options = {}) {
  await ctx.sendChatAction('typing');
  await new Promise(resolve => setTimeout(resolve, options.delay || 300));
  
  if (options.photo) {
    return await ctx.replyWithPhoto(options.photo, {
      caption: message,
      parse_mode: options.parse_mode || "HTML",
      reply_markup: options.reply_markup
    });
  } else {
    return await ctx.reply(message, {
      parse_mode: options.parse_mode || "HTML",
      reply_markup: options.reply_markup
    });
  }
}

// Middleware untuk efek typing otomatis
bot.use(async (ctx, next) => {
  // Cek jika ini adalah callback query
  if (ctx.callbackQuery) {
    await ctx.sendChatAction('typing');
    // Delay kecil untuk efek yang lebih natural
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return next();
});

// Atau fungsi wrapper khusus untuk handler dengan efek typing
async function withTyping(handler) {
  return async (ctx) => {
    await ctx.sendChatAction('typing');
    await new Promise(resolve => setTimeout(resolve, 300));
    return handler(ctx);
  };
}

async function requirePrivateChat(ctx, actionName) {
  if (!isPrivateChat(ctx)) {
    await ctx.answerCbQuery("❌ Perintah ini hanya bisa digunakan di Private Chat!", { show_alert: true });
    
    try {
      await ctx.reply("🔒 Silakan gunakan di Private Chat:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💬 Chat Private", url: `https://t.me/${bot.botInfo.username}` }]
          ]
        }
      });
    } catch (e) {}
    
    return false;
  }
  return true;
}

function readTransactions() {
  if (!fs.existsSync(TRANSACTIONS_DB)) {
    fs.writeFileSync(TRANSACTIONS_DB, JSON.stringify([]));
  }
  return JSON.parse(fs.readFileSync(TRANSACTIONS_DB));
}

// Fungsi untuk menyimpan transaksi
function saveTransactions(data) {
  fs.writeFileSync(TRANSACTIONS_DB, JSON.stringify(data, null, 2));
}

// ==================================================================
// WISHLIST PRODUK HABIS
// User bisa "daftar notifikasi" di produk yang stoknya 0, otomatis
// di-DM begitu owner nambah stok (restock) produk itu.
// ==================================================================
const WISHLIST_DB = "./wishlist.json";
function readWishlist() {
  if (!fs.existsSync(WISHLIST_DB)) {
    fs.writeFileSync(WISHLIST_DB, JSON.stringify({}));
  }
  try {
    return JSON.parse(fs.readFileSync(WISHLIST_DB));
  } catch (e) {
    return {};
  }
}
// ==================================================================
// AUTO MODE "SEDANG ISTIRAHAT"
// ==================================================================
function isSleepingHours() {
  if (!config.sleepHours?.enabled) return false;
  const hour = new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta", hour: "numeric", hour12: false });
  const h = parseInt(hour) % 24;
  const { start, end } = config.sleepHours;
  if (start === end) return false;
  if (start < end) return h >= start && h < end;
  return h >= start || h < end; // rentang lewat tengah malam, misal 23-6
}



// ==================================================================
// PRODUK TRENDING OTOMATIS
// Dihitung dari transactions.json 7 hari terakhir, tanpa perlu owner
// set manual. Nama produk trending disamakan dengan pola "App: <nama> x<qty>".
// ==================================================================
/** Total unit terjual (sepanjang waktu) untuk satu nama produk, buat social proof di katalog. */
function getSoldCount(appName) {
  try {
    const all = readTransactions();
    return all.filter((t) => t.type === "app" && typeof t.itemName === "string" && t.itemName.startsWith(`App: ${appName} x`)).length;
  } catch (e) {
    return 0;
  }
}

function getTrendingAppNames(limit = 3) {
  try {
    const all = readTransactions();
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const counts = {};
    all
      .filter((t) => t.timestamp >= since && t.type === "app" && typeof t.itemName === "string")
      .forEach((t) => {
        const match = t.itemName.match(/^App:\s*(.+?)\s*x\d+$/);
        const name = match ? match[1] : t.itemName;
        counts[name] = (counts[name] || 0) + 1;
      });
    return Object.entries(counts)
      .filter(([, count]) => count >= 2) // minimal 2x kebeli baru dianggap "trending"
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name]) => name);
  } catch (e) {
    return [];
  }
}


function addToWishlist(appName, userId) {
  const wl = readWishlist();
  if (!wl[appName]) wl[appName] = [];
  if (!wl[appName].includes(userId)) wl[appName].push(userId);
  saveWishlist(wl);
}
function isInWishlist(appName, userId) {
  const wl = readWishlist();
  return (wl[appName] || []).includes(userId);
}
async function notifyWishlistRestock(appName, harga) {
  const wl = readWishlist();
  const waiters = wl[appName] || [];
  if (waiters.length === 0) return;

  for (const uid of waiters) {
    try {
      await bot.telegram.sendMessage(
        uid,
        `<blockquote>🔔 <b>Restock!</b>\n\n<b>${appName}</b> yang kamu tunggu sudah tersedia lagi!\n<b>Harga:</b> ${toRupiah(harga)}\n\nBuruan sebelum kehabisan lagi 👇</blockquote>`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🛒 Beli Sekarang", callback_data: "menu_apps" }]] } }
      );
    } catch (e) {
      console.error(`[WISHLIST] Gagal notif user ${uid}:`, e.message);
    }
  }

  delete wl[appName];
  saveWishlist(wl);
}


// Modifikasi fungsi recordTransaction untuk menerima parameter voucher:
function recordTransaction(userId, userName, itemName, amount, type, voucherCode = null) {
  try {
    const transactions = readTransactions();
    
    const newTransaction = {
      id: `trx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      userId,
      userName,
      itemName,
      amount,
      type,
      voucherCode: voucherCode || null, // Tambahkan field voucher
      timestamp: Date.now(),
      date: new Date().toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    };
    
    transactions.push(newTransaction);
    saveTransactions(transactions);
    
    return newTransaction;
  } catch (error) {
    console.error("[ERROR] Gagal mencatat transaksi:", error);
  }
}

function createSubdomainListText(domain, subdomainsList, currentPage, totalPages) {
  const itemsPerPage = 10;
  const startIndex = currentPage * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const pageItems = subdomainsList.slice(startIndex, endIndex);
  
  let text = `<blockquote><b>📋 DAFTAR SUBDOMAIN</b>\n\n` +
    `<b>Domain:</b> ${domain}\n` +
    `<b>Total:</b> ${subdomainsList.length} subdomain\n` +
    `<b>Halaman:</b> ${currentPage + 1}/${totalPages}\n\n`;
  
  pageItems.forEach((subdomain, index) => {
    const globalIndex = startIndex + index;
    const status = subdomain.proxied ? "🛡️ (Proxied)" : "🌐 (DNS Only)";
    const createdDate = new Date(subdomain.created).toLocaleDateString("id-ID");
    
    text += `<b>${globalIndex + 1}. ${subdomain.name}</b>\n` +
      `   <code>IP:</code> ${subdomain.ip}\n` +
      `   <code>TTL:</code> ${subdomain.ttl} | ${status}\n` +
      `   <code>Dibuat:</code> ${createdDate}\n\n`;
  });
  
  text += `</blockquote>`;
  return text;
}

function createSubdomainListKeyboard(currentPage, totalPages, domainIndex) {
  const buttons = [];
  
  // Tombol navigasi
  const navButtons = [];
  if (currentPage > 0) {
    navButtons.push({
      text: "⬅️ Prev",
      callback_data: `subdomain_page_${domainIndex}_${currentPage - 1}`
    });
  }
  
  navButtons.push({
    text: `${currentPage + 1}/${totalPages}`,
    callback_data: `subdomain_page_info`
  });
  
  if (currentPage < totalPages - 1) {
    navButtons.push({
      text: "Next ➡️",
      callback_data: `subdomain_page_${domainIndex}_${currentPage + 1}`
    });
  }
  
  if (navButtons.length > 0) {
    buttons.push(navButtons);
  }
  
  // Tombol aksi
  buttons.push([
    { text: "🌐 Buat Baru", callback_data: "menu_subdomain" }
  ]);
  
  buttons.push([
    { text: "🔙 Kembali ke List Domain", callback_data: "menu_list_subdomain" },
    { text: "🔙 Menu Owner", callback_data: "menu_owner" }
  ]);
  
  return buttons;
}

// Fungsi untuk mendapatkan statistik pemasukan
function getIncomeStats() {
  try {
    const transactions = readTransactions();
    
    const totalTransactions = transactions.length;
    const totalIncome = transactions.reduce((sum, trx) => sum + (parseInt(trx.amount) || 0), 0);
    
    // Hitung pendapatan hari ini
    const today = new Date().toLocaleDateString("id-ID");
    const todayTransactions = transactions.filter(trx => {
      const trxDate = new Date(trx.timestamp).toLocaleDateString("id-ID");
      return trxDate === today;
    });
    
    const todayIncome = todayTransactions.reduce((sum, trx) => sum + (parseInt(trx.amount) || 0), 0);
    const todayCount = todayTransactions.length;
    
    // Hitung pendapatan bulan ini
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();
    const monthTransactions = transactions.filter(trx => {
      const trxDate = new Date(trx.timestamp);
      return trxDate.getMonth() === currentMonth && trxDate.getFullYear() === currentYear;
    });
    
    const monthIncome = monthTransactions.reduce((sum, trx) => sum + (parseInt(trx.amount) || 0), 0);
    const monthCount = monthTransactions.length;
    
    return {
      totalTransactions,
      totalIncome,
      todayIncome,
      todayCount,
      monthIncome,
      monthCount,
      transactions // untuk debug jika perlu
    };
  } catch (error) {
    console.error("[ERROR] Gagal membaca statistik pemasukan:", error);
    return {
      totalTransactions: 0,
      totalIncome: 0,
      todayIncome: 0,
      todayCount: 0,
      monthIncome: 0,
      monthCount: 0
    };
  }
}

function getVoucherStats() {
  try {
    const vouchers = readVouchers();
    const now = Date.now();
    
    const activeVouchers = vouchers.filter(v => v.isActive);
    const expiredVouchers = vouchers.filter(v => !v.isActive);
    
    const expiredByDate = vouchers.filter(v => v.expiresAt && v.expiresAt < now);
    const maxUsesReached = vouchers.filter(v => v.maxUses !== -1 && v.usedCount >= v.maxUses);
    
    return {
      total: vouchers.length,
      active: activeVouchers.length,
      expired: expiredVouchers.length,
      expiredByDate: expiredByDate.length,
      maxUsesReached: maxUsesReached.length,
      totalUses: vouchers.reduce((sum, v) => sum + v.usedCount, 0),
      canBeCleaned: expiredByDate.length + maxUsesReached.length
    };
  } catch (error) {
    console.error("[ERROR] Gagal mendapatkan statistik voucher:", error);
    return {
      total: 0,
      active: 0,
      expired: 0,
      expiredByDate: 0,
      maxUsesReached: 0,
      totalUses: 0,
      canBeCleaned: 0
    };
  }
}

function readVouchers() {
  if (!fs.existsSync(VOUCHERS_DB)) {
    fs.writeFileSync(VOUCHERS_DB, JSON.stringify([]));
  }
  return JSON.parse(fs.readFileSync(VOUCHERS_DB));
}

function saveVouchers(data) {
  fs.writeFileSync(VOUCHERS_DB, JSON.stringify(data, null, 2));
}

function generateVoucherCode(length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function sendVoucherUsedNotification(voucherCode, userId, userName, productName, discountAmount) {
  try {
    if (!config.ownerId) return;
    
    const timestamp = new Date().toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    
    // Baca voucher untuk mendapatkan informasi terbaru
    const vouchers = readVouchers();
    const voucher = vouchers.find(v => v.code === voucherCode);
    
    if (!voucher) {
      console.error(`[ERROR] Voucher ${voucherCode} tidak ditemukan di database`);
      return;
    }
    
    const message = `
💰 <b>VOUCHER BERHASIL DIGUNAKAN!</b>

<b>Kode Voucher:</b> <code>${voucherCode}</code>
<b>User:</b> ${userName} (${userId})
<b>Produk:</b> ${productName}
<b>Diskon:</b> ${toRupiah(discountAmount)}
<b>Sisa Penggunaan:</b> ${voucher.maxUses === -1 ? 'Unlimited' : `${voucher.maxUses - voucher.usedCount} kali`}
<b>Waktu:</b> ${timestamp}

<b>🎉 User berhasil mendapatkan diskon!</b>
    `.trim();
    
    await bot.telegram.sendMessage(config.ownerId, message, {
      parse_mode: "HTML"
    });
    
    console.log(`[NOTIF] Notifikasi penggunaan voucher berhasil dikirim ke owner`);
    
  } catch (error) {
    console.error("[ERROR] Gagal mengirim notifikasi penggunaan voucher:", error.message);
  }
}

async function sendVoucherNotificationToChannel(voucher, isNew = true) {
  try {
    if (!config.testimoniChannel || !config.testimoniChannel.trim()) {
      console.log("[INFO] Channel testimoni belum diatur di config.js");
      return;
    }

    const channel = config.testimoniChannel;
    const timestamp = new Date().toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });

    const escapeHTML = (text) => {
      if (!text) return "-";
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    };

    // Buat caption untuk notifikasi voucher
    let caption = "";
    if (isNew) {
      caption = `🎉 <b>VOUCHER BARU DIBUAT!</b>\n\n`;
    } else {
      caption = `📢 <b>VOUCHER TERSEDIA!</b>\n\n`;
    }

    caption += `🎫 <b>KODE VOUCHER:</b> <code>${escapeHTML(voucher.code)}</code>\n`;
    caption += `📊 <b>TIPE:</b> ${voucher.type === 'percentage' ? 'PERCENTAGE' : 'FIXED'}\n`;
    caption += `💰 <b>NILAI:</b> ${voucher.type === 'percentage' ? `${voucher.value}%` : toRupiah(voucher.value)}\n`;
    caption += `📈 <b>MAKS PENGGUNAAN:</b> ${voucher.maxUses === -1 ? 'Unlimited' : `${voucher.maxUses} kali`}\n`;
    
    if (voucher.expiresAt) {
      caption += `📅 <b>KADALUARSA:</b> ${new Date(voucher.expiresAt).toLocaleString('id-ID')}\n`;
    } else {
      caption += `📅 <b>KADALUARSA:</b> Tidak ada\n`;
    }
    
    caption += `🔄 <b>TERPAKAI:</b> ${voucher.usedCount} kali\n`;
    caption += `⏰ <b>WAKTU:</b> ${escapeHTML(timestamp)}\n\n`;
    
    caption += `💡 <b>CARA PAKAI:</b>\n`;
    caption += `1. Beli produk apapun di bot\n`;
    caption += `2. Pilih "Gunakan Voucher"\n`;
    caption += `3. Masukkan kode di atas\n`;
    caption += `4. Dapatkan diskon langsung!\n\n`;
    
    caption += `🎁 <b>Diskon berlaku untuk semua produk!</b>`;

    // Buat inline keyboard dengan tombol ke bot
    const inlineKeyboard = [[
      { 
        text: `🛒 Beli di ${config.botName || "Bot"}`, 
        url: `https://t.me/${bot.botInfo.username}`
      }
    ]];

    // Kirim foto dengan caption ke channel
    if (config.startDoneVoucher) {
      await bot.telegram.sendPhoto(channel, config.startDoneVoucher, {
        caption: caption,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: inlineKeyboard }
      });
    } else {
      // Jika foto tidak tersedia, kirim teks saja
      await bot.telegram.sendMessage(channel, caption, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: inlineKeyboard }
      });
    }

    console.log(`[NOTIF] Notifikasi voucher berhasil dikirim ke channel`);

  } catch (error) {
    console.error("[ERROR] Gagal mengirim notifikasi voucher ke channel:", error.message);
  }
}

async function sendVoucherNotificationToOwner(voucher, isNew = true) {
  try {
    const ownerId = config.ownerId;
    const timestamp = new Date().toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });

    // Buat pesan untuk owner
    let message = "";
    if (isNew) {
      message = `✅ <b>VOUCHER BARU BERHASIL DIBUAT!</b>\n\n`;
    } else {
      message = `📢 <b>VOUCHER TELAH DI-BROADCAST!</b>\n\n`;
    }

    message += `🎫 <b>KODE:</b> <code>${voucher.code}</code>\n`;
    message += `📊 <b>TIPE:</b> ${voucher.type === 'percentage' ? 'PERCENTAGE' : 'FIXED'}\n`;
    message += `💰 <b>NILAI:</b> ${voucher.type === 'percentage' ? `${voucher.value}%` : toRupiah(voucher.value)}\n`;
    message += `📈 <b>MAKS PENGGUNAAN:</b> ${voucher.maxUses === -1 ? 'Unlimited' : `${voucher.maxUses} kali`}\n`;
    
    if (voucher.expiresAt) {
      message += `📅 <b>KADALUARSA:</b> ${new Date(voucher.expiresAt).toLocaleString('id-ID')}\n`;
    }
    
    message += `🔄 <b>TERPAKAI:</b> ${voucher.usedCount} kali\n`;
    message += `⏰ <b>DIBUAT:</b> ${new Date(voucher.createdAt).toLocaleString('id-ID')}\n`;
    message += `📢 <b>NOTIFIKASI:</b> ${timestamp}\n\n`;
    
    message += `📊 <b>STATUS:</b> ${voucher.isActive ? '🟢 AKTIF' : '🔴 NONAKTIF'}\n\n`;
    
    if (isNew) {
      message += `🎯 <b>AKSI:</b>\n`;
      message += `• Notifikasi telah dikirim ke channel\n`;
      message += `• Voucher siap digunakan user\n`;
    } else {
      message += `📤 <b>BROADCAST:</b>\n`;
      message += `• Voucher telah dikirim ke semua user\n`;
      message += `• User dapat langsung menggunakan\n`;
    }

    // Buat tombol inline untuk owner
    const inlineKeyboard = [[
      { 
        text: `🤖 ${config.botName || "Bot"}`, 
        url: `https://t.me/${bot.botInfo.username}`
      }
    ]];

    // Kirim pesan dengan tombol ke owner
    await bot.telegram.sendMessage(ownerId, message, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: inlineKeyboard }
    });

    console.log(`[NOTIF] Notifikasi voucher berhasil dikirim ke owner`);

  } catch (error) {
    console.error("[ERROR] Gagal mengirim notifikasi voucher ke owner:", error.message);
  }
}

async function createVoucher(type, value, maxUses = 1, expiresAt = null) {
  try {
    const vouchers = readVouchers();
    
    const voucher = {
      id: `vc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      code: generateVoucherCode(),
      type: type,
      value: value,
      maxUses: maxUses,
      usedCount: 0,
      expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
      createdAt: Date.now(),
      createdBy: config.ownerId,
      isActive: true
    };
    
    vouchers.push(voucher);
    saveVouchers(vouchers);
    
    // Kirim notifikasi ke channel dan owner
    setTimeout(async () => {
      try {
        await sendVoucherNotificationToChannel(voucher, true);
        await sendVoucherNotificationToOwner(voucher, true);
      } catch (notifError) {
        console.error("[ERROR] Gagal mengirim notifikasi voucher:", notifError.message);
      }
    }, 1000); // Delay 1 detik untuk memastikan voucher sudah tersimpan
    
    return voucher;
  } catch (error) {
    console.error("[ERROR] Gagal membuat voucher:", error);
    return null;
  }
}

function validateVoucher(code, nominal) {
  try {
    const vouchers = readVouchers();
    const now = Date.now();
    
    const voucher = vouchers.find(v => 
      v.code === code.toUpperCase() && 
      v.isActive === true &&
      v.usedCount < v.maxUses &&
      (!v.expiresAt || v.expiresAt > now)
    );
    
    if (!voucher) {
      return { valid: false, message: "❌ Voucher tidak valid atau sudah kadaluarsa!" };
    }
    
    let discount = 0;
    let finalPrice = nominal;
    
    if (voucher.type === 'percentage') {
      discount = Math.floor((nominal * voucher.value) / 100);
      finalPrice = nominal - discount;
    } else if (voucher.type === 'fixed') {
      discount = Math.min(voucher.value, nominal);
      finalPrice = nominal - discount;
    }
    
    if (finalPrice < 0) finalPrice = 0;
    
    return {
      valid: true,
      voucher: voucher, // Mengembalikan objek voucher lengkap
      discount: discount,
      finalPrice: finalPrice,
      message: `✅ Voucher berhasil digunakan! Potongan: ${toRupiah(discount)}`
    };
  } catch (error) {
    console.error("[ERROR] Gagal validasi voucher:", error);
    return { valid: false, message: "❌ Error validasi voucher!" };
  }
}

function useVoucher(voucherId, userId = null, userName = null, productName = null) {
  try {
    const vouchers = readVouchers();
    const voucherIndex = vouchers.findIndex(v => v.id === voucherId);
    
    if (voucherIndex === -1) return false;
    
    const voucher = vouchers[voucherIndex];
    
    // Hitung jumlah discount untuk notifikasi
    let discountAmount = 0;
    if (productName) {
      // Ini hanya untuk notifikasi, perhitungan sebenarnya di validateVoucher
      discountAmount = voucher.type === 'percentage' ? 
        (voucher.value / 100) * 10000 : // Contoh nominal untuk notifikasi
        voucher.value;
    }
    
    // Update penggunaan - INI YANG DIHAPUS DARI SINI
    // Penggunaan akan diupdate di fungsi handlePayment saat pembayaran sukses
    
    // Simpan perubahan (tanpa perubahan usedCount di sini)
    saveVouchers(vouchers);
    
    return true;
  } catch (error) {
    console.error("[ERROR] Gagal menggunakan voucher:", error);
    return false;
  }
}

function incrementVoucherUsage(voucherId, userId = null, userName = null, productName = null) {
  try {
    const vouchers = readVouchers();
    const voucherIndex = vouchers.findIndex(v => v.id === voucherId);
    
    if (voucherIndex === -1) {
      console.error(`[ERROR] Voucher dengan ID ${voucherId} tidak ditemukan`);
      return false;
    }
    
    const voucher = vouchers[voucherIndex];
    
    // Update penggunaan - HANYA DI SINI setelah pembayaran sukses
    vouchers[voucherIndex].usedCount += 1;
    
    // Jika sudah mencapai maksimal penggunaan, nonaktifkan
    if (vouchers[voucherIndex].usedCount >= vouchers[voucherIndex].maxUses && vouchers[voucherIndex].maxUses !== -1) {
      vouchers[voucherIndex].isActive = false;
      console.log(`[INFO] Voucher ${voucher.code} dinonaktifkan karena mencapai batas penggunaan`);
    }
    
    saveVouchers(vouchers);
    
    // Kirim notifikasi ke owner jika ada informasi user
    if (userId && userName && productName) {
      setTimeout(async () => {
        try {
          // Hitung discount untuk notifikasi
          let discountAmount = 0;
          if (voucher.type === 'percentage') {
            discountAmount = Math.floor((10000 * voucher.value) / 100); // Contoh perhitungan
          } else {
            discountAmount = voucher.value;
          }
          
          await sendVoucherUsedNotification(voucher.code, userId, userName, productName, discountAmount);
        } catch (notifError) {
          console.error("[ERROR] Gagal mengirim notifikasi penggunaan voucher:", notifError.message);
        }
      }, 1000);
    }
    
    console.log(`[INFO] Penggunaan voucher ${voucher.code} bertambah menjadi ${vouchers[voucherIndex].usedCount}`);
    return true;
  } catch (error) {
    console.error("[ERROR] Gagal menambah penggunaan voucher:", error);
    return false;
  }
}

async function broadcastVoucherToAllUsers(voucher) {
  try {
    const users = loadUsers();
    let sentCount = 0;
    
    const broadcastMessage = `
🎉 <b>VOUCHER BARU TERSEDIA!</b>

<b>Kode Voucher:</b> <code>${voucher.code}</code>
<b>Tipe:</b> ${voucher.type === 'percentage' ? `${voucher.value}%` : `Rp ${voucher.value.toLocaleString()}`}
<b>Maksimal Penggunaan:</b> ${voucher.maxUses === -1 ? 'Unlimited' : `${voucher.maxUses} kali`}
${voucher.expiresAt ? `<b>Kadaluarsa:</b> ${new Date(voucher.expiresAt).toLocaleString('id-ID')}` : ''}

<b>Cara pakai:</b> Pilih "Gunakan Voucher" saat checkout!
<b>Berlaku untuk semua produk!</b>

Segera gunakan sebelum kadaluarsa! 🛒
    `.trim();
    
    for (const userId of users) {
      try {
        await bot.telegram.sendMessage(userId, broadcastMessage, {
          parse_mode: "HTML"
        });
        sentCount++;
        
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        continue;
      }
    }
    
    // Kirim notifikasi ke channel dan owner setelah broadcast
    setTimeout(async () => {
      try {
        await sendVoucherNotificationToChannel(voucher, false);
        await sendVoucherNotificationToOwner(voucher, false);
      } catch (notifError) {
        console.error("[ERROR] Gagal mengirim notifikasi broadcast voucher:", notifError.message);
      }
    }, 1000);
    
    return sentCount;
  } catch (error) {
    console.error("[ERROR] Gagal broadcast voucher:", error);
    return 0;
  }
}

function deleteVoucher(voucherId) {
  try {
    const vouchers = readVouchers();
    const initialLength = vouchers.length;
    
    // Filter untuk menghapus voucher dengan ID tertentu
    const filteredVouchers = vouchers.filter(v => v.id !== voucherId);
    
    if (filteredVouchers.length === initialLength) {
      return { success: false, message: "Voucher tidak ditemukan!" };
    }
    
    saveVouchers(filteredVouchers);
    
    return { 
      success: true, 
      message: "Voucher berhasil dihapus!",
      deletedCount: initialLength - filteredVouchers.length
    };
  } catch (error) {
    console.error("[ERROR] Gagal menghapus voucher:", error);
    return { success: false, message: "Error sistem saat menghapus voucher!" };
  }
}

function deleteVoucherByCode(voucherCode) {
  try {
    const vouchers = readVouchers();
    const initialLength = vouchers.length;
    
    // Filter untuk menghapus voucher dengan kode tertentu
    const filteredVouchers = vouchers.filter(v => v.code !== voucherCode.toUpperCase());
    
    if (filteredVouchers.length === initialLength) {
      return { success: false, message: "Voucher dengan kode tersebut tidak ditemukan!" };
    }
    
    saveVouchers(filteredVouchers);
    
    return { 
      success: true, 
      message: "Voucher berhasil dihapus!",
      deletedCount: initialLength - filteredVouchers.length
    };
  } catch (error) {
    console.error("[ERROR] Gagal menghapus voucher by code:", error);
    return { success: false, message: "Error sistem saat menghapus voucher!" };
  }
}

async function createMuridPanelAccount(username, email, password, panelType, panelCategory, duration) {
  try {
    let domain, apikey;
    
    // Tentukan konfigurasi berdasarkan kategori dan tipe panel
    if (panelCategory === "OWNERPANEL") {
      if (panelType === "private") {
        domain = config.muridPanel?.OWNERPANEL?.private?.domain;
        apikey = config.muridPanel?.OWNERPANEL?.private?.apikey;
      } else if (panelType === "public") {
        domain = config.muridPanel?.OWNERPANEL?.public?.domain;
        apikey = config.muridPanel?.OWNERPANEL?.public?.apikey;
      }
    } else if (panelCategory === "PTPANEL") {
      if (panelType === "private") {
        domain = config.muridPanel?.PTPANEL?.private?.domain;
        apikey = config.muridPanel?.PTPANEL?.private?.apikey;
      } else if (panelType === "public") {
        domain = config.muridPanel?.PTPANEL?.public?.domain;
        apikey = config.muridPanel?.PTPANEL?.public?.apikey;
      }
    }
    
    if (!domain || !apikey) {
      return { success: false, msg: "Konfigurasi panel tidak ditemukan!" };
    }
    
    const headers = {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apikey}`
    };
    
    // Buat akun student/murid
    const userRes = await axios.post(`${domain}/api/application/users`, {
      email: email,
      username: username.toLowerCase(),
      first_name: username,
      last_name: "Student",
      language: "en",
      password: password,
      root_admin: false  // Bukan admin, hanya student
    }, { headers });
    
    const user = userRes.data.attributes;
    
    // Berikan permissions student (terbatas)
    await axios.post(`${domain}/api/application/users/${user.id}/permissions`, {
      permissions: ["user", "server.create", "server.view-own"] // Hak akses terbatas
    }, { headers });
    
    return { 
      success: true, 
      data: { 
        username: user.username, 
        email: user.email,
        password: password,
        login: domain,
        panelCategory: panelCategory,
        panelType: panelType,
        duration: duration,
        expires: duration === "permanen" ? "Permanen" : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString("id-ID")
      } 
    };
    
  } catch (error) {
    console.error("Error creating murid panel:", error.response?.data || error.message);
    return { 
      success: false, 
      msg: error.response?.data?.errors?.[0]?.detail || error.message || "Gagal membuat akun murid panel" 
    };
  }
}

async function sendProductNotification(type, productData, addedBy) {
  try {
    if (!config.testimoniChannel || !config.testimoniChannel.trim()) {
      console.log("[INFO] Channel testimoni belum diatur di config.js");
      return;
    }

    const channel = config.testimoniChannel;
    const timestamp = new Date().toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });

    let caption = "";
    let inlineKeyboard = [];

    const escapeHTML = (text) => {
      if (!text) return "-";
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    };

    // =========================
    // 📦 SCRIPT
    // =========================
    if (type === "script") {
      caption =
        `🎉 <b>PRODUK BARU DITAMBAHKAN!</b>\n\n` +
        `📦 <b>TIPE:</b> 📁 SCRIPT\n` +
        `📛 <b>NAMA:</b> ${escapeHTML(productData.nama)}\n` +
        `💰 <b>HARGA:</b> ${toRupiah(productData.harga)}\n` +
        `📄 <b>FILE:</b> ${escapeHTML(productData.fileName || "-")}\n\n` +
        `👤 <b>DITAMBAHKAN OLEH:</b> ${escapeHTML(addedBy)}\n` +
        `🕒 <b>WAKTU:</b> ${escapeHTML(timestamp)}\n\n` +
        `🛒 <b>Beli sekarang di bot:</b> @${bot.botInfo.username}`;

      inlineKeyboard = [[
        { text: "🛒 Beli Script", url: `https://t.me/${bot.botInfo.username}?start=shop` }
      ]];
    }

    // =========================
    // 📱 APP
    // =========================
    else if (type === "app") {
      caption =
        `🎉 <b>PRODUK BARU DITAMBAHKAN!</b>\n\n` +
        `📦 <b>TIPE:</b> 📱 APP PREMIUM\n` +
        `📛 <b>NAMA:</b> ${escapeHTML(productData.nama)}\n` +
        `💰 <b>HARGA:</b> ${toRupiah(productData.harga)}\n` +
        `📝 <b>DESKRIPSI:</b> ${escapeHTML(productData.deskripsi || "-")}\n` +
        `📊 <b>STOK:</b> ${(productData.accounts || []).length} akun\n\n` +
        `👤 <b>DITAMBAHKAN OLEH:</b> ${escapeHTML(addedBy)}\n` +
        `🕒 <b>WAKTU:</b> ${escapeHTML(timestamp)}\n\n` +
        `🛒 <b>Beli sekarang di bot:</b> @${bot.botInfo.username}`;

      inlineKeyboard = [[
        { text: "🛒 Beli App", url: `https://t.me/${bot.botInfo.username}?start=shop` }
      ]];
    }

    // =========================
    // 👤 AKUN
    // =========================
    else if (type === "account") {
      caption =
        `🎉 <b>STOK AKUN DITAMBAHKAN!</b>\n\n` +
        `📦 <b>UNTUK APP:</b> ${escapeHTML(productData.appName)}\n` +
        `📝 <b>DESKRIPSI:</b> ${escapeHTML(productData.desc || "-")}\n\n` +
        `📊 <b>STOK SEKARANG:</b> ${productData.newStock} akun\n` +
        `👤 <b>DITAMBAHKAN OLEH:</b> ${escapeHTML(addedBy)}\n` +
        `🕒 <b>WAKTU:</b> ${escapeHTML(timestamp)}\n\n` +
        `🛒 <b>Beli sekarang di bot:</b> @${bot.botInfo.username}`;

      inlineKeyboard = [[
        { text: "🛒 Beli App", url: `https://t.me/${bot.botInfo.username}?start=shop` }
      ]];
    } else {
      return;
    }

    // =========================
    // 🖼️ KIRIM FOTO + CAPTION
    // =========================
    await bot.telegram.sendPhoto(channel, config.startProduk, {
      caption,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: inlineKeyboard }
    });

    console.log(`[NOTIF] Produk ${type} berhasil dikirim ke channel`);

  } catch (error) {
    console.error("[ERROR] Gagal mengirim notifikasi produk:", error.message);
  }
}

async function checkDigitalOceanAccountStatus(apiKey) {
  try {
    if (!apiKey || apiKey === "-") {
      return { 
        success: false, 
        message: "API KEY tidak valid",
        account: null
      };
    }

    // 1. Cek status akun dengan endpoint account
    const accountResponse = await axios.get("https://api.digitalocean.com/v2/account", {
      headers: { 
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      timeout: 10000
    });

    if (accountResponse.status !== 200) {
      return { 
        success: false, 
        message: "Gagal mengambil data akun",
        account: null
      };
    }

    const accountData = accountResponse.data.account;
    
    // 2. Cek jumlah droplets
    const dropletsResponse = await axios.get("https://api.digitalocean.com/v2/droplets", {
      headers: { 
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      timeout: 10000
    });

    const totalDroplets = dropletsResponse.data.meta?.total || 0;
    const droplets = dropletsResponse.data.droplets || [];
    
    // 3. Hitung droplets yang aktif
    const activeDroplets = droplets.filter(d => d.status === "active").length;
    
    // 4. Cek limit droplet
    const dropletLimit = accountData.droplet_limit || 0;
    const availableDroplets = Math.max(0, dropletLimit - totalDroplets);
    
    return {
      success: true,
      message: "Status akun berhasil diambil",
      account: {
        email: accountData.email || "N/A",
        uuid: accountData.uuid || "N/A",
        status: accountData.status || "N/A",
        emailVerified: accountData.email_verified || false,
        dropletLimit: dropletLimit,
        floatingIPLimit: accountData.floating_ip_limit || 0,
        statusEmoji: accountData.status === "active" ? "🟢" : "🔴",
        emailVerifiedEmoji: accountData.email_verified ? "✅" : "❌",
        totalDroplets: totalDroplets,
        activeDroplets: activeDroplets,
        availableDroplets: availableDroplets,
        droplets: droplets.slice(0, 5) // Ambil 5 droplet pertama untuk preview
      }
    };
    
  } catch (error) {
    console.error("Error checking DO account status:", error.message);
    
    if (error.response) {
      if (error.response.status === 401) {
        return { 
          success: false, 
          message: "API KEY tidak valid atau expired",
          account: null
        };
      } else if (error.response.status === 403) {
        return { 
          success: false, 
          message: "Akses ditolak. Pastikan API KEY memiliki permission yang cukup",
          account: null
        };
      } else if (error.response.status === 429) {
        return { 
          success: false, 
          message: "Rate limit exceeded. Coba lagi nanti",
          account: null
        };
      }
    }
    
    return { 
      success: false, 
      message: error.message || "Gagal menghubungi API DigitalOcean",
      account: null
    };
  }
}

async function getAllDroplets() {
  try {
    const apiDO = config.ApiDO1;
    if (!apiDO || apiDO === "-") {
      return { success: false, message: "API KEY DigitalOcean tidak ditemukan!" };
    }

    const response = await axios.get("https://api.digitalocean.com/v2/droplets", {
      headers: { 
        "Authorization": `Bearer ${apiDO}`,
        "Content-Type": "application/json"
      },
      timeout: 15000
    });

    if (response.data && response.data.droplets) {
      return { 
        success: true, 
        droplets: response.data.droplets,
        total: response.data.meta.total
      };
    } else {
      return { success: false, message: "Tidak ada droplet ditemukan" };
    }
    
  } catch (error) {
    console.error("Error fetching droplets:", error.message);
    return { 
      success: false, 
      message: error.response?.data?.message || error.message || "Unknown error" 
    };
  }
}

async function getDropletDetails(dropletId) {
  try {
    const apiDO = config.ApiDO1;
    if (!apiDO || apiDO === "-") {
      return { success: false, message: "API KEY DigitalOcean tidak ditemukan!" };
    }

    const response = await axios.get(`https://api.digitalocean.com/v2/droplets/${dropletId}`, {
      headers: { 
        "Authorization": `Bearer ${apiDO}`,
        "Content-Type": "application/json"
      },
      timeout: 10000
    });

    if (response.data && response.data.droplet) {
      return { 
        success: true, 
        droplet: response.data.droplet
      };
    } else {
      return { success: false, message: "Droplet tidak ditemukan" };
    }
    
  } catch (error) {
    console.error("Error fetching droplet details:", error.message);
    return { 
      success: false, 
      message: error.response?.data?.message || error.message || "Unknown error" 
    };
  }
}

async function deleteDroplet(dropletId) {
  try {
    const apiDO = config.ApiDO1;
    if (!apiDO || apiDO === "-") {
      return { success: false, message: "API KEY DigitalOcean tidak ditemukan!" };
    }

    const response = await axios.delete(`https://api.digitalocean.com/v2/droplets/${dropletId}`, {
      headers: { 
        "Authorization": `Bearer ${apiDO}`,
        "Content-Type": "application/json"
      },
      timeout: 15000
    });

    if (response.status === 204) {
      return { success: true, message: "Droplet berhasil dihapus!" };
    } else {
      return { success: false, message: "Gagal menghapus droplet" };
    }
    
  } catch (error) {
    console.error("Error deleting droplet:", error.message);
    return { 
      success: false, 
      message: error.response?.data?.message || error.message || "Unknown error" 
    };
  }
}

function formatDropletInfo(droplet) {
  const ipv4 = droplet.networks?.v4?.find(ip => ip.type === "public")?.ip_address || "N/A";
  const ipv6 = droplet.networks?.v6?.find(ip => ip.type === "public")?.ip_address || "N/A";
  
  const created = new Date(droplet.created_at).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
  
  const statusEmoji = droplet.status === "active" ? "🟢" : 
                     droplet.status === "off" ? "🔴" : 
                     droplet.status === "new" ? "🟡" : "⚪";
  
  return {
    id: droplet.id,
    name: droplet.name,
    ipv4: ipv4,
    ipv6: ipv6,
    region: droplet.region?.name || droplet.region?.slug || "N/A",
    size: droplet.size?.slug || "N/A",
    memory: droplet.memory || 0,
    vcpus: droplet.vcpus || 0,
    disk: droplet.disk || 0,
    image: droplet.image?.distribution + " " + droplet.image?.name || "N/A",
    status: droplet.status,
    statusEmoji: statusEmoji,
    created: created,
    tags: droplet.tags || []
  };
}

async function getDropletCount() {
  try {
    const apiDO = config.ApiDO1;
    if (!apiDO || apiDO === "-") return 0;

    const res = await axios.get("https://api.digitalocean.com/v2/droplets", {
      headers: { Authorization: `Bearer ${apiDO}` }
    });

    return res.data.droplets?.length || 0;
  } catch (e) {
    console.error("Error checking droplet count:", e.message);
    return 0;
  }
}

async function createVPSDroplet(userId, vpsData) {
  try {
    const apiDO = config.ApiDO1;
    if (!apiDO) {
      return { success: false, msg: "API KEY DigitalOcean tidak ditemukan!" };
    }

    const sizeMap = {
      "2c2": "s-2vcpu-2gb-amd",
      "4c2": "s-2vcpu-4gb-amd",
      "8c4": "s-4vcpu-8gb-amd",
      "16c4": "s-4vcpu-16gb-amd",
      "16c8": "s-8vcpu-16gb-amd"
    };

    const size = sizeMap[vpsData.plan];
    if (!size) {
      return { success: false, msg: "PLAN VPS TIDAK VALID!" };
    }

    const osShort = (vpsData.osFamily || "ubuntu").toLowerCase();
    const regionShort = (vpsData.region || "sgp1").toLowerCase();
    const planShort = (vpsData.plan || "2c2").toLowerCase();
    const urut = String(Math.floor(Math.random() * 90) + 10);
    const hostname = `${osShort}-${planShort}-${regionShort}-${urut}`;
    const password = "RAFAXBILA#" + size.replace(/s-|-/g, "").toUpperCase();

    const payload = {
      name: hostname,
      region: vpsData.region,
      size: size,
      image: vpsData.os,
      ipv6: true,
      backups: false,
      tags: ["RafatharCode404"],
      user_data: `#cloud-config
password: ${password}
chpasswd: { expire: False }`
    };

    console.log("Creating VPS with payload:", JSON.stringify(payload, null, 2));

    const resp = await axios.post("https://api.digitalocean.com/v2/droplets", payload, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiDO}`
      },
      timeout: 30000
    });

    if (resp.status !== 202) {
      return { success: false, msg: "Gagal membuat VPS: " + JSON.stringify(resp.data) };
    }

    const dropletId = resp.data.droplet.id;
    console.log(`VPS Created - ID: ${dropletId}, Hostname: ${hostname}`);

    await new Promise(r => setTimeout(r, 60000));

    const cek = await axios.get(`https://api.digitalocean.com/v2/droplets/${dropletId}`, {
      headers: { "Authorization": `Bearer ${apiDO}` },
      timeout: 10000
    });

    const dropletInfo = cek.data.droplet;
    const ip = dropletInfo?.networks?.v4?.[0]?.ip_address || "N/A";
    
    console.log(`VPS IP: ${ip}`);

    const vpsFolder = "./database";
    const vpsPath = `${vpsFolder}/data_vps.json`;

    if (!fs.existsSync(vpsFolder)) {
      fs.mkdirSync(vpsFolder, { recursive: true });
    }

    if (!fs.existsSync(vpsPath)) {
      fs.writeFileSync(vpsPath, JSON.stringify([], null, 2));
    }

    let vpsDB = [];
    try {
      vpsDB = JSON.parse(fs.readFileSync(vpsPath));
      if (!Array.isArray(vpsDB)) vpsDB = [];
    } catch (err) {
      vpsDB = [];
    }

    const created = new Date().toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });

    const paketInfo = {
      low: { garansi: 15, replace: 1 },
      medium: { garansi: 25, replace: 2 },
      high: { garansi: 30, replace: -1 }
    };

    const newVpsData = {
      userId: userId,
      username: vpsData.username || "-",
      hostname: hostname,
      ip: ip,
      password: password,
      region: vpsData.region,
      osFamily: vpsData.osFamily,
      os: vpsData.os,
      paket: vpsData.paket,
      plan: vpsData.plan,
      garansi: paketInfo[vpsData.paket]?.garansi || 15,
      replace: paketInfo[vpsData.paket]?.replace || 1,
      harga: vpsData.harga,
      dropletId: dropletId,
      created: created,
      penjual: bot.botInfo.username
    };

    vpsDB.push(newVpsData);
    fs.writeFileSync(vpsPath, JSON.stringify(vpsDB, null, 2));

    return {
      success: true,
      data: {
        hostname,
        ip,
        password,
        region: vpsData.region,
        os: vpsData.os,
        plan: vpsData.plan,
        garansi: paketInfo[vpsData.paket]?.garansi || 15,
        replace: paketInfo[vpsData.paket]?.replace || 1,
        created
      }
    };

  } catch (error) {
    console.error("Error creating VPS:", error);
    return { 
      success: false, 
      msg: error.response?.data?.message || error.message || "Unknown error" 
    };
  }
}

async function rumahOtpTransfer(nominal, config) {
  try {
    const reffId = `wd_rotp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const body = {
      api_key: config.RUMAHOTP,
      action: 'transfer',
      code: config.wd_balance.bank_code,
      target: config.wd_balance.destination_number,
      amount: parseInt(nominal),
      reff_id: reffId
    };

    const response = await axios.post("https://www.rumahotp.io/api/v2/h2h/transfer", qs.stringify(body), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });

    if (!response.data || (response.data.success === false)) {
        throw new Error(response.data.message || "Gagal request ke API RumahOTP");
    }

    return response.data;
  } catch (error) {
    throw new Error(`Gagal WD RumahOTP: ${error.message}`);
  }
}

async function editMenuMessage(ctx, text, keyboard) {
  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      ...keyboard
    });
  } catch (e) {
    try {
      const newMsg = await safeReply(ctx, text, {
        parse_mode: "HTML",
        ...keyboard
      });
      
      try {
        if (ctx.callbackQuery) {
          await ctx.deleteMessage();
        }
      } catch (err) {}
      
      return newMsg;
    } catch (replyErr) {
      console.error("Edit menu error:", replyErr);
      return null;
    }
  }
}

async function editMenuMessageWithPhoto(ctx, photo, caption, keyboard) {
  try {
    await ctx.editMessageMedia({
      type: 'photo',
      media: photo,
      caption: caption,
      parse_mode: 'HTML'
    }, {
      parse_mode: "HTML",
      ...keyboard
    });
  } catch (e) {
    try {
      try {
        if (ctx.callbackQuery) {
          await ctx.deleteMessage();
        }
      } catch (err) {}
      
      await ctx.replyWithPhoto(photo, {
        caption: caption,
        parse_mode: "HTML",
        ...keyboard
      });
    } catch (replyErr) {
      console.error("Edit menu with photo error:", replyErr);
      return null;
    }
  }
}

async function safeSend(method, chatId, ...args) {
  try {
    return await bot.telegram[method](chatId, ...args);
  } catch (err) {
    const m = err?.response?.description || err?.description || err?.message || String(err);
    if (typeof m === 'string' && (m.toLowerCase().includes('user is deactivated') || m.toLowerCase().includes('bot was blocked') || m.toLowerCase().includes('blocked'))) {
      return null;
    }
    throw err;
  }
}

async function safeReply(ctx, text, extra = {}) {
  try {
    return await ctx.reply(text, extra);
  } catch (err) {
    const m = err?.response?.description || err?.description || err?.message || String(err);
    if (typeof m === 'string' && (m.toLowerCase().includes('user is deactivated') || m.toLowerCase().includes('bot was blocked') || m.toLowerCase().includes('blocked'))) {
      return null;
    }
    throw err;
  }
}

const USERS_DB = "./users.json";
const DB_PATH = "./database.json";
const MANUAL_PAYMENTS_DB = "./manual_payments.json";
const TRANSACTIONS_DB = "./transactions.json";
const VOUCHERS_DB = "./vouchers.json";
const AUTO_REACT_DB = "./autoreactgroups.json";
const ADMIN_PANEL_ORDERS_DB = "./orderadminpanel.json";
const SMM_HISTORY_DB = "./database/smm_history.json";
const activeTransactions = {};
const userState = {};
const nevaWdMethodCache = {};
const liveChatState = {};
const ownerReplyState = {};

function getSmmHistory(userId) {
  if (!fs.existsSync(SMM_HISTORY_DB)) fs.writeFileSync(SMM_HISTORY_DB, JSON.stringify({}));
  const db = JSON.parse(fs.readFileSync(SMM_HISTORY_DB));
  return db[userId] || [];
}

function saveSmmHistory(userId, orderData) {
  const db = JSON.parse(fs.readFileSync(SMM_HISTORY_DB));
  if (!db[userId]) db[userId] = [];
  db[userId].unshift(orderData); 
  fs.writeFileSync(SMM_HISTORY_DB, JSON.stringify(db, null, 2));
}

async function callSmmApi(path, params = {}) {
  try {
    const requestBody = {
        api_id: config.smm.apiId,
        api_key: config.smm.apiKey,
        ...params
    };

    const response = await axios.post(`${config.smm.baseUrl}${path}`, requestBody, {
        headers: { 'Content-Type': 'application/json' }
    });
    
    return response.data;
  } catch (e) {
    console.error("SMM API Error:", e.message);
    return { status: false, msg: "Gagal connect ke server SMM" };
  }
}

let botStartTime = Date.now();

const TESTIMONI_CHANNEL = config.testimoniChannel || "";
const INFOBOTKU_CHANNEL = config.infobotChannel || "";

async function createAndSendFullBackup(ctx = null, isAuto = false) {
  const timestamp = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
    .replace(/[\/:]/g, '-').replace(/, /g, '_');
  
  const backupName = `SC_FULL_${config.botName || 'Bot'}_${timestamp}.zip`;
  const backupPath = path.join(__dirname, backupName);
  const output = fs.createWriteStream(backupPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  console.log(`[BACKUP] Memulai proses zip full SC...`);

  return new Promise((resolve, reject) => {
    output.on('close', async () => {
      try {
        const caption = isAuto 
          ? `♻️ <b>AUTO BACKUP SC</b>\n📅 ${timestamp}\n📦 Full Source Code (Tanpa node_modules)`
          : `📦 <b>BACKUP SOURCE CODE</b>\n📅 ${timestamp}\n✅ Full Folder Zip`;

        await bot.telegram.sendDocument(config.ownerId, {
          source: backupPath,
          filename: backupName
        }, { caption: caption, parse_mode: "HTML" });

        fs.unlinkSync(backupPath);
        if (ctx) await ctx.reply("✅ <b>Backup Full SC Terkirim!</b>", { parse_mode: "HTML" });
        resolve(true);
      } catch (err) {
        console.error("[BACKUP FAIL]", err);
        if (ctx) await ctx.reply("❌ Gagal kirim backup.");
        reject(err);
      }
    });

    archive.on('error', (err) => reject(err));
    archive.pipe(output);

    archive.glob('**/*', {
      cwd: __dirname,
      ignore: [
        'node_modules/**', 
        '.git/**',
        'package-lock.json',
        '*.zip',
        'session/**'
      ]
    });

    archive.finalize();
  });
}

async function generateLocalQr(qrString) {
  try {
    return await QRCode.toBuffer(qrString, {
      type: 'png',
      width: 400,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
  } catch (err) {
    console.error("QR Generate Error:", err);
    return null;
  }
}

function generateMuridUsername() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'student_';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateMuridPassword() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let result = 'Student@';
  for (let i = 0; i < 10; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function sendStartInfoToChannel(user) {
  try {
    if (!INFOBOTKU_CHANNEL) {
      console.log("[INFO] Channel testimoni belum diatur di config.js");
      return;
    }

    const cleanFirstName = cleanText(user.first_name || '');
    const cleanLastName  = cleanText(user.last_name || '');
    const username = user.username ? `@${user.username}` : '-';

    const now = new Date();
    const options = {
      timeZone: 'Asia/Jakarta',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    };

    const waktuWIB = now.toLocaleString('id-ID', options);

    const startInfo = `
<blockquote>
━━━━━━━━━━━━━━━━━━━━━━
🚀 𝗪𝗘𝗟𝗖𝗢𝗠𝗘 𝗡𝗘𝗪 𝗨𝗦𝗘𝗥
━━━━━━━━━━━━━━━━━━━━━━

👤 𝗡𝗔𝗠𝗔 𝗗𝗘𝗣𝗔𝗡
╰┈➤ ${cleanFirstName} 

👥 𝗡𝗔𝗠𝗔 𝗕𝗘𝗟𝗔𝗞𝗔𝗡𝗚
╰┈➤ ${cleanLastName}

🆔 𝗨𝗦𝗘𝗥 𝗜𝗗
╰┈➤ ${user.id}

📛 𝗨𝗦𝗘𝗥𝗡𝗔𝗠𝗘
╰┈➤ ${username}

⏰ 𝗪𝗔𝗞𝗧𝗨
╰┈➤ ${waktuWIB} WIB

━━━━━━━━━━━━━━━━━━━━
🤖 𝗕𝗢𝗧
╰┈➤ ${config.botName || "Bot"}!
━━━━━━━━━━━━━━━━━━━━
</blockquote>
`;

    await bot.telegram.sendMessage(INFOBOTKU_CHANNEL, startInfo, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🛒 Beli Sekarang",
              url: `https://t.me/${bot.botInfo.username}`
            }
          ]
        ]
      }
    });

    console.log("[SUCCESS] Info start user baru berhasil dikirim ke channel");

  } catch (error) {
    console.error("[ERROR] Gagal mengirim info start ke channel:", error.message);
    console.log("[INFO] Pastikan bot sudah jadi admin di channel:", INFOBOTKU_CHANNEL);
  }
}

function cleanText(text) {
  if (!text) return '';
  return String(text)
    .replace(/\_/g, '\\_')
    .replace(/\*/g, '\\*')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\~/g, '\\~')
    .replace(/\`/g, '\\`')
    .replace(/\>/g, '\\>')
    .replace(/\#/g, '\\#')
    .replace(/\+/g, '\\+')
    .replace(/\-/g, '\\-')
    .replace(/\=/g, '\\=')
    .replace(/\|/g, '\\|')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\./g, '\\.')
    .replace(/\!/g, '\\!')
    .trim();
}

async function sendTestimoniKeChannel(userName, userId, productName, amount) {
  try {
    if (!TESTIMONI_CHANNEL) {
      console.log("[INFO] Channel testimoni belum diatur di config.js");
      return;
    }

    const now = new Date();
    const options = { 
      timeZone: 'Asia/Jakarta', 
      weekday: 'long',
      year: 'numeric', 
      month: 'long', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    };
    const waktuWIB = now.toLocaleString('id-ID', options);

    const escapeHTML = (text) => {
      if (!text) return "-";
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    };

    // =========================
    // 🧾 CAPTION TESTIMONI
    // =========================
    const caption = `
<b>📜 STRUK PEMBELIAN PRODUK</b>
━━━━━━━━━━━━━━━━━━━━━━━❍

<b>🪪 IDENTITAS PEMBELI</b>
├⌑ 👤 <b>Nama</b> : ${escapeHTML(userName)}
╰⌑ 🆔 <b>ID</b> : ${escapeHTML(userId)}

<b>🎀 DATA PRODUK</b>
├⌑ 🛒 <b>Produk</b> : ${escapeHTML(productName)}
├⌑ 💰 <b>Harga</b> : ${toRupiah(amount)}
╰⌑ ⏰ <b>Waktu</b> : ${escapeHTML(waktuWIB)} WIB

<b>📨 Terimakasih Sudah Belanja Di :</b>
➥ <b>${escapeHTML(config.botName)} Bot</b>
`;

    // =========================
    // 🖼️ KIRIM FOTO + CAPTION
    // =========================
    await bot.telegram.sendPhoto(
      TESTIMONI_CHANNEL,
      config.startTransaksi, // FOTO TRANSAKSI
      {
        caption,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { 
                text: "🛒 Beli Sekarang", 
                url: `https://t.me/${bot.botInfo.username}` 
              }
            ]
          ]
        }
      }
    );

    console.log("[SUCCESS] Testimoni berhasil dikirim ke channel");

  } catch (error) {
    console.error("[ERROR] Gagal mengirim testimoni ke channel:", error.message);
    console.log("[INFO] Pastikan bot sudah jadi admin di channel:", TESTIMONI_CHANNEL);
  }
}

// Fungsi untuk membaca data admin panel orders
function readAdminPanelOrders() {
  try {
    if (!fs.existsSync(ADMIN_PANEL_ORDERS_DB)) {
      fs.writeFileSync(ADMIN_PANEL_ORDERS_DB, JSON.stringify([]));
    }
    const data = fs.readFileSync(ADMIN_PANEL_ORDERS_DB, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error("[ERROR] Gagal membaca order admin panel:", error);
    return [];
  }
}

// Fungsi untuk menyimpan data admin panel orders
function saveAdminPanelOrders(data) {
  try {
    fs.writeFileSync(ADMIN_PANEL_ORDERS_DB, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("[ERROR] Gagal menyimpan order admin panel:", error);
  }
}

function addAdminPanelOrder(orderData) {
  try {
    const orders = readAdminPanelOrders();
    
    const newOrder = {
      id: `adminpanel_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      userId: orderData.userId,
      userName: orderData.userName,
      userUsername: orderData.userUsername || '',
      panelType: orderData.panelType,
      duration: orderData.duration,
      username: orderData.username,
      email: orderData.email,
      password: orderData.password,
      loginUrl: orderData.loginUrl,
      price: orderData.price,
      status: orderData.status || 'active',
      created: Date.now(),
      createdAt: new Date().toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }),
      expires: orderData.expires || 'Permanen'
    };
    
    orders.push(newOrder);
    saveAdminPanelOrders(orders);
    
    return newOrder;
  } catch (error) {
    console.error("[ERROR] Gagal menambahkan order admin panel:", error);
    return null;
  }
}

function readManualPayments() {
  if (!fs.existsSync(MANUAL_PAYMENTS_DB)) {
    fs.writeFileSync(MANUAL_PAYMENTS_DB, JSON.stringify([]));
  }
  return JSON.parse(fs.readFileSync(MANUAL_PAYMENTS_DB));
}

function saveManualPayments(data) {
  fs.writeFileSync(MANUAL_PAYMENTS_DB, JSON.stringify(data, null, 2));
}

function getBotStats() {
  try {
    const users = loadUsers();
    const totalUsers = users.length;

    const uptime = Date.now() - botStartTime;
    const days = Math.floor(uptime / (1000 * 60 * 60 * 24));
    const hours = Math.floor((uptime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));

    return {
      totalUsers,
      runtime: `${days}d ${hours}h ${minutes}m`,
      botName: config.botName || "BOT TELEGRAM",
      ownerName: config.ownerName || "Owner",
      backupCount: "Auto" 
    };
  } catch (e) {
    return {
      totalUsers: "Error",
      runtime: "Unknown",
      botName: config.botName || "BOT TELEGRAM",
      ownerName: config.ownerName || "Owner",
      backupCount: "-"
    };
  }
}

function formatUserCard(ctx, msg) {
  const username = ctx.from.username ? `@${ctx.from.username}` : '-';
  return `<b>📩 PESAN DARI USER</b>\n<b>Username :</b> ${username}\n<b>ID User  :</b> ${ctx.from.id}\n\n<b>Pesan:</b>\n${msg}`;
}

bot.on("document", async (ctx, next) => {
  const userId = ctx.from.id;
  const state = userState[userId];

  if (state?.step === "WAITING_SCRIPT_FILE" && userId === config.ownerId) {
    const doc = ctx.message.document;

    if (!doc.file_name.endsWith(".zip"))
      return safeReply(ctx, "<blockquote>❌ File harus format .zip!</blockquote>", { parse_mode: "HTML" });

    userState[userId] = {
      step: "WAITING_SCRIPT_DETAIL",
      file_id: doc.file_id,
      temp_fileName: doc.file_name.replace(/\s/g, "_"),
    };

    return safeReply(ctx, `<blockquote>✅ <b>File diterima!</b>\n<b>Kirim detail:</b>\nNama | Harga | Deskripsi</blockquote>`, { parse_mode: "HTML" });
  }

  return next();
});

bot.command('help', async (ctx) => {
  await sendWithTyping(ctx, "Ini pesan bantuan...", {
    delay: 200,
    parse_mode: "HTML"
  });
});

bot.command("pesan", async (ctx) => {
  const raw = ctx.message.text || "";
  const msg = raw.replace(/^\/pesan(@\w+)?\s*/i, "").trim();

  if (!msg) {
    liveChatState[ctx.from.id] = { step: "WAITING_MESSAGE" };
    return safeReply(ctx, "<blockquote>📝 <b>Silakan ketik pesan yang ingin dikirim ke owner.</b>\nKetik /batal untuk membatalkan.</blockquote>", { parse_mode: "HTML" });
  }

  return sendToOwner(ctx, msg);
});

bot.command("batal", (ctx) => {
  if (liveChatState[ctx.from.id]?.step === "WAITING_MESSAGE") {
    delete liveChatState[ctx.from.id];
    return safeReply(ctx, "❌ Pengiriman pesan dibatalkan.");
  }
  if (ownerReplyState[ctx.from.id]) {
    delete ownerReplyState[ctx.from.id];
    return safeReply(ctx, "❌ Mode balas owner dibatalkan.");
  }
  if (userState[ctx.from.id]?.step === "WAITING_BROADCAST" && ctx.from.id === config.ownerId) {
    delete userState[ctx.from.id];
    return safeReply(ctx, "❌ Broadcast dibatalkan.");
  }
  return; 
});

bot.on('message', async (ctx, next) => {
    try {
        // Cek apakah pesan ada di grup atau supergroup
        const chatType = ctx.chat?.type;
        if (chatType === 'group' || chatType === 'supergroup') {
            const chatId = String(ctx.chat.id);
            
            // Cek status auto react untuk grup ini
            const isAutoReactEnabled = getAutoReactStatus(chatId);
            
            if (!isAutoReactEnabled) {
                console.log(`[AUTO-REACT] Dinonaktifkan untuk grup ${chatId}`);
                return next();
            }
            
            // Skip jika pesan dari bot sendiri
            if (ctx.from && ctx.from.id === bot.botInfo.id) {
                return next();
            }
            
            // Skip jika pesan adalah command
            if (ctx.message.text && ctx.message.text.startsWith('/')) {
                return next();
            }
            
            // Skip jika pesan adalah service message
            if (ctx.message.new_chat_members || ctx.message.left_chat_member || 
                ctx.message.new_chat_title || ctx.message.new_chat_photo || 
                ctx.message.delete_chat_photo || ctx.message.pinned_message) {
                return next();
            }
            
            // Skip jika pesan kosong (hanya foto/video tanpa caption)
            if (!ctx.message.text && !ctx.message.caption) {
                return next();
            }
            
            // Pilih emoji acak
            const randomEmoji = autoReactEmojis[Math.floor(Math.random() * autoReactEmojis.length)];
            
            // Coba berikan reaksi dengan timeout
            setTimeout(async () => {
                try {
                    await ctx.react(randomEmoji);
                    console.log(`[AUTO-REACT] Reaksi "${randomEmoji}" dikirim ke grup "${ctx.chat.title || chatId}"`);
                } catch (reactError) {
                    console.error(`[AUTO-REACT ERROR] Gagal memberikan reaksi di grup ${chatId}:`, reactError.message);
                    
                    // Jika gagal karena permission, matikan auto react untuk grup ini
                    if (reactError.message.includes('not enough rights') || 
                        reactError.message.includes('CHAT_ADMIN_REQUIRED')) {
                        console.log(`[AUTO-REACT] Permission error, disabling for group ${chatId}`);
                        setAutoReactStatus(chatId, false);
                    }
                }
            }, 1000); // Delay 1 detik sebelum react
            
        }
    } catch (error) {
        console.error('[AUTO-REACT GENERAL ERROR]', error.message);
    }
    
    return next();
});

bot.on("text", async (ctx, next) => {
  try {
    const st = liveChatState[ctx.from.id];
    if (st && st.step === "WAITING_MESSAGE") {
      const text = ctx.message.text;
      delete liveChatState[ctx.from.id];
      return await sendToOwner(ctx, text);
    }
  } catch (e) {}
  return next();
});

async function sendToOwner(ctx, messageText) {
  try {
    const owner = config.ownerId;
    const layout = formatUserCard(ctx, messageText);
    await bot.telegram.sendMessage(owner, layout, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "💬 Balas Pesan", callback_data: `reply_${ctx.from.id}` }]
        ]
      }
    });
    await safeReply(ctx, "<blockquote>✅ <b>Pesan berhasil dikirim ke owner.</b></blockquote>", { parse_mode: "HTML" });
  } catch (err) {
    return safeReply(ctx, "❌ Gagal mengirim pesan ke owner.");
  }
}

bot.action(/reply_(\d+)/, async (ctx) => {
  try {
    if (String(ctx.from.id) !== String(config.ownerId)) {
      await ctx.answerCbQuery("❌ Hanya owner yang boleh membalas.", { show_alert: true });
      return;
    }
    const targetId = ctx.match[1];
    ownerReplyState[ctx.from.id] = { target: targetId, step: "WAITING_REPLY" };
    await ctx.answerCbQuery();
    await safeReply(ctx, "<blockquote>✉️ <b>Silakan kirim balasan Anda sekarang</b> (text / foto / voice / file).\nKetik /batal untuk batalkan.</blockquote>", { parse_mode: "HTML" });
  } catch (e) {}
});

async function forwardReplyToUser(ownerCtx, targetUserId, messageType, payload) {
  try {
    if (messageType === "text") {
      await bot.telegram.sendMessage(targetUserId, `<blockquote>💬 <b>Balasan dari Owner:</b>\n\n${payload}</blockquote>`, { parse_mode: "HTML" });
      await ownerCtx.reply("✅ Balasan terkirim sebagai teks.");
      return;
    }
  } catch (e) {
    await ownerCtx.reply("❌ Gagal mengirim balasan ke user.");
  }
}

bot.on("text", async (ctx, next) => {
  try {
    const st = ownerReplyState[ctx.from.id];
    if (st && st.step === "WAITING_REPLY") {
      const target = st.target;
      const text = ctx.message.text;
      delete ownerReplyState[ctx.from.id];
      await forwardReplyToUser(ctx, target, "text", text);
      return;
    }
  } catch (e) {}
  return next();
});

function getFileExtension(name) {
    const ext = name.split(".").pop().toLowerCase();
    if (["js"].includes(ext)) return "javascript";
    if (["py"].includes(ext)) return "python";
    if (["html","htm"].includes(ext)) return "html";
    if (["css"].includes(ext)) return "css";
    if (["json"].includes(ext)) return "json";
    if (["zip","rar","7z","tar","gz"].includes(ext)) return "archive";
    return "text";
}

async function downloadFile(fileId) {
    try {
        const fileLink = await bot.telegram.getFileLink(fileId);
        const res = await axios.get(fileLink, { responseType: "arraybuffer" });
        return res.data;
    } catch (err) {
        throw new Error("Gagal download file: " + err.message);
    }
}

function getFileContent(buffer) {
    try {
        return Buffer.from(buffer).toString("utf8");
    } catch (err) {
        throw new Error("Gagal membaca file: " + err.message);
    }
}

async function analyzeErrorWithGemini(codeContent, fileName) {
    try {
        if (getFileExtension(fileName) === "archive") {
            return "❌ <b>File adalah arsip (zip/rar), bukan file kode.</b>\nSilakan ekstrak dulu dan kirim file kode individual (js, py, html, css, json).";
        }
        
        const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${config.GEMINI_API_KEY}`,
            {
                contents: [{
                    parts: [{
                        text: `Deteksi error pada file bernama ${fileName}. Berikan hasilnya dalam format:

\`\`\`${getFileExtension(fileName)}
(kode atau analisis singkat di sini)
\`\`\`

JANGAN beri penjelasan panjang. Singkat & jelas saja.

Isi file:
${codeContent}
`
                    }]
                }]
            }
        );
        return res.data.candidates[0].content.parts[0].text;
    } catch (err) {
        throw new Error("Gemini error: " + err.message);
    }
}

async function fixErrorWithGemini(codeContent, fileName) {
    try {
        if (getFileExtension(fileName) === "archive") {
            throw new Error("File adalah arsip (zip/rar), bukan file kode. Silakan ekstrak dulu.");
        }
        
        const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${config.GEMINI_API_KEY}`,
            {
                contents: [{
                    parts: [{
                        text: `Perbaiki error dalam file ${fileName} dan kirimkan hanya kode final:\n\n${codeContent}`
                    }]
                }]
            }
        );
        return res.data.candidates[0].content.parts[0].text;
    } catch (err) {
        throw new Error("Gemini error: " + err.message);
    }
}

const premiumUsers = new Set([config.ownerId]);
let userLimits = new Map();

function updateUserLimit(userId) {
    if (premiumUsers.has(userId)) return 999;
    const now = userLimits.get(userId) || config.USER_LIMIT;
    const sisa = now - 1;
    userLimits.set(userId, sisa);
    return sisa;
}

function getUserLimit(userId) {
    return premiumUsers.has(userId) ? "Unlimited" : (userLimits.get(userId) || config.USER_LIMIT);
}

function loadUsers() {
  if (!fs.existsSync(USERS_DB)) {
    fs.writeFileSync(USERS_DB, JSON.stringify([]));
  }
  return JSON.parse(fs.readFileSync(USERS_DB));
}

function saveUsers(list) {
  fs.writeFileSync(USERS_DB, JSON.stringify(list, null, 2));
}

function checkAndAddUser(user) {
  const users = loadUsers();
  const isNewUser = !users.includes(user.id);
  
  if (isNewUser) {
    users.push(user.id);
    saveUsers(users);
    sendStartInfoToChannel(user);
    return true;
  }
  return false;
}

bot.on("message", (ctx, next) => {
  try {
    checkAndAddUser(ctx.from);
  } catch (e) {
    console.error("[ERROR] Error adding user:", e);
  }
  return next();
});

function readDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({
      isPanelOpen: true,       
      isAdminPanelOpen: true, 
      isMuridPanelOpen: true, 
      scripts: [],
      apps: [],
      paymentMethod: config.payment?.method || 'nevapedia'
    }, null, 2));
  }
  
  return JSON.parse(fs.readFileSync(DB_PATH));
}

function saveDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ================= GMAIL STOCK HELPER =================
// Produk Gmail disimpan sebagai entri biasa di db.apps supaya bisa
// memakai ulang mesin pembelian & stok akun (accounts) yang sudah ada.
function getOrCreateGmailApp(db) {
  db.apps = db.apps || [];
  let idx = db.apps.findIndex(a => (a.nama || '').trim().toLowerCase() === 'gmail');
  if (idx === -1) {
    db.apps.push({
      nama: "Gmail",
      harga: config.hargaGmailDefault || 5000,
      deskripsi: "Akun Gmail fresh & siap pakai",
      accounts: [],
      isGmailProduct: true
    });
    saveDb(db);
    idx = db.apps.length - 1;
  }
  return { app: db.apps[idx], idx };
}

// ================= NOTEL (NOMOR TELEPON) STOCK HELPER =================
// Sama seperti Gmail, produk Notel disimpan sebagai entri di db.apps
// supaya bisa memakai ulang mesin pembelian & stok akun yang sudah ada.
function getOrCreateNotelApp(db) {
  db.apps = db.apps || [];
  let idx = db.apps.findIndex(a => (a.nama || '').trim().toLowerCase() === 'notel');
  if (idx === -1) {
    db.apps.push({
      nama: "Notel",
      harga: config.hargaNotelDefault || 3000,
      deskripsi: "Nomor telepon aktif untuk kebutuhan verifikasi/OTP",
      accounts: [],
      isNotelProduct: true
    });
    saveDb(db);
    idx = db.apps.length - 1;
  }
  return { app: db.apps[idx], idx };
}

function getActivePaymentMethod() {
  const db = readDb();
  const method = (db && db.paymentMethod) ? db.paymentMethod : (config.payment?.method || 'nevapedia');
  // Migrasi: Atlantic sudah dihapus total dari bot, kalau db lama masih
  // nyimpen "atlantic" anggap saja nevapedia.
  return method === "atlantic" ? "nevapedia" : method;
}
function setActivePaymentMethod(method) {
  const db = readDb();
  db.paymentMethod = method;
  saveDb(db);
}

async function createAdminPanelAccount(username, email, password, panelType, duration) {
  try {
    let domain, apikey;
    
    if (panelType === "private") {
      domain = config.adminPanel.private.domain;
      apikey = config.adminPanel.private.apikey;
    } else if (panelType === "public") {
      domain = config.adminPanel.public.domain;
      apikey = config.adminPanel.public.apikey;
    } else {
      return { success: false, msg: "Tipe panel tidak valid!" };
    }
    
    const headers = {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apikey}`
    };
    
    // 1. Buat akun admin dengan root_admin: true
    const userRes = await axios.post(`${domain}/api/application/users`, {
      email: email,
      username: username.toLowerCase(),
      first_name: username,
      last_name: "Admin",
      language: "en",
      password: password,
      root_admin: true  // Set sebagai admin root
    }, { headers });
    
    const user = userRes.data.attributes;
    
    // 2. Untuk versi Pterodactyl terbaru, kita bisa langsung gunakan root_admin: true
    // Tidak perlu endpoint permissions terpisah
    
    // 3. Tambahkan ke database admin panel orders
    const orderData = {
      userId: user.id,
      userName: username,
      userUsername: username.toLowerCase(),
      panelType: panelType,
      duration: duration,
      username: username.toLowerCase(),
      email: email,
      password: password,
      loginUrl: domain,
      price: panelType === "private" ? 
        (duration === "bulanan" ? config.adminPanel.private.harga.bulanan : config.adminPanel.private.harga.permanen) :
        (duration === "bulanan" ? config.adminPanel.public.harga.bulanan : config.adminPanel.public.harga.permanen),
      status: 'active'
    };
    
    addAdminPanelOrder(orderData);
    
    return { 
      success: true, 
      data: { 
        username: user.username, 
        email: user.email,
        password: password,
        login: domain,
        panelType: panelType,
        duration: duration,
        expires: duration === "permanen" ? "Permanen" : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString("id-ID"),
        user_id: user.id  // Tambahkan user ID untuk referensi
      } 
    };
    
  } catch (error) {
    console.error("Error creating admin panel:", error.response?.data || error.message);
    
    // Debug informasi error
    let errorMsg = "Gagal membuat akun admin";
    if (error.response?.data) {
      if (error.response.data.errors) {
        errorMsg = error.response.data.errors.map(e => e.detail).join(", ");
      } else if (error.response.data.message) {
        errorMsg = error.response.data.message;
      }
    } else if (error.message) {
      errorMsg = error.message;
    }
    
    return { 
      success: false, 
      msg: errorMsg
    };
  }
}

async function createPanelAccount(username, ram, disk, cpu) {
  try {
    const headers = {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.panel.apikey}`
    };
    const password = username + "001";
    const email = `${username.toLowerCase()}@gmail.com`;

    const userRes = await axios.post(`${config.panel.domain}/api/application/users`, {
      email, username: username.toLowerCase(), first_name: username, last_name: "User", language: "en", password
    }, { headers });

    const user = userRes.data.attributes;

    await axios.post(`${config.panel.domain}/api/application/servers`, {
      name: `${username} Server`,
      user: user.id,
      egg: config.panel.eggId,
      docker_image: config.panel.image,
      startup: config.panel.startup,
      environment: { INST: "npm", USER_UPLOAD: "0", AUTO_UPDATE: "0", CMD_RUN: "npm start" },
      limits: { memory: ram, swap: 0, disk: disk, io: 500, cpu: cpu },
      feature_limits: { databases: 1, backups: 1, allocations: 1 },
      deploy: { locations: [config.panel.locationId], dedicated_ip: false, port_range: [] }
    }, { headers });

    return { success: true, data: { username: user.username, password, login: config.panel.domain } };
  } catch (error) {
    return { success: false, msg: error.response?.data?.errors?.[0]?.detail || error.message };
  }
}

bot.telegram.setMyCommands([
  { command: 'start', description: '𝗠𝗲𝗻𝗮𝗺𝗽𝗶𝗹𝗸𝗮𝗻 𝗦𝗲𝗺𝘂𝗮 𝗖𝗼𝗺𝗺𝗮𝗻𝗱' },
  { command: 'withdraw', description: '𝗠𝗲𝗻𝗰𝗮𝗶𝗿𝗸𝗮𝗻 𝗦𝗮𝗹𝗱𝗼 𝗔𝗻𝗱𝗮' },
]).catch((e) => {
  // Kalau Telegram API lagi lambat/gak kegapai pas bot baru nyala (ETIMEDOUT dkk),
  // JANGAN sampai bikin seluruh bot mati. Command list emang gak muncul sampe
  // nyala ulang / berhasil, tapi payment & fitur lain tetap harus jalan.
  console.error("[STARTUP] Gagal set command list (non-fatal, bot tetap jalan):", e.message);
})

// Dipanggil dari deep-link Mini App: t.me/<bot>?start=buyapp_<idx>
// Meniru bot.action(/buy_app_(\d+)/) tapi kirim pesan baru (bukan edit),
// karena datang dari /start, bukan dari tombol callback yang sudah ada.
async function startPayloadBuyApp(ctx, idx) {
  const db = readDb();
  const app = db.apps[idx];
  if (!app) return safeReply(ctx, "<blockquote>❌ <b>Produk tidak ditemukan</b> (mungkin sudah dihapus/diganti owner).</blockquote>", { parse_mode: "HTML" });

  const stock = (app.accounts || []).length;
  if (stock <= 0) {
    const already = isInWishlist(app.nama, ctx.from.id);
    return safeReply(
      ctx,
      `<blockquote>❌ <b>${app.nama}</b> lagi habis stok.\n\n${already ? "🔔 Kamu sudah terdaftar, nanti otomatis di-DM begitu restock." : "Mau di-notif otomatis kalau sudah restock?"}</blockquote>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: already
            ? [[{ text: "🔙 Kembali", callback_data: "menu_apps" }]]
            : [
                [{ text: "🔔 Notifikasi Saya Kalau Restock", callback_data: `wishlist_add_${idx}` }],
                [{ text: "🔙 Kembali", callback_data: "menu_apps" }],
              ],
        },
      }
    );
  }

  userState[ctx.from.id] = { step: "PURCHASE_APP", appIndex: idx, qty: 1, message: null };

  const base = parseInt(app.harga) || 0;
  const qty = 1;
  const total = calcTotalPrice(base, qty);
  const caption = renderPurchaseText(app, qty, total);

  await safeReply(ctx, caption, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "➖", callback_data: `app_qty_minus_${idx}` },
          { text: `${qty}`, callback_data: `app_qty_show_${idx}` },
          { text: "➕", callback_data: `app_qty_plus_${idx}` },
        ],
        [{ text: "🛒 Buy Now", callback_data: `app_buy_now_${idx}` }],
        [{ text: "📝 Tambah Catatan (opsional)", callback_data: `app_note_${idx}` }],
        [{ text: "🔙 Batal", callback_data: "menu_apps" }],
      ],
    },
  });
}

bot.start(async (ctx) => {
    // Deep-link dari Telegram Mini App ("Beli Sekarang") -> langsung ke kartu pembelian produk
    const payload = ctx.startPayload || "";
    const buyAppMatch = payload.match(/^buyapp_(\d+)$/);
    if (buyAppMatch) {
      checkAndAddUser(ctx.from);
      return startPayloadBuyApp(ctx, parseInt(buyAppMatch[1]));
    }

    // Aktifkan efek bot sedang mengetik
    await ctx.sendChatAction('typing');
    
    // Pilih efek pesan secara acak
    const randomEffectId = config.menuEffects[Math.floor(Math.random() * config.menuEffects.length)];
    
    const stats = getBotStats();
    
    const isNewUser = checkAndAddUser(ctx.from);
    const cleanFirstName = cleanText(ctx.from.first_name || 'Pengguna');
    const cleanLastName = cleanText(ctx.from.last_name || '-');

    // Ambil statistik pemasukan
    let incomeStats = null;
    let totalPemasukanText = "Sedang dimuat...";
    let totalTransaksiText = "Sedang dimuat...";
    
    try {
        incomeStats = getIncomeStats();
        
        // Format total pemasukan
        totalPemasukanText = `<b>${toRupiah(incomeStats.totalIncome)}</b>`;
        
        // Format total transaksi
        totalTransaksiText = `<b>${incomeStats.totalTransactions} transaksi</b>`;
        
    } catch (error) {
        console.error("[ERROR] Gagal mengambil statistik pemasukan:", error);
        // Tetap tampilkan placeholder jika error
        totalPemasukanText = "<b>-</b>";
        totalTransaksiText = "<b>-</b>";
    }

    const trendingTeaser = getTrendingAppNames(2);
    const trendingLine = trendingTeaser.length > 0 ? `\n🔥 <b>Lagi diminati:</b> ${trendingTeaser.join(", ")}\n` : "";

    const welcomeText = `
<blockquote><b>╭━━━━✧「 👋 𝗛𝗔𝗟𝗢, ${cleanFirstName.toUpperCase()} 」✧━━━━❍</b>
<b>┃</b> Selamat datang di <b>${config.botName || "Bot"}</b>
<b>┃</b> Toko digital serba ada — script, apps, panel, VPS & OTP
<b>╰━━━━━━━━━━━━━━━━━━━━━━━━❍</b></blockquote>

<blockquote><b>╭━━━━✧「 📊 𝗦𝗧𝗔𝗧𝗜𝗦𝗧𝗜𝗞 𝗕𝗢𝗧 」✧━━━━❍</b>
<b>┃</b> ⏱️ Runtime     : ${stats.runtime}
<b>┃</b> 👥 Total User  : ${stats.totalUsers}
<b>┃</b> 💰 Pemasukan   : ${totalPemasukanText}
<b>┃</b> 🧾 Transaksi   : ${totalTransaksiText}
<b>╰━━━━━━━━━━━━━━━━━━━━━━━━❍</b></blockquote>
${trendingLine}
<blockquote><b>╭━━━━✧「 🪪 𝗣𝗥𝗢𝗙𝗜𝗟 𝗞𝗔𝗠𝗨 」✧━━━━❍</b>
<b>┃</b> 🆔 ID     : <code>${ctx.from.id}</code>
<b>┃</b> 📝 Nama   : ${cleanFirstName} ${cleanLastName !== "-" ? cleanLastName : ""}
<b>╰━━━━━━━━━━━━━━━━━━━━━━━━❍</b></blockquote>

🛍️ Tap <b>Buka Katalog</b> di bawah buat mulai belanja!
`;

    const menuKeyboard = {
        inline_keyboard: [
            ...(config.miniApp?.enabled && config.miniApp?.url !== "-"
              ? [[{ text: "🛍️ 𝗕𝘂𝗸𝗮 𝗠𝗶𝗻𝗶 𝗔𝗽𝗽", web_app: { url: config.miniApp.url } }]]
              : []),
            [
                { text: "📦 𝗕𝘂𝗸𝗮 𝗞𝗮𝘁𝗮𝗹𝗼𝗴", callback_data: "menu_katalog" }
            ],
            [
                { text: "⭐ 𝗧𝗲𝘀𝘁𝗶𝗺𝗼𝗻𝗶", url: "https://t.me/dimas_storebot" },
                { text: "👨‍💻 𝗗𝗲𝘃𝗲𝗹𝗼𝗽𝗲𝗿", url: "https://t.me/dimas_store19" }
            ]
        ]
    };

    // Tambahkan delay kecil untuk efek typing lebih natural
    await new Promise(resolve => setTimeout(resolve, 500));

    // Kirim pesan dengan efek
    try {
        if (config.startPhoto) {
            await ctx.replyWithPhoto(config.startPhoto, {
                caption: welcomeText,
                parse_mode: "HTML",
                reply_markup: menuKeyboard,
                message_effect_id: randomEffectId // Tambahkan efek pesan di sini
            });
        } else {
            await ctx.reply(welcomeText, {
                parse_mode: "HTML",
                reply_markup: menuKeyboard,
                message_effect_id: randomEffectId // Tambahkan efek pesan di sini
            });
        }
    } catch (e) {
        // Fallback jika efek tidak didukung
        console.log("[INFO] Message effect not available, using standard reply");
        if (config.startPhoto) {
            try {
                await ctx.replyWithPhoto(config.startPhoto, {
                    caption: welcomeText,
                    parse_mode: "HTML",
                    reply_markup: menuKeyboard
                });
            } catch (photoError) {
                await ctx.reply(welcomeText, {
                    parse_mode: "HTML",
                    reply_markup: menuKeyboard
                });
            }
        } else {
            await ctx.reply(welcomeText, {
                parse_mode: "HTML",
                reply_markup: menuKeyboard
            });
        }
    }

    // Khusus owner - Hanya tampilkan pesan sederhana tanpa statistik lengkap
    if (ctx.from.id === config.ownerId) {
        // Aktifkan efek typing lagi untuk pesan owner
        await ctx.sendChatAction('typing');
        await new Promise(resolve => setTimeout(resolve, 300));
        
        await ctx.reply(
            `<blockquote><b>👑 Selamat Datang Owner!</b></blockquote>`,
            {
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🔧 𝗠𝗲𝗻𝘂 𝗢𝘄𝗻𝗲𝗿", callback_data: "menu_owner" }]
                    ]
                },
                message_effect_id: randomEffectId // Efek yang sama atau efek khusus
            }
        );
    }
});

bot.action("menu_katalog", async (ctx) => {
  await ctx.answerCbQuery();
  
  // Aktifkan efek bot sedang mengetik
  await ctx.sendChatAction('typing');
  
  // Pilih efek pesan secara acak
  const randomEffectId = config.menuEffects[Math.floor(Math.random() * config.menuEffects.length)];

  const stats = getBotStats();
  
  // Ambil statistik pemasukan
  let incomeStats = null;
  let totalPemasukanText = "Sedang dimuat...";
  let totalTransaksiText = "Sedang dimuat...";
  
  try {
    incomeStats = getIncomeStats();
    
    // Format total pemasukan
    totalPemasukanText = `<b>${toRupiah(incomeStats.totalIncome)}</b>`;
    
    // Format total transaksi
    totalTransaksiText = `<b>${incomeStats.totalTransactions} transaksi</b>`;
    
  } catch (error) {
    console.error("[ERROR] Gagal mengambil statistik pemasukan:", error);
    // Tetap tampilkan placeholder jika error
    totalPemasukanText = "<b>-</b>";
    totalTransaksiText = "<b>-</b>";
  }

  const isNewUser = checkAndAddUser(ctx.from);
  const cleanFirstName = cleanText(ctx.from.first_name || 'Pengguna');
  const cleanLastName = cleanText(ctx.from.last_name || '-');

  const welcomeText = `
<blockquote><b>╭━━━━✧「 👋 𝗛𝗔𝗟𝗢, ${cleanFirstName.toUpperCase()} 」✧━━━━❍</b>
<b>┃</b> Selamat datang di <b>${config.botName || "Bot"}</b>
<b>┃</b> Toko digital serba ada — script, apps, panel, VPS & OTP
<b>╰━━━━━━━━━━━━━━━━━━━━━━━━❍</b></blockquote>

<blockquote><b>╭━━━━✧「 📊 𝗦𝗧𝗔𝗧𝗜𝗦𝗧𝗜𝗞 𝗕𝗢𝗧 」✧━━━━❍</b>
<b>┃</b> ⏱️ Runtime     : ${stats.runtime}
<b>┃</b> 👥 Total User  : ${stats.totalUsers}
<b>┃</b> 💰 Pemasukan   : ${totalPemasukanText}
<b>┃</b> 🧾 Transaksi   : ${totalTransaksiText}
<b>╰━━━━━━━━━━━━━━━━━━━━━━━━❍</b></blockquote>
${(() => { const t = getTrendingAppNames(2); return t.length ? `\n🔥 <b>Lagi diminati:</b> ${t.join(", ")}\n` : ""; })()}
🛍️ Silakan pilih produk yang tersedia di bawah ini!
`;

  const menuKeyboard = {
    inline_keyboard: [
      ...(config.miniApp?.enabled && config.miniApp?.url !== "-"
        ? [[{ text: "🛍️ 𝗕𝘂𝗸𝗮 𝗠𝗶𝗻𝗶 𝗔𝗽𝗽", web_app: { url: config.miniApp.url } }]]
        : []),
      [
        { text: "🛍️ 𝗕𝘂𝘆 𝗣𝗿𝗼𝗱𝘂𝗸", callback_data: "menu_apps" },
        { text: "🖥 𝗕𝘂𝘆 𝗩𝗽𝘀", callback_data: "buyvps_start" }
      ],
      [
        { text: "📁 𝗕𝘂𝘆 𝗦𝗰𝗿𝗶𝗽𝘁𝘀", callback_data: "menu_scripts" },
        { text: "👑 𝗢𝘄𝗻𝗲𝗿", callback_data: "menu_owner_contact" }
      ],
      [
        { text: "⬅️ 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data: "back_home" },
        { text: "➡️ 𝗟𝗮𝗻𝗷𝘂𝘁", callback_data: "menu_katalog_v2" }
      ]
    ]
  };

  // Tambahkan delay untuk efek typing yang lebih natural
  await new Promise(resolve => setTimeout(resolve, 400));

  if (config.startPhoto) {
    try {
      await ctx.editMessageMedia(
        {
          type: "photo",
          media: config.startPhoto,
          caption: welcomeText,
          parse_mode: "HTML"
        },
        { 
          reply_markup: menuKeyboard,
          message_effect_id: randomEffectId // Tambahkan efek di sini
        }
      );
    } catch (e) {
      console.error("[ERROR] Gagal mengedit pesan dengan foto:", e);
      
      // Jika editMessageMedia gagal, coba kirim pesan baru dengan efek
      try {
        await ctx.replyWithPhoto(config.startPhoto, {
          caption: welcomeText,
          parse_mode: "HTML",
          reply_markup: menuKeyboard,
          message_effect_id: randomEffectId // Efek juga di sini
        });
        
        // Hapus pesan sebelumnya jika perlu
        try {
          await ctx.deleteMessage();
        } catch (deleteErr) {
          console.error("[WARNING] Gagal menghapus pesan lama:", deleteErr);
        }
      } catch (photoErr) {
        console.error("[ERROR] Gagal mengirim pesan foto baru:", photoErr);
        
        // Fallback ke teks biasa
        await ctx.editMessageText(welcomeText, {
          parse_mode: "HTML",
          reply_markup: menuKeyboard,
          message_effect_id: randomEffectId // Efek juga untuk teks
        }).catch(async (editErr) => {
          console.error("[ERROR] Gagal edit pesan dengan efek:", editErr);
          
          // Coba tanpa efek
          await ctx.editMessageText(welcomeText, {
            parse_mode: "HTML",
            reply_markup: menuKeyboard
          }).catch(async (finalErr) => {
            console.error("[ERROR] Gagal edit pesan:", finalErr);
            await safeReply(ctx, welcomeText, {
              parse_mode: "HTML",
              reply_markup: menuKeyboard
            });
          });
        });
      }
    }
  } else {
    try {
      await ctx.editMessageText(welcomeText, {
        parse_mode: "HTML",
        reply_markup: menuKeyboard,
        message_effect_id: randomEffectId // Tambahkan efek untuk teks
      });
    } catch (e) {
      console.error("[ERROR] Gagal mengedit pesan teks dengan efek:", e);
      
      // Coba tanpa efek
      try {
        await ctx.editMessageText(welcomeText, {
          parse_mode: "HTML",
          reply_markup: menuKeyboard
        });
      } catch (editErr) {
        console.error("[ERROR] Gagal mengedit pesan teks:", editErr);
        await safeReply(ctx, welcomeText, {
          parse_mode: "HTML",
          reply_markup: menuKeyboard
        });
      }
    }
  }
});

bot.action("menu_katalog_v2", async (ctx) => {
  await ctx.answerCbQuery();
  
  // Aktifkan efek bot sedang mengetik
  await ctx.sendChatAction('typing');
  
  // Pilih efek pesan secara acak
  const randomEffectId = config.menuEffects[Math.floor(Math.random() * config.menuEffects.length)];

  const stats = getBotStats();
  
  // Ambil statistik pemasukan
  let incomeStats = null;
  let totalPemasukanText = "Sedang dimuat...";
  let totalTransaksiText = "Sedang dimuat...";
  
  try {
    incomeStats = getIncomeStats();
    
    // Format total pemasukan
    totalPemasukanText = `<b>${toRupiah(incomeStats.totalIncome)}</b>`;
    
    // Format total transaksi
    totalTransaksiText = `<b>${incomeStats.totalTransactions} transaksi</b>`;
    
  } catch (error) {
    console.error("[ERROR] Gagal mengambil statistik pemasukan:", error);
    // Tetap tampilkan placeholder jika error
    totalPemasukanText = "<b>-</b>";
    totalTransaksiText = "<b>-</b>";
  }

  const isNewUser = checkAndAddUser(ctx.from);
  const cleanFirstName = cleanText(ctx.from.first_name || 'Pengguna');
  const cleanLastName = cleanText(ctx.from.last_name || '-');

  const welcomeText = `
<blockquote><b>╭━━━━✧「 👋 𝗛𝗔𝗟𝗢, ${cleanFirstName.toUpperCase()} 」✧━━━━❍</b>
<b>┃</b> Selamat datang di <b>${config.botName || "Bot"}</b>
<b>┃</b> Toko digital serba ada — script, apps, panel, VPS & OTP
<b>╰━━━━━━━━━━━━━━━━━━━━━━━━❍</b></blockquote>

<blockquote><b>╭━━━━✧「 📊 𝗦𝗧𝗔𝗧𝗜𝗦𝗧𝗜𝗞 𝗕𝗢𝗧 」✧━━━━❍</b>
<b>┃</b> ⏱️ Runtime     : ${stats.runtime}
<b>┃</b> 👥 Total User  : ${stats.totalUsers}
<b>┃</b> 💰 Pemasukan   : ${totalPemasukanText}
<b>┃</b> 🧾 Transaksi   : ${totalTransaksiText}
<b>╰━━━━━━━━━━━━━━━━━━━━━━━━❍</b></blockquote>
${(() => { const t = getTrendingAppNames(2); return t.length ? `\n🔥 <b>Lagi diminati:</b> ${t.join(", ")}\n` : ""; })()}
🛍️ Silakan pilih produk yang tersedia di bawah ini!
`;

  const menuKeyboard = {
    inline_keyboard: [
      [
        { text: "📡 𝗕𝘂𝘆 𝗣𝗮𝗻𝗲𝗹", callback_data: "menu_panel" },
        { text: "📱 𝗕𝘂𝘆 𝗡𝗼𝗸𝗼𝘀", callback_data: "choose_service" }
      ],
      [
        { text: "👑 𝗕𝘂𝘆 𝗔𝗱𝗺𝗶𝗻 𝗣𝗮𝗻𝗲𝗹", callback_data: "buyadminpanel_start" },
        { text: "👨‍🎓 𝗕𝘂𝘆 𝗠𝘂𝗿𝗶𝗱 𝗣𝗮𝗻𝗲𝗹", callback_data: "buymuridpanel_start" }
      ],
      [
        { text: "🎫 𝗩𝗼𝘂𝗰𝗵𝗲𝗿", callback_data: "menu_voucher" },
        { text: "🔥 𝗦𝘂𝗻𝘁𝗶𝗸 𝗦𝗼𝘀𝗺𝗲𝗱", callback_data: "smm_menu" }
      ],
      [
        { text: "🧰 𝗧𝗼𝗼𝗹𝘀", callback_data: "menu_tools" }
      ],
      [
        { text: "⬅️ 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", callback_data: "menu_katalog" },
        { text: "👑 𝗢𝘄𝗻𝗲𝗿", callback_data: "menu_owner_contact" }
      ]
    ]
  };

  // Tambahkan delay untuk efek typing yang lebih natural
  await new Promise(resolve => setTimeout(resolve, 400));

  if (config.startPhoto) {
    try {
      await ctx.editMessageMedia(
        {
          type: "photo",
          media: config.startPhoto,
          caption: welcomeText,
          parse_mode: "HTML"
        },
        { 
          reply_markup: menuKeyboard,
          message_effect_id: randomEffectId // Tambahkan efek di sini
        }
      );
    } catch (e) {
      console.error("[ERROR] Gagal mengedit pesan dengan foto (katalog v2):", e);
      
      // Jika editMessageMedia gagal, coba kirim pesan baru dengan efek
      try {
        await ctx.replyWithPhoto(config.startPhoto, {
          caption: welcomeText,
          parse_mode: "HTML",
          reply_markup: menuKeyboard,
          message_effect_id: randomEffectId // Efek juga di sini
        });
        
        // Hapus pesan sebelumnya jika perlu
        try {
          await ctx.deleteMessage();
        } catch (deleteErr) {
          console.error("[WARNING] Gagal menghapus pesan lama (katalog v2):", deleteErr);
        }
      } catch (photoErr) {
        console.error("[ERROR] Gagal mengirim pesan foto baru (katalog v2):", photoErr);
        
        // Fallback ke teks biasa dengan efek
        await ctx.editMessageText(welcomeText, {
          parse_mode: "HTML",
          reply_markup: menuKeyboard,
          message_effect_id: randomEffectId // Efek juga untuk teks
        }).catch(async (editErr) => {
          console.error("[ERROR] Gagal edit pesan teks dengan efek (katalog v2):", editErr);
          
          // Coba tanpa efek
          await ctx.editMessageText(welcomeText, {
            parse_mode: "HTML",
            reply_markup: menuKeyboard
          }).catch(async (finalErr) => {
            console.error("[ERROR] Gagal edit pesan teks (katalog v2):", finalErr);
            await safeReply(ctx, welcomeText, {
              parse_mode: "HTML",
              reply_markup: menuKeyboard
            });
          });
        });
      }
    }
  } else {
    try {
      await ctx.editMessageText(welcomeText, {
        parse_mode: "HTML",
        reply_markup: menuKeyboard,
        message_effect_id: randomEffectId // Tambahkan efek untuk teks
      });
    } catch (e) {
      console.error("[ERROR] Gagal mengedit pesan teks dengan efek (katalog v2):", e);
      
      // Coba tanpa efek
      try {
        await ctx.editMessageText(welcomeText, {
          parse_mode: "HTML",
          reply_markup: menuKeyboard
        });
      } catch (editErr) {
        console.error("[ERROR] Gagal mengedit pesan teks (katalog v2):", editErr);
        await safeReply(ctx, welcomeText, {
          parse_mode: "HTML",
          reply_markup: menuKeyboard
        });
      }
    }
  }
});

bot.action(/^menu_scripts(?:_page_(\d+))?$/, async (ctx) => {
  if (!await requirePrivateChat(ctx, "menu_scripts")) return;

  // =========================
  // ⚙️ SETTING DALAM FITUR
  // =========================
  const SCRIPT_PER_PAGE = 5;

  const db = readDb();
  const scripts = db.scripts || [];
  const page = Number(ctx.match?.[1] || 0);
  const totalPages = Math.ceil(scripts.length / SCRIPT_PER_PAGE);

  // =========================
  // ❌ JIKA SCRIPT KOSONG
  // =========================
  if (!scripts.length) {
    await ctx.editMessageMedia(
      {
        type: "photo",
        media: config.startScript,
        caption: "⚠️ <b>Belum ada produk script yang tersedia.</b>",
        parse_mode: "HTML"
      },
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "menu_katalog" }]
          ]
        }
      }
    );
    return;
  }

  // =========================
  // 🧠 DATA HALAMAN
  // =========================
  const start = page * SCRIPT_PER_PAGE;
  const end = start + SCRIPT_PER_PAGE;
  const pageItems = scripts.slice(start, end);

  // =========================
  // 📝 CAPTION
  // =========================
  let text = `<b>🛍️ 𝗟𝗶𝘀𝘁 𝗗𝗮𝗳𝘁𝗮𝗿 𝗦𝗰𝗿𝗶𝗽𝘁</b>\n`;
  text += `<i>Halaman ${page + 1} dari ${totalPages}</i>\n\n`;

  pageItems.forEach((item, i) => {
    const no = start + i + 1;
    text += `${no}. <b>${item.nama}</b>\n`;
    text += `╰┈➤ ${toRupiah(item.harga)}\n\n`;
  });

  text += "<b>🛍️ 𝗣𝗶𝗹𝗶𝗵 𝗦𝗰𝗿𝗶𝗽𝘁 𝗬𝗮𝗻𝗴 𝗜𝗻𝗴𝗶𝗻 𝗞𝗮𝗺𝘂 𝗕𝗲𝗹𝗶:</b>";

  // =========================
  // 🔢 BUTTON BELI
  // =========================
  const buttons = [];

  for (let i = 0; i < pageItems.length; i += 2) {
    const row = [];

    row.push({
      text: `${start + i + 1}`,
      callback_data: `buy_sc_${start + i}`
    });

    if (pageItems[i + 1]) {
      row.push({
        text: `${start + i + 2}`,
        callback_data: `buy_sc_${start + i + 1}`
      });
    }

    buttons.push(row);
  }

  // =========================
  // ⬅️ ➡️ PAGINATION AUTO
  // =========================
  const navRow = [];

  if (page > 0) {
    navRow.push({
      text: "⬅️ Prev",
      callback_data: `menu_scripts_page_${page - 1}`
    });
  }

  if (page < totalPages - 1) {
    navRow.push({
      text: "Next ➡️",
      callback_data: `menu_scripts_page_${page + 1}`
    });
  }

  if (navRow.length) buttons.push(navRow);

  // 🔙 KEMBALI
  buttons.push([{ text: "🔙 Kembali", callback_data: "menu_katalog" }]);

  // =========================
  // 🖼️ FOTO + BUTTON
  // =========================
  await ctx.editMessageMedia(
    {
      type: "photo",
      media: config.startScript,
      caption: text,
      parse_mode: "HTML"
    },
    {
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
});

bot.action("menu_apps", async (ctx) => {
  if (!await requirePrivateChat(ctx, 'menu_apps')) return;

  const db = readDb();
  if ((db.apps || []).length === 0) {
    await ctx.editMessageMedia(
      {
        type: "photo",
        media: config.startProduk,
        caption: "⚠️ <b>Belum ada aplikasi tersedia.</b>",
        parse_mode: "HTML"
      },
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "menu_katalog" }]
          ]
        }
      }
    );
    return;
  }

  // =========================
  // 📝 TEKS CAPTION
  // =========================
  const trendingNames = getTrendingAppNames();
  const totalSoldAllTime = readTransactions().filter((t) => t.type === "app").length;

  let text = `<blockquote><b>╭━━━━✧「 🛍️ 𝗞𝗔𝗧𝗔𝗟𝗢𝗚 𝗣𝗥𝗢𝗗𝗨𝗞 」✧━━━━❍</b>\n<b>┃</b> 👥 ${totalSoldAllTime}+ produk sudah terjual\n<b>┃</b> ⚡ Pengiriman otomatis, instan!\n<b>╰━━━━━━━━━━━━━━━━━━━━━━━━❍</b></blockquote>\n\n`;

  if (trendingNames.length > 0) {
    text += `🔥 <b>Lagi diminati:</b> ${trendingNames.join(", ")}\n\n`;
  }

  db.apps.forEach((app, i) => {
    const stock = (app.accounts || []).length;
    const status = stock > 0 ? "✅" : "🚫";
    const trendingBadge = trendingNames.includes(app.nama) ? " 🔥" : "";
    const sold = getSoldCount(app.nama);
    const urgencyBadge = stock > 0 && stock <= (config.lowStockThreshold ?? 2) ? " ⚡<i>sisa dikit!</i>" : "";

    text += `[ ${i + 1} ] <b>${app.nama}</b> ${status}${trendingBadge}${urgencyBadge}\n`;
    text += `┈➤ Stok  : ${stock}\n`;
    text += `┈➤ Harga : ${toRupiah(app.harga)}\n`;
    if (sold > 0) text += `┈➤ <i>${sold}x terjual</i>\n`;
    text += `\n`;
  });

  text += "<b>🛍️ 𝗣𝗶𝗹𝗶𝗵 𝗣𝗿𝗼𝗱𝘂𝗸 𝗬𝗮𝗻𝗴 𝗔𝗻𝗱𝗮 𝗜𝗻𝗴𝗶𝗻𝗸𝗮𝗻 :</b>";

  // =========================
  // 🔢 BUTTON
  // =========================
  const buttons = [];
  for (let i = 0; i < db.apps.length; i += 2) {
    const row = [
      { text: `${i + 1}`, callback_data: `buy_app_${i}` }
    ];

    if (db.apps[i + 1]) {
      row.push({
        text: `${i + 2}`,
        callback_data: `buy_app_${i + 1}`
      });
    }

    buttons.push(row);
  }

  buttons.push([{ text: "🔙 Kembali", callback_data: "menu_katalog" }]);

  // =========================
  // 🖼️ FOTO + TEKS
  // =========================
  await ctx.editMessageMedia(
    {
      type: "photo",
      media: config.startProduk,
      caption: text,
      parse_mode: "HTML"
    },
    {
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
});

bot.action("buymuridpanel_start", async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buymuridpanel_start')) return;
  
  const db = readDb();
  
  // Cek apakah murid panel sedang open
  if (!db.isMuridPanelOpen) {
    await editMenuMessage(
      ctx,
      `<blockquote>
❌ <b>BUY MURID PANEL SEDANG TUTUP!</b>

Maaf, untuk saat ini pembelian Murid Panel sedang tidak tersedia.

Silakan hubungi owner untuk informasi lebih lanjut:
👤 @${config.ownerUser || "RafatharCodeNew"}
</blockquote>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "menu_katalog_v2" }]
          ]
        }
      }
    );
    return;
  }
  
  const text = `
<blockquote>
<b>👨‍🎓 KATALOG MURID PANEL</b>
━━━━━━━━━━━━━━━━━━━━━━
📊 <b>AKSES MURID/STUDENT</b>

🎯 <b>FITUR MURID PANEL:</b>
├─ 📋 Akses server sendiri
├─ 🖥️ Buat server sendiri
├─ 👀 Lihat server sendiri
├─ 🔧 Konfigurasi server sendiri
├─ 📊 Monitoring server sendiri
└─ 🛠️ Tools terbatas untuk murid

━━━━━━━━━━━━━━━━━━━━━━
<b>📚 PILIH KATEGORI PANEL:</b>
<b>1️⃣ OWNERPANEL</b>
├─ 🔐 Private: Rp 20.000 (1 bulan)
├─ 🔐 Private: Rp 25.000 (permanen)
├─ 🌐 Public: Rp 15.000 (1 bulan) 
└─ 🌐 Public: Rp 20.000 (permanen)

<b>2️⃣ PT PANEL</b>
├─ 🔐 Private: Rp 30.000 (1 bulan)
├─ 🔐 Private: Rp 35.000 (permanen)
├─ 🌐 Public: Rp 25.000 (1 bulan)
└─ 🌐 Public: Rp 30.000 (permanen)
━━━━━━━━━━━━━━━━━━━━━━
</blockquote>
✨ <b>PILIH YANG ANDA INGINKAN:</b>`;

  await ctx.editMessageMedia(
    {
      type: "photo",
      media: config.startMuridPanel || config.startPhoto,
      caption: text,
      parse_mode: "HTML"
    },
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "1️⃣ OWNERPANEL", callback_data: "buymuridpanel_category:OWNERPANEL" }],
          [{ text: "2️⃣ PT PANEL", callback_data: "buymuridpanel_category:PTPANEL" }],
          [{ text: "🔙 Kembali", callback_data: "menu_katalog_v2" }]
        ]
      }
    }
  );
});

bot.action(/buymuridpanel_category:(OWNERPANEL|PTPANEL)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buymuridpanel_category')) return;
  
  const category = ctx.match[1];
  const userId = ctx.from.id;
  
  if (!userState[userId]) userState[userId] = {};
  userState[userId].muridPanelData = { category: category };
  
  const categoryText = category === "OWNERPANEL" ? "OWNERPANEL" : "PT PANEL";
  
  const text = `
<blockquote>
<b>👨‍🎓 MURID PANEL ${categoryText}</b>
━━━━━━━━━━━━━━━━━━━━━━
✨ <b>PILIH TIPE PANEL:</b>

<b>🔐 PRIVATE PANEL</b>
├─ Akses lebih eksklusif
├─ Support prioritas
└─ Fitur lebih lengkap

<b>🌐 PUBLIC PANEL</b>
├─ Akses regular
├─ Support standar
└─ Fitur dasar
━━━━━━━━━━━━━━━━━━━━━━
</blockquote>
✨ <b>PILIH YANG ANDA INGINKAN:</b>`;

  await editMenuMessage(ctx, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "1️⃣ PRIVATE", callback_data: `buymuridpanel_type:${category}:private` }],
        [{ text: "2️⃣ PUBLIC", callback_data: `buymuridpanel_type:${category}:public` }],
        [{ text: "🔙 Kembali", callback_data: "buymuridpanel_start" }]
      ]
    }
  });
});

bot.action(/buymuridpanel_type:(OWNERPANEL|PTPANEL):(private|public)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buymuridpanel_type')) return;
  
  const [_, category, panelType] = ctx.match;
  const userId = ctx.from.id;
  
  if (!userState[userId]?.muridPanelData) {
    userState[userId] = { muridPanelData: {} };
  }
  
  userState[userId].muridPanelData.category = category;
  userState[userId].muridPanelData.panelType = panelType;
  
  // Ambil harga dari config
  let hargaConfig;
  if (category === "OWNERPANEL") {
    hargaConfig = panelType === "private" 
      ? config.muridPanel?.OWNERPANEL?.private?.harga
      : config.muridPanel?.OWNERPANEL?.public?.harga;
  } else if (category === "PTPANEL") {
    hargaConfig = panelType === "private"
      ? config.muridPanel?.PTPANEL?.private?.harga
      : config.muridPanel?.PTPANEL?.public?.harga;
  }
  
  const hargaBulanan = hargaConfig?.bulanan || 0;
  const hargaPermanen = hargaConfig?.permanen || 0;
  
  const categoryText = category === "OWNERPANEL" ? "OWNERPANEL" : "PT PANEL";
  const panelTypeText = panelType === "private" ? "PRIVATE" : "PUBLIC";
  
  const text = `
<blockquote>
<b>👨‍🎓 MURID PANEL ${categoryText} - ${panelTypeText}</b>
━━━━━━━━━━━━━━━━━━━━━━
🏷️ <b>HARGA:</b>
├─ 📅 1 BULAN: <b>${toRupiah(hargaBulanan)}</b>
└─ ♾️ PERMANEN: <b>${toRupiah(hargaPermanen)}</b>

━━━━━━━━━━━━━━━━━━━━━━
✅ <b>KEUNTUNGAN:</b>
├─ Akun murid/student panel
├─ Bisa buat server sendiri
├─ Akses terbatas sesuai role
├─ Fitur dasar untuk belajar
└─ Support dari tim kami
━━━━━━━━━━━━━━━━━━━━━━
</blockquote>
✨ <b>PILIH DURASI YANG ANDA INGINKAN:</b>`;

  await editMenuMessage(ctx, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "1️⃣ 1 Bulan", callback_data: `buymuridpanel_duration:${category}:${panelType}:bulanan` },
          { text: "2️⃣ Permanen", callback_data: `buymuridpanel_duration:${category}:${panelType}:permanen` }
        ],
        [{ text: "🔙 Kembali", callback_data: `buymuridpanel_category:${category}` }]
      ]
    }
  });
});

bot.action(/buymuridpanel_duration:(OWNERPANEL|PTPANEL):(private|public):(bulanan|permanen)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buymuridpanel_duration')) return;
  
  const [_, category, panelType, duration] = ctx.match;
  const userId = ctx.from.id;
  
  if (!userState[userId]?.muridPanelData) {
    userState[userId] = { muridPanelData: {} };
  }
  
  userState[userId].muridPanelData.category = category;
  userState[userId].muridPanelData.panelType = panelType;
  userState[userId].muridPanelData.duration = duration;
  
  // Ambil harga dari config
  let hargaConfig;
  if (category === "OWNERPANEL") {
    hargaConfig = panelType === "private" 
      ? config.muridPanel?.OWNERPANEL?.private?.harga
      : config.muridPanel?.OWNERPANEL?.public?.harga;
  } else if (category === "PTPANEL") {
    hargaConfig = panelType === "private"
      ? config.muridPanel?.PTPANEL?.private?.harga
      : config.muridPanel?.PTPANEL?.public?.harga;
  }
  
  const harga = duration === "bulanan" ? hargaConfig?.bulanan : hargaConfig?.permanen;
  
  if (!harga || harga === 0) {
    return ctx.answerCbQuery("❌ Harga belum diatur di config!", { show_alert: true });
  }
  
  userState[userId].muridPanelData.harga = harga;
  
  const durasiText = duration === "bulanan" ? "1 Bulan" : "Permanen";
  const categoryText = category === "OWNERPANEL" ? "OWNERPANEL" : "PT PANEL";
  const panelTypeText = panelType === "private" ? "PRIVATE" : "PUBLIC";
  
  const text = `
<blockquote>
<b>✅ KONFIRMASI PEMESANAN MURID PANEL</b>
━━━━━━━━━━━━━━━━━━━━━━
📋 <b>DETAIL ORDER:</b>
├─ 🏷️ Kategori: <b>${categoryText}</b>
├─ 🏷️ Tipe: <b>${panelTypeText}</b>
├─ 📅 Durasi: <b>${durasiText}</b>
├─ 💰 Harga: <b>${toRupiah(harga)}</b>
└─ 👤 Pembeli: <b>${ctx.from.first_name || "User"}</b>

━━━━━━━━━━━━━━━━━━━━━━
📝 <b>CATATAN:</b>
• Akun murid panel akan dibuat dalam 1-5 menit
• Login details akan dikirim via chat
• Garansi 3 hari untuk masalah teknis
• Hak akses terbatas (student role)
• Tidak termasuk refund setelah akun dibuat
━━━━━━━━━━━━━━━━━━━━━━
</blockquote>
<i>Lanjutkan pembayaran?</i>`;

  await editMenuMessage(ctx, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "💰 LANJUT PEMBAYARAN", callback_data: "buymuridpanel_pay" }],
        [{ text: "🔙 Kembali", callback_data: `buymuridpanel_type:${category}:${panelType}` }]
      ]
    }
  });
});

bot.action("buymuridpanel_pay", async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buymuridpanel_pay')) return;
  
  const userId = ctx.from.id;
  
  if (!userState[userId]?.muridPanelData) {
    return ctx.answerCbQuery("❌ Data murid panel tidak ditemukan!", { show_alert: true });
  }

  const muridPanelData = userState[userId].muridPanelData;
  const nominal = muridPanelData.harga;
  const categoryText = muridPanelData.category === "OWNERPANEL" ? "OWNERPANEL" : "PT PANEL";
  const panelTypeText = muridPanelData.panelType === "private" ? "PRIVATE" : "PUBLIC";
  const durasiText = muridPanelData.duration === "bulanan" ? "1 Bulan" : "Permanen";
  const itemName = `Murid Panel ${categoryText} - ${panelTypeText} - ${durasiText}`;

  // Ubah dari handlePayment ke showPaymentWithVoucher
  await showPaymentWithVoucher(ctx, nominal, itemName, {
    type: "muridpanel",
    muridPanelData: muridPanelData
  });
});

bot.action("buyadminpanel_start", async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buyadminpanel_start')) return;
  
  const db = readDb();
  
  // Cek apakah admin panel sedang open
  if (!db.isAdminPanelOpen) {
    await editMenuMessage(
      ctx,
      `<blockquote>
❌ <b>BUY ADMIN PANEL SEDANG TUTUP!</b>

Maaf, untuk saat ini pembelian Admin Panel sedang tidak tersedia.

Silakan hubungi owner untuk informasi lebih lanjut:
👤 @${config.ownerUser || "RafatharCodeNew"}
</blockquote>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "menu_katalog_v2" }]
          ]
        }
      }
    );
    return;
  }
  
  const text = `
<blockquote>
<b>🛒 KATALOG ADMIN PANEL</b>
━━━━━━━━━━━━━━━━━━━━━━
📊 <b>AKSES FULL ADMINISTRATOR</b>

🎯 <b>FITUR ADMIN PANEL:</b>
├─ 📋 Akses semua server
├─ 👥 Kelola semua user
├─ 🖥️ Buat/hapus server
├─ 🌐 Kelola nodes/locations
├─ 🔧 Konfigurasi lengkap
├─ 📊 Monitoring real-time
└─ 🛠️ Tools administrator
</blockquote>

━━━━━━━━━━━━━━━━━━━━━━
✨ <b>PILIH TIPE ADMIN PANEL:</b>`;

  await ctx.editMessageMedia(
    {
      type: "photo",
      media: config.startAdminPanel || config.startPhoto,
      caption: text,
      parse_mode: "HTML"
    },
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔐 PRIVATE ADMIN", callback_data: "buyadminpanel_type:private" }],
          [{ text: "🌐 PUBLIC ADMIN", callback_data: "buyadminpanel_type:public" }],
          [{ text: "🔙 Kembali", callback_data: "menu_katalog_v2" }]
        ]
      }
    }
  );
});

bot.action(/buyadminpanel_type:(private|public)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buyadminpanel_type')) return;
  
  const panelType = ctx.match[1];
  const userId = ctx.from.id;
  
  if (!userState[userId]) userState[userId] = {};
  userState[userId].adminPanelData = { panelType: panelType };
  
  const harga = panelType === "private" ? config.adminPanel.private.harga : config.adminPanel.public.harga;
  
  const text = `
<blockquote>
<b>🛒 ADMIN PANEL ${panelType.toUpperCase()}</b>
━━━━━━━━━━━━━━━━━━━━━━
🏷️ <b>HARGA:</b>
├─ 📅 1 BULAN: <b>${toRupiah(harga.bulanan)}</b>
└─ ♾️ PERMANEN: <b>${toRupiah(harga.permanen)}</b>

━━━━━━━━━━━━━━━━━━━━━━
✅ <b>KEUNTUNGAN:</b>
├─ Akses panel ${panelType === "private" ? "full root/admin" : "administrator regular"}
├─ Bisa kelola semua server
├─ Bisa kelola user lain
├─ Fitur administrator lengkap
└─ Support dari tim kami
</blockquote>

━━━━━━━━━━━━━━━━━━━━━━
✨ <b>PILIH DURASI:</b>`;

  await editMenuMessage(ctx, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "1️⃣ 1 Bulan", callback_data: `buyadminpanel_duration:${panelType}:bulanan` },
          { text: "2️⃣ Permanen", callback_data: `buyadminpanel_duration:${panelType}:permanen` }
        ],
        [{ text: "🔙 Kembali", callback_data: "buyadminpanel_start" }]
      ]
    }
  });
});

bot.action(/buyadminpanel_duration:(private|public):(bulanan|permanen)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buyadminpanel_duration')) return;
  
  const [_, panelType, duration] = ctx.match;
  const userId = ctx.from.id;
  
  if (!userState[userId]?.adminPanelData) {
    userState[userId] = { adminPanelData: {} };
  }
  
  userState[userId].adminPanelData.panelType = panelType;
  userState[userId].adminPanelData.duration = duration;
  
  const hargaConfig = panelType === "private" ? config.adminPanel.private.harga : config.adminPanel.public.harga;
  const harga = duration === "bulanan" ? hargaConfig.bulanan : hargaConfig.permanen;
  
  userState[userId].adminPanelData.harga = harga;
  
  const durasiText = duration === "bulanan" ? "1 Bulan" : "Permanen";
  const panelTypeText = panelType === "private" ? "PRIVATE" : "PUBLIC";
  
  const text = `
<blockquote>
<b>✅ KONFIRMASI PEMESANAN</b>
━━━━━━━━━━━━━━━━━━━━━━
📋 <b>DETAIL ORDER:</b>
├─ 🏷️ Tipe: <b>ADMIN PANEL ${panelTypeText}</b>
├─ 📅 Durasi: <b>${durasiText}</b>
├─ 💰 Harga: <b>${toRupiah(harga)}</b>
└─ 👤 Pembeli: <b>${ctx.from.first_name || "User"}</b>

━━━━━━━━━━━━━━━━━━━━━━
📝 <b>CATATAN:</b>
• Akun akan dibuat dalam 1-5 menit
• Login details akan dikirim via chat
• Garansi 3 hari untuk masalah teknis
• Tidak termasuk refund setelah akun dibuat
</blockquote>

━━━━━━━━━━━━━━━━━━━━━━
<i>Lanjutkan pembayaran?</i>`;

  await editMenuMessage(ctx, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "💰 LANJUT PEMBAYARAN", callback_data: "buyadminpanel_pay" }],
        [{ text: "🔙 Kembali", callback_data: `buyadminpanel_type:${panelType}` }]
      ]
    }
  });
});

bot.action("buyadminpanel_pay", async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buyadminpanel_pay')) return;
  
  const userId = ctx.from.id;
  
  if (!userState[userId]?.adminPanelData) {
    return ctx.answerCbQuery("❌ Data admin panel tidak ditemukan!", { show_alert: true });
  }

  const adminPanelData = userState[userId].adminPanelData;
  const nominal = adminPanelData.harga;
  const panelTypeText = adminPanelData.panelType === "private" ? "PRIVATE" : "PUBLIC";
  const durasiText = adminPanelData.duration === "bulanan" ? "1 Bulan" : "Permanen";
  const itemName = `Admin Panel ${panelTypeText} - ${durasiText}`;

  await showPaymentWithVoucher(ctx, nominal, itemName, {
    type: "adminpanel",
    adminPanelData: adminPanelData
  });
});

bot.action("menu_panel", async (ctx) => {
  if (!await requirePrivateChat(ctx, 'menu_panel')) return;
  
  const db = readDb();
  if (!db.isPanelOpen) {
    await editMenuMessage(
      ctx,
      `<blockquote>
Maaf, Untuk Buy Panel Pindah Ke Bot Khusus Buy Panel

Bot Buypanel:
@TokoPanelRafatharCodeBot
</blockquote>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "menu_katalog" }]
          ]
        }
      }
    );
    return;
  }

  userState[ctx.from.id] = { step: "WAITING_USERNAME_PANEL" };

  await editMenuMessage(
    ctx,
    "<b>🍂 𝗦𝗶𝗹𝗮𝗵𝗸𝗮𝗻 𝗞𝗶𝗿𝗶𝗺 𝗨𝘀𝗲𝗿𝗻𝗮𝗺𝗲 𝗨𝗻𝘁𝘂𝗸 𝗣𝗮𝗻𝗲𝗹 𝗞𝗮𝗺𝘂 𝗠𝗶𝗻𝗶𝗺𝗮𝗹 𝟱-𝟴 𝗛𝘂𝗿𝘂𝗳.</b>\n\n<i>Kirim username sekarang...</i>",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "❌ Batalkan", callback_data: "menu_katalog" }]
        ]
      }
    }
  );

  setTimeout(() => {
    const st = userState[ctx.from.id];
    if (st && st.step === "WAITING_USERNAME_PANEL") {
      delete userState[ctx.from.id];
      safeReply(
        ctx,
        "<blockquote>❌ <b>Waktu habis!</b> Silahkan mulai ulang pembelian panel.</blockquote>",
        { parse_mode: "HTML" }
      );
    }
  }, 60000);
});

bot.action("shop_menu", async (ctx) => {
  if (!await requirePrivateChat(ctx, 'shop_menu')) return;
  
  await editMenuMessage(ctx, 
    `<blockquote><b>🛍️ 𝗦𝗛𝗢𝗣 𝗠𝗘𝗡𝗨</b>
━━━━━━━━━━━━━━━━━━━━━━
Pilih kategori produk yang ingin dibeli:</blockquote>`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📱 ☇ 𝗕𝘂𝘆 𝗡𝗼𝗸𝗼𝘀 (𝗩𝗶𝗿𝘁𝘂𝗮𝗹)", callback_data: "choose_service" }],
          [{ text: "📁 ☇ 𝗦𝗰𝗿𝗶𝗽𝘁𝘀", callback_data: "menu_scripts" }],
          [{ text: "📱 ☇ 𝗔𝗽𝗽𝘀 𝗣𝗿𝗲𝗺𝗶𝘂𝗺", callback_data: "menu_apps" }],
          [{ text: "📧 ☇ 𝗕𝘂𝘆 𝗚𝗺𝗮𝗶𝗹", callback_data: "buy_gmail_shop" }],
          [{ text: "📶 ☇ 𝗕𝘂𝘆 𝗡𝗼𝘁𝗲𝗹", callback_data: "buy_notel_shop" }],
          [{ text: "📡 ☇ 𝗣𝗮𝗻𝗲𝗹 𝗣𝘁𝗲𝗿𝗼𝗱𝗮𝗰𝘁𝗹𝘆", callback_data: "menu_panel" }],
          [{ text: "🖥 ☇ 𝗩𝗽𝘀 𝗗𝗶𝗴𝗶𝘁𝗮𝗹𝗢𝗰𝗲𝗮𝗻", callback_data: "buyvps_start" }],
          [{ text: "🔙 Kembali", callback_data: "menu_katalog" }]
        ]
      }
    }
  );
});


// Kategori -> emoji, biar tampilan katalog lebih enak dilihat
const CATEGORY_ICONS = {
  AI: "🤖", Tools: "🧰", Downloader: "⬇️", Pterodactyl: "🦖",
  Search: "🔎", Searching: "🔎", Stalker: "🕵️", System: "⚙️",
  Games: "🎮", Information: "ℹ️", Maker: "🎨", "Shorten URL": "🔗", Anime: "🎌", Islami: "🕌"
};
function catIcon(cat) {
  return CATEGORY_ICONS[cat] || "📦";
}

bot.action("menu_tools", async (ctx) => {
  await editMenuMessage(ctx, 
    `<blockquote><b>╭━━━━✧「 𝗧𝗢𝗢𝗟𝗦 𝗠𝗘𝗡𝗨 」✧━━━━❍</b>
<b>┃ 🎬 𝗬𝗼𝘂𝘁𝘂𝗯𝗲</b>
<b>┃ ├⌑</b> /ytsearch <i>(Searching YouTube)</i>
<b>┃ └⌑</b> /ytmp3 <i>(Audio)</i>
<b>┃</b>
<b>┃ 📝 𝗖𝗼𝗱𝗲 𝗛𝗲𝗹𝗽</b>
<b>┃ ├⌑</b> /checkerror
<b>┃ └⌑</b> /fixerror
<b>┃</b>
<b>┃ 🛠️ 𝗧𝗼𝗼𝗹𝘀 𝗕𝗮𝗿𝘂</b>
<b>┃ ├⌑</b> /makeqr /ssweb /shorten /qc /brat /tourl <i>(gambar → URL jpg/png)</i>
<b>┃ ├⌑</b> /bypass2 /wachannel /channelid /capcutdl /ttpp
<b>┃ ├⌑</b> /pinsearch /pinvideo /crypto /emojimix /npmcheck
<b>┃ ├⌑</b> /hdvideo <i>(balas video)</i> /enhanceimg <i>(balas foto)</i>
<b>┃ ├⌑</b> /codesearch /spotifysearch /spotifydl2 /tiktokdl2
<b>┃ └⌑</b> /chatgptmobile
<b>┃</b>
<b>┃ 🎵 𝗗𝗼𝘄𝗻𝗹𝗼𝗮𝗱𝗲𝗿 𝗠𝘂𝘀𝗶𝗸/𝗔𝘂𝗱𝗶𝗼</b>
<b>┃ ├⌑</b> /dlspotify <i>(support playlist: /dlspotifyv1)</i>
<b>┃ ├⌑</b> /dlspotifyplay <i>(cari by judul)</i>
<b>┃ ├⌑</b> /dlapplemusic /dlsoundcloud /dlsmule /dlwebmusic
<b>┃ ├⌑</b> /dlytmp3 /dlytmp3v1 <i>(YouTube MP3)</i>
<b>┃ ├⌑</b> /dlsavetube <i>(YouTube, pilih quality)</i>
<b>┃ └⌑</b> /dlytplay <i>(cari MP3 YouTube by judul)</i>
<b>┃</b>
<b>┃ 🎬 𝗗𝗼𝘄𝗻𝗹𝗼𝗮𝗱𝗲𝗿 𝗩𝗶𝗱𝗲𝗼/𝗦𝗼𝘀𝗺𝗲𝗱</b>
<b>┃ ├⌑</b> /dltiktok2 /dlfacebook /dltwitter /dlthreads
<b>┃ ├⌑</b> /dlinstagram /dlinstagramv1 /dlinstagramv2
<b>┃ ├⌑</b> /dlpinterest /dllikee /dldouyin /dldouyinv1
<b>┃ ├⌑</b> /dlbilibili /dlsnackvideo /dlcocofun /dlrednote
<b>┃ ├⌑</b> /dlterabox /dlvidey /dlaio <i>(multi platform)</i>
<b>┃ ├⌑</b> /dlytmp4 /dlytmp4v1 <i>(YouTube MP4, pilih resolusi)</i>
<b>┃ └⌑</b> /dlytplayvid <i>(cari MP4 YouTube by judul)</i>
<b>┃</b>
<b>┃ 📁 𝗗𝗼𝘄𝗻𝗹𝗼𝗮𝗱𝗲𝗿 𝗙𝗶𝗹𝗲 𝗦𝘁𝗼𝗿𝗮𝗴𝗲</b>
<b>┃ ├⌑</b> /dlmediafire /dlmega /dlgdrive /dlkrakenfiles
<b>┃ ├⌑</b> /dlsfile /dlscribd /dlgithub /dlnpm
<b>┃ └⌑</b> /dlcapcut /dlcapcutv1 <i>(CapCut)</i>
<b>┃</b>
<b>┃ 🧠 𝗔𝗜 𝗕𝗮𝗿𝘂</b>
<b>┃ ├⌑</b> /aiclaude /aichatgpt /aideepseek /aigpt35
<b>┃ ├⌑</b> /aialisia /aiandisearch /aicopilot /aifelo
<b>┃ ├⌑</b> /aidgaf /aiduck /aidolphin /aigitagpt
<b>┃ ├⌑</b> /aideepsearch /aiepsilon /aidreamanalyze /aibypass
<b>┃ ├⌑</b> /aideepimg /aifluxv1 /aitext2image <i>(gambar)</i>
<b>┃ ├⌑</b> /aigptimage <i>(edit, balas foto)</i>
<b>┃ ├⌑</b> /aiimage2prompt <i>(gambar→prompt)</i>
<b>┃ ├⌑</b> /aigeminitts /aidracintts <i>(TTS)</i>
<b>┃ └⌑</b> /aiislamcity /aimuslim <i>(Islami)</i>
<b>┃</b>
<b>┃ 🪄 𝗧𝗼𝗼𝗹𝘀 𝗚𝗮𝗺𝗯𝗮𝗿/𝗩𝗶𝗱𝗲𝗼 𝗕𝗮𝗿𝘂</b>
<b>┃ ├⌑</b> /toolremini /toolunblur /toolblurface
<b>┃ ├⌑</b> /toolremovebg /toolremovebgv1 /toolremovebgv2
<b>┃ ├⌑</b> /toolhdvideo /toolhdvideov1 <i>(balas video)</i>
<b>┃ └⌑</b> /hdsuper /hdv2 /hdv3 /hdv4 <i>(balas foto)</i>
<b>┃</b>
<b>┃ 🔧 𝗧𝗼𝗼𝗹𝘀 𝗟𝗮𝗶𝗻𝗻𝘆𝗮 𝗕𝗮𝗿𝘂</b>
<b>┃ ├⌑</b> /toolvcc <i>(generate VCC)</i>
<b>┃ ├⌑</b> /toolvirtualnumber /toolvirtualnumberv1 <i>(nomor virtual/OTP)</i>
<b>┃ └⌑</b> /trackip <i>(lacak IP)</i>
<b>┃</b>
<b>┃ 🎌 𝗔𝗻𝗶𝗺𝗲/𝗠𝗮𝗻𝗴𝗮 (𝗔𝗻𝗶𝗰𝗵𝗶𝗻/𝗞𝗼𝗺𝗶𝗸𝘂/𝗦𝗮𝗺𝗲𝗵𝗮𝗱𝗮𝗸𝘂)</b>
<b>┃ ├⌑</b> /anichinhome /anichinschedule /anichinsearch
<b>┃ ├⌑</b> /anichingenre /anichingenres /toolanichin /anichinstream
<b>┃ ├⌑</b> /komikuhome /komikupopular /komikusearch
<b>┃ ├⌑</b> /komikudetail /komikuchapter
<b>┃ ├⌑</b> /samehadakuhome /samehadakuschedule /samehadakupage
<b>┃ ├⌑</b> /samehadakusearch /samehadakudetail /samehadakustream
<b>┃ └⌑</b> /samehadakuembed
<b>┃</b>
<b>┃ 🔐 𝗨𝘁𝗶𝗹𝗶𝘁𝗮𝘀 &amp; 𝗚𝗮𝗺𝗲𝘀 𝗕𝗮𝗿𝘂</b>
<b>┃ └⌑</b> Tap tombol di bawah — 20 fitur baru (encrypt, tempmail, cek nomor, kuis/games)
<b>╰━━━━━━━━━━━━━━━━━━━━━━━━❍</b></blockquote>`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔐 Utilitas & Games Baru", callback_data: "menu_tools_utils" }],
          [{ text: "🔙 Kembali", callback_data: "back_home" }]
        ]
      }
    }
  );
});

bot.action("menu_tools_utils", async (ctx) => {
  await editMenuMessage(ctx,
    `<blockquote><b>╭━━━━✧「 𝗨𝗧𝗜𝗟𝗜𝗧𝗔𝗦 &amp; 𝗚𝗔𝗠𝗘𝗦 𝗕𝗔𝗥𝗨 」✧━━━━❍</b>
<b>┃</b> <i>Gratis, tanpa apikey.</i>
<b>┃</b>
<b>┃ 🔐 𝗧𝗼𝗼𝗹𝘀</b>
<b>┃ ├⌑</b> /encrypttext <i>(encrypt/decrypt teks)</i>
<b>┃ ├⌑</b> /tempmailcreate /tempmailinbox /tempmaildelete
<b>┃ ├⌑</b> /cekxlaxis /cektri /cekxl <i>(cek nomor kartu)</i>
<b>┃</b>
<b>┃ 🎮 𝗚𝗮𝗺𝗲𝘀 &amp; 𝗞𝘂𝗶𝘀</b>
<b>┃ ├⌑</b> /gameasahotak /gamecaklontong /gamefamily100
<b>┃ ├⌑</b> /gamelengkapikalimat /gametebakan /gamemath
<b>┃ ├⌑</b> /gametebakbendera /gametebakbendera2 /gametebakgambar
<b>┃ ├⌑</b> /gametebakgame /gametebakheroml /gametebakjkt48
<b>┃ ├⌑</b> /gametebakkabupaten /gametebakkalimat
<b>┃ └⌑</b> /gamecc <i>(kuis mapel SD)</i>
<b>┃</b>
<b>┃ 🕌 𝗜𝘀𝗹𝗮𝗺𝗶</b>
<b>┃ ├⌑</b> /doaharian <i>(cari doa + ayat/latin/arti)</i>
<b>┃ └⌑</b> /jadwalsholat <i>(per kota)</i>
<b>┃</b>
<b>┃ 🌐 𝗧𝗼𝗼𝗹𝘀 𝗟𝗮𝗶𝗻</b>
<b>┃ └⌑</b> /freeproxy <i>(proxy HTTP gratis)</i>
<b>┃</b>
<b>┃ 🎌 𝗔𝗻𝗶𝗺𝗲 𝗕𝗮𝘁𝗰𝗵 𝗕𝗮𝗿𝘂</b>
<b>┃ ├⌑</b> /animequote /auratailsearch /aurataillatest
<b>┃ ├⌑</b> /auratailschedule /aurataildetail
<b>┃ ├⌑</b> /otakudesusearch /otakudesudownload /otakudesudetail
<b>┃ ├⌑</b> /anichinepisode /anichinsearch2 /anichindownload
<b>┃ ├⌑</b> /anichinlatest /anichinpopular /anichindetail2
<b>┃ ├⌑</b> /oploverzepisode /oploverzsearch /oploverzongoing
<b>┃ ├⌑</b> /komikindodetail /komikindodownload
<b>┃ ├⌑</b> /samehadakusearch2 /samehadakudownload2
<b>┃ └⌑</b> /samehadakulatest2 /samehadakurelease /samehadakudetail2
<b>┃</b>
<b>┃ 🆕 𝗕𝗮𝘁𝗰𝗵 𝗧𝗲𝗿𝗯𝗮𝗿𝘂</b>
<b>┃ └⌑</b> Tap tombol di bawah — games, canvas/meme, filter foto, image AI &amp; search baru
<b>╰━━━━━━━━━━━━━━━━━━━━━━━━❍</b></blockquote>`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🆕 Batch Terbaru", callback_data: "menu_tools_utils2" }],
          [{ text: "🔙 Kembali ke Tools", callback_data: "menu_tools" }]
        ]
      }
    }
  );
});

bot.action("menu_tools_utils2", async (ctx) => {
  await editMenuMessage(ctx,
    `<blockquote><b>╭━━━━✧「 𝗕𝗔𝗧𝗖𝗛 𝗧𝗘𝗥𝗕𝗔𝗥𝗨 」✧━━━━❍</b>
<b>┃</b> <i>Semua gratis, tanpa apikey.</i>
<b>┃</b>
<b>┃ 🎮 𝗚𝗮𝗺𝗲𝘀 (𝘃𝟮)</b>
<b>┃ └⌑</b> /gamesusunkata /gametebakwarna /gametebaklagu2
<b>┃    </b> /gameasahotak2 /gametebaklirik /gamemaths2
<b>┃</b>
<b>┃ 🖼️ 𝗖𝗮𝗻𝘃𝗮𝘀 — 𝗲𝗳𝗲𝗸 𝟭 𝗴𝗮𝗺𝗯𝗮𝗿</b> <i>(balas url gambar)</i>
<b>┃ └⌑</b> /canvasgreyscale /canvasdarkness /canvasblur /canvasinvert
<b>┃    </b> /canvascircle /canvasaffect /canvasbeautiful /canvasfacepalm
<b>┃</b>
<b>┃ 🖼️ 𝗖𝗮𝗻𝘃𝗮𝘀 — 𝟮 𝗴𝗮𝗺𝗯𝗮𝗿</b> <i>(url1 url2)</i>
<b>┃ └⌑</b> /canvasship /canvasbatslap /canvaskiss
<b>┃</b>
<b>┃ 🖼️ 𝗖𝗮𝗻𝘃𝗮𝘀 — 𝗺𝘂𝗹𝘁𝗶 𝗽𝗮𝗿𝗮𝗺</b> <i>(key=value key2=value2 ...)</i>
<b>┃ ├⌑</b> /canvaswelcomev1 /canvaswelcomev3 /canvaswelcomev4
<b>┃ ├⌑</b> /canvasgoodbyev1 /canvasgoodbyev3 /canvasgoodbyev4 /canvasgoodbyev5
<b>┃ ├⌑</b> /canvascaptcha /canvasprofile /canvassecurity
<b>┃ ├⌑</b> /canvasspotify /canvaslevelup /canvassertifikat /canvassertifikat2
<b>┃ ├⌑</b> /canvasroblox /canvasyoutube /canvasbratvid /canvascarbon
<b>┃ └⌑</b> /canvascreatelogo <i>(judul/ide/slogan → logo AI)</i>
<b>┃</b>
<b>┃ 🎨 𝗜𝗺𝗮𝗴𝗲 𝗔𝗜</b>
<b>┃ └⌑</b> /aibingimg /aipollinations /aidezgo /aiquilimage
<b>┃</b>
<b>┃ 🔎 𝗜𝗺𝗮𝗴𝗲 𝗛𝗗 (𝘂𝗽𝘀𝗰𝗮𝗹𝗲𝗿)</b>
<b>┃ ├⌑</b> /aisparkpix <i>(url=... quality=4k face=false)</i>
<b>┃ ├⌑</b> /aisuperresolution /aienhance /aienhancev6
<b>┃ ├⌑</b> /aiupscale /aiwinkhd
<b>┃ ├⌑</b> /aienhancev2 /aienhancev4 /aienhancev8 /aiimageupscaler <i>(key=value)</i>
<b>┃ └⌑</b> /imglarger1 url_gambar
<b>┃</b>
<b>┃ 🔍 𝗦𝗲𝗮𝗿𝗰𝗵 𝗕𝗮𝗿𝘂</b>
<b>┃ ├⌑</b> /searchanime /searchdouyin /searchlazada /searchmanhwaindo
<b>┃ ├⌑</b> /searchyoutube2 /searchcookpad /searchdapodik /searchipa
<b>┃ ├⌑</b> /searchjadwalbolahariini /searchjadwalbola2 /searchmurotal
<b>┃ └⌑</b> /searchtiktok2
<b>┃</b>
<b>┃</b>
<b>┃ ✨ 𝗙𝗶𝗹𝘁𝗲𝗿 𝗙𝗼𝘁𝗼 (𝗘𝗽𝗵𝗼𝘁𝗼)</b> <i>(balas url gambar)</i>
<b>┃ ├⌑</b> /efanime /efart /efascii /efborealis /efbotak /efbravegreen
<b>┃ ├⌑</b> /efchibi /efcinematic /efcomic /effigurev1 /effigurev2
<b>┃ ├⌑</b> /efghibli /efluminare /efmafia /efmirror /efmonochrome
<b>┃ └⌑</b> /efmountain /efnft /efplaylist /efqin /efreal /efstatue /efstreet
<b>╰━━━━━━━━━━━━━━━━━━━━━━━━❍</b></blockquote>`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Kembali", callback_data: "menu_tools_utils" }]
        ]
      }
    }
  );
});

bot.action("stats", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang bisa melihat statistik!", { show_alert: true });
  }
  
  await ctx.answerCbQuery(); // Menutup loading indicator
  
  const stats = getBotStats();
  const incomeStats = getIncomeStats();
  
  const message = `
<blockquote>
📊 <b>STATISTIK BOT & PENDAPATAN</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━

🤖 <b>INFO BOT</b>
├ Total User: <b>${stats.totalUsers}</b>
├ Runtime: <b>${stats.runtime}</b>
└ Owner: <b>${stats.ownerName}</b>

💰 <b>TOTAL PEMASUKAN</b>
├ Seluruh Waktu: <b>${toRupiah(incomeStats.totalIncome)}</b>
├ Bulan Ini: <b>${toRupiah(incomeStats.monthIncome)}</b>
└ Hari Ini: <b>${toRupiah(incomeStats.todayIncome)}</b>

🛒 <b>TOTAL TRANSAKSI</b>
├ Seluruh Waktu: <b>${incomeStats.totalTransactions} transaksi</b>
├ Bulan Ini: <b>${incomeStats.monthCount} transaksi</b>
└ Hari Ini: <b>${incomeStats.todayCount} transaksi</b>

━━━━━━━━━━━━━━━━━━━━━━━━━━
⏰ Update: ${new Date().toLocaleString("id-ID")}
</blockquote>`;
  
  try {
    // Coba edit message jika ada
    await ctx.editMessageText(message, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📋 Detail Transaksi", callback_data: "view_transactions" },
            { text: "🔄 Refresh", callback_data: "refresh_stats" }
          ],
          [{ text: "🔙 Menu Owner", callback_data: "menu_owner" }]
        ]
      }
    });
  } catch (error) {
    // Jika tidak bisa edit (misal dari menu), kirim message baru
    await safeReply(ctx, message, { 
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📋 Detail Transaksi", callback_data: "view_transactions" },
            { text: "🔄 Refresh", callback_data: "refresh_stats" }
          ],
          [{ text: "🔙 Menu Owner", callback_data: "menu_owner" }]
        ]
      }
    });
  }
});

bot.action("view_transactions", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner!", { show_alert: true });
  }
  
  await ctx.answerCbQuery("📋 Memuat detail transaksi...");
  
  const transactions = readTransactions();
  const recentTransactions = transactions.slice(-10).reverse(); // 10 transaksi terakhir
  
  if (recentTransactions.length === 0) {
    await ctx.editMessageText("<blockquote>📭 <b>Belum ada transaksi tercatat.</b></blockquote>", { 
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Kembali ke Statistik", callback_data: "stats" }]
        ]
      }
    });
    return;
  }
  
  let message = `<blockquote>📋 <b>10 TRANSAKSI TERAKHIR</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  
  recentTransactions.forEach((trx, index) => {
    message += `<b>${index + 1}. ${trx.itemName}</b>\n`;
    message += `├ 👤 ${trx.userName || 'Unknown'}\n`;
    message += `├ 💰 ${toRupiah(trx.amount)}\n`;
    message += `├ 📅 ${trx.date}\n`;
    message += `└ 🔗 ID: <code>${trx.userId}</code>\n\n`;
  });
  
  message += `</blockquote>`;
  
  try {
    await ctx.editMessageText(message, { 
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📊 Statistik Lengkap", callback_data: "full_statistics" },
            { text: "📄 Export CSV", callback_data: "export_transactions" }
          ],
          [{ text: "🔙 Kembali ke Statistik", callback_data: "stats" }]
        ]
      }
    });
  } catch (error) {
    // Jika gagal edit, kirim sebagai pesan baru
    await safeReply(ctx, message, { 
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📊 Statistik Lengkap", callback_data: "full_statistics" },
            { text: "📄 Export CSV", callback_data: "export_transactions" }
          ],
          [{ text: "🔙 Kembali ke Statistik", callback_data: "stats" }]
        ]
      }
    });
  }
});

bot.action("export_transactions", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner!", { show_alert: true });
  }
  
  const transactions = readTransactions();
  
  if (transactions.length === 0) {
    return ctx.answerCbQuery("❌ Tidak ada data transaksi!", { show_alert: true });
  }
  
  await ctx.answerCbQuery("📄 Membuat file CSV...");
  
  // Buat header CSV
  let csvContent = "ID,User ID,Nama User,Item,Jumlah,Tipe,Tanggal\n";
  
  // Tambahkan data
  transactions.forEach(trx => {
    csvContent += `"${trx.id}",${trx.userId},"${(trx.userName || '').replace(/"/g, '""')}","${(trx.itemName || '').replace(/"/g, '""')}",${trx.amount},"${trx.type || ''}","${trx.date || ''}"\n`;
  });
  
  // Simpan ke file sementara
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tempFile = `./temp_transactions_${timestamp}.csv`;
  
  try {
    fs.writeFileSync(tempFile, csvContent);
    
    // Kirim file ke owner
    await ctx.replyWithDocument({
      source: fs.readFileSync(tempFile),
      filename: `transactions_export_${new Date().toISOString().split('T')[0]}.csv`
    }, {
      caption: `<blockquote>📤 <b>Export Data Transaksi</b>\n\nTotal: ${transactions.length} transaksi\nWaktu: ${new Date().toLocaleString("id-ID")}</blockquote>`,
      parse_mode: "HTML"
    });
    
    // Hapus file sementara
    fs.unlinkSync(tempFile);
    
    // Kembalikan ke menu sebelumnya
    try {
      await ctx.deleteMessage();
    } catch (e) {}
    
  } catch (error) {
    console.error("[ERROR] Gagal export CSV:", error);
    await ctx.answerCbQuery("❌ Gagal membuat file CSV!", { show_alert: true });
  }
});

bot.action("refresh_stats", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner!", { show_alert: true });
  }
  
  // Panggil ulang action stats
  await ctx.answerCbQuery("🔄 Memperbarui statistik...");
  
  // Simulasikan panggilan action stats
  const stats = getBotStats();
  const incomeStats = getIncomeStats();
  
  const message = `
<blockquote>
📊 <b>STATISTIK BOT & PENDAPATAN</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━

🤖 <b>INFO BOT</b>
├ Total User: <b>${stats.totalUsers}</b>
├ Runtime: <b>${stats.runtime}</b>
└ Owner: <b>${stats.ownerName}</b>

💰 <b>TOTAL PEMASUKAN</b>
├ Seluruh Waktu: <b>${toRupiah(incomeStats.totalIncome)}</b>
├ Bulan Ini: <b>${toRupiah(incomeStats.monthIncome)}</b>
└ Hari Ini: <b>${toRupiah(incomeStats.todayIncome)}</b>

🛒 <b>TOTAL TRANSAKSI</b>
├ Seluruh Waktu: <b>${incomeStats.totalTransactions} transaksi</b>
├ Bulan Ini: <b>${incomeStats.monthCount} transaksi</b>
└ Hari Ini: <b>${incomeStats.todayCount} transaksi</b>

━━━━━━━━━━━━━━━━━━━━━━━━━━
⏰ Update: ${new Date().toLocaleString("id-ID")}
</blockquote>`;
  
  try {
    await ctx.editMessageText(message, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📋 Detail Transaksi", callback_data: "view_transactions" },
            { text: "🔄 Refresh", callback_data: "refresh_stats" }
          ],
          [{ text: "🔙 Menu Owner", callback_data: "menu_owner" }]
        ]
      }
    });
  } catch (error) {
    console.error("[ERROR] Failed to refresh stats:", error);
    await ctx.answerCbQuery("❌ Gagal memperbarui!", { show_alert: true });
  }
});

bot.action("full_statistics", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner!", { show_alert: true });
  }
  
  await ctx.answerCbQuery("📈 Memuat statistik lengkap...");
  
  const transactions = readTransactions();
  const incomeStats = getIncomeStats();
  
  // Hitung per kategori
  const categoryStats = {};
  transactions.forEach(trx => {
    const category = trx.type || 'other';
    categoryStats[category] = (categoryStats[category] || 0) + 1;
  });
  
  let categoryText = "";
  for (const [category, count] of Object.entries(categoryStats)) {
    categoryText += `├ ${category.toUpperCase()}: ${count} transaksi\n`;
  }
  
  const message = `
<blockquote>
📈 <b>STATISTIK LENGKAP</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━

📦 <b>KATEGORI PRODUK</b>
${categoryText || "└ Belum ada data"}

📅 <b>RINCIAN WAKTU</b>
├ Transaksi Pertama: ${transactions.length > 0 ? new Date(transactions[0].timestamp).toLocaleString("id-ID") : "-"}
├ Transaksi Terakhir: ${transactions.length > 0 ? new Date(transactions[transactions.length - 1].timestamp).toLocaleString("id-ID") : "-"}
└ Rata-rata/transaksi: ${toRupiah(Math.floor(incomeStats.totalIncome / Math.max(1, incomeStats.totalTransactions)))}

💰 <b>RINCIAN KEUANGAN</b>
├ Total Pemasukan: ${toRupiah(incomeStats.totalIncome)}
├ Rata-rata/transaksi: ${toRupiah(Math.floor(incomeStats.totalIncome / Math.max(1, incomeStats.totalTransactions)))}
└ Transaksi Tertinggi: ${toRupiah(Math.max(...transactions.map(t => t.amount || 0)))}

━━━━━━━━━━━━━━━━━━━━━━━━━━
ℹ️ Total Data: ${transactions.length} transaksi
</blockquote>`;
  
  try {
    await ctx.editMessageText(message, { 
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Kembali ke Detail", callback_data: "view_transactions" }]
        ]
      }
    });
  } catch (error) {
    await safeReply(ctx, message, { 
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Kembali ke Detail", callback_data: "view_transactions" }]
        ]
      }
    });
  }
});

bot.action("menu_owner_contact", async (ctx) => {
  const sleepNotice = isSleepingHours()
    ? `\n<blockquote>😴 <b>Owner sedang istirahat</b> (${String(config.sleepHours.start).padStart(2, "0")}:00-${String(config.sleepHours.end).padStart(2, "0")}:00). Balasan mungkin agak lama, tapi AI Customer Support tetap siap bantu 24 jam kok!</blockquote>\n`
    : "";
  await editMenuMessage(ctx,
    `<blockquote><b>╭━━━━✧「 📞 𝗞𝗢𝗡𝗧𝗔𝗞 𝗢𝗪𝗡𝗘𝗥 」✧━━━━❍</b>\n` +
    `<b>┃</b> 🍂 Nama     : ${config.ownerName || "𝗔𝗱𝗺𝗶𝗻"}\n` +
    `<b>┃</b> 📲 WhatsApp : ${config.ownerWa}\n` +
    `<b>┃</b> ✈️ Telegram : ${config.ownerUser}\n` +
    `<b>╰━━━━━━━━━━━━━━━━━━━━━━━━❍</b></blockquote>\n` +
    `📩 Kamu limit? Silakan tap command /pesan${sleepNotice}`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "💬 Kirim Pesan ke Owner", callback_data: "send_message_owner" }],
          [{ text: "🔙 Kembali", callback_data: "back_home" }]
        ]
      }
    }
  );
});

bot.action("send_message_owner", async (ctx) => {
  liveChatState[ctx.from.id] = { step: "WAITING_MESSAGE" };
  await editMenuMessage(ctx, 
    "<blockquote>📝 <b>Silakan ketik pesan yang ingin dikirim ke owner.</b>\n\n<i>Ketik /batal untuk membatalkan</i></blockquote>",
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "❌ Batalkan", callback_data: "back_home" }]
        ]
      }
    }
  );
});

bot.action("back_home", async (ctx) => {
  await ctx.answerCbQuery();
  
  // Aktifkan efek bot sedang mengetik
  await ctx.sendChatAction('typing');

  const stats = getBotStats();
  
  // Ambil statistik pemasukan
  let incomeStats = null;
  let totalPemasukanText = "Sedang dimuat...";
  let totalTransaksiText = "Sedang dimuat...";
  
  try {
    incomeStats = getIncomeStats();
    
    // Format total pemasukan
    totalPemasukanText = `<b>${toRupiah(incomeStats.totalIncome)}</b>`;
    
    // Format total transaksi
    totalTransaksiText = `<b>${incomeStats.totalTransactions} transaksi</b>`;
    
  } catch (error) {
    console.error("[ERROR] Gagal mengambil statistik pemasukan:", error);
    // Tetap tampilkan placeholder jika error
    totalPemasukanText = "<b>-</b>";
    totalTransaksiText = "<b>-</b>";
  }

  const isNewUser = checkAndAddUser(ctx.from);
  const cleanFirstName = cleanText(ctx.from.first_name || 'Pengguna');
  const cleanLastName = cleanText(ctx.from.last_name || '-');

  const welcomeText = `
<blockquote>
Hallo, <b>${cleanFirstName} 👋🏻</b>
Selamat datang di <b>${config.botName || "Bot"}</b>
━━━━━━━━━━━━━━━━━━━━━━
🤖 <b>𝗜𝗻𝗳𝗼𝗿𝗺𝗮𝘀𝗶 𝗣𝗿𝗼𝗳𝗶𝗹𝗲 𝗕𝗼𝘁</b>
ᯤ Runtime: ${stats.runtime}
ᯤ Total User: ${stats.totalUsers}
ᯤ Version: AutoOrder Premium
ᯤ Total Pemasukan: ${totalPemasukanText}
ᯤ Total Transaksi: ${totalTransaksiText}
━━━━━━━━━━━━━━━━━━━━━━
🪪 <b>𝗜𝗻𝗳𝗼𝗿𝗺𝗮𝘀𝗶 𝗣𝗿𝗼𝗳𝗶𝗹 𝗔𝗻𝗱𝗮</b>
ᯤ ID: ${ctx.from.id}
ᯤ Nama Depan: ${cleanFirstName}
ᯤ Nama Belakang: ${cleanLastName}
━━━━━━━━━━━━━━━━━━━━━━
Gunakan Menu Button <b>Buka Katalog</b>
Dibawah untuk Melihat List Produk
Yang Tersedia
</blockquote>
`;

  // ✅ KEYBOARD BARU
  const menuKeyboard = {
    inline_keyboard: [
      [
        { text: "📦 𝗕𝘂𝗸𝗮 𝗞𝗮𝘁𝗮𝗹𝗼𝗴", callback_data: "menu_katalog" }
      ],
      [
        { text: "⭐ 𝗧𝗲𝘀𝘁𝗶𝗺𝗼𝗻𝗶", url: "https://t.me/dimas_storebot" },
        { text: "👨‍💻 𝗗𝗲𝘃𝗲𝗹𝗼𝗽𝗲𝗿", url: "https://t.me/dimas_store19" }
      ]
    ]
  };

  // Tambahkan delay untuk efek typing yang lebih natural
  await new Promise(resolve => setTimeout(resolve, 400));

  if (config.startPhoto) {
    try {
      // Coba edit message dengan foto
      await ctx.editMessageMedia(
        {
          type: "photo",
          media: config.startPhoto,
          caption: welcomeText,
          parse_mode: "HTML"
        },
        { reply_markup: menuKeyboard }
      );
    } catch (e) {
      console.error("[ERROR] Gagal mengedit pesan dengan foto (back_home):", e);
      
      // Jika editMessageMedia gagal, coba kirim pesan baru dengan foto
      try {
        await ctx.replyWithPhoto(config.startPhoto, {
          caption: welcomeText,
          parse_mode: "HTML",
          reply_markup: menuKeyboard,
          message_effect_id: randomEffectId
        });
        
        // Hapus pesan sebelumnya jika perlu
        try {
          await ctx.deleteMessage();
        } catch (deleteErr) {
          console.error("[WARNING] Gagal menghapus pesan lama (back_home):", deleteErr);
        }
      } catch (photoErr) {
        console.error("[ERROR] Gagal mengirim pesan foto baru (back_home):", photoErr);
        
        // Fallback ke edit teks biasa
        try {
          await ctx.editMessageText(welcomeText, {
            parse_mode: "HTML",
            reply_markup: menuKeyboard,
            message_effect_id: randomEffectId
          });
        } catch (editErr) {
          console.error("[ERROR] Gagal edit pesan teks (back_home):", editErr);
          
          // Kirim pesan baru sebagai last resort
          await safeReply(ctx, welcomeText, {
            parse_mode: "HTML",
            reply_markup: menuKeyboard,
            message_effect_id: randomEffectId
          });
        }
      }
    }
  } else {
    try {
      // Edit pesan teks saja
      await ctx.editMessageText(welcomeText, {
        parse_mode: "HTML",
        reply_markup: menuKeyboard,
        message_effect_id: randomEffectId
      });
    } catch (e) {
      console.error("[ERROR] Gagal mengedit pesan teks (back_home):", e);
      
      // Kirim pesan baru sebagai fallback
      await safeReply(ctx, welcomeText, {
        parse_mode: "HTML",
        reply_markup: menuKeyboard,
        message_effect_id: randomEffectId
      });
    }
  }
});

function showOwnerMenu(ctx) {
  if (ctx.from.id !== config.ownerId) 
    return safeReply(ctx, "<blockquote>🚫 𝗞𝗮𝗺𝘂 𝗕𝘂𝗸𝗮𝗻 𝗢𝘄𝗻𝗲𝗿 𝗕𝗼𝘁!</blockquote>", { parse_mode: "HTML" });

  const db = readDb();
  const panelStatus = db.isPanelOpen ? "🟢" : "🔴";
  const adminPanelStatus = db.isAdminPanelOpen ? "🟢" : "🔴";
  const muridPanelStatus = db.isMuridPanelOpen ? "🟢" : "🔴";

  safeReply(ctx, `<blockquote><b>👑 𝗠𝗘𝗡𝗨 𝗢𝗪𝗡𝗘𝗥</b>\n<b>𝖲𝗂𝗅𝖺𝗁𝗄𝖺𝗇 𝖳𝖾𝗄𝖺𝗇 𝖡𝗎𝗋𝗍𝗈𝗇 𝖣𝗂𝖻𝖺𝗐𝖺𝗁:</b></blockquote>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [ 
          Markup.button.callback(`${panelStatus} Panel Online/Offline`, "owner_panel"),
          Markup.button.callback(`${adminPanelStatus} Admin Panel`, "owner_adminpanel"),
          Markup.button.callback(`${muridPanelStatus} Murid Panel`, "owner_muridpanel") 
        ],
        [ Markup.button.callback("📢 Broadcast", "owner_broadcast") ],
        [
          Markup.button.callback("➕ Add Script", "add_script"),
          Markup.button.callback("🗑 Delete Script", "del_script")
        ],
        [
          Markup.button.callback("📱 Add App Premium", "add_app"),
          Markup.button.callback("🗑 Delete App", "del_app")
        ],
        [
          Markup.button.callback("➕ Add Account", "owner_add_account"),
          Markup.button.callback("🗑 Delete Account", "owner_del_account")
        ],
        [
          Markup.button.callback("📧 Add Stok Gmail", "owner_add_gmail_stock"),
          Markup.button.callback("🗑 Delete Stok Gmail", "owner_del_gmail_stock")
        ],
        [
          Markup.button.callback("📶 Add Stok Notel", "owner_add_notel_stock"),
          Markup.button.callback("🗑 Delete Stok Notel", "owner_del_notel_stock")
        ],
        [
          Markup.button.callback("⚡ Create VPS", "create_vps_menu"),
          Markup.button.callback("📋 List VPS", "list_vps_digitalocean")
        ],
        [
          Markup.button.callback("🌐 Create Subdomain", "menu_subdomain"),
          Markup.button.callback("📋 List Subdomain", "menu_list_subdomain")
        ],
        [
          Markup.button.callback("🌐 Cek Status DO", "check_do_status"),
          Markup.button.callback("🔑 Update API DO", "update_do_api")
        ],        
        [ Markup.button.callback("🖥️ List VPS Orders", "list_vps_orders") ],
        [ Markup.button.callback("📃 List App Premium", "list_apps") ],
        [ Markup.button.callback("👑 List Admin Panel", "list_adminpanel") ],
        [ Markup.button.callback("🎫 Kelola Voucher", "manage_vouchers") ],
        [ Markup.button.callback("🗂️ Kelola FAQ", "manage_faq") ],
        [ Markup.button.callback("💳 Ganti Payment", "change_payment") ],
        [ Markup.button.callback("🩺 Tes Payment Gateway", "paymentstatus_menu") ],
        [ Markup.button.callback("🧾 Manual Payments", "manual_payments_menu") ],
        [ Markup.button.callback("💰 Withdraw RumahOTP", "wd_rumahotp_start") ],
        [ Markup.button.callback("💚 Withdraw Nevapedia", "wd_nevapedia_start") ],
        [ Markup.button.callback("🦖 Kelola Pterodactyl", "ptero_menu") ],
        [ Markup.button.callback("💾 Backup Database", "backup_database") ],
        [ Markup.button.callback("📊 Statistik Pemasukan", "stats") ],
        [ Markup.button.callback("📉 Statistik Voucher", "voucher_stats") ],
        [ Markup.button.callback("🔙 Kembali", "back_home") ]
      ])
    }
  );
}

bot.action("smm_menu", async (ctx) => {
  const userId = ctx.from.id;
  const saldoData = JSON.parse(
    fs.readFileSync("./database/saldoOtp.json", "utf8") || "{}"
  );
  const saldo = saldoData[userId] || 0;

  const caption = `
<blockquote>
━━━━━━━━━━━━━━━━━━━━━
<b>🔥 SUNTIK SOSIAL MEDIA 🔥</b>
━━━━━━━━━━━━━━━━━━━━━

<b>Tingkatkan Popularitas Akunmu</b>  
<b>Followers • Likes • Views • Subscriber</b>

━━━━━━━━━━━━━━━━━━━━━
<b>👤 User</b> : ${ctx.from.first_name}
<b>💰 Saldo</b> : ${toRupiah(saldo)}

━━━━━━━━━━━━━━━━━━━━━

<b>🚀 LAYANAN TERSEDIA</b>
<b>• Proses Cepat & Otomatis</b>
<b>• Harga Bersahabat</b>
<b>• Aman & Terpercaya</b>

━━━━━━━━━━━━━━━━━━━━━
<b>Silakan Pilih Menu Di Bawah</b>  
<b>Dan Mulai Order Sekarang 🚀</b>
━━━━━━━━━━━━━━━━━━━━━
</blockquote>
`;

  await ctx.editMessageMedia(
    {
      type: "photo",
      media: config.startMedia,
      caption,
      parse_mode: "HTML"
    },
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "➕ ☇ Deposit Saldo", callback_data: "topup_nokos" }],
          [{ text: "🛒 ☇ Daftar Layanan", callback_data: "smm_services_0" }],
          [{ text: "📜 ☇ Riwayat Order", callback_data: "smm_history" }],
          [{ text: "🔍 ☇ Cek Status Order", callback_data: "smm_check_status" }],
          [{ text: "🔙 ☇ Kembali", callback_data: "menu_katalog_v2" }]
        ]
      }
    }
  );
});

bot.action("menu_list_subdomain", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang boleh melihat daftar subdomain!", { show_alert: true });
  }

  await ctx.answerCbQuery();

  const subdomainConfig = config.subdomain || {};
  const domains = Object.keys(subdomainConfig);

  if (domains.length === 0) {
    return editMenuMessage(ctx,
      "<blockquote>❌ <b>Tidak ada domain yang tersedia.</b>\n\nTambahkan konfigurasi subdomain di config.js terlebih dahulu.</blockquote>",
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "menu_owner" }]
          ]
        }
      }
    );
  }

  // Buat tombol untuk setiap domain
  const buttons = [];
  for (let i = 0; i < domains.length; i += 2) {
    const row = [];
    
    // Tombol pertama
    row.push({
      text: `📋 ${domains[i]}`,
      callback_data: `list_subdomain_${i}`
    });
    
    // Tombol kedua (jika ada)
    if (domains[i + 1]) {
      row.push({
        text: `📋 ${domains[i + 1]}`,
        callback_data: `list_subdomain_${i + 1}`
      });
    }
    
    buttons.push(row);
  }
  
  buttons.push([{ text: "🔙 Kembali", callback_data: "menu_owner" }]);

  await editMenuMessage(ctx,
    "<blockquote><b>📋 PILIH DOMAIN UNTUK DILIHAT SUBDOMAINNYA</b>\n\nPilih domain yang ingin dilihat daftar subdomainnya:</blockquote>",
    {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons }
    }
  );
});

// Handler untuk menampilkan daftar subdomain
bot.action(/^list_subdomain_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang boleh melihat daftar subdomain!", { show_alert: true });
  }

  const domainIndex = parseInt(ctx.match[1]);
  
  await ctx.answerCbQuery("⏳ Mengambil daftar subdomain...");

  const subdomainConfig = config.subdomain || {};
  const domains = Object.keys(subdomainConfig);

  if (domainIndex < 0 || domainIndex >= domains.length) {
    return safeReply(ctx,
      "<blockquote>❌ <b>Domain tidak ditemukan!</b></blockquote>",
      { parse_mode: "HTML" }
    );
  }

  const selectedDomain = domains[domainIndex];
  const domainConfig = subdomainConfig[selectedDomain];

  if (!domainConfig || !domainConfig.zone || !domainConfig.apitoken) {
    return safeReply(ctx,
      "<blockquote>❌ <b>Konfigurasi domain tidak lengkap!</b>\n\nPastikan zone dan apitoken terisi di config.js</blockquote>",
      { parse_mode: "HTML" }
    );
  }

  // Kirim pesan loading
  const loadingMsg = await editMenuMessage(ctx,
    `<blockquote>⏳ <b>Mengambil daftar subdomain...</b>\n\n<b>Domain:</b> ${selectedDomain}</blockquote>`,
    { parse_mode: "HTML" }
  );

  try {
    // Fungsi untuk mengambil daftar subdomain dari Cloudflare
    async function getSubdomainList(domain, config) {
      try {
        const response = await axios.get(
          `https://api.cloudflare.com/client/v4/zones/${config.zone}/dns_records?type=A&per_page=100`,
          {
            headers: {
              "Authorization": `Bearer ${config.apitoken}`,
              "Content-Type": "application/json"
            },
            timeout: 30000
          }
        );

        const res = response.data;
        
        if (res.success) {
          // Filter hanya subdomain (bukan domain utama)
          const subdomains = res.result.filter(record => 
            record.name.endsWith(`.${domain}`) && record.name !== domain
          );
          
          return {
            success: true,
            domain: domain,
            total: subdomains.length,
            subdomains: subdomains.map(record => ({
              name: record.name,
              ip: record.content,
              created: record.created_on,
              id: record.id,
              proxied: record.proxied,
              ttl: record.ttl
            }))
          };
        } else {
          const errorMsg = res.errors?.[0]?.message || "Gagal mengambil daftar subdomain";
          return { success: false, error: errorMsg };
        }
      } catch (error) {
        console.error("[ERROR] Cloudflare API Error:", error.response?.data || error.message);
        
        let errorMsg = "Terjadi kesalahan";
        if (error.response?.data?.errors?.[0]?.message) {
          errorMsg = error.response.data.errors[0].message;
        } else if (error.message) {
          errorMsg = error.message;
        }
        
        return { success: false, error: errorMsg };
      }
    }

    // Panggil fungsi untuk mengambil daftar subdomain
    const result = await getSubdomainList(selectedDomain, domainConfig);

    if (result.success) {
      if (result.total === 0) {
        const emptyText = `<blockquote>📭 <b>BELUM ADA SUBDOMAIN</b>\n\n` +
          `<b>Domain:</b> ${selectedDomain}\n` +
          `<b>Total Subdomain:</b> 0\n\n` +
          `<i>Belum ada subdomain yang dibuat untuk domain ini.</i></blockquote>`;

        await editMenuMessage(ctx, emptyText, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🌐 Buat Subdomain", callback_data: "menu_subdomain" }],
              [{ text: "🔙 Kembali", callback_data: "menu_list_subdomain" }]
            ]
          }
        });
      } else {
        // Tampilkan daftar subdomain dengan pagination
        const subdomains = result.subdomains;
        const itemsPerPage = 10;
        let page = 0;
        const totalPages = Math.ceil(subdomains.length / itemsPerPage);

        // Fungsi untuk membuat teks daftar subdomain
        function createSubdomainListText(domain, subdomainsList, currentPage, totalPages) {
          const startIndex = currentPage * itemsPerPage;
          const endIndex = startIndex + itemsPerPage;
          const pageItems = subdomainsList.slice(startIndex, endIndex);
          
          let text = `<blockquote><b>📋 DAFTAR SUBDOMAIN</b>\n\n` +
            `<b>Domain:</b> ${domain}\n` +
            `<b>Total:</b> ${subdomainsList.length} subdomain\n` +
            `<b>Halaman:</b> ${currentPage + 1}/${totalPages}\n\n`;
          
          pageItems.forEach((subdomain, index) => {
            const globalIndex = startIndex + index;
            const status = subdomain.proxied ? "🛡️ (Proxied)" : "🌐 (DNS Only)";
            const createdDate = new Date(subdomain.created).toLocaleDateString("id-ID");
            
            text += `<b>${globalIndex + 1}. ${subdomain.name}</b>\n` +
              `   <code>IP:</code> ${subdomain.ip}\n` +
              `   <code>TTL:</code> ${subdomain.ttl} | ${status}\n` +
              `   <code>Dibuat:</code> ${createdDate}\n\n`;
          });
          
          text += `</blockquote>`;
          return text;
        }

        // Fungsi untuk membuat keyboard pagination
        function createSubdomainListKeyboard(currentPage, totalPages, domainIndex) {
          const buttons = [];
          
          // Tombol navigasi
          const navButtons = [];
          if (currentPage > 0) {
            navButtons.push({
              text: "⬅️ Prev",
              callback_data: `subdomain_page_${domainIndex}_${currentPage - 1}`
            });
          }
          
          navButtons.push({
            text: `${currentPage + 1}/${totalPages}`,
            callback_data: `subdomain_page_info`
          });
          
          if (currentPage < totalPages - 1) {
            navButtons.push({
              text: "Next ➡️",
              callback_data: `subdomain_page_${domainIndex}_${currentPage + 1}`
            });
          }
          
          if (navButtons.length > 0) {
            buttons.push(navButtons);
          }
          
          // Tombol aksi
          buttons.push([
            { text: "🌐 Buat Baru", callback_data: "menu_subdomain" }
          ]);
          
          buttons.push([
            { text: "🔙 Kembali ke List Domain", callback_data: "menu_list_subdomain" },
            { text: "🔙 Menu Owner", callback_data: "menu_owner" }
          ]);
          
          return buttons;
        }

        // Tampilkan halaman pertama
        const listText = createSubdomainListText(selectedDomain, subdomains, page, totalPages);
        const listKeyboard = createSubdomainListKeyboard(page, totalPages, domainIndex);

        await editMenuMessage(ctx, listText, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: listKeyboard }
        });

        // Simpan data subdomain di state untuk pagination
        if (!userState[ctx.from.id]) {
          userState[ctx.from.id] = {};
        }
        userState[ctx.from.id].subdomainList = {
          domain: selectedDomain,
          domainIndex: domainIndex,
          subdomains: subdomains,
          itemsPerPage: itemsPerPage,
          totalPages: totalPages
        };
      }

    } else {
      await editMenuMessage(ctx,
        `<blockquote>❌ <b>GAGAL MENGAMBIL DAFTAR SUBDOMAIN</b>\n\n` +
        `<b>Error:</b> ${result.error}\n\n` +
        `<b>Domain:</b> ${selectedDomain}\n\n` +
        `<i>Silakan coba lagi atau periksa konfigurasi Cloudflare.</i></blockquote>`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Coba Lagi", callback_data: `list_subdomain_${domainIndex}` }],
              [{ text: "🔙 Menu Owner", callback_data: "menu_owner" }]
            ]
          }
        }
      );
    }

  } catch (error) {
    console.error("[ERROR] Get subdomain list:", error);
    
    await editMenuMessage(ctx,
      `<blockquote>❌ <b>TERJADI KESALAHAN SISTEM</b>\n\n` +
      `<b>Error:</b> ${error.message}\n\n` +
      `<i>Silakan coba lagi nanti.</i></blockquote>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 Menu Owner", callback_data: "menu_owner" }]
          ]
        }
      }
    );
  }
});

// Handler untuk pagination list subdomain
bot.action(/^subdomain_page_(\d+)_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang boleh melihat daftar subdomain!", { show_alert: true });
  }

  const domainIndex = parseInt(ctx.match[1]);
  const page = parseInt(ctx.match[2]);
  
  await ctx.answerCbQuery();

  const state = userState[ctx.from.id];
  if (!state || !state.subdomainList) {
    return safeReply(ctx,
      "<blockquote>❌ <b>Data tidak ditemukan!</b>\n\nSilakan muat ulang daftar subdomain.</blockquote>",
      { parse_mode: "HTML" }
    );
  }

  const { domain, subdomains, itemsPerPage, totalPages } = state.subdomainList;
  
  if (page < 0 || page >= totalPages) {
    return ctx.answerCbQuery("❌ Halaman tidak valid!", { show_alert: true });
  }

  // Perbarui teks dan keyboard untuk halaman baru
  const listText = createSubdomainListText(domain, subdomains, page, totalPages);
  const listKeyboard = createSubdomainListKeyboard(page, totalPages, domainIndex);

  await editMenuMessage(ctx, listText, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: listKeyboard }
  });
});

// Handler untuk info halaman (placeholder)
bot.action("subdomain_page_info", async (ctx) => {
  await ctx.answerCbQuery("📖 Informasi halaman", { show_alert: false });
});

bot.action("menu_subdomain", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang boleh membuat subdomain!", { show_alert: true });
  }

  await ctx.answerCbQuery();

  const subdomainConfig = config.subdomain || {};
  const domains = Object.keys(subdomainConfig);

  if (domains.length === 0) {
    return editMenuMessage(ctx,
      "<blockquote>❌ <b>Tidak ada domain yang tersedia.</b>\n\nTambahkan konfigurasi subdomain di config.js terlebih dahulu.</blockquote>",
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "menu_owner" }]
          ]
        }
      }
    );
  }

  // Set state untuk menunggu input hostname dan IP
  userState[ctx.from.id] = { 
    step: "WAITING_SUBDOMAIN_INPUT",
    domains: domains,
    cancelCallback: "menu_owner" // Tambahkan ini
  };

  await editMenuMessage(ctx,
    "<blockquote><b>🌐 CREATE SUBDOMAIN</b>\n\n📝 <b>Kirim format:</b>\n<code>hostname|ipvps</code>\n\n<b>Contoh:</b>\n<code>myserver|103.167.112.45</code>\n\n<i>Hostname akan digabung dengan domain yang tersedia.</i></blockquote>",
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "❌ Batalkan", callback_data: "cancel_subdomain" }] // Ubah callback_data
        ]
      }
    }
  );
});

bot.on("text", async (ctx, next) => {
  try {
    const userId = ctx.from.id;
    const text = ctx.message.text;

    const state = userState[userId];
    
    // Cek jika user membatalkan dengan command /cancel
    if (text === "/cancel" && state?.step?.startsWith("WAITING_")) {
      // Hapus state
      delete userState[userId];
      
      return safeReply(ctx,
        "<blockquote>❌ <b>OPERASI DIBATALKAN</b>\n\nTidak ada perubahan yang dilakukan.</blockquote>",
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔙 Menu Owner", callback_data: "menu_owner" }]
            ]
          }
        }
      );
    }
    
    if (state?.step === "WAITING_SUBDOMAIN_INPUT" && userId === config.ownerId) {
      if (!text.includes("|")) {
        return safeReply(ctx, 
          "<blockquote>❌ <b>Format salah!</b>\n\nGunakan format: <code>hostname|ipvps</code>\n\n<b>Contoh:</b> <code>myserver|103.167.112.45</code>\n\nKetik <code>/cancel</code> untuk membatalkan.</blockquote>",
          { parse_mode: "HTML" }
        );
      }

      const [hostname, ip] = text.split("|").map(item => item.trim());
      
      if (!hostname || !ip) {
        return safeReply(ctx,
          "<blockquote>❌ <b>Format tidak lengkap!</b>\n\nPastikan hostname dan IP terisi.\n<b>Contoh:</b> <code>myserver|103.167.112.45</code>\n\nKetik <code>/cancel</code> untuk membatalkan.</blockquote>",
          { parse_mode: "HTML" }
        );
      }

      // Validasi hostname
      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/.test(hostname)) {
        return safeReply(ctx,
          "<blockquote>❌ <b>Hostname tidak valid!</b>\n\n• Hanya boleh huruf, angka, dan tanda hubung (-)\n• Tidak boleh diawali atau diakhiri dengan tanda hubung\n• Minimal 1 karakter\n\nKetik <code>/cancel</code> untuk membatalkan.</blockquote>",
          { parse_mode: "HTML" }
        );
      }

      // Validasi IP
      const ipRegex = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
      if (!ipRegex.test(ip)) {
        return safeReply(ctx,
          "<blockquote>❌ <b>Alamat IP tidak valid!</b>\n\nMasukkan alamat IP yang valid (contoh: 103.167.112.45)\n\nKetik <code>/cancel</code> untuk membatalkan.</blockquote>",
          { parse_mode: "HTML" }
        );
      }

      // Simpan data dan tampilkan pilihan domain
      userState[userId] = {
        ...state,
        step: "WAITING_DOMAIN_SELECTION",
        hostname: hostname.toLowerCase(),
        ip: ip,
        cancelCallback: "menu_owner"
      };

      const domains = state.domains;
      
      // Buat tombol untuk setiap domain
      const buttons = [];
      for (let i = 0; i < domains.length; i += 2) {
        const row = [];
        
        // Tombol pertama
        row.push({
          text: domains[i],
          callback_data: `create_subdomain_${i}_${hostname}|${ip}`
        });
        
        // Tombol kedua (jika ada)
        if (domains[i + 1]) {
          row.push({
            text: domains[i + 1],
            callback_data: `create_subdomain_${i + 1}_${hostname}|${ip}`
          });
        }
        
        buttons.push(row);
      }
      
      // Tambahkan tombol batal
      buttons.push([{ text: "❌ Batalkan", callback_data: "cancel_subdomain" }]);

      await safeReply(ctx,
        `<blockquote><b>🌐 PILIH DOMAIN</b>\n\n<b>Hostname:</b> <code>${hostname}</code>\n<b>IP:</b> <code>${ip}</code>\n\nPilih domain yang ingin digunakan:</blockquote>`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: buttons }
        }
      );

      return;
    }
  } catch (e) {
    console.error("[ERROR] Subdomain input handler:", e);
  }
  
  return next();
});

bot.action("cancel_subdomain", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang boleh melakukan aksi ini!", { show_alert: true });
  }

  await ctx.answerCbQuery("❌ Dibatalkan");

  // Hapus state jika ada
  if (userState[ctx.from.id]) {
    delete userState[ctx.from.id];
  }

  await editMenuMessage(ctx,
    "<blockquote>❌ <b>PEMBUATAN SUBDOMAIN DIBATALKAN</b>\n\nTidak ada subdomain yang dibuat.</blockquote>",
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Kembali ke Menu Owner", callback_data: "menu_owner" }]
        ]
      }
    }
  );
});

// Handler untuk membuat subdomain
bot.action(/^create_subdomain_(\d+)_(.+)$/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang boleh membuat subdomain!", { show_alert: true });
  }

  const domainIndex = parseInt(ctx.match[1]);
  const [hostname, ip] = ctx.match[2].split("|");
  
  await ctx.answerCbQuery("⏳ Membuat subdomain...");

  const subdomainConfig = config.subdomain || {};
  const domains = Object.keys(subdomainConfig);

  if (domainIndex < 0 || domainIndex >= domains.length) {
    return safeReply(ctx,
      "<blockquote>❌ <b>Domain tidak ditemukan!</b></blockquote>",
      { parse_mode: "HTML" }
    );
  }

  const selectedDomain = domains[domainIndex];
  const domainConfig = subdomainConfig[selectedDomain];

  if (!domainConfig || !domainConfig.zone || !domainConfig.apitoken) {
    return safeReply(ctx,
      "<blockquote>❌ <b>Konfigurasi domain tidak lengkap!</b>\n\nPastikan zone dan apitoken terisi di config.js</blockquote>",
      { parse_mode: "HTML" }
    );
  }

  // Kirim pesan loading dengan tombol batal
  const loadingMsg = await editMenuMessage(ctx,
    `<blockquote>⏳ <b>Membuat subdomain...</b>\n\n` +
    `<b>Hostname:</b> ${hostname}\n` +
    `<b>Domain:</b> ${selectedDomain}\n` +
    `<b>IP:</b> ${ip}\n\n` +
    `<i>Sedang memproses...</i></blockquote>`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "❌ Batalkan Proses", callback_data: "cancel_subdomain_process" }]
        ]
      }
    }
  );

  try {
    // Fungsi untuk membuat subdomain di Cloudflare
    async function createSubDomain(host, ipAddress, domain, config) {
      try {
        const subdomainName = `${host}.${domain}`;
        
        const response = await axios.post(
          `https://api.cloudflare.com/client/v4/zones/${config.zone}/dns_records`,
          {
            type: "A",
            name: subdomainName,
            content: ipAddress,
            ttl: 1,
            proxied: false
          },
          {
            headers: {
              "Authorization": `Bearer ${config.apitoken}`,
              "Content-Type": "application/json"
            },
            timeout: 30000
          }
        );

        const res = response.data;
        
        if (res.success) {
          return {
            success: true,
            name: res.result.name,
            ip: res.result.content,
            created: res.result.created_on,
            id: res.result.id
          };
        } else {
          const errorMsg = res.errors?.[0]?.message || "Gagal membuat subdomain";
          return { success: false, error: errorMsg };
        }
      } catch (error) {
        console.error("[ERROR] Cloudflare API Error:", error.response?.data || error.message);
        
        let errorMsg = "Terjadi kesalahan";
        if (error.response?.data?.errors?.[0]?.message) {
          errorMsg = error.response.data.errors[0].message;
        } else if (error.message) {
          errorMsg = error.message;
        }
        
        return { success: false, error: errorMsg };
      }
    }

    // Panggil fungsi untuk membuat subdomain
    const result = await createSubDomain(hostname, ip, selectedDomain, domainConfig);

    if (result.success) {
      const successText = `<blockquote>✅ <b>SUBDOMAIN BERHASIL DIBUAT!</b>\n\n` +
        `<b>🌐 Subdomain:</b>\n<code>${result.name}</code>\n\n` +
        `<b>📍 IP Address:</b>\n<code>${result.ip}</code>\n\n` +
        `<b>📅 Dibuat pada:</b>\n${new Date(result.created).toLocaleString("id-ID")}\n\n` +
        `<b>🆔 Record ID:</b>\n<code>${result.id}</code>\n\n` +
        `<i>Subdomain siap digunakan!</i></blockquote>`;

      await editMenuMessage(ctx, successText, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "➕ Buat Lagi", callback_data: "menu_subdomain" }],
            [{ text: "🔙 Menu Owner", callback_data: "menu_owner" }]
          ]
        }
      });

      // Kirim notifikasi ke owner
      await bot.telegram.sendMessage(
        config.ownerId,
        `<b>🌐 SUBDOMAIN BARU DIBUAT</b>\n\n` +
        `<b>Domain:</b> ${result.name}\n` +
        `<b>IP:</b> ${result.ip}\n` +
        `<b>Waktu:</b> ${new Date().toLocaleString("id-ID")}\n` +
        `<b>Dibuat oleh:</b> ${ctx.from.first_name}`,
        { parse_mode: "HTML" }
      );

    } else {
      await editMenuMessage(ctx,
        `<blockquote>❌ <b>GAGAL MEMBUAT SUBDOMAIN</b>\n\n` +
        `<b>Error:</b> ${result.error}\n\n` +
        `<b>Hostname:</b> ${hostname}\n` +
        `<b>Domain:</b> ${selectedDomain}\n` +
        `<b>IP:</b> ${ip}\n\n` +
        `<i>Silakan coba lagi atau periksa konfigurasi Cloudflare.</i></blockquote>`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Coba Lagi", callback_data: "menu_subdomain" }],
              [{ text: "🔙 Menu Owner", callback_data: "menu_owner" }]
            ]
          }
        }
      );
    }

  } catch (error) {
    console.error("[ERROR] Create subdomain:", error);
    
    await editMenuMessage(ctx,
      `<blockquote>❌ <b>TERJADI KESALAHAN SISTEM</b>\n\n` +
      `<b>Error:</b> ${error.message}\n\n` +
      `<i>Silakan coba lagi nanti.</i></blockquote>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Coba Lagi", callback_data: "menu_subdomain" }],
            [{ text: "🔙 Menu Owner", callback_data: "menu_owner" }]
          ]
        }
      }
    );
  }
});

// Handler untuk membatalkan proses pembuatan subdomain
bot.action("cancel_subdomain_process", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang boleh melakukan aksi ini!", { show_alert: true });
  }

  await ctx.answerCbQuery("❌ Proses dibatalkan");

  await editMenuMessage(ctx,
    "<blockquote>❌ <b>PROSES PEMBUATAN SUBDOMAIN DIBATALKAN</b>\n\nTidak ada subdomain yang dibuat.</blockquote>",
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "➕ Buat Subdomain Baru", callback_data: "menu_subdomain" }],
          [{ text: "🔙 Menu Owner", callback_data: "menu_owner" }]
        ]
      }
    }
  );
});

bot.action("cancel_from_domain_selection", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang boleh melakukan aksi ini!", { show_alert: true });
  }

  await ctx.answerCbQuery("❌ Dibatalkan");

  // Hapus state jika ada
  if (userState[ctx.from.id]) {
    delete userState[ctx.from.id];
  }

  await editMenuMessage(ctx,
    "<blockquote>❌ <b>PEMBUATAN SUBDOMAIN DIBATALKAN</b>\n\nTidak ada subdomain yang dibuat.</blockquote>",
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Kembali ke Menu Owner", callback_data: "menu_owner" }]
        ]
      }
    }
  );
});

bot.action("update_do_api", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang bisa update API key!", { show_alert: true });
  }
  
  await ctx.answerCbQuery();
  

  userState[ctx.from.id] = { step: "WAITING_DO_APIKEY" };
  
  // Tampilkan status akun saat ini
  let currentStatus = "";
  const apiKey = config.ApiDO1;
  
  if (apiKey && apiKey !== "-") {
    // Sensor API key untuk keamanan (tampilkan 10 karakter pertama dan 5 karakter terakhir)
    const maskedKey = apiKey.substring(0, 10) + "..." + apiKey.substring(apiKey.length - 5);
    currentStatus += `📝 <b>ApiDO1:</b> ${maskedKey}\n`;
    currentStatus += `🔑 <b>Status:</b> ✅ Terkonfigurasi\n`;
  } else {
    currentStatus += `📝 <b>ApiDO1:</b> ❌ Belum diatur\n`;
    currentStatus += `🔑 <b>Status:</b> ❌ Tidak aktif\n`;
  }
  
  const message = `<b>🔑 UPDATE API KEY DIGITAL OCEAN</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n<b>📋 AKUN SAAT INI:</b>\n${currentStatus}\n━━━━━━━━━━━━━━━━━━━━━━\n\n<blockquote>Silakan kirim API Key Digital Ocean yang baru:\n\n<code>Format: dop_v1_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx</code>\n\n<b>⚠️ PASTIKAN API KEY BENAR DAN VALID!</b></blockquote>`;
  
  const buttons = [
    [
      { text: "❌ Batalkan", callback_data: "menu_owner" },
      { text: "🌐 Test API Key", callback_data: "test_do_apikey" }
    ]
  ];
  
  await editMenuMessage(ctx, message, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons }
  });
});

// Handler untuk test API key
bot.action("test_do_apikey", async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  
  const apiKey = config.ApiDO1;
  
  if (!apiKey || apiKey === "-") {
    return ctx.answerCbQuery("❌ API key belum diatur!", { show_alert: true });
  }
  
  await ctx.answerCbQuery("⏳ Menguji API key...");
  
  const loadingMsg = await safeReply(ctx, "<blockquote>🔍 <b>Menguji API key DigitalOcean...</b></blockquote>", {
    parse_mode: "HTML"
  });
  
  try {
    const status = await checkDigitalOceanAccountStatus(apiKey);
    
    if (loadingMsg) {
      try {
        await ctx.deleteMessage(loadingMsg.message_id);
      } catch (e) {}
    }
    
    if (status.success) {
      const acc = status.account;
      const testMessage = `<b>✅ API KEY VALID!</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      testMessage += `<b>📧 Email:</b> ${acc.email}\n`;
      testMessage += `<b>🟢 Status:</b> ${acc.statusEmoji} ${acc.status}\n`;
      testMessage += `<b>📊 Droplets:</b> ${acc.totalDroplets}\n`;
      testMessage += `<b>✅ Available:</b> ${acc.availableDroplets}\n\n`;
      testMessage += `<i>✅ API key dapat digunakan dengan baik.</i>`;
      
      await safeReply(ctx, testMessage, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔙 Kembali", callback_data: "update_do_api" },
              { text: "🌐 Cek Status", callback_data: "check_do_status" }
            ]
          ]
        }
      });
      
    } else {
      await safeReply(ctx, `<blockquote>❌ <b>API KEY TIDAK VALID!</b>\n\n<b>Error:</b> ${status.message}</blockquote>`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "update_do_api" }]
          ]
        }
      });
    }
    
  } catch (error) {
    if (loadingMsg) {
      try {
        await ctx.deleteMessage(loadingMsg.message_id);
      } catch (e) {}
    }
    
    await safeReply(ctx, `<blockquote>❌ <b>Error testing API:</b>\n${error.message}</blockquote>`, {
      parse_mode: "HTML"
    });
  }
});

bot.action("check_do_status", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang bisa cek status DO!", { show_alert: true });
  }
  
  await ctx.answerCbQuery("⏳ Memeriksa status akun DigitalOcean...");
  
  const loadingMsg = await safeReply(ctx, "<blockquote>🔍 <b>Memeriksa status akun DigitalOcean...</b>\nMohon tunggu sebentar.</blockquote>", {
    parse_mode: "HTML"
  });
  
  try {
    // Cek ApiDO1 saja
    const apiKey = config.ApiDO1;
    
    if (!apiKey || apiKey === "-") {
      if (loadingMsg) {
        try {
          await ctx.deleteMessage(loadingMsg.message_id);
        } catch (e) {}
      }
      
      return safeReply(ctx, `<blockquote>❌ <b>API KEY DIGITALOCEAN BELUM DIATUR!</b></blockquote>\n\n<blockquote>Silakan atur API key DigitalOcean terlebih dahulu:</blockquote>`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔑 Atur API Key", callback_data: "update_do_api" }],
            [{ text: "🔙 Kembali", callback_data: "menu_owner" }]
          ]
        }
      });
    }
    
    const status = await checkDigitalOceanAccountStatus(apiKey);
    
    if (loadingMsg) {
      try {
        await ctx.deleteMessage(loadingMsg.message_id);
      } catch (e) {}
    }
    
    if (!status.success) {
      return safeReply(ctx, `<blockquote>❌ <b>GAGAL MENGECEK STATUS!</b>\n\n<b>Error:</b> ${status.message}</blockquote>`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔑 Update API Key", callback_data: "update_do_api" },
              { text: "🔄 Coba Lagi", callback_data: "check_do_status" }
            ],
            [{ text: "🔙 Kembali", callback_data: "menu_owner" }]
          ]
        }
      });
    }
    
    const acc = status.account;
    
    // Format pesan status
    let message = `<b>🌐 DIGITAL OCEAN ACCOUNT STATUS</b>\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    message += `<b>🔹 AKUN</b>\n`;
    message += `<code>   📧 Email:</code> ${acc.email}\n`;
    message += `<code>   🆔 UUID:</code> ${acc.uuid}\n`;
    message += `<code>   🟢 Status:</code> ${acc.statusEmoji} ${acc.status}\n`;
    message += `<code>   📧 Verified:</code> ${acc.emailVerifiedEmoji} ${acc.emailVerified ? "Yes" : "No"}\n\n`;
    
    message += `<b>📊 DROPLETS INFO</b>\n`;
    message += `<code>   📊 Droplets:</code> ${acc.totalDroplets} total\n`;
    message += `<code>   ✅ Available:</code> ${acc.availableDroplets}\n`;
    message += `<code>   🟢 Active:</code> ${acc.activeDroplets} aktif\n`;
    message += `<code>   🚀 Limit:</code> ${acc.dropletLimit} droplets\n\n`;
    
    // Tampilkan droplet terbaru jika ada
    if (acc.droplets.length > 0) {
      message += `<b>🖥️ DROPLETS TERBARU</b>\n`;
      acc.droplets.slice(0, 5).forEach((droplet, index) => {
        const ip = droplet.networks?.v4?.[0]?.ip_address || "N/A";
        const statusEmoji = droplet.status === "active" ? "🟢" : 
                          droplet.status === "off" ? "🔴" : 
                          droplet.status === "new" ? "🟡" : "⚪";
        message += `<code>   ${index + 1}. ${droplet.name}</code>\n`;
        message += `<code>      Status:</code> ${statusEmoji} ${droplet.status}\n`;
        message += `<code>      IP:</code> ${ip}\n`;
        message += `<code>      Size:</code> ${droplet.size_slug || "N/A"}\n`;
        if (index < acc.droplets.length - 1) message += `\n`;
      });
      message += `\n`;
    }
    
    message += `<b>📅 WAKTU CEK</b>\n`;
    message += `<code>   ⏰</code> ${new Date().toLocaleString("id-ID", { 
      timeZone: "Asia/Jakarta",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    })}\n`;
    
    const buttons = [
      [
        { text: "🔑 Update API Key", callback_data: "update_do_api" },
        { text: "🔄 Refresh", callback_data: "check_do_status" }
      ],
      [
        { text: "📋 List VPS", callback_data: "list_vps_digitalocean" },
        { text: "🔙 Menu Owner", callback_data: "menu_owner" }
      ]
    ];
    
    await safeReply(ctx, message, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons }
    });
    
  } catch (error) {
    if (loadingMsg) {
      try {
        await ctx.deleteMessage(loadingMsg.message_id);
      } catch (e) {}
    }
    
    console.error("Error checking DO status:", error);
    safeReply(ctx, `<blockquote>❌ <b>Error:</b> ${error.message}</blockquote>`, {
      parse_mode: "HTML"
    });
  }
});

bot.action("list_vps_digitalocean", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang bisa melihat VPS!", { show_alert: true });
  }
  
  await ctx.answerCbQuery("⏳ Mengambil data dari DigitalOcean...");
  
  // Tampilkan loading message
  const loadingMsg = await safeReply(ctx, "<blockquote>🔄 <b>Mengambil data VPS dari DigitalOcean...</b></blockquote>", {
    parse_mode: "HTML"
  });
  
  try {
    const result = await getAllDroplets();
    
    if (loadingMsg) {
      try {
        await ctx.deleteMessage(loadingMsg.message_id);
      } catch (e) {}
    }
    
    if (!result.success) {
      return safeReply(ctx, `<blockquote>❌ <b>Gagal mengambil data:</b> ${result.message}</blockquote>`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "menu_owner" }]
          ]
        }
      });
    }
    
    if (!result.droplets || result.droplets.length === 0) {
      return safeReply(ctx, "<blockquote>📭 <b>Tidak ada VPS ditemukan di DigitalOcean.</b></blockquote>", {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Refresh", callback_data: "list_vps_digitalocean" }],
            [{ text: "🔙 Kembali", callback_data: "menu_owner" }]
          ]
        }
      });
    }
    
    // Urutkan berdasarkan tanggal dibuat (terbaru dulu)
    const droplets = result.droplets.sort((a, b) => {
      return new Date(b.created_at) - new Date(a.created_at);
    });
    
    let message = `<b>📋 DAFTAR VPS DIGITALOCEAN</b>\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `<b>Total: ${result.total} Droplet</b>\n\n`;
    
    // Tampilkan daftar droplet
    droplets.forEach((droplet, index) => {
      const info = formatDropletInfo(droplet);
      const truncatedName = droplet.name.length > 20 ? droplet.name.substring(0, 20) + "..." : droplet.name;
      
      message += `<b>${index + 1}. ${info.statusEmoji} ${truncatedName}</b>\n`;
      message += `<code>   ID:</code> ${droplet.id}\n`;
      message += `<code>   IP:</code> ${info.ipv4}\n`;
      message += `<code>   Status:</code> ${info.status}\n`;
      message += `<code>   Region:</code> ${info.region}\n`;
      message += `<code>   Size:</code> ${info.size}\n\n`;
    });
    
    // Buat button untuk setiap droplet
    const buttons = [];
    
    // Button untuk melihat detail droplet (maksimal 10 per halaman jika banyak)
    droplets.slice(0, 10).forEach((droplet, index) => {
      const info = formatDropletInfo(droplet);
      buttons.push([
        { 
          text: `📝 ${index + 1}. ${info.name.substring(0, 15)}...`, 
          callback_data: `vps_detail_${droplet.id}` 
        }
      ]);
    });
    
    // Navigation buttons
    buttons.push([
      { text: "🔄 Refresh", callback_data: "list_vps_digitalocean" },
      { text: "🗑 Delete All VPS", callback_data: "delete_all_vps_confirm" }
    ]);
    
    buttons.push([
      { text: "🔙 Kembali ke Owner Menu", callback_data: "menu_owner" }
    ]);
    
    await safeReply(ctx, message, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons }
    });
    
  } catch (error) {
    if (loadingMsg) {
      try {
        await ctx.deleteMessage(loadingMsg.message_id);
      } catch (e) {}
    }
    
    console.error("Error listing VPS:", error);
    safeReply(ctx, `<blockquote>❌ <b>Error:</b> ${error.message}</blockquote>`, {
      parse_mode: "HTML"
    });
  }
});

bot.action(/vps_detail_(\d+)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang bisa melihat detail VPS!", { show_alert: true });
  }
  
  const dropletId = ctx.match[1];
  
  await ctx.answerCbQuery("⏳ Mengambil detail droplet...");
  
  try {
    const result = await getDropletDetails(dropletId);
    
    if (!result.success) {
      return safeReply(ctx, `<blockquote>❌ <b>Gagal mengambil detail:</b> ${result.message}</blockquote>`, {
        parse_mode: "HTML"
      });
    }
    
    const droplet = result.droplet;
    const info = formatDropletInfo(droplet);
    
    // Format detail message
    let message = `<b>🔍 DETAIL DROPLET #${droplet.id}</b>\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    message += `<b>📛 Nama:</b> ${info.name}\n`;
    message += `<b>🆔 ID:</b> <code>${info.id}</code>\n`;
    message += `<b>📊 Status:</b> ${info.statusEmoji} ${info.status.toUpperCase()}\n\n`;
    
    message += `<b>🌐 NETWORK</b>\n`;
    message += `<code>   IPv4:</code> <code>${info.ipv4}</code>\n`;
    message += `<code>   IPv6:</code> <code>${info.ipv6}</code>\n\n`;
    
    message += `<b>💾 SPESIFIKASI</b>\n`;
    message += `<code>   Memory:</code> ${info.memory} MB\n`;
    message += `<code>   vCPUs:</code> ${info.vcpus}\n`;
    message += `<code>   Disk:</code> ${info.disk} GB\n`;
    message += `<code>   Size:</code> ${info.size}\n\n`;
    
    message += `<b>🌍 REGION & OS</b>\n`;
    message += `<code>   Region:</code> ${info.region}\n`;
    message += `<code>   Image:</code> ${info.image}\n\n`;
    
    message += `<b>🏷️ TAGS</b>\n`;
    message += `<code>   Tags:</code> ${info.tags.length > 0 ? info.tags.join(", ") : "Tidak ada"}\n\n`;
    
    message += `<b>📅 DIBUAT</b>\n`;
    message += `<code>   Tanggal:</code> ${info.created}\n`;
    
    // Button untuk aksi
    const buttons = [
      [
        { text: "🗑 Hapus VPS Ini", callback_data: `delete_vps_confirm_${droplet.id}` },
        { text: "🔄 Reboot", callback_data: `reboot_vps_${droplet.id}` }
      ],
      [
        { text: "📋 Kembali ke List", callback_data: "list_vps_digitalocean" },
        { text: "🔙 Menu Owner", callback_data: "menu_owner" }
      ]
    ];
    
    // Coba edit message yang ada
    try {
      await ctx.editMessageText(message, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons }
      });
    } catch (e) {
      // Jika gagal edit, kirim message baru
      await safeReply(ctx, message, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons }
      });
    }
    
  } catch (error) {
    console.error("Error getting droplet details:", error);
    ctx.answerCbQuery("❌ Gagal mengambil detail droplet");
  }
});

bot.action(/delete_vps_confirm_(\d+)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang bisa menghapus VPS!", { show_alert: true });
  }
  
  const dropletId = ctx.match[1];
  
  // Tampilkan konfirmasi
  const message = `<blockquote>⚠️ <b>KONFIRMASI HAPUS VPS</b>\n\nApakah Anda yakin ingin menghapus droplet dengan ID: <code>${dropletId}</code>?\n\n<i>⚠️ PERINGATAN: Tindakan ini tidak dapat dibatalkan!</i></blockquote>`;
  
  try {
    await ctx.editMessageText(message, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Ya, Hapus Sekarang", callback_data: `delete_vps_execute_${dropletId}` },
            { text: "❌ Batal", callback_data: `vps_detail_${dropletId}` }
          ]
        ]
      }
    });
  } catch (e) {
    await safeReply(ctx, message, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Ya, Hapus Sekarang", callback_data: `delete_vps_execute_${dropletId}` },
            { text: "❌ Batal", callback_data: "list_vps_digitalocean" }
          ]
        ]
      }
    });
  }
  
  ctx.answerCbQuery();
});

bot.action(/delete_vps_execute_(\d+)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang bisa menghapus VPS!", { show_alert: true });
  }
  
  const dropletId = ctx.match[1];
  
  await ctx.answerCbQuery("⏳ Menghapus droplet...");
  
  // Tampilkan loading
  const loadingMsg = await ctx.editMessageText("<blockquote>⏳ <b>Sedang menghapus droplet dari DigitalOcean...</b></blockquote>", {
    parse_mode: "HTML"
  });
  
  try {
    const result = await deleteDroplet(dropletId);
    
    if (result.success) {
      const successMsg = `<blockquote>✅ <b>DROPLET BERHASIL DIHAPUS!</b>\n\n<b>ID Droplet:</b> <code>${dropletId}</code>\n\n<i>Droplet telah dihapus dari DigitalOcean.</i></blockquote>`;
      
      await ctx.editMessageText(successMsg, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "📋 Lihat List VPS", callback_data: "list_vps_digitalocean" },
              { text: "🔙 Menu Owner", callback_data: "menu_owner" }
            ]
          ]
        }
      });
      
    } else {
      await ctx.editMessageText(`<blockquote>❌ <b>GAGAL MENGHAPUS DROPLET:</b>\n${result.message}</blockquote>`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔄 Coba Lagi", callback_data: `delete_vps_confirm_${dropletId}` },
              { text: "📋 Kembali ke List", callback_data: "list_vps_digitalocean" }
            ]
          ]
        }
      });
    }
    
  } catch (error) {
    console.error("Error deleting droplet:", error);
    
    await ctx.editMessageText(`<blockquote>❌ <b>ERROR:</b> ${error.message}</blockquote>`, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📋 Kembali ke List", callback_data: "list_vps_digitalocean" },
            { text: "🔙 Menu Owner", callback_data: "menu_owner" }
          ]
        ]
      }
    });
  }
});

bot.action("delete_all_vps_confirm", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang bisa menghapus VPS!", { show_alert: true });
  }
  
  // Ambil data droplet dulu
  const result = await getAllDroplets();
  
  if (!result.success || !result.droplets || result.droplets.length === 0) {
    return ctx.answerCbQuery("❌ Tidak ada VPS untuk dihapus!", { show_alert: true });
  }
  
  const totalDroplets = result.droplets.length;
  
  const message = `<blockquote>⚠️ <b>KONFIRMASI HAPUS SEMUA VPS</b>\n\nAnda akan menghapus <b>${totalDroplets} droplet</b> dari DigitalOcean!\n\n<b>⚠️ PERINGATAN:</b>\n• Tindakan ini tidak dapat dibatalkan!\n• Semua data akan hilang permanen!\n• Tidak ada backup otomatis!</blockquote>`;
  
  try {
    await ctx.editMessageText(message, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Ya, Hapus Semua", callback_data: "delete_all_vps_execute" },
            { text: "❌ Batal", callback_data: "list_vps_digitalocean" }
          ]
        ]
      }
    });
  } catch (e) {
    await safeReply(ctx, message, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Ya, Hapus Semua", callback_data: "delete_all_vps_execute" },
            { text: "❌ Batal", callback_data: "list_vps_digitalocean" }
          ]
        ]
      }
    });
  }
  
  ctx.answerCbQuery();
});

bot.action("delete_all_vps_execute", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang bisa menghapus VPS!", { show_alert: true });
  }
  
  await ctx.answerCbQuery("⏳ Menghapus semua droplet...");
  
  const loadingMsg = await ctx.editMessageText("<blockquote>⏳ <b>Sedang menghapus semua droplet dari DigitalOcean...</b>\nIni mungkin memakan waktu beberapa menit.</blockquote>", {
    parse_mode: "HTML"
  });
  
  try {
    const result = await getAllDroplets();
    
    if (!result.success || !result.droplets) {
      throw new Error("Gagal mengambil data droplet");
    }
    
    const droplets = result.droplets;
    let deletedCount = 0;
    let errorCount = 0;
    let errorMessages = [];
    
    // Hapus semua droplet satu per satu
    for (const droplet of droplets) {
      try {
        const deleteResult = await deleteDroplet(droplet.id);
        if (deleteResult.success) {
          deletedCount++;
        } else {
          errorCount++;
          errorMessages.push(`Droplet ${droplet.id}: ${deleteResult.message}`);
        }
        
        // Tunggu sebentar antara setiap delete
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        errorCount++;
        errorMessages.push(`Droplet ${droplet.id}: ${error.message}`);
      }
    }
    
    let reportMessage = `<blockquote>📊 <b>LAPORAN HAPUS SEMUA VPS</b>\n\n`;
    reportMessage += `<b>Total Droplet:</b> ${droplets.length}\n`;
    reportMessage += `<b>Berhasil Dihapus:</b> ${deletedCount}\n`;
    reportMessage += `<b>Gagal Dihapus:</b> ${errorCount}\n\n`;
    
    if (errorCount > 0) {
      reportMessage += `<b>⚠️ ERROR:</b>\n`;
      errorMessages.slice(0, 5).forEach(msg => {
        reportMessage += `<code>   • ${msg.substring(0, 50)}...</code>\n`;
      });
      if (errorMessages.length > 5) {
        reportMessage += `<code>   • ...dan ${errorMessages.length - 5} error lainnya</code>\n`;
      }
    } else {
      reportMessage += `<i>✅ Semua droplet berhasil dihapus!</i>\n`;
    }
    
    reportMessage += `</blockquote>`;
    
    await ctx.editMessageText(reportMessage, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📋 Refresh List", callback_data: "list_vps_digitalocean" },
            { text: "🔙 Menu Owner", callback_data: "menu_owner" }
          ]
        ]
      }
    });
    
  } catch (error) {
    console.error("Error deleting all droplets:", error);
    
    await ctx.editMessageText(`<blockquote>❌ <b>ERROR HAPUS SEMUA VPS:</b>\n${error.message}</blockquote>`, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📋 Kembali ke List", callback_data: "list_vps_digitalocean" },
            { text: "🔙 Menu Owner", callback_data: "menu_owner" }
          ]
        ]
      }
    });
  }
});

bot.action(/reboot_vps_(\d+)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang bisa reboot VPS!", { show_alert: true });
  }
  
  const dropletId = ctx.match[1];
  
  await ctx.answerCbQuery("⏳ Memulai reboot...");
  
  try {
    const apiDO = config.ApiDO1;
    
    // Kirim request reboot
    const response = await axios.post(
      `https://api.digitalocean.com/v2/droplets/${dropletId}/actions`,
      { type: "reboot" },
      {
        headers: { 
          "Authorization": `Bearer ${apiDO}`,
          "Content-Type": "application/json"
        },
        timeout: 10000
      }
    );
    
    if (response.status === 201) {
      const actionId = response.data.action.id;
      
      const message = `<blockquote>🔄 <b>REBOOT DIMULAI</b>\n\n<b>Droplet ID:</b> <code>${dropletId}</code>\n<b>Action ID:</b> <code>${actionId}</code>\n\n<i>Reboot sedang berjalan. Tunggu beberapa menit hingga proses selesai.</i></blockquote>`;
      
      await ctx.editMessageText(message, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔄 Refresh Status", callback_data: `vps_detail_${dropletId}` },
              { text: "📋 Kembali ke List", callback_data: "list_vps_digitalocean" }
            ]
          ]
        }
      });
      
    } else {
      throw new Error("Gagal memulai reboot");
    }
    
  } catch (error) {
    console.error("Error rebooting droplet:", error);
    
    await ctx.editMessageText(`<blockquote>❌ <b>GAGAL REBOOT:</b>\n${error.message}</blockquote>`, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔄 Coba Lagi", callback_data: `reboot_vps_${dropletId}` },
            { text: "📋 Kembali ke Detail", callback_data: `vps_detail_${dropletId}` }
          ]
        ]
      }
    });
  }
});

bot.action("create_vps_menu", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang bisa membuat VPS!", { show_alert: true });
  }
  
  await ctx.answerCbQuery();
  
  // Cek stock VPS
  const count = await getDropletCount();
  const sisaVPS = Math.max(0, 10 - count);
  
  // Tampilkan menu untuk memilih paket VPS
  const text = `
<b>🖥 CREATE VPS (OWNER ONLY)</b>
━━━━━━━━━━━━━━━━━━━━━━
📦 <b>STOK TERSEDIA:</b> ${sisaVPS} VPS

⚙️ <b>Pilih tipe VPS sesuai kebutuhan:</b>

🟢 <b>LOW VPS</b>
▪ Garansi: <b>15 Hari</b>
▪ Replace: <b>1x</b>
━━━━━━━━━━━━━━━━━━━━━━

🟡 <b>MEDIUM VPS</b>
▪ Garansi: <b>25 Hari</b>
▪ Replace: <b>2x</b>
━━━━━━━━━━━━━━━━━━━━━━

🔴 <b>HIGH VPS</b>
▪ Garansi: <b>30 Hari</b>
▪ Replace: <b>Unlimited</b>
━━━━━━━━━━━━━━━━━━━━━━
✨ <b>Silakan pilih kategori VPS:</b>
`;

  await editMenuMessage(ctx, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🟢 LOW", callback_data: "createvps_pkg:low" }],
        [{ text: "🟡 MEDIUM", callback_data: "createvps_pkg:medium" }],
        [{ text: "🔴 HIGH", callback_data: "createvps_pkg:high" }],
        [{ text: "🔙 Kembali", callback_data: "menu_owner" }]
      ]
    }
  });
});

// Handler untuk memilih paket
bot.action(/createvps_pkg:(low|medium|high)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  
  const paket = ctx.match[1];
  const userId = ctx.from.id;

  // Cek stock VPS
  const count = await getDropletCount();
  const sisaVPS = Math.max(0, 10 - count);

  if (sisaVPS <= 0) {
    return editMenuMessage(ctx,
`❌ <b>STOK VPS HABIS</b>

Mohon Maaf Sebesar-besarnya 🙏  
Stok VPS kami <b>sudah habis</b> 😞

Silahkan tunggu hingga ada VPS yang kosong.`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "create_vps_menu" }]
          ]
        }
      }
    );
  }

  // Simpan data paket ke state
  if (!userState[userId]) userState[userId] = {};
  userState[userId].createVpsData = { paket };

  const dataHarga = config.hargaVPS?.[paket] || {};

  const listRam = [
    { id: 1, ram: "2GB", spec: "2 CPU | 60GB SSD | 3TB BW", plan: "2c2" },
    { id: 2, ram: "4GB", spec: "2 CPU | 80GB SSD | 4TB BW", plan: "4c2" },
    { id: 3, ram: "8GB", spec: "4 CPU | 160GB SSD | 5TB BW", plan: "8c4" },
    { id: 4, ram: "16GB", spec: "4 CPU | 200GB SSD | 8TB BW", plan: "16c4" },
    { id: 5, ram: "16GB", spec: "8 CPU | 320GB SSD | 6TB BW", plan: "16c8" }
  ].map(v => ({
    ...v,
    harga: dataHarga[v.plan] || 0
  }));

  let teks = `<b>🖥 PILIH RAM VPS</b>\n`;
  teks += `──────────────────────────\n\n`;

  for (const v of listRam) {
    teks += `<b>${v.id}. ${v.ram}</b>\n`;
    teks += `┈➤ ${v.spec}\n`;
    teks += `──────────────────────────\n`;
  }

  teks += `\n✅ <b>STOK TERSEDIA : ${sisaVPS} VPS</b>`;

  // BUTTON ANGKA (KANAN-KIRI)
  const keyboard = [];
  for (let i = 0; i < listRam.length; i += 2) {
    keyboard.push(
      listRam.slice(i, i + 2).map(v => ({
        text: `${v.id}`,
        callback_data: `createvps_ram:${v.plan}`
      }))
    );
  }

  keyboard.push([{ text: "🔙 Kembali", callback_data: "create_vps_menu" }]);

  await editMenuMessage(ctx, teks, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard }
  });
});

// Handler untuk memilih RAM
bot.action(/createvps_ram:(.+)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  
  const plan = ctx.match[1];
  const userId = ctx.from.id;

  if (!userState[userId]) userState[userId] = {};
  if (!userState[userId].createVpsData) userState[userId].createVpsData = {};
  userState[userId].createVpsData.plan = plan;

  const osFamily = [
    { id: 1, name: "Ubuntu", key: "ubuntu" },
    { id: 2, name: "Debian", key: "debian" },
    { id: 3, name: "CentOS Stream", key: "centos" },
    { id: 4, name: "Fedora", key: "fedora" },
    { id: 5, name: "AlmaLinux", key: "almalinux" },
    { id: 6, name: "Rocky Linux", key: "rocky" }
  ];

  let teks = `<b>💾 SPESIFIKASI VPS DIPILIH</b>\n`;
  teks += `──────────────────────────\n`;
  teks += `📦 <b>Plan:</b> ${plan}\n\n`;
  teks += `<b>🖥 PILIH OS VPS</b>\n`;
  teks += `──────────────────────────\n\n`;

  for (const os of osFamily) {
    teks += `<b>${os.id}. ${os.name}</b>\n`;
    teks += `──────────────────────────\n`;
  }

  // BUTTON ANGKA (KANAN-KIRI)
  const keyboard = [];
  for (let i = 0; i < osFamily.length; i += 2) {
    keyboard.push(
      osFamily.slice(i, i + 2).map(os => ({
        text: `${os.id}`,
        callback_data: `createvps_osfamily:${os.key}`
      }))
    );
  }

  keyboard.push([
    { 
      text: "🔙 Kembali", 
      callback_data: `createvps_pkg:${userState[userId].createVpsData.paket}` 
    }
  ]);

  await editMenuMessage(ctx, teks, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard }
  });
});

// Handler untuk memilih OS Family
bot.action(/createvps_osfamily:(.+)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  
  const osKey = ctx.match[1];
  const userId = ctx.from.id;

  if (!userState[userId]) userState[userId] = {};
  if (!userState[userId].createVpsData) userState[userId].createVpsData = {};
  userState[userId].createVpsData.osFamily = osKey;

  const osVersions = {
    ubuntu: [
      { id: 1, name: "Ubuntu 22.04", slug: "ubuntu-22-04-x64" },
      { id: 2, name: "Ubuntu 24.04", slug: "ubuntu-24-04-x64" },
      { id: 3, name: "Ubuntu 25.04", slug: "ubuntu-25-04-x64" },
    ],
    debian: [
      { id: 1, name: "Debian 12", slug: "debian-12-x64" },
      { id: 2, name: "Debian 13", slug: "debian-13-x64" },
    ],
    centos: [
      { id: 1, name: "CentOS Stream 9", slug: "centos-stream-9-x64" },
    ],
    fedora: [
      { id: 1, name: "Fedora 42", slug: "fedora-42-x64" },
    ],
    almalinux: [
      { id: 1, name: "AlmaLinux 8", slug: "almalinux-8-x64" },
      { id: 2, name: "AlmaLinux 9", slug: "almalinux-9-x64" },
    ],
    rocky: [
      { id: 1, name: "Rocky Linux 8", slug: "rockylinux-8-x64" },
      { id: 2, name: "Rocky Linux 9", slug: "rockylinux-9-x64" },
    ]
  };

  const versionList = osVersions[osKey] || [];

  let teks = `<b>🖥 OS FAMILY DIPILIH</b>\n`;
  teks += `──────────────────────────\n`;
  teks += `📀 <b>${osKey.toUpperCase()}</b>\n\n`;
  teks += `<b>📦 PILIH VERSI OS</b>\n`;
  teks += `──────────────────────────\n\n`;

  for (const v of versionList) {
    teks += `<b>${v.id}. ${v.name}</b>\n`;
    teks += `──────────────────────────\n`;
  }

  // BUTTON ANGKA (KANAN–KIRI)
  const keyboard = [];
  for (let i = 0; i < versionList.length; i += 2) {
    keyboard.push(
      versionList.slice(i, i + 2).map(v => ({
        text: `${v.id}`,
        callback_data: `createvps_os:${v.slug}`
      }))
    );
  }

  keyboard.push([
    { 
      text: "🔙 Kembali", 
      callback_data: `createvps_ram:${userState[userId].createVpsData.plan}` 
    }
  ]);

  await editMenuMessage(ctx, teks, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard }
  });
});

bot.action(/createvps_os:(.+)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  
  const osSlug = ctx.match[1];
  const userId = ctx.from.id;
  
  if (userState[userId]?.createVpsData) {
    userState[userId].createVpsData.os = osSlug;
  }

  const regionList = [
    { name: "SINGAPORE", code: "sgp1" },
    { name: "NEW YORK", code: "nyc3" },
    { name: "SAN FRANCISCO", code: "sfo3" },
    { name: "AMSTERDAM", code: "ams3" },
    { name: "LONDON", code: "lon1" },
    { name: "FRANKFURT", code: "fra1" },
  ];

  let text = `📍 <b>PILIH REGION VPS</b>\n\n`;
  regionList.forEach((r, i) => text += `${i + 1}. ${r.name}\n`);

  if (userState[userId]?.createVpsData) {
    userState[userId].createVpsData.regionList = regionList;
  }

  const buttons = regionList.map((r, i) => [
    { text: `${i + 1}. ${r.name}`, callback_data: `createvps_region:${r.code}` }
  ]);

  buttons.push([
    { text: "🔙 Kembali", callback_data: `createvps_osfamily:${userState[userId]?.createVpsData?.osFamily}` }
  ]);

  await editMenuMessage(ctx, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons }
  });
});

bot.action(/createvps_region:(.+)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  
  const region = ctx.match[1];
  const userId = ctx.from.id;
  
  if (!userState[userId]?.createVpsData) {
    return ctx.answerCbQuery("❌ Session VPS tidak ditemukan!", { show_alert: true });
  }

  const vpsData = userState[userId].createVpsData;
  vpsData.region = region;

  // Set harga menjadi 0 karena untuk owner
  vpsData.harga = 0;
  vpsData.username = ctx.from.username || ctx.from.first_name;

  const paketInfo = {
    low: { garansi: "15 Hari", replace: "1x" },
    medium: { garansi: "25 Hari", replace: "2x" },
    high: { garansi: "30 Hari", replace: "Unlimited" }
  };

  const specList = {
    "2c2": "2GB 2 VCPU | 60GB SSD | 3TB BW",
    "4c2": "4GB 2 VCPU | 80GB SSD | 4TB BW",
    "8c4": "8GB 4 VCPU | 160GB SSD | 5TB BW",
    "16c4": "16GB 4 VCPU | 200GB SSD | 8TB BW",
    "16c8": "16GB 8 VCPU | 320GB SSD | 6TB BW"
  };

  const labelSpec = specList[vpsData.plan] || "-";

  await editMenuMessage(ctx,
`✅ <b>KONFIRMASI PEMBUATAN VPS</b>
━━━━━━━━━━━━━━━━━━━━━━

📦 <b>Paket:</b> ${vpsData.paket.toUpperCase()}

🛡️ <b>Garansi:</b> ${paketInfo[vpsData.paket].garansi}
♻️ <b>Replace:</b> ${paketInfo[vpsData.paket].replace}

🖥 <b>Spesifikasi</b>
• ${labelSpec}
• CPU/RAM Code: <b>${vpsData.plan}</b>

🧩 <b>OS Family:</b> ${vpsData.osFamily.toUpperCase()}
🖥 <b>OS Version:</b> ${vpsData.os}
🌍 <b>Region:</b> ${region}

━━━━━━━━━━━━━━━━━━━━━━
<b>Silakan konfirmasi pembuatan VPS:</b>`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Buat VPS Sekarang", callback_data: "createvps_confirm_create" }],
          [{ text: "🔙 Kembali", callback_data: `createvps_os:${vpsData.os}` }]
        ]
      }
    }
  );
});

bot.action("createvps_confirm_create", async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  
  const userId = ctx.from.id;
  
  if (!userState[userId]?.createVpsData) {
    return ctx.answerCbQuery("❌ Data VPS tidak ditemukan!", { show_alert: true });
  }

  const vpsData = userState[userId].createVpsData;
  
  // Cek stock lagi sebelum membuat
  const count = await getDropletCount();
  const sisaVPS = Math.max(0, 10 - count);
  
  if (sisaVPS <= 0) {
    return ctx.answerCbQuery("❌ Stock VPS sudah habis!", { show_alert: true });
  }
  
  // Tampilkan loading message
  const loadingMsg = await ctx.editMessageText("<blockquote>⏳ <b>Sedang membuat VPS DigitalOcean...</b>\nProses membutuhkan waktu ±60 detik.</blockquote>", { 
    parse_mode: "HTML" 
  });
  
  try {
    // Gunakan fungsi createVPSDroplet yang sudah ada
    const result = await createVPSDroplet(userId, vpsData);
    
    if (result.success) {
      const data = result.data;
      const paketInfo = {
        low: { garansi: 15, replace: 1 },
        medium: { garansi: 25, replace: 2 },
        high: { garansi: 30, replace: -1 }
      };
      
      const paket = vpsData.paket;
      
      const detailVPS = `<blockquote>✅ <b>VPS BERHASIL DIBUAT!</b></blockquote>

<blockquote>🖥️ <b>DETAIL DATA VPS</b>
━━━━━━━━━━━━━━━━━━━━━━
<b>🌐 IP ADDRESS:</b> <code>${data.ip}</code>
<b>🆔 USERNAME:</b> <code>root</code>
<b>🔐 PASSWORD:</b> <code>${data.password}</code>
<b>🧩 HOSTNAME:</b> ${data.hostname}
<b>🌍 REGION:</b> ${data.region.toUpperCase()}
<b>💿 OS:</b> ${data.os.toUpperCase()}</blockquote>

<blockquote>🛍️ <b>DETAIL PEMBUATAN</b>
━━━━━━━━━━━━━━━━━━━━━━
<b>📦 PAKET:</b> ${paket.toUpperCase()}
<b>💾 SPESIFIKASI:</b> ${vpsData.plan}
<b>🛡️ GARANSI:</b> ${paketInfo[paket].garansi} Hari
<b>♻️ REPLACE:</b> ${paketInfo[paket].replace === -1 ? "Unlimited" : paketInfo[paket].replace + "x"}
<b>📅 TANGGAL:</b> ${data.created}
<b>👤 DIBUAT OLEH:</b> Owner (${ctx.from.first_name})
<b>🤝 PENJUAL:</b> @${bot.botInfo.username}</blockquote>`;
      
      await ctx.editMessageText(detailVPS, { parse_mode: "HTML" });
      
      // Hapus data dari state
      delete userState[userId].createVpsData;
      
    } else {
      await ctx.editMessageText(`<blockquote>❌ <b>Gagal membuat VPS:</b> ${result.msg}</blockquote>`, { 
        parse_mode: "HTML" 
      });
    }
    
  } catch (error) {
    await ctx.editMessageText(`<blockquote>❌ <b>Error sistem VPS:</b> ${error.message}</blockquote>`, { 
      parse_mode: "HTML" 
    });
  }
});

bot.action("manage_faq", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang boleh mengelola FAQ!", { show_alert: true });
  }
  await ctx.answerCbQuery();

  const faqs = readFaq();
  const message = `
<b>🗂️ KELOLA FAQ</b>
━━━━━━━━━━━━━━━━━━━━━━

Total FAQ tersimpan: <b>${faqs.length}</b>

FAQ dicek <b>sebelum</b> AI Customer Support. Kalau pesan user cocok kata kunci FAQ, jawaban FAQ langsung dipakai (tidak lewat AI sama sekali).

━━━━━━━━━━━━━━━━━━━━━━
<b>Pilih aksi:</b>
  `.trim();

  await editMenuMessage(ctx, message, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ Tambah FAQ", callback_data: "add_faq" }],
        [{ text: "📋 Lihat Semua FAQ", callback_data: "list_faq" }],
        [{ text: "🗑️ Hapus FAQ", callback_data: "delete_faq_menu" }],
        [{ text: "🔙 Kembali", callback_data: "menu_owner" }],
      ],
    },
  });
});

bot.action("add_faq", async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  await ctx.answerCbQuery();
  userState[ctx.from.id] = { step: "WAITING_FAQ_KEYWORDS" };
  await editMenuMessage(
    ctx,
    `<blockquote>✏️ <b>Tambah FAQ - Langkah 1/2</b>\n\nKetik <b>kata kunci</b> pemicu FAQ ini, pisah pakai koma.\n\nContoh: <code>jam buka, buka jam berapa, kapan buka</code>\n\n<i>Kalau pesan user mengandung salah satu kata kunci ini, jawaban FAQ langsung dipakai.</i></blockquote>`,
    { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "❌ Batal", callback_data: "manage_faq" }]] } }
  );
});

bot.action("list_faq", async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  await ctx.answerCbQuery();

  const faqs = readFaq();
  if (faqs.length === 0) {
    return editMenuMessage(ctx, "<blockquote>📭 Belum ada FAQ. Tambah dulu lewat menu sebelumnya.</blockquote>", {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "manage_faq" }]] },
    });
  }

  let text = `<b>📋 DAFTAR FAQ</b> (${faqs.length})\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  faqs.forEach((f, i) => {
    text += `<b>${i + 1}.</b> <i>${f.keywords.join(", ")}</i>\n   ↳ ${f.answer.length > 80 ? f.answer.slice(0, 80) + "..." : f.answer}\n\n`;
  });

  await editMenuMessage(ctx, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "manage_faq" }]] },
  });
});

bot.action("delete_faq_menu", async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  await ctx.answerCbQuery();

  const faqs = readFaq();
  if (faqs.length === 0) {
    return editMenuMessage(ctx, "<blockquote>📭 Belum ada FAQ untuk dihapus.</blockquote>", {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "manage_faq" }]] },
    });
  }

  const rows = faqs.map((f, i) => [
    { text: `🗑️ ${i + 1}. ${f.keywords[0]}${f.keywords.length > 1 ? " +" + (f.keywords.length - 1) : ""}`, callback_data: `faq_del_${i}` },
  ]);
  rows.push([{ text: "🔙 Kembali", callback_data: "manage_faq" }]);

  await editMenuMessage(ctx, "<blockquote>🗑️ <b>Pilih FAQ yang mau dihapus:</b></blockquote>", {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
  });
});

bot.action(/faq_del_(\d+)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  const idx = parseInt(ctx.match[1]);
  const faqs = readFaq();
  if (!faqs[idx]) return ctx.answerCbQuery("❌ FAQ tidak ditemukan.", { show_alert: true });

  const deleted = faqs.splice(idx, 1)[0];
  saveFaq(faqs);
  await ctx.answerCbQuery(`✅ FAQ "${deleted.keywords[0]}" dihapus.`, { show_alert: true });

  // Refresh daftar
  const rows = faqs.map((f, i) => [
    { text: `🗑️ ${i + 1}. ${f.keywords[0]}${f.keywords.length > 1 ? " +" + (f.keywords.length - 1) : ""}`, callback_data: `faq_del_${i}` },
  ]);
  rows.push([{ text: "🔙 Kembali", callback_data: "manage_faq" }]);
  await editMenuMessage(ctx, faqs.length ? "<blockquote>🗑️ <b>Pilih FAQ yang mau dihapus:</b></blockquote>" : "<blockquote>📭 Semua FAQ sudah dihapus.</blockquote>", {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows.length ? rows : [[{ text: "🔙 Kembali", callback_data: "manage_faq" }]] },
  });
});

// Step multi-tahap tambah FAQ (keywords -> jawaban)
bot.on("text", async (ctx, next) => {
  const userId = ctx.from.id;
  const st = userState[userId];
  if (!st) return next();
  const text = ctx.message.text;

  if (st.step === "WAITING_FAQ_KEYWORDS") {
    if (userId !== config.ownerId) return next();
    const keywords = text.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
    if (keywords.length === 0) {
      return safeReply(ctx, "<blockquote>❌ Kata kunci tidak boleh kosong. Coba lagi (pisah pakai koma).</blockquote>", { parse_mode: "HTML" });
    }
    userState[userId] = { step: "WAITING_FAQ_ANSWER", faqKeywords: keywords };
    return safeReply(
      ctx,
      `<blockquote>✏️ <b>Tambah FAQ - Langkah 2/2</b>\n\nKata kunci: <i>${keywords.join(", ")}</i>\n\nSekarang ketik <b>jawabannya</b>:</blockquote>`,
      { parse_mode: "HTML" }
    );
  }

  if (st.step === "WAITING_FAQ_ANSWER") {
    if (userId !== config.ownerId) return next();
    const faqs = readFaq();
    faqs.push({ id: Date.now(), keywords: st.faqKeywords, answer: text });
    saveFaq(faqs);
    delete userState[userId];
    return safeReply(
      ctx,
      `<blockquote>✅ <b>FAQ tersimpan!</b>\n\n<b>Kata kunci:</b> ${st.faqKeywords.join(", ")}\n<b>Jawaban:</b> ${text}\n\nSekarang kalau ada user nanya hal serupa, jawaban ini langsung dipakai.</blockquote>`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "➕ Tambah Lagi", callback_data: "add_faq" }], [{ text: "🔙 Menu FAQ", callback_data: "manage_faq" }]] },
      }
    );
  }

  return next();
});

bot.action("manage_vouchers", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang boleh mengelola voucher!", { show_alert: true });
  }
  
  await ctx.answerCbQuery();
  
  const vouchers = readVouchers();
  const activeVouchers = vouchers.filter(v => v.isActive);
  const expiredVouchers = vouchers.filter(v => !v.isActive);
  
  const message = `
<b>🎫 KELOLA VOUCHER</b>
━━━━━━━━━━━━━━━━━━━━━━

📊 <b>Statistik Voucher:</b>
├ Aktif: ${activeVouchers.length}
├ Kadaluarsa: ${expiredVouchers.length}
└ Total: ${vouchers.length}

━━━━━━━━━━━━━━━━━━━━━━
<b>Pilih aksi:</b>
  `.trim();
  
  await editMenuMessage(ctx, message, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
    [{ text: "➕ Buat Voucher Baru", callback_data: "create_voucher" }],
    [{ text: "📋 Lihat Semua Voucher", callback_data: "list_vouchers" }],
    [{ text: "🗑️ Hapus Voucher", callback_data: "delete_voucher_menu" }],
    [{ text: "📊 Statistik Detail", callback_data: "voucher_stats" }],
    [{ text: "📤 Broadcast Voucher", callback_data: "broadcast_voucher_menu" }],
    [{ text: "🔙 Kembali", callback_data: "menu_owner" }]
  ]
    }
  });
});

bot.action("voucher_stats", async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  
  const stats = getVoucherStats();
  const vouchers = readVouchers();
  
  let message = `<b>📊 STATISTIK VOUCHER DETAIL</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  
  message += `<b>📈 OVERVIEW:</b>\n`;
  message += `├ Total Voucher: <b>${stats.total}</b>\n`;
  message += `├ Voucher Aktif: <b>${stats.active}</b>\n`;
  message += `├ Voucher Nonaktif: <b>${stats.expired}</b>\n`;
  message += `├ Total Penggunaan: <b>${stats.totalUses}</b>\n`;
  message += `└ Dapat Dibersihkan: <b>${stats.canBeCleaned}</b>\n\n`;
  
  message += `<b>🔍 DETAIL KADALUARSA:</b>\n`;
  message += `├ Kadaluarsa Waktu: <b>${stats.expiredByDate}</b>\n`;
  message += `└ Maks Penggunaan: <b>${stats.maxUsesReached}</b>\n\n`;
  
  // Tampilkan 5 voucher terbaru
  if (vouchers.length > 0) {
    message += `<b>📝 VOUCHER TERBARU (5):</b>\n`;
    const recentVouchers = [...vouchers].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
    
    recentVouchers.forEach((v, i) => {
      const status = v.isActive ? "🟢" : "🔴";
      message += `${i+1}. ${status} <code>${v.code}</code> - ${v.type === 'percentage' ? `${v.value}%` : toRupiah(v.value)} - ${v.usedCount}/${v.maxUses === -1 ? '∞' : v.maxUses}\n`;
    });
  }
  
  message += `\n<i>Terakhir diperbarui: ${new Date().toLocaleString('id-ID')}</i>`;
  
  await editMenuMessage(ctx, message, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🗑️ Bersihkan Otomatis", callback_data: "delete_expired_vouchers" }],
        [{ text: "🔄 Refresh", callback_data: "voucher_stats" }],
        [{ text: "🔙 Kembali", callback_data: "manage_vouchers" }]
      ]
    }
  });
});

bot.action("create_voucher", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner!", { show_alert: true });
  }
  
  userState[ctx.from.id] = {
    step: "WAITING_VOUCHER_TYPE",
    voucherData: {}
  };
  
  const message = `
<b>➕ BUAT VOUCHER BARU</b>
━━━━━━━━━━━━━━━━━━━━━━

<b>Pilih tipe voucher:</b>

1️⃣ <b>PERCENTAGE</b> - Potongan persentase
   Contoh: 10% dari total belanja

2️⃣ <b>FIXED</b> - Potongan nominal tetap
   Contoh: Rp 5.000 langsung
  `.trim();
  
  await editMenuMessage(ctx, message, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 Percentage (%)", callback_data: "voucher_type:percentage" }],
        [{ text: "💰 Fixed (Rp)", callback_data: "voucher_type:fixed" }],
        [{ text: "🔙 Kembali", callback_data: "manage_vouchers" }]
      ]
    }
  });
});

bot.action(/voucher_type:(percentage|fixed)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  
  const type = ctx.match[1];
  const userId = ctx.from.id;
  
  if (!userState[userId]) userState[userId] = { voucherData: {} };
  userState[userId].voucherData.type = type;
  userState[userId].step = "WAITING_VOUCHER_VALUE";
  
  const example = type === 'percentage' 
    ? "Contoh: 10 (untuk 10% diskon)"
    : "Contoh: 5000 (untuk Rp 5.000 diskon)";
  
  await editMenuMessage(ctx, 
    `<b>💰 MASUKKAN NILAI VOUCHER</b>\n\nTipe: <b>${type.toUpperCase()}</b>\n${example}\n\nKirim angka sekarang:`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "🔙 Batal", callback_data: "manage_vouchers" }]]
      }
    }
  );
});

bot.action("delete_voucher_menu", async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  
  const vouchers = readVouchers();
  
  if (vouchers.length === 0) {
    return ctx.answerCbQuery("❌ Tidak ada voucher yang bisa dihapus!", { show_alert: true });
  }
  
  const message = `
<b>🗑️ HAPUS VOUCHER</b>
━━━━━━━━━━━━━━━━━━━━━━

Total voucher: ${vouchers.length}

<b>Pilih metode penghapusan:</b>
  `.trim();
  
  await editMenuMessage(ctx, message, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📋 Pilih Voucher dari List", callback_data: "delete_voucher_list" }],
        [{ text: "⌨️ Hapus dengan Kode", callback_data: "delete_voucher_by_code" }],
        [{ text: "🧹 Hapus Semua Kadaluarsa", callback_data: "delete_expired_vouchers" }],
        [{ text: "🔙 Kembali", callback_data: "manage_vouchers" }]
      ]
    }
  });
});

bot.action("delete_voucher_list", async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  
  const vouchers = readVouchers();
  
  if (vouchers.length === 0) {
    return editMenuMessage(ctx, 
      "<b>📭 TIDAK ADA VOUCHER</b>\n\nBelum ada voucher yang bisa dihapus!",
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "delete_voucher_menu" }]]
        }
      }
    );
  }
  
  let message = `<b>🗑️ PILIH VOUCHER UNTUK DIHAPUS</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  
  const buttons = [];
  
  // Group vouchers into pairs for better layout
  for (let i = 0; i < vouchers.length; i += 2) {
    const row = [];
    
    // First voucher in row
    const v1 = vouchers[i];
    const status1 = v1.isActive ? "🟢" : "🔴";
    row.push({
      text: `${status1} ${v1.code}`,
      callback_data: `confirm_delete_voucher_${v1.id}`
    });
    
    // Second voucher in row (if exists)
    if (i + 1 < vouchers.length) {
      const v2 = vouchers[i + 1];
      const status2 = v2.isActive ? "🟢" : "🔴";
      row.push({
        text: `${status2} ${v2.code}`,
        callback_data: `confirm_delete_voucher_${v2.id}`
      });
    }
    
    buttons.push(row);
  }
  
  // Add navigation buttons
  buttons.push([{ text: "🔙 Kembali", callback_data: "delete_voucher_menu" }]);
  
  await editMenuMessage(ctx, message, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons }
  });
});

bot.action("delete_voucher_by_code", async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  
  userState[ctx.from.id] = {
    step: "WAITING_VOUCHER_CODE_DELETE"
  };
  
  await editMenuMessage(ctx,
    `<b>⌨️ HAPUS VOUCHER DENGAN KODE</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\nMasukkan kode voucher yang ingin dihapus:\n\nContoh: <code>ABC123DE</code>\n\n<b>Perhatian:</b> Aksi ini tidak dapat dibatalkan!`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "🔙 Batal", callback_data: "delete_voucher_menu" }]]
      }
    }
  );
});

bot.action("delete_expired_vouchers", async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  
  const vouchers = readVouchers();
  const now = Date.now();
  
  // Filter voucher yang sudah kadaluarsa atau nonaktif
  const expiredVouchers = vouchers.filter(v => 
    !v.isActive || 
    (v.expiresAt && v.expiresAt < now) ||
    (v.maxUses !== -1 && v.usedCount >= v.maxUses)
  );
  
  if (expiredVouchers.length === 0) {
    return ctx.answerCbQuery("✅ Tidak ada voucher kadaluarsa!", { show_alert: true });
  }
  
  const message = `
<b>🧹 HAPUS SEMUA VOUCHER KADALUARSA</b>
━━━━━━━━━━━━━━━━━━━━━━

<b>Total voucher kadaluarsa:</b> ${expiredVouchers.length}

<b>Daftar voucher yang akan dihapus:</b>
${expiredVouchers.slice(0, 10).map(v => `• ${v.code} (${v.isActive ? 'Aktif' : 'Nonaktif'})`).join('\n')}
${expiredVouchers.length > 10 ? `\n...dan ${expiredVouchers.length - 10} voucher lainnya` : ''}

<b>⚠️ PERINGATAN:</b>
Aksi ini akan menghapus <b>${expiredVouchers.length}</b> voucher!
Aksi tidak dapat dibatalkan!
  `.trim();
  
  await editMenuMessage(ctx, message, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Ya, Hapus Semua", callback_data: "confirm_delete_expired" }],
        [{ text: "❌ Batal", callback_data: "delete_voucher_menu" }]
      ]
    }
  });
});

bot.action(/confirm_delete_voucher_(.+)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  
  const voucherId = ctx.match[1];
  const vouchers = readVouchers();
  const voucher = vouchers.find(v => v.id === voucherId);
  
  if (!voucher) {
    return ctx.answerCbQuery("❌ Voucher tidak ditemukan!", { show_alert: true });
  }
  
  const message = `
<b>🗑️ KONFIRMASI HAPUS VOUCHER</b>
━━━━━━━━━━━━━━━━━━━━━━

<b>Kode Voucher:</b> <code>${voucher.code}</code>
<b>Tipe:</b> ${voucher.type === 'percentage' ? 'Percentage' : 'Fixed'}
<b>Nilai:</b> ${voucher.type === 'percentage' ? `${voucher.value}%` : toRupiah(voucher.value)}
<b>Digunakan:</b> ${voucher.usedCount}/${voucher.maxUses === -1 ? 'Unlimited' : voucher.maxUses}
<b>Status:</b> ${voucher.isActive ? '🟢 Aktif' : '🔴 Nonaktif'}
<b>Dibuat:</b> ${new Date(voucher.createdAt).toLocaleString('id-ID')}

<b>⚠️ PERINGATAN:</b>
Voucher akan dihapus secara permanen!
Aksi ini tidak dapat dibatalkan!
  `.trim();
  
  await editMenuMessage(ctx, message, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Ya, Hapus Voucher", callback_data: `execute_delete_voucher_${voucherId}` }],
        [{ text: "❌ Batal", callback_data: "delete_voucher_list" }]
      ]
    }
  });
});

bot.action(/execute_delete_voucher_(.+)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  
  const voucherId = ctx.match[1];
  const result = deleteVoucher(voucherId);
  
  if (result.success) {
    await ctx.answerCbQuery("✅ Voucher berhasil dihapus!", { show_alert: true });
    
    await editMenuMessage(ctx,
      `<b>✅ VOUCHER BERHASIL DIHAPUS!</b>\n\n${result.message}\n\nVoucher telah dihapus dari database.`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 Kembali ke Menu", callback_data: "manage_vouchers" }]]
        }
      }
    );
  } else {
    await ctx.answerCbQuery("❌ Gagal menghapus voucher!", { show_alert: true });
    
    await editMenuMessage(ctx,
      `<b>❌ GAGAL MENGHAPUS VOUCHER</b>\n\n${result.message}`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "delete_voucher_list" }]]
        }
      }
    );
  }
});

bot.action("confirm_delete_expired", async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  
  const vouchers = readVouchers();
  const now = Date.now();
  
  // Filter voucher yang akan dipertahankan
  const activeVouchers = vouchers.filter(v => 
    v.isActive && 
    (!v.expiresAt || v.expiresAt > now) &&
    (v.maxUses === -1 || v.usedCount < v.maxUses)
  );
  
  const deletedCount = vouchers.length - activeVouchers.length;
  
  if (deletedCount === 0) {
    return ctx.answerCbQuery("✅ Tidak ada voucher yang perlu dihapus!", { show_alert: true });
  }
  
  // Simpan voucher yang aktif saja
  saveVouchers(activeVouchers);
  
  await ctx.answerCbQuery(`✅ ${deletedCount} voucher berhasil dihapus!`, { show_alert: true });
  
  await editMenuMessage(ctx,
    `<b>✅ BERHASIL MEMBERSIHKAN VOUCHER!</b>\n\nSebanyak <b>${deletedCount}</b> voucher kadaluarsa/nonaktif telah dihapus.\n\nSisa voucher aktif: <b>${activeVouchers.length}</b>`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "🔙 Kembali ke Menu", callback_data: "manage_vouchers" }]]
        }
      }
    );
});

bot.action(/execute_delete_bycode_(.+)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  
  const voucherCode = ctx.match[1];
  const result = deleteVoucherByCode(voucherCode);
  
  if (result.success) {
    await ctx.answerCbQuery("✅ Voucher berhasil dihapus!", { show_alert: true });
    
    await editMenuMessage(ctx,
      `<b>✅ VOUCHER BERHASIL DIHAPUS!</b>\n\n<b>Kode Voucher:</b> <code>${voucherCode}</code>\n\n${result.message}\n\nVoucher telah dihapus dari database.`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 Kembali ke Menu", callback_data: "manage_vouchers" }]]
        }
      }
    );
  } else {
    await ctx.answerCbQuery("❌ Gagal menghapus voucher!", { show_alert: true });
    
    await editMenuMessage(ctx,
      `<b>❌ GAGAL MENGHAPUS VOUCHER</b>\n\n<b>Kode:</b> <code>${voucherCode}</code>\n\n${result.message}`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "delete_voucher_menu" }]]
        }
      }
    );
  }
});

bot.action("broadcast_voucher_menu", async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  
  const vouchers = readVouchers();
  const activeVouchers = vouchers.filter(v => v.isActive);
  
  if (activeVouchers.length === 0) {
    return ctx.answerCbQuery("❌ Tidak ada voucher aktif!", { show_alert: true });
  }
  
  const buttons = activeVouchers.map(v => [
    { 
      text: `${v.code} (${v.type === 'percentage' ? `${v.value}%` : toRupiah(v.value)})`, 
      callback_data: `broadcast_voucher_${v.id}`
    }
  ]);
  
  buttons.push([{ text: "🔙 Kembali", callback_data: "manage_vouchers" }]);
  
  await editMenuMessage(ctx, 
    `<b>📤 BROADCAST VOUCHER</b>\n\nPilih voucher yang akan di-broadcast ke semua user:`,
    {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons }
    }
  );
});

bot.action(/broadcast_voucher_(.+)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  
  const voucherId = ctx.match[1];
  const vouchers = readVouchers();
  const voucher = vouchers.find(v => v.id === voucherId);
  
  if (!voucher) {
    return ctx.answerCbQuery("❌ Voucher tidak ditemukan!", { show_alert: true });
  }
  
  await ctx.answerCbQuery("⏳ Memulai broadcast...");
  
  const loadingMsg = await ctx.reply("<blockquote>📤 <b>Mengirim voucher ke semua user...</b>\nProses mungkin memakan waktu beberapa menit.</blockquote>", {
    parse_mode: "HTML"
  });
  
  const sentCount = await broadcastVoucherToAllUsers(voucher);
  
  await ctx.deleteMessage(loadingMsg.message_id);
  
  let successMessage = `<b>✅ BROADCAST SELESAI</b>\n\n`;
  successMessage += `Voucher <code>${voucher.code}</code> telah dikirim ke <b>${sentCount}</b> user!\n\n`;
  successMessage += `<b>📢 NOTIFIKASI:</b>\n`;
  successMessage += `├ Channel: ${config.testimoniChannel ? '✅ Akan dikirim' : '❌ Belum diatur'}\n`;
  successMessage += `└ Owner: ✅ Akan dikirim\n\n`;
  successMessage += `<i>Notifikasi akan dikirim dalam beberapa detik...</i>`;
  
  await editMenuMessage(ctx, successMessage, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "manage_vouchers" }]]
    }
  });
});

bot.action("list_vouchers", async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  
  const vouchers = readVouchers();
  
  if (vouchers.length === 0) {
    return editMenuMessage(ctx, 
      "<b>📭 BELUM ADA VOUCHER</b>\n\nBuat voucher terlebih dahulu!",
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "manage_vouchers" }]]
        }
      }
    );
  }
  
  let message = `<b>📋 DAFTAR SEMUA VOUCHER</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  
  vouchers.forEach((v, i) => {
    const status = v.isActive ? "🟢" : "🔴";
    const typeText = v.type === 'percentage' ? `${v.value}%` : toRupiah(v.value);
    const uses = `${v.usedCount}/${v.maxUses}`;
    const expires = v.expiresAt ? new Date(v.expiresAt).toLocaleDateString('id-ID') : "Tidak";
    
    message += `<b>${i+1}. ${status} ${v.code}</b>\n`;
    message += `├ Tipe: ${typeText}\n`;
    message += `├ Digunakan: ${uses}\n`;
    message += `├ Kadaluarsa: ${expires}\n`;
    message += `└ Status: ${v.isActive ? 'Aktif' : 'Nonaktif'}\n\n`;
  });
  
  await editMenuMessage(ctx, message, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "manage_vouchers" }]]
    }
  });
});

// Handler untuk menu voucher di user side
bot.action("menu_voucher", async (ctx) => {
  await ctx.answerCbQuery();
  
  const vouchers = readVouchers();
  const now = Date.now();
  
  const activeVouchers = vouchers.filter(v => 
    v.isActive && 
    (!v.expiresAt || v.expiresAt > now) &&
    v.usedCount < v.maxUses
  );
  
  if (activeVouchers.length === 0) {
    return editMenuMessage(ctx,
      `<b>🎫 VOUCHER SAYA</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n📭 <b>Belum ada voucher aktif yang tersedia.</b>\n\nTunggu owner mengirim voucher baru!`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Cek Voucher", callback_data: "check_voucher_input" }],
            [{ text: "🔙 Kembali", callback_data: "menu_katalog_v2" }]
          ]
        }
      }
    );
  }
  
  let message = `<b>🎫 VOUCHER AKTIF</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  
  activeVouchers.forEach((v, i) => {
    message += `<b>${i+1}. ${v.code}</b>\n`;
    message += `├ Diskon: ${v.type === 'percentage' ? `${v.value}%` : toRupiah(v.value)}\n`;
    message += `├ Sisa: ${v.maxUses - v.usedCount}x penggunaan\n`;
    if (v.expiresAt) {
      message += `└ Kadaluarsa: ${new Date(v.expiresAt).toLocaleDateString('id-ID')}\n`;
    }
    message += `\n`;
  });
  
  message += `<i>Pilih "Gunakan Voucher" saat checkout produk!</i>`;
  
  await editMenuMessage(ctx, message, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔍 Cek Voucher Lain", callback_data: "check_voucher_input" }],
        [{ text: "🔙 Kembali", callback_data: "menu_katalog_v2" }]
      ]
    }
  });
});

bot.action("check_voucher_input", async (ctx) => {
  userState[ctx.from.id] = {
    step: "WAITING_CHECK_VOUCHER"
  };
  
  await editMenuMessage(ctx,
    `<b>🔍 CEK VOUCHER</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\nMasukkan kode voucher yang ingin dicek:\n\nContoh: <code>ABC123DE</code>`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "🔙 Batal", callback_data: "menu_voucher" }]]
      }
    }
  );
});

bot.action("voucher_no_expiry", async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  
  const userId = ctx.from.id;
  userState[userId].voucherData.expiresAt = null;
  userState[userId].step = "WAITING_VOUCHER_EXPIRY";
  
  // Simulasi input text "tidak"
  await ctx.answerCbQuery();
  
  // Kirim pesan dummy untuk trigger handler text
  await safeReply(ctx, "tidak", {
    reply_markup: { remove_keyboard: true }
  });
});

bot.action(/voucher_max_uses:(.+)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  
  const maxUses = parseInt(ctx.match[1]);
  const userId = ctx.from.id;
  
  userState[userId].voucherData.maxUses = maxUses;
  userState[userId].step = "_VOUCHER_EXPIRY";
  
  await ctx.answerCbQuery();
  await editMenuMessage(ctx,
    `<blockquote><b>📅 TANGGAL KADALUARSA (Opsional)</b>\n\nFormat: DD-MM-YYYY\nContoh: 31-12-2024\n\nAtau kirim "tidak" untuk tanpa kadaluarsa</blockquote>`,
    { 
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "⏳ Tanpa Kadaluarsa", callback_data: "voucher_no_expiry" }]]
      }
    }
  );
});

bot.action("owner_muridpanel", (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  const db = readDb();
  db.isMuridPanelOpen = !db.isMuridPanelOpen;
  saveDb(db);
  const status = db.isMuridPanelOpen ? "🟢 ONLINE" : "🔴 OFFLINE";
  safeReply(ctx, `<blockquote><b>Status Murid Panel sekarang:</b> ${status}</blockquote>`, { parse_mode: "HTML" });
});

bot.action("owner_adminpanel", (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  const db = readDb();
  db.isAdminPanelOpen = !db.isAdminPanelOpen;
  saveDb(db);
  const status = db.isAdminPanelOpen ? "🟢 ONLINE" : "🔴 OFFLINE";
  safeReply(ctx, `<blockquote><b>Status Admin Panel sekarang:</b> ${status}</blockquote>`, { parse_mode: "HTML" });
});

bot.action("list_adminpanel", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang boleh melihat order Admin Panel!", { show_alert: true });
  }
  
  await ctx.answerCbQuery("📋 Memuat data admin panel...");
  
  const orders = readAdminPanelOrders();
  
  if (orders.length === 0) {
    return safeReply(ctx, "<blockquote>📭 <b>Belum ada order Admin Panel.</b></blockquote>", { 
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Kembali", callback_data: "menu_owner" }]
        ]
      }
    });
  }
  
  let message = `<blockquote><b>📋 DAFTAR ORDER ADMIN PANEL</b></blockquote>\n\n`;
  message += `<blockquote><b>Total Order:</b> ${orders.length} akun</blockquote>\n\n`;
  
  // Tampilkan 10 order terbaru
  const recentOrders = orders.slice(-10).reverse();
  
  recentOrders.forEach((order, index) => {
    const orderDate = new Date(order.created).toLocaleString("id-ID");
    const panelTypeText = order.panelType === "private" ? "PRIVATE" : "PUBLIC";
    const durasiText = order.duration === "bulanan" ? "1 Bulan" : "Permanen";
    
    message += `<blockquote><b>${index + 1}. ${order.userName}</b> (ID: ${order.userId})\n`;
    message += `├ <b>Tipe:</b> ${panelTypeText}\n`;
    message += `├ <b>Durasi:</b> ${durasiText}\n`;
    message += `├ <b>Username:</b> ${order.username}\n`;
    message += `├ <b>Password:</b> ${order.password}\n`;
    message += `├ <b>Harga:</b> ${toRupiah(order.price)}\n`;
    message += `├ <b>Status:</b> ${order.status === 'active' ? '🟢 Aktif' : '🔴 Inactive'}\n`;
    message += `└ <b>Tanggal:</b> ${orderDate}</blockquote>\n\n`;
  });
  
  if (orders.length > 10) {
    message += `<blockquote><i>Menampilkan 10 order terbaru dari total ${orders.length} order.</i></blockquote>`;
  }
  
  await safeReply(ctx, message, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📄 Export ke File", callback_data: "export_adminpanel" },
          { text: "🔄 Refresh", callback_data: "list_adminpanel" }
        ],
        [
          { text: "👁️ Lihat Semua", callback_data: "view_all_adminpanel" },
          { text: "🔍 Cari Order", callback_data: "search_adminpanel" }
        ],
        [{ text: "🔙 Kembali", callback_data: "menu_owner" }]
      ]
    }
  });
});

// Export data admin panel ke file
bot.action("export_adminpanel", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner!", { show_alert: true });
  }
  
  const orders = readAdminPanelOrders();
  
  if (orders.length === 0) {
    return ctx.answerCbQuery("❌ Tidak ada data admin panel!", { show_alert: true });
  }
  
  await ctx.answerCbQuery("📄 Membuat file CSV...");
  
  // Buat header CSV
  let csvContent = "ID,User ID,Nama User,Username,Tipe,Durasi,Panel Username,Panel Email,Password,Login URL,Harga,Status,Tanggal,Expired\n";
  
  // Tambahkan data
  orders.forEach(order => {
    csvContent += `"${order.id}",${order.userId},"${(order.userName || '').replace(/"/g, '""')}","${(order.userUsername || '').replace(/"/g, '""')}","${order.panelType}","${order.duration}","${order.username}","${order.email}","${order.password}","${order.loginUrl}",${order.price},"${order.status}","${order.createdAt}","${order.expires}"\n`;
  });
  
  // Simpan ke file sementara
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tempFile = `./temp_adminpanel_${timestamp}.csv`;
  
  try {
    fs.writeFileSync(tempFile, csvContent);
    
    // Kirim file ke owner
    await ctx.replyWithDocument({
      source: fs.readFileSync(tempFile),
      filename: `adminpanel_orders_${new Date().toISOString().split('T')[0]}.csv`
    }, {
      caption: `<blockquote>📤 <b>Export Data Admin Panel</b>\n\nTotal: ${orders.length} order\nWaktu: ${new Date().toLocaleString("id-ID")}</blockquote>`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Kembali", callback_data: "list_adminpanel" }]
        ]
      }
    });
    
    // Hapus file sementara
    fs.unlinkSync(tempFile);
    
    // Hapus pesan sebelumnya
    try {
      await ctx.deleteMessage();
    } catch (e) {}
    
  } catch (error) {
    console.error("[ERROR] Gagal export CSV:", error);
    await ctx.answerCbQuery("❌ Gagal membuat file CSV!", { show_alert: true });
  }
});

bot.action("view_all_adminpanel", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner!", { show_alert: true });
  }
  
  await ctx.answerCbQuery("📋 Memuat semua data...");
  
  const orders = readAdminPanelOrders();
  
  if (orders.length === 0) {
    return ctx.answerCbQuery("❌ Tidak ada data!", { show_alert: true });
  }
  
  let message = `<blockquote><b>📋 SEMUA ORDER ADMIN PANEL</b></blockquote>\n\n`;
  message += `<blockquote><b>Total Order:</b> ${orders.length} akun</blockquote>\n\n`;
  
  orders.forEach((order, index) => {
    const orderDate = new Date(order.created).toLocaleString("id-ID");
    const panelTypeText = order.panelType === "private" ? "PRIVATE" : "PUBLIC";
    const durasiText = order.duration === "bulanan" ? "1 Bulan" : "Permanen";
    
    message += `<blockquote><b>${index + 1}. ${order.userName}</b> (ID: ${order.userId})\n`;
    message += `├ <b>Tipe:</b> ${panelTypeText}\n`;
    message += `├ <b>Durasi:</b> ${durasiText}\n`;
    message += `├ <b>Username:</b> ${order.username}\n`;
    message += `├ <b>Harga:</b> ${toRupiah(order.price)}\n`;
    message += `├ <b>Status:</b> ${order.status === 'active' ? '🟢 Aktif' : '🔴 Inactive'}\n`;
    message += `└ <b>Tanggal:</b> ${orderDate}</blockquote>\n`;
  });
  
  // Karena mungkin panjang, kita kirim sebagai file jika terlalu panjang
  if (message.length > 4000) {
    const tempFile = `./temp_all_adminpanel_${Date.now()}.txt`;
    fs.writeFileSync(tempFile, message.replace(/<[^>]*>/g, ''));
    
    await ctx.replyWithDocument({
      source: fs.readFileSync(tempFile),
      filename: `all_adminpanel_orders.txt`
    }, {
      caption: `<blockquote>📋 <b>Semua Order Admin Panel</b>\nTotal: ${orders.length} order</blockquote>`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Kembali", callback_data: "list_adminpanel" }]
        ]
      }
    });
    
    fs.unlinkSync(tempFile);
  } else {
    await ctx.editMessageText(message, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Kembali", callback_data: "list_adminpanel" }]
        ]
      }
    });
  }
});

bot.action("menu_owner", (ctx) => {
  ctx.answerCbQuery().catch(()=>{});
  showOwnerMenu(ctx);
});

bot.action("list_vps_orders", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang boleh melihat order VPS!", { show_alert: true });
  }
  
  const vpsPath = "./database/data_vps.json";
  
  if (!fs.existsSync(vpsPath)) {
    return safeReply(ctx, "<blockquote>📭 Belum ada data VPS yang terjual.</blockquote>", { 
      parse_mode: "HTML" 
    });
  }
  
  try {
    const vpsDB = JSON.parse(fs.readFileSync(vpsPath));
    
    if (!Array.isArray(vpsDB) || vpsDB.length === 0) {
      return safeReply(ctx, "<blockquote>📭 Belum ada data VPS yang terjual.</blockquote>", { 
        parse_mode: "HTML" 
      });
    }
    
    let message = "<b>📋 DAFTAR ORDER VPS</b>\n\n";
    
    vpsDB.forEach((vps, i) => {
      message += `<b>${i + 1}. ${vps.hostname}</b>\n`;
      message += `<code>   User:</code> ${vps.username} (${vps.userId})\n`;
      message += `<code>   IP:</code> ${vps.ip}\n`;
      message += `<code>   Region:</code> ${vps.region}\n`;
      message += `<code>   Paket:</code> ${vps.paket}\n`;
      message += `<code>   Harga:</code> ${toRupiah(vps.harga)}\n`;
      message += `<code>   Tanggal:</code> ${vps.created}\n\n`;
    });
    
    await safeReply(ctx, message, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Kembali", "menu_owner")]
      ])
    });
    
  } catch (error) {
    console.error("Error reading VPS data:", error);
    safeReply(ctx, "<blockquote>❌ Gagal membaca data VPS.</blockquote>", { 
      parse_mode: "HTML" 
    });
  }
});

bot.action("backup_database", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return ctx.answerCbQuery("❌ Hanya owner yang boleh backup!", { show_alert: true });
  }
  
  await ctx.answerCbQuery("⏳ Memproses Full Backup...", { show_alert: false });
  await safeReply(ctx, "<blockquote>📦 <b>Sedang mempacking seluruh Source Code & Database...</b>\n<i>Mohon tunggu, proses tergantung ukuran file.</i></blockquote>", { parse_mode: "HTML" });
  
  createAndSendFullBackup(ctx, false);
});


bot.action("manual_payments_menu", (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  ctx.answerCbQuery().catch(()=>{});
  
  const payments = readManualPayments();
  const pendingCount = payments.filter(p => p.status === "pending").length;
  
  safeReply(ctx, `<blockquote><b>🧾 𝗠𝗲𝗻𝘂 𝗣𝗮𝘆𝗺𝗲𝗻𝘁 𝗠𝗮𝗻𝘂𝗮𝗹</b>\n<b>𝖯𝖾𝗇𝖽𝗂𝗇𝗀:</b> ${pendingCount}</blockquote>`, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [ Markup.button.callback("📋 𝗟𝗶𝘀𝘁 𝗣𝗲𝗻𝗱𝗶𝗻𝗴", "list_pending_payments") ],
      [ Markup.button.callback("📜 𝗔𝗹𝗹 𝗣𝗮𝘆𝗺𝗲𝗻𝘁", "list_all_payments") ],
      [ Markup.button.callback("🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", "menu_owner") ]
    ])
  });
});

bot.action("list_pending_payments", (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  
  const payments = readManualPayments();
  const pending = payments.filter(p => p.status === "pending");
  
  if (pending.length === 0) {
    safeReply(ctx, "✅ Tidak ada pembayaran pending.");
    return showOwnerMenu(ctx);
  }
  
  let message = "<b>📋 Pembayaran Pending</b>\n\n";
  pending.forEach((p, i) => {
    message += `<b>${i+1}. ${p.userName} (${p.userId})</b>\n`;
    message += `<code>   Item:</code> ${p.itemName}\n`;
    message += `<code>   Amount:</code> ${toRupiah(p.amount)}\n`;
    message += `<code>   Time:</code> ${new Date(p.timestamp).toLocaleString()}\n`;
    message += `   [Verify](tg://user?id=${p.userId})\n\n`;
  });
  
  safeReply(ctx, message, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [ Markup.button.callback("🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", "manual_payments_menu") ]
    ])
  });
});

bot.action("list_all_payments", (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  
  const payments = readManualPayments();
  
  if (payments.length === 0) {
    safeReply(ctx, "📭 Belum ada riwayat pembayaran manual.");
    return showOwnerMenu(ctx);
  }
  
  let message = "<b>📜 Riwayat Semua Pembayaran Manual</b>\n\n";
  payments.forEach((p, i) => {
    const statusEmoji = p.status === "approved" ? "✅" : p.status === "rejected" ? "❌" : "⏳";
    message += `<b>${i+1}. ${statusEmoji} ${p.userName}</b>\n`;
    message += `<code>   Item:</code> ${p.itemName}\n`;
    message += `<code>   Amount:</code> ${toRupiah(p.amount)}\n`;
    message += `<code>   Status:</code> ${p.status}\n`;
    message += `<code>   Time:</code> ${new Date(p.timestamp).toLocaleString()}\n\n`;
  });
  
  safeReply(ctx, message, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [ Markup.button.callback("🔙 Kembali", "manual_payments_menu") ]
    ])
  });
});

bot.action("change_payment", (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  ctx.answerCbQuery().catch(()=>{});
  const active = getActivePaymentMethod();
  safeReply(ctx, `<blockquote><b>🔧 Payment aktif saat ini:</b> <code>${active.toUpperCase()}</code>\n<b>Pilih payment baru:</b></blockquote>`, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [ Markup.button.callback("🟢 𝗡𝗲𝘃𝗮𝗽𝗲𝗱𝗶𝗮", "set_payment_nevapedia") ],
      [ Markup.button.callback("👨‍💼 𝗠𝗮𝗻𝘂𝗮𝗹 (𝗤𝗥𝗜𝗦 𝗙𝗼𝘁𝗼)", "set_payment_manual") ],
      [ Markup.button.callback("🔙 𝗞𝗲𝗺𝗯𝗮𝗹𝗶", "menu_owner") ]
    ])
  });
});

bot.action("set_payment_nevapedia", (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  setActivePaymentMethod("nevapedia");
  safeReply(ctx, "<blockquote>✅ <b>Payment berhasil diganti ke NEVAPEDIA</b></blockquote>", { parse_mode: "HTML" });
  showOwnerMenu(ctx);
});


bot.action("owner_panel", (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  const db = readDb();
  db.isPanelOpen = !db.isPanelOpen;
  saveDb(db);
  const status = db.isPanelOpen ? "🟢 ONLINE" : "🔴 OFFLINE";
  safeReply(ctx, `<blockquote><b>Status panel sekarang:</b> ${status}</blockquote>`, { parse_mode: "HTML" });
});

bot.action("owner_broadcast", (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  ctx.answerCbQuery().catch(()=>{});
  userState[ctx.from.id] = { step: "WAITING_BROADCAST" };
  safeReply(ctx, "<blockquote>📢 <b>Silakan kirim pesan broadcast (teks atau foto).</b>\nKetik /batal untuk membatalkan.</blockquote>", {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("❌ Batalkan Broadcast", "cancel_broadcast")]
    ])
  });
});

bot.action("cancel_broadcast", (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  if (userState[ctx.from.id]?.step === "WAITING_BROADCAST") {
    delete userState[ctx.from.id];
    safeReply(ctx, "❌ Broadcast dibatalkan.");
    showOwnerMenu(ctx);
  }
});

bot.action("buyvps_start", async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buyvps_start')) return;

  const text = `
<b>🛒 KATALOG VPS DIGITALOCEAN</b>
━━━━━━━━━━━━━━━━━━━━━━
📦 <b>STOK TERSEDIA:</b> Ready untuk pemesanan!

⚙️ <b>Pilih tipe VPS sesuai kebutuhan Anda:</b>

🟢 <b>LOW VPS</b>
▪ Garansi: <b>15 Hari</b>
▪ Replace: <b>1x</b>
▪ Harga mulai: <b>Rp20.000</b>
━━━━━━━━━━━━━━━━━━━━━━

🟡 <b>MEDIUM VPS</b>
▪ Garansi: <b>25 Hari</b>
▪ Replace: <b>2x</b>
▪ Harga mulai: <b>Rp25.000</b>
━━━━━━━━━━━━━━━━━━━━━━

🔴 <b>HIGH VPS</b>
▪ Garansi: <b>30 Hari</b>
▪ Replace: <b>Unlimited</b>
▪ Harga mulai: <b>Rp35.000</b>
━━━━━━━━━━━━━━━━━━━━━━
✨ <b>Silakan pilih kategori VPS:</b>
`;

  await ctx.editMessageMedia(
    {
      type: "photo",
      media: config.startVps, // FOTO VPS
      caption: text,
      parse_mode: "HTML"
    },
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🟢 LOW", callback_data: "buyvps_pkg:low" }],
          [{ text: "🟡 MEDIUM", callback_data: "buyvps_pkg:medium" }],
          [{ text: "🔴 HIGH", callback_data: "buyvps_pkg:high" }],
          [{ text: "🔙 Kembali", callback_data: "menu_katalog" }]
        ]
      }
    }
  );
});

bot.action(/buyvps_pkg:(low|medium|high)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buyvps_pkg')) return;
  
  const paket = ctx.match[1];
  const userId = ctx.from.id;

  const count = await getDropletCount();
  const sisaVPS = Math.max(0, 10 - count);

  if (sisaVPS <= 0) {
    return editMenuMessage(ctx,
`❌ *STOK VPS HABIS*

Mohon Maaf Sebesar-besarnya 🙏  
Stok VPS kami *sudah habis* 😞

Silahkan hubungi *@RafatharCodeNew* untuk meminta restock VPS.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "buyvps_start" }]
          ]
        }
      }
    );
  }

  if (!userState[userId]) userState[userId] = {};
  userState[userId].vpsData = { paket };

  const dataHarga = config.hargaVPS?.[paket] || {};

  const listRam = [
    { id: 1, ram: "2GB", spec: "2 CPU | 60GB SSD | 3TB BW", plan: "2c2" },
    { id: 2, ram: "4GB", spec: "2 CPU | 80GB SSD | 4TB BW", plan: "4c2" },
    { id: 3, ram: "8GB", spec: "4 CPU | 160GB SSD | 5TB BW", plan: "8c4" },
    { id: 4, ram: "16GB", spec: "4 CPU | 200GB SSD | 8TB BW", plan: "16c4" },
    { id: 5, ram: "16GB", spec: "8 CPU | 320GB SSD | 6TB BW", plan: "16c8" }
  ].map(v => ({
    ...v,
    harga: dataHarga[v.plan] || 0
  }));

  let teks = `🖥 *PILIH RAM VPS*\n`;
  teks += `──────────────────────────\n\n`;

  for (const v of listRam) {
    teks += `*${v.id}. ${v.ram}*\n`;
    teks += `┈➤ ${v.spec}\n`;
    teks += `┈➤ *Rp ${v.harga.toLocaleString("id-ID")}*\n`;
    teks += `──────────────────────────\n`;
  }

  teks += `\n✅ *STOK TERSEDIA : ${sisaVPS} VPS*`;

  // BUTTON ANGKA (KANAN-KIRI)
  const keyboard = [];
  for (let i = 0; i < listRam.length; i += 2) {
    keyboard.push(
      listRam.slice(i, i + 2).map(v => ({
        text: `${v.id}`,
        callback_data: `buyvps_ram:${v.plan}`
      }))
    );
  }

  keyboard.push([{ text: "🔙 Kembali", callback_data: "buyvps_start" }]);

  await editMenuMessage(ctx, teks, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard }
  });
});

bot.action(/buyvps_ram:(.+)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buyvps_ram')) return;
  
  const plan = ctx.match[1];
  const userId = ctx.from.id;

  if (!userState[userId]) userState[userId] = {};
  if (!userState[userId].vpsData) userState[userId].vpsData = {};
  userState[userId].vpsData.plan = plan;

  const osFamily = [
    { id: 1, name: "Ubuntu", key: "ubuntu" },
    { id: 2, name: "Debian", key: "debian" },
    { id: 3, name: "CentOS Stream", key: "centos" },
    { id: 4, name: "Fedora", key: "fedora" },
    { id: 5, name: "AlmaLinux", key: "almalinux" },
    { id: 6, name: "Rocky Linux", key: "rocky" }
  ];

  let teks = `💾 *SPESIFIKASI VPS DIPILIH*\n`;
  teks += `──────────────────────────\n`;
  teks += `📦 *Plan*: ${plan}\n\n`;
  teks += `🖥 *PILIH OS VPS*\n`;
  teks += `──────────────────────────\n\n`;

  for (const os of osFamily) {
    teks += `*${os.id}. ${os.name}*\n`;
    teks += `──────────────────────────\n`;
  }

  // BUTTON ANGKA (KANAN-KIRI)
  const keyboard = [];
  for (let i = 0; i < osFamily.length; i += 2) {
    keyboard.push(
      osFamily.slice(i, i + 2).map(os => ({
        text: `${os.id}`,
        callback_data: `buyvps_osfamily:${os.key}`
      }))
    );
  }

  keyboard.push([
    { 
      text: "🔙 Kembali", 
      callback_data: `buyvps_pkg:${userState[userId].vpsData.paket}` 
    }
  ]);

  await editMenuMessage(ctx, teks, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard }
  });
});

bot.action(/buyvps_osfamily:(.+)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buyvps_osfamily')) return;
  
  const osKey = ctx.match[1];
  const userId = ctx.from.id;

  if (!userState[userId]) userState[userId] = {};
  if (!userState[userId].vpsData) userState[userId].vpsData = {};
  userState[userId].vpsData.osFamily = osKey;

  const osVersions = {
    ubuntu: [
      { id: 1, name: "Ubuntu 22.04", slug: "ubuntu-22-04-x64" },
      { id: 2, name: "Ubuntu 24.04", slug: "ubuntu-24-04-x64" },
      { id: 3, name: "Ubuntu 25.04", slug: "ubuntu-25-04-x64" },
    ],
    debian: [
      { id: 1, name: "Debian 12", slug: "debian-12-x64" },
      { id: 2, name: "Debian 13", slug: "debian-13-x64" },
    ],
    centos: [
      { id: 1, name: "CentOS Stream 9", slug: "centos-stream-9-x64" },
    ],
    fedora: [
      { id: 1, name: "Fedora 42", slug: "fedora-42-x64" },
    ],
    almalinux: [
      { id: 1, name: "AlmaLinux 8", slug: "almalinux-8-x64" },
      { id: 2, name: "AlmaLinux 9", slug: "almalinux-9-x64" },
    ],
    rocky: [
      { id: 1, name: "Rocky Linux 8", slug: "rockylinux-8-x64" },
      { id: 2, name: "Rocky Linux 9", slug: "rockylinux-9-x64" },
    ]
  };

  const versionList = osVersions[osKey] || [];

  let teks = `🖥 *OS FAMILY DIPILIH*\n`;
  teks += `──────────────────────────\n`;
  teks += `📀 *${osKey.toUpperCase()}*\n\n`;
  teks += `📦 *PILIH VERSI OS*\n`;
  teks += `──────────────────────────\n\n`;

  for (const v of versionList) {
    teks += `*${v.id}. ${v.name}*\n`;
    teks += `──────────────────────────\n`;
  }

  // BUTTON ANGKA (KANAN–KIRI)
  const keyboard = [];
  for (let i = 0; i < versionList.length; i += 2) {
    keyboard.push(
      versionList.slice(i, i + 2).map(v => ({
        text: `${v.id}`,
        callback_data: `buyvps_os:${v.slug}`
      }))
    );
  }

  keyboard.push([
    { 
      text: "🔙 Kembali", 
      callback_data: `buyvps_ram:${userState[userId].vpsData.plan}` 
    }
  ]);

  await editMenuMessage(ctx, teks, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard }
  });
});

bot.action(/buyvps_os:(.+)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buyvps_os')) return;
  
  const osSlug = ctx.match[1];
  const userId = ctx.from.id;
  
  if (userState[userId]?.vpsData) {
    userState[userId].vpsData.os = osSlug;
  }

  const regionList = [
    { name: "SINGAPORE", code: "sgp1" },
    { name: "NEW YORK", code: "nyc3" },
    { name: "SAN FRANCISCO", code: "sfo3" },
    { name: "AMSTERDAM", code: "ams3" },
    { name: "LONDON", code: "lon1" },
    { name: "FRANKFURT", code: "fra1" },
  ];

  let text = `📍 *PILIH REGION VPS*\n\n`;
  regionList.forEach((r, i) => text += `${i + 1}. ${r.name}\n`);

  if (userState[userId]?.vpsData) {
    userState[userId].vpsData.regionList = regionList;
  }

  const buttons = regionList.map((r, i) => [
    { text: `${i + 1}. ${r.name}`, callback_data: `buyvps_region:${r.code}` }
  ]);

  buttons.push([
    { text: "🔙 Kembali", callback_data: `buyvps_osfamily:${userState[userId]?.vpsData?.osFamily}` }
  ]);

  await editMenuMessage(ctx, text, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buttons }
  });
});

bot.action(/buyvps_region:(.+)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buyvps_region')) return;
  
  const region = ctx.match[1];
  const userId = ctx.from.id;
  
  if (!userState[userId]?.vpsData) {
    return ctx.answerCbQuery("❌ Session VPS tidak ditemukan!", { show_alert: true });
  }

  const vpsData = userState[userId].vpsData;
  vpsData.region = region;

  const paket = vpsData.paket;
  const plan = vpsData.plan;
  const hargaRaw = config.hargaVPS?.[paket]?.[plan] || 0;
  
  vpsData.harga = hargaRaw;
  vpsData.username = ctx.from.username || ctx.from.first_name;

  const paketInfo = {
    low: { garansi: "15 Hari", replace: "1x" },
    medium: { garansi: "25 Hari", replace: "2x" },
    high: { garansi: "30 Hari", replace: "Unlimited" }
  };

  const specList = {
    "2c2": "2GB 2 VCPU | 60GB SSD | 3TB BW",
    "4c2": "4GB 2 VCPU | 80GB SSD | 4TB BW",
    "8c4": "8GB 4 VCPU | 160GB SSD | 5TB BW",
    "16c4": "16GB 4 VCPU | 200GB SSD | 8TB BW",
    "16c8": "16GB 8 VCPU | 320GB SSD | 6TB BW"
  };

  const labelSpec = specList[plan] || "-";
  const harga = `Rp ${hargaRaw.toLocaleString("id-ID")}`;

  await editMenuMessage(ctx,
`✅ *KONFIRMASI PEMESANAN VPS*
━━━━━━━━━━━━━━━━━━━━━━

📦 *Paket*: ${paket.toUpperCase()}
💸 *Harga*: *${harga}*

🛡️ *Garansi*: ${paketInfo[paket].garansi}
♻️ *Replace*: ${paketInfo[paket].replace}

🖥 *Spesifikasi*
• ${labelSpec}
• CPU/RAM Code: *${plan}*

🧩 *OS Family*: ${vpsData.osFamily.toUpperCase()}
🖥 *OS Version*: ${vpsData.os}
🌍 *Region*: ${region}

━━━━━━━━━━━━━━━━━━━━━━
Silakan pilih metode pembayaran.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "💰 Bayar via QRIS Otomatis", callback_data: "buyvps_pay_qris" }],
          [{ text: "🔙 Kembali", callback_data: `buyvps_os:${vpsData.os}` }]
        ]
      }
    }
  );
});

bot.action(/choose_service(_page_(\d+))?/, async (ctx) => {
  const page = ctx.match[2] ? parseInt(ctx.match[2]) : 1;
  const perPage = 20;
  const apiKey = config.RUMAHOTP;

  try {
    if (!ctx.match[2]) {
       await ctx.editMessageCaption("⏳ <b>Memuat daftar layanan...</b>", { parse_mode: "HTML" }).catch(() => {});
    }

    if (globalNokos.cachedServices.length === 0) {
      const res = await axios.get("https://www.rumahotp.io/api/v2/services", { headers: { "x-apikey": apiKey } });
      if (res.data.success) globalNokos.cachedServices = res.data.data;
    }

    const services = globalNokos.cachedServices;
    const totalPages = Math.ceil(services.length / perPage);
    const start = (page - 1) * perPage;
    const list = services.slice(start, start + perPage);

    const buttons = list.map(srv => [{
      text: `${srv.service_name}`,
      callback_data: `service_${srv.service_code}`
    }]);

    const nav = [];
    if (page > 1) nav.push({ text: "⬅️ Prev", callback_data: `choose_service_page_${page - 1}` });
    if (page < totalPages) nav.push({ text: "➡️ Next", callback_data: `choose_service_page_${page + 1}` });
    if (nav.length) buttons.push(nav);

    buttons.push([{ text: "💰 DEPOSIT (RumahOTP)", callback_data: "topup_nokos" }]); 
    buttons.push([{ text: "🔙 Kembali", callback_data: "menu_katalog" }]);

    const caption = `<b>📱 DAFTAR APLIKASI OTP</b>\n\nSilakan pilih aplikasi:\nHalaman ${page}/${totalPages}`;

    globalNokos.lastServicePhoto[ctx.from.id] = { chatId: ctx.chat.id, messageId: ctx.callbackQuery.message.message_id };

    if (config.ppthumb && !ctx.match[2]) {
       await editMenuMessageWithPhoto(ctx, config.ppthumb, caption, { reply_markup: { inline_keyboard: buttons } });
    } else {
       await ctx.editMessageCaption(caption, { parse_mode: "HTML", reply_markup: { inline_keyboard: buttons } });
    }

  } catch (error) {
    console.error(error);
    await ctx.answerCbQuery("❌ Gagal memuat layanan.");
  }
});

bot.action(/service_(.+)/, async (ctx) => {
  const serviceId = ctx.match[1];
  const apiKey = config.RUMAHOTP;

  await ctx.editMessageCaption("⏳ <b>Memuat negara...</b>", { parse_mode: "HTML" }).catch(() => {});

  try {
    if (!globalNokos.cachedCountries[serviceId]) {
      const res = await axios.get(`https://www.rumahotp.io/api/v2/countries?service_id=${serviceId}`, {
        headers: { "x-apikey": apiKey }
      });
      if (res.data.success) {
         globalNokos.cachedCountries[serviceId] = res.data.data.filter(x => x.pricelist && x.pricelist.length > 0);
      }
    }

    const countries = globalNokos.cachedCountries[serviceId] || [];
    if (countries.length === 0) return ctx.editMessageCaption("❌ Negara tidak tersedia.", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{text: "🔙 Kembali", callback_data: "choose_service"}]] } });

    const slice = countries.slice(0, 20);
    
    const buttons = slice.map(c => [{
      text: `${c.name} (${c.stock_total})`,
      callback_data: `country_${serviceId}_${c.iso_code}_${c.number_id}`
    }]);

    buttons.push([{ text: "🔙 Kembali", callback_data: "choose_service" }]);

    await ctx.editMessageCaption(`<b>🌍 PILIH NEGARA</b>\nLayanan ID: ${serviceId}`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (e) {
    ctx.answerCbQuery("Error memuat negara");
  }
});

bot.action(/country_(.+)_(.+)_(.+)/, async (ctx) => {
  const [_, serviceId, iso, numberId] = ctx.match;
  const apiKey = config.RUMAHOTP;
  const untung = config.UNTUNG_NOKOS || 500;

  await ctx.editMessageCaption("⏳ <b>Memuat harga...</b>", { parse_mode: "HTML" }).catch(() => {});

  try {
    let countryData = globalNokos.cachedCountries[serviceId]?.find(c => String(c.number_id) === String(numberId));
    
    if (!countryData) {
       const res = await axios.get(`https://www.rumahotp.io/api/v2/countries?service_id=${serviceId}`, { headers: { "x-apikey": apiKey } });
       countryData = res.data.data.find(c => String(c.number_id) === String(numberId));
    }

    if (!countryData) return ctx.answerCbQuery("Negara data error");

    const providers = (countryData.pricelist || [])
      .filter(p => p.available && p.stock > 0)
      .map(p => {
        const finalPrice = (parseInt(p.price) || 0) + untung;
        return { ...p, finalPrice };
      })
      .sort((a, b) => a.finalPrice - b.finalPrice);

    if (providers.length === 0) return ctx.editMessageCaption("❌ Stok kosong untuk negara ini.", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{text: "🔙 Kembali", callback_data: `service_${serviceId}`}]] } });

    const buttons = providers.map(p => [{
      text: `Rp ${toRupiah(p.finalPrice)} (Stok: ${p.stock})`,
      callback_data: `buy_nokos_${numberId}_${p.provider_id}_${serviceId}_${p.finalPrice}`
    }]);

    buttons.push([{ text: "🔙 Kembali", callback_data: `service_${serviceId}` }]);

    await ctx.editMessageCaption(`<b>💵 PILIH HARGA</b>\nNegara: ${countryData.name}\n\nPilih harga terbaik:`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons }
    });

  } catch (e) {
    ctx.answerCbQuery("Gagal memuat harga");
  }
});

bot.action(/buy_nokos_(.+)_(.+)_(.+)_(.+)/, async (ctx) => {
  const [_, numberId, providerId, serviceId, price] = ctx.match;
  
  const buttons = [
    [{ text: "✅ Konfirmasi Beli (Random Operator)", callback_data: `confirm_nokos_${numberId}_${providerId}_${serviceId}_any_${price}` }],
    [{ text: "📡 Pilih Operator Tertentu", callback_data: `operator_${numberId}_${providerId}_${serviceId}_${price}` }],
    [{ text: "🔙 Batal", callback_data: "choose_service" }]
  ];

  await ctx.editMessageCaption(`<b>🛒 KONFIRMASI ORDER</b>\n\n💰 Harga: Rp ${toRupiah(price)}\n\nLanjutkan pembelian?`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons }
  });
});

bot.action(/operator_(.+)_(.+)_(.+)_(.+)/, async (ctx) => {
  const [_, numberId, providerId, serviceId, price] = ctx.match;
  const apiKey = config.RUMAHOTP;

  try {
     const countryData = globalNokos.cachedCountries[serviceId]?.find(c => String(c.number_id) === String(numberId));
     if (!countryData) return ctx.answerCbQuery("Data negara hilang, ulangi dari awal.");

     const res = await axios.get(`https://www.rumahotp.io/api/v2/operators?country=${encodeURIComponent(countryData.name)}&provider_id=${providerId}`, { headers: { "x-apikey": apiKey } });
     
     const ops = res.data.data || [];
     if(ops.length === 0) return ctx.answerCbQuery("Operator spesifik tidak tersedia, gunakan random.");

     const buttons = ops.map(op => [{
        text: op.name,
        callback_data: `confirm_nokos_${numberId}_${providerId}_${serviceId}_${op.id}_${price}`
     }]);
     buttons.push([{text: "🔙 Kembali", callback_data: `buy_nokos_${numberId}_${providerId}_${serviceId}_${price}`}]);

     await ctx.editMessageCaption(`<b>📡 PILIH OPERATOR</b>\nProvider ID: ${providerId}`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons }
     });

  } catch(e) {
     ctx.answerCbQuery("Gagal load operator");
  }
});

bot.action(/confirm_nokos_(.+)_(.+)_(.+)_(.+)_(.+)/, async (ctx) => {
  const [_, numberId, providerId, serviceId, operatorId, priceStr] = ctx.match;
  const price = parseInt(priceStr);
  const userId = ctx.from.id;
  const apiKey = config.RUMAHOTP;
  const dbPath = "./database/saldoOtp.json";

  const saldoData = JSON.parse(fs.readFileSync(dbPath, "utf8") || "{}");
  const userSaldo = saldoData[userId] || 0;

  if (userSaldo < price) {
    return ctx.answerCbQuery("❌ Saldo tidak cukup!", { show_alert: true });
  }

  await ctx.editMessageCaption("⏳ <b>Memproses order ke server...</b>", { parse_mode: "HTML" }).catch(()=>{});

  try {
    saldoData[userId] = userSaldo - price;
    fs.writeFileSync(dbPath, JSON.stringify(saldoData, null, 2));

    let url = `https://www.rumahotp.io/api/v2/orders?number_id=${numberId}&provider_id=${providerId}`;
    if (operatorId && operatorId !== 'any') {
        url += `&operator_id=${operatorId}`;
    }

    const res = await axios.get(url, { headers: { "x-apikey": apiKey } });

    if (!res.data.success) {
      saldoData[userId] += price;
      fs.writeFileSync(dbPath, JSON.stringify(saldoData, null, 2));
      
      const errMsg = res.data.message || "Stok habis / Gangguan Provider";
      return ctx.editMessageCaption(`❌ <b>Order Gagal:</b> ${errMsg}\n💰 Saldo dikembalikan.`, { 
          parse_mode: "HTML", 
          reply_markup: { inline_keyboard: [[{text:"🔙 Menu", callback_data:"choose_service"}]] } 
      });
    }

    const d = res.data.data;
    
    globalNokos.activeOrders[d.order_id] = {
      userId,
      price,
      messageId: ctx.callbackQuery.message.message_id,
      startTime: Date.now()
    };

    const text = `✅ <b>ORDER BERHASIL</b>\n\n🆔 ID: <code>${d.order_id}</code>\n📞 No: <code>${d.phone_number}</code>\n📱 App: ${d.service}\n💰 Harga: ${toRupiah(price)}\n\n⏳ <i>Menunggu SMS OTP...</i>`;

    await ctx.editMessageCaption(text, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📩 Cek Kode SMS", callback_data: `check_sms_${d.order_id}` }],
          [{ text: "❌ Batalkan Pesanan", callback_data: `cancel_sms_${d.order_id}` }]
        ]
      }
    });

    // CATAT TRANSAKSI NOKOS (SAAT ORDER BERHASIL DIBUAT)
    recordTransaction(
      userId,
      ctx.from.first_name || 'User',
      `Nokos: ${serviceId}`,
      price,
      'nokos'
    );

    const expireTime = (d.expires_in_minute || 20) * 60 * 1000;
    
    setTimeout(async () => {
       if (globalNokos.activeOrders[d.order_id]) {
           try {
               const cek = await axios.get(`https://www.rumahotp.io/api/v1/orders/get_status?order_id=${d.order_id}`, { headers: { "x-apikey": apiKey } });
               const st = cek.data.data;

               if (st.status !== 'completed' && (!st.otp_code || st.otp_code === '-')) {
                   await axios.get(`https://www.rumahotp.io/api/v1/orders/set_status?order_id=${d.order_id}&status=cancel`, { headers: { "x-apikey": apiKey } });
                   
                   const curSaldo = JSON.parse(fs.readFileSync(dbPath, "utf8"));
                   curSaldo[userId] = (curSaldo[userId] || 0) + price;
                   fs.writeFileSync(dbPath, JSON.stringify(curSaldo, null, 2));

                   bot.telegram.sendMessage(userId, `⌛ <b>Order Expired/Timeout</b>\nID: ${d.order_id}\nSaldo Rp ${toRupiah(price)} dikembalikan.`, {parse_mode:"HTML"});
                   
                   delete globalNokos.activeOrders[d.order_id];
               }
           } catch(e) { console.log("Auto cancel error", e.message); }
       }
    }, expireTime);

  } catch (e) {
    console.error("Order Sys Error:", e);
    const curSaldo = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    curSaldo[userId] = (curSaldo[userId] || 0) + price;
    fs.writeFileSync(dbPath, JSON.stringify(curSaldo, null, 2));
    ctx.editMessageCaption(`❌ <b>System Error:</b> ${e.message}`);
  }
});

bot.action(/check_sms_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const apiKey = config.RUMAHOTP;

  try {
    const res = await axios.get(`https://www.rumahotp.io/api/v1/orders/get_status?order_id=${orderId}`, {
       headers: { "x-apikey": apiKey }
    });

    const d = res.data.data;
    const status = d.status.toLowerCase();

    if (status === "completed" || (d.otp_code && d.otp_code !== "-")) {
       if (globalNokos.activeOrders[orderId]) delete globalNokos.activeOrders[orderId];
       
       await ctx.editMessageCaption(
           `✅ <b>SMS DITERIMA!</b>\n\n📞 No: <code>${d.phone_number}</code>\n💬 <b>OTP:</b> <code>${d.otp_code}</code>\n\n<i>Transaksi Selesai.</i>`, 
           { parse_mode: "HTML" }
       );
       return;
    } 
    
    if (status === 'processing' || status === 'waiting' || status === 'pending') {
       const sisaWaktu = d.expires_in ? `(${d.expires_in}s)` : "";
       return ctx.answerCbQuery(`⏳ SMS Belum masuk.. Tunggu sebentar lagi! ${sisaWaktu}`, { show_alert: false });
    } 
    
    if (status === 'cancelled' || status === 'expired') {
       if (globalNokos.activeOrders[orderId]) delete globalNokos.activeOrders[orderId];
       await ctx.editMessageCaption(`❌ <b>Order Dibatalkan/Expired.</b>`, { parse_mode: "HTML" });
       return;
    }

    await ctx.answerCbQuery(`Status: ${status}`);

  } catch(e) {
    console.error("Check SMS Error:", e.message);
    ctx.answerCbQuery("⚠️ Gagal cek status API.");
  }
});

bot.action(/cancel_sms_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const apiKey = config.RUMAHOTP;
  const userId = ctx.from.id;

  let orderInfo = globalNokos.activeOrders[orderId];

  try {
    const res = await axios.get(`https://www.rumahotp.io/api/v1/orders/set_status?order_id=${orderId}&status=cancel`, {
       headers: { "x-apikey": apiKey }
    });

    if (res.data.success) {
       let msgRefund = "";

       if (orderInfo) {
          const dbPath = "./database/saldoOtp.json";
          const saldoData = JSON.parse(fs.readFileSync(dbPath, "utf8") || "{}");
          
          saldoData[userId] = (saldoData[userId] || 0) + orderInfo.price;
          fs.writeFileSync(dbPath, JSON.stringify(saldoData, null, 2));
          
          delete globalNokos.activeOrders[orderId];
          msgRefund = `\n💰 Saldo Rp ${toRupiah(orderInfo.price)} telah dikembalikan.`;
       } else {
          msgRefund = "\n⚠️ Data lokal hilang (bot restart), saldo tidak otomatis kembali. Hubungi Admin.";
       }

       await ctx.editMessageCaption(`✅ <b>Order Berhasil Dibatalkan.</b>${msgRefund}`, { 
           parse_mode: "HTML", 
           reply_markup: { inline_keyboard: [[{text:"🔙 Menu Utama", callback_data:"choose_service"}]] } 
       });

    } else {
       ctx.answerCbQuery("❌ Gagal cancel: " + (res.data.message || "Mungkin sudah expired/completed."));
    }
  } catch(e) {
    console.error("Cancel Error:", e.message);
    ctx.answerCbQuery("❌ Terjadi kesalahan API.");
  }
});

bot.action("topup_nokos", async (ctx) => {
  userState[ctx.from.id] = { step: "WAITING_TOPUP_RUMAHOTP" };
  await editMenuMessage(ctx, 
    "<b>💳 DEPOSIT (Qris RumahOTP)</b>\n\nSilakan kirim nominal deposit (Hanya Angka).\nMinimal: Rp 2.000\nContoh: <code>10000</code>", 
    { 
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{text: "❌ Batal", callback_data: "choose_service"}]] }
    }
  );
});

bot.action(/batal_depo_rumahotp_(.+)/, async (ctx) => {
   const depoId = ctx.match[1];
   const apiKey = config.RUMAHOTP;
   try {
     await axios.get(`https://www.rumahotp.io/api/v1/deposit/cancel?deposit_id=${depoId}`, { headers: { "x-apikey": apiKey } });
     await ctx.deleteMessage();
     await ctx.reply("✅ Deposit dibatalkan.", {reply_markup: {inline_keyboard: [[{text:"🔙 Menu", callback_data:"choose_service"}]]}});
   } catch(e) {
     ctx.answerCbQuery("Gagal batal");
   }
});

bot.action(/smm_services_(\d+)/, async (ctx) => {
    const page = parseInt(ctx.match[1]);
    await ctx.answerCbQuery("⏳ Memuat layanan...").catch(()=>{});
    
    const res = await callSmmApi('/services'); 
    
    let services = [];
    if (res.status === true && res.data) services = res.data;
    else if (Array.isArray(res)) services = res;
    else if (res.services) services = res.services;

    if (!services || services.length === 0) {
        return ctx.reply("❌ Gagal mengambil layanan. Cek Config API ID/Key.");
    }

    const categories = [...new Set(services.map(s => s.category))];
    const perPage = 5;
    const paginated = categories.slice(page * perPage, (page + 1) * perPage);

    const buttons = paginated.map((cat) => [
        Markup.button.callback(`📂 ${cat}`, `smm_cat_${categories.indexOf(cat)}_0`)
    ]);

    const nav = [];
    if (page > 0) nav.push(Markup.button.callback('⬅️ 𝗣𝗿𝗲𝘃', `smm_services_${page - 1}`));
    if ((page + 1) * perPage < categories.length) nav.push(Markup.button.callback('Next ➡️', `smm_services_${page + 1}`));
    if (nav.length > 0) buttons.push(nav);
    buttons.push([Markup.button.callback('🔙 ☇ 𝗞𝗲𝗺𝗯𝗮𝗹𝗶', 'smm_menu')]);

    await editMenuMessage(ctx, "<b>📂 𝗣𝗜𝗟𝗜𝗛 𝗞𝗔𝗧𝗘𝗚𝗢𝗥𝗜 𝗟𝗔𝗬𝗔𝗡𝗔𝗡 :</b>", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons }
    });
});

bot.action(/smm_cat_(\d+)_(\d+)/, async (ctx) => {
    const catIndex = parseInt(ctx.match[1]);
    const page = parseInt(ctx.match[2]);
    
    const res = await callSmmApi('/services');
    let services = res.data || res.services || (Array.isArray(res) ? res : []);
    
    const categories = [...new Set(services.map(s => s.category))];
    const targetCat = categories[catIndex];
    const filtered = services.filter(s => s.category === targetCat);
    
    const perPage = 5;
    const paginated = filtered.slice(page * perPage, (page + 1) * perPage);

    let text = `<b>📦 𝖪𝖠𝖳𝖤𝖦𝖮𝖱𝖨 : ${targetCat}</b>\n\n`;
    const buttons = paginated.map(s => {
        text += `🆔 <b>𝖨𝖣 : ${s.id}</b>\n🏷 ${s.name}\n💰 ${toRupiah(s.price)}/1000\nMin: ${s.min} | Max: ${s.max}\n\n`;
        return [Markup.button.callback(`𝖡𝖾𝗅𝗂 𝖨𝖣: ${s.id}`, `smm_buy_${s.id}`)];
    });

    const nav = [];
    if (page > 0) nav.push(Markup.button.callback('⬅️ 𝗣𝗿𝗲𝘃', `smm_cat_${catIndex}_${page - 1}`));
    if ((page + 1) * perPage < filtered.length) nav.push(Markup.button.callback('Next ➡️', `smm_cat_${catIndex}_${page + 1}`));
    if (nav.length > 0) buttons.push(nav);
    buttons.push([Markup.button.callback('🔙 ☇ 𝗞𝗲𝗺𝗯𝗮𝗹𝗶', `smm_services_0`)]);

    try { await ctx.deleteMessage(); } catch(e){}
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: { inline_keyboard: buttons } });
});

bot.action(/smm_buy_(\d+)/, async (ctx) => {
    const serviceId = ctx.match[1];
    userState[ctx.from.id] = { step: "SMM_WAITING_LINK", serviceId: serviceId };
    
    await editMenuMessage(ctx, 
        `🔗 <b>𝗦𝗜𝗟𝗔𝗛𝗞𝗔𝗡 𝗞𝗜𝗥𝗜𝗠 𝗟𝗜𝗡𝗞 𝗧𝗔𝗥𝗚𝗘𝗧</b>\n\n☘︎ Silakan kirim link/username target untuk layanan ID <b>${serviceId}</b>.\n\n<i>Ketik /batal untuk membatalkan.</i>`, 
        {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[Markup.button.callback('❌ ☇ 𝗕𝗮𝘁𝗮𝗹𝗸𝗮𝗻', 'smm_menu')]] }
        }
    );
});

bot.action("smm_history", async (ctx) => {
    const history = getSmmHistory(ctx.from.id);
    if (history.length === 0) return ctx.answerCbQuery("Belum ada riwayat.", { show_alert: true });

    let msg = "<b>📜 𝟱 𝗥𝗜𝗪𝗔𝗬𝗔𝗧 𝗧𝗘𝗥𝗔𝗞𝗛𝗜𝗥</b>\n\n";
    history.slice(0, 5).forEach(h => {
        msg += `🆔 <b>#${h.orderId}</b>\n📦 ${h.serviceName}\n💰 ${h.price}\n📅 ${h.date}\n\n`;
    });

    await editMenuMessage(ctx, msg, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[Markup.button.callback('🔙 ☇ Kembali', 'smm_menu')]] }
    });
});

bot.action("smm_check_status", (ctx) => {
    userState[ctx.from.id] = { step: "SMM_WAITING_STATUS_ID" };
    ctx.reply("🔍 <b>Kirim ID Pesanan :</b>", { 
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[Markup.button.callback('❌ ☇ Batal', 'smm_menu')]] } 
    });
});

bot.action("smm_exec_order", async (ctx) => {
    const userId = ctx.from.id;
    const pending = userState[userId]?.pendingOrder;

    if (!pending) {
        return ctx.answerCbQuery("❌ Sesi Habis, Ulangi Pesanan.", { show_alert: true });
    }

    const dbSaldoPath = "./database/saldoOtp.json";
    const saldoData = JSON.parse(fs.readFileSync(dbSaldoPath, "utf8") || "{}");
    const userSaldo = saldoData[userId] || 0;

    if (userSaldo < pending.price) {
        return ctx.answerCbQuery("❌ Saldo tidak cukup", { show_alert: true });
    }

    await ctx.editMessageText("⏳ <b>Memproses Pesanan...</b>", { parse_mode: "HTML" });

    const orderRes = await callSmmApi('/order', {
        service: pending.serviceId,
        target: pending.target,
        quantity: pending.quantity
    });

    if (orderRes.status === true) {
        saldoData[userId] = userSaldo - pending.price;
        fs.writeFileSync(dbSaldoPath, JSON.stringify(saldoData, null, 2));

        const orderId = orderRes.order;
        saveSmmHistory(userId, {
            orderId: orderId, 
            serviceName: pending.serviceName,
            price: toRupiah(pending.price),
            date: new Date().toLocaleString("id-ID")
        });

        await ctx.editMessageText(
            `✅ <b>𝗢𝗥𝗗𝗘𝗥 𝗦𝗨𝗞𝗦𝗘𝗦</b>\n` +
            `├⌑ 🆔 <b>𝖨𝖣 𝖮𝗋𝖽𝖾𝗋 :</b> <code>${orderId}</code>\n` +
            `├⌑ 📦 <b>𝖫𝖺𝗒𝖺𝗇𝖺𝗇 :</b> ${pending.serviceName}\n` +
            `├⌑ 💰 <b>𝖧𝖺𝗋𝗀𝖺 :</b> ${toRupiah(pending.price)}\n` +
            `└⌑ 📉 <b>𝖲𝗂𝗌𝖺 𝖲𝖺𝗅𝖽𝗈 :</b> ${toRupiah(saldoData[userId])}`,
            { 
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [[{ text: "🔙 ☇ Kembali ke Menu", callback_data: "smm_menu" }]] }
            }
        );
    } else {
        const errorMsg = orderRes.msg || "Gagal memproses order.";
        await ctx.editMessageText(
            `❌ <b>𝗢𝗥𝗗𝗘𝗥 𝗚𝗔𝗚𝗔𝗟</b>\n└⌑ Alasan: ${errorMsg}\n\n<i>Saldo tidak terpotong.</i>`,
            { 
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [[{ text: "🔙 𝗖𝗼𝗯𝗮 𝗟𝗮𝗴𝗶", callback_data: "smm_menu" }]] }
            }
        );
    }
    
    delete userState[userId];
});

bot.action("add_script", (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  userState[ctx.from.id] = { step: "WAITING_SCRIPT_FILE" };
  safeReply(ctx, `<blockquote><b>📥 CARA TAMBAH SCRIPT</b>\n\n<b>1. Silahkan kirim file *.zip* sekarang.</b>\n<b>2. Setelah file terkirim, bot akan meminta detail produk.</b></blockquote>`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Batal", "menu_owner")]]) }
  );
});

bot.action("add_app", (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  userState[ctx.from.id] = { step: "WAITING_APP_TEXT" };
  safeReply(ctx, "<blockquote><b>✏️ Kirim detail App Premium dengan format:</b>\n<code>Nama | Harga | Deskripsi</code>\n\n<b>Contoh:</b>\n<code>CANVA PRO | 3500 | Akses premium aktif</code></blockquote>", { parse_mode: "HTML" });
});

bot.action("del_script", (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  const db = readDb();
  if (db.scripts.length === 0) return ctx.editMessageText("Belum ada produk script.", Markup.inlineKeyboard([[Markup.button.callback("🔙 Kembali", "menu_owner")]]));

  const buttons = db.scripts.map((sc, i) => [Markup.button.callback(`❌ ${sc.nama}`, `delete_sc_${i}`)]);
  buttons.push([Markup.button.callback("🔙 Kembali", "menu_owner")]);
  ctx.editMessageText("<blockquote><b>🗑️ Pilih script yang mau dihapus:</b></blockquote>", { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) })
    .catch(() => {
      safeReply(ctx, "<blockquote><b>🗑️ Pilih script yang mau dihapus:</b></blockquote>", { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
    });
});

bot.action("del_app", (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  const db = readDb();
  if ((db.apps || []).length === 0) return ctx.editMessageText("Belum ada app.", Markup.inlineKeyboard([[Markup.button.callback("🔙 Kembali", "menu_owner")]]));

  const buttons = db.apps.map((a, i) => [Markup.button.callback(`❌ ${a.nama}`, `delete_app_${i}`)]);
  buttons.push([Markup.button.callback("🔙 Kembali", "menu_owner")]);
  ctx.editMessageText("<blockquote><b>🗑️ Pilih app yang mau dihapus:</b></blockquote>", { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
});

bot.action("list_apps", (ctx) => {
  const db = readDb();
  if ((db.apps || []).length === 0) return safeReply(ctx, "Tidak ada app.");
  const isOwner = ctx.from.id === config.ownerId;
  db.apps.forEach((x, i) => {
    const stock = (x.accounts || []).length;
    const text = `<blockquote><b>📱 ${x.nama}</b>\n<b>Harga:</b> ${toRupiah(x.harga)}\n<b>Stock:</b> ${stock}\n${x.deskripsi || ''}</blockquote>`;
    const buttons = [];
    if (isOwner) {
      buttons.push([ Markup.button.callback("📄 List Account", `list_accounts_${i}`) ]);
    }
    safeReply(ctx, text, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
  });
});

bot.action("buyvps_pay_qris", async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buyvps_pay_qris')) return;
  
  const userId = ctx.from.id;
  
  if (!userState[userId]?.vpsData) {
    return ctx.answerCbQuery("❌ Data VPS tidak ditemukan!", { show_alert: true });
  }

  const vpsData = userState[userId].vpsData;
  const nominal = vpsData.harga;
  const itemName = `VPS ${vpsData.paket.toUpperCase()} - ${vpsData.plan} - ${vpsData.region}`;

  await showPaymentWithVoucher(ctx, nominal, itemName, {
    type: "vps",
    vpsData: vpsData
  });
});

bot.action(/buy_sc_(\d+)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buy_sc')) return;
  
  const index = parseInt(ctx.match[1]);
  const db = readDb();
  const item = db.scripts[index];
  if (!item || !item.file_id) return safeReply(ctx, "Script tidak ditemukan/file hilang.");
  
  await showPaymentWithVoucher(ctx, item.harga, "Script: " + item.nama, {
    type: "script",
    index: index
  });
});

bot.action("buy_gmail_shop", async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buy_gmail_shop')) return;

  const db = readDb();
  const { app, idx } = getOrCreateGmailApp(db);
  const stock = (app.accounts || []).length;
  if (stock <= 0) {
    return ctx.answerCbQuery("❌ Stok Gmail sedang habis, coba lagi nanti.", { show_alert: true });
  }

  userState[ctx.from.id] = {
    step: "PURCHASE_APP",
    appIndex: idx,
    qty: 1,
    message: null
  };

  const base = parseInt(app.harga) || 0;
  const qty = 1;
  const total = calcTotalPrice(base, qty);
  const caption = renderPurchaseText(app, qty, total);
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [ 
          { text: "➖", callback_data: `app_qty_minus_${idx}` }, 
          { text: `${qty}`, callback_data: `app_qty_show_${idx}` }, 
          { text: "➕", callback_data: `app_qty_plus_${idx}` } 
        ],
        [ { text: "🛒 Buy Now", callback_data: `app_buy_now_${idx}` } ],
        [ { text: "📝 Tambah Catatan (opsional)", callback_data: `app_note_${idx}` } ],
        [ { text: "🔙 Batal", callback_data: "shop_menu" } ]
      ]
    }
  };

  await editMenuMessage(ctx, caption, {
    parse_mode: "HTML",
    ...keyboard
  });

  ctx.answerCbQuery().catch(()=>{});
});

bot.action("buy_notel_shop", async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buy_notel_shop')) return;

  const db = readDb();
  const { app, idx } = getOrCreateNotelApp(db);
  const stock = (app.accounts || []).length;
  if (stock <= 0) {
    return ctx.answerCbQuery("❌ Stok Notel sedang habis, coba lagi nanti.", { show_alert: true });
  }

  userState[ctx.from.id] = {
    step: "PURCHASE_APP",
    appIndex: idx,
    qty: 1,
    message: null
  };

  const base = parseInt(app.harga) || 0;
  const qty = 1;
  const total = calcTotalPrice(base, qty);
  const caption = renderPurchaseText(app, qty, total);
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [ 
          { text: "➖", callback_data: `app_qty_minus_${idx}` }, 
          { text: `${qty}`, callback_data: `app_qty_show_${idx}` }, 
          { text: "➕", callback_data: `app_qty_plus_${idx}` } 
        ],
        [ { text: "🛒 Buy Now", callback_data: `app_buy_now_${idx}` } ],
        [ { text: "📝 Tambah Catatan (opsional)", callback_data: `app_note_${idx}` } ],
        [ { text: "🔙 Batal", callback_data: "shop_menu" } ]
      ]
    }
  };

  await editMenuMessage(ctx, caption, {
    parse_mode: "HTML",
    ...keyboard
  });

  ctx.answerCbQuery().catch(()=>{});
});

bot.action(/buy_app_(\d+)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'buy_app')) return;
  
  const idx = parseInt(ctx.match[1]);
  const db = readDb();
  const app = db.apps[idx];
  if (!app) return ctx.answerCbQuery("❌ App tidak ditemukan.");
  const stock = (app.accounts || []).length;
  if (stock <= 0) {
    const already = isInWishlist(app.nama, ctx.from.id);
    await ctx.answerCbQuery();
    return safeReply(
      ctx,
      `<blockquote>❌ <b>${app.nama}</b> lagi habis stok.\n\n${already ? "🔔 Kamu sudah terdaftar, nanti otomatis di-DM begitu restock." : "Mau di-notif otomatis kalau sudah restock?"}</blockquote>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: already
            ? [[{ text: "🔙 Kembali", callback_data: "menu_apps" }]]
            : [
                [{ text: "🔔 Notifikasi Saya Kalau Restock", callback_data: `wishlist_add_${idx}` }],
                [{ text: "🔙 Kembali", callback_data: "menu_apps" }],
              ],
        },
      }
    );
  }

  userState[ctx.from.id] = {
    step: "PURCHASE_APP",
    appIndex: idx,
    qty: 1,
    message: null
  };

  const base = parseInt(app.harga) || 0;
  const qty = 1;
  const total = calcTotalPrice(base, qty);
  const caption = renderPurchaseText(app, qty, total);
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [ 
          { text: "➖", callback_data: `app_qty_minus_${idx}` }, 
          { text: `${qty}`, callback_data: `app_qty_show_${idx}` }, 
          { text: "➕", callback_data: `app_qty_plus_${idx}` } 
        ],
        [ { text: "🛒 Buy Now", callback_data: `app_buy_now_${idx}` } ],
        [ { text: "📝 Tambah Catatan (opsional)", callback_data: `app_note_${idx}` } ],
        [ { text: "🔙 Batal", callback_data: "menu_apps" } ]
      ]
    }
  };

  await editMenuMessage(ctx, caption, {
    parse_mode: "HTML",
    ...keyboard
  });
  
  ctx.answerCbQuery().catch(()=>{});
});

bot.action(/wishlist_add_(\d+)/, async (ctx) => {
  const idx = parseInt(ctx.match[1]);
  const db = readDb();
  const app = db.apps[idx];
  if (!app) return ctx.answerCbQuery("❌ Produk tidak ditemukan.", { show_alert: true });

  addToWishlist(app.nama, ctx.from.id);
  await ctx.answerCbQuery("🔔 Kamu akan di-DM otomatis kalau restock!", { show_alert: true });
  await editMenuMessage(ctx, `<blockquote>🔔 <b>Terdaftar!</b>\n\nKamu akan otomatis di-DM begitu <b>${app.nama}</b> restock.</blockquote>`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "🔙 Kembali ke Katalog", callback_data: "menu_apps" }]] },
  });
});

bot.action(/app_note_(\d+)/, async (ctx) => {
  const idx = parseInt(ctx.match[1]);
  const uid = ctx.from.id;
  const st = userState[uid];
  if (!st || st.appIndex !== idx) return ctx.answerCbQuery("❌ Sesi order sudah kedaluwarsa, ulangi dari katalog.", { show_alert: true });

  userState[uid] = { ...st, step: "WAITING_APP_NOTE", returnStep: st.step };
  await ctx.answerCbQuery();
  await safeReply(ctx, "<blockquote>📝 Ketik catatan tambahan buat order ini (contoh: kirim ke email beda, dll). Ketik <b>skip</b> buat batal.</blockquote>", { parse_mode: "HTML" });
});

bot.on("text", async (ctx, next) => {
  const uid = ctx.from.id;
  const st = userState[uid];
  if (!st || st.step !== "WAITING_APP_NOTE") return next();

  const text = ctx.message.text.trim();
  const note = text.toLowerCase() === "skip" ? null : text;
  userState[uid] = { ...st, step: st.returnStep || "PURCHASE_APP", note };
  delete userState[uid].returnStep;

  await safeReply(
    ctx,
    note
      ? `<blockquote>✅ Catatan disimpan: <i>${note}</i>\n\nLanjut tap <b>🛒 Buy Now</b> di kartu produk buat checkout.</blockquote>`
      : "<blockquote>❌ Catatan dibatalkan. Lanjut tap 🛒 Buy Now buat checkout tanpa catatan.</blockquote>",
    { parse_mode: "HTML" }
  );
});

bot.action(/app_qty_minus_(\d+)/, async (ctx) => {
  const uid = ctx.from.id;
  const idx = parseInt(ctx.match[1]);
  if (!userState[uid] || userState[uid].step !== "PURCHASE_APP" || userState[uid].appIndex !== idx) {
    userState[uid] = { step: "PURCHASE_APP", appIndex: idx, qty: 1, message: null };
  }
  const db = readDb();
  const app = db.apps[idx];
  if (!app) {
    ctx.answerCbQuery("❌ App tidak ditemukan.");
    return;
  }
  userState[uid].qty = Math.max(1, (userState[uid].qty || 1) - 1);
  const qty = userState[uid].qty;
  const base = parseInt(app.harga) || 0;
  const stock = (app.accounts || []).length;
  if (qty > stock) userState[uid].qty = stock;
  const total = calcTotalPrice(base, userState[uid].qty);
  const caption = renderPurchaseText(app, userState[uid].qty, total);

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [ 
          { text: "➖", callback_data: `app_qty_minus_${idx}` }, 
          { text: `${userState[uid].qty}`, callback_data: `app_qty_show_${idx}` }, 
          { text: "➕", callback_data: `app_qty_plus_${idx}` } 
        ],
        [ { text: "🛒 Buy Now", callback_data: `app_buy_now_${idx}` } ],
        [ { text: "📝 Tambah Catatan (opsional)", callback_data: `app_note_${idx}` } ],
        [ { text: "🔙 Batal", callback_data: "back_home" } ]
      ]
    }
  };

  await editMenuMessage(ctx, caption, {
    parse_mode: "HTML",
    ...keyboard
  });
  
  ctx.answerCbQuery().catch(()=>{});
});

bot.action(/app_qty_plus_(\d+)/, async (ctx) => {
  const uid = ctx.from.id;
  const idx = parseInt(ctx.match[1]);
  if (!userState[uid] || userState[uid].step !== "PURCHASE_APP" || userState[uid].appIndex !== idx) {
    userState[uid] = { step: "PURCHASE_APP", appIndex: idx, qty: 1, message: null };
  }
  const db = readDb();
  const app = db.apps[idx];
  if (!app) {
    ctx.answerCbQuery("❌ App tidak ditemukan.");
    return;
  }
  const stock = (app.accounts || []).length;
  userState[uid].qty = (userState[uid].qty || 1) + 1;
  if (userState[uid].qty > stock) userState[uid].qty = stock;
  const total = calcTotalPrice(parseInt(app.harga) || 0, userState[uid].qty);
  const caption = renderPurchaseText(app, userState[uid].qty, total);

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [ 
          { text: "➖", callback_data: `app_qty_minus_${idx}` }, 
          { text: `${userState[uid].qty}`, callback_data: `app_qty_show_${idx}` }, 
          { text: "➕", callback_data: `app_qty_plus_${idx}` } 
        ],
        [ { text: "🛒 Buy Now", callback_data: `app_buy_now_${idx}` } ],
        [ { text: "📝 Tambah Catatan (opsional)", callback_data: `app_note_${idx}` } ],
        [ { text: "🔙 Batal", callback_data: "back_home" } ]
      ]
    }
  };

  await editMenuMessage(ctx, caption, {
    parse_mode: "HTML",
    ...keyboard
  });
  
  ctx.answerCbQuery().catch(()=>{});
});

bot.action(/app_qty_show_(\d+)/, (ctx) => {
  ctx.answerCbQuery().catch(()=>{});
});

bot.action(/app_buy_now_(\d+)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'app_buy_now')) return;
  
  const uid = ctx.from.id;
  const idx = parseInt(ctx.match[1]);
  const db = readDb();
  const app = db.apps[idx];
  if (!app) return ctx.answerCbQuery("❌ App tidak ditemukan.");
  
  const st = userState[uid];
  if (!st || st.step !== "PURCHASE_APP" || st.appIndex !== idx) {
    userState[uid] = { step: "PURCHASE_APP", appIndex: idx, qty: 1, message: null };
  }
  
  const qty = Math.max(1, userState[uid].qty || 1);
  const total = calcTotalPrice(parseInt(app.harga) || 0, qty);
  const note = userState[uid].note || null;
  
  await showPaymentWithVoucher(ctx, total, `App: ${app.nama} x${qty}`, {
    type: "app",
    idx: idx,
    qty: qty,
    total: total,
    note: note
  });
  
  ctx.answerCbQuery().catch(()=>{});
});

bot.action(/pay_panel_(\d+)_(\d+)_(.+)/, async (ctx) => {
  if (!await requirePrivateChat(ctx, 'pay_panel')) return;
  
  const ram = parseInt(ctx.match[1]);
  const price = parseInt(ctx.match[2]);
  const username = ctx.match[3];

  await showPaymentWithVoucher(ctx, price, `Panel ${ram === 0 ? "Unlimited" : ram/1024 + "GB"}`, {
    type: "panel",
    username: username,
    ram: ram,
    price: price
  });
});

bot.on('audio', async (ctx) => {
  console.log('Audio File ID:', ctx.message.audio.file_id);
  console.log('Audio Metadata:', {
    title: ctx.message.audio.title,
    performer: ctx.message.audio.performer,
    duration: ctx.message.audio.duration
  });
});

bot.on("text", async (ctx, next) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  if (["📁 ☇ 𝗦𝗰𝗿𝗶𝗽𝘁", "📱 ☇ 𝗔𝗽𝗽𝘀", "📡 ☇ 𝗣𝗮𝗻𝗲𝗹", "🛠 ☇ 𝗧𝗼𝗼𝗹𝘀", "🌸 ☇ 𝗢𝘄𝗻𝗲𝗿"].includes(text)) {
    return next();
  }
  if (userState[userId]?.step === "WAITING_VOUCHER_VALUE") {
    const value = parseInt(text);
    
    if (isNaN(value) || value <= 0) {
      return safeReply(ctx, "<blockquote>❌ Nilai harus angka positif!</blockquote>", { parse_mode: "HTML" });
    }
    
    if (userState[userId].voucherData?.type === 'percentage' && value > 100) {
      return safeReply(ctx, "<blockquote>❌ Persentase maksimal 100%!</blockquote>", { parse_mode: "HTML" });
    }
    
    userState[userId].voucherData.value = value;
    userState[userId].step = "WAITING_VOUCHER_MAX_USES";
    
    return safeReply(ctx, 
      `<blockquote><b>🔢 MASUKKAN MAKSIMAL PENGGUNAAN</b>\n\nBerapa kali voucher bisa digunakan?\nContoh: 10 (untuk 10x penggunaan)\n-1 untuk unlimited</blockquote>`,
      { 
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "♾ Unlimited", callback_data: "voucher_max_uses:-1" }]]
        }
      }
    );
  }

  // Handler untuk input maksimal penggunaan voucher (owner)
  if (userState[userId]?.step === "WAITING_VOUCHER_MAX_USES") {
    let maxUses = -1;
    
    if (text.toLowerCase() === 'unlimited') {
      maxUses = -1;
    } else {
      maxUses = parseInt(text);
    }
    
    if (isNaN(maxUses) || maxUses === 0) {
      return safeReply(ctx, "<blockquote>❌ Masukkan angka yang valid! (-1 untuk unlimited)</blockquote>", { parse_mode: "HTML" });
    }
    
    userState[userId].voucherData.maxUses = maxUses;
    userState[userId].step = "WAITING_VOUCHER_EXPIRY";
    
    return safeReply(ctx,
      `<blockquote><b>📅 TANGGAL KADALUARSA (Opsional)</b>\n\nFormat: DD-MM-YYYY\nContoh: 31-12-2024\n\nAtau kirim "tidak" untuk tanpa kadaluarsa</blockquote>`,
      { 
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "⏳ Tanpa Kadaluarsa", callback_data: "voucher_no_expiry" }]]
        }
      }
    );
  }

if (userState[userId]?.step === "WAITING_VOUCHER_EXPIRY") {
  let expiresAt = null;
  
  if (text.toLowerCase() !== 'tidak' && text.trim() !== '') {
    const dateParts = text.split('-');
    if (dateParts.length === 3) {
      const day = parseInt(dateParts[0]);
      const month = parseInt(dateParts[1]) - 1;
      const year = parseInt(dateParts[2]);
      
      const expiryDate = new Date(year, month, day, 23, 59, 59);
      expiresAt = expiryDate.getTime();
      
      if (isNaN(expiresAt) || expiryDate <= new Date()) {
        return safeReply(ctx, "<blockquote>❌ Tanggal tidak valid atau sudah lewat!</blockquote>", { parse_mode: "HTML" });
      }
    } else {
      return safeReply(ctx, "<blockquote>❌ Format tanggal salah! Gunakan: DD-MM-YYYY</blockquote>", { parse_mode: "HTML" });
    }
  }
  
  userState[userId].voucherData.expiresAt = expiresAt;
  
  // Buat voucher
  const voucherData = userState[userId].voucherData;
  const voucher = await createVoucher(
    voucherData.type,
    voucherData.value,
    voucherData.maxUses,
    expiresAt ? new Date(expiresAt).toISOString() : null
  );
  
  if (voucher) {
    delete userState[userId];
    
    let voucherDetails = `<b>✅ VOUCHER BERHASIL DIBUAT!</b>\n\n`;
    voucherDetails += `<b>Kode:</b> <code>${voucher.code}</code>\n`;
    voucherDetails += `<b>Tipe:</b> ${voucher.type === 'percentage' ? 'Percentage' : 'Fixed'}\n`;
    voucherDetails += `<b>Nilai:</b> ${voucher.type === 'percentage' ? `${voucher.value}%` : toRupiah(voucher.value)}\n`;
    voucherDetails += `<b>Maks. Penggunaan:</b> ${voucher.maxUses === -1 ? 'Unlimited' : `${voucher.maxUses}x`}\n`;
    if (voucher.expiresAt) {
      voucherDetails += `<b>Kadaluarsa:</b> ${new Date(voucher.expiresAt).toLocaleString('id-ID')}\n`;
    } else {
      voucherDetails += `<b>Kadaluarsa:</b> Tidak ada\n`;
    }
    voucherDetails += `<b>Status:</b> ${voucher.isActive ? '🟢 Aktif' : '🔴 Nonaktif'}\n\n`;
    
    // Tambahkan info notifikasi
    voucherDetails += `<b>📢 NOTIFIKASI:</b>\n`;
    voucherDetails += `├ Channel: ${config.testimoniChannel ? '✅ Akan dikirim' : '❌ Belum diatur'}\n`;
    voucherDetails += `└ Owner: ✅ Akan dikirim\n\n`;
    voucherDetails += `<i>Notifikasi akan dikirim dalam beberapa detik...</i>`;
    
    await safeReply(ctx, voucherDetails, { 
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📤 Broadcast ke Semua User", callback_data: `broadcast_voucher_${voucher.id}` }],
          [{ text: "🔙 Kembali", callback_data: "manage_vouchers" }]
        ]
      }
    });
  } else {
    await safeReply(ctx, "<blockquote>❌ Gagal membuat voucher!</blockquote>", { parse_mode: "HTML" });
  }
  
  return;
}
  // Handler untuk input kode voucher (user - payment)
  if (userState[userId]?.step === "WAITING_VOUCHER_CODE_INPUT") {
    const voucherCode = text.trim().toUpperCase();
    
    if (!userState[userId].paymentData) {
      delete userState[userId];
      return safeReply(ctx, "<blockquote>❌ Data pembayaran tidak ditemukan. Silakan ulangi transaksi.</blockquote>", { parse_mode: "HTML" });
    }
    
    const paymentData = userState[userId].paymentData;
    
    // Validasi voucher
    const voucherInfo = validateVoucher(voucherCode, paymentData.nominal);
    
    if (voucherInfo.valid) {
      // Simpan info voucher
      userState[userId].voucherInfo = voucherInfo;
      userState[userId].step = "VOUCHER_APPLIED";
      
      // Tampilkan ringkasan dengan diskon
      const summary = `
<b>✅ VOUCHER DITERIMA!</b>
━━━━━━━━━━━━━━━━━━━━━━

<b>Item:</b> ${paymentData.itemName}
<b>Harga Awal:</b> ${toRupiah(paymentData.nominal)}
<b>Diskon:</b> -${toRupiah(voucherInfo.discount)}
━━━━━━━━━━━━━━━━━━━━━━
<b>TOTAL BAYAR:</b> ${toRupiah(voucherInfo.finalPrice)}
━━━━━━━━━━━━━━━━━━━━━━
<b>Kode Voucher:</b> <code>${voucherCode}</code>
━━━━━━━━━━━━━━━━━━━━━━
<i>Lanjutkan pembayaran?</i>
      `.trim();
      
      await editMenuMessage(ctx, summary, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "💰 Lanjutkan Pembayaran", callback_data: "continue_with_voucher" }],
            [{ text: "🔙 Ganti Voucher", callback_data: "back_to_voucher_input" }]
          ]
        }
      });
    } else {
      await safeReply(ctx, `${voucherInfo.message}\n\n<b>Silakan coba kode voucher lain atau lanjutkan tanpa voucher.</b>`, { 
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Coba Kode Lain", callback_data: `use_voucher_payment` }],
            [{ text: "🚫 Tanpa Voucher", callback_data: `skip_voucher_${paymentData.nominal}` }]
          ]
        }
      });
    }
    
    return;
  }

  // Handler untuk cek voucher (user - menu voucher)
  if (userState[userId]?.step === "WAITING_CHECK_VOUCHER") {
    const voucherCode = text.trim().toUpperCase();
    
    if (voucherCode.length < 3) {
      return safeReply(ctx, "<blockquote>❌ Kode voucher terlalu pendek!</blockquote>", { parse_mode: "HTML" });
    }
    
    const voucherInfo = validateVoucher(voucherCode, 10000); // Contoh nominal 10.000
    
    if (voucherInfo.valid) {
      await editMenuMessage(ctx,
        `<b>✅ VOUCHER VALID!</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n<b>Kode:</b> <code>${voucherCode}</code>\n<b>Tipe:</b> ${voucherInfo.voucher.type === 'percentage' ? `${voucherInfo.voucher.value}%` : `Rp ${voucherInfo.voucher.value.toLocaleString()}`}\n<b>Sisa penggunaan:</b> ${voucherInfo.voucher.maxUses === -1 ? 'Unlimited' : voucherInfo.voucher.maxUses - voucherInfo.voucher.usedCount}\n\n<b>💡 Tips:</b> Gunakan voucher saat checkout produk!`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🛒 Beli Sekarang", callback_data: "menu_katalog" }],
              [{ text: "🔙 Kembali", callback_data: "menu_voucher" }]
            ]
          }
        }
      );
    } else {
      await editMenuMessage(ctx,
        `<b>❌ VOUCHER TIDAK VALID</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n${voucherInfo.message}\n\n<b>Kode yang dimasukkan:</b> <code>${voucherCode}</code>\n\n<b>💡 Tips:</b> Pastikan kode voucher benar dan belum kadaluarsa.`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Coba Lagi", callback_data: "check_voucher_input" }],
              [{ text: "🔙 Kembali", callback_data: "menu_voucher" }]
            ]
          }
        }
      );
    }
    
    delete userState[userId];
    return;
  }
  
  if (userState[userId]?.step === "WAITING_VOUCHER_CODE_DELETE") {
  const voucherCode = text.trim().toUpperCase();
  
  if (voucherCode.length < 3) {
    return safeReply(ctx, "<blockquote>❌ Kode voucher terlalu pendek!</blockquote>", { parse_mode: "HTML" });
  }
  
  // Cari voucher dengan kode tersebut
  const vouchers = readVouchers();
  const voucher = vouchers.find(v => v.code === voucherCode);
  
  if (!voucher) {
    await editMenuMessage(ctx,
      `<b>❌ VOUCHER TIDAK DITEMUKAN</b>\n\nTidak ada voucher dengan kode: <code>${voucherCode}</code>\n\nSilakan coba dengan kode yang lain.`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Coba Lagi", callback_data: "delete_voucher_by_code" }],
            [{ text: "🔙 Kembali", callback_data: "delete_voucher_menu" }]
          ]
        }
      }
    );
    
    delete userState[userId];
    return;
  }
  
  // Tampilkan konfirmasi
  const message = `
<b>🗑️ KONFIRMASI HAPUS VOUCHER</b>
━━━━━━━━━━━━━━━━━━━━━━

<b>Kode Voucher:</b> <code>${voucher.code}</code>
<b>Tipe:</b> ${voucher.type === 'percentage' ? 'Percentage' : 'Fixed'}
<b>Nilai:</b> ${voucher.type === 'percentage' ? `${voucher.value}%` : toRupiah(voucher.value)}
<b>Digunakan:</b> ${voucher.usedCount}/${voucher.maxUses === -1 ? 'Unlimited' : voucher.maxUses}
<b>Status:</b> ${voucher.isActive ? '🟢 Aktif' : '🔴 Nonaktif'}
<b>Dibuat:</b> ${new Date(voucher.createdAt).toLocaleString('id-ID')}
${voucher.expiresAt ? `<b>Kadaluarsa:</b> ${new Date(voucher.expiresAt).toLocaleString('id-ID')}` : ''}

<b>⚠️ PERINGATAN:</b>
Voucher akan dihapus secara permanen!
Aksi ini tidak dapat dibatalkan!
  `.trim();
  
  await editMenuMessage(ctx, message, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Ya, Hapus Voucher", callback_data: `execute_delete_bycode_${voucher.code}` }],
        [{ text: "❌ Batal", callback_data: "delete_voucher_menu" }]
      ]
    }
  });
  
  delete userState[userId];
  return;
}

if (userState[userId]?.step === "WAITING_DO_APIKEY") {
  const apiKey = text.trim();
  
  // Validasi format API key
  if (!apiKey.startsWith("dop_v1_") && !apiKey.startsWith("dopv1_")) {
    delete userState[userId];
    return safeReply(ctx, `<blockquote>❌ <b>FORMAT API KEY SALAH!</b>\n\nAPI key DigitalOcean harus dimulai dengan:\n<code>dop_v1_</code> atau <code>dopv1_</code>\n\nSilakan coba lagi.</blockquote>`, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Kembali", callback_data: "update_do_api" }]
        ]
      }
    });
  }
  
  if (apiKey.length < 64) {
    delete userState[userId];
    return safeReply(ctx, `<blockquote>❌ <b>API KEY TERLALU PENDEK!</b>\n\nAPI key DigitalOcean biasanya 64 karakter atau lebih.\n\nSilakan cek kembali API key Anda.</blockquote>`, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Kembali", callback_data: "update_do_api" }]
        ]
      }
    });
  }
  
  // Test API key sebelum menyimpan
  const loadingMsg = await safeReply(ctx, "<blockquote>🔍 <b>Menguji API key yang baru...</b></blockquote>", {
    parse_mode: "HTML"
  });
  
  try {
    const status = await checkDigitalOceanAccountStatus(apiKey);
    
    if (loadingMsg) {
      try {
        await ctx.deleteMessage(loadingMsg.message_id);
      } catch (e) {}
    }
    
    if (!status.success) {
      delete userState[userId];
      return safeReply(ctx, `<blockquote>❌ <b>API KEY TIDAK VALID!</b>\n\n<b>Error:</b> ${status.message}\n\nSilakan cek API key Anda dan coba lagi.</blockquote>`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 Kembali", callback_data: "update_do_api" }]
          ]
        }
      });
    }
    
    // API key valid, simpan ke config
    try {
      // Baca config.js
      const configPath = path.join(__dirname, "config.js");
      let configContent = fs.readFileSync(configPath, "utf8");
      
      // Cari dan replace ApiDO1
      const oldApiKey = config.ApiDO1 || "-";
      
      if (oldApiKey !== "-") {
        // Ganti API key yang lama
        configContent = configContent.replace(
          new RegExp(`ApiDO1:\\s*["']${escapeRegExp(oldApiKey)}["']`, "g"),
          `ApiDO1: "${apiKey}"`
        );
        
        // Jika tidak ketemu, coba format lain
        if (configContent.indexOf(`ApiDO1: "${apiKey}"`) === -1) {
          configContent = configContent.replace(
            /ApiDO1:\s*["'][^"']*["']/,
            `ApiDO1: "${apiKey}"`
          );
        }
      } else {
        // Jika ApiDO1 belum ada, tambahkan
        if (configContent.indexOf("ApiDO1:") === -1) {
          // Cari tempat yang tepat untuk menambahkan
          const lines = configContent.split('\n');
          let insertIndex = -1;
          
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes("module.exports") || lines[i].includes("exports")) {
              insertIndex = i - 1;
              break;
            }
          }
          
          if (insertIndex !== -1) {
            lines.splice(insertIndex, 0, `  ApiDO1: "${apiKey}",`);
            configContent = lines.join('\n');
          }
        }
      }
      
      // Tulis kembali ke file
      fs.writeFileSync(configPath, configContent, "utf8");
      
      // Update config object langsung
      config.ApiDO1 = apiKey;
      
      const acc = status.account;
      const successMessage = `<b>✅ API KEY BERHASIL DISIMPAN!</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      successMessage += `<b>🔹 AKUN DIGITALOCEAN</b>\n`;
      successMessage += `<code>   📧 Email:</code> ${acc.email}\n`;
      successMessage += `<code>   🟢 Status:</code> ${acc.statusEmoji} ${acc.status}\n`;
      successMessage += `<code>   📊 Droplets:</code> ${acc.totalDroplets}\n`;
      successMessage += `<code>   ✅ Available:</code> ${acc.availableDroplets}\n\n`;
      successMessage += `<i>✅ API key berhasil disimpan dan valid.</i>`;
      
      delete userState[userId];
      
      await safeReply(ctx, successMessage, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🌐 Cek Status", callback_data: "check_do_status" },
              { text: "🔙 Menu Owner", callback_data: "menu_owner" }
            ]
          ]
        }
      });
      
    } catch (configError) {
      console.error("Error saving config:", configError);
      delete userState[userId];
      safeReply(ctx, `<blockquote>❌ <b>GAGAL MENYIMPAN KONFIGURASI!</b>\n\n${configError.message}</blockquote>`, {
        parse_mode: "HTML"
      });
    }
    
  } catch (error) {
    if (loadingMsg) {
      try {
        await ctx.deleteMessage(loadingMsg.message_id);
      } catch (e) {}
    }
    
    delete userState[userId];
    safeReply(ctx, `<blockquote>❌ <b>ERROR TESTING API KEY:</b>\n\n${error.message}</blockquote>`, {
      parse_mode: "HTML"
    });
  }
  
  return;
}
  
    if (userState[userId]?.step === "SMM_WAITING_LINK") {
    if (ctx.chat.type !== 'private') return next();

    const link = text;
    userState[userId].link = link;
    userState[userId].step = "SMM_WAITING_QTY";
    
    return ctx.reply("🔢 <b>𝗠𝗔𝗦𝗨𝗞𝗔𝗡 𝗝𝗨𝗠𝗟𝗔𝗛 :</b>\n\n└⌑ 𝖤𝗑𝖺𝗆𝗉𝗅𝖾 : 𝟣𝟢𝟢𝟢", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[Markup.button.callback('❌ 𝗕𝗮𝘁𝗮𝗹𝗸𝗮𝗻', 'smm_menu')]] }
    });
  }

  if (userState[userId]?.step === "SMM_WAITING_QTY" && ctx.chat.type === 'private') {
    const qty = parseInt(text);

    if (isNaN(qty) || qty <= 0) {
        return ctx.reply("❌ <b>𝗛𝗮𝗿𝘂𝘀 𝗕𝗲𝗿𝘂𝗽𝗮 𝗔𝗻𝗴𝗸𝗮</b>\n\n└⌑ 𝖲𝗂𝗅𝖺𝗁𝗄𝖺𝗇 𝖬𝖺𝗌𝗎𝗄𝖺𝗇 𝖩𝗎𝗆𝗅𝖺𝗁 𝖸𝖺𝗇𝗀 𝖵𝖺𝗅𝗂𝖽 (𝖤𝗑𝖺𝗆𝗉𝗅𝖾: 𝟣𝟢𝟢𝟢).", {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "❌ Batalkan", callback_data: "smm_menu" }]] }
        });
    }

    const state = userState[userId];
    
    const res = await callSmmApi('/services');
    let services = res.services || res.data || [];
    const service = services.find(s => s.id == state.serviceId);
    
    if (!service) {
        delete userState[userId];
        return ctx.reply("❌ 𝗟𝗮𝘆𝗮𝗻𝗮𝗻 𝗧𝗶𝗱𝗮𝗸 𝗗𝗶𝘁𝗲𝗺𝘂𝗸𝗮𝗻/𝗕𝗲𝗿𝘂𝗯𝗮𝗵.");
    }

    if (qty < service.min || qty > service.max) {
        return ctx.reply(`❌ <b>𝗝𝘂𝗺𝗹𝗮𝗵 𝗧𝗶𝗱𝗮𝗸 𝗦𝗲𝘀𝘂𝗮𝗶</b>\n├⌑𝖬𝗂𝗇 : ${service.min}\n└⌑ 𝖬𝖺𝗑 : ${service.max}`, { parse_mode: "HTML" });
    }

    const totalPrice = (parseFloat(service.price) / 1000) * qty;
    
    const dbSaldoPath = "./database/saldoOtp.json";
    const saldoData = JSON.parse(fs.readFileSync(dbSaldoPath, "utf8") || "{}");
    const userSaldo = saldoData[userId] || 0;

    if (userSaldo < totalPrice) {
        delete userState[userId];
        return ctx.reply(`<blockquote>❌ <b>𝗦𝗔𝗟𝗗𝗢 𝗧𝗜𝗗𝗔𝗞 𝗖𝗨𝗞𝗨𝗣!</b>\n\n╭⌑ 💰 𝖡𝗎𝗍𝗎𝗁 : ${toRupiah(totalPrice)}\n├⌑ 💳 𝖲𝖺𝗅𝖽𝗈 𝖪𝖺𝗆𝗎 : ${toRupiah(userSaldo)}\n\n╰⌑ 🍂 𝖲𝗂𝗅𝖺𝗁𝗄𝖺𝗇 𝖣𝖾𝗉𝗈𝗌𝗂𝗍 𝖳𝖾𝗅𝖾𝖻𝗂𝗁 𝖣𝖺𝗁𝗎𝗅𝗎.</blockquote>`, { 
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[Markup.button.callback('➕ 𝗜𝘀𝗶 𝗦𝗮𝗹𝗱𝗼', 'topup_nokos')]] }
        });
    }

    userState[userId].pendingOrder = {
        serviceId: state.serviceId,
        serviceName: service.name,
        target: state.link,
        quantity: qty,
        price: totalPrice
    };

    await ctx.reply(
        `🚀 <b>𝗞𝗢𝗡𝗙𝗜𝗥𝗠𝗔𝗦𝗜 𝗣𝗘𝗦𝗔𝗡𝗔𝗡</b>\n\n` +
        `├⌑ 📦 <b>𝖫𝖺𝗒𝖺𝗇𝖺𝗇 :</b> ${service.name}\n` +
        `├⌑ 🔗 <b>𝖳𝖺𝗋𝗀𝖾𝗍 :</b> ${state.link}\n` +
        `├⌑ 🔢 <b>𝖩𝗎𝗆𝗅𝖺𝗁 :</b> ${qty}\n` +
        `└⌑ 💰 <b>𝖳𝗈𝗍𝖺𝗅 𝖧𝖺𝗋𝗀𝖺 :</b> ${toRupiah(totalPrice)}\n\n` +
        `<i>📝 𝖭𝗈𝗍𝖾 : 𝖲𝗂𝗅𝖺𝗁𝗄𝖺𝗇 𝖯𝖺𝗌𝗍𝗂𝗄𝖺𝗇 𝖯𝖾𝗌𝖺𝗇𝖺𝗇 𝖡𝖾𝗇𝖺𝗋 𝖲𝖾𝖻𝖾𝗅𝗎𝗆 𝖫𝖺𝗇𝗃𝗎𝗍!</i>`,
        {
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "✅ 𝗞𝗼𝗻𝗳𝗶𝗿𝗺𝗮𝘀𝗶 𝗢𝗿𝗱𝗲𝗿", callback_data: "smm_exec_order" }],
                    [{ text: "❌ 𝗕𝗮𝘁𝗮𝗹𝗸𝗮𝗻", callback_data: "smm_menu" }]
                ]
            }
        }
    );
    return;
  }

  if (userState[userId]?.step === "SMM_WAITING_STATUS_ID") {
      if (ctx.chat.type !== 'private') return next();

      const orderId = text;
      const res = await callSmmApi('/status', { id: orderId });
      
      if (res.status === true) {
          ctx.reply(`📊 <b>𝗦𝗧𝗔𝗧𝗨𝗦 𝗢𝗥𝗗𝗘𝗥 #${orderId}</b>\n├⌑ 𝖲𝗍𝖺𝗍𝗎𝗌 :<b>${res.data?.status || res.order_status}</b>\n├⌑ 𝖲𝗍𝖺𝗋𝗍 : ${res.data?.start_count || '-'}\n└⌑ 𝖲𝗂𝗌𝖺 : ${res.data?.remains || '-'}`, { parse_mode: "HTML" });
      } else {
          ctx.reply("❌ 𝗗𝗮𝘁𝗮 𝗧𝗶𝗱𝗮𝗸 𝗗𝗶𝘁𝗲𝗺𝘂𝗸𝗮𝗻/𝗘𝗿𝗿𝗼𝗿.", { parse_mode: "HTML" });
      }
      delete userState[userId];
      return;
  }
  
  if (userState[userId]?.step === "PTERO_CREATEADMIN_USERNAME") {
    if (ctx.from.id !== config.ownerId) { delete userState[userId]; return; }
    const username = text.trim();
    delete userState[userId];
    if (!username) {
      return safeReply(ctx, "<blockquote>❌ <b>Username tidak boleh kosong!</b></blockquote>", { parse_mode: "HTML" });
    }
    await runPteroAction(ctx, "ptero-createadmin", { username }, `➕ Buat Admin "${username}"`);
    return;
  }

  if (userState[userId]?.step === "PTERO_DELPANEL_ID") {
    if (ctx.from.id !== config.ownerId) { delete userState[userId]; return; }
    const id = text.trim();
    delete userState[userId];
    if (!id) {
      return safeReply(ctx, "<blockquote>❌ <b>ID tidak boleh kosong!</b></blockquote>", { parse_mode: "HTML" });
    }
    await runPteroAction(ctx, "ptero-delpanel", { id }, `🗑️ Hapus Panel "${id}"`);
    return;
  }

  if (userState[userId]?.step === "PTERO_DELADMIN_ID") {
    if (ctx.from.id !== config.ownerId) { delete userState[userId]; return; }
    const id = text.trim();
    delete userState[userId];
    if (!id) {
      return safeReply(ctx, "<blockquote>❌ <b>ID tidak boleh kosong!</b></blockquote>", { parse_mode: "HTML" });
    }
    await runPteroAction(ctx, "ptero-deladmin", { id }, `🗑️ Hapus Admin "${id}"`);
    return;
  }

  if (userState[userId]?.step === "WAITING_WD_NEVA_AMOUNT") {
    const nominal = parseInt(text.replace(/[^0-9]/g, ''));

    if (isNaN(nominal) || nominal < 1000) {
      return safeReply(ctx, "<blockquote>❌ <b>Nominal tidak valid!</b>\\nMasukkan angka saja (Min 1000).</blockquote>", { parse_mode: "HTML" });
    }

    userState[userId].nevaAmount = nominal;
    userState[userId].step = "WAITING_WD_NEVA_ACCOUNT";

    return safeReply(ctx,
      `<blockquote><b>💚 Nominal:</b> ${toRupiah(nominal)}\\n\\n<i>Silakan ketik nomor tujuan (contoh: 08123456789).</i></blockquote>`,
      { parse_mode: "HTML" }
    );
  }

  if (userState[userId]?.step === "WAITING_WD_NEVA_ACCOUNT") {
    const accountNumber = text.trim();
    const state = userState[userId];

    if (!accountNumber) {
      return safeReply(ctx, "<blockquote>❌ <b>Nomor tujuan tidak valid!</b></blockquote>", { parse_mode: "HTML" });
    }

    delete userState[userId];

    const waitMsg = await safeReply(ctx, "⏳ <b>Sedang memproses withdraw Nevapedia...</b>", { parse_mode: "HTML" });

    try {
      const nevaConfig = { apikey: config.nevapedia?.apikey };
      const res = await createNevapediaWd(nevaConfig, state.nevaAmount, state.nevaMethod, accountNumber, state.nevaInstant);

      if (!res.success) throw new Error(res.message);

      const data = res.data;
      const replyText = `<blockquote>✅ <b>WD NEVAPEDIA DIAJUKAN!</b>\\n\\n` +
        `<b>ID:</b> <code>${data.id}</code>\\n` +
        `<b>Metode:</b> ${data.method}\\n` +
        `<b>Tujuan:</b> ${data.account_number}\\n` +
        `<b>Nominal:</b> ${toRupiah(data.amount)}\\n` +
        `<b>Fee:</b> ${toRupiah(data.fee)}\\n` +
        `<b>Status:</b> <code>${(data.status || "pending").toUpperCase()}</code>\\n\\n` +
        `<i>${res.message || ""}</i></blockquote>`;

      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, replyText, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Cek Status WD", callback_data: `check_wd_neva_${data.id}` }],
            [{ text: "🔙 Menu Owner", callback_data: "menu_owner" }]
          ]
        }
      });

    } catch (err) {
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null,
        `<blockquote>❌ <b>GAGAL WD NEVAPEDIA</b>\\n\\n<b>Error:</b> ${err.message}\\n\\n<i>Pastikan saldo Nevapedia cukup dan data tujuan benar.</i></blockquote>`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "🔙 Menu Owner", callback_data: "menu_owner" }]] }
        }
      );
    }
    return;
  }

  if (userState[userId]?.step === "WAITING_WD_RUMAHOTP_NOMINAL") {
    const nominal = parseInt(text.replace(/[^0-9]/g, ''));

    if (isNaN(nominal) || nominal < 1000) {
      return safeReply(ctx, "<blockquote>❌ <b>Nominal tidak valid!</b>\nMasukkan angka saja (Min 1000).</blockquote>", { parse_mode: "HTML" });
    }

    delete userState[userId];

    const waitMsg = await safeReply(ctx, "⏳ <b>Sedang menembak API H2H RumahOTP...</b>", { parse_mode: "HTML" });

    try {
      const res = await rumahOtpTransfer(nominal, config);

      const trxId = res.data?.id || res.id || "Unknown";
      const status = res.data?.status || res.status || "Pending";
      const message = res.message || "Permintaan dikirim";

      let replyText = `<blockquote>✅ <b>WD RUMAHOTP SUKSES!</b>\n\n`;
      replyText += `<b>Nominal:</b> ${toRupiah(nominal)}\n`;
      replyText += `<b>Tujuan:</b> ${config.wd_balance.destination_number} (${config.wd_balance.bank_code})\n`;
      replyText += `<b>Trx ID:</b> <code>${trxId}</code>\n`;
      replyText += `<b>Status:</b> <code>${status.toUpperCase()}</code>\n`;
      replyText += `<b>Note:</b> ${message}</blockquote>`;

      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, replyText, {
        parse_mode: "HTML",
        reply_markup: {
            inline_keyboard: [[{ text: "🔙 Menu Owner", callback_data: "menu_owner" }]]
        }
      });

    } catch (err) {
      console.error("WD RumahOTP Fail:", err);

      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null,
        `<blockquote>❌ <b>GAGAL WD RUMAHOTP</b>\n\n<b>Error:</b> ${err.message}\n\n<i>Pastikan saldo RumahOTP cukup dan Endpoint API benar.</i></blockquote>`,
        {
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [[{ text: "🔙 Menu Owner", callback_data: "menu_owner" }]]
            }
        }
      );
    }
    return;
  }
  
  if (userState[userId]?.step === "WAITING_TOPUP_RUMAHOTP") {
    const amount = parseInt(text);
    if (isNaN(amount) || amount < 2000) {
       return safeReply(ctx, "❌ Minimal deposit Rp 2.000 dan harus angka!");
    }
    
    delete userState[userId];

    const loading = await safeReply(ctx, "🔄 <b>Membuat QRIS RumahOTP...</b>", { parse_mode: "HTML" });
    const apiKey = config.RUMAHOTP;
    const fee = config.UNTUNG_DEPOSIT || 500;
    const totalRequest = amount + fee;

        try {
       const res = await axios.get(`https://www.rumahotp.io/api/v2/deposit/create?amount=${totalRequest}&payment_id=qris`, {
          headers: { "x-apikey": apiKey }
       });
       
       await ctx.deleteMessage(loading.message_id).catch(()=>{});

       if (!res.data.success) {
          const reason = res.data?.message || res.data?.msg || "Provider tidak memberi alasan.";
          console.error("[RUMAHOTP QRIS ERROR]", reason);
          return safeReply(ctx, `❌ Gagal membuat QRIS.\nSebab: ${reason}`);
       }

       const d = res.data.data;
       const caption = `<b>💳 TAGIHAN DEPOSIT</b>\n\n🆔 ID: <code>${d.id}</code>\n💰 Total Bayar: <b>Rp ${toRupiah(d.total)}</b>\n(Termasuk biaya admin)\n\n📥 Masuk Saldo: Rp ${toRupiah(amount)}\n\n⚠️ <b>Bayar sesuai nominal TOTAL (sampai digit terakhir)!</b>\nOtomatis cek status...`;
       
       const msgQris = await ctx.replyWithPhoto(d.qr_image, {
          caption: caption,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{text: "❌ Batalkan", callback_data: `batal_depo_rumahotp_${d.id}`}]] }
       });

       let checks = 0;
       const maxChecks = 120;
       const checkInterval = setInterval(async () => {
          checks++;
          if (checks > maxChecks) {
             clearInterval(checkInterval);
             return;
          }

          try {
             const checkRes = await axios.get(`https://www.rumahotp.io/api/v2/deposit/get_status?deposit_id=${d.id}`, { headers: { "x-apikey": apiKey } });
             
             if (checkRes.data && checkRes.data.success) {
                 const status = checkRes.data.data.status;

                 if (status === 'success' || status === 'paid') {
                     clearInterval(checkInterval);
                     
                     const dbPath = "./database/saldoOtp.json";
                     let saldoDB = {};
                     try { saldoDB = JSON.parse(fs.readFileSync(dbPath, "utf8")); } catch(e){}
                     
                     saldoDB[userId] = (saldoDB[userId] || 0) + amount;
                     fs.writeFileSync(dbPath, JSON.stringify(saldoDB, null, 2));

                     await ctx.deleteMessage(msgQris.message_id).catch(()=>{});
                     await ctx.reply(`✅ <b>DEPOSIT SUKSES!</b>\n\n💰 Diterima: Rp ${toRupiah(amount)}\n💼 Total Saldo: Rp ${toRupiah(saldoDB[userId])}`, { parse_mode: "HTML" });
                     
                     bot.telegram.sendMessage(config.ownerId, `🔔 User ${userId} Deposit Rp ${amount} via RumahOTP`).catch(()=>{});

                 } else if (status === 'cancelled' || status === 'failed') {
                     clearInterval(checkInterval);
                     await ctx.deleteMessage(msgQris.message_id).catch(()=>{});
                     await ctx.reply("❌ Deposit dibatalkan/gagal.");
                 }
             }
          } catch(e) { 
              console.log("Error cek deposit:", e.message);
          }
       }, 5000);

    } catch(e) {
       console.error("[RUMAHOTP QRIS FATAL]", e.response?.data || e.message);
       const reason = e.response?.data?.message || e.response?.data?.msg || e.message;
       safeReply(ctx, `❌ Error API RumahOTP.\nSebab: ${reason}`);
    }
    return;
  }
  if (userState[userId]?.step === "WAITING_USERNAME_PANEL") {
    if (!/^[a-zA-Z0-9]+$/.test(text))
        return ctx.reply("<blockquote>⚠️ <b>Username hanya boleh huruf & angka!</b></blockquote>", { parse_mode: "HTML" });

    const username = text;
    delete userState[userId].step;

    const hargaGb = config.hargaPanel.perGB;
    const hargaUnli = config.hargaPanel.unlimited;

    let listRam = [];

    for (let gb = 1; gb <= 10; gb++) {
        const ramMB = gb * 1024;
        const price = gb * hargaGb;

        listRam.push({
            label: `${gb}GB - ${toRupiah(price)}`,
            ram: ramMB,
            price
        });
    }

    listRam.push({
        label: `UNLIMITED (${toRupiah(hargaUnli)})`,
        ram: 0,
        price: hargaUnli
    });

    const buttons = listRam.map(p => {
        return [{ text: p.label, callback_data: `pay_panel_${p.ram}_${p.price}_${username}` }];
    });

    buttons.push([{ text: "🔙 Batal", callback_data: "back_home" }]);

    return ctx.reply(
        `<blockquote><b>🛠️ Pilih Spesifikasi untuk user ${username}</b></blockquote>`,
        {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buttons }
        }
    );
  }

  if (userState[userId]?.step === "WAITING_SCRIPT_DETAIL") {
  const state = userState[userId];
  const parts = text.split("|").map(x => x.trim());
  
  if (parts.length !== 3) {
    return safeReply(ctx, "<blockquote>❌ Format detail salah! Gunakan: Nama | Harga (angka) | Deskripsi</blockquote>", { parse_mode: "HTML" });
  }
  
  const [nama, hargaStr, deskripsi] = parts;
  const harga = parseInt(hargaStr);
  
  if (isNaN(harga) || harga <= 0) {
    return safeReply(ctx, "<blockquote>❌ Harga harus angka positif!</blockquote>", { parse_mode: "HTML" });
  }
  
  try {
    const db = readDb();
    const scriptData = {
      nama: nama,
      harga: harga,
      deskripsi: deskripsi,
      file_id: state.file_id, 
      fileName: state.temp_fileName 
    };
    
    db.scripts.push(scriptData);
    saveDb(db);
    
    const addedBy = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
    
    sendProductNotification("script", scriptData, addedBy);
    
    safeReply(ctx, `<blockquote><b>✅ Sukses Menambah Script!</b>\n\n<b>📂 Nama:</b> <code>${nama}</code>\n<b>💰 Harga:</b> <code>${toRupiah(harga)}</code>\n<b>📄 File:</b> <code>${state.temp_fileName}</code>\n\n📢 Notifikasi telah dikirim ke channel!</blockquote>`, { 
      parse_mode: "HTML" 
    });
    
  } catch (e) {
    console.error(e);
    safeReply(ctx, "❌ Gagal menyimpan data script ke database.");
  }
  
  delete userState[userId];
  return;
}

  if (userState[userId]?.step === "WAITING_APP_TEXT") {
  if (userId !== config.ownerId) return next();
  
  const parts = text.split("|").map(x => x.trim());
  if (parts.length !== 3) {
    return safeReply(ctx, "<blockquote>❌ Format salah! Gunakan: Nama | Harga | Deskripsi</blockquote>", { parse_mode: "HTML" });
  }
  
  const [nama, hargaStr, deskripsi] = parts;
  const harga = parseInt(hargaStr);
  
  if (isNaN(harga) || harga <= 0) {
    return safeReply(ctx, "<blockquote>❌ Harga harus angka positif!</blockquote>", { parse_mode: "HTML" });
  }
  
  try {
    const db = readDb();
    const newApp = {
      nama,
      harga,
      deskripsi,
      accounts: [] 
    };
    
    db.apps.push(newApp);
    saveDb(db);
    const idx = db.apps.length - 1;
    
    const addedBy = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
    
    sendProductNotification("app", newApp, addedBy);
    
    await safeReply(ctx, `<blockquote><b>✅ App Premium ditambahkan!</b>\n<b>📱 ${nama}</b>\n<b>Stock:</b> 0\n\n📢 Notifikasi telah dikirim ke channel!</blockquote>`, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [ Markup.button.callback("📄 List Account", `list_accounts_${idx}`) ],
        [ Markup.button.callback("🔙 Kembali ke Owner Menu", "menu_owner") ]
      ])
    });
    
  } catch (e) {
    console.error(e);
    safeReply(ctx, "❌ Gagal menyimpan data app ke database.");
  }
  
  delete userState[userId];
  return;
}

  if (userState[userId]?.step === "WAITING_ADD_ACCOUNT") {
  if (userId !== config.ownerId) return next();
  
  const st = userState[userId];
  const parts = text.split("|").map(x => x.trim());
  
  if (parts.length !== 4) {
    return safeReply(ctx, "<blockquote>❌ Format salah! Gunakan: username|password|link akses|deskripsi</blockquote>", { parse_mode: "HTML" });
  }
  
  const [usernameA, passwordA, linkA, descA] = parts;
  
  try {
    const db = readDb();
    const app = db.apps[st.appIndex];
    
    if (!app) {
      return safeReply(ctx, "❌ App tidak ditemukan / sudah dihapus.");
    }
    
    app.accounts = app.accounts || [];
    app.accounts.push({ 
      user: usernameA, 
      pass: passwordA, 
      link: linkA, 
      desc: descA 
    });
    
    saveDb(db);
    const stockNow = app.accounts.length;
    
    const addedBy = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
    const accountData = {
      appName: app.nama,
      username: usernameA,
      password: passwordA,
      link: linkA,
      desc: descA,
      newStock: stockNow
    };
    
    sendProductNotification("account", accountData, addedBy);
    notifyWishlistRestock(app.nama, app.harga);
    
    safeReply(ctx, `<blockquote><b>✅ Akun ditambahkan!</b>\n<b>Stock sekarang:</b> ${stockNow}\n\n📢 Notifikasi telah dikirim ke channel!</blockquote>`, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [ Markup.button.callback("➕ Tambah lagi", `owner_add_account`) ],
        [ Markup.button.callback("📃 List App Premium", "list_apps") ],
        [ Markup.button.callback("🔙 Kembali ke Owner Menu", "menu_owner") ]
      ])
    });
    
  } catch (e) {
    console.error(e);
    safeReply(ctx, "❌ Gagal menambahkan akun ke database.");
  }
  
  delete userState[userId];
  return;
}

  if (userState[userId]?.step === "WAITING_ADD_GMAIL_STOCK") {
  if (userId !== config.ownerId) return next();

  const st = userState[userId];
  const lines = text.split("\n").map(x => x.trim()).filter(x => x.length > 0);

  if (!lines.length) {
    return safeReply(ctx, "<blockquote>❌ Tidak ada data yang bisa diproses.</blockquote>", { parse_mode: "HTML" });
  }

  try {
    const db = readDb();
    const app = db.apps[st.appIndex];

    if (!app) {
      delete userState[userId];
      return safeReply(ctx, "❌ Produk Gmail tidak ditemukan / sudah dihapus.");
    }

    app.accounts = app.accounts || [];

    let added = 0;
    const gagal = [];

    for (const line of lines) {
      const parts = line.split("|").map(x => x.trim());
      if (parts.length < 2 || !parts[0] || !parts[1]) {
        gagal.push(line);
        continue;
      }
      const [emailA, passwordA, recoveryA, descA] = parts;
      app.accounts.push({
        user: emailA,
        pass: passwordA,
        link: recoveryA || "-",
        desc: descA || "-"
      });
      added++;
    }

    saveDb(db);
    const stockNow = app.accounts.length;

    const addedBy = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
    sendProductNotification("account", {
      appName: app.nama,
      username: `${added} akun`,
      password: "-",
      link: "-",
      desc: `Stok Gmail ditambahkan sebanyak ${added} akun`,
      newStock: stockNow
    }, addedBy);

    let msg = `<blockquote><b>✅ Stok Gmail ditambahkan!</b>\n<b>Berhasil:</b> ${added} akun\n<b>Stock sekarang:</b> ${stockNow}\n\n📢 Notifikasi telah dikirim ke channel!</blockquote>`;
    if (gagal.length) {
      msg += `\n<blockquote>⚠️ <b>${gagal.length} baris gagal diproses</b> (format salah, dilewati).</blockquote>`;
    }

    safeReply(ctx, msg, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [ Markup.button.callback("➕ Tambah lagi", "owner_add_gmail_stock") ],
        [ Markup.button.callback("🗑 Kelola Stok Gmail", "owner_del_gmail_stock") ],
        [ Markup.button.callback("🔙 Kembali ke Owner Menu", "menu_owner") ]
      ])
    });

  } catch (e) {
    console.error(e);
    safeReply(ctx, "❌ Gagal menambahkan stok Gmail ke database.");
  }

  delete userState[userId];
  return;
}

  if (userState[userId]?.step === "WAITING_ADD_NOTEL_STOCK") {
  if (userId !== config.ownerId) return next();

  const st = userState[userId];
  const lines = text.split("\n").map(x => x.trim()).filter(x => x.length > 0);

  if (!lines.length) {
    return safeReply(ctx, "<blockquote>❌ Tidak ada data yang bisa diproses.</blockquote>", { parse_mode: "HTML" });
  }

  try {
    const db = readDb();
    const app = db.apps[st.appIndex];

    if (!app) {
      delete userState[userId];
      return safeReply(ctx, "❌ Produk Notel tidak ditemukan / sudah dihapus.");
    }

    app.accounts = app.accounts || [];

    let added = 0;
    const gagal = [];

    for (const line of lines) {
      const parts = line.split("|").map(x => x.trim());
      if (parts.length < 2 || !parts[0] || !parts[1]) {
        gagal.push(line);
        continue;
      }
      const [nomorA, pinA, providerA, descA] = parts;
      app.accounts.push({
        user: nomorA,
        pass: pinA,
        link: providerA || "-",
        desc: descA || "-"
      });
      added++;
    }

    saveDb(db);
    const stockNow = app.accounts.length;

    const addedBy = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
    sendProductNotification("account", {
      appName: app.nama,
      username: `${added} nomor`,
      password: "-",
      link: "-",
      desc: `Stok Notel ditambahkan sebanyak ${added} nomor`,
      newStock: stockNow
    }, addedBy);

    let msg = `<blockquote><b>✅ Stok Notel ditambahkan!</b>\n<b>Berhasil:</b> ${added} nomor\n<b>Stock sekarang:</b> ${stockNow}\n\n📢 Notifikasi telah dikirim ke channel!</blockquote>`;
    if (gagal.length) {
      msg += `\n<blockquote>⚠️ <b>${gagal.length} baris gagal diproses</b> (format salah, dilewati).</blockquote>`;
    }

    safeReply(ctx, msg, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [ Markup.button.callback("➕ Tambah lagi", "owner_add_notel_stock") ],
        [ Markup.button.callback("🗑 Kelola Stok Notel", "owner_del_notel_stock") ],
        [ Markup.button.callback("🔙 Kembali ke Owner Menu", "menu_owner") ]
      ])
    });

  } catch (e) {
    console.error(e);
    safeReply(ctx, "❌ Gagal menambahkan stok Notel ke database.");
  }

  delete userState[userId];
  return;
}

  if (userState[ctx.from.id]?.step === "WAITING_BROADCAST" && ctx.from.id === config.ownerId) {
    const users = loadUsers();
    let sent = 0;
    for (const uid of users) {
      try {
        if (ctx.message.photo) {
          await bot.telegram.sendPhoto(uid, ctx.message.photo[0].file_id, { caption: ctx.message.caption || "", parse_mode: "HTML" });
        } else if (ctx.message.document) {
          await bot.telegram.sendDocument(uid, ctx.message.document.file_id, { caption: ctx.message.caption || "", parse_mode: "HTML" });
        } else {
          await bot.telegram.sendMessage(uid, ctx.message.text);
        }
        sent++;
      } catch (e) {}
    }
    delete userState[ctx.from.id];
    return safeReply(ctx, `<blockquote>📢 <b>Broadcast selesai!</b> <b>Terkirim:</b> ${sent}</blockquote>`, { parse_mode: "HTML" });
  }

  return next();
});

async function downloadQrisImage(url) {
  try {
    console.log("[DEBUG] Downloading QRIS image from:", url);
    
    if (!url || !url.startsWith('http')) {
      throw new Error('URL QRIS tidak valid: ' + url);
    }
    
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!response.data || response.data.length === 0) {
      throw new Error('Gambar QRIS kosong');
    }
    
    console.log("[DEBUG] QRIS image downloaded successfully, size:", response.data.length, "bytes");
    return Buffer.from(response.data);
    
  } catch (error) {
    console.error("[ERROR] Failed to download QRIS image:", error.message);
    console.error("[ERROR] URL:", url);
    return null;
  }
}

async function showPaymentWithVoucher(ctx, nominal, itemName, productData) {
  const message = `
<b>💳 PEMBAYARAN</b>
━━━━━━━━━━━━━━━━━━━━━━

<b>Item:</b> ${itemName}
<b>Harga:</b> ${toRupiah(nominal)}

━━━━━━━━━━━━━━━━━━━━━━
<b>💎 Punya voucher?</b>
Pilih opsi di bawah:
  `.trim();
  
  userState[ctx.from.id] = {
    step: "WAITING_VOUCHER_INPUT",
    paymentData: {
      nominal: nominal,
      itemName: itemName,
      productData: productData
    }
  };
  
  await editMenuMessage(ctx, message, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🎫 Gunakan Voucher", callback_data: "use_voucher_payment" }],
        [{ text: "🚫 Tanpa Voucher", callback_data: `skip_voucher_${nominal}` }],
        [{ text: "🔙 Batal", callback_data: "menu_katalog" }]
      ]
    }
  });
}

bot.action("use_voucher_payment", async (ctx) => {
  const userId = ctx.from.id;
  
  if (!userState[userId]?.paymentData) {
    return ctx.answerCbQuery("❌ Data pembayaran tidak ditemukan!", { show_alert: true });
  }
  
  const paymentData = userState[userId].paymentData;
  
  // Set state untuk menunggu input kode voucher
  userState[userId].step = "WAITING_VOUCHER_CODE_INPUT";
  
  await editMenuMessage(ctx, 
    `<b>🎫 MASUKKAN KODE VOUCHER</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n<b>Produk:</b> ${paymentData.itemName}\n<b>Harga:</b> ${toRupiah(paymentData.nominal)}\n\nSilakan masukkan kode voucher Anda:\n\nContoh: <code>ABC123DE</code>`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Kembali", callback_data: `back_to_payment_${paymentData.nominal}` }]
        ]
      }
    }
  );
});

bot.action(/back_to_payment_(\d+)/, async (ctx) => {
  const nominal = parseInt(ctx.match[1]);
  const userId = ctx.from.id;
  
  if (userState[userId]?.paymentData) {
    const paymentData = userState[userId].paymentData;
    
    // Reset ke harga asli
    paymentData.nominal = paymentData.originalNominal;
    delete userState[userId].voucherInfo;
    delete userState[userId].step;
    
    // Tampilkan menu payment lagi
    const text = `
<b>💰 KONFIRMASI PEMBAYARAN</b>
━━━━━━━━━━━━━━━━━━━━━━

<b>📦 Produk:</b> ${paymentData.itemName}
<b>💰 Harga:</b> ${toRupiah(paymentData.nominal)}

━━━━━━━━━━━━━━━━━━━━━━
<b>🎫 Pilihan Voucher:</b>
    `.trim();
    
    await editMenuMessage(ctx, text, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎫 Gunakan Voucher", callback_data: "use_voucher_payment" }],
          [{ text: "🚫 Tanpa Voucher", callback_data: `skip_voucher_${nominal}` }],
          [{ text: "🔙 Kembali", callback_data: "menu_katalog" }]
        ]
      }
    });
  }
});

bot.action(/skip_voucher_(\d+)/, async (ctx) => {
  const nominal = parseInt(ctx.match[1]);
  const userId = ctx.from.id;
  
  if (userState[userId]?.step === "WAITING_VOUCHER_INPUT" || userState[userId]?.step === "WAITING_VOUCHER_CODE_INPUT") {
    const paymentData = userState[userId].paymentData;
    delete userState[userId];
    
    await handlePayment(ctx, nominal, paymentData.itemName, paymentData.productData);
  }
});

bot.action("continue_with_voucher", async (ctx) => {
  const userId = ctx.from.id;
  
  if (!userState[userId]?.paymentData || !userState[userId]?.voucherInfo) {
    return ctx.answerCbQuery("❌ Data voucher tidak ditemukan!", { show_alert: true });
  }
  
  const paymentData = userState[userId].paymentData;
  const voucherInfo = userState[userId].voucherInfo;
  
  // Update nominal dengan harga setelah diskon
  paymentData.nominal = voucherInfo.finalPrice;
  paymentData.voucherInfo = voucherInfo;
  
  // Panggil handlePayment dengan data yang sudah di-update
  await handlePayment(ctx, voucherInfo.finalPrice, paymentData.itemName, {
    ...paymentData.productData,
    voucherCode: voucherInfo.voucher?.code,
    voucherId: voucherInfo.voucher?.id,
    originalPrice: paymentData.originalNominal,
    discount: voucherInfo.discount
  });
});

bot.action("back_to_voucher_input", async (ctx) => {
  const userId = ctx.from.id;
  
  if (userState[userId]?.step === "VOUCHER_APPLIED") {
    const paymentData = userState[userId].paymentData;
    
    userState[userId].step = "WAITING_VOUCHER_INPUT";
    delete userState[userId].voucherInfo;
    
    await showPaymentWithVoucher(ctx, paymentData.nominal, paymentData.itemName, paymentData.productData);
  }
});

// In-memory penyimpanan sementara pilihan metode bayar (dipilih sebelum QRIS/Stars dibuat)
const pendingPaymentChoice = {};

// ==================================================================
// AUTO-RESTOCK REMINDER
// Notif owner otomatis begitu stok produk (accounts) turun ke batas
// tertentu, biar gak kehabisan tanpa sadar pas lagi rame.
// ==================================================================
const lowStockAlerted = {}; // appName -> level stok terakhir yang sudah di-notif (biar gak spam notif berkali-kali di level yang sama)
function checkLowStockAlert(app) {
  const threshold = config.lowStockThreshold ?? 2;
  const remaining = (app.accounts || []).length;

  if (remaining <= threshold) {
    if (lowStockAlerted[app.nama] === remaining) return; // sudah pernah di-notif persis di level stok ini, skip
    lowStockAlerted[app.nama] = remaining;
    bot.telegram
      .sendMessage(
        config.ownerId,
        `<blockquote>⚠️ <b>Stok Menipis!</b>\n\n<b>${app.nama}</b> tersisa <b>${remaining}</b> stok.\nSegera tambah stok biar gak kehabisan.</blockquote>`,
        { parse_mode: "HTML" }
      )
      .catch((e) => console.error("[LOW STOCK] Gagal notif owner:", e.message));
  } else {
    delete lowStockAlerted[app.nama]; // stok sudah di atas batas lagi (baru di-restock), reset biar next time turun bisa notif ulang
  }
}


// Cegah user checkout item yang SAMA berkali-kali dalam waktu singkat
// (biasa kejadian karena double-tap tombol beli / koneksi lag).
// ==================================================================
const recentOrderAttempts = {};
const DOUBLE_ORDER_COOLDOWN_MS = 15 * 1000; // 15 detik

function isDuplicateOrder(userId, itemName) {
  const key = `${userId}_${itemName}`;
  const last = recentOrderAttempts[key];
  const now = Date.now();
  if (last && now - last < DOUBLE_ORDER_COOLDOWN_MS) return true;
  recentOrderAttempts[key] = now;
  return false;
}

async function handlePayment(ctx, nominal, itemName, productData, voucherCode = null) {
  if (isDuplicateOrder(ctx.from.id, itemName)) {
    await ctx.answerCbQuery?.();
    return safeReply(
      ctx,
      `<blockquote>⏳ <b>Tunggu sebentar!</b>\n\nKamu baru aja order <b>${itemName}</b>. Kalau itu bukan double-tap dan memang mau order lagi, tunggu ±15 detik lalu coba lagi.</blockquote>`,
      { parse_mode: "HTML" }
    );
  }

  // Kalau Telegram Stars tidak diaktifkan owner, langsung ke alur QRIS seperti biasa (tidak ada perubahan perilaku).
  if (!config.telegramStars?.enabled) {
    return handlePaymentQris(ctx, nominal, itemName, productData, voucherCode);
  }

  if (!isPrivateChat(ctx)) {
    await ctx.answerCbQuery?.();
    return safeReply(ctx, "❌ <b>Pembayaran hanya bisa dilakukan di Private Chat!</b>\n\n💬 Silakan chat saya di private: https://t.me/" + bot.botInfo.username, { parse_mode: "HTML" });
  }

  const userId = ctx.from.id;
  if (activeTransactions[userId]) return safeReply(ctx, "<blockquote>⚠️ <b>Ada transaksi pending.</b> Ketik /cancel.</blockquote>", { parse_mode: "HTML" });

  const stars = Math.ceil(nominal / (config.telegramStars.idrPerStar || 250));
  pendingPaymentChoice[userId] = { nominal, itemName, productData, voucherCode, stars };

  await safeReply(
    ctx,
    `<blockquote><b>💰 Pilih Metode Pembayaran</b>\n\n<b>Item:</b> ${itemName}\n<b>Total:</b> ${toRupiah(nominal)}\n\nMau bayar pakai apa?</blockquote>`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "💳 QRIS (Nevapedia)", callback_data: "paymethod_qris" }],
          [{ text: `⭐ Telegram Stars (${stars})`, callback_data: "paymethod_stars" }],
          [{ text: "❌ Batalkan", callback_data: "paymethod_cancel" }],
        ],
      },
    }
  );
}

bot.action("paymethod_cancel", async (ctx) => {
  const userId = ctx.from.id;
  delete pendingPaymentChoice[userId];
  try { await ctx.deleteMessage(); } catch (e) {}
  await ctx.answerCbQuery("Dibatalkan.");
});

bot.action("paymethod_qris", async (ctx) => {
  const userId = ctx.from.id;
  const pending = pendingPaymentChoice[userId];
  if (!pending) return ctx.answerCbQuery("❌ Data pembayaran sudah kedaluwarsa, ulangi order.", { show_alert: true });
  delete pendingPaymentChoice[userId];
  try { await ctx.deleteMessage(); } catch (e) {}
  await handlePaymentQris(ctx, pending.nominal, pending.itemName, pending.productData, pending.voucherCode);
});

bot.action("paymethod_stars", async (ctx) => {
  const userId = ctx.from.id;
  const pending = pendingPaymentChoice[userId];
  if (!pending) return ctx.answerCbQuery("❌ Data pembayaran sudah kedaluwarsa, ulangi order.", { show_alert: true });
  delete pendingPaymentChoice[userId];
  try { await ctx.deleteMessage(); } catch (e) {}
  await handleStarsPayment(ctx, pending.nominal, pending.itemName, pending.productData, pending.voucherCode, pending.stars);
});

// ==================================================================
// TELEGRAM STARS PAYMENT
// Metode bayar native Telegram (mata uang XTR), tanpa keluar app,
// tanpa perlu payment gateway pihak ketiga.
// ==================================================================
const pendingStarsPayments = {}; // payload -> {userId, itemName, productData, nominal, voucherCode, stars}

async function handleStarsPayment(ctx, nominal, itemName, productData, voucherCode, stars) {
  const userId = ctx.from.id;
  const payload = `stars_${userId}_${Date.now()}`;
  pendingStarsPayments[payload] = { userId, itemName, productData, nominal, voucherCode, stars, chatId: ctx.chat.id };

  try {
    await ctx.replyWithInvoice({
      title: itemName.slice(0, 32),
      description: `Pembayaran ${itemName} — ${toRupiah(nominal)} (${stars} ⭐)`.slice(0, 255),
      payload,
      provider_token: "", // wajib string kosong untuk Telegram Stars
      currency: "XTR",
      prices: [{ label: itemName.slice(0, 32), amount: stars }],
    });
  } catch (err) {
    console.error("[STARS] Gagal kirim invoice:", err.message);
    delete pendingStarsPayments[payload];
    await safeReply(ctx, "<blockquote>❌ <b>Gagal membuat invoice Telegram Stars.</b> Coba metode QRIS, atau hubungi owner.</blockquote>", { parse_mode: "HTML" });
  }
}

bot.on("pre_checkout_query", async (ctx) => {
  const payload = ctx.preCheckoutQuery.invoice_payload;
  if (!pendingStarsPayments[payload]) {
    return ctx.answerPreCheckoutQuery(false, "Transaksi tidak ditemukan atau sudah kedaluwarsa.");
  }
  await ctx.answerPreCheckoutQuery(true);
});

// Handle pembayaran Stars sukses (harus didaftarkan sebelum handler "text" generik lain)
bot.on("message", async (ctx, next) => {
  const sp = ctx.message?.successful_payment;
  if (!sp) return next();

  const payload = sp.invoice_payload;
  const data = pendingStarsPayments[payload];
  delete pendingStarsPayments[payload];

  if (!data) {
    console.error("[STARS] successful_payment tanpa data pending, payload:", payload);
    return safeReply(ctx, "<blockquote>✅ Pembayaran diterima, tapi data order tidak ditemukan. Hubungi owner dengan screenshot ini.</blockquote>", { parse_mode: "HTML" });
  }

  const { itemName, productData, nominal, voucherCode, stars, userId } = data;

  await safeReply(ctx, `<blockquote>✅ <b>Pembayaran Telegram Stars berhasil!</b>\n\n<b>Item:</b> ${itemName}\n<b>Dibayar:</b> ${stars} ⭐\n\nMengirim produk...</blockquote>`, { parse_mode: "HTML" });

  const userName = `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim();
  sendTestimoniKeChannel(userName, userId, itemName, nominal);

  try {
    await bot.telegram.sendMessage(
      config.ownerId,
      `<b>💰 PEMBAYARAN SUKSES (Telegram Stars)</b>\n\n<b>👤 User:</b> ${userName} (${userId})\n<b>🛒 Item:</b> ${itemName}\n<b>💵 Harga:</b> ${toRupiah(nominal)}\n<b>⭐ Stars:</b> ${stars}\n<b>⏰ Waktu:</b> ${new Date().toLocaleString()}`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    console.error("[STARS] Gagal notif owner:", e.message);
  }

  if (voucherCode) {
    productData.voucherCode = voucherCode;
  }

  await sendProductToUser(ctx, productData);
  sendReceiptImage(ctx, { itemName, nominal, method: `Telegram Stars (${stars} ⭐)` });
  sendBuyAgainButton(ctx, productData);

  if (userState[userId]?.voucherInfo?.voucher?.id) {
    const voucherId = userState[userId].voucherInfo.voucher.id;
    incrementVoucherUsage(voucherId, userId, ctx.from.first_name || "User", itemName);
    delete userState[userId].voucherInfo;
  }
});

// ==================================================================
// STRUK BELANJA (JPG) - dikirim otomatis tiap transaksi sukses
// Pakai fitur "create-struk" dari API nexapi (gratis kalau apikey sudah
// diisi). Kalau apikey belum diisi / API error, DIAM SAJA (tidak
// ganggu alur utama) karena ini cuma pemanis, bukan fitur inti.
// ==================================================================
/** Tombol "Beli Lagi" cepat setelah transaksi sukses. Cuma didukung buat produk tipe "app" (yang punya idx jelas). */
async function sendBuyAgainButton(ctx, productData) {
  if (productData?.type !== "app" || productData.idx === undefined) return;
  try {
    await safeReply(ctx, "<blockquote>🎉 <b>Makasih udah order!</b> Mau beli lagi produk yang sama?</blockquote>", {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 Beli Lagi", callback_data: `buy_app_${productData.idx}` }],
          [{ text: "📦 Lihat Katalog Lain", callback_data: "menu_apps" }],
        ],
      },
    });
  } catch (e) {
    console.error("[BELI LAGI] Gagal kirim tombol:", e.message);
  }
}

async function sendReceiptImage(ctx, { itemName, nominal, method = "QRIS" }) {
  const apikey = config.externalApi?.nexapi?.apikey;
  if (!apikey || apikey === "-") return; // fitur struk belum diaktifkan owner, skip diam-diam

  try {
    const ep = ExtAPI.findEndpoint(ExtAPI.NEX_ENDPOINTS, "create-struk");
    if (!ep) return;
    const items = `${itemName}:1:${nominal}`;
    const data = ExtAPI.deepStripCredit(await ExtAPI.callNex(ep, {
      storename: config.botName || "Toko",
      items,
      bayar: String(nominal),
      timezone: "Asia/Jakarta",
    }));
    const imageUrl = ExtAPI.extractMediaUrl(data);
    if (!imageUrl) return;
    await ctx.replyWithPhoto(imageUrl, { caption: `🧾 Struk pembayaran — ${method}` });
  } catch (err) {
    console.error("[STRUK] Gagal generate struk JPG (dilewati, tidak fatal):", err.message);
  }
}

async function handlePaymentQris(ctx, nominal, itemName, productData, voucherCode = null) {
  if (!isPrivateChat(ctx)) {
    await ctx.answerCbQuery?.();
    return safeReply(ctx, "❌ <b>Pembayaran hanya bisa dilakukan di Private Chat!</b>\n\n💬 Silakan chat saya di private: https://t.me/" + bot.botInfo.username, { parse_mode: "HTML" });
  }
  
  const userId = ctx.from.id;
  if (activeTransactions[userId]) return safeReply(ctx, "<blockquote>⚠️ <b>Ada transaksi pending.</b> Ketik /cancel.</blockquote>", { parse_mode: "HTML" });
  
  // Validasi voucher jika ada
  let voucherInfo = null;
  let finalNominal = nominal;
  let discountAmount = 0;
  
  if (voucherCode) {
    voucherInfo = validateVoucher(voucherCode, nominal);
    
    if (voucherInfo.valid) {
      finalNominal = voucherInfo.finalPrice;
      discountAmount = voucherInfo.discount;
      
      // Tandai voucher sebagai digunakan
      useVoucher(voucherInfo.voucher.id);
      
      // Tambahkan voucher code ke productData untuk dicatat di transaksi
      productData.voucherCode = voucherCode;
      productData.originalPrice = nominal;
      productData.discountAmount = discountAmount;
    } else {
      // Jika voucher tidak valid, lanjut tanpa voucher
      await safeReply(ctx, `<blockquote>${voucherInfo.message}</blockquote>\n\n<b>Melanjutkan tanpa voucher...</b>`, { parse_mode: "HTML" });
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
  
  const activePaymentMethod = getActivePaymentMethod();
  
  // Simpan info voucher di userState untuk digunakan nanti
  if (voucherInfo && voucherInfo.valid) {
    if (!userState[userId]) userState[userId] = {};
    userState[userId].voucherInfo = voucherInfo;
  }
  
  if (activePaymentMethod === "manual") {
    if (!config.manualQrisPhoto) {
      return safeReply(ctx, "<blockquote>❌ <b>QRIS manual belum diatur oleh owner.</b> Silakan hubungi owner.</blockquote>", { parse_mode: "HTML" });
    }
    
    const fee = Math.floor(Math.random() * 100);
    const totalBayar = finalNominal + fee;
    
    let caption = `<blockquote><b>🧾 TAGIHAN MANUAL</b>\n\n<b>Item:</b> <code>${itemName}</code>\n`;
    
    if (voucherInfo && voucherInfo.valid) {
      caption += `<b>Harga Awal:</b> ${toRupiah(nominal)}\n`;
      caption += `<b>Diskon:</b> -${toRupiah(discountAmount)}\n`;
      caption += `<b>Voucher:</b> <code>${voucherCode}</code>\n`;
    }
    
    caption += `<b>Total Bayar:</b> ${toRupiah(totalBayar)}\n\n`;
    caption += `<i>Silakan transfer sesuai nominal di atas</i>\n`;
    caption += `<i>Lalu kirim foto bukti transfer ke bot ini</i>\n`;
    caption += `<i>Bot akan otomatis mengirim ke owner</i></blockquote>`;
    
    await ctx.replyWithPhoto(config.manualQrisPhoto, {
      caption: caption,
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("❌ Batalkan", "cancel_trx")]
      ])
    });
    
    userState[userId] = {
      step: "PAYMENT_MANUAL_PENDING",
      itemName: itemName,
      amount: totalBayar,
      productData: productData,
      nominal: finalNominal,
      originalPrice: nominal,
      discountAmount: discountAmount,
      voucherCode: voucherCode
    };
    
    return;
  }
  
  const fee = Math.floor(Math.random() * 100);
  const totalBayar = finalNominal + fee;
  const msgLoading = await safeReply(ctx, "<blockquote>🔄 <b>Mohon Sebentar Sedang Membuat Qris Pembayaran Anda...</b></blockquote>", { parse_mode: "HTML" });

  const paymentConfig = { method: "nevapedia", apikey: config.nevapedia?.apikey };
  const qrisData = await createdQris(totalBayar, paymentConfig);
  
  try {
    await ctx.deleteMessage(msgLoading.message_id);
  } catch (e) {}
  
  if (!qrisData || qrisData.error) {
    const reason = qrisData?.error || "Provider tidak mengembalikan data QRIS.";
    console.error("[QRIS CREATE ERROR]", reason);
    return safeReply(
      ctx,
      `<blockquote>❌ <b>Gagal membuat QRIS.</b>\n<b>Sebab:</b> ${reason}\n\n<i>Silakan hubungi owner kalau ini terus terjadi.</i></blockquote>`,
      { parse_mode: "HTML" }
    );
  }
  
  console.log("[DEBUG] QRIS Data:", {
    hasImage: !!qrisData.imageqris,
    imageType: typeof qrisData.imageqris,
    isBuffer: qrisData.imageqris instanceof Buffer,
    isString: typeof qrisData.imageqris === 'string',
    hasQrString: !!qrisData.qr_string,
    fullData: qrisData
  });
  
  let photoToSend = null;
  let useLocalQR = false;
  
  if (qrisData.imageqris instanceof Buffer) {
    console.log("[DEBUG] QRIS adalah Buffer, size:", qrisData.imageqris.length);
    photoToSend = { source: qrisData.imageqris };
    
  } else if (qrisData.imageqris && typeof qrisData.imageqris === 'string') {
    if (qrisData.imageqris.startsWith('data:image')) {
      try {
        console.log("[DEBUG] QRIS adalah Base64");
        const base64Data = qrisData.imageqris.replace(/^data:image\/\w+;base64,/, '');
        photoToSend = { source: Buffer.from(base64Data, 'base64') };
      } catch (e) {
        console.error("[ERROR] Failed to parse base64 image:", e.message);
      }
      
    } else if (qrisData.imageqris.startsWith('http')) {
      console.log("[DEBUG] QRIS adalah URL:", qrisData.imageqris);
      
      try {
        const { downloadQrisImage } = require("./lib/payment");
        const qrBuffer = await downloadQrisImage(qrisData.imageqris);
        
        if (qrBuffer) {
          console.log("[DEBUG] QRIS downloaded successfully, size:", qrBuffer.length);
          photoToSend = { source: qrBuffer };
        } else {
          console.log("[DEBUG] Failed to download QRIS, will use qr_string");
          useLocalQR = true;
        }
      } catch (downloadErr) {
        console.error("[ERROR] Failed to download QRIS image:", downloadErr.message);
        useLocalQR = true;
      }
    } else {
      console.log("[DEBUG] QRIS adalah string biasa");
      useLocalQR = true;
    }
  }
  
  if (!photoToSend && (useLocalQR || !qrisData.imageqris)) {
    if (qrisData.qr_string && qrisData.qr_string.trim().length > 0) {
      console.log("[DEBUG] Generating local QR from qr_string");
      try {
        const qrBuffer = await generateLocalQr(qrisData.qr_string);
        if (qrBuffer) {
          photoToSend = { source: qrBuffer };
          console.log("[DEBUG] Local QR generated successfully");
        } else {
          console.log("[DEBUG] Failed to generate local QR");
        }
      } catch (qrErr) {
        console.error("[ERROR] Failed to generate local QR:", qrErr.message);
      }
    }
  }
  
  if (!photoToSend) {
    console.error("[ERROR] No valid QRIS data available");
    
    let errorMessage = `<b>❌ GAGAL MEMBUAT QRIS</b>\n\n`;
    errorMessage += `<b>Item:</b> ${itemName}\n`;
    
    if (voucherInfo && voucherInfo.valid) {
      errorMessage += `<b>Harga Awal:</b> ${toRupiah(nominal)}\n`;
      errorMessage += `<b>Diskon:</b> -${toRupiah(discountAmount)}\n`;
      errorMessage += `<b>Voucher:</b> <code>${voucherCode}</code>\n`;
    }
    
    errorMessage += `<b>Total:</b> ${toRupiah(totalBayar)}\n\n`;
    errorMessage += `<i>Silakan hubungi owner untuk pembayaran manual.</i>`;
    
    return safeReply(ctx, errorMessage, { parse_mode: "HTML" });
  }
  
  try {
    console.log("[DEBUG] Sending QRIS to user");
    
    let caption = `<blockquote><b>╭━━━━✧「 🧾 𝗣𝗘𝗠𝗕𝗔𝗬𝗔𝗥𝗔𝗡 」✧━━━━❍</b>\n<b>┃</b> 📦 <b>Item</b>   : ${itemName}\n`;
    
    if (voucherInfo && voucherInfo.valid) {
      caption += `<b>┃</b> 💵 <b>Harga Awal</b> : ${toRupiah(nominal)}\n`;
      caption += `<b>┃</b> 🏷️ <b>Diskon</b>     : -${toRupiah(discountAmount)}\n`;
      caption += `<b>┃</b> 🎫 <b>Voucher</b>    : <code>${voucherCode}</code>\n`;
    }

    if (qrisData.fee) {
      caption += `<b>┃</b> 🧮 <b>Subtotal</b>  : ${toRupiah(qrisData.amountAsli || (qrisData.jumlah - qrisData.fee))}\n`;
      caption += `<b>┃</b> ⚙️ <b>Biaya Admin</b> : ${toRupiah(qrisData.fee)}\n`;
    }
    
    caption += `<b>┃</b> 💰 <b>Total Bayar</b> : <code>${toRupiah(qrisData.jumlah)}</code>\n`;
    if (qrisData.expired_at) {
      caption += `<b>┃</b> ⏰ <b>Berlaku s/d</b> : ${qrisData.expired_at}\n`;
    }
    caption += `<b>╰━━━━━━━━━━━━━━━━━━━━━━━━❍</b>\n\n`;
    caption += `⚠️ <i>Bayar PAS sesuai nominal di atas, jangan dibulatkan!</i>\n`;
    caption += `✅ <i>Status otomatis terverifikasi begitu QRIS discan &amp; dibayar.</i></blockquote>`;
    
    const msgQris = await ctx.replyWithPhoto(photoToSend, {
      caption: caption,
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("❌ Batalkan", "cancel_trx")]
      ])
    });
    
    // Simpan informasi voucher di activeTransactions jika ada
    const transactionData = { 
      id: qrisData.idtransaksi || qrisData.id, 
      amount: qrisData.jumlah, 
      status: 'pending',
      messageId: msgQris.message_id,
      paymentMethod: activePaymentMethod,
      paymentConfig: paymentConfig,
      itemName: itemName,
      nominal: finalNominal,
      originalPrice: nominal,
      discountAmount: discountAmount,
      voucherCode: voucherCode
    };
    
    // Tambahkan info voucher jika valid
    if (voucherInfo && voucherInfo.valid) {
      transactionData.voucherInfo = voucherInfo;
    }
    
    activeTransactions[userId] = transactionData;
    
    console.log(`[DEBUG] Transaction started for user ${userId}:`, activeTransactions[userId].id);
    
    let attempts = 0;
    const maxAttempts = 72;
    
    const interval = setInterval(async () => {
      attempts++;
      
      if (!activeTransactions[userId]) {
        console.log(`[DEBUG] Transaction ${userId} cancelled, stopping check`);
        clearInterval(interval);
        return;
      }
      
      if (attempts > maxAttempts) {
        console.log(`[DEBUG] Payment timeout for user ${userId} after ${attempts} attempts`);
        clearInterval(interval);
        
        if (activeTransactions[userId]) {
          try {
            if (activeTransactions[userId].messageId) {
              await ctx.deleteMessage(activeTransactions[userId].messageId).catch(() => {});
            }
          } catch (e) {}
          
          delete activeTransactions[userId];
          
          let timeoutMessage = "<blockquote>❌ <b>Waktu pembayaran habis.</b> Silakan ulangi transaksi.</blockquote>";
          if (voucherCode) {
            timeoutMessage += `\n\n<i>Voucher <code>${voucherCode}</code> tidak digunakan karena transaksi dibatalkan.</i>`;
          }
          
          await safeReply(ctx, timeoutMessage, { 
            parse_mode: "HTML" 
          });
        }
        return;
      }
      
      try {
        console.log(`[DEBUG] Checking payment status for user ${userId}, attempt ${attempts}`);
        
        const isPaid = await cekStatus(
          qrisData.idtransaksi || qrisData.id, 
          qrisData.jumlah, 
          paymentConfig
        );
        
        if (isPaid) {
          console.log(`[DEBUG] Payment confirmed for user ${userId}`);
          clearInterval(interval);
          
          try {
            if (activeTransactions[userId]?.messageId) {
              await ctx.deleteMessage(activeTransactions[userId].messageId).catch(() => {});
            }
          } catch (e) {}
          
          // Simpan data transaksi sebelum dihapus
          const transactionData = activeTransactions[userId];
          delete activeTransactions[userId];
          
          const userName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim();
          
          // Kirim testimoni ke channel
          sendTestimoniKeChannel(userName, userId, itemName, finalNominal);
          
          // Kirim notifikasi ke owner dengan info voucher jika ada
          let ownerMessage = `<b>💰 PEMBAYARAN SUKSES</b>\n\n`;
          ownerMessage += `<b>👤 User:</b> ${ctx.from.first_name} (${ctx.from.id})\n`;
          ownerMessage += `<b>🛒 Item:</b> ${itemName}\n`;
          
          if (voucherCode) {
            ownerMessage += `<b>💵 Harga Awal:</b> ${toRupiah(nominal)}\n`;
            ownerMessage += `<b>🎫 Voucher:</b> <code>${voucherCode}</code>\n`;
            ownerMessage += `<b>💰 Diskon:</b> -${toRupiah(discountAmount)}\n`;
            ownerMessage += `<b>💳 Total Bayar:</b> ${toRupiah(finalNominal)}\n`;
          } else {
            ownerMessage += `<b>💵 Harga:</b> ${toRupiah(nominal)}\n`;
          }
          
          ownerMessage += `<b>📊 Status:</b> QRIS Payment (${activePaymentMethod.toUpperCase()})\n`;
          ownerMessage += `<b>⏰ Waktu:</b> ${new Date().toLocaleString()}`;
          
          try {
            await bot.telegram.sendMessage(
              config.ownerId,
              ownerMessage,
              { parse_mode: "HTML" }
            );
          } catch (ownerErr) {
            console.error("[ERROR] Failed to notify owner:", ownerErr.message);
          }
          
          // Tambahkan voucherCode ke productData untuk dicatat di transaksi
          if (voucherCode) {
            productData.voucherCode = voucherCode;
            productData.originalPrice = nominal;
            productData.discountAmount = discountAmount;
          }
          
          await sendProductToUser(ctx, productData);
          sendReceiptImage(ctx, { itemName, nominal: finalNominal, method: `QRIS (${activePaymentMethod})` });
          sendBuyAgainButton(ctx, productData);
          // =====================================================
          if (userState[userId]?.voucherInfo?.voucher?.id) {
            const voucherId = userState[userId].voucherInfo.voucher.id;
            
            const incrementSuccess = incrementVoucherUsage(
              voucherId,
              userId,
              ctx.from.first_name || 'User',
              itemName
            );
            
            if (incrementSuccess) {
              console.log(`[SUCCESS] Penggunaan voucher berhasil dicatat untuk transaksi ${itemName}`);
            } else {
              console.log(`[WARNING] Gagal mencatat penggunaan voucher untuk transaksi ${itemName}`);
            }
            
            // Hapus data voucher dari user state
            delete userState[userId].voucherInfo;
          }
          
        } else {
          console.log(`[DEBUG] Payment not yet confirmed for user ${userId}`);
        }
        
      } catch (error) {
        console.error(`[ERROR] Error checking payment status for user ${userId}:`, error.message);
        
        if (attempts > 10) {
          clearInterval(interval);
          console.error(`[ERROR] Too many errors, stopping check for user ${userId}`);
          
          if (activeTransactions[userId]) {
            delete activeTransactions[userId];
            
            let errorMessage = "<blockquote>⚠️ <b>Terjadi gangguan sistem pembayaran.</b> Silakan hubungi owner.</blockquote>";
            if (voucherCode) {
              errorMessage += `\n\n<i>Voucher <code>${voucherCode}</code> tetap valid untuk transaksi berikutnya.</i>`;
            }
            
            await safeReply(ctx, errorMessage, { 
              parse_mode: "HTML" 
            });
          }
        }
      }
    }, 5000);
    
  } catch (error) {
    console.error("[ERROR] Failed to send QRIS photo:", error.message);
    
    if (activeTransactions[userId]) {
      delete activeTransactions[userId];
    }
    
    let errorMessage = `<b>⚠️ GAGAL MENAMPILKAN QRIS</b>\n\n`;
    errorMessage += `<b>Item:</b> ${itemName}\n`;
    
    if (voucherCode) {
      errorMessage += `<b>Harga Awal:</b> ${toRupiah(nominal)}\n`;
      errorMessage += `<b>Diskon:</b> -${toRupiah(discountAmount)}\n`;
      errorMessage += `<b>Voucher:</b> <code>${voucherCode}</code>\n`;
    }
    
    errorMessage += `<b>Total:</b> ${toRupiah(totalBayar)}\n`;
    errorMessage += `<b>ID Transaksi:</b> ${qrisData.idtransaksi || qrisData.id || '-'}\n`;
    
    if (qrisData.qr_string && qrisData.qr_string.length < 500) {
      errorMessage += `<b>QR String:</b>\n<code>${qrisData.qr_string}</code>\n\n`;
    }
    
    errorMessage += `<i>Silakan hubungi owner untuk pembayaran manual.</i>`;
    
    if (voucherCode) {
      errorMessage += `\n\n<i>Catatan: Voucher <code>${voucherCode}</code> tetap valid untuk transaksi berikutnya.</i>`;
    }
    
    await safeReply(ctx, errorMessage, { parse_mode: "HTML" });
  }
}

bot.action(/delete_sc_(\d+)/, async (ctx) => {
  try {
    const idx = parseInt(ctx.match[1]);
    const db = readDb();
    const sc = db.scripts[idx];

    if (!sc) {
      await ctx.answerCbQuery("❌ Script tidak ditemukan.");
      return;
    }

    db.scripts.splice(idx, 1);
    saveDb(db);

    await ctx.answerCbQuery("✅ Script berhasil dihapus!");
    await ctx.editMessageText("✔️ Script berhasil dihapus.", Markup.inlineKeyboard([[Markup.button.callback("🔙 Kembali", "menu_owner")]]))
      .catch(()=>{ safeReply(ctx, "✔️ Script berhasil dihapus."); });

  } catch (e) {
    console.error("delete_sc error:", e);
  }
});

bot.action(/delete_app_(\d+)/, (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  const idx = parseInt(ctx.match[1]);
  const db = readDb();
  const app = db.apps[idx];
  if (!app) {
    ctx.answerCbQuery("❌ App tidak ditemukan.");
    return showOwnerMenu(ctx);
  }
  db.apps.splice(idx, 1);
  saveDb(db);
  ctx.answerCbQuery(`✅ App ${app?.nama || 'Item'} berhasil dihapus.`);
  showOwnerMenu(ctx);
});

bot.action(/list_accounts_(\d+)/, (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  const idx = parseInt(ctx.match[1]);
  const db = readDb();
  const app = db.apps[idx];
  if (!app) return ctx.answerCbQuery("❌ App tidak ditemukan.");
  const accounts = app.accounts || [];
  let txt = `<b>📄 List Accounts - ${app.nama}</b>\n<b>Stock:</b> ${accounts.length}\n\n`;
  if (!accounts.length) txt += "<i>Belum ada akun.</i>\n";
  accounts.forEach((a, i) => {
    txt += `<b>${i+1}.</b> ${a.user} | ${a.pass} | ${a.link} | ${a.desc || '-'}\n`;
  });
  safeReply(ctx, txt, { parse_mode: "HTML" });
  ctx.answerCbQuery().catch(()=>{});
});

bot.action("owner_add_account", (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  const db = readDb();
  if (!db.apps || db.apps.length === 0) return safeReply(ctx, "<blockquote>❌ <b>Belum ada app yang terdaftar.</b> Tambahkan app terlebih dahulu.</blockquote>", { parse_mode: "HTML" });
  const buttons = db.apps.map((a, i) => [ Markup.button.callback(`${a.nama} (${(a.accounts||[]).length} stok)`, `owner_add_account_to_${i}`) ]);
  buttons.push([ Markup.button.callback("🔙 Kembali", "menu_owner") ]);
  safeReply(ctx, "<blockquote><b>Pilih aplikasi untuk menambah akun:</b></blockquote>", { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
  ctx.answerCbQuery().catch(()=>{});
});

bot.action(/owner_add_account_to_(\d+)/, (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  const idx = parseInt(ctx.match[1]);
  const db = readDb();
  if (!db.apps[idx]) return ctx.answerCbQuery("❌ App tidak ditemukan.");
  userState[ctx.from.id] = { step: "WAITING_ADD_ACCOUNT", appIndex: idx };
  safeReply(ctx, "<blockquote><b>✏️ Kirim akun dengan format:</b>\n<code>username|password|link akses|deskripsi</code></blockquote>", { parse_mode: "HTML" });
  ctx.answerCbQuery().catch(()=>{});
});

bot.action("owner_del_account", (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  const db = readDb();
  if (!db.apps || db.apps.length === 0) return safeReply(ctx, "<blockquote>❌ <b>Belum ada app yang terdaftar.</b></blockquote>", { parse_mode: "HTML" });
  const buttons = db.apps.map((a, i) => [ Markup.button.callback(`${a.nama} (${(a.accounts||[]).length} stok)`, `owner_del_account_choose_${i}`) ]);
  buttons.push([ Markup.button.callback("🔙 Kembali", "menu_owner") ]);
  safeReply(ctx, "<blockquote><b>Pilih aplikasi untuk menghapus akun:</b></blockquote>", { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
  ctx.answerCbQuery().catch(()=>{});
});

bot.action(/owner_del_account_choose_(\d+)/, (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  const idx = parseInt(ctx.match[1]);
  const db = readDb();
  const app = db.apps[idx];
  if (!app) return ctx.answerCbQuery("❌ App tidak ditemukan.");
  const accounts = app.accounts || [];
  if (!accounts.length) return safeReply(ctx, "<blockquote>❌ <b>Tidak ada akun pada aplikasi ini.</b></blockquote>", { parse_mode: "HTML" });
  const buttons = accounts.map((acc, i) => [ Markup.button.callback(`🗑 ${i+1}. ${acc.user} - ${acc.desc || '-'}`, `owner_delete_acc_${idx}_${i}`) ]);
  buttons.push([ Markup.button.callback("🔙 Kembali", "menu_owner") ]);
  safeReply(ctx, `<blockquote><b>Pilih akun yang ingin dihapus dari ${app.nama}:</b></blockquote>`, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
  ctx.answerCbQuery().catch(()=>{});
});

// ================= GMAIL STOCK (OWNER) =================
bot.action("owner_add_gmail_stock", (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  const db = readDb();
  const { idx } = getOrCreateGmailApp(db);
  userState[ctx.from.id] = { step: "WAITING_ADD_GMAIL_STOCK", appIndex: idx };
  safeReply(ctx,
    "<blockquote><b>✏️ Kirim stok akun Gmail.</b>\n\n" +
    "<b>Format per baris:</b>\n<code>email|password</code>\n" +
    "atau <code>email|password|recovery|deskripsi</code>\n\n" +
    "<i>Bisa kirim banyak akun sekaligus, satu akun per baris.</i>\n\n" +
    "<b>Contoh:</b>\n<code>akun1@gmail.com|Password123\nakun2@gmail.com|Password456|recovery@mail.com|Fresh 2026</code></blockquote>",
    { parse_mode: "HTML" }
  );
  ctx.answerCbQuery().catch(()=>{});
});

bot.action("owner_del_gmail_stock", (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  const db = readDb();
  const { app, idx } = getOrCreateGmailApp(db);
  const accounts = app.accounts || [];
  if (!accounts.length) {
    return safeReply(ctx, "<blockquote>❌ <b>Stok Gmail masih kosong.</b></blockquote>", { parse_mode: "HTML" });
  }
  const buttons = accounts.map((acc, i) => [ Markup.button.callback(`🗑 ${i+1}. ${acc.user}`, `owner_delete_acc_${idx}_${i}`) ]);
  buttons.push([ Markup.button.callback("🔙 Kembali", "menu_owner") ]);
  safeReply(ctx, `<blockquote><b>📧 Pilih stok Gmail yang ingin dihapus:</b>\n<b>Stock saat ini:</b> ${accounts.length}</blockquote>`, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
  ctx.answerCbQuery().catch(()=>{});
});

// ================= NOTEL STOCK (OWNER) =================
bot.action("owner_add_notel_stock", (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  const db = readDb();
  const { idx } = getOrCreateNotelApp(db);
  userState[ctx.from.id] = { step: "WAITING_ADD_NOTEL_STOCK", appIndex: idx };
  safeReply(ctx,
    "<blockquote><b>✏️ Kirim stok Notel (nomor telepon).</b>\n\n" +
    "<b>Format per baris:</b>\n<code>nomor|pin_otp</code>\n" +
    "atau <code>nomor|pin_otp|provider|deskripsi</code>\n\n" +
    "<i>Bisa kirim banyak nomor sekaligus, satu nomor per baris.</i>\n\n" +
    "<b>Contoh:</b>\n<code>081234567890|123456\n081298765432|654321|Telkomsel|Fresh 2026</code></blockquote>",
    { parse_mode: "HTML" }
  );
  ctx.answerCbQuery().catch(()=>{});
});

bot.action("owner_del_notel_stock", (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  const db = readDb();
  const { app, idx } = getOrCreateNotelApp(db);
  const accounts = app.accounts || [];
  if (!accounts.length) {
    return safeReply(ctx, "<blockquote>❌ <b>Stok Notel masih kosong.</b></blockquote>", { parse_mode: "HTML" });
  }
  const buttons = accounts.map((acc, i) => [ Markup.button.callback(`🗑 ${i+1}. ${acc.user}`, `owner_delete_acc_${idx}_${i}`) ]);
  buttons.push([ Markup.button.callback("🔙 Kembali", "menu_owner") ]);
  safeReply(ctx, `<blockquote><b>📶 Pilih stok Notel yang ingin dihapus:</b>\n<b>Stock saat ini:</b> ${accounts.length}</blockquote>`, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
  ctx.answerCbQuery().catch(()=>{});
});

bot.action(/owner_delete_acc_(\d+)_(\d+)/, (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  const appIndex = parseInt(ctx.match[1]);
  const accIndex = parseInt(ctx.match[2]);
  const db = readDb();
  const app = db.apps[appIndex];
  if (!app) return ctx.answerCbQuery("❌ App tidak ditemukan.");
  if (!app.accounts || !app.accounts[accIndex]) return ctx.answerCbQuery("❌ Akun tidak ditemukan.");
  const removed = app.accounts.splice(accIndex, 1);
  saveDb(db);
  ctx.answerCbQuery("✅ Akun dihapus.");
  safeReply(ctx, `<blockquote><b>✅ Akun ${removed[0].user} telah dihapus dari ${app.nama}</b></blockquote>`, { parse_mode: "HTML" });
});

async function sendProductToUser(ctx, productData) {
  try {
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name || 'User';

    // Ambil informasi voucher dari productData
    const voucherCode = productData.voucherCode || null;
    const originalPrice = productData.originalPrice || 0;
    const discountAmount = productData.discountAmount || 0;
    const finalPrice = productData.finalPrice || (originalPrice - discountAmount);

    // Log penggunaan voucher
    if (voucherCode) {
      console.log(`[VOUCHER] User ${userId} menggunakan voucher: ${voucherCode}`);
      console.log(`[VOUCHER] Harga asli: ${originalPrice}, Diskon: ${discountAmount}, Harga akhir: ${finalPrice}`);
    }

    if (productData.type === "script") {
      const db = readDb();
      const item = db.scripts[productData.index];
      
      if (!item) {
        return safeReply(ctx, "<blockquote>❌ <b>Script tidak ditemukan!</b> Silakan hubungi owner.</blockquote>", { 
          parse_mode: "HTML" 
        });
      }
      
      if (!item.file_id) {
        return safeReply(ctx, "<blockquote>❌ <b>File script tidak tersedia!</b> Silakan hubungi owner.</blockquote>", { 
          parse_mode: "HTML" 
        });
      }
      
      // Pesan sukses dengan info voucher jika ada
      let successMessage = "<blockquote>✅ <b>Pembayaran valid! Mengirim file...</b></blockquote>";
      
      if (voucherCode) {
        successMessage += `\n<blockquote>🎫 <b>Voucher diterapkan:</b> <code>${voucherCode}</code>\n<b>Diskon:</b> -${toRupiah(discountAmount)}</blockquote>`;
      }
      
      await safeReply(ctx, successMessage, { 
        parse_mode: "HTML" 
      });
      
      // Caption file dengan info voucher jika ada
      let fileCaption = `<b>📦 ${item.nama}</b>\n\n`;
      
      if (voucherCode) {
        fileCaption += `<b>💰 Harga Awal:</b> ${toRupiah(originalPrice)}\n`;
        fileCaption += `<b>🎫 Voucher:</b> <code>${voucherCode}</code>\n`;
        fileCaption += `<b>💰 Diskon:</b> -${toRupiah(discountAmount)}\n`;
        fileCaption += `<b>💳 Total Bayar:</b> ${toRupiah(finalPrice)}\n\n`;
      } else {
        fileCaption += `<b>💰 Harga:</b> ${toRupiah(item.harga)}\n\n`;
      }
      
      fileCaption += `<b>📝 Deskripsi:</b>\n${item.deskripsi || 'Tidak ada deskripsi'}\n\n`;
      fileCaption += `<i>Terima kasih telah berbelanja!</i>`;
      
      await ctx.replyWithDocument(item.file_id, { 
        caption: fileCaption,
        filename: item.fileName || `${item.nama}.zip`,
        parse_mode: "HTML"
      });

      // CATAT TRANSAKSI SCRIPT dengan info voucher
      recordTransaction(
        userId, 
        username, 
        `Script: ${item.nama}`, 
        finalPrice, 
        'script',
        voucherCode,
        originalPrice,
        discountAmount
      );

      const userName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim();
      
      // Kirim testimoni dengan info voucher jika ada
      let testimoniItemName = `Script: ${item.nama}`;
      if (voucherCode) {
        testimoniItemName += ` (Voucher: ${voucherCode})`;
      }
      
      sendTestimoniKeChannel(userName, userId, testimoniItemName, finalPrice);
      } else if (productData.type === "app") {
      const db = readDb();
      const app = db.apps[productData.idx];
      
      if (!app) {
        return safeReply(ctx, "<blockquote>❌ <b>Aplikasi tidak ditemukan!</b> Silakan hubungi owner.</blockquote>", { 
          parse_mode: "HTML" 
        });
      }
      
      app.accounts = app.accounts || [];
      
      if (app.accounts.length < productData.qty) {
        return safeReply(ctx, `<blockquote>❌ <b>Stok tidak mencukupi!</b>\nStok tersedia: ${app.accounts.length}\nYang dibeli: ${productData.qty}</blockquote>`, { 
          parse_mode: "HTML" 
        });
      }
      
      const taken = [];
      for (let i = 0; i < productData.qty; i++) {
        const acc = app.accounts.shift();
        if (acc) taken.push(acc);
      }
      
      saveDb(db);
      checkLowStockAlert(app);
      const totalWithDiscount = voucherCode ? (productData.total - discountAmount) : productData.total;
      
      let msg = `<blockquote><b>╭━━━━✧「 ✅ 𝗧𝗥𝗔𝗡𝗦𝗔𝗞𝗦𝗜 𝗦𝗨𝗞𝗦𝗘𝗦 」✧━━━━❍</b>\n<b>┃</b> 📦 Produk      : ${app.nama}\n<b>┃</b> 🔢 Jumlah Beli : ${productData.qty}\n`;
      
      if (voucherCode) {
        msg += `<b>┃</b> 💵 Harga Awal   : ${toRupiah(originalPrice)}\n`;
        msg += `<b>┃</b> 🎫 Voucher      : <code>${voucherCode}</code>\n`;
        msg += `<b>┃</b> 🏷️ Diskon        : -${toRupiah(discountAmount)}\n`;
        msg += `<b>┃</b> 💰 Total Harga  : ${toRupiah(totalWithDiscount)}\n`;
      } else {
        msg += `<b>┃</b> 💰 Total Harga  : ${toRupiah(productData.total)}\n`;
      }
      
      msg += `<b>┃</b> 📝 Deskripsi    : ${app.deskripsi || '-'}\n<b>╰━━━━━━━━━━━━━━━━━━━━━━━━❍</b></blockquote>`;
      if (productData.note) {
        msg += `<blockquote>📝 <b>Catatan kamu:</b> ${productData.note}</blockquote>`;
      }
      
      // Tambahkan info voucher di pesan sukses
      if (voucherCode) {
        msg += `<blockquote>🎫 <b>Voucher berhasil digunakan!</b> Kode: <code>${voucherCode}</code></blockquote>`;
      }
      
      taken.forEach((a, i) => {
        msg += `<blockquote><b>╭━━━━✧「 🔑 AKUN ${i+1} 」✧━━━━❍</b>\n<b>┃</b> 👤 Username : <code>${a.user}</code>\n<b>┃</b> 🔒 Password : <code>${a.pass}</code>\n<b>┃</b> 🔗 Link     : ${a.link}\n<b>┃</b> 📝 Info     : ${a.desc || '-'}\n<b>╰━━━━━━━━━━━━━━━━━━━━━━━━❍</b></blockquote>`;
      });
      
      safeReply(ctx, msg, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "🔄 Beli Lagi", callback_data: `buy_app_${productData.idx}` }]] },
      });

      // CATAT TRANSAKSI APP dengan info voucher
      recordTransaction(
        userId, 
        username, 
        `App: ${app.nama} x${productData.qty}`, 
        totalWithDiscount, 
        'app',
        voucherCode,
        originalPrice,
        discountAmount
      );

      const userName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim();
      
      // Kirim testimoni dengan info voucher jika ada
      let testimoniItemName = `App: ${app.nama} x${productData.qty}`;
      if (voucherCode) {
        testimoniItemName += ` (Voucher: ${voucherCode})`;
      }
      
      sendTestimoniKeChannel(userName, userId, testimoniItemName, totalWithDiscount);

      if (productData.note) {
        bot.telegram.sendMessage(
          config.ownerId,
          `<blockquote>📝 <b>Catatan dari pembeli</b>\n\n<b>User:</b> ${userName} (${userId})\n<b>Produk:</b> ${app.nama}\n<b>Catatan:</b> ${productData.note}</blockquote>`,
          { parse_mode: "HTML" }
        ).catch((e) => console.error("[NOTE] Gagal kirim catatan ke owner:", e.message));
      }
       } 
    else if (productData.type === "muridpanel") {
      const muridPanelData = productData.muridPanelData;
      
      if (!muridPanelData) {
        throw new Error("Data murid panel tidak ditemukan!");
      }
      
      const username = generateMuridUsername();
      const email = `${username.toLowerCase()}@student.com`;
      const password = generateMuridPassword();
      
      // Proses pembuatan akun murid panel
      const result = await createMuridPanelAccount(
        username,
        email,
        password,
        muridPanelData.panelType,
        muridPanelData.panelCategory,
        muridPanelData.duration
      );
      
      if (!result.success) {
        throw new Error(result.msg || "Gagal membuat akun murid panel");
      }
      
      // Kirim detail murid panel ke user
      const panelInfo = `
<b>✅ PEMBELIAN MURID PANEL BERHASIL!</b>

👨‍🎓 <b>Kategori:</b> ${muridPanelData.panelCategory}
🏷️ <b>Tipe:</b> ${muridPanelData.panelType.toUpperCase()} PANEL
📅 <b>Durasi:</b> ${muridPanelData.duration === "bulanan" ? "1 Bulan" : "Permanen"}
👤 <b>Username:</b> ${result.data.username}
📧 <b>Email:</b> ${result.data.email}
🔑 <b>Password:</b> ${result.data.password}
🔗 <b>Login URL:</b> ${result.data.login}
💰 <b>Harga:</b> ${toRupiah(paymentData.amount)}
📅 <b>Expired:</b> ${result.data.expires}

<b>🎯 FITUR MURID PANEL:</b>
• Akses server sendiri
• Buat server sendiri
• Lihat server sendiri
• Konfigurasi server sendiri
• Monitoring server sendiri
• Tools terbatas untuk murid

<b>⚠️ PERHATIAN:</b>
• Segera ganti password untuk keamanan
• Simpan baik-baik informasi login
• Hak akses terbatas (student role)
• Tidak termasuk refund setelah akun dibuat
      `.trim();
      
      await ctx.reply(panelInfo, { parse_mode: "HTML" });
      
      // Catat transaksi
      recordTransaction(
        userId,
        userName,
        `Murid Panel ${muridPanelData.panelCategory} - ${muridPanelData.panelType} - ${muridPanelData.duration}`,
        paymentData.amount,
        'muridpanel',
        paymentData.voucherCode // Tambahkan voucher code
      );
      
      // Kirim testimoni ke channel
      await sendTestimoniKeChannel(
        userName,
        userId,
        `Murid Panel ${muridPanelData.panelCategory} - ${muridPanelData.panelType}`,
        paymentData.amount
      );
      
      // Kirim notifikasi ke owner
      if (config.ownerId) {
        const timestamp = new Date().toLocaleString("id-ID", {
          timeZone: "Asia/Jakarta"
        });
        
        const ownerMessage = `
👨‍🎓 <b>MURID PANEL BERHASIL DIBUAT!</b>

<b>User:</b> ${userName} (${userId})
<b>Kategori:</b> ${muridPanelData.panelCategory}
<b>Tipe:</b> ${muridPanelData.panelType.toUpperCase()}
<b>Durasi:</b> ${muridPanelData.duration === "bulanan" ? "1 Bulan" : "Permanen"}
<b>Username:</b> ${result.data.username}
<b>Email:</b> ${result.data.email}
<b>Password:</b> ${result.data.password}
<b>Harga:</b> ${toRupiah(paymentData.amount)}
<b>Waktu:</b> ${timestamp}
        `.trim();
        
        await bot.telegram.sendMessage(config.ownerId, ownerMessage, {
          parse_mode: "HTML"
        });
      }
    }
       else if (productData.type === "panel") {
      // Pesan loading dengan info voucher jika ada
      let loadingMsg = "<blockquote>⏳ <b>Sedang membuat akun panel...</b></blockquote>";
      if (voucherCode) {
        loadingMsg += `\n<blockquote>🎫 <b>Voucher diterapkan:</b> <code>${voucherCode}</code></blockquote>`;
      }
      
      ctx.reply(loadingMsg, { parse_mode: "HTML" });
      
      let disk, cpu;
      if (productData.ram === 0) {
        disk = 0;
        cpu = 0;
      } else {
        const gb = productData.ram / 1024;
        disk = gb * 2048;
        cpu = gb * 50;
      }
      
      const result = await createPanelAccount(productData.username, productData.ram, disk, cpu);
      
      if (result.success) {
        const d = result.data;
        
        // Hitung harga dengan diskon jika ada voucher
        const finalPanelPrice = voucherCode ? (productData.price - discountAmount) : productData.price;
        
        let panelMessage = `<blockquote><b>✅ PANEL BERHASIL DIBUAT</b>\n\n`;
        panelMessage += `<b>👤 User:</b> ${productData.username}\n`;
        panelMessage += `<b>🆔 ID:</b> <code>${d.username}</code>\n`;
        panelMessage += `<b>🔑 PW:</b> <code>${d.password}</code>\n`;
        panelMessage += `<b>🌐 Login:</b> ${d.login}\n\n`;
        
        if (voucherCode) {
          panelMessage += `<b>🎫 Voucher:</b> <code>${voucherCode}</code>\n`;
          panelMessage += `<b>💰 Harga Awal:</b> ${toRupiah(originalPrice)}\n`;
          panelMessage += `<b>💰 Diskon:</b> -${toRupiah(discountAmount)}\n`;
          panelMessage += `<b>💳 Total Bayar:</b> ${toRupiah(finalPanelPrice)}</blockquote>`;
        } else {
          panelMessage += `<b>💰 Harga:</b> ${toRupiah(productData.price)}</blockquote>`;
        }
        
        ctx.reply(panelMessage, { parse_mode: "HTML" });

        // CATAT TRANSAKSI PANEL dengan info voucher
        recordTransaction(
          userId, 
          username, 
          `Panel ${productData.ram === 0 ? "Unlimited" : productData.ram/1024 + "GB"}`, 
          finalPanelPrice, 
          'panel',
          voucherCode,
          originalPrice,
          discountAmount
        );

        const userName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim();
        
        // Kirim testimoni dengan info voucher jika ada
        let testimoniItemName = `Panel ${productData.ram === 0 ? "Unlimited" : productData.ram/1024 + "GB"}`;
        if (voucherCode) {
          testimoniItemName += ` (Voucher: ${voucherCode})`;
        }
        
        sendTestimoniKeChannel(userName, userId, testimoniItemName, finalPanelPrice);

      } else {
        ctx.reply(`<blockquote>⚠️ <b>Gagal:</b> ${result.msg}</blockquote>`, { parse_mode: "HTML" });
      }
      
    } else if (productData.type === "adminpanel") {
      const adminPanelData = productData.adminPanelData;
      
      // Hitung harga dengan diskon jika ada voucher
      const finalAdminPrice = voucherCode ? (adminPanelData.harga - discountAmount) : adminPanelData.harga;
      
      let loadingMsgText = "<blockquote>⏳ <b>Sedang membuat akun Admin Panel...</b>\nProses membutuhkan waktu ±2 menit.</blockquote>";
      if (voucherCode) {
        loadingMsgText += `\n<blockquote>🎫 <b>Voucher diterapkan:</b> <code>${voucherCode}</code>\n<b>Diskon:</b> -${toRupiah(discountAmount)}</blockquote>`;
      }
      
      const loadingMsg = await ctx.reply(loadingMsgText, { 
        parse_mode: "HTML" 
      });
      
      try {
        // Generate username dan password
        const randomNum = Math.floor(Math.random() * 900) + 100;
        const panelUsername = `admin${randomNum}`;
        const panelEmail = `${panelUsername}@gmail.com`;
        const panelPassword = `Admin${randomNum}#${adminPanelData.panelType === "private" ? "PRIVATE" : "PUBLIC"}`;
        
        const result = await createAdminPanelAccount(
          panelUsername,
          panelEmail,
          panelPassword,
          adminPanelData.panelType,
          adminPanelData.duration
        );
        
        try {
          await ctx.deleteMessage(loadingMsg.message_id);
        } catch (e) {}
        
        if (result.success) {
          const data = result.data;
          const panelTypeText = adminPanelData.panelType === "private" ? "PRIVATE" : "PUBLIC";
          const durasiText = adminPanelData.duration === "bulanan" ? "1 Bulan" : "Permanen";
          
          // SIMPAN DATA KE DATABASE ADMIN PANEL ORDERS
          const orderData = {
            userId: ctx.from.id,
            userName: `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim(),
            userUsername: ctx.from.username ? `@${ctx.from.username}` : '',
            panelType: adminPanelData.panelType,
            duration: adminPanelData.duration,
            username: data.username,
            email: data.email,
            password: panelPassword,
            loginUrl: data.login,
            price: finalAdminPrice,
            expires: data.expires,
            voucherCode: voucherCode,
            originalPrice: originalPrice,
            discountAmount: discountAmount
          };
          
          addAdminPanelOrder(orderData);
          
          let detailPanel = `<blockquote>✅ <b>ADMIN PANEL BERHASIL DIBUAT!</b></blockquote>

<blockquote>🔐 <b>LOGIN DETAILS</b>
━━━━━━━━━━━━━━━━━━━━━━
<b>🌐 PANEL URL:</b> <code>${data.login}</code>
<b>👤 USERNAME:</b> <code>${data.username}</code>
<b>📧 EMAIL:</b> <code>${data.email}</code>
<b>🔐 PASSWORD:</b> <code>${panelPassword}</code>
<b>🏷️ TIPE:</b> ${panelTypeText}
<b>📅 DURASI:</b> ${durasiText}
<b>⏳ EXPIRED:</b> ${data.expires}</blockquote>`;

          // Tambahkan info voucher jika ada
          if (voucherCode) {
            detailPanel += `<blockquote>🎫 <b>INFO VOUCHER</b>
━━━━━━━━━━━━━━━━━━━━━━
<b>Kode:</b> <code>${voucherCode}</code>
<b>Harga Awal:</b> ${toRupiah(originalPrice)}
<b>Diskon:</b> -${toRupiah(discountAmount)}
<b>Total Bayar:</b> ${toRupiah(finalAdminPrice)}</blockquote>`;
          }

          detailPanel += `<blockquote>⚠️ <b>INFORMASI PENTING</b>
━━━━━━━━━━━━━━━━━━━━━━
• Simpan baik-baik informasi login di atas
• Password bisa diubah setelah login
• Akses semua fitur administrator
• Jika lupa password, hubungi admin
• Garansi 3 hari untuk masalah teknis
• Group Buyer AdminPanel: <a href="${config.GbAdminPanel}">KLIK DISINI</a></blockquote>

<blockquote>🛠️ <b>FITUR YANG DIDAPATKAN</b>
━━━━━━━━━━━━━━━━━━━━━━
• 📋 Akses semua server
• 👥 Kelola semua user
• 🖥️ Buat/hapus server
• 🌐 Kelola nodes/locations
• 🔧 Konfigurasi lengkap
• 📊 Monitoring real-time
• 🛠️ Tools administrator</blockquote>`;
          
          await ctx.reply(detailPanel, { parse_mode: "HTML" });
          
          // CATAT TRANSAKSI ADMINPANEL dengan info voucher
          recordTransaction(
            userId, 
            ctx.from.first_name || 'User',
            `Admin Panel ${panelTypeText} - ${durasiText}`, 
            finalAdminPrice, 
            'adminpanel',
            voucherCode,
            originalPrice,
            discountAmount
          );
          
          // Kirim notifikasi ke channel testimoni
          const userName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim();
          
          let testimoniItemName = `Admin Panel ${panelTypeText} - ${durasiText}`;
          if (voucherCode) {
            testimoniItemName += ` (Voucher: ${voucherCode})`;
          }
          
          sendTestimoniKeChannel(userName, userId, testimoniItemName, finalAdminPrice);
          
          // Kirim notifikasi ke owner dengan info voucher jika ada
          let ownerMessage = `<b>💰 ADMIN PANEL TERJUAL!</b>\n\n`;
          ownerMessage += `<b>👤 Pembeli:</b> ${ctx.from.first_name} (${userId})\n`;
          ownerMessage += `<b>🏷️ Tipe:</b> ${panelTypeText}\n`;
          ownerMessage += `<b>📅 Durasi:</b> ${durasiText}\n`;
          
          if (voucherCode) {
            ownerMessage += `<b>🎫 Voucher:</b> <code>${voucherCode}</code>\n`;
            ownerMessage += `<b>💰 Harga Awal:</b> ${toRupiah(originalPrice)}\n`;
            ownerMessage += `<b>💰 Diskon:</b> -${toRupiah(discountAmount)}\n`;
            ownerMessage += `<b>💳 Total Bayar:</b> ${toRupiah(finalAdminPrice)}\n`;
          } else {
            ownerMessage += `<b>💰 Harga:</b> ${toRupiah(adminPanelData.harga)}\n`;
          }
          
          ownerMessage += `<b>👤 Username:</b> ${data.username}\n`;
          ownerMessage += `<b>🔐 Password:</b> ${panelPassword}\n`;
          ownerMessage += `<b>📧 Email:</b> ${data.email}\n`;
          ownerMessage += `<b>⏰ Waktu:</b> ${new Date().toLocaleString("id-ID")}`;
          
          try {
            await bot.telegram.sendMessage(
              config.ownerId,
              ownerMessage,
              { parse_mode: "HTML" }
            );
          } catch (ownerErr) {}
          
        } else {
          await ctx.reply(`<blockquote>❌ <b>Gagal membuat Admin Panel:</b> ${result.msg}</blockquote>`, { 
            parse_mode: "HTML" 
          });
          
          await ctx.reply(
            `<blockquote>⚠️ <b>TRANSAKSI GAGAL</b>

Maaf, terjadi kesalahan saat membuat Admin Panel Anda.

Silakan:
1. Hubungi admin untuk bantuan
2. Atau minta refund melalui admin
3. Admin akan membantu Anda segera</blockquote>`,
            { parse_mode: "HTML" }
          );
        }
        
        // Hapus data dari userState
        if (userState[userId]?.adminPanelData) {
          delete userState[userId].adminPanelData;
        }
        
      } catch (error) {
        try {
          await ctx.deleteMessage(loadingMsg.message_id);
        } catch (e) {}
        
        await ctx.reply(`<blockquote>❌ <b>Error sistem Admin Panel:</b> ${error.message}</blockquote>`, { 
          parse_mode: "HTML" 
        });
        
        console.error("[ERROR] Admin Panel creation error:", error);
      }
       } else if (productData.type === "vps") {
      // Hitung harga dengan diskon jika ada voucher
      const vpsNominal = productData.vpsData?.harga || 0;
      const finalVpsPrice = voucherCode ? (vpsNominal - discountAmount) : vpsNominal;
      
      let loadingMsgText = "<blockquote>⏳ <b>Sedang membuat VPS DigitalOcean...</b>\nProses membutuhkan waktu ±60 detik.</blockquote>";
      if (voucherCode) {
        loadingMsgText += `\n<blockquote>🎫 <b>Voucher diterapkan:</b> <code>${voucherCode}</code>\n<b>Diskon:</b> -${toRupiah(discountAmount)}</blockquote>`;
      }
      
      const loadingMsg = await ctx.reply(loadingMsgText, { 
        parse_mode: "HTML" 
      });
      
      try {
        productData.vpsData.username = username;
        
        const result = await createVPSDroplet(userId, productData.vpsData);
        
        try {
          await ctx.deleteMessage(loadingMsg.message_id);
        } catch (e) {}
        
        if (result.success) {
          const data = result.data;
          const paketInfo = {
            low: { garansi: 15, replace: 1 },
            medium: { garansi: 25, replace: 2 },
            high: { garansi: 30, replace: -1 }
          };
          
          const paket = productData.vpsData.paket;
          
          let detailVPS = `<blockquote>✅ <b>VPS BERHASIL DIBUAT!</b></blockquote>

<blockquote>🖥️ <b>DETAIL DATA VPS</b>
━━━━━━━━━━━━━━━━━━━━━━
<b>🌐 IP ADDRESS:</b> <code>${data.ip}</code>
<b>🆔 USERNAME:</b> <code>root</code>
<b>🔐 PASSWORD:</b> <code>${data.password}</code>
<b>🧩 HOSTNAME:</b> ${data.hostname}
<b>🌍 REGION:</b> ${data.region.toUpperCase()}
<b>💿 OS:</b> ${data.os.toUpperCase()}</blockquote>

<blockquote>🛍️ <b>DETAIL PEMBELIAN</b>
━━━━━━━━━━━━━━━━━━━━━━
<b>📦 PAKET:</b> ${paket.toUpperCase()}
<b>💾 SPESIFIKASI:</b> ${productData.vpsData.plan}`;
          
          // Tambahkan info voucher jika ada
          if (voucherCode) {
            detailVPS += `\n<b>🎫 VOUCHER:</b> <code>${voucherCode}</code>`;
            detailVPS += `\n<b>💰 HARGA AWAL:</b> ${toRupiah(originalPrice)}`;
            detailVPS += `\n<b>💰 DISKON:</b> -${toRupiah(discountAmount)}`;
            detailVPS += `\n<b>💳 TOTAL BAYAR:</b> ${toRupiah(finalVpsPrice)}`;
          } else {
            detailVPS += `\n<b>💰 HARGA:</b> ${toRupiah(vpsNominal)}`;
          }
          
          detailVPS += `\n<b>🛡️ GARANSI:</b> ${paketInfo[paket].garansi} Hari
<b>♻️ REPLACE:</b> ${paketInfo[paket].replace === -1 ? "Unlimited" : paketInfo[paket].replace + "x"}
<b>📅 TANGGAL:</b> ${data.created}
<b>👤 PEMBELI:</b> ${username}
<b>🤝 PENJUAL:</b> @${bot.botInfo.username}</blockquote>`;
          
          await ctx.reply(detailVPS, { parse_mode: "HTML" });
          
          await ctx.reply(
`<blockquote>📌 <b>INFORMASI PENTING</b>
━━━━━━━━━━━━━━━━━━━━━━
• Gunakan IP <code>${data.ip}</code> untuk akses VPS
• Login dengan username <code>root</code> dan password di atas
• VPS sudah ready untuk digunakan
• Jika ada masalah, silakan hubungi admin</blockquote>`,
            { parse_mode: "HTML" }
          );
          
          // CATAT TRANSAKSI VPS dengan info voucher
          recordTransaction(
            userId, 
            username, 
            `VPS ${productData.vpsData.paket.toUpperCase()} - ${productData.vpsData.plan}`, 
            finalVpsPrice, 
            'vps',
            voucherCode,
            originalPrice,
            discountAmount
          );
          
          try {
            // Kirim testimoni ke channel dengan info voucher jika ada
            let testimoniText = `🖥️ *VPS BERHASIL DIBELI!*\n\n`;
            testimoniText += `👤 *Pembeli:* ${username}\n`;
            testimoniText += `🌐 *IP:* \`${data.ip}\`\n`;
            testimoniText += `📦 *Paket:* ${paket.toUpperCase()}\n`;
            testimoniText += `💾 *Spesifikasi:* ${productData.vpsData.plan}\n`;
            
            if (voucherCode) {
              testimoniText += `🎫 *Voucher:* \`${voucherCode}\`\n`;
              testimoniText += `💰 *Harga Awal:* ${toRupiah(originalPrice)}\n`;
              testimoniText += `💰 *Diskon:* -${toRupiah(discountAmount)}\n`;
              testimoniText += `💳 *Total Bayar:* ${toRupiah(finalVpsPrice)}\n`;
            } else {
              testimoniText += `💰 *Harga:* ${toRupiah(vpsNominal)}\n`;
            }
            
            testimoniText += `🕒 *Waktu:* ${new Date().toLocaleString("id-ID")}\n\n`;
            testimoniText += `🎉 *Transaksi sukses!*`;
            
            await bot.telegram.sendMessage(config.testimoniChannel, testimoniText, {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🛒 Beli VPS", url: `https://t.me/${bot.botInfo.username}?start=shop` }]
                ]
              }
            });
          } catch (channelErr) {}
          
          try {
            // Kirim notifikasi ke owner dengan info voucher jika ada
            let ownerMessage = `<b>💰 VPS TERJUAL!</b>\n\n`;
            ownerMessage += `<b>👤 Pembeli:</b> ${username} (${userId})\n`;
            ownerMessage += `<b>🌐 IP VPS:</b> <code>${data.ip}</code>\n`;
            ownerMessage += `<b>🔐 Password:</b> <code>${data.password}</code>\n`;
            ownerMessage += `<b>📦 Paket:</b> ${paket.toUpperCase()}\n`;
            
            if (voucherCode) {
              ownerMessage += `<b>🎫 Voucher:</b> <code>${voucherCode}</code>\n`;
              ownerMessage += `<b>💰 Harga Awal:</b> ${toRupiah(originalPrice)}\n`;
              ownerMessage += `<b>💰 Diskon:</b> -${toRupiah(discountAmount)}\n`;
              ownerMessage += `<b>💳 Total Bayar:</b> ${toRupiah(finalVpsPrice)}\n`;
            } else {
              ownerMessage += `<b>💰 Harga:</b> ${toRupiah(vpsNominal)}\n`;
            }
            
            ownerMessage += `<b>⏰ Waktu:</b> ${new Date().toLocaleString("id-ID")}`;
            
            await bot.telegram.sendMessage(
              config.ownerId,
              ownerMessage,
              { parse_mode: "HTML" }
            );
          } catch (ownerErr) {}
          
          const userName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim();
          
          // Kirim testimoni dengan info voucher jika ada
          let testimoniItemName = `VPS ${paket.toUpperCase()} - ${productData.vpsData.plan}`;
          if (voucherCode) {
            testimoniItemName += ` (Voucher: ${voucherCode})`;
          }
          
          sendTestimoniKeChannel(userName, userId, testimoniItemName, finalVpsPrice);
          
        } else {
          await ctx.reply(`<blockquote>❌ <b>Gagal membuat VPS:</b> ${result.msg}</blockquote>`, { 
            parse_mode: "HTML" 
          });
          
          await ctx.reply(
`<blockquote>⚠️ <b>TRANSAKSI GAGAL</b>

Maaf, terjadi kesalahan saat membuat VPS Anda.

Silakan:
1. Hubungi admin untuk bantuan
2. Atau minta refund melalui admin
3. Admin akan membantu Anda segera</blockquote>`,
            { parse_mode: "HTML" }
          );
          
          try {
            let ownerErrorMsg = `<b>🚨 ERROR BUAT VPS!</b>\n\n`;
            ownerErrorMsg += `<b>👤 User:</b> ${username} (${userId})\n`;
            
            if (voucherCode) {
              ownerErrorMsg += `<b>🎫 Voucher:</b> <code>${voucherCode}</code>\n`;
              ownerErrorMsg += `<b>💰 Harga Awal:</b> ${toRupiah(originalPrice)}\n`;
              ownerErrorMsg += `<b>💰 Diskon:</b> -${toRupiah(discountAmount)}\n`;
              ownerErrorMsg += `<b>💳 Total Transaksi:</b> ${toRupiah(finalVpsPrice)}\n`;
            } else {
              ownerErrorMsg += `<b>💰 Transaksi:</b> ${toRupiah(vpsNominal)}\n`;
            }
            
            ownerErrorMsg += `<b>❌ Error:</b> ${result.msg}\n`;
            ownerErrorMsg += `<b>📦 Paket:</b> ${productData.vpsData.paket.toUpperCase()}\n`;
            ownerErrorMsg += `<b>💾 Plan:</b> ${productData.vpsData.plan}\n`;
            ownerErrorMsg += `<b>🌍 Region:</b> ${productData.vpsData.region}\n\n`;
            ownerErrorMsg += `<i>Silakan handle manual!</i>`;
            
            await bot.telegram.sendMessage(
              config.ownerId,
              ownerErrorMsg,
              { parse_mode: "HTML" }
            );
          } catch (notifyErr) {}
        }
        
        if (userState[userId]?.vpsData) {
          delete userState[userId].vpsData;
        }
        
      } catch (error) {
        try {
          await ctx.deleteMessage(loadingMsg.message_id);
        } catch (e) {}
        
        await ctx.reply(`<blockquote>❌ <b>Error sistem VPS:</b> ${error.message}</blockquote>`, { 
          parse_mode: "HTML" 
        });
        
        try {
          await bot.telegram.sendMessage(
            config.ownerId,
            `<b>🚨 ERROR SISTEM VPS!</b>\n\n` +
            `<b>👤 User:</b> ${username} (${userId})\n` +
            `<b>❌ Error:</b> ${error.message}\n` +
            `<b>🔧 Stack:</b> <code>${error.stack || "No stack"}</code>\n\n` +
            `<i>Perlu penanganan manual!</i>`,
            { parse_mode: "HTML" }
          );
        } catch (notifyErr) {}
      }
    }
  } catch (error) {
    console.error("[ERROR] Error sending product:", error);
    safeReply(ctx, "<blockquote>❌ <b>Gagal mengirim produk.</b> Silakan hubungi owner.</blockquote>", { parse_mode: "HTML" });
  }
}

bot.on("photo", async (ctx) => {
  try {
    const userId = ctx.from.id;
    const state = userState[userId];
    
    if (state?.step === "PAYMENT_MANUAL_PENDING") {
      const photos = ctx.message.photo || [];
      if (photos.length === 0) {
        await ctx.reply("❌ Foto tidak ditemukan. Silakan kirim ulang.");
        return;
      }
      
      const bestPhoto = photos[photos.length - 1];
      
      const paymentData = {
        userId: userId,
        userName: `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim(),
        userUsername: ctx.from.username ? `@${ctx.from.username}` : '-',
        itemName: state.itemName,
        amount: state.amount,
        nominal: state.nominal,
        proofPhotoId: bestPhoto.file_id,
        timestamp: Date.now(),
        status: "pending",
        productData: state.productData
      };
      
      const payments = readManualPayments();
      const paymentIndex = payments.length;
      payments.push(paymentData);
      saveManualPayments(payments);
      
      delete userState[userId];
      
      try {
        await bot.telegram.sendPhoto(config.ownerId, paymentData.proofPhotoId, {
          caption: `<blockquote><b>🧾 BUKTI PEMBAYARAN MANUAL</b>\n\n<b>👤 User:</b> ${paymentData.userName}\n<b>🆔 ID:</b> ${paymentData.userId}\n<b>📛 Username:</b> ${paymentData.userUsername}\n\n<b>🛒 Item:</b> ${paymentData.itemName}\n<b>💰 Amount:</b> ${toRupiah(paymentData.amount)}\n<b>⏰ Time:</b> ${new Date(paymentData.timestamp).toLocaleString()}\n\n<i>Verifikasi pembayaran ini:</i></blockquote>`,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Terima & Kirim Produk", callback_data: `approve_payment_${paymentIndex}` },
                { text: "❌ Tolak", callback_data: `reject_payment_${paymentIndex}` }
              ]
            ]
          }
        });
        
        await ctx.reply("<blockquote>✅ <b>Bukti pembayaran telah dikirim ke owner!</b>\nSilakan tunggu verifikasi. Status akan diberitahu.</blockquote>", { parse_mode: "HTML" });
        
      } catch (ownerError) {
        console.error("[ERROR] Error sending to owner:", ownerError);
        await ctx.reply("<blockquote>❌ <b>Gagal mengirim bukti ke owner.</b> Silakan coba lagi atau hubungi owner langsung.</blockquote>", { parse_mode: "HTML" });
        userState[userId] = state;
      }
      
      return;
    }
    
  } catch (e) {
    console.error("[ERROR] Payment proof error:", e);
    try {
      await ctx.reply("<blockquote>❌ <b>Terjadi kesalahan saat memproses bukti pembayaran.</b> Silakan coba lagi.</blockquote>", { parse_mode: "HTML" });
    } catch (replyError) {
      console.error("[ERROR] Cannot send error message:", replyError);
    }
  }
});

bot.action(/approve_payment_(\d+)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    await ctx.answerCbQuery("❌ Hanya owner yang boleh verifikasi!", { show_alert: true });
    return;
  }
  
  const paymentIndex = parseInt(ctx.match[1]);
  const payments = readManualPayments();
  const payment = payments[paymentIndex];
  
  if (!payment) {
    await ctx.answerCbQuery("❌ Pembayaran tidak ditemukan!", { show_alert: true });
    return;
  }
  
  if (payment.status !== "pending") {
    await ctx.answerCbQuery("❌ Pembayaran sudah diverifikasi!", { show_alert: true });
    return;
  }
  
  payment.status = "approved";
  payment.approvedBy = ctx.from.id;
  payment.approvedAt = Date.now();
  saveManualPayments(payments);
  
  try {
    await ctx.editMessageCaption(`<blockquote><b>✅ PEMBAYARAN DITERIMA</b>\n\n<b>👤 User:</b> ${payment.userName}\n<b>🛒 Item:</b> ${payment.itemName}\n<b>💰 Amount:</b> ${toRupiah(payment.amount)}\n<b>⏰ Approved:</b> ${new Date(payment.approvedAt).toLocaleString()}</blockquote>`,
      { parse_mode: "HTML" });
  } catch (e) {
    console.error("[ERROR] Failed to edit message caption:", e);
  }
  
  try {
    await bot.telegram.sendMessage(payment.userId, 
      `<blockquote><b>✅ Pembayaran Anda telah diterima!</b>\n\n<b>Item:</b> ${payment.itemName}\n<b>Amount:</b> ${toRupiah(payment.amount)}\n\n<i>Sedang mengirim produk...</i></blockquote>`,
      { parse_mode: "HTML" }
    );
    
    const fakeCtx = {
      from: { 
        id: payment.userId, 
        first_name: payment.userName.split(' ')[0] || payment.userName,
        last_name: payment.userName.split(' ').slice(1).join(' ') || ''
      },
      reply: (text, extra) => bot.telegram.sendMessage(payment.userId, text, extra),
      replyWithDocument: (file_id, extra) => bot.telegram.sendDocument(payment.userId, file_id, extra)
    };
    
    if (payment.productData) {
      await sendProductToUser(fakeCtx, payment.productData);
      
      sendTestimoniKeChannel(payment.userName, payment.userId, payment.itemName, payment.amount);
      
      await bot.telegram.sendMessage(config.ownerId,
        `<blockquote><b>📦 Produk telah dikirim ke user</b>\n\n<b>👤 User:</b> ${payment.userName}\n<b>🆔 ID:</b> ${payment.userId}\n<b>🛒 Item:</b> ${payment.itemName}\n<b>💰 Amount:</b> ${toRupiah(payment.amount)}</blockquote>`,
        { parse_mode: "HTML" }
      );
    }
    
    await ctx.answerCbQuery("✅ Pembayaran diterima dan produk dikirim!");
    
  } catch (error) {
    console.error("[ERROR] Error in payment approval:", error);
    await bot.telegram.sendMessage(config.ownerId, 
      `<blockquote><b>⚠️ Error saat memproses pembayaran untuk ${payment.userName} (${payment.userId}):</b> ${error.message}\n\n<i>Silakan kirim produk manual ke user.</i></blockquote>`,
      { parse_mode: "HTML" }
    );
  }
});

bot.action(/reject_payment_(\d+)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    await ctx.answerCbQuery("❌ Hanya owner yang boleh verifikasi!", { show_alert: true });
    return;
  }
  
  const paymentIndex = parseInt(ctx.match[1]);
  const payments = readManualPayments();
  const payment = payments[paymentIndex];
  
  if (!payment) {
    await ctx.answerCbQuery("❌ Pembayaran tidak ditemukan!", { show_alert: true });
    return;
  }
  
  if (payment.status !== "pending") {
    await ctx.answerCbQuery("❌ Pembayaran sudah diverifikasi!", { show_alert: true });
    return;
  }
  
  payment.status = "rejected";
  payment.rejectedBy = ctx.from.id;
  payment.rejectedAt = Date.now();
  saveManualPayments(payments);
  
  try {
    await ctx.editMessageCaption(`<blockquote><b>❌ PEMBAYARAN DITOLAK</b>\n\n<b>👤 User:</b> ${payment.userName}\n<b>🛒 Item:</b> ${payment.itemName}\n<b>💰 Amount:</b> ${toRupiah(payment.amount)}\n<b>⏰ Rejected:</b> ${new Date(payment.rejectedAt).toLocaleString()}</blockquote>`,
      { parse_mode: "HTML" });
  } catch (e) {
    console.error("[ERROR] Failed to edit message caption:", e);
  }
  
  try {
    await bot.telegram.sendMessage(payment.userId, 
      `<blockquote><b>❌ Pembayaran Anda ditolak!</b>\n\n<b>Alasan:</b> Bukti transfer tidak valid / nominal tidak sesuai.\n<i>Silakan hubungi owner untuk informasi lebih lanjut.</i></blockquote>`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    console.error("[ERROR] Failed to send rejection message to user:", e);
  }
  
  await ctx.answerCbQuery("❌ Pembayaran ditolak!");
});

bot.action("wd_nevapedia_start", async (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  await ctx.answerCbQuery().catch(() => {});

  const nevaConfig = { apikey: config.nevapedia?.apikey };

  await editMenuMessage(ctx, "⏳ <b>Mengambil daftar metode withdraw Nevapedia...</b>", { parse_mode: "HTML" });

  const methods = await getNevapediaWdMethods(nevaConfig);

  if (!methods || (methods.manual.length === 0 && methods.instant.length === 0)) {
    return editMenuMessage(ctx,
      "<blockquote>❌ <b>Gagal mengambil metode withdraw Nevapedia.</b>\\nPastikan API key sudah benar.</blockquote>",
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "🔙 Menu Owner", callback_data: "menu_owner" }]] }
      }
    );
  }

  nevaWdMethodCache[ctx.from.id] = methods;

  const buttons = [];
  methods.manual.forEach(m => {
    buttons.push([Markup.button.callback(`🏧 ${m.name} (Manual)`, `wd_neva_pick_manual_${m.method}`)]);
  });
  methods.instant.forEach(m => {
    buttons.push([Markup.button.callback(`⚡ ${m.name} (Instant)`, `wd_neva_pick_instant_${m.method}`)]);
  });
  buttons.push([Markup.button.callback("🔙 Kembali", "menu_owner")]);

  let listText = "<blockquote><b>💚 WITHDRAW NEVAPEDIA</b>\\n\\n<b>Pilih metode:</b>\\n\\n";
  [...methods.manual, ...methods.instant].forEach(m => {
    listText += `• <b>${m.name}</b> — Fee: ${toRupiah(m.fee)} | Min: ${toRupiah(m.min)} | Max: ${toRupiah(m.max)}\\n`;
  });
  listText += "</blockquote>";

  await editMenuMessage(ctx, listText, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons }
  });
});

bot.action(/wd_neva_pick_(manual|instant)_(.+)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  await ctx.answerCbQuery().catch(() => {});

  const instant = ctx.match[1] === "instant";
  const methodCode = ctx.match[2];

  const cached = nevaWdMethodCache[ctx.from.id];
  const list = instant ? cached?.instant : cached?.manual;
  const methodInfo = list?.find(m => m.method === methodCode);

  userState[ctx.from.id] = {
    step: "WAITING_WD_NEVA_AMOUNT",
    nevaMethod: methodCode,
    nevaMethodName: methodInfo?.name || methodCode,
    nevaInstant: instant
  };

  await editMenuMessage(ctx,
    `<blockquote><b>💚 WITHDRAW NEVAPEDIA — ${methodInfo?.name || methodCode} (${instant ? "Instant" : "Manual"})</b>\\n\\n` +
    `<b>Fee:</b> ${methodInfo ? toRupiah(methodInfo.fee) : "-"}\\n` +
    `<b>Min:</b> ${methodInfo ? toRupiah(methodInfo.min) : "-"}\\n` +
    `<b>Max:</b> ${methodInfo ? toRupiah(methodInfo.max) : "-"}\\n\\n` +
    `<i>Silakan ketik nominal yang ingin dicairkan (angka saja).</i></blockquote>`,
    {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "❌ Batalkan", callback_data: "menu_owner" }]] }
    }
  );
});

bot.action(/check_wd_neva_(.+)/, async (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  const wdId = ctx.match[1];

  try {
    const res = await cekNevapediaWdStatus({ apikey: config.nevapedia?.apikey }, wdId);
    const status = res?.status || "processing";
    await ctx.answerCbQuery(`Status: ${status.toUpperCase()}`);

    if (status === "success") {
      await ctx.editMessageText(`<blockquote>✅ <b>WD NEVAPEDIA BERHASIL!</b>\\nID: <code>${wdId}</code>\\nStatus: <b>SUCCESS</b></blockquote>`, { parse_mode: "HTML" }).catch(() => {});
    }
  } catch (e) {
    ctx.answerCbQuery("Gagal cek status.");
  }
});

bot.action("wd_rumahotp_start", async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;

  const infoWd = config.wd_balance || {};

  userState[ctx.from.id] = { step: "WAITING_WD_RUMAHOTP_NOMINAL" };

  await editMenuMessage(ctx,
    `<blockquote><b>🏦 CAIRKAN RUMAHOTP (H2H)</b>\n\n` +
    `<b>Tujuan WD (Config):</b>\n` +
    `Bank: <code>${infoWd.bank_code || '-'}</code>\n` +
    `No: <code>${infoWd.destination_number || '-'}</code>\n` +
    `A/N: <code>${infoWd.destination_name || '-'}</code>\n\n` +
    `<i>Silakan ketik nominal yang ingin dicairkan (Angka saja).</i>\n` +
    `<i>Contoh: 50000</i></blockquote>`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "❌ Batalkan", callback_data: "menu_owner" }]
        ]
      }
    }
  );
});

bot.command('autoreact', async (ctx) => {
    // Hanya bekerja di grup atau supergrup
    const chatType = ctx.chat?.type;
    if (chatType !== 'group' && chatType !== 'supergroup') {
        return ctx.reply('❌ Command ini hanya bisa digunakan di grup!');
    }
    
    const chatId = String(ctx.chat.id);
    
    try {
        // Cek apakah pengirim adalah admin
        let isAdmin = false;
        try {
            const chatMember = await ctx.getChatMember(ctx.from.id);
            isAdmin = ['creator', 'administrator'].includes(chatMember.status);
        } catch (adminError) {
            console.error('[AUTO-REACT] Admin check error:', adminError);
        }
        
        if (!isAdmin) {
            return ctx.reply('❌ Hanya admin grup yang bisa mengatur auto react!');
        }
        
        // Parse argument
        const args = ctx.message.text.split(' ').slice(1);
        const action = args[0] ? args[0].toLowerCase() : '';
        
        // Jika tidak ada argumen, tampilkan status
        if (!action) {
            const currentStatus = getAutoReactStatus(chatId);
            const statusText = currentStatus ? '🟢 AKTIF' : '🔴 NONAKTIF';
            const groupName = ctx.chat.title || `Grup ${chatId}`;
            
            return ctx.reply(
                `🎭 <b>Auto React Settings - ${groupName}</b>\n\n` +
                `Status: <b>${statusText}</b>\n\n` +
                `<b>Perintah:</b>\n` +
                `<code>/autoreact on</code> - Aktifkan auto react\n` +
                `<code>/autoreact off</code> - Nonaktifkan auto react\n` +
                `<code>/autoreact status</code> - Lihat status\n` +
                `<code>/autoreact test</code> - Test reaksi\n\n` +
                `<i>Bot akan memberikan reaksi emoji acak pada pesan di grup ini.</i>`,
                { parse_mode: 'HTML' }
            );
        }
        
        // Handle action
        if (action === 'on' || action === 'aktifkan' || action === 'enable') {
            // Cek apakah bot adalah admin
            let isBotAdmin = false;
            try {
                const botMember = await ctx.getChatMember(bot.botInfo.id);
                isBotAdmin = ['creator', 'administrator'].includes(botMember.status);
            } catch (botError) {
                console.error('[AUTO-REACT] Bot admin check error:', botError);
            }
            
            if (!isBotAdmin) {
                return ctx.reply(
                    '❌ <b>Bot harus menjadi admin!</b>\n\n' +
                    'Tambahkan bot sebagai admin dengan permission:\n' +
                    '• Kirim Pesan\n' +
                    '• Tambah Reaksi (Reactions)\n\n' +
                    'Setelah itu coba lagi.',
                    { parse_mode: 'HTML' }
                );
            }
            
            setAutoReactStatus(chatId, true);
            
            return ctx.reply(
                '✅ <b>Auto React Diaktifkan!</b>\n\n' +
                'Bot sekarang akan memberikan reaksi emoji acak pada pesan di grup ini.\n\n' +
                '⚙️ <i>Gunakan</i> <code>/autoreact off</code> <i>untuk menonaktifkan.</i>',
                { parse_mode: 'HTML' }
            );
            
        } else if (action === 'off' || action === 'nonaktifkan' || action === 'disable') {
            setAutoReactStatus(chatId, false);
            
            return ctx.reply(
                '❌ <b>Auto React Dinonaktifkan!</b>\n\n' +
                'Bot tidak akan memberikan reaksi otomatis lagi.\n\n' +
                '⚙️ <i>Gunakan</i> <code>/autoreact on</code> <i> untuk mengaktifkan kembali.</i>',
                { parse_mode: 'HTML' }
            );
            
        } else if (action === 'status') {
            const currentStatus = getAutoReactStatus(chatId);
            const statusText = currentStatus ? '🟢 AKTIF' : '🔴 NONAKTIF';
            
            // Cek apakah bot admin
            let isBotAdmin = false;
            try {
                const botMember = await ctx.getChatMember(bot.botInfo.id);
                isBotAdmin = ['creator', 'administrator'].includes(botMember.status);
            } catch (error) {
                console.error('[AUTO-REACT] Bot status check error:', error);
            }
            
            const botStatus = isBotAdmin ? '✅ Admin' : '❌ Bukan Admin';
            
            return ctx.reply(
                `📊 <b>Status Auto React</b>\n\n` +
                `Grup: <b>${ctx.chat.title || `ID: ${chatId}`}</b>\n` +
                `Auto React: <b>${statusText}</b>\n` +
                `Bot Status: <b>${botStatus}</b>\n\n` +
                `<i>${currentStatus ? 'Bot sedang memberikan reaksi otomatis.' : 'Bot sedang tidak memberikan reaksi otomatis.'}</i>`,
                { parse_mode: 'HTML' }
            );
            
        } else if (action === 'test') {
            // Test reaksi pada pesan saat ini
            try {
                const testEmoji = '👍';
                await ctx.react(testEmoji);
                return ctx.reply(`✅ <b>Test Reaksi Berhasil!</b>\n\nEmoji ${testEmoji} berhasil dikirim.`, { parse_mode: 'HTML' });
            } catch (error) {
                return ctx.reply(
                    `❌ <b>Test Reaksi Gagal!</b>\n\n` +
                    `Error: ${error.message}\n\n` +
                    `<b>Pastikan:</b>\n` +
                    `1. Bot adalah admin\n` +
                    `2. Bot memiliki permission "Tambah Reaksi"\n` +
                    `3. Fitur reactions aktif di grup`,
                    { parse_mode: 'HTML' }
                );
            }
            
        } else {
            return ctx.reply(
                '❌ <b>Perintah tidak dikenal!</b>\n\n' +
                '<b>Perintah yang valid:</b>\n' +
                '• <code>/autoreact on</code> - Aktifkan\n' +
                '• <code>/autoreact off</code> - Nonaktifkan\n' +
                '• <code>/autoreact status</code> - Lihat status\n' +
                '• <code>/autoreact test</code> - Test reaksi\n' +
                '• <code>/autoreact</code> - Info pengaturan',
                { parse_mode: 'HTML' }
            );
        }
        
    } catch (error) {
        console.error('[AUTO-REACT CMD ERROR]', error);
        return ctx.reply(
            '❌ <b>Terjadi error!</b>\n\n' +
            `${error.message}\n\n` +
            'Coba lagi atau hubungi developer.',
            { parse_mode: 'HTML' }
        );
    }
});

bot.command('resetautoreact', async (ctx) => {
    if (ctx.from.id !== config.ownerId) {
        return ctx.reply('❌ Hanya owner yang bisa menggunakan command ini!');
    }
    
    try {
        const args = ctx.message.text.split(' ').slice(1);
        const chatId = args[0];
        
        if (chatId) {
            // Reset grup tertentu
            setAutoReactStatus(chatId, false);
            return ctx.reply(`✅ Auto react untuk grup ${chatId} telah direset.`);
        } else {
            // Reset semua grup
            saveAutoReactDB({});
            return ctx.reply('✅ Semua data auto react telah direset.');
        }
    } catch (error) {
        console.error('[RESET AUTO-REACT ERROR]', error);
        return ctx.reply('❌ Gagal reset auto react!');
    }
});

// Command untuk melihat daftar grup dengan auto react aktif (owner only)
bot.command('listautoreact', async (ctx) => {
    if (ctx.from.id !== config.ownerId) {
        return ctx.reply('❌ Hanya owner yang bisa melihat daftar grup!');
    }
    
    try {
        const db = readAutoReactDB();
        const activeGroups = Object.entries(db).filter(([_, status]) => status === true);
        
        if (activeGroups.length === 0) {
            return ctx.reply('📭 Tidak ada grup dengan auto react aktif.');
        }
        
        let message = `📋 <b>Daftar Grup dengan Auto React Aktif</b>\n\n`;
        message += `Total: ${activeGroups.length} grup\n\n`;
        
        for (const [chatId, status] of activeGroups.slice(0, 20)) { // Batasi 20 grup
            try {
                // Coba dapatkan info grup
                const chat = await ctx.telegram.getChat(chatId);
                message += `🟢 ${chat.title || `Grup ${chatId}`}\n`;
                message += `   ID: <code>${chatId}</code>\n\n`;
            } catch (error) {
                message += `🟢 Grup ${chatId}\n`;
                message += `   (Tidak bisa akses info)\n\n`;
            }
        }
        
        if (activeGroups.length > 20) {
            message += `\n...dan ${activeGroups.length - 20} grup lainnya.`;
        }
        
        return ctx.reply(message, { parse_mode: 'HTML' });
        
    } catch (error) {
        console.error('[LIST AUTO-REACT ERROR]', error);
        return ctx.reply('❌ Gagal mengambil daftar grup!');
    }
});

// Handler untuk debug: log semua pesan di grup
bot.on('message', (ctx, next) => {
    const chatType = ctx.chat?.type;
    if (chatType === 'group' || chatType === 'supergroup') {
        const chatId = String(ctx.chat.id);
        const hasText = ctx.message.text || ctx.message.caption;
        const isAutoReactEnabled = getAutoReactStatus(chatId);
        
        console.log(`[DEBUG] Grup: ${chatId}, AutoReact: ${isAutoReactEnabled}, Ada teks: ${!!hasText}`);
    }
    return next();
});

bot.command("cancel", (ctx) => cancelTransaction(ctx));

bot.command("riwayat", async (ctx) => {
  const userId = ctx.from.id;
  const all = readTransactions();
  const mine = all.filter((t) => t.userId === userId).sort((a, b) => b.timestamp - a.timestamp);

  if (mine.length === 0) {
    return safeReply(ctx, "<blockquote>📭 <b>Belum ada riwayat transaksi.</b>\n\nYuk mulai belanja lewat /start!</blockquote>", { parse_mode: "HTML" });
  }

  const recent = mine.slice(0, 10);
  let text = `<blockquote><b>╭━━━━✧「 🧾 𝗥𝗜𝗪𝗔𝗬𝗔𝗧 𝗧𝗥𝗔𝗡𝗦𝗔𝗞𝗦𝗜 」✧━━━━❍</b>\n<b>┃</b> Menampilkan ${recent.length} dari ${mine.length} total\n<b>╰━━━━━━━━━━━━━━━━━━━━━━━━❍</b></blockquote>\n\n`;
  recent.forEach((t, i) => {
    text += `<b>${i + 1}. ${t.itemName}</b>\n   💰 ${toRupiah(t.amount)}`;
    if (t.voucherCode) text += ` <i>(voucher ${t.voucherCode})</i>`;
    text += `\n   🕐 ${t.date}\n\n`;
  });
  const totalSpent = mine.reduce((sum, t) => sum + (t.amount || 0), 0);
  text += `<blockquote>💳 <b>Total belanja:</b> ${toRupiah(totalSpent)}\n<i>Ketik /invoice nomor buat generate ulang struk (contoh: /invoice 1)</i></blockquote>`;

  await safeReply(ctx, text, { parse_mode: "HTML" });
});

bot.command("invoice", async (ctx) => {
  const userId = ctx.from.id;
  const arg = ctx.message.text.split(" ")[1];
  const num = parseInt(arg);

  if (!num || num < 1) {
    return safeReply(ctx, "<blockquote>ℹ️ <b>Gunakan:</b> <code>/invoice nomor</code>\n\nLihat nomornya dulu di /riwayat, contoh: <code>/invoice 2</code></blockquote>", { parse_mode: "HTML" });
  }

  const all = readTransactions();
  const mine = all.filter((t) => t.userId === userId).sort((a, b) => b.timestamp - a.timestamp);
  const trx = mine[num - 1];

  if (!trx) {
    return safeReply(ctx, "<blockquote>❌ Transaksi nomor itu tidak ditemukan. Cek dulu daftarnya di /riwayat.</blockquote>", { parse_mode: "HTML" });
  }

  await safeReply(ctx, "<blockquote>⏳ Membuat ulang invoice...</blockquote>", { parse_mode: "HTML" });
  await sendReceiptImage(ctx, { itemName: trx.itemName, nominal: trx.amount, method: "Invoice Ulang" });

  await safeReply(
    ctx,
    `<blockquote><b>╭━━━━✧「 🧾 𝗜𝗡𝗩𝗢𝗜𝗖𝗘 」✧━━━━❍</b>\n<b>┃</b> 🆔 ID       : <code>${trx.id}</code>\n<b>┃</b> 📦 Item     : ${trx.itemName}\n<b>┃</b> 💰 Total    : ${toRupiah(trx.amount)}${trx.voucherCode ? `\n<b>┃</b> 🎫 Voucher  : ${trx.voucherCode}` : ""}\n<b>┃</b> 🕐 Tanggal  : ${trx.date}\n<b>╰━━━━━━━━━━━━━━━━━━━━━━━━❍</b></blockquote>`,
    { parse_mode: "HTML" }
  );
});

bot.command("selftest", async (ctx) => {
  if (ctx.from.id !== config.ownerId) return;
  const checking = await safeReply(ctx, "<blockquote>⏳ Menjalankan self-test lengkap...</blockquote>", { parse_mode: "HTML" });

  const lines = [];

  // AI Customer Support — live ping ke endpoint status
  const tools2Key = config.externalApi?.fidzzcodex?.apikey;
  if (tools2Key && tools2Key !== "-") {
    try {
      const ep = ExtAPI.findEndpoint(ExtAPI.FIDZZ_ENDPOINTS, "status");
      await ExtAPI.callFidzz(ep, {});
      lines.push("🟢 AI Customer Support: OK");
    } catch (e) {
      lines.push(`🔴 AI Customer Support: GAGAL - ${e.message}`);
    }
  } else {
    lines.push("⚪ AI Customer Support: apikey belum diisi");
  }

  // Struk Generator
  const tools3Key = config.externalApi?.nexapi?.apikey;
  lines.push(tools3Key && tools3Key !== "-" ? "🟢 Struk Generator: apikey terisi" : "⚪ Struk Generator: apikey belum diisi");

  // Payment gateway
  lines.push(`💳 Metode bayar aktif: ${getActivePaymentMethod()}`);
  lines.push(`⭐ Telegram Stars: ${config.telegramStars?.enabled ? "🟢 Aktif" : "⚪ Nonaktif"}`);

  // Disk write test
  try {
    fs.writeFileSync("./.selftest_tmp", "ok");
    fs.unlinkSync("./.selftest_tmp");
    lines.push("🟢 Disk write: OK");
  } catch (e) {
    lines.push(`🔴 Disk write: GAGAL - ${e.message}`);
  }

  // Database JSON integrity
  try {
    readDb();
    readTransactions();
    readVouchers();
    lines.push("🟢 Database JSON: valid, bisa dibaca");
  } catch (e) {
    lines.push(`🔴 Database JSON: RUSAK - ${e.message}`);
  }

  // Memory & uptime
  const mem = process.memoryUsage();
  const uptimeSec = process.uptime();
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  lines.push(`💾 Memory: ${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB / ${(mem.heapTotal / 1024 / 1024).toFixed(1)}MB`);
  lines.push(`⏱️ Uptime proses: ${h}j ${m}m`);

  const text = `<blockquote><b>🔬 SELF-TEST LENGKAP</b>\n━━━━━━━━━━━━━━━━━━\n\n${lines.join("\n")}\n\n🕐 ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}</blockquote>`;

  try {
    await ctx.telegram.editMessageText(ctx.chat.id, checking.message_id, undefined, text, { parse_mode: "HTML" });
  } catch (e) {
    await safeReply(ctx, text, { parse_mode: "HTML" });
  }
});

bot.command("status", async (ctx) => {
  const checking = await safeReply(ctx, "<blockquote>⏳ Mengecek status sistem...</blockquote>", { parse_mode: "HTML" });

  const method = getActivePaymentMethod();
  const tools2Key = config.externalApi?.fidzzcodex?.apikey;
  const tools3Key = config.externalApi?.nexapi?.apikey;

  let aiCsStatus = "🔴 Apikey belum diisi owner";
  if (tools2Key && tools2Key !== "-") {
    try {
      const ep = ExtAPI.findEndpoint(ExtAPI.FIDZZ_ENDPOINTS, "status");
      await ExtAPI.callFidzz(ep, {});
      aiCsStatus = "🟢 Terhubung normal";
    } catch (e) {
      aiCsStatus = "🟡 Apikey ada, tapi API sedang gangguan";
    }
  }
  const strukStatus = tools3Key && tools3Key !== "-" ? "🟢 Terhubung (apikey aktif)" : "🔴 Apikey belum diisi owner";

  const text =
    `<blockquote><b>🩺 Status Sistem</b>\n\n` +
    `🤖 <b>Bot Telegram:</b> 🟢 Online\n` +
    `💳 <b>Payment QRIS:</b> 🟢 Aktif (${method})\n` +
    `⭐ <b>Telegram Stars:</b> ${config.telegramStars?.enabled ? "🟢 Aktif" : "⚫ Nonaktif"}\n` +
    `🧾 <b>Struk Generator:</b> ${strukStatus}\n` +
    `🗣️ <b>AI Customer Support:</b> ${aiCsStatus}\n\n` +
    `🕐 Dicek pada: ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}</blockquote>`;

  try {
    await ctx.telegram.editMessageText(ctx.chat.id, checking.message_id, undefined, text, { parse_mode: "HTML" });
  } catch (e) {
    await safeReply(ctx, text, { parse_mode: "HTML" });
  }
});


bot.action("cancel_trx", (ctx) => cancelTransaction(ctx));
async function cancelTransaction(ctx) {
  const userId = ctx.from.id;
  
  if (activeTransactions[userId]) {
    try {
      if (activeTransactions[userId].messageId) {
        await ctx.deleteMessage(activeTransactions[userId].messageId).catch(() => {});
      }
    } catch (e) {}
    
    delete activeTransactions[userId];
    
    if (userState[userId]) {
      delete userState[userId];
    }
    
    await safeReply(ctx, "<blockquote>✅ <b>Transaksi dibatalkan.</b></blockquote>", { parse_mode: "HTML" });
  } else {
    await safeReply(ctx, "<blockquote>⚠️ <b>Tidak ada transaksi aktif.</b></blockquote>", { parse_mode: "HTML" });
  }
  
  if (ctx.updateType === 'callback_query') {
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
  }
}

bot.command("ytsearch", async (ctx) => {
  const query = ctx.message.text.split(" ").slice(1).join(" ");
  if (!query) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/ytsearch judul lagu / keyword</code></blockquote>", { parse_mode: "HTML" });

  try {
    await safeReply(ctx, "<blockquote>🔍 <b>Mencari video di YouTube...</b></blockquote>", { parse_mode: "HTML" });

    const api = `https://api-ralzz.vercel.app/search/youtube?apikey=ubot&q=${encodeURIComponent(query)}`;
    const res = await axios.get(api);

    if (!res.data || !res.data.result || res.data.result.length === 0) {
      return safeReply(ctx, "<blockquote>❌ <b>Tidak ada hasil ditemukan.</b></blockquote>", { parse_mode: "HTML" });
    }

    const results = res.data.result.slice(0, 10); 

    results.forEach((vid, i) => {
      const text =
`<b>🎬 ${vid.title}</b>
<b>👤 Channel:</b> ${vid.author?.name || "-"}
<b>⏱ Durasi:</b> ${vid.duration?.timestamp || "-"}
<b>👁 Views:</b> ${vid.views?.toLocaleString() || "-"}

<b>🔗</b> ${vid.url}`;

      safeReply(ctx, text, { parse_mode: "HTML" });
    });

  } catch (err) {
    console.error(err);
    safeReply(ctx, "<blockquote>❌ <b>Error mengambil data pencarian YouTube.</b></blockquote>", { parse_mode: "HTML" });
  }
});

bot.command("ssweb", async (ctx) => {
  const url = ctx.message.text.split(" ")[1];
  if (!url) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/ssweb url</code></blockquote>", { parse_mode: "HTML" });

  try {
    safeReply(ctx, "<blockquote>⏳ <b>Mengambil screenshot...</b></blockquote>", { parse_mode: "HTML" });

    const api = `https://api-ralzz.vercel.app/tools/ssweb?apikey=ubot&url=${encodeURIComponent(url)}`;
    const res = await axios.get(api);

    if (!res.data || !res.data.result) {
      return safeReply(ctx, "<blockquote>❌ <b>Gagal mengambil screenshot.</b></blockquote>", { parse_mode: "HTML" });
    }

    await ctx.replyWithPhoto(res.data.result, {
      caption: "<blockquote>✅ <b>Screenshot berhasil!</b></blockquote>",
      parse_mode: "HTML"
    });

  } catch (err) {
    console.error(err);
    safeReply(ctx, "<blockquote>❌ <b>Error: tidak bisa mengambil screenshot.</b></blockquote>", { parse_mode: "HTML" });
  }
});

bot.command("makeqr", async(ctx) => {
  const txt = ctx.message.text.replace("/makeqr", "").trim();
  if (!txt) return safeReply(ctx, "<blockquote><b>Gunakan:</b> <code>/makeqr teks</code></blockquote>", { parse_mode: "HTML" });
  ctx.replyWithPhoto(`https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(txt)}`);
});

bot.command("ytmp3", async (ctx) => {
  const url = ctx.message.text.split(" ")[1];
  if (!url) return safeReply(ctx, "<blockquote><b>Gunakan:</b> <code>/ytmp3 url</code></blockquote>", { parse_mode: "HTML" });
  safeReply(ctx, "<blockquote>⏳ <b>Mengambil audio...</b></blockquote>", { parse_mode: "HTML" });
  try {
    const res = await axios.get(`https://api-ralzz.vercel.app/download/ytmp3v2?apikey=ubot&url=${encodeURIComponent(url)}`);
    await ctx.replyWithAudio(res.data.result, { caption: "<blockquote>🎵 <b>YouTube Audio Downloaded</b></blockquote>", parse_mode: "HTML" });
  } catch (e) { safeReply(ctx, "<blockquote>❌ <b>Gagal mengambil audio.</b></blockquote>", { parse_mode: "HTML" }); }
});

bot.command("shorten", async (ctx) => {
  const url = ctx.message.text.split(" ")[1];
  if (!url) return safeReply(ctx, "<blockquote><b>Gunakan:</b> <code>/shorten url</code></blockquote>", { parse_mode: "HTML" });
  try {
    const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`);
    safeReply(ctx, `<blockquote><b>🔗 Shortened URL:</b>\n${res.data}</blockquote>`, { parse_mode: "HTML" });
  } catch (e) { safeReply(ctx, "<blockquote>❌ <b>Gagal memendekkan URL.</b></blockquote>", { parse_mode: "HTML" }); }
});


bot.command("checkerror", async (ctx) => {
    if (!ctx.message.reply_to_message?.document)
        return safeReply(ctx, "<blockquote>❌ <b>Reply file untuk dianalisa!</b></blockquote>", { parse_mode: "HTML" });

    const file = ctx.message.reply_to_message.document;
    const fileId = file.file_id;
    const fileName = file.file_name;

    const limit = updateUserLimit(ctx.from.id);
    if (limit < 0) return safeReply(ctx, "<blockquote>❌ <b>Limit habis!</b> Upgrade ke premium.</blockquote>", { parse_mode: "HTML" });

    try {
        safeReply(ctx, "<blockquote>📥 <b>Mengunduh & menganalisa file...</b></blockquote>", { parse_mode: "HTML" });

        const buff = await downloadFile(fileId);
        const content = getFileContent(buff);

        const analysis = await analyzeErrorWithGemini(content, fileName);

        safeReply(ctx, `<b>📄 Hasil Analisis:</b>\n\n${analysis}\n\n<b>Sisa limit:</b> ${getUserLimit(ctx.from.id)}`,
            { parse_mode: "HTML" }
        );
    } catch (err) {
        safeReply(ctx, "<blockquote>❌ <b>Error:</b></blockquote>" + err.message, { parse_mode: "HTML" });
    }
});

bot.command("fixerror", async (ctx) => {
    if (!ctx.message.reply_to_message?.document)
        return safeReply(ctx, "❌ <b>Reply file untuk diperbaiki!</b>", { parse_mode: "HTML" });

    const file = ctx.message.reply_to_message.document;
    const fileId = file.file_id;
    const fileName = file.file_name;

    const limit = updateUserLimit(ctx.from.id);
    if (limit < 0) return safeReply(ctx, "❌ <b>Limit habis!</b> Upgrade ke premium.", { parse_mode: "HTML" });

    try {
        safeReply(ctx, "🔧 <b>Memperbaiki error dengan Gemini...</b>", { parse_mode: "HTML" });

        const buff = await downloadFile(fileId);
        const content = getFileContent(buff);

        const fixed = await fixErrorWithGemini(content, fileName);

        ctx.replyWithDocument(
            { source: Buffer.from(fixed), filename: `fixed_${fileName}` },
            { caption: `✔ <b>Error berhasil diperbaiki!</b>\n<b>Sisa limit:</b> ${getUserLimit(ctx.from.id)}`, parse_mode: "HTML" }
        );
    } catch (err) {
        safeReply(ctx, "❌ <b>Error:</b> " + err.message, { parse_mode: "HTML" });
    }
});

// ================= KELOLA PTERODACTYL (OWNER ONLY) =================
// Semua endpoint di kategori "Pterodactyl" itu OWNER_ONLY_CATEGORIES (lihat
// lib/externalApis.js) — sengaja gak pernah diekspos ke customer karena
// destruktif (bisa hapus SEMUA server/user di panel). domain+plta otomatis
// dipakai dari config.panel (kredensial panel yang sama dgn yang dipakai
// buat jualan Admin Panel), jadi owner gak perlu input ulang tiap kali.
function pteroCall(epKey, extraArgs = {}) {
  const ep = ExtAPI.findEndpoint(ExtAPI.FIDZZ_ENDPOINTS, epKey);
  return ExtAPI.callFidzz(ep, { domain: config.panel.domain, plta: config.panel.apikey, ...extraArgs });
}

function requireOwner(ctx) {
  return ctx.from.id === config.ownerId;
}

bot.action("ptero_menu", async (ctx) => {
  if (!requireOwner(ctx)) return ctx.answerCbQuery("❌ Bukan Owner!");
  ctx.answerCbQuery().catch(() => {});
  await editMenuMessage(ctx,
    `<blockquote><b>╭━━━━✧「 🦖 𝗞𝗘𝗟𝗢𝗟𝗔 𝗣𝗧𝗘𝗥𝗢𝗗𝗔𝗖𝗧𝗬𝗟 」✧━━━━❍</b>\n<b>┃</b> Panel: <code>${config.panel.domain}</code>\n<b>╰━━━━━━━━━━━━━━━━━━━━━━━━❍</b></blockquote>`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📋 List User", callback_data: "ptero_listuser" }, { text: "📋 List Server", callback_data: "ptero_listserver" }],
          [{ text: "📋 List Admin", callback_data: "ptero_listadmin" }],
          [{ text: "➕ Buat Admin Baru", callback_data: "ptero_createadmin_start" }],
          [{ text: "🗑️ Hapus Panel (by id)", callback_data: "ptero_delpanel_start" }, { text: "🗑️ Hapus Admin (by id)", callback_data: "ptero_deladmin_start" }],
          [{ text: "⚠️ Clear SEMUA Server", callback_data: "ptero_clearserver_confirm" }],
          [{ text: "⚠️ Clear SEMUA User", callback_data: "ptero_clearuser_confirm" }],
          [{ text: "🔙 Kembali", callback_data: "menu_owner" }]
        ]
      }
    }
  );
});

async function runPteroAction(ctx, epKey, extraArgs, title) {
  await ctx.answerCbQuery("⏳ Memproses...").catch(() => {});
  const waitMsg = await safeReply(ctx, `<blockquote>⏳ <b>${title}...</b></blockquote>`, { parse_mode: "HTML" });
  try {
    const result = await pteroCall(epKey, extraArgs);
    const text = `<blockquote><b>${title}</b>\n\n<code>${JSON.stringify(result, null, 2).slice(0, 3500)}</code></blockquote>`;
    try { await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" }); }
    catch (e) { await safeReply(ctx, text, { parse_mode: "HTML" }); }
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
    const text = `<blockquote>❌ <b>Gagal:</b>\n<code>${detail}</code></blockquote>`;
    try { await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" }); }
    catch (e2) { await safeReply(ctx, text, { parse_mode: "HTML" }); }
  }
}

bot.action("ptero_listuser", async (ctx) => {
  if (!requireOwner(ctx)) return ctx.answerCbQuery("❌ Bukan Owner!");
  await runPteroAction(ctx, "ptero-listuser", {}, "📋 List User Pterodactyl");
});

bot.action("ptero_listserver", async (ctx) => {
  if (!requireOwner(ctx)) return ctx.answerCbQuery("❌ Bukan Owner!");
  await runPteroAction(ctx, "ptero-listserver", {}, "📋 List Server Pterodactyl");
});

bot.action("ptero_listadmin", async (ctx) => {
  if (!requireOwner(ctx)) return ctx.answerCbQuery("❌ Bukan Owner!");
  await runPteroAction(ctx, "ptero-listadmin", {}, "📋 List Admin Pterodactyl");
});

bot.action("ptero_createadmin_start", (ctx) => {
  if (!requireOwner(ctx)) return ctx.answerCbQuery("❌ Bukan Owner!");
  ctx.answerCbQuery().catch(() => {});
  userState[ctx.from.id] = { step: "PTERO_CREATEADMIN_USERNAME" };
  safeReply(ctx, "<blockquote>➕ <b>Buat Admin Baru</b>\n\nMasukkan <b>username</b> buat akun admin barunya:</blockquote>", { parse_mode: "HTML" });
});

bot.action("ptero_delpanel_start", (ctx) => {
  if (!requireOwner(ctx)) return ctx.answerCbQuery("❌ Bukan Owner!");
  ctx.answerCbQuery().catch(() => {});
  userState[ctx.from.id] = { step: "PTERO_DELPANEL_ID" };
  safeReply(ctx, "<blockquote>🗑️ <b>Hapus Panel</b>\n\nMasukkan <b>ID/username</b> server+user yang mau dihapus:</blockquote>", { parse_mode: "HTML" });
});

bot.action("ptero_deladmin_start", (ctx) => {
  if (!requireOwner(ctx)) return ctx.answerCbQuery("❌ Bukan Owner!");
  ctx.answerCbQuery().catch(() => {});
  userState[ctx.from.id] = { step: "PTERO_DELADMIN_ID" };
  safeReply(ctx, "<blockquote>🗑️ <b>Hapus Admin</b>\n\nMasukkan <b>ID</b> user admin yang mau dihapus (lihat dari 📋 List Admin):</blockquote>", { parse_mode: "HTML" });
});

// Aksi destruktif (hapus SEMUA) — wajib konfirmasi 2 langkah, gak boleh
// ke-trigger dari satu tap doang.
bot.action("ptero_clearserver_confirm", async (ctx) => {
  if (!requireOwner(ctx)) return ctx.answerCbQuery("❌ Bukan Owner!");
  ctx.answerCbQuery().catch(() => {});
  await safeReply(ctx,
    `<blockquote>⚠️⚠️ <b>PERINGATAN!</b>\nIni bakal menghapus <b>SEMUA SERVER</b> di panel <code>${config.panel.domain}</code>. Aksi ini TIDAK BISA dibatalkan.\n\nYakin lanjut?</blockquote>`,
    { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Ya, Hapus SEMUA Server", callback_data: "ptero_clearserver_exec" }, { text: "❌ Batal", callback_data: "ptero_menu" }]] } }
  );
});

bot.action("ptero_clearserver_exec", async (ctx) => {
  if (!requireOwner(ctx)) return ctx.answerCbQuery("❌ Bukan Owner!");
  await runPteroAction(ctx, "ptero-clearserver", {}, "⚠️ Clear SEMUA Server");
});

bot.action("ptero_clearuser_confirm", async (ctx) => {
  if (!requireOwner(ctx)) return ctx.answerCbQuery("❌ Bukan Owner!");
  ctx.answerCbQuery().catch(() => {});
  await safeReply(ctx,
    `<blockquote>⚠️⚠️ <b>PERINGATAN!</b>\nIni bakal menghapus <b>SEMUA USER</b> di panel <code>${config.panel.domain}</code>. Aksi ini TIDAK BISA dibatalkan.\n\nYakin lanjut?</blockquote>`,
    { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Ya, Hapus SEMUA User", callback_data: "ptero_clearuser_exec" }, { text: "❌ Batal", callback_data: "ptero_menu" }]] } }
  );
});

bot.action("ptero_clearuser_exec", async (ctx) => {
  if (!requireOwner(ctx)) return ctx.answerCbQuery("❌ Bukan Owner!");
  await runPteroAction(ctx, "ptero-clearuser", {}, "⚠️ Clear SEMUA User");
});

bot.command("qc", async (ctx) => {
  try {
    const reply = ctx.message.reply_to_message;

    if (!reply) {
      return ctx.reply(
        "❌ <b>Contoh penggunaan:</b> <code>/qc (reply pesan)</code>",
        { parse_mode: "HTML" }
      );
    }

    const target = reply.forward_from || reply.from;
    const username = target.first_name || "User";

    let avatarUrl = "https://files.catbox.moe/nwvkbt.png";

    try {
      const photos = await ctx.telegram.getUserProfilePhotos(target.id, 0, 1);

      if (photos.total_count > 0) {
        const file = await ctx.telegram.getFileLink(photos.photos[0][0].file_id);
        avatarUrl = file.href;
      }
    } catch (err) {
      console.log("Avatar fetch error:", err);
    }

    const messageText = reply.text || reply.caption || "(pesan tidak berisi teks)";

    const payload = {
      type: "quote",
      format: "png",
      backgroundColor: "#000000",
      width: 512,
      height: 768,
      scale: 2,
      messages: [
        {
          entities: [],
          avatar: true,
          from: {
            id: target.id,
            name: username,
            photo: { url: avatarUrl },
          },
          text: messageText,
          replyMessage: {},
        },
      ],
    };

    const loading = await ctx.reply(
      `<blockquote>⏳ <b>Membuat sticker quote...</b></blockquote>`,
      { parse_mode: "HTML" }
    );

    const result = await axios.post(
      "https://bot.lyo.su/quote/generate",
      payload,
      { headers: { "Content-Type": "application/json" } }
    );

    const buffer = Buffer.from(result.data.result.image, "base64");

    await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id);

    await ctx.replyWithSticker({ source: buffer });
  } catch (err) {
    console.error("QC ERROR:", err);
    return ctx.reply(
      `<blockquote>❌ <b>Terjadi kesalahan saat membuat sticker.</b></blockquote>`,
      { parse_mode: "HTML" }
    );
  }
});

bot.command("brat", async (ctx) => {
  const text = ctx.message.text.split(" ").slice(1).join(" ");

  if (!text) {
    return ctx.reply("❌ <b>Contoh:</b> <code>/brat (kata-kata)</code>", {
      parse_mode: "HTML"
    });
  }

  const chatId = ctx.chat.id;
  const tempFilePath = "./brat_temp.webp";

  try {
    await ctx.reply("<blockquote>⏳ <b>Membuat sticker, tunggu sebentar...</b></blockquote>", { parse_mode: "HTML" });

    const imageUrl = `https://kepolu-brat.hf.space/brat?q=${encodeURIComponent(text)}`;

    const downloadFile = async (url, dest) => {
      const writer = fs.createWriteStream(dest);

      const response = await axios({
        url,
        method: "GET",
        responseType: "stream",
      });

      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });
    };

    await downloadFile(imageUrl, tempFilePath);

    await ctx.replyWithSticker({ source: tempFilePath });

    fs.unlinkSync(tempFilePath);

  } catch (err) {
    console.error(err);
    ctx.reply("<blockquote>❌ <b>Terjadi kesalahan saat membuat sticker. Coba lagi nanti.</b></blockquote>", { parse_mode: "HTML" });
  }
});

async function uploadToCatbox(buffer, filename) {
  const form = new FormData();
  form.append('fileToUpload', buffer, { filename: filename });
  form.append('reqtype', 'fileupload');

  const response = await axios.post('https://catbox.moe/user/api.php', form, {
    headers: { ...form.getHeaders() },
    timeout: 30000
  });

  const url = typeof response.data === "string" ? response.data.trim() : "";
  if (!url.startsWith("http")) {
    throw new Error(`Catbox menolak upload: ${JSON.stringify(response.data).slice(0, 200)}`);
  }
  return url;
}

// Cadangan-cadangan kalau Catbox gagal (mis. status 412 — Catbox sering
// memblokir upload dari IP VPS/hosting sebagai proteksi anti-abuse, ini di
// luar kendali kode kita). Dicoba berurutan sampai salah satu berhasil.
async function uploadToUguu(buffer, filename) {
  const form = new FormData();
  form.append('files[]', buffer, { filename: filename });

  const response = await axios.post('https://uguu.se/upload.php', form, {
    headers: { ...form.getHeaders() },
    timeout: 30000
  });

  const url = response.data?.files?.[0]?.url;
  if (!url) {
    throw new Error(`Uguu menolak upload: ${JSON.stringify(response.data).slice(0, 200)}`);
  }
  return url;
}

async function uploadToQuAx(buffer, filename) {
  const form = new FormData();
  form.append('files[]', buffer, { filename: filename });

  const response = await axios.post('https://qu.ax/upload.php', form, {
    headers: { ...form.getHeaders() },
    timeout: 30000
  });

  const url = response.data?.files?.[0]?.url;
  if (!url) {
    throw new Error(`Qu.ax menolak upload: ${JSON.stringify(response.data).slice(0, 200)}`);
  }
  return url;
}

async function uploadTo0x0(buffer, filename) {
  const form = new FormData();
  form.append('file', buffer, { filename: filename });

  // 0x0.st mewajibkan User-Agent yang jelas/deskriptif, kalau tidak akan ditolak (403).
  const response = await axios.post('https://0x0.st', form, {
    headers: { ...form.getHeaders(), "User-Agent": "AutoOrderBot/1.0 (Telegram file uploader)" },
    timeout: 30000
  });

  const url = typeof response.data === "string" ? response.data.trim() : "";
  if (!url.startsWith("http")) {
    throw new Error(`0x0.st menolak upload: ${JSON.stringify(response.data).slice(0, 200)}`);
  }
  return url;
}

async function uploadToLitterbox(buffer, filename) {
  const form = new FormData();
  form.append('fileToUpload', buffer, { filename: filename });
  form.append('reqtype', 'fileupload');
  form.append('time', '72h'); // maksimum yang ditawarkan Litterbox — subdomain ini MEMANG
  // didesain sementara oleh Catbox sendiri (beda dari catbox.moe utama yang permanen),
  // jadi retensinya nggak bisa dibikin permanen lewat API. Dipakai sebagai fallback
  // paling akhir aja, kalau semua provider permanen di atas gagal.

  const response = await axios.post('https://litterbox.catbox.moe/resources/internals/api.php', form, {
    headers: { ...form.getHeaders() },
    timeout: 30000
  });

  const url = typeof response.data === "string" ? response.data.trim() : "";
  if (!url.startsWith("http")) {
    throw new Error(`Litterbox menolak upload: ${JSON.stringify(response.data).slice(0, 200)}`);
  }
  return url;
}

async function uploadToEnvs(buffer, filename) {
  const form = new FormData();
  form.append('file', buffer, { filename: filename });

  // envs.sh adalah mirror dari 0x0.st (kode sama), jadi tetap butuh User-Agent jelas.
  const response = await axios.post('https://envs.sh', form, {
    headers: { ...form.getHeaders(), "User-Agent": "AutoOrderBot/1.0 (Telegram file uploader)" },
    timeout: 30000
  });

  const url = typeof response.data === "string" ? response.data.trim() : "";
  if (!url.startsWith("http")) {
    throw new Error(`Envs.sh menolak upload: ${JSON.stringify(response.data).slice(0, 200)}`);
  }
  return url;
}

// Urutan sengaja diprioritaskan dari yang URL-nya PERMANEN/retensi paling
// panjang ke yang paling pendek, karena user butuh link yang nggak hilang:
// - Catbox   : permanen, nggak ada auto-delete (utama)
// - Qu.ax    : permanen, nggak ada auto-delete
// - 0x0.st   : retensi panjang (30 hari - 1 tahun tergantung ukuran file, bukan instan hilang)
// - Envs.sh  : sama seperti 0x0.st (mirrornya)
// - Uguu     : SEMENTARA (~48 jam) — cuma fallback kalau 4 di atas semua gagal
// - Litterbox: SEMENTARA (maks 72 jam) — fallback paling akhir/terakhir
const UPLOAD_PROVIDERS = [
  { name: "Catbox", fn: uploadToCatbox },
  { name: "Qu.ax", fn: uploadToQuAx },
  { name: "0x0.st", fn: uploadTo0x0 },
  { name: "Envs.sh", fn: uploadToEnvs },
  { name: "Uguu", fn: uploadToUguu },
  { name: "Litterbox", fn: uploadToLitterbox },
];

// Beberapa provider (khususnya Qu.ax & Uguu, basisnya pomf2) kadang balikin
// URL TANPA ekstensi sama sekali (mis. "https://qu.ax/lqijk" padahal isinya
// gambar) walau filename yang kita kirim sudah punya ekstensi jelas. Ini bikin
// endpoint lain yang butuh nebak tipe file dari URL (harus .jpg/.png/dst) gagal
// memproses. Fungsi ini nyoba nambahin ekstensi yang bener di belakang URL,
// TAPI diverifikasi dulu beneran bisa diakses sebelum dipakai — kalau ternyata
// nggak valid, balik pakai URL asli (yang masih tetap valid, cuma tanpa ekstensi)
// daripada ngasih link mati ke user.
async function ensureUrlExtension(url, filename) {
  if (!url || typeof url !== "string") return url;
  const extMatch = /\.([a-zA-Z0-9]{2,5})$/.exec(filename || "");
  const ext = extMatch ? extMatch[1].toLowerCase() : null;
  if (!ext) return url;

  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return url;
  }
  const lastSegment = parsed.pathname.split("/").pop() || "";
  if (/\.[a-zA-Z0-9]{2,5}$/.test(lastSegment)) return url; // sudah ada ekstensi apa pun, jangan diutak-atik

  const candidate = `${url}.${ext}`;
  try {
    const check = await axios.head(candidate, { timeout: 8000, validateStatus: () => true });
    if (check.status >= 200 && check.status < 400) return candidate;
  } catch (e) {
    // diamkan, fallback ke url asli di bawah
  }
  return url;
}

async function uploadFileToUrl(buffer, filename) {
  const failures = [];
  for (const provider of UPLOAD_PROVIDERS) {
    try {
      const rawUrl = await provider.fn(buffer, filename);
      return await ensureUrlExtension(rawUrl, filename);
    } catch (err) {
      const status = err?.response?.status;
      const detail = `${provider.name}${status ? ` (status ${status})` : ""}: ${err.message}`;
      console.error(`[tourl] ${detail}`);
      failures.push(detail);
    }
  }
  throw new Error(`Semua layanan upload gagal.\n${failures.join("\n")}`);
}


function renderPaymentStatusText() {
  const status = getGatewayStatus();
  const s = status.nevapedia;
  const icon = s.healthy ? "✅" : "⛔";
  const state = s.healthy ? "Sehat / aktif" : `Di-skip sementara (${s.cooldownRemainingSec}s lagi)`;
  let gw = `${icon} <b>Nevapedia</b>\n<b>┃</b> Status: ${state}\n<b>┃</b> Gagal beruntun: ${s.failCount}`;
  if (s.lastError) {
    gw += `\n<b>┃</b> Error terakhir: ${s.lastError}`;
  }
  return `<blockquote><b>💳 STATUS PAYMENT GATEWAY</b>\n\n${gw}</blockquote>`;
}

const PAYMENT_STATUS_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "🔄 Tes Koneksi (2 tahap)", callback_data: "paymenttest_live" }],
      [{ text: "💰 Cek Saldo Nevapedia", callback_data: "paymenttest_balance" }],
      [{ text: "🔙 Kembali", callback_data: "menu_owner" }]
    ]
  }
};

bot.command("paymentstatus", async (ctx) => {
  if (ctx.from.id !== config.ownerId) {
    return safeReply(ctx, "<blockquote>🔒 <b>Command khusus owner.</b></blockquote>", { parse_mode: "HTML" });
  }
  return safeReply(ctx, renderPaymentStatusText(), { parse_mode: "HTML", ...PAYMENT_STATUS_KEYBOARD });
});

bot.action("paymentstatus_menu", async (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  await ctx.answerCbQuery().catch(() => {});
  await editMenuMessage(ctx, renderPaymentStatusText(), { parse_mode: "HTML", ...PAYMENT_STATUS_KEYBOARD });
});

bot.action("paymenttest_balance", async (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  await ctx.answerCbQuery("⏳ Mengambil data saldo...").catch(() => {});

  const waitMsg = await safeReply(ctx, "<blockquote>⏳ <b>Mengambil saldo dari Nevapedia...</b></blockquote>", { parse_mode: "HTML" });

  const result = await getNevapediaBalance({ apikey: config.nevapedia?.apikey });

  const text = result && !result.error
    ? `<blockquote><b>╭━━━━✧「 💰 𝗦𝗔𝗟𝗗𝗢 𝗡𝗘𝗩𝗔𝗣𝗘𝗗𝗜𝗔 」✧━━━━❍</b>\n` +
      `<b>┃</b> 👤 <b>Akun</b>      : ${result.username}\n` +
      `<b>┃</b> 📧 <b>Email</b>     : ${result.email}\n` +
      `<b>┃</b> 💵 <b>Saldo</b>     : <code>${toRupiah(result.balance)}</code>\n` +
      `<b>┃</b> ⏳ <b>Pending</b>   : <code>${toRupiah(result.pendingBalance)}</code>\n` +
      `<b>╰━━━━━━━━━━━━━━━━━━━━━━━━❍</b></blockquote>`
    : `<blockquote>❌ <b>Gagal ambil saldo.</b>\n<b>Sebab:</b> ${result?.error || "Unknown error"}</blockquote>`;

  try {
    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" });
  } catch (e) {
    await safeReply(ctx, text, { parse_mode: "HTML" });
  }
});

bot.action("paymenttest_live", async (ctx) => {
  if (ctx.from.id !== config.ownerId) return ctx.answerCbQuery("❌ Bukan Owner!");
  await ctx.answerCbQuery("⏳ Menguji koneksi ke Nevapedia...").catch(() => {});

  const waitMsg = await safeReply(ctx, "<blockquote>⏳ <b>Menguji koneksi ke Nevapedia...</b>\n<i>Tahap 1: domain utama. Tahap 2: endpoint API invoice (nominal tes Rp 100).</i>\nMohon tunggu...</blockquote>", { parse_mode: "HTML" });

  const result = await testNevapediaConnectivity(config.nevapedia?.apikey);

  const renderStage = (r) => {
    if (!r) return "⚪ <i>tidak dites</i>";
    if (r.ok) {
      let line = `✅ <b>OK</b> <i>(${r.elapsedSec}s)</i>`;
      if (r.httpStatus !== undefined) line += `\n     ↳ HTTP <code>${r.httpStatus}</code> · <code>${r.rawResponse}</code>`;
      return line;
    }
    return `❌ <b>GAGAL</b> <i>(${r.elapsedSec}s)</i>\n     ↳ ${r.error}`;
  };

  const verdict = result.baseDomain?.ok && result.apiEndpoint?.ok
    ? "🟢 <b>Semua normal.</b> Kalau tetap gagal saat bayar, mungkin sekadar hiccup sesaat — coba lagi."
    : !result.baseDomain?.ok
      ? "🔴 <b>Domain utama aja udah gagal</b> → masalah jaringan/DNS di VPS ini (bukan spesifik Nevapedia)."
      : "🟡 <b>Domain hidup, tapi endpoint API gagal</b> → spesifik masalah di endpoint/API key, bukan jaringan.";

  const text =
    `<blockquote><b>╭━━━━✧「 🩺 𝗧𝗘𝗦 𝗞𝗢𝗡𝗘𝗞𝗦𝗜 𝗡𝗘𝗩𝗔𝗣𝗘𝗗𝗜𝗔 」✧━━━━❍</b>\n\n` +
    `<b>① Domain utama</b> <i>(app.nevapedia.com)</i>\n${renderStage(result.baseDomain)}\n\n` +
    `<b>② Endpoint API</b> <i>(/api/invoice)</i>\n${renderStage(result.apiEndpoint)}\n\n` +
    `<b>╰━━━━━━━━━━━━━━━━━━━━━━━━❍</b>\n\n` +
    `${verdict}</blockquote>`;

  try {
    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" });
  } catch (e) {
    await safeReply(ctx, text, { parse_mode: "HTML" });
  }
});

bot.command("tourl", async (ctx) => {
  const replyMsg = ctx.message.reply_to_message;
  if (!replyMsg) {
    return safeReply(
      ctx,
      `<blockquote>❌ <b>Balas sebuah gambar dengan perintah /tourl</b>\n<i>Ubah gambar (foto/dokumen gambar) jadi link URL langsung (.jpg/.png/dst) — bukan buat download file.</i></blockquote>`,
      { parse_mode: "HTML" }
    );
  }

  // Deteksi apakah pesan yang dibalas benar-benar gambar. Dokumen (file) cuma
  // diterima kalau mime type-nya emang gambar — video/audio/voice/dokumen
  // non-gambar ditolak dengan pesan jelas, sesuai fungsi command ini yang
  // khusus "gambar -> URL", bukan uploader file serba-guna.
  const isPhoto = !!replyMsg.photo;
  const docMime = replyMsg.document?.mime_type || "";
  const isImageDocument = !!replyMsg.document && docMime.startsWith("image/");

  if (!isPhoto && !isImageDocument) {
    return safeReply(
      ctx,
      `<blockquote>❌ <b>Pesan yang kamu balas bukan gambar.</b>\n<i>/tourl khusus buat ubah gambar (foto/dokumen bertipe image) jadi URL — bukan buat video/audio/voice/dokumen lain.</i></blockquote>`,
      { parse_mode: "HTML" }
    );
  }

  // Ekstensi file ditentukan dari mime type asli, BUKAN dari nama file yang
  // dikasih user (bisa kosong/tanpa ekstensi kalau dikirim sebagai dokumen),
  // supaya URL hasil upload selalu jelas .jpg/.png/dst dan bisa langsung
  // dipakai endpoint gambar lain.
  const MIME_TO_EXT = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
  };
  const ext = isPhoto ? "jpg" : (MIME_TO_EXT[docMime] || "jpg");
  const fileId = isPhoto ? replyMsg.photo[replyMsg.photo.length - 1].file_id : replyMsg.document.file_id;
  const filename = `image_${Date.now()}.${ext}`;

  const waitMsg = await safeReply(ctx, "<blockquote>⏳ <b>Mengupload gambar...</b></blockquote>", { parse_mode: "HTML" });

  try {
    const file = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;

    const res = await axios.get(fileUrl, { responseType: "arraybuffer" });
    const buffer = Buffer.from(res.data);

    const imageUrl = await uploadFileToUrl(buffer, filename);
    const text = `<blockquote>✅ <b>Gambar berhasil diubah jadi URL:</b>\n<code>${ExtAPI.escapeHtml(imageUrl)}</code></blockquote>`;

    try {
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" });
    } catch (e) {
      await safeReply(ctx, text, { parse_mode: "HTML" });
    }
  } catch (err) {
    console.error("tourl error:", err);
    const rawMessage = (err && err.message) ? err.message : String(err || "Unknown error");
    const cleanError = ExtAPI.escapeHtml(rawMessage);
    const text = `<blockquote>❌ <b>Gagal ubah gambar ke URL:</b> ${cleanError}</blockquote>`;
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" });
    } catch (e) {
      await safeReply(ctx, text, { parse_mode: "HTML" });
    }
  }
});

// ================= TOOLS BARU (nambahin ke menu Tools bawaan) =================
async function fidzzToolCommand(ctx, epKey, callArgs, { loadingText, buildSuccessText, media } = {}) {
  const ep = ExtAPI.findEndpoint(ExtAPI.FIDZZ_ENDPOINTS, epKey);
  if (!ep) return safeReply(ctx, "<blockquote>❌ <b>Endpoint tidak ditemukan di registry.</b></blockquote>", { parse_mode: "HTML" });

  const apikey = config.externalApi?.fidzzcodex?.apikey;
  if (!apikey || apikey === "-") {
    return safeReply(
      ctx,
      `<blockquote>⚠️ <b>API key belum diisi.</b>\nIsi dulu <code>config.externalApi.fidzzcodex.apikey</code> di config.js sebelum fitur ini bisa dipakai.</blockquote>`,
      { parse_mode: "HTML" }
    );
  }

  const waitMsg = await safeReply(ctx, `<blockquote>⏳ <b>${loadingText || "Memproses..."}</b></blockquote>`, { parse_mode: "HTML" });

  try {
    const data = ExtAPI.deepStripCredit(await ExtAPI.callFidzz(ep, callArgs));
    const found = ExtAPI.extractMedia(data);
    const url = found?.url;
    const mediaType = media || found?.type;

    if (url && (mediaType === "image" || mediaType === "audio" || mediaType === "video")) {
      const caption = buildSuccessText ? buildSuccessText(data) : "<blockquote>✅ <b>Berhasil!</b></blockquote>";
      const sendFn = mediaType === "image" ? "replyWithPhoto" : mediaType === "audio" ? "replyWithAudio" : "replyWithVideo";
      try {
        // Coba kirim langsung pakai URL dulu (lebih cepat, tanpa transit lewat server bot)
        await ctx[sendFn](url, { caption, parse_mode: "HTML" });
      } catch (sendErr) {
        // Fallback: Telegram sering gagal fetch URL CDN (mis. TikTok) tanpa
        // header yang sesuai -> "400: Bad Request: failed to get HTTP URL content".
        // Download dulu di server bot, baru upload sebagai buffer.
        const buffer = await ExtAPI.downloadMediaBuffer(url, callArgs.url || callArgs.link);
        const ext = mediaType === "image" ? "jpg" : mediaType === "audio" ? "mp3" : "mp4";
        await ctx[sendFn]({ source: buffer, filename: `media.${ext}` }, { caption, parse_mode: "HTML" });
      }
    } else {
      const text = buildSuccessText ? buildSuccessText(data) : ExtAPI.formatResultText(ep, data);
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" });
        return;
      } catch (e) { /* fallthrough ke safeReply di bawah */ }
      return safeReply(ctx, text, { parse_mode: "HTML" });
    }

    try { await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
  } catch (e) {
    const detail = e.response?.data && typeof e.response.data === "object" ? ExtAPI.extractFailMessage(e.response.data) : e.message;
    const text = `<blockquote>❌ <b>Gagal:</b>\n<code>${ExtAPI.escapeHtml(detail)}</code></blockquote>`;
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" });
    } catch (e2) {
      await safeReply(ctx, text, { parse_mode: "HTML" });
    }
  }
}

bot.command("bypass2", async (ctx) => {
  const url = ctx.message.text.split(" ")[1];
  if (!url) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/bypass2 url</code>\n<i>Bypass SFL.gl, Linkvertise, dan shortlink lain.</i></blockquote>", { parse_mode: "HTML" });
  await fidzzToolCommand(ctx, "bypass2", { url }, {
    loadingText: "Bypass shortlink...",
    buildSuccessText: (data) => `<blockquote>✅ <b>Bypass berhasil!</b>\n<code>${ExtAPI.escapeHtml((data?.result || data?.url || JSON.stringify(data)).toString().slice(0, 1000))}</code></blockquote>`,
  });
});

bot.command("wachannel", async (ctx) => {
  const url = ctx.message.text.split(" ")[1];
  if (!url) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/wachannel url</code>\n<i>Ambil informasi channel WhatsApp.</i>\n<code>/wachannel https://www.whatsapp.com/channel/xxxxx</code></blockquote>", { parse_mode: "HTML" });
  await fidzzToolCommand(ctx, "wa-channel", { url }, {
    loadingText: "Mengambil info channel WhatsApp...",
  });
});

bot.command("channelid", async (ctx) => {
  const link = ctx.message.text.split(" ")[1];
  if (!link) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/channelid link</code>\n<i>Ambil ID dan JID dari link WhatsApp Channel.</i>\n<code>/channelid https://whatsapp.com/channel/00xxxxx</code></blockquote>", { parse_mode: "HTML" });
  await fidzzToolCommand(ctx, "channel-id", { link }, {
    loadingText: "Mengekstrak ID channel...",
  });
});

bot.command("capcutdl", async (ctx) => {
  const url = ctx.message.text.split(" ")[1];
  if (!url) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/capcutdl url</code>\n<i>Download video/template Capcut.</i>\n<code>/capcutdl https://www.capcut.com/template/xxxxx</code></blockquote>", { parse_mode: "HTML" });
  await fidzzToolCommand(ctx, "capcut", { url }, { loadingText: "Mengunduh video Capcut...", media: "video" });
});

bot.command("ttpp", async (ctx) => {
  const username = ctx.message.text.replace(/^\/ttpp(@\w+)?\s*/i, "").trim();
  if (!username) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/ttpp username</code>\n<i>Ambil foto profil TikTok user.</i></blockquote>", { parse_mode: "HTML" });
  await fidzzToolCommand(ctx, "getpp", { username }, { loadingText: "Mengambil foto profil TikTok...", media: "image" });
});

bot.command("pinsearch", async (ctx) => {
  const q = ctx.message.text.replace(/^\/pinsearch(@\w+)?\s*/i, "").trim();
  if (!q) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/pinsearch kata kunci</code>\n<i>Cari pin di Pinterest.</i></blockquote>", { parse_mode: "HTML" });
  await fidzzToolCommand(ctx, "pinterest-search", { q }, { loadingText: "Mencari pin di Pinterest..." });
});

bot.command("pinvideo", async (ctx) => {
  const q = ctx.message.text.replace(/^\/pinvideo(@\w+)?\s*/i, "").trim();
  if (!q) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/pinvideo kata kunci</code>\n<i>Cari video di Pinterest.</i></blockquote>", { parse_mode: "HTML" });
  await fidzzToolCommand(ctx, "pinterest-video", { q }, { loadingText: "Mencari video di Pinterest...", media: "video" });
});

// HD Video Enhancer butuh upload FILE video (bukan url) -> multipart/form-data manual
bot.command("hdvideo", async (ctx) => {
  const replyMsg = ctx.message.reply_to_message;
  const video = replyMsg?.video || replyMsg?.document;
  if (!video) {
    return safeReply(ctx, "<blockquote>❌ <b>Balas sebuah video dengan perintah /hdvideo</b>\n<i>Enhance video jadi kualitas tinggi.</i></blockquote>", { parse_mode: "HTML" });
  }

  const apikey = config.externalApi?.fidzzcodex?.apikey;
  if (!apikey || apikey === "-") {
    return safeReply(ctx, `<blockquote>⚠️ <b>API key belum diisi</b> di config.js.</blockquote>`, { parse_mode: "HTML" });
  }

  const waitMsg = await safeReply(ctx, "<blockquote>⏳ <b>Upload video...</b></blockquote>", { parse_mode: "HTML" });
  try {
    const fileId = video.file_id;
    const file = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
    const res = await axios.get(fileUrl, { responseType: "arraybuffer" });
    const buffer = Buffer.from(res.data);

    // Endpoint /ai/hdvideo butuh param "url" (link publik), BUKAN upload binary
    // langsung -> upload dulu ke hosting sementara (Catbox dkk) via uploadFileToUrl.
    const publicUrl = await uploadFileToUrl(buffer, video.file_name || "video.mp4");

    try { await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, "<blockquote>⏳ <b>Enhance video, mohon tunggu...</b></blockquote>", { parse_mode: "HTML" }); } catch (e) {}

    const ep = ExtAPI.findEndpoint(ExtAPI.FIDZZ_ENDPOINTS, "hdvideo");
    const data = ExtAPI.deepStripCredit(await ExtAPI.callFidzz(ep, { url: publicUrl }));

    const outUrl = ExtAPI.extractMediaUrl(data);
    if (outUrl) {
      const caption = "<blockquote>✅ <b>Video berhasil di-enhance!</b></blockquote>";
      try {
        await ctx.replyWithVideo(outUrl, { caption, parse_mode: "HTML" });
      } catch (sendErr) {
        const outBuffer = await ExtAPI.downloadMediaBuffer(outUrl);
        await ctx.replyWithVideo({ source: outBuffer, filename: "hd.mp4" }, { caption, parse_mode: "HTML" });
      }
      try { await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
    } else {
      const text = ExtAPI.formatResultText({ desc: "Enhance Video" }, data);
      try { await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" }); }
      catch (e) { await safeReply(ctx, text, { parse_mode: "HTML" }); }
    }
  } catch (e) {
    const detail = e.response?.data && typeof e.response.data === "object" ? ExtAPI.extractFailMessage(e.response.data) : e.message;
    const text = `<blockquote>❌ <b>Gagal enhance video:</b>\n<code>${ExtAPI.escapeHtml(detail)}</code></blockquote>`;
    try { await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" }); }
    catch (e2) { await safeReply(ctx, text, { parse_mode: "HTML" }); }
  }
});

bot.command("crypto", async (ctx) => {
  const coins = ctx.message.text.replace(/^\/crypto(@\w+)?\s*/i, "").trim();
  if (!coins) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/crypto btc,eth,sol</code>\n<i>Cek harga crypto real-time.</i></blockquote>", { parse_mode: "HTML" });
  await fidzzToolCommand(ctx, "crypto", { coins }, { loadingText: "Mengambil harga crypto..." });
});

bot.command("emojimix", async (ctx) => {
  const emoji = ctx.message.text.replace(/^\/emojimix(@\w+)?\s*/i, "").trim();
  if (!emoji) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/emojimix 😀😍</code>\n<i>Gabung 2 emoji jadi 1 (Google Emoji Kitchen).</i></blockquote>", { parse_mode: "HTML" });
  await fidzzToolCommand(ctx, "emojimix", { emoji }, { loadingText: "Meracik emoji...", media: "image" });
});

bot.command("npmcheck", async (ctx) => {
  const pkg = ctx.message.text.split(" ")[1];
  if (!pkg) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/npmcheck nama-package</code>\n<i>Cek versi terbaru package NPM.</i></blockquote>", { parse_mode: "HTML" });
  await fidzzToolCommand(ctx, "npm-check", { package: pkg }, { loadingText: "Mengecek NPM registry..." });
});

bot.command("codesearch", async (ctx) => {
  const args = ctx.message.text.replace(/^\/codesearch(@\w+)?\s*/i, "").trim();
  if (!args) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/codesearch query</code>\n<i>Cari kode di GitHub via Searchcode.</i></blockquote>", { parse_mode: "HTML" });
  await fidzzToolCommand(ctx, "code-search", { q: args }, { loadingText: "Mencari kode..." });
});

bot.command("spotifysearch", async (ctx) => {
  const q = ctx.message.text.replace(/^\/spotifysearch(@\w+)?\s*/i, "").trim();
  if (!q) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/spotifysearch judul lagu</code></blockquote>", { parse_mode: "HTML" });
  await fidzzToolCommand(ctx, "spotify-search-fidzz", { q }, { loadingText: "Mencari lagu di Spotify..." });
});

bot.command("spotifydl2", async (ctx) => {
  const url = ctx.message.text.split(" ")[1];
  if (!url) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/spotifydl2 url</code>\n<i>Download lagu dari Spotify.</i></blockquote>", { parse_mode: "HTML" });
  await fidzzToolCommand(ctx, "spotify-dl-fidzz", { url }, { loadingText: "Mengunduh lagu Spotify...", media: "audio" });
});

bot.command("tiktokdl2", async (ctx) => {
  const url = ctx.message.text.split(" ")[1];
  if (!url) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/tiktokdl2 url</code>\n<i>Download video/audio TikTok tanpa watermark.</i></blockquote>", { parse_mode: "HTML" });
  await fidzzToolCommand(ctx, "tiktok-dl-fidzz", { url }, { loadingText: "Mengunduh video TikTok...", media: "video" });
});

bot.command("chatgptmobile", async (ctx) => {
  const prompt = ctx.message.text.replace(/^\/chatgptmobile(@\w+)?\s*/i, "").trim();
  if (!prompt) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/chatgptmobile pertanyaanmu</code></blockquote>", { parse_mode: "HTML" });
  await fidzzToolCommand(ctx, "chatgpt-mobile", { prompt, session_id: `chatgpt_${ctx.from.id}` }, {
    loadingText: "Bertanya ke ChatGPT...",
    buildSuccessText: (data) => `<blockquote>🤖 <b>ChatGPT:</b>\n\n${ExtAPI.escapeHtml((data?.result || data?.message || JSON.stringify(data)).toString().slice(0, 3500))}</blockquote>`,
  });
});

// ================= NEXRAY DOWNLOADER (42 endpoint, gratis TANPA apikey) =================
// Sumber: https://api.nexray.eu.cc/category/downloader
async function nexrayToolCommand(ctx, epKey, callArgs, { loadingText, buildSuccessText, media } = {}) {
  const ep = ExtAPI.findEndpoint(ExtAPI.NEXRAY_ENDPOINTS, epKey);
  if (!ep) return safeReply(ctx, "<blockquote>❌ <b>Endpoint tidak ditemukan di registry.</b></blockquote>", { parse_mode: "HTML" });

  const waitMsg = await safeReply(ctx, `<blockquote>⏳ <b>${loadingText || "Memproses..."}</b></blockquote>`, { parse_mode: "HTML" });

  try {
    const data = ExtAPI.deepStripCredit(await ExtAPI.callNexray(ep, callArgs));
    const found = ExtAPI.extractMedia(data);
    const url = found?.url;
    const mediaType = media || found?.type;

    if (url && (mediaType === "image" || mediaType === "audio" || mediaType === "video")) {
      const caption = buildSuccessText ? buildSuccessText(data) : "<blockquote>✅ <b>Berhasil!</b></blockquote>";
      const sendFn = mediaType === "image" ? "replyWithPhoto" : mediaType === "audio" ? "replyWithAudio" : "replyWithVideo";
      try {
        // Coba kirim langsung pakai URL dulu (lebih cepat, tanpa transit lewat server bot)
        await ctx[sendFn](url, { caption, parse_mode: "HTML" });
      } catch (sendErr) {
        // Fallback: Telegram sering gagal fetch URL CDN langsung tanpa header
        // yang sesuai -> "400: Bad Request: failed to get HTTP URL content".
        // Download dulu di server bot, baru upload sebagai buffer.
        const buffer = await ExtAPI.downloadMediaBuffer(url, callArgs.url || callArgs.q);
        const ext = mediaType === "image" ? "jpg" : mediaType === "audio" ? "mp3" : "mp4";
        await ctx[sendFn]({ source: buffer, filename: `media.${ext}` }, { caption, parse_mode: "HTML" });
      }
    } else if (url) {
      // File generik (mis. MediaFire/Mega/Scribd/SFile/KrakenFiles/GoogleDrive/GitHub)
      // dikirim sebagai dokumen; kalau Telegram gagal fetch URL-nya, fallback ke teks berisi link.
      const caption = buildSuccessText ? buildSuccessText(data) : "<blockquote>✅ <b>Berhasil!</b></blockquote>";
      try {
        await ctx.replyWithDocument(url, { caption, parse_mode: "HTML" });
      } catch (sendErr) {
        const text = buildSuccessText ? buildSuccessText(data) : ExtAPI.formatResultText(ep, data);
        try {
          await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" });
          return;
        } catch (e) { /* fallthrough ke safeReply di bawah */ }
        return safeReply(ctx, text, { parse_mode: "HTML" });
      }
    } else {
      const text = buildSuccessText ? buildSuccessText(data) : ExtAPI.formatResultText(ep, data);
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" });
        return;
      } catch (e) { /* fallthrough ke safeReply di bawah */ }
      return safeReply(ctx, text, { parse_mode: "HTML" });
    }

    try { await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
  } catch (e) {
    const detail = e.response?.data && typeof e.response.data === "object" ? ExtAPI.extractFailMessage(e.response.data) : e.message;
    const text = `<blockquote>❌ <b>Gagal:</b>\n<code>${ExtAPI.escapeHtml(detail)}</code></blockquote>`;
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" });
    } catch (e2) {
      await safeReply(ctx, text, { parse_mode: "HTML" });
    }
  }
}

// Daftar command berbasis param "url" (+ opsional 1 param tambahan seperti quality/resolusi)
const NEXRAY_URL_COMMANDS = [
  { cmd: "dlaio", epKey: "aio", label: "All-in-One Downloader", example: "https://www.instagram.com/reel/xxxx" },
  { cmd: "dlapplemusic", epKey: "applemusic", label: "Apple Music Downloader", media: "audio", example: "https://music.apple.com/id/album/xxxx" },
  { cmd: "dlbilibili", epKey: "bilibili", label: "Bilibili Downloader", media: "video", example: "https://www.bilibili.com/video/xxxx" },
  { cmd: "dlcapcut", epKey: "capcut", label: "CapCut Downloader", media: "video", example: "https://www.capcut.com/template/xxxx" },
  { cmd: "dlcapcutv1", epKey: "capcut-v1", label: "CapCut Downloader v1", media: "video", example: "https://www.capcut.com/template/xxxx" },
  { cmd: "dlcocofun", epKey: "cocofun", label: "Cocofun Downloader", media: "video", example: "https://www.icocofun.com/s/xxxx" },
  { cmd: "dldouyin", epKey: "douyin", label: "Douyin Downloader", media: "video", example: "https://www.douyin.com/video/xxxx" },
  { cmd: "dldouyinv1", epKey: "douyin-v1", label: "Douyin Downloader v1", media: "video", example: "https://www.douyin.com/video/xxxx" },
  { cmd: "dlfacebook", epKey: "facebook", label: "Facebook Downloader", media: "video", example: "https://www.facebook.com/watch/?v=xxxx" },
  { cmd: "dlgithub", epKey: "github", label: "GitHub Repo Downloader", example: "https://github.com/user/repo" },
  { cmd: "dlgdrive", epKey: "googledrive", label: "Google Drive Downloader", example: "https://drive.google.com/file/d/xxxx" },
  { cmd: "dlinstagram", epKey: "instagram", label: "Instagram Downloader", example: "https://www.instagram.com/p/xxxx" },
  { cmd: "dlinstagramv1", epKey: "instagram-v1", label: "Instagram Downloader v1", example: "https://www.instagram.com/p/xxxx" },
  { cmd: "dlinstagramv2", epKey: "instagram-v2", label: "Instagram Downloader v2", example: "https://www.instagram.com/p/xxxx" },
  { cmd: "dlkrakenfiles", epKey: "krakenfiles", label: "KrakenFiles Downloader", example: "https://krakenfiles.com/view/xxxx" },
  { cmd: "dllikee", epKey: "likee", label: "Likee Downloader", media: "video", example: "https://l.likee.video/v/xxxx" },
  { cmd: "dlmediafire", epKey: "mediafire", label: "MediaFire Downloader", example: "https://www.mediafire.com/file/xxxx" },
  { cmd: "dlmega", epKey: "mega", label: "Mega.nz Downloader", example: "https://mega.nz/file/xxxx" },
  { cmd: "dlpinterest", epKey: "pinterest", label: "Pinterest Downloader", example: "https://id.pinterest.com/pin/xxxx" },
  { cmd: "dlrednote", epKey: "rednote", label: "RedNote (Xiaohongshu) Downloader", example: "https://xhslink.com/o/xxxx" },
  { cmd: "dlsavetube", epKey: "savetube", label: "SaveTube (YouTube) Downloader", example: "https://youtu.be/xxxx", extraParam: { name: "quality", def: "mp3" } },
  { cmd: "dlscribd", epKey: "scribd", label: "Scribd Downloader", example: "https://www.scribd.com/document/xxxx" },
  { cmd: "dlsfile", epKey: "sfile", label: "SFile Downloader", example: "https://sfile.mobi/xxxx" },
  { cmd: "dlsmule", epKey: "smule", label: "Smule Downloader", media: "audio", example: "https://www.smule.com/recording/xxxx" },
  { cmd: "dlsnackvideo", epKey: "snackvideo", label: "SnackVideo Downloader", media: "video", example: "https://share.snackvideo.com/xxxx" },
  { cmd: "dlsoundcloud", epKey: "soundcloud", label: "SoundCloud Downloader", media: "audio", example: "https://soundcloud.com/user/track" },
  { cmd: "dlspotify", epKey: "spotify", label: "Spotify Downloader", media: "audio", example: "https://open.spotify.com/track/xxxx" },
  { cmd: "dlspotifyv1", epKey: "spotify-v1", label: "Spotify Downloader v1 (support playlist)", media: "audio", example: "https://open.spotify.com/playlist/xxxx" },
  { cmd: "dlterabox", epKey: "terabox", label: "Terabox Downloader", media: "video", example: "https://www.terabox.com/s/xxxx" },
  { cmd: "dlthreads", epKey: "threads", label: "Threads Downloader", example: "https://www.threads.net/@user/post/xxxx" },
  { cmd: "dltiktok2", epKey: "tiktok", label: "TikTok Downloader", media: "video", example: "https://www.tiktok.com/@user/video/xxxx" },
  { cmd: "dltwitter", epKey: "twitter", label: "Twitter/X Downloader", media: "video", example: "https://x.com/user/status/xxxx" },
  { cmd: "dlvidey", epKey: "videy", label: "Videy.co Downloader", media: "video", example: "https://videy.co/v?id=xxxx" },
  { cmd: "dlwebmusic", epKey: "webmusic", label: "WebMusic Downloader", example: "https://webmusic.example/xxxx" },
  { cmd: "dlytmp3", epKey: "ytmp3", label: "YouTube MP3 Downloader", media: "audio", example: "https://youtu.be/xxxx" },
  { cmd: "dlytmp3v1", epKey: "ytmp3-v1", label: "YouTube MP3 Downloader v1", media: "audio", example: "https://youtu.be/xxxx" },
  { cmd: "dlytmp4", epKey: "ytmp4", label: "YouTube MP4 Downloader", media: "video", example: "https://youtu.be/xxxx", extraParam: { name: "resolusi", def: "360" } },
  { cmd: "dlytmp4v1", epKey: "ytmp4-v1", label: "YouTube MP4 Downloader v1", media: "video", example: "https://youtu.be/xxxx", extraParam: { name: "resolusi", def: "360" } },
];

for (const c of NEXRAY_URL_COMMANDS) {
  bot.command(c.cmd, async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const url = parts[1];
    if (!url) {
      return safeReply(
        ctx,
        `<blockquote>❌ <b>Gunakan:</b> <code>/${c.cmd} url${c.extraParam ? " [" + c.extraParam.name + "]" : ""}</code>\n<i>${c.label}.</i>\n<code>/${c.cmd} ${c.example}</code></blockquote>`,
        { parse_mode: "HTML" }
      );
    }
    const callArgs = { url };
    if (c.extraParam) callArgs[c.extraParam.name] = parts[2] || c.extraParam.def;
    await nexrayToolCommand(ctx, c.epKey, callArgs, {
      loadingText: `Memproses ${c.label}...`,
      media: c.media,
    });
  });
}

// Daftar command berbasis param "q" (kata kunci pencarian, boleh mengandung spasi)
const NEXRAY_Q_COMMANDS = [
  { cmd: "dlnpm", epKey: "npm", label: "Info Package NPM", example: "axios" },
  { cmd: "dlspotifyplay", epKey: "spotifyplay", label: "Cari & Download Spotify (judul lagu)", media: "audio", example: "Blinding Lights Weeknd" },
  { cmd: "dlytplay", epKey: "ytplay", label: "Cari & Download MP3 YouTube (judul lagu)", media: "audio", example: "Blinding Lights Weeknd" },
  { cmd: "dlytplayvid", epKey: "ytplayvid", label: "Cari & Download MP4 YouTube (judul video)", media: "video", example: "Blinding Lights Weeknd" },
];

for (const c of NEXRAY_Q_COMMANDS) {
  bot.command(c.cmd, async (ctx) => {
    const q = ctx.message.text.replace(new RegExp(`^/${c.cmd}(@\\w+)?\\s*`, "i"), "").trim();
    if (!q) {
      return safeReply(
        ctx,
        `<blockquote>❌ <b>Gunakan:</b> <code>/${c.cmd} kata kunci</code>\n<i>${c.label}.</i>\n<code>/${c.cmd} ${c.example}</code></blockquote>`,
        { parse_mode: "HTML" }
      );
    }
    await nexrayToolCommand(ctx, c.epKey, { q }, {
      loadingText: `Memproses ${c.label}...`,
      media: c.media,
    });
  });
}

// ================= NEXRAY AI (22 endpoint, batch ke-2, gratis TANPA apikey) =================
// Sumber: https://api.nexray.eu.cc/category/ai

// Command chat AI biasa: param "text" saja
const NEXRAY_AI_TEXT_COMMANDS = [
  { cmd: "aialisia", epKey: "alisia", label: "Chat Alisia AI", example: "Halo apa kabar?" },
  { cmd: "aiandisearch", epKey: "andisearch", label: "Chat Andisearch AI", example: "Halo apa kabar?" },
  { cmd: "aibypass", epKey: "bypass-ai", label: "Bypass AI Detector / Humanize Teks", example: "Tulisan hasil AI yang mau di-humanize..." },
  { cmd: "aichatgpt", epKey: "chatgpt-nx", label: "Chat ChatGPT", example: "Halo apa kabar?" },
  { cmd: "aiclaude", epKey: "claude-nx", label: "Chat Claude AI", example: "Halo apa kabar?" },
  { cmd: "aicopilot", epKey: "copilot", label: "Chat Copilot AI", example: "Halo apa kabar?" },
  { cmd: "aideepsearch", epKey: "deepsearch", label: "Deep Search AI Research Assistant", example: "Perkembangan AI terbaru 2026" },
  { cmd: "aideepseek", epKey: "deepseek-nx", label: "Chat DeepSeek", example: "Halo apa kabar?" },
  { cmd: "aidgaf", epKey: "dgaf", label: "Chat Dgaf AI", example: "Halo apa kabar?" },
  { cmd: "aidreamanalyze", epKey: "dreamanalyze", label: "Analisis Mimpi dengan AI", example: "I had a dream about flying" },
  { cmd: "aiepsilon", epKey: "epsilon", label: "Cari Paper Akademik (Epsilon AI)", example: "JAKARTA" },
  { cmd: "aifelo", epKey: "felo", label: "Chat Felo AI", example: "Halo apa kabar?" },
  { cmd: "aigitagpt", epKey: "gitagpt", label: "Tanya Jawab GitaGPT", example: "Apa itu dharma?" },
  { cmd: "aigpt35", epKey: "gpt-35-turbo", label: "Chat GPT-3.5 Turbo", example: "Halo apa kabar?" },
  { cmd: "aiislamcity", epKey: "islamcity", label: "Chat IslamCity AI (keislaman)", example: "Apa hukum riba dalam Islam?" },
  { cmd: "aimuslim", epKey: "muslim-nx", label: "Chat AI tentang Islam", example: "Apa itu Islam?" },
];

for (const c of NEXRAY_AI_TEXT_COMMANDS) {
  bot.command(c.cmd, async (ctx) => {
    const text = ctx.message.text.replace(new RegExp(`^/${c.cmd}(@\\w+)?\\s*`, "i"), "").trim();
    if (!text) {
      return safeReply(
        ctx,
        `<blockquote>❌ <b>Gunakan:</b> <code>/${c.cmd} teks</code>\n<i>${c.label}.</i>\n<code>/${c.cmd} ${c.example}</code></blockquote>`,
        { parse_mode: "HTML" }
      );
    }
    await nexrayToolCommand(ctx, c.epKey, { text }, {
      loadingText: `${c.label}...`,
      buildSuccessText: (data) => {
        const msg = data?.result?.response || data?.result?.text || data?.result?.message || data?.result || data?.response || data?.message;
        const clean = typeof msg === "string" ? msg : JSON.stringify(msg, null, 2);
        return `<blockquote>🤖 <b>${ExtAPI.escapeHtml(c.label)}:</b>\n\n${ExtAPI.escapeHtml((clean || "").toString().slice(0, 3500))}</blockquote>`;
      },
    });
  });
}

// Command generate gambar: param "prompt", hasil dikirim sebagai foto
const NEXRAY_AI_IMAGE_COMMANDS = [
  { cmd: "aideepimg", epKey: "deepimg", label: "Generate Gambar (DeepImg AI)", example: "A futuristic Sundanese warrior" },
  { cmd: "aifluxv1", epKey: "flux-v1-nx", label: "Generate Gambar (Flux AI v1)", example: "Neon Samurai" },
  { cmd: "aitext2image", epKey: "text2image-v1", label: "Generate Gambar (Text to Image v1)", example: "cat in the sky" },
];

for (const c of NEXRAY_AI_IMAGE_COMMANDS) {
  bot.command(c.cmd, async (ctx) => {
    const prompt = ctx.message.text.replace(new RegExp(`^/${c.cmd}(@\\w+)?\\s*`, "i"), "").trim();
    if (!prompt) {
      return safeReply(
        ctx,
        `<blockquote>❌ <b>Gunakan:</b> <code>/${c.cmd} prompt</code>\n<i>${c.label}.</i>\n<code>/${c.cmd} ${c.example}</code></blockquote>`,
        { parse_mode: "HTML" }
      );
    }
    await nexrayToolCommand(ctx, c.epKey, { prompt }, {
      loadingText: `${c.label}...`,
      media: "image",
    });
  });
}

// Text-to-Speech: Gemini TTS (text saja) — hasil dikirim sebagai audio
bot.command("aigeminitts", async (ctx) => {
  const text = ctx.message.text.replace(/^\/aigeminitts(@\w+)?\s*/i, "").trim();
  if (!text) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/aigeminitts teks</code>\n<i>Buat suara/pembicaraan menggunakan Gemini TTS.</i></blockquote>", { parse_mode: "HTML" });
  await nexrayToolCommand(ctx, "gemini-tts", { text }, { loadingText: "Membuat suara Gemini TTS...", media: "audio" });
});

// Text-to-Speech: Dracin TTS (text + speed/volume/music opsional) — hasil dikirim sebagai audio
// Format: /aidracintts teks | speed | volume | music
bot.command("aidracintts", async (ctx) => {
  const raw = ctx.message.text.replace(/^\/aidracintts(@\w+)?\s*/i, "").trim();
  if (!raw) {
    return safeReply(
      ctx,
      `<blockquote>❌ <b>Gunakan:</b> <code>/aidracintts teks | speed | volume | music</code>\n<i>Membuat suara Dracin TTS. Bagian setelah teks bersifat opsional.</i>\n<code>/aidracintts Halo apa kabar</code>\n<code>/aidracintts Halo apa kabar | 1.0 | 0.3 | true</code></blockquote>`,
      { parse_mode: "HTML" }
    );
  }
  const parts = raw.split("|").map((s) => s.trim());
  const [text, speed, volume, music] = parts;
  await nexrayToolCommand(
    ctx,
    "dracin-tts",
    { text, speed: speed || "1.0", volume: volume || "0.3", music: music || "true" },
    { loadingText: "Membuat suara Dracin TTS...", media: "audio" }
  );
});

// Dolphin AI: text + template (dropdown, opsional) — Format: /aidolphin teks | template
bot.command("aidolphin", async (ctx) => {
  const raw = ctx.message.text.replace(/^\/aidolphin(@\w+)?\s*/i, "").trim();
  if (!raw) {
    return safeReply(
      ctx,
      `<blockquote>❌ <b>Gunakan:</b> <code>/aidolphin teks | template</code>\n<i>Chat dengan Dolphin AI. Template opsional, default "logical".</i>\n<code>/aidolphin Halo apa kabar</code></blockquote>`,
      { parse_mode: "HTML" }
    );
  }
  const [text, template] = raw.split("|").map((s) => s.trim());
  await nexrayToolCommand(ctx, "dolphin", { text, template: template || "logical" }, {
    loadingText: "Chat dengan Dolphin AI...",
    buildSuccessText: (data) => {
      const msg = data?.result?.response || data?.result?.text || data?.result || data?.response || data?.message;
      const clean = typeof msg === "string" ? msg : JSON.stringify(msg, null, 2);
      return `<blockquote>🐬 <b>Dolphin AI:</b>\n\n${ExtAPI.escapeHtml((clean || "").toString().slice(0, 3500))}</blockquote>`;
    },
  });
});

// Duck AI: text + model (dropdown, opsional) — Format: /aiduck teks | model
bot.command("aiduck", async (ctx) => {
  const raw = ctx.message.text.replace(/^\/aiduck(@\w+)?\s*/i, "").trim();
  if (!raw) {
    return safeReply(
      ctx,
      `<blockquote>❌ <b>Gunakan:</b> <code>/aiduck teks | model</code>\n<i>Chat dengan Duck AI. Model opsional, default "claude-haiku-4-5".</i>\n<code>/aiduck Halo apa kabar</code></blockquote>`,
      { parse_mode: "HTML" }
    );
  }
  const [text, model] = raw.split("|").map((s) => s.trim());
  await nexrayToolCommand(ctx, "duck", { text, model: model || "claude-haiku-4-5" }, {
    loadingText: "Chat dengan Duck AI...",
    buildSuccessText: (data) => {
      const msg = data?.result?.response || data?.result?.text || data?.result || data?.response || data?.message;
      const clean = typeof msg === "string" ? msg : JSON.stringify(msg, null, 2);
      return `<blockquote>🦆 <b>Duck AI:</b>\n\n${ExtAPI.escapeHtml((clean || "").toString().slice(0, 3500))}</blockquote>`;
    },
  });
});

// Image to Prompt: param "url" (link gambar) -> hasil berupa teks prompt
bot.command("aiimage2prompt", async (ctx) => {
  const url = ctx.message.text.split(/\s+/)[1];
  if (!url) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/aiimage2prompt url_gambar</code>\n<i>Generate prompt teks dari sebuah gambar.</i>\n<code>/aiimage2prompt https://files.catbox.moe/xxxx.jpg</code></blockquote>", { parse_mode: "HTML" });
  await nexrayToolCommand(ctx, "image2prompt", { url }, {
    loadingText: "Menganalisis gambar...",
    buildSuccessText: (data) => {
      const msg = data?.result?.prompt || data?.result?.text || data?.result || data?.prompt || data?.message;
      const clean = typeof msg === "string" ? msg : JSON.stringify(msg, null, 2);
      return `<blockquote>🖼️ <b>Prompt dari gambar:</b>\n\n${ExtAPI.escapeHtml((clean || "").toString().slice(0, 3500))}</blockquote>`;
    },
  });
});

// GPT Image (Edit gambar pakai GPT Vision): butuh UPLOAD FILE -> multipart/form-data manual,
// mengikuti pola yang sama dengan /enhanceimg di bawah (balas foto + kasih instruksi editnya).
bot.command("aigptimage", async (ctx) => {
  const replyMsg = ctx.message.reply_to_message;
  const photo = replyMsg?.photo?.[replyMsg.photo.length - 1] || replyMsg?.document;
  const param = ctx.message.text.replace(/^\/aigptimage(@\w+)?\s*/i, "").trim();
  if (!photo || !param) {
    return safeReply(
      ctx,
      "<blockquote>❌ <b>Balas sebuah foto</b> dengan perintah <code>/aigptimage instruksi editnya</code>\n<i>Edit gambar pakai GPT Vision sesuai prompt.</i>\n<code>/aigptimage Change skin color to black</code></blockquote>",
      { parse_mode: "HTML" }
    );
  }

  const waitMsg = await safeReply(ctx, "<blockquote>⏳ <b>Edit gambar pakai GPT Vision...</b></blockquote>", { parse_mode: "HTML" });
  try {
    const fileId = photo.file_id;
    const file = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
    const res = await axios.get(fileUrl, { responseType: "arraybuffer" });
    const buffer = Buffer.from(res.data);

    const form = new FormData();
    form.append("image", buffer, { filename: "image.jpg" });
    form.append("param", param);

    const result = await axios.post("https://api.nexray.eu.cc/ai/gptimage", form, {
      headers: {
        ...form.getHeaders(),
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      timeout: 60000,
    });

    if (typeof result.data === "string") throw new Error("Provider tidak mengembalikan JSON (kemungkinan endpoint sedang down/limit). Coba lagi beberapa saat.");
    if (ExtAPI.isFailedResponse(result.data)) throw new Error(ExtAPI.extractFailMessage(result.data));

    const outUrl = ExtAPI.extractMediaUrl(result.data);
    if (outUrl) {
      const caption = "<blockquote>✅ <b>Gambar berhasil diedit!</b></blockquote>";
      try {
        await ctx.replyWithPhoto(outUrl, { caption, parse_mode: "HTML" });
      } catch (sendErr) {
        const outBuffer = await ExtAPI.downloadMediaBuffer(outUrl);
        await ctx.replyWithPhoto({ source: outBuffer, filename: "edited.jpg" }, { caption, parse_mode: "HTML" });
      }
      try { await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
    } else {
      const text = ExtAPI.formatResultText({ desc: "GPT Image" }, result.data);
      try { await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" }); }
      catch (e) { await safeReply(ctx, text, { parse_mode: "HTML" }); }
    }
  } catch (e) {
    const detail = e.response?.data && typeof e.response.data === "object" ? ExtAPI.extractFailMessage(e.response.data) : e.message;
    const text = `<blockquote>❌ <b>Gagal edit gambar:</b>\n<code>${ExtAPI.escapeHtml(detail)}</code></blockquote>`;
    try { await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" }); }
    catch (e2) { await safeReply(ctx, text, { parse_mode: "HTML" }); }
  }
});

// ================= NEXRAY TOOLS (batch ke-3: RemoveBG/Unblur/VCC/Virtual Number/Anime) =================
// Command URL-based (param "url"), hasil gambar dikirim langsung
const NEXRAY_TOOLS_URL_COMMANDS = [
  { cmd: "toolblurface", epKey: "blurface", label: "Blur Wajah dalam Gambar", media: "image", example: "https://files.catbox.moe/xxxx.jpg" },
  { cmd: "toolremini", epKey: "remini-nx", label: "Perjelas Gambar (Remini)", media: "image", example: "https://files.catbox.moe/xxxx.jpg" },
  { cmd: "toolremovebg", epKey: "removebg-nx", label: "Hapus Background Gambar", media: "image", example: "https://files.catbox.moe/xxxx.jpg" },
  { cmd: "toolremovebgv1", epKey: "removebg-v1-nx", label: "Hapus Background Gambar v1", media: "image", example: "https://files.catbox.moe/xxxx.jpg" },
  { cmd: "toolremovebgv2", epKey: "removebg-v2-nx", label: "Hapus Background Gambar v2", media: "image", example: "https://files.catbox.moe/xxxx.jpg" },
  { cmd: "toolunblur", epKey: "unblur", label: "Hilangkan Blur pada Gambar", media: "image", example: "https://files.catbox.moe/xxxx.jpg" },
];

for (const c of NEXRAY_TOOLS_URL_COMMANDS) {
  bot.command(c.cmd, async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const url = parts[1];
    if (!url) {
      return safeReply(
        ctx,
        `<blockquote>❌ <b>Gunakan:</b> <code>/${c.cmd} url${c.extraParam ? " [" + c.extraParam.name + "]" : ""}</code>\n<i>${c.label}.</i>\n<code>/${c.cmd} ${c.example}</code></blockquote>`,
        { parse_mode: "HTML" }
      );
    }
    const callArgs = { url };
    if (c.extraParam) callArgs[c.extraParam.name] = parts[2] || c.extraParam.def;
    await nexrayToolCommand(ctx, c.epKey, callArgs, {
      loadingText: `${c.label}...`,
      media: c.media,
    });
  });
}

// Enhance Video ke HD: BALAS VIDEO (bukan url) -> upload dulu ke hosting sementara, baru dipanggil ke API
async function replyVideoUploadCommand(ctx, cmd, epKey, label, { extraParamName, extraParamDefault } = {}) {
  const replyMsg = ctx.message.reply_to_message;
  const video = replyMsg?.video || replyMsg?.document;
  if (!video) {
    return safeReply(
      ctx,
      `<blockquote>❌ <b>Balas sebuah video dengan perintah</b> <code>/${cmd}${extraParamName ? " [" + extraParamName + "]" : ""}</code>\n<i>${label}.</i></blockquote>`,
      { parse_mode: "HTML" }
    );
  }
  const extraVal = ctx.message.text.replace(new RegExp(`^/${cmd}(@\\w+)?\\s*`, "i"), "").trim();

  const waitMsg = await safeReply(ctx, "<blockquote>⏳ <b>Upload video...</b></blockquote>", { parse_mode: "HTML" });
  try {
    const fileId = video.file_id;
    const file = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
    const res = await axios.get(fileUrl, { responseType: "arraybuffer" });
    const buffer = Buffer.from(res.data);
    const publicUrl = await uploadFileToUrl(buffer, video.file_name || "video.mp4");

    try { await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `<blockquote>⏳ <b>${label}...</b></blockquote>`, { parse_mode: "HTML" }); } catch (e) {}

    const callArgs = { url: publicUrl };
    if (extraParamName) callArgs[extraParamName] = extraVal || extraParamDefault;

    const ep = ExtAPI.findEndpoint(ExtAPI.NEXRAY_ENDPOINTS, epKey);
    const data = ExtAPI.deepStripCredit(await ExtAPI.callNexray(ep, callArgs));

    const outUrl = ExtAPI.extractMediaUrl(data);
    if (outUrl) {
      const caption = `<blockquote>✅ <b>Video berhasil di-enhance!</b></blockquote>`;
      try {
        await ctx.replyWithVideo(outUrl, { caption, parse_mode: "HTML" });
      } catch (sendErr) {
        const outBuffer = await ExtAPI.downloadMediaBuffer(outUrl);
        await ctx.replyWithVideo({ source: outBuffer, filename: "hd.mp4" }, { caption, parse_mode: "HTML" });
      }
      try { await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
    } else {
      const text = ExtAPI.formatDataDump(label, data) || ExtAPI.formatResultText({ desc: label }, data);
      try { await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `<blockquote>${text}</blockquote>`, { parse_mode: "HTML" }); }
      catch (e) { await safeReply(ctx, `<blockquote>${text}</blockquote>`, { parse_mode: "HTML" }); }
    }
  } catch (e) {
    const detail = e.response?.data && typeof e.response.data === "object" ? ExtAPI.extractFailMessage(e.response.data) : e.message;
    const text = `<blockquote>❌ <b>Gagal:</b>\n<code>${ExtAPI.escapeHtml(detail)}</code></blockquote>`;
    try { await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" }); }
    catch (e2) { await safeReply(ctx, text, { parse_mode: "HTML" }); }
  }
}

bot.command("toolhdvideo", async (ctx) => {
  await replyVideoUploadCommand(ctx, "toolhdvideo", "hdvideo-nx", "Enhance Video ke HD");
});

bot.command("toolhdvideov1", async (ctx) => {
  await replyVideoUploadCommand(ctx, "toolhdvideov1", "hdvideo-v1-nx", "Upscale Video HD/FHD/2K/4K", {
    extraParamName: "resolusi",
    extraParamDefault: "hd",
  });
});

// VCC Generator: param "type" (dropdown opsional, default mastercard)
bot.command("toolvcc", async (ctx) => {
  const type = ctx.message.text.replace(/^\/toolvcc(@\w+)?\s*/i, "").trim() || "mastercard";
  await nexrayToolCommand(ctx, "vcc", { type }, {
    loadingText: "Generate VCC...",
    buildSuccessText: (data) => {
      const text = ExtAPI.formatDataDump("VCC Generator", data) || ExtAPI.formatResultText({ desc: "VCC Generator" }, data);
      return `<blockquote>${text}</blockquote>`;
    },
  });
});

// Get Virtual Number: param "number" opsional
bot.command("toolvirtualnumber", async (ctx) => {
  const number = ctx.message.text.replace(/^\/toolvirtualnumber(@\w+)?\s*/i, "").trim();
  await nexrayToolCommand(ctx, "virtual-number", number ? { number } : {}, {
    loadingText: "Mengambil daftar nomor virtual...",
    buildSuccessText: (data) => {
      const text = ExtAPI.formatDataDump("Virtual Number", data) || ExtAPI.formatResultText({ desc: "Virtual Number" }, data);
      return `<blockquote>${text}</blockquote>`;
    },
  });
});

// Get Virtual Number v1: params country_id + number_id — Format: /toolvirtualnumberv1 country_id number_id
bot.command("toolvirtualnumberv1", async (ctx) => {
  // Terima pemisah spasi ATAU koma, dan buang spasi berlebih -> lebih toleran terhadap cara input user
  const raw = ctx.message.text.replace(/^\/toolvirtualnumberv1(@\w+)?\s*/i, "").trim();
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  const [country_id, number_id] = parts;
  if (!country_id || !number_id) {
    return safeReply(
      ctx,
      "<blockquote>❌ <b>Gunakan:</b> <code>/toolvirtualnumberv1 country_id number_id</code>\n<i>Dapatkan nomor virtual/OTP.</i>\n<code>/toolvirtualnumberv1 7 651</code></blockquote>",
      { parse_mode: "HTML" }
    );
  }
  await nexrayToolCommand(ctx, "virtual-number-v1", { country_id, number_id }, {
    loadingText: "Mengambil nomor virtual...",
    buildSuccessText: (data) => {
      const text = ExtAPI.formatDataDump("Virtual Number v1", data) || ExtAPI.formatResultText({ desc: "Virtual Number v1" }, data);
      return `<blockquote>${text}</blockquote>`;
    },
  });
});

// Anichin Detail: param "url" -> info anime (episode, batch download, metadata)
bot.command("toolanichin", async (ctx) => {
  const url = ctx.message.text.split(/\s+/)[1];
  if (!url) {
    return safeReply(
      ctx,
      "<blockquote>❌ <b>Gunakan:</b> <code>/toolanichin url</code>\n<i>Detail anime dari Anichin.</i>\n<code>/toolanichin https://anichin.cafe/seri/xxxx</code></blockquote>",
      { parse_mode: "HTML" }
    );
  }
  await nexrayToolCommand(ctx, "anichin-detail", { url }, {
    loadingText: "Mengambil detail anime...",
    buildSuccessText: buildAnimeSuccessText("Anichin Detail"),
  });
});

// ================= ANIME & MANGA (18 endpoint: Anichin, Komiku, Samehadaku) =================
// Format hasil dipilih otomatis: coba tampilkan sebagai daftar rapi (judul+link) dulu,
// baru dump data lengkap, baru fallback teks bebas — TIDAK PERNAH dump JSON mentah.
function buildAnimeSuccessText(title) {
  return (data) => {
    const text = ExtAPI.formatListText(title, data) || ExtAPI.formatDataDump(title, data) || ExtAPI.formatResultText({ desc: title }, data);
    return `<blockquote>${text}</blockquote>`;
  };
}

// --- Tanpa parameter ---
const ANIME_NO_PARAM_COMMANDS = [
  { cmd: "anichinhome", epKey: "anichin-home", title: "Anichin Home" },
  { cmd: "anichingenres", epKey: "anichin-genres", title: "Anichin Genre List" },
  { cmd: "anichinschedule", epKey: "anichin-schedule", title: "Anichin Schedule" },
  { cmd: "komikuhome", epKey: "komiku-home", title: "Komiku Home" },
  { cmd: "samehadakuhome", epKey: "samehadaku-home", title: "Samehadaku Home" },
  { cmd: "samehadakuschedule", epKey: "samehadaku-schedule", title: "Samehadaku Schedule" },
];
for (const c of ANIME_NO_PARAM_COMMANDS) {
  bot.command(c.cmd, async (ctx) => {
    await nexrayToolCommand(ctx, c.epKey, {}, { loadingText: `Mengambil ${c.title}...`, buildSuccessText: buildAnimeSuccessText(c.title) });
  });
}

// --- Cuma param "page" (opsional, default 1) ---
const ANIME_PAGE_COMMANDS = [
  { cmd: "komikupopular", epKey: "komiku-popular", title: "Komiku Popular" },
  { cmd: "samehadakupage", epKey: "samehadaku-page", title: "Samehadaku Page" },
];
for (const c of ANIME_PAGE_COMMANDS) {
  bot.command(c.cmd, async (ctx) => {
    const page = ctx.message.text.trim().split(/\s+/)[1] || "1";
    await nexrayToolCommand(ctx, c.epKey, { page }, { loadingText: `Mengambil ${c.title}...`, buildSuccessText: buildAnimeSuccessText(c.title) });
  });
}

// --- Param "q" (kata kunci, wajib) ---
const ANIME_SEARCH_COMMANDS = [
  { cmd: "anichinsearch", epKey: "anichin-search", title: "Anichin Search", example: "naruto", withPage: true },
  { cmd: "komikusearch", epKey: "komiku-search", title: "Komiku Search", example: "Solo Leveling" },
  { cmd: "samehadakusearch", epKey: "samehadaku-search", title: "Samehadaku Search", example: "naruto" },
];
for (const c of ANIME_SEARCH_COMMANDS) {
  bot.command(c.cmd, async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const q = parts.slice(1).join(" ");
    if (!q) {
      return safeReply(ctx, `<blockquote>❌ <b>Gunakan:</b> <code>/${c.cmd} kata kunci</code>\n<i>${c.title}.</i>\n<code>/${c.cmd} ${c.example}</code></blockquote>`, { parse_mode: "HTML" });
    }
    const args = { q };
    await nexrayToolCommand(ctx, c.epKey, args, { loadingText: `${c.title}...`, buildSuccessText: buildAnimeSuccessText(c.title) });
  });
}

// --- Param "url" (wajib) -> detail/chapter/stream ---
const ANIME_URL_COMMANDS = [
  { cmd: "anichinstream", epKey: "anichin-stream", title: "Anichin Stream", example: "https://anichin.cafe/100-xxxx", media: true },
  { cmd: "komikuchapter", epKey: "komiku-chapter", title: "Komiku Chapter", example: "https://komiku.org/solo-leveling-chapter-1" },
  { cmd: "komikudetail", epKey: "komiku-detail", title: "Komiku Detail", example: "https://komiku.org/manga/solo-leveling" },
  { cmd: "samehadakudetail", epKey: "samehadaku-detail", title: "Samehadaku Detail", example: "https://v2.samehadaku.how/anime/xxxx" },
  { cmd: "samehadakustream", epKey: "samehadaku-stream", title: "Samehadaku Stream", example: "https://v2.samehadaku.how/xxxx", media: true },
];
for (const c of ANIME_URL_COMMANDS) {
  bot.command(c.cmd, async (ctx) => {
    const url = ctx.message.text.trim().split(/\s+/)[1];
    if (!url) {
      return safeReply(ctx, `<blockquote>❌ <b>Gunakan:</b> <code>/${c.cmd} url</code>\n<i>${c.title}.</i>\n<code>/${c.cmd} ${c.example}</code></blockquote>`, { parse_mode: "HTML" });
    }
    await nexrayToolCommand(ctx, c.epKey, { url }, {
      loadingText: `${c.title}...`,
      buildSuccessText: buildAnimeSuccessText(c.title),
    });
  });
}

// --- Anichin by Genre: slug (wajib) + page (opsional) ---
bot.command("anichingenre", async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const [, slug, page] = parts;
  if (!slug) {
    return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/anichingenre slug [page]</code>\n<i>Daftar anime Anichin per genre.</i>\n<code>/anichingenre action</code></blockquote>", { parse_mode: "HTML" });
  }
  await nexrayToolCommand(ctx, "anichin-genre", { slug, page: page || "1" }, {
    loadingText: "Mengambil daftar anime per genre...",
    buildSuccessText: buildAnimeSuccessText("Anichin by Genre"),
  });
});

// --- Samehadaku Embed: post + nume + type (wajib), url (opsional) ---
bot.command("samehadakuembed", async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const [, post, nume, type, url] = parts;
  if (!post || !nume || !type) {
    return safeReply(
      ctx,
      "<blockquote>❌ <b>Gunakan:</b> <code>/samehadakuembed post nume type [url]</code>\n<i>Ambil URL embed video player Samehadaku.</i>\n<code>/samehadakuembed 37909 1 schtml</code></blockquote>",
      { parse_mode: "HTML" }
    );
  }
  const args = { post, nume, type };
  if (url) args.url = url;
  await nexrayToolCommand(ctx, "samehadaku-embed", args, {
    loadingText: "Mengambil URL embed...",
    buildSuccessText: buildAnimeSuccessText("Samehadaku Embed"),
  });
});

// ================= API BY FAA (api-faa.my.id, 5 endpoint, gratis TANPA apikey) =================
async function faaToolCommand(ctx, epKey, callArgs, { loadingText, buildSuccessText, media } = {}) {
  const ep = ExtAPI.findEndpoint(ExtAPI.FAA_ENDPOINTS, epKey);
  if (!ep) return safeReply(ctx, "<blockquote>❌ <b>Endpoint tidak ditemukan di registry.</b></blockquote>", { parse_mode: "HTML" });

  const waitMsg = await safeReply(ctx, `<blockquote>⏳ <b>${loadingText || "Memproses..."}</b></blockquote>`, { parse_mode: "HTML" });

  try {
    const data = ExtAPI.deepStripCredit(await ExtAPI.callFaa(ep, callArgs));
    const found = ExtAPI.extractMedia(data);
    const url = found?.url;
    const mediaType = media || found?.type;

    if (url && (mediaType === "image" || mediaType === "audio" || mediaType === "video")) {
      const caption = buildSuccessText ? buildSuccessText(data) : "<blockquote>✅ <b>Berhasil!</b></blockquote>";
      const sendFn = mediaType === "image" ? "replyWithPhoto" : mediaType === "audio" ? "replyWithAudio" : "replyWithVideo";
      try {
        await ctx[sendFn](url, { caption, parse_mode: "HTML" });
      } catch (sendErr) {
        const buffer = await ExtAPI.downloadMediaBuffer(url, callArgs.url || callArgs.image);
        const ext = mediaType === "image" ? "jpg" : mediaType === "audio" ? "mp3" : "mp4";
        await ctx[sendFn]({ source: buffer, filename: `media.${ext}` }, { caption, parse_mode: "HTML" });
      }
      try { await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
    } else {
      const text = buildSuccessText ? buildSuccessText(data) : ExtAPI.formatResultText(ep, data);
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" });
      } catch (e) {
        await safeReply(ctx, text, { parse_mode: "HTML" });
      }
    }
  } catch (e) {
    const detail = e.response?.data && typeof e.response.data === "object" ? ExtAPI.extractFailMessage(e.response.data) : e.message;
    const text = `<blockquote>❌ <b>Gagal:</b>\n<code>${ExtAPI.escapeHtml(detail)}</code></blockquote>`;
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" });
    } catch (e2) {
      await safeReply(ctx, text, { parse_mode: "HTML" });
    }
  }
}

async function izukaToolCommand(ctx, epKey, callArgs, { loadingText, buildSuccessText, media } = {}) {
  const ep = ExtAPI.findEndpoint(ExtAPI.IZUKA_ENDPOINTS, epKey);
  if (!ep) return safeReply(ctx, "<blockquote>❌ <b>Endpoint tidak ditemukan di registry.</b></blockquote>", { parse_mode: "HTML" });

  const waitMsg = await safeReply(ctx, `<blockquote>⏳ <b>${loadingText || "Memproses..."}</b></blockquote>`, { parse_mode: "HTML" });

  try {
    const data = ExtAPI.deepStripCredit(await ExtAPI.callIzuka(ep, callArgs));
    const found = ExtAPI.extractMedia(data);
    const url = found?.url;
    const mediaType = media || found?.type;

    if (url && (mediaType === "image" || mediaType === "audio" || mediaType === "video")) {
      const caption = buildSuccessText ? buildSuccessText(data) : "<blockquote>✅ <b>Berhasil!</b></blockquote>";
      const sendFn = mediaType === "image" ? "replyWithPhoto" : mediaType === "audio" ? "replyWithAudio" : "replyWithVideo";
      try {
        await ctx[sendFn](url, { caption, parse_mode: "HTML" });
      } catch (sendErr) {
        const buffer = await ExtAPI.downloadMediaBuffer(url, callArgs.url || callArgs.image);
        const ext = mediaType === "image" ? "jpg" : mediaType === "audio" ? "mp3" : "mp4";
        await ctx[sendFn]({ source: buffer, filename: `media.${ext}` }, { caption, parse_mode: "HTML" });
      }
      try { await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
    } else {
      const text = buildSuccessText ? buildSuccessText(data) : ExtAPI.formatResultText(ep, data);
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" });
      } catch (e) {
        await safeReply(ctx, text, { parse_mode: "HTML" });
      }
    }
  } catch (e) {
    const detail = e.response?.data && typeof e.response.data === "object" ? ExtAPI.extractFailMessage(e.response.data) : e.message;
    const text = `<blockquote>❌ <b>Gagal:</b>\n<code>${ExtAPI.escapeHtml(detail)}</code></blockquote>`;
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" });
    } catch (e2) {
      await safeReply(ctx, text, { parse_mode: "HTML" });
    }
  }
}

wireUrlParamCmds([
  { cmd: "imglarger1", epKey: "izuka-imglarger1", title: "Perbesar & Tingkatkan Kualitas Gambar (Image Larger)" },
], izukaToolCommand, "url");

const FAA_REPLY_PHOTO_COMMANDS = [
  { cmd: "hdsuper", epKey: "faa-superhd", param: "url", label: "Ai HD v1" },
  { cmd: "hdv2", epKey: "faa-hdv2", param: "url", label: "Ai HD v2 - Remini" },
  { cmd: "hdv3", epKey: "faa-hdv3", param: "image", label: "Ai HD v3 - Perbesar 4x" },
  { cmd: "hdv4", epKey: "faa-hdv4", param: "image", label: "Ai HD v4" },
];

// Semua endpoint HD ini BALAS FOTO (bukan url) -> upload dulu ke hosting sementara, baru dipanggil ke API
const FAA_HD_MIME_TO_EXT = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
};
for (const c of FAA_REPLY_PHOTO_COMMANDS) {
  bot.command(c.cmd, async (ctx) => {
    const replyMsg = ctx.message.reply_to_message;
    const isPhoto = !!replyMsg?.photo?.length;
    const doc = replyMsg?.document;
    const photo = isPhoto ? replyMsg.photo[replyMsg.photo.length - 1] : doc;
    if (!photo) {
      return safeReply(
        ctx,
        `<blockquote>❌ <b>Balas sebuah foto dengan perintah</b> <code>/${c.cmd}</code>\n<i>${c.label}.</i></blockquote>`,
        { parse_mode: "HTML" }
      );
    }
    // Kalau yang dibalas dokumen (bukan foto terkompresi), pastikan mime type-nya
    // beneran gambar dulu -- dan tentukan ekstensi file dari mime type ASLI,
    // bukan di-hardcode ".jpg" terus (bisa salah kalau dokumennya PNG/WEBP/dst,
    // dan bikin API tujuan gagal mengenali isinya).
    if (!isPhoto) {
      const docMime = doc?.mime_type || "";
      if (!docMime.startsWith("image/")) {
        return safeReply(
          ctx,
          `<blockquote>❌ <b>Dokumen yang kamu balas bukan gambar.</b>\n<i>${c.label} cuma bisa proses foto/dokumen bertipe image.</i></blockquote>`,
          { parse_mode: "HTML" }
        );
      }
    }
    const ext = isPhoto ? "jpg" : (FAA_HD_MIME_TO_EXT[doc?.mime_type] || "jpg");
    const uploadFilename = `image.${ext}`;

    const waitMsg = await safeReply(ctx, "<blockquote>⏳ <b>Upload gambar...</b></blockquote>", { parse_mode: "HTML" });
    let publicUrl = null;
    try {
      const fileId = photo.file_id;
      const file = await ctx.telegram.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
      const res = await axios.get(fileUrl, { responseType: "arraybuffer" });
      const buffer = Buffer.from(res.data);
      publicUrl = await uploadFileToUrl(buffer, uploadFilename);

      try { await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `<blockquote>⏳ <b>${c.label}...</b></blockquote>`, { parse_mode: "HTML" }); } catch (e) {}

      const ep = ExtAPI.findEndpoint(ExtAPI.FAA_ENDPOINTS, c.epKey);
      const data = ExtAPI.deepStripCredit(await ExtAPI.callFaa(ep, { [c.param]: publicUrl }));

      const outUrl = ExtAPI.extractMediaUrl(data);
      if (outUrl) {
        const caption = `<blockquote>✅ <b>Gambar berhasil diproses!</b></blockquote>`;
        try {
          await ctx.replyWithPhoto(outUrl, { caption, parse_mode: "HTML" });
        } catch (sendErr) {
          const outBuffer = await ExtAPI.downloadMediaBuffer(outUrl);
          await ctx.replyWithPhoto({ source: outBuffer, filename: "hd.jpg" }, { caption, parse_mode: "HTML" });
        }
        try { await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
      } else {
        const text = ExtAPI.formatDataDump(c.label, data) || ExtAPI.formatResultText({ desc: c.label }, data);
        try { await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `<blockquote>${text}</blockquote>`, { parse_mode: "HTML" }); }
        catch (e) { await safeReply(ctx, `<blockquote>${text}</blockquote>`, { parse_mode: "HTML" }); }
      }
    } catch (e) {
      const detail = e.response?.data && typeof e.response.data === "object" ? ExtAPI.extractFailMessage(e.response.data) : e.message;
      // Sertakan URL gambar yang tadi diupload (kalau sempat berhasil dibuat)
      // supaya gampang di-debug manual: buka linknya langsung di browser, atau
      // tempel ke playground resmi provider buat mastiin providernya beneran
      // gagal proses gambarnya (bukan gara-gara link upload kita).
      const debugLine = publicUrl ? `\n\n🔗 <b>URL gambar yang diupload:</b>\n<code>${ExtAPI.escapeHtml(publicUrl)}</code>\n<i>Coba buka link ini di browser — kalau gambarnya nggak muncul, berarti masalah di provider upload. Kalau muncul normal tapi tetap gagal, berarti API HD-nya lagi bermasalah.</i>` : "";
      const text = `<blockquote>❌ <b>Gagal:</b>\n<code>${ExtAPI.escapeHtml(detail)}</code>${debugLine}</blockquote>`;
      try { await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" }); }
      catch (e2) { await safeReply(ctx, text, { parse_mode: "HTML" }); }
    }
  });
}

bot.command("trackip", async (ctx) => {
  const ip = ctx.message.text.trim().split(/\s+/)[1];
  if (!ip) {
    return safeReply(
      ctx,
      "<blockquote>❌ <b>Gunakan:</b> <code>/trackip alamat_ip</code>\n<i>Lacak informasi detail dari sebuah alamat IP.</i>\n<code>/trackip 8.8.8.8</code></blockquote>",
      { parse_mode: "HTML" }
    );
  }
  await faaToolCommand(ctx, "faa-trackip", { ip }, {
    loadingText: "Melacak alamat IP...",
    buildSuccessText: (data) => {
      const text = ExtAPI.formatDataDump("Track IP", data) || ExtAPI.formatResultText({ desc: "Track IP" }, data);
      return `<blockquote>${text}</blockquote>`;
    },
  });
});

// ================= ALWAYSCODEX API (api.alwayscodex.my.id, 20 endpoint, gratis TANPA apikey) =================
async function alwaysCodexToolCommand(ctx, epKey, callArgs, { loadingText, buildSuccessText, media } = {}) {
  const ep = ExtAPI.findEndpoint(ExtAPI.ALWAYSCODEX_ENDPOINTS, epKey);
  if (!ep) return safeReply(ctx, "<blockquote>❌ <b>Endpoint tidak ditemukan di registry.</b></blockquote>", { parse_mode: "HTML" });

  const waitMsg = await safeReply(ctx, `<blockquote>⏳ <b>${loadingText || "Memproses..."}</b></blockquote>`, { parse_mode: "HTML" });

  try {
    const data = ExtAPI.deepStripCredit(await ExtAPI.callAlwaysCodex(ep, callArgs));
    const found = ExtAPI.extractMedia(data);
    const url = found?.url;
    const mediaType = media || found?.type;

    if (url && (mediaType === "image" || mediaType === "audio" || mediaType === "video")) {
      const caption = buildSuccessText ? buildSuccessText(data) : "<blockquote>✅ <b>Berhasil!</b></blockquote>";
      const sendFn = mediaType === "image" ? "replyWithPhoto" : mediaType === "audio" ? "replyWithAudio" : "replyWithVideo";
      try {
        await ctx[sendFn](url, { caption, parse_mode: "HTML" });
      } catch (sendErr) {
        const buffer = await ExtAPI.downloadMediaBuffer(url);
        const ext = mediaType === "image" ? "jpg" : mediaType === "audio" ? "mp3" : "mp4";
        await ctx[sendFn]({ source: buffer, filename: `media.${ext}` }, { caption, parse_mode: "HTML" });
      }
      try { await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
    } else {
      const text = buildSuccessText
        ? buildSuccessText(data)
        : `<blockquote>${ExtAPI.formatListText(ep.desc, data) || ExtAPI.formatDataDump(ep.desc, data) || ExtAPI.formatResultText(ep, data)}</blockquote>`;
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" });
      } catch (e) {
        await safeReply(ctx, text, { parse_mode: "HTML" });
      }
    }
  } catch (e) {
    const detail = e.response?.data && typeof e.response.data === "object" ? ExtAPI.extractFailMessage(e.response.data) : e.message;
    const text = `<blockquote>❌ <b>Gagal:</b>\n<code>${ExtAPI.escapeHtml(detail)}</code></blockquote>`;
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" });
    } catch (e2) {
      await safeReply(ctx, text, { parse_mode: "HTML" });
    }
  }
}

// --- Tools: Encrypt/Decrypt Teks ---
// Format: /encrypttext teks | mode(encrypt/decrypt) | method(base64/dll)
bot.command("encrypttext", async (ctx) => {
  const raw = ctx.message.text.replace(/^\/encrypttext(@\w+)?\s*/i, "").trim();
  if (!raw) {
    return safeReply(
      ctx,
      "<blockquote>❌ <b>Gunakan:</b> <code>/encrypttext teks | mode | method</code>\n<i>Convert teks pakai berbagai metode enkripsi (tanpa key). Mode & method opsional, default encrypt/base64.</i>\n<code>/encrypttext halo dunia</code></blockquote>",
      { parse_mode: "HTML" }
    );
  }
  const [text, mode, method] = raw.split("|").map((s) => s.trim());
  await alwaysCodexToolCommand(ctx, "ac-encrypt", { text, mode: mode || "encrypt", method: method || "base64" }, {
    loadingText: "Memproses enkripsi...",
    buildSuccessText: (data) => {
      const t = ExtAPI.formatDataDump("Hasil Enkripsi", data) || ExtAPI.formatResultText({ desc: "Encrypt/Decrypt" }, data);
      return `<blockquote>${t}</blockquote>`;
    },
  });
});

// --- Tools: TempMail (email sementara) ---
bot.command("tempmailcreate", async (ctx) => {
  const domain = ctx.message.text.replace(/^\/tempmailcreate(@\w+)?\s*/i, "").trim();
  await alwaysCodexToolCommand(ctx, "ac-tempmail", domain ? { action: "create", domain } : { action: "create" }, {
    loadingText: "Membuat email sementara...",
    buildSuccessText: (data) => {
      const t = ExtAPI.formatDataDump("Email Sementara Dibuat", data) || ExtAPI.formatResultText({ desc: "TempMail Create" }, data);
      return `<blockquote>${t}</blockquote>`;
    },
  });
});

bot.command("tempmailinbox", async (ctx) => {
  const email = ctx.message.text.trim().split(/\s+/)[1];
  if (!email) {
    return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/tempmailinbox email</code>\n<i>Cek inbox email sementara.</i></blockquote>", { parse_mode: "HTML" });
  }
  await alwaysCodexToolCommand(ctx, "ac-tempmail", { action: "inbox", email }, {
    loadingText: "Mengecek inbox...",
    buildSuccessText: (data) => {
      const t = ExtAPI.formatListText("Inbox Email Sementara", data) || ExtAPI.formatDataDump("Inbox Email Sementara", data) || ExtAPI.formatResultText({ desc: "TempMail Inbox" }, data);
      return `<blockquote>${t}</blockquote>`;
    },
  });
});

bot.command("tempmaildelete", async (ctx) => {
  const email = ctx.message.text.trim().split(/\s+/)[1];
  if (!email) {
    return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/tempmaildelete email</code>\n<i>Hapus email sementara.</i></blockquote>", { parse_mode: "HTML" });
  }
  await alwaysCodexToolCommand(ctx, "ac-tempmail", { action: "delete", email }, {
    loadingText: "Menghapus email...",
    buildSuccessText: (data) => {
      const t = ExtAPI.formatDataDump("Email Dihapus", data) || ExtAPI.formatResultText({ desc: "TempMail Delete" }, data);
      return `<blockquote>${t}</blockquote>`;
    },
  });
});

// --- Tools: Check Number ---
bot.command("cekxlaxis", async (ctx) => {
  const nomor = ctx.message.text.trim().split(/\s+/)[1];
  if (!nomor) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/cekxlaxis nomor</code>\n<i>Cek info nomor XL/AXIS (auto detect provider).</i>\n<code>/cekxlaxis 6285934417318</code></blockquote>", { parse_mode: "HTML" });
  await alwaysCodexToolCommand(ctx, "ac-checknumber-simdopul", { nomor }, {
    loadingText: "Mengecek nomor...",
    buildSuccessText: (data) => {
      const t = ExtAPI.formatDataDump("Info Nomor XL/AXIS", data) || ExtAPI.formatResultText({ desc: "Cek Nomor" }, data);
      return `<blockquote>${t}</blockquote>`;
    },
  });
});

bot.command("cektri", async (ctx) => {
  const number = ctx.message.text.trim().split(/\s+/)[1];
  if (!number) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/cektri nomor</code>\n<i>Cek info nomor kartu Tri.</i></blockquote>", { parse_mode: "HTML" });
  await alwaysCodexToolCommand(ctx, "ac-checknumber-tricheck", { number }, {
    loadingText: "Mengecek nomor Tri...",
    buildSuccessText: (data) => {
      const t = ExtAPI.formatDataDump("Info Nomor Tri", data) || ExtAPI.formatResultText({ desc: "Cek Nomor Tri" }, data);
      return `<blockquote>${t}</blockquote>`;
    },
  });
});

bot.command("cekxl", async (ctx) => {
  const number = ctx.message.text.trim().split(/\s+/)[1];
  if (!number) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/cekxl nomor</code>\n<i>Cek info nomor XL/Axis — paket, kuota, masa aktif.</i>\n<code>/cekxl 081915895220</code></blockquote>", { parse_mode: "HTML" });
  await alwaysCodexToolCommand(ctx, "ac-checknumber-xlcheck", { number }, {
    loadingText: "Mengecek paket & kuota...",
    buildSuccessText: (data) => {
      const t = ExtAPI.formatDataDump("Info Paket XL/Axis", data) || ExtAPI.formatResultText({ desc: "Cek Paket XL" }, data);
      return `<blockquote>${t}</blockquote>`;
    },
  });
});

// --- Games (tanpa parameter) ---
const ALWAYSCODEX_GAME_NO_PARAM = [
  { cmd: "gameasahotak", epKey: "ac-asahotak", title: "Asah Otak" },
  { cmd: "gamecaklontong", epKey: "ac-caklontong", title: "Cak Lontong" },
  { cmd: "gamefamily100", epKey: "ac-family100", title: "Family 100" },
  { cmd: "gamelengkapikalimat", epKey: "ac-lengkapikalimat", title: "Lengkapi Kalimat" },
  { cmd: "gametebakan", epKey: "ac-tebakan", title: "Tebakan / Teka-teki" },
  { cmd: "gametebakbendera", epKey: "ac-tebakbendera", title: "Tebak Bendera" },
  { cmd: "gametebakbendera2", epKey: "ac-tebakbendera2", title: "Tebak Bendera v2" },
  { cmd: "gametebakgambar", epKey: "ac-tebakgambar", title: "Tebak Gambar", media: "image" },
  { cmd: "gametebakgame", epKey: "ac-tebakgame", title: "Tebak Game" },
  { cmd: "gametebakheroml", epKey: "ac-tebakheroml", title: "Tebak Hero Mobile Legends", media: "audio" },
  { cmd: "gametebakjkt48", epKey: "ac-tebakjkt48", title: "Tebak Member JKT48", media: "image" },
  { cmd: "gametebakkabupaten", epKey: "ac-tebakkabupaten", title: "Tebak Kabupaten/Kota" },
  { cmd: "gametebakkalimat", epKey: "ac-tebakkalimat", title: "Tebak Kalimat" },
];
for (const c of ALWAYSCODEX_GAME_NO_PARAM) {
  bot.command(c.cmd, async (ctx) => {
    await alwaysCodexToolCommand(ctx, c.epKey, {}, {
      loadingText: `Mengambil soal ${c.title}...`,
      media: c.media,
      buildSuccessText: (data) => {
        const t = ExtAPI.formatDataDump(c.title, data) || ExtAPI.formatListText(c.title, data) || ExtAPI.formatResultText({ desc: c.title }, data);
        return `<blockquote>${t}</blockquote>`;
      },
    });
  });
}

// --- Games dengan parameter ---
bot.command("gamecc", async (ctx) => {
  const raw = ctx.message.text.replace(/^\/gamecc(@\w+)?\s*/i, "").trim();
  if (!raw) {
    return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/gamecc matapelajaran [jumlahsoal]</code>\n<i>Kuis mata pelajaran SD.</i>\n<code>/gamecc bindo 5</code></blockquote>", { parse_mode: "HTML" });
  }
  const [matapelajaran, jumlahsoal] = raw.split(/\s+/);
  await alwaysCodexToolCommand(ctx, "ac-ccsd", { matapelajaran, jumlahsoal: jumlahsoal || "5" }, {
    loadingText: "Mengambil soal kuis SD...",
    buildSuccessText: (data) => {
      const t = ExtAPI.formatListText("Kuis SD", data) || ExtAPI.formatDataDump("Kuis SD", data) || ExtAPI.formatResultText({ desc: "Kuis SD" }, data);
      return `<blockquote>${t}</blockquote>`;
    },
  });
});

bot.command("gamemath", async (ctx) => {
  const level = ctx.message.text.replace(/^\/gamemath(@\w+)?\s*/i, "").trim();
  await alwaysCodexToolCommand(ctx, "ac-math", level ? { level } : {}, {
    loadingText: "Membuat soal matematika...",
    buildSuccessText: (data) => {
      const t = ExtAPI.formatDataDump("Soal Matematika", data) || ExtAPI.formatResultText({ desc: "Soal Matematika" }, data);
      return `<blockquote>${t}</blockquote>`;
    },
  });
});

// ================= ISLAMI & TOOLS TAMBAHAN (api-faa.my.id) =================
async function faaBoxCommand(ctx, epKey, callArgs, { loadingText, title, media } = {}) {
  const ep = ExtAPI.findEndpoint(ExtAPI.FAA_ENDPOINTS, epKey);
  if (!ep) return safeReply(ctx, "<blockquote>❌ <b>Endpoint tidak ditemukan di registry.</b></blockquote>", { parse_mode: "HTML" });

  const waitMsg = await safeReply(ctx, `<blockquote>⏳ <b>${loadingText || "Memproses..."}</b></blockquote>`, { parse_mode: "HTML" });
  try {
    const data = ExtAPI.deepStripCredit(await ExtAPI.callFaa(ep, callArgs));
    const found = ExtAPI.extractMedia(data);
    const url = found?.url;
    const mediaType = media || found?.type;

    if (url && (mediaType === "image" || mediaType === "audio" || mediaType === "video")) {
      const caption = `<blockquote>${ExtAPI.formatDataDump(title, data) || `✅ <b>${ExtAPI.escapeHtml(title)}</b>`}</blockquote>`;
      const sendFn = mediaType === "image" ? "replyWithPhoto" : mediaType === "audio" ? "replyWithAudio" : "replyWithVideo";
      try {
        await ctx[sendFn](url, { caption, parse_mode: "HTML" });
      } catch (sendErr) {
        const buffer = await ExtAPI.downloadMediaBuffer(url);
        const ext = mediaType === "image" ? "jpg" : mediaType === "audio" ? "mp3" : "mp4";
        await ctx[sendFn]({ source: buffer, filename: `media.${ext}` }, { caption, parse_mode: "HTML" });
      }
      try { await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
    } else {
      const body = ExtAPI.formatDataDump(title, data) || ExtAPI.formatListText(title, data) || ExtAPI.formatResultText({ desc: title }, data);
      const text = ExtAPI.formatBox(title, body.replace(/^✅ <b>.*?<\/b>\n\n/, ""));
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" });
      } catch (e) {
        await safeReply(ctx, text, { parse_mode: "HTML" });
      }
    }
  } catch (e) {
    const detail = e.response?.data && typeof e.response.data === "object" ? ExtAPI.extractFailMessage(e.response.data) : e.message;
    const text = `<blockquote>❌ <b>Gagal:</b>\n<code>${ExtAPI.escapeHtml(detail)}</code></blockquote>`;
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" });
    } catch (e2) {
      await safeReply(ctx, text, { parse_mode: "HTML" });
    }
  }
}

bot.command("doaharian", async (ctx) => {
  const q = ctx.message.text.replace(/^\/doaharian(@\w+)?\s*/i, "").trim();
  if (!q) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/doaharian kata kunci</code>\n<i>Cari doa harian Islam lengkap ayat, latin, dan artinya.</i>\n<code>/doaharian sebelum makan</code></blockquote>", { parse_mode: "HTML" });
  await faaBoxCommand(ctx, "faa-doa", { q }, { loadingText: "Mencari doa...", title: "Doa Harian Islam" });
});

bot.command("jadwalsholat", async (ctx) => {
  const kota = ctx.message.text.replace(/^\/jadwalsholat(@\w+)?\s*/i, "").trim();
  if (!kota) return safeReply(ctx, "<blockquote>❌ <b>Gunakan:</b> <code>/jadwalsholat nama kota</code>\n<i>Jadwal sholat harian berdasarkan kota.</i>\n<code>/jadwalsholat Jakarta</code></blockquote>", { parse_mode: "HTML" });
  await faaBoxCommand(ctx, "faa-jadwalsholat", { kota }, { loadingText: "Mengambil jadwal sholat...", title: `Jadwal Sholat - ${kota}` });
});

bot.command("freeproxy", async (ctx) => {
  await faaBoxCommand(ctx, "faa-free-proxy", {}, { loadingText: "Mengambil proxy gratis...", title: "Free Proxy" });
});

// ================= ANIME BATCH BARU (app.siputzx.my.id) =================
async function siputzxToolCommand(ctx, epKey, callArgs, { loadingText, title, media } = {}) {
  const ep = ExtAPI.findEndpoint(ExtAPI.SIPUTZX_ENDPOINTS, epKey);
  if (!ep) return safeReply(ctx, "<blockquote>❌ <b>Endpoint tidak ditemukan di registry.</b></blockquote>", { parse_mode: "HTML" });

  const waitMsg = await safeReply(ctx, `<blockquote>⏳ <b>${loadingText || "Memproses..."}</b></blockquote>`, { parse_mode: "HTML" });
  try {
    const data = ExtAPI.deepStripCredit(await ExtAPI.callSiputzx(ep, callArgs));
    const found = ExtAPI.extractMedia(data);
    const url = found?.url;
    const mediaType = media || found?.type;

    if (url && (mediaType === "image" || mediaType === "audio" || mediaType === "video")) {
      const caption = `<blockquote>${ExtAPI.formatDataDump(title, data) || `✅ <b>${ExtAPI.escapeHtml(title)}</b>`}</blockquote>`;
      const sendFn = mediaType === "image" ? "replyWithPhoto" : mediaType === "audio" ? "replyWithAudio" : "replyWithVideo";
      try {
        await ctx[sendFn](url, { caption, parse_mode: "HTML" });
      } catch (sendErr) {
        const buffer = await ExtAPI.downloadMediaBuffer(url);
        const ext = mediaType === "image" ? "jpg" : mediaType === "audio" ? "mp3" : "mp4";
        await ctx[sendFn]({ source: buffer, filename: `media.${ext}` }, { caption, parse_mode: "HTML" });
      }
      try { await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
    } else {
      // Untuk anime: coba list dulu (episode/hasil pencarian), baru data dump, baru teks bebas
      const body = ExtAPI.formatListText(title, data) || ExtAPI.formatDataDump(title, data) || ExtAPI.formatResultText({ desc: title }, data);
      const text = ExtAPI.formatBox(title, body.replace(/^✅ <b>.*?<\/b>\n\n/, ""));
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" });
      } catch (e) {
        await safeReply(ctx, text, { parse_mode: "HTML" });
      }
    }
  } catch (e) {
    const detail = e.response?.data && typeof e.response.data === "object" ? ExtAPI.extractFailMessage(e.response.data) : e.message;
    const text = `<blockquote>❌ <b>Gagal:</b>\n<code>${ExtAPI.escapeHtml(detail)}</code></blockquote>`;
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" });
    } catch (e2) {
      await safeReply(ctx, text, { parse_mode: "HTML" });
    }
  }
}

// --- Tanpa parameter ---
const SP_ANIME_NO_PARAM = [
  { cmd: "aurataillatest", epKey: "sp-auratail-latest", title: "Auratail - Update Terbaru" },
  { cmd: "auratailschedule", epKey: "sp-auratail-schedule", title: "Auratail - Jadwal Mingguan" },
  { cmd: "anichinlatest", epKey: "sp-anichin-latest", title: "Anichin - Update Terbaru" },
  { cmd: "anichinpopular", epKey: "sp-anichin-popular", title: "Anichin - Populer" },
  { cmd: "oploverzongoing", epKey: "sp-oploverz-ongoing", title: "Oploverz - Ongoing" },
  { cmd: "samehadakulatest2", epKey: "sp-samehadaku-latest", title: "Samehadaku - Episode Terbaru" },
  { cmd: "samehadakurelease", epKey: "sp-samehadaku-release", title: "Samehadaku - Jadwal Rilis Mingguan" },
];
for (const c of SP_ANIME_NO_PARAM) {
  bot.command(c.cmd, async (ctx) => {
    await siputzxToolCommand(ctx, c.epKey, {}, { loadingText: `Mengambil ${c.title}...`, title: c.title });
  });
}

// --- Param pencarian (query/s) ---
const SP_ANIME_SEARCH = [
  { cmd: "animequote", epKey: "sp-animequotes", param: "query", title: "Quotes Anime", example: "fate" },
  { cmd: "auratailsearch", epKey: "sp-auratail-search", param: "query", title: "Auratail Search", example: "war" },
  { cmd: "otakudesusearch", epKey: "sp-otakudesu-search", param: "s", title: "Otakudesu Search", example: "naruto" },
  { cmd: "anichinsearch2", epKey: "sp-anichin-search", param: "query", title: "Anichin Search (v2)", example: "naga" },
  { cmd: "oploverzsearch", epKey: "sp-oploverz-search", param: "query", title: "Oploverz Search", example: "romance" },
  { cmd: "samehadakusearch2", epKey: "sp-samehadaku-search", param: "query", title: "Samehadaku Search (v2, hasil detail)", example: "naruto" },
];
for (const c of SP_ANIME_SEARCH) {
  bot.command(c.cmd, async (ctx) => {
    const q = ctx.message.text.replace(new RegExp(`^/${c.cmd}(@\\w+)?\\s*`, "i"), "").trim();
    if (!q) return safeReply(ctx, `<blockquote>❌ <b>Gunakan:</b> <code>/${c.cmd} kata kunci</code>\n<i>${c.title}.</i>\n<code>/${c.cmd} ${c.example}</code></blockquote>`, { parse_mode: "HTML" });
    await siputzxToolCommand(ctx, c.epKey, { [c.param]: q }, { loadingText: `${c.title}...`, title: c.title });
  });
}

// --- Param url/link (wajib) — nama param bisa beda-beda per endpoint, jangan hardcode "url" ---
const SP_ANIME_URL = [
  { cmd: "aurataildetail", epKey: "sp-auratail-detail", param: "url", title: "Auratail Detail", example: "https://auratail.vip/the-war-of-cards/" },
  { cmd: "otakudesudownload", epKey: "sp-otakudesu-download", param: "url", title: "Otakudesu Download", example: "https://otakudesu.cloud/lengkap/btr-nng-sub-indo/" },
  { cmd: "otakudesudetail", epKey: "sp-otakudesu-detail", param: "url", title: "Otakudesu Detail", example: "https://otakudesu.cloud/anime/borto-sub-i/" },
  { cmd: "anichinepisode", epKey: "sp-anichin-episode", param: "url", title: "Anichin Episode List", example: "https://anichin.cafe/renegade-immortal/" },
  { cmd: "anichindownload", epKey: "sp-anichin-download", param: "url", title: "Anichin Download", example: "https://anichin.cafe/renegade-immortal-episode-1/" },
  { cmd: "anichindetail2", epKey: "sp-anichin-detail", param: "url", title: "Anichin Detail (v2)", example: "https://anichin.cafe/renegade-immortal-episode-1/" },
  { cmd: "oploverzepisode", epKey: "sp-oploverz-episode", param: "url", title: "Oploverz Episode List", example: "https://oploverz.org/mushoku-tensei-isekai/" },
  { cmd: "komikindodetail", epKey: "sp-komikindo-detail", param: "url", title: "Komikindo Detail", example: "https://komikindo.cz/komik/550578-solo-leveling/" },
  { cmd: "komikindodownload", epKey: "sp-komikindo-download", param: "url", title: "Komikindo Download (gambar chapter)", example: "https://komikindo.cz/solo-leveling-chapter-1/" },
  { cmd: "samehadakudownload2", epKey: "sp-samehadaku-download", param: "url", title: "Samehadaku Download (v2)", example: "https://v1.samehadaku.how/rekishi-ni-nokoru/" },
  { cmd: "samehadakudetail2", epKey: "sp-samehadaku-detail", param: "link", title: "Samehadaku Detail (v2)", example: "https://v1.samehadaku.how/anime/blue-lock/" },
];
for (const c of SP_ANIME_URL) {
  bot.command(c.cmd, async (ctx) => {
    const url = ctx.message.text.trim().split(/\s+/)[1];
    if (!url) return safeReply(ctx, `<blockquote>❌ <b>Gunakan:</b> <code>/${c.cmd} url</code>\n<i>${c.title}.</i>\n<code>/${c.cmd} ${c.example}</code></blockquote>`, { parse_mode: "HTML" });
    await siputzxToolCommand(ctx, c.epKey, { [c.param]: url }, { loadingText: `${c.title}...`, title: c.title });
  });
}

// Image Enhancer butuh upload FILE (bukan url) -> multipart/form-data manual
bot.command("enhanceimg", async (ctx) => {
  const replyMsg = ctx.message.reply_to_message;
  const photo = replyMsg?.photo?.[replyMsg.photo.length - 1] || replyMsg?.document;
  if (!photo) {
    return safeReply(ctx, "<blockquote>❌ <b>Balas sebuah foto dengan perintah /enhanceimg</b>\n<i>Enhance/upscale gambar pakai AI.</i></blockquote>", { parse_mode: "HTML" });
  }

  const apikey = config.externalApi?.fidzzcodex?.apikey;
  if (!apikey || apikey === "-") {
    return safeReply(ctx, `<blockquote>⚠️ <b>API key belum diisi</b> di config.js.</blockquote>`, { parse_mode: "HTML" });
  }

  const waitMsg = await safeReply(ctx, "<blockquote>⏳ <b>Upload gambar...</b></blockquote>", { parse_mode: "HTML" });
  try {
    const fileId = photo.file_id;
    const file = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
    const res = await axios.get(fileUrl, { responseType: "arraybuffer" });
    const buffer = Buffer.from(res.data);

    // Endpoint /tools/enhance-image butuh param "file" berisi LINK gambar,
    // BUKAN upload binary langsung -> upload dulu ke hosting sementara.
    const publicUrl = await uploadFileToUrl(buffer, "image.jpg");

    try { await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, "<blockquote>⏳ <b>Enhance gambar...</b></blockquote>", { parse_mode: "HTML" }); } catch (e) {}

    const ep = ExtAPI.findEndpoint(ExtAPI.FIDZZ_ENDPOINTS, "enhance-image");
    const data = ExtAPI.deepStripCredit(await ExtAPI.callFidzz(ep, { file: publicUrl }));

    const outUrl = ExtAPI.extractMediaUrl(data);
    if (outUrl) {
      const caption = "<blockquote>✅ <b>Gambar berhasil di-enhance!</b></blockquote>";
      try {
        await ctx.replyWithPhoto(outUrl, { caption, parse_mode: "HTML" });
      } catch (sendErr) {
        const outBuffer = await ExtAPI.downloadMediaBuffer(outUrl);
        await ctx.replyWithPhoto({ source: outBuffer, filename: "enhanced.jpg" }, { caption, parse_mode: "HTML" });
      }
      try { await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
    } else {
      const text = ExtAPI.formatResultText({ desc: "Enhance Gambar" }, data);
      try { await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" }); }
      catch (e) { await safeReply(ctx, text, { parse_mode: "HTML" }); }
    }
  } catch (e) {
    const detail = e.response?.data && typeof e.response.data === "object" ? ExtAPI.extractFailMessage(e.response.data) : e.message;
    const text = `<blockquote>❌ <b>Gagal enhance gambar:</b>\n<code>${ExtAPI.escapeHtml(detail)}</code></blockquote>`;
    try { await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, text, { parse_mode: "HTML" }); }
    catch (e2) { await safeReply(ctx, text, { parse_mode: "HTML" }); }
  }
});

// ================= BATCH ENDPOINT BARU (Games/Canvas/Ephoto/ImageAI/Search) =================
// PENTING: endpoint yang cuma didaftarkan di lib/externalApis.js (registry) TIDAK
// otomatis bisa dipanggil user -> tetap wajib di-wire ke bot.command() di sini,
// baru benar-benar aktif jadi command Telegram. Helper generik di bawah dipakai
// supaya nggak nulis ulang boilerplate try/catch/loading untuk tiap command.

function wireNoParamCmds(list, toolFn) {
  for (const c of list) {
    bot.command(c.cmd, async (ctx) => {
      await toolFn(ctx, c.epKey, {}, { loadingText: `Mengambil ${c.title}...`, title: c.title, media: c.media });
    });
  }
}

function wireSingleParamCmds(list, toolFn) {
  for (const c of list) {
    bot.command(c.cmd, async (ctx) => {
      const val = ctx.message.text.replace(new RegExp(`^/${c.cmd}(@\\w+)?\\s*`, "i"), "").trim();
      if (!val) {
        return safeReply(
          ctx,
          `<blockquote>❌ <b>Gunakan:</b> <code>/${c.cmd} ${c.param}</code>\n<i>${c.title}.</i>${c.example ? `\n<code>/${c.cmd} ${c.example}</code>` : ""}</blockquote>`,
          { parse_mode: "HTML" }
        );
      }
      await toolFn(ctx, c.epKey, { [c.param]: val }, { loadingText: `${c.title}...`, title: c.title, media: c.media });
    });
  }
}

function wireUrlParamCmds(list, toolFn, paramName) {
  for (const c of list) {
    bot.command(c.cmd, async (ctx) => {
      const url = ctx.message.text.trim().split(/\s+/)[1];
      if (!url) {
        return safeReply(
          ctx,
          `<blockquote>❌ <b>Gunakan:</b> <code>/${c.cmd} url_gambar</code>\n<i>${c.title}.</i></blockquote>`,
          { parse_mode: "HTML" }
        );
      }
      await toolFn(ctx, c.epKey, { [paramName || c.param || "url"]: url }, { loadingText: `${c.title}...`, title: c.title, media: "image" });
    });
  }
}

function wireTwoUrlParamCmds(list, toolFn) {
  for (const c of list) {
    bot.command(c.cmd, async (ctx) => {
      const parts = ctx.message.text.trim().split(/\s+/);
      const [u1, u2] = [parts[1], parts[2]];
      if (!u1 || !u2) {
        return safeReply(
          ctx,
          `<blockquote>❌ <b>Gunakan:</b> <code>/${c.cmd} url_gambar1 url_gambar2</code>\n<i>${c.title}.</i></blockquote>`,
          { parse_mode: "HTML" }
        );
      }
      await toolFn(ctx, c.epKey, { image1: u1, image2: u2 }, { loadingText: `${c.title}...`, title: c.title, media: "image" });
    });
  }
}

function wireMultiParamCmds(list, toolFn, endpointList) {
  for (const c of list) {
    bot.command(c.cmd, async (ctx) => {
      const raw = ctx.message.text.replace(new RegExp(`^/${c.cmd}(@\\w+)?\\s*`, "i"), "").trim();
      const ep = ExtAPI.findEndpoint(endpointList, c.epKey);
      const hasRequiredParam = ep && (ep.params || []).some((p) => !p.includes("?"));
      if (!raw && hasRequiredParam) {
        const hint = ExtAPI.paramsHint(ep);
        return safeReply(
          ctx,
          `<blockquote>❌ <b>Gunakan:</b> <code>/${c.cmd} key=value key2=value2 ...</code>\n<i>${c.title}.</i>\n📋 <b>Parameter:</b> <code>${ExtAPI.escapeHtml(hint)}</code></blockquote>`,
          { parse_mode: "HTML" }
        );
      }
      const args = ExtAPI.parseKeyValueArgs(raw);
      await toolFn(ctx, c.epKey, args, { loadingText: `${c.title}...`, title: c.title, media: c.media });
    });
  }
}

// --- Siputzx: Games (tanpa parameter) ---
wireNoParamCmds([
  { cmd: "gamesusunkata", epKey: "sp-susunkata", title: "Susun Kata" },
  { cmd: "gametebakwarna", epKey: "sp-tebakwarna", title: "Tebak Warna" },
  { cmd: "gametebaklagu2", epKey: "sp-tebaklagu", title: "Tebak Lagu (v2)", media: "audio" },
  { cmd: "gameasahotak2", epKey: "sp-asahotak", title: "Asah Otak (v2)" },
  { cmd: "gametebaklirik", epKey: "sp-tebaklirik", title: "Tebak Lirik" },
  { cmd: "gamemaths2", epKey: "sp-maths", title: "Matematika (v2)" },
], siputzxToolCommand);

// --- Siputzx: Canvas efek 1 gambar (param "image") ---
wireUrlParamCmds([
  { cmd: "canvasgreyscale", epKey: "sp-greyscale", title: "Efek Greyscale" },
  { cmd: "canvasdarkness", epKey: "sp-darkness", title: "Efek Darkness" },
  { cmd: "canvasblur", epKey: "sp-blur", title: "Efek Blur" },
  { cmd: "canvasinvert", epKey: "sp-invert", title: "Efek Invert" },
  { cmd: "canvascircle", epKey: "sp-circle", title: "Crop Lingkaran" },
  { cmd: "canvasaffect", epKey: "sp-affect", title: "Meme Affect" },
  { cmd: "canvasbeautiful", epKey: "sp-beautiful", title: "Efek Beautiful" },
  { cmd: "canvasfacepalm", epKey: "sp-facepalm", title: "Meme Facepalm" },
], siputzxToolCommand, "image");

// --- Siputzx: Canvas efek 2 gambar (param "image1" & "image2") ---
wireTwoUrlParamCmds([
  { cmd: "canvasship", epKey: "sp-ship", title: "Ship Image" },
  { cmd: "canvasbatslap", epKey: "sp-batslap", title: "Batslap Meme" },
  { cmd: "canvaskiss", epKey: "sp-kiss", title: "Kiss Image" },
], siputzxToolCommand);

// --- Siputzx: Canvas multi-parameter (key=value bebas) ---
wireMultiParamCmds([
  { cmd: "canvaswelcomev1", epKey: "sp-welcomev1", title: "Welcome Card v1" },
  { cmd: "canvaswelcomev3", epKey: "sp-welcomev3", title: "Welcome Card v3" },
  { cmd: "canvaswelcomev4", epKey: "sp-welcomev4", title: "Welcome Card v4" },
  { cmd: "canvasgoodbyev1", epKey: "sp-goodbyev1", title: "Goodbye Card v1" },
  { cmd: "canvasgoodbyev3", epKey: "sp-goodbyev3", title: "Goodbye Card v3" },
  { cmd: "canvasgoodbyev4", epKey: "sp-goodbyev4", title: "Goodbye Card v4" },
  { cmd: "canvasgoodbyev5", epKey: "sp-goodbyev5", title: "Goodbye Card v5" },
  { cmd: "canvascaptcha", epKey: "sp-captcha", title: "Captcha Image" },
  { cmd: "canvasprofile", epKey: "sp-profile", title: "Profile Card" },
  { cmd: "canvassecurity", epKey: "sp-security", title: "Security Suspect Card" },
  { cmd: "canvasspotify", epKey: "sp-spotify-card", title: "Spotify Now Playing Card" },
  { cmd: "canvaslevelup", epKey: "sp-level-up", title: "Level Up Card" },
  { cmd: "canvassertifikat", epKey: "sp-sertifikat-tolol", title: "Sertifikat Tolol (Siputzx)" },
], siputzxToolCommand, ExtAPI.SIPUTZX_ENDPOINTS);

// --- AlwaysCodex: single-param ---
wireSingleParamCmds([
  { cmd: "canvasroblox", epKey: "ac-roblox", param: "username", title: "Kartu Profil Roblox", example: "Builderman" },
  { cmd: "aibingimg", epKey: "ac-bingimg", param: "query", title: "Cari Gambar Bing", media: "image" },
  { cmd: "aipollinations", epKey: "ac-pollinations", param: "prompt", title: "Generate Gambar (Pollinations)", media: "image" },
  { cmd: "searchanime", epKey: "ac-search-anime", param: "q", title: "Cari Detail Anime", example: "Go-toubun No Hanayome" },
  { cmd: "searchdouyin", epKey: "ac-search-douyin", param: "query", title: "Cari Video Douyin" },
  { cmd: "searchlazada", epKey: "ac-search-lazada", param: "query", title: "Cari Produk Lazada" },
  { cmd: "searchmanhwaindo", epKey: "ac-search-manhwaindo", param: "query", title: "Cari Detail Manhwa" },
  { cmd: "searchyoutube2", epKey: "ac-search-youtube", param: "query", title: "Cari Video YouTube" },
], alwaysCodexToolCommand);

// --- AlwaysCodex: tanpa parameter ---
wireNoParamCmds([
  { cmd: "searchjadwalbolahariini", epKey: "ac-search-jadwalbola", title: "Jadwal Bola Hari Ini" },
], alwaysCodexToolCommand);

// --- AlwaysCodex: multi-parameter (key=value bebas) ---
wireMultiParamCmds([
  { cmd: "canvasyoutube", epKey: "ac-youtube-thumbnail", title: "Thumbnail YouTube", media: "image" },
  { cmd: "canvasbratvid", epKey: "ac-bratvid-vermeil", title: "Video Teks Bertahap (Vermeil)", media: "video" },
  { cmd: "canvascarbon", epKey: "ac-carbon", title: "Screenshot Kode (Carbon)", media: "image" },
  { cmd: "canvascreatelogo", epKey: "ac-createlogo", title: "Generate Logo AI", media: "image" },
  { cmd: "canvassertifikat2", epKey: "ac-sertifikat-tolol", title: "Sertifikat Tolol (AlwaysCodex)", media: "image" },
  { cmd: "aidezgo", epKey: "ac-dezgo", title: "Generate Gambar AI (Dezgo)", media: "image" },
  { cmd: "aiquilimage", epKey: "ac-quil-image", title: "Generate Gambar AI (Quillbot)", media: "image" },
  { cmd: "searchcookpad", epKey: "ac-search-cookpad", title: "Cari Resep Cookpad" },
  { cmd: "searchdapodik", epKey: "ac-search-dapodik", title: "Cari Data Sekolah Dapodik" },
  { cmd: "searchipa", epKey: "ac-search-ipapelajaran", title: "Cari Materi Pelajaran IPA" },
  { cmd: "searchjadwalbola2", epKey: "ac-search-jadwalsepakbola", title: "Jadwal Sepakbola Live" },
  { cmd: "searchmurotal", epKey: "ac-search-murotalquran", title: "Cari Murotal Al-Quran", media: "audio" },
  { cmd: "searchtiktok2", epKey: "ac-search-tiktok", title: "Cari Video/Foto TikTok" },
], alwaysCodexToolCommand, ExtAPI.ALWAYSCODEX_ENDPOINTS);

// --- AlwaysCodex: Image HD (upscaler/enhancer) ---
wireMultiParamCmds([
  { cmd: "aisparkpix", epKey: "ac-imagehd-sparkpix", title: "Upscale Gambar HD 4K/6K/8K (SparkPix)", media: "image" },
], alwaysCodexToolCommand, ExtAPI.ALWAYSCODEX_ENDPOINTS);
wireUrlParamCmds([
  { cmd: "aisuperresolution", epKey: "ac-imagehd-superresolution", title: "Perjelas Resolusi Gambar (Super-Resolution)" },
  { cmd: "aienhance", epKey: "ac-imagehd-aienhance", title: "Enhance Gambar AI" },
  { cmd: "aienhancev6", epKey: "ac-imagehd-aienhancev6", title: "Super-Resolution Cepat (v6)" },
  { cmd: "aiupscale", epKey: "ac-imagehd-upscale", title: "Upscale Gambar" },
  { cmd: "aiwinkhd", epKey: "ac-imagehd-winkhd", title: "Upscale Ultra HD (Wink AI)" },
], alwaysCodexToolCommand, "url");
wireMultiParamCmds([
  { cmd: "aienhancev2", epKey: "ac-imagehd-aienhancev2", title: "Enhance Gambar AI v2 (scale 2x/4x/6x/8x)", media: "image" },
  { cmd: "aienhancev4", epKey: "ac-imagehd-aienhancev4", title: "Upscale Gambar v4 (2x/4x)", media: "image" },
  { cmd: "aienhancev8", epKey: "ac-imagehd-aienhancev8", title: "Upscale Gambar v8 + Face Enhancement", media: "image" },
  { cmd: "aiimageupscaler", epKey: "ac-imagehd-imageupscaler", title: "Upscale Gambar 2x/4x/6x", media: "image" },
], alwaysCodexToolCommand, ExtAPI.ALWAYSCODEX_ENDPOINTS);

// --- Nexray: filter foto Ephoto (semua param "url") ---
wireUrlParamCmds([
  { cmd: "efanime", epKey: "ephoto-anime", title: "Filter Anime" },
  { cmd: "efart", epKey: "ephoto-art", title: "Filter Art" },
  { cmd: "efascii", epKey: "ephoto-ascii", title: "ASCII Art" },
  { cmd: "efborealis", epKey: "ephoto-borealis", title: "Filter Borealis" },
  { cmd: "efbotak", epKey: "ephoto-botak", title: "Filter Botak (meme)" },
  { cmd: "efbravegreen", epKey: "ephoto-bravegreen", title: "Filter Brave Green" },
  { cmd: "efchibi", epKey: "ephoto-chibi", title: "Filter Chibi" },
  { cmd: "efcinematic", epKey: "ephoto-cinematic", title: "Filter Cinematic" },
  { cmd: "efcomic", epKey: "ephoto-comic", title: "Filter Comic" },
  { cmd: "effigurev1", epKey: "ephoto-figure-v1", title: "Filter Figure v1" },
  { cmd: "effigurev2", epKey: "ephoto-figure-v2", title: "Filter Figure v2" },
  { cmd: "efghibli", epKey: "ephoto-ghibli", title: "Filter Studio Ghibli" },
  { cmd: "efluminare", epKey: "ephoto-luminare", title: "Filter Luminare" },
  { cmd: "efmafia", epKey: "ephoto-mafia", title: "Filter Mafia" },
  { cmd: "efmirror", epKey: "ephoto-mirror", title: "Mirror Selfie" },
  { cmd: "efmonochrome", epKey: "ephoto-monochrome", title: "Filter Monochrome" },
  { cmd: "efmountain", epKey: "ephoto-mountain", title: "Filter Mountain Hiking" },
  { cmd: "efnft", epKey: "ephoto-nft", title: "Filter Pixel-Art NFT" },
  { cmd: "efplaylist", epKey: "ephoto-playlist", title: "Filter Spotify Playlist" },
  { cmd: "efqin", epKey: "ephoto-qin", title: "Filter Qin" },
  { cmd: "efreal", epKey: "ephoto-real", title: "Filter Realistic Human" },
  { cmd: "efstatue", epKey: "ephoto-statue", title: "Filter Giant Statue" },
  { cmd: "efstreet", epKey: "ephoto-street", title: "Filter Street Art" },
], nexrayToolCommand, "url");

function calcTotalPrice(basePrice, qty) {
  if (qty <= 1) return basePrice;
  return basePrice * qty;
}

function renderPurchaseText(app, qty, total) {
  const stock = (app.accounts || []).length;
  return `<blockquote><b>╭━━━━✧「 🛒 𝗗𝗘𝗧𝗔𝗜𝗟 𝗣𝗥𝗢𝗗𝗨𝗞 」✧━━━━❍</b>
<b>┃</b> 📦 Produk    : ${app.nama}
<b>┃</b> 📊 Sisa Stok : ${stock}
<b>┃</b> 📝 Deskripsi : ${app.deskripsi || "-"}
<b>┃</b>
<b>┃</b> 🔢 Jumlah       : ${qty}
<b>┃</b> 💵 Harga Satuan : ${toRupiah(app.harga)}
<b>┃</b> 💰 Total Harga  : ${toRupiah(total)}
<b>╰━━━━━━━━━━━━━━━━━━━━━━━━❍</b></blockquote>
<i>Diperbarui: ${new Date().toLocaleTimeString("id-ID")}</i>`;
}

/** Cek kasar/toxic sederhana berbasis daftar kata (owner bisa tambah di config.js -> toxicWordFilter). */
function containsToxicContent(text) {
  const list = config.toxicWordFilter || [];
  if (list.length === 0) return false;
  const msg = text.toLowerCase();
  return list.some((word) => msg.includes(word.toLowerCase()));
}


// ==================================================================
const AI_CS_LOG = "./aicslog.json";
function logAiCsInteraction(source, userMsg, ctx) {
  try {
    const log = fs.existsSync(AI_CS_LOG) ? JSON.parse(fs.readFileSync(AI_CS_LOG)) : [];
    log.push({
      timestamp: Date.now(),
      userId: ctx.from.id,
      userName: ctx.from.first_name || "User",
      question: userMsg.slice(0, 200),
      source, // 'faq' | 'ai' | 'escalated'
    });
    fs.writeFileSync(AI_CS_LOG, JSON.stringify(log.slice(-2000), null, 2)); // simpan maks 2000 entri terakhir
  } catch (e) {
    console.error("[AI CS LOG] Gagal simpan log:", e.message);
  }
}

function sendAiCsDailySummary() {
  try {
    if (!fs.existsSync(AI_CS_LOG)) return;
    const log = JSON.parse(fs.readFileSync(AI_CS_LOG));
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const today = log.filter((e) => e.timestamp >= since);
    if (today.length === 0) return; // gak ada aktivitas, gak usah kirim ringkasan kosong

    const faqCount = today.filter((e) => e.source === "faq").length;
    const aiCount = today.filter((e) => e.source === "ai").length;
    const escalatedCount = today.filter((e) => e.source === "escalated").length;
    const uniqueUsers = new Set(today.map((e) => e.userId)).size;

    bot.telegram
      .sendMessage(
        config.ownerId,
        `<blockquote><b>📊 Ringkasan AI Customer Support</b> (24 jam terakhir)\n\n` +
          `👥 <b>User unik:</b> ${uniqueUsers}\n` +
          `💬 <b>Total pertanyaan:</b> ${today.length}\n` +
          `📋 <b>Dijawab FAQ:</b> ${faqCount}\n` +
          `🤖 <b>Dijawab AI:</b> ${aiCount}\n` +
          `📞 <b>Gagal jawab / perlu kamu:</b> ${escalatedCount}</blockquote>`,
        { parse_mode: "HTML" }
      )
      .catch((e) => console.error("[AI CS SUMMARY] Gagal kirim:", e.message));
  } catch (e) {
    console.error("[AI CS SUMMARY] Error:", e.message);
  }
}


// Owner nambah Q&A sendiri lewat menu owner. Kalau pesan user cocok
// sama salah satu kata kunci FAQ, jawaban FAQ dipakai (akurat, gratis,
// instan). Kalau tidak ada yang cocok, baru lanjut ke AI CS seperti biasa.
// ==================================================================
const FAQ_DB = "./faq.json";
function readFaq() {
  if (!fs.existsSync(FAQ_DB)) fs.writeFileSync(FAQ_DB, JSON.stringify([]));
  try {
    return JSON.parse(fs.readFileSync(FAQ_DB));
  } catch (e) {
    return [];
  }
}
function saveFaq(data) {
  fs.writeFileSync(FAQ_DB, JSON.stringify(data, null, 2));
}

/** Cari FAQ yang kata kuncinya paling banyak cocok dengan pesan user. */
function findFaqMatch(userMessage) {
  const faqs = readFaq();
  if (faqs.length === 0) return null;

  const msg = userMessage.toLowerCase();
  let best = null;
  let bestScore = 0;

  for (const faq of faqs) {
    let score = 0;
    for (const kw of faq.keywords) {
      if (msg.includes(kw.toLowerCase())) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = faq;
    }
  }

  return bestScore > 0 ? best : null;
}


// Menjawab pesan bebas (bukan command/menu) yang tidak match state
// manapun, pakai Gemini (API fidzzcodex). Kalau apikeynya belum diisi,
// otomatis kasih jawaban default + tombol kontak owner (tanpa error).
// ==================================================================
const AI_CS_MENU_LABELS = ["📁 ☇ 𝗦𝗰𝗿𝗶𝗽𝘁", "📱 ☇ 𝗔𝗽𝗽𝘀", "📡 ☇ 𝗣𝗮𝗻𝗲𝗹", "🛠 ☇ 𝗧𝗼𝗼𝗹𝘀", "🌸 ☇ 𝗢𝘄𝗻𝗲𝗿"];

function buildAiCsSystemContext() {
  return (
    `Kamu adalah customer service otomatis untuk toko Telegram bernama "${config.botName || "Toko"}". ` +
    `Toko ini jual produk digital: script, aplikasi premium, panel hosting, VPS, dan jasa nomor OTP. ` +
    `Owner toko: ${config.ownerUser || "-"}. ` +
    `Cara order: pilih kategori produk dari menu utama bot, pilih item, lalu bayar via QRIS (Nevapedia). ` +
    `Kalau kamu tidak yakin jawabannya atau pertanyaannya soal komplain/refund/masalah teknis spesifik, ` +
    `jawab jujur bahwa kamu akan menyambungkan ke owner, jangan mengarang. ` +
    `Jawab singkat (maks 4 kalimat), ramah, jangan pakai markdown/asterisk berlebihan. ` +
    `PENTING soal bahasa: deteksi bahasa pesan customer di bawah ini, lalu WAJIB balas menggunakan bahasa yang SAMA persis. ` +
    `Kalau customer nulis pakai Bahasa Inggris, balas full Bahasa Inggris. Kalau Bahasa Indonesia, balas Bahasa Indonesia santai tapi sopan. ` +
    `Kalau bahasa lain (Melayu, Arab, Mandarin, dll), tetap balas pakai bahasa yang sama seperti pesan customer. Jangan pernah campur dua bahasa dalam satu balasan.`
  );
}

/** Terjemahkan teks (misal jawaban FAQ) ke bahasa yang sama dengan pesan referensi, pakai AI. Diam-diam gagal ke teks asli kalau error. */
async function translateToMatchLanguage(text, referenceMessage) {
  const apikey = config.externalApi?.fidzzcodex?.apikey;
  if (!apikey || apikey === "-") return text;
  try {
    const ep = ExtAPI.findEndpoint(ExtAPI.FIDZZ_ENDPOINTS, "gemini");
    const prompt =
      `Deteksi bahasa dari pesan customer ini: "${referenceMessage}". ` +
      `Kalau bahasanya SUDAH Bahasa Indonesia, balas HANYA dengan teks berikut ini persis apa adanya tanpa perubahan: "${text}". ` +
      `Kalau bahasanya BUKAN Bahasa Indonesia, terjemahkan teks berikut ke bahasa yang sama dengan pesan customer: "${text}". ` +
      `Balas HANYA hasil akhirnya (teks asli atau terjemahan), tanpa penjelasan tambahan, tanpa tanda kutip.`;
    const data = ExtAPI.deepStripCredit(await ExtAPI.callFidzz(ep, { prompt, session_id: `cs_translate_${Date.now()}` }));
    const translated = data?.result || data?.message || data?.response;
    return translated ? translated.trim() : text;
  } catch (e) {
    console.error("[AI CS] Gagal translate FAQ:", e.message);
    return text;
  }
}

async function handleAiCustomerSupport(ctx) {
  const userMsg = ctx.message.text;

  // Filter kata kasar/toxic - diblokir sebelum sempat ke FAQ/AI sama sekali
  if (containsToxicContent(userMsg)) {
    logAiCsInteraction("blocked", userMsg, ctx);
    return safeReply(
      ctx,
      "<blockquote>😅 Yuk jaga obrolan tetap sopan ya. Kalau ada pertanyaan soal produk/order, aku siap bantu!</blockquote>",
      { parse_mode: "HTML" }
    );
  }

  // Cek FAQ buatan owner dulu sebelum AI (lebih akurat & gratis)
  const faqMatch = findFaqMatch(userMsg);
  if (faqMatch) {
    logAiCsInteraction("faq", userMsg, ctx);
    const translatedAnswer = await translateToMatchLanguage(faqMatch.answer, userMsg);
    return safeReply(ctx, `<blockquote>💬 ${translatedAnswer}</blockquote>`, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "📞 Bukan itu, sambungkan ke Owner", callback_data: "menu_owner_contact" }]],
      },
    });
  }

  const apikey = config.externalApi?.fidzzcodex?.apikey;

  if (!apikey || apikey === "-") {
    // Apikey AI CS (fidzzcodex) belum diisi -> jangan diam, tetap kasih respons dasar + kontak owner
    return safeReply(
      ctx,
      `<blockquote>👋 Halo! Aku belum bisa jawab otomatis (fitur AI CS belum diaktifkan owner).\nKetik /help buat lihat semua command, atau hubungi owner langsung.</blockquote>`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "📞 Hubungi Owner", callback_data: "menu_owner_contact" }]] },
      }
    );
  }

  try {
    const ep = ExtAPI.findEndpoint(ExtAPI.FIDZZ_ENDPOINTS, "gemini");
    const prompt = `${buildAiCsSystemContext()}\n\nPertanyaan customer: "${userMsg}"`;
    const data = ExtAPI.deepStripCredit(await ExtAPI.callFidzz(ep, { prompt, session_id: `cs_${ctx.from.id}` }));
    const answer = data?.result || data?.message || data?.response || (typeof data === "string" ? data : null);

    if (!answer) throw new Error("Respons AI kosong");

    logAiCsInteraction("ai", userMsg, ctx);
    await safeReply(ctx, `<blockquote>🤖 ${answer}</blockquote>`, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "📞 Bukan itu, sambungkan ke Owner", callback_data: "menu_owner_contact" }]],
      },
    });
  } catch (err) {
    console.error("[AI CS] error:", err.message);
    logAiCsInteraction("escalated", userMsg, ctx);
    await safeReply(
      ctx,
      `<blockquote>👋 Maaf, aku belum bisa jawab pertanyaan itu otomatis. Coba hubungi owner ya.</blockquote>`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "📞 Hubungi Owner", callback_data: "menu_owner_contact" }]] },
      }
    );
  }
}

bot.on("text", async (ctx) => {
  const text = ctx.message.text || "";
  if (text.startsWith("/")) return; // command tak dikenal -> biarkan Telegram default, jangan dijawab AI
  if (AI_CS_MENU_LABELS.includes(text)) return; // tombol menu reply-keyboard, seharusnya sudah ditangani sebelumnya
  if (ctx.from.id === config.ownerId) return; // owner tidak perlu dijawab AI, kemungkinan lagi input state lain
  return handleAiCustomerSupport(ctx);
});

bot.catch((err, ctx) => {
    console.error("Bot Error:", err);
    safeReply(ctx, "<blockquote>❌ <b>Terjadi kesalahan.</b></blockquote>", { parse_mode: "HTML" });
});

bot.launch().then(() => {
  console.log("🤖 Bot Berjalan!");
  
  setTimeout(() => {
    console.log("[INFO] Mengirim backup startup ke owner...");
    createAndSendFullBackup(null, true);
  }, 10000);

  const INTERVAL_BACKUP = 2 * 60 * 60 * 1000; 
  
  setInterval(() => {
    console.log("[INFO] Menjalankan Auto Backup Berkala...");
    createAndSendFullBackup(null, true);
  }, INTERVAL_BACKUP);

  // Ringkasan harian AI CS ke owner (cek tiap 5 menit, kirim sekali per hari di jam yang ditentukan)
  let lastAiCsSummaryDate = null;
  setInterval(() => {
    const now = new Date();
    const targetHour = config.aiCsSummaryHour ?? 21; // default jam 21:00
    const dateStr = now.toDateString();
    if (now.getHours() === targetHour && lastAiCsSummaryDate !== dateStr) {
      lastAiCsSummaryDate = dateStr;
      sendAiCsDailySummary();
    }
  }, 5 * 60 * 1000);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));