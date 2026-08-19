require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const store = require('./store');
const ui = require('./ui');

if (!process.env.BOT_TOKEN) throw new Error('BOT_TOKEN belum diisi di .env');
const bot = new Telegraf(process.env.BOT_TOKEN);
const OWNER_IDS = (process.env.OWNER_IDS || '').split(',').map(x => x.trim()).filter(Boolean).map(Number);
const sessions = new Map();
const MAX_STOCK_PREVIEW = 20;
const ORDER_QUEUES = new Map();

function isOwner(id) { return OWNER_IDS.includes(Number(id)); }
function isAdmin(id) { return store.isAdmin(id); }
function isStaff(id) { return isOwner(id) || isAdmin(id); }
async function withOrderLock(key, fn) {
  const previous = ORDER_QUEUES.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  ORDER_QUEUES.set(key, current);
  await previous;
  try { return await fn(); } finally { release(); if (ORDER_QUEUES.get(key) === current) ORDER_QUEUES.delete(key); }
}
function b(...items) { return items; }
async function ack(ctx, text, alert = false) { try { await ctx.answerCbQuery(text, { show_alert: alert }); } catch {} }
function kb(buttons) { return Markup.inlineKeyboard(ui.rows(buttons)); }
function fmtTime(ts) { return ts ? new Date(ts).toLocaleString('id-ID', { hour12: false }) : '-'; }
function orderReceiptText(o, p, pkg, mode = 'admin') {
  const events = Array.isArray(o.events) ? o.events : [];
  const ev = events.slice(-12).map(e => `• ${fmtTime(e.at)} — <b>${ui.escapeHtml(e.type)}</b>: ${ui.escapeHtml(e.message)}`).join('\n') || 'Belum ada log.';
  const buyer = store.store.users?.[String(o.buyerId)] || {};
  return `🧾 <b>RESI PESANAN</b>\n\n🔖 Resi: <code>${ui.escapeHtml(o.receiptId || '-')}</code>\n🆔 Order: <code>${ui.escapeHtml(o.id)}</code>\n👤 User ID: <code>${o.buyerId}</code>${buyer.username ? `\n👤 Username: @${ui.escapeHtml(buyer.username)}` : ''}\n📦 Produk: <b>${ui.escapeHtml(p?.name || o.productId)}</b>\n⏱️ Paket: <b>${ui.escapeHtml(pkg?.name || o.packageId)}</b>\n⚙️ Model: <b>${ui.escapeHtml(p?.model || '-')}</b>\n💵 Harga: <b>Rp${ui.money(o.price)}</b>\n📌 Status: <b>${ui.escapeHtml(o.status)}</b>\n🕒 Dibuat: ${fmtTime(o.createdAt)}\n💳 Dibayar: ${fmtTime(o.paidAt)}\n✅ Selesai: ${fmtTime(o.completedAt)}\n↩️ Refund: ${fmtTime(o.refundedAt)}\n${o.failureReason ? `⚠️ Error: <b>${ui.escapeHtml(o.failureReason)}</b>\n` : ''}\n<b>🔍 Log proses</b>\n${ev}`;
}
async function notifyAdminOrder(telegram, o, kind = 'success') {
  const p = store.getProduct(o.productId);
  const pkg = store.getPackage(p, o.packageId);
  const title = kind === 'success' ? '🟢 PESANAN BERHASIL' : kind === 'failed' ? '🔴 PESANAN GAGAL' : '🟡 PESANAN DIBAYAR';
  for (const oid of new Set([...OWNER_IDS, ...store.listAdmins()])) {
    try {
      await telegram.sendMessage(oid, `${title}\n\n${orderReceiptText(o, p, pkg)}`, { parse_mode: 'HTML', ...kb([['🧾 Cek Resi', `admin:receipt:${o.id}`], ['🧾 Semua Order', 'admin:orders'], ['🛠️ Admin', 'admin']]) });
    } catch (e) { console.error('[ORDER NOTIFY]', e.message); }
  }
}

async function render(ctx, text, buttons = []) {
  const extra = { parse_mode: 'HTML', ...kb(buttons) };
  try {
    if (ctx.callbackQuery?.message?.photo) {
      try { await ctx.deleteMessage(); } catch {}
      return ctx.reply(text, extra);
    }
    return await ctx.editMessageText(text, extra);
  } catch (e) {
    if (/message is not modified/i.test(e.message || '')) return;
    if (/message to edit not found|can't edit|message can't be edited|there is no text in the message to edit/i.test(e.message || '')) {
      try { await ctx.deleteMessage(); } catch {}
      return ctx.reply(text, extra);
    }
    console.error('[RENDER]', e);
  }
}

function mainKb(id) {
  if (isOwner(id)) {
    return [
      ['📦 Cek Katalog', 'products'],
      ['🛠️ Admin Panel', 'admin'],
      ['🧾 Cek Order', 'admin:orders'],
      ['📊 Statistik', 'admin:stats'],
      ['👋 Home', 'home']
    ];
  }
  return [
    ['🛍️ Produk', 'products'],
    ['🧾 Pesanan', 'orders'],
    ['💰 Saldo', 'wallet'],
    ['💳 Deposit', 'deposit'],
    ['ℹ️ Bantuan', 'help'],
    ['👋 Home', 'home']
  ];
}

async function home(ctx) {
  const f = ctx.from || {};
  store.user(f.id, { firstName: f.first_name || '', username: f.username || '' });
  const text = ui.homeText(f.first_name || 'Kak', isStaff(f.id));
  const banner = store.getSetting('bannerFileId');
  if (ctx.callbackQuery) { try { await ctx.deleteMessage(); } catch {} }
  if (banner) return ctx.replyWithPhoto(banner, { caption: store.getSetting('bannerCaption') || text, parse_mode: 'HTML', ...kb(mainKb(f.id)) });
  return ctx.reply(text, { parse_mode: 'HTML', ...kb(mainKb(f.id)) });
}

function catalogButtons() {
  return store.products.map(p => {
    const a = store.productAvailability(p);
    return [a.available ? `${p.emoji || '📦'} ${p.name}` : `❌ ${p.emoji || '📦'} ${p.name}`, `p:${p.id}`];
  }).concat([['👋 Home', 'home']]);
}

function cancelWizardButtons() {
  return [['❌ Batalkan', 'cancel_wizard'], ['👋 Home', 'home']];
}

async function showCatalog(ctx) {
  const text = isStaff(ctx.from.id)
    ? '📦 <b>Katalog / Cek Ketersediaan</b>\n\nAdmin hanya bisa melihat status. Pembelian dari akun admin dinonaktifkan.'
    : '🛍️ <b>Daftar Produk</b>\n\n❌ = belum siap dijual / harga belum diset / stok habis\n✅ = siap dipesan\n\nPilih produk:';
  return render(ctx, text, catalogButtons());
}

bot.start(home);
bot.action('home', async c => { await ack(c, 'Menu utama'); sessions.delete(c.from.id); return home(c); });
bot.action('products', async c => { await ack(c, 'Memuat katalog'); return showCatalog(c); });

bot.action(/^p:(.+)$/, async c => {
  const p = store.getProduct(c.match[1]);
  if (!p) return ack(c, 'Produk tidak ditemukan', true);
  const a = store.productAvailability(p);
  await ack(c, p.name);
  const pkgs = p.packages.map(x => {
    const pa = store.productAvailability(p, x.id);
    const label = pa.available ? `💳 ${x.name} • Rp${ui.money(x.price)}` : `❌ ${x.name} • ${pa.reason}`;
    return [label, pa.available ? `pkg:${p.id}:${x.id}` : `unavailable:${p.id}:${x.id}`];
  });
  const extra = [['↩️ Kembali', 'products'], ['👋 Home', 'home']];
  if (isStaff(c.from.id)) extra.unshift(['🛠️ Kelola Produk', `admin:product:${p.id}`]);
  return render(c, ui.productText(p), pkgs.concat(extra));
});

bot.action(/^unavailable:(.+):(.+)$/, async c => {
  const p = store.getProduct(c.match[1]);
  const pkg = store.getPackage(p, c.match[2]);
  if (!p || !pkg) return ack(c, 'Paket tidak ditemukan', true);
  const reason = store.productAvailability(p, pkg.id).reason;
  return ack(c, `❌ ${reason}`, true);
});

bot.action(/^pkg:(.+):(.+)$/, async c => {
  if (isStaff(c.from.id)) return ack(c, 'Admin tidak dapat membeli produk.', true);
  const p = store.getProduct(c.match[1]);
  const pkg = store.getPackage(p, c.match[2]);
  if (!p || !pkg) return ack(c, 'Paket tidak ditemukan', true);
  const a = store.productAvailability(p, pkg.id);
  if (!a.available) return ack(c, `❌ ${a.reason}`, true);
  try {
    const o = store.createOrder({ buyerId: c.from.id, productId: p.id, packageId: pkg.id });
    sessions.set(c.from.id, { orderId: o.id, step: p.fields?.length ? 'order_field' : 'order_confirm', fieldIndex: 0, answers: {} });
    await ack(c, 'Pesanan dibuat');
    if (p.fields?.length) return nextOrderField(c, p);
    return confirmOrder(c, o);
  } catch (e) { return ack(c, e.message || 'Gagal membuat pesanan', true); }
});

async function confirmOrder(c, o) {
  const p = store.getProduct(o.productId);
  const pkg = store.getPackage(p, o.packageId);
  const u = store.user(c.from.id);
  const text = `🧾 <b>Konfirmasi Pesanan</b>\n\n📦 ${ui.escapeHtml(p.name)}\n⏱️ ${ui.escapeHtml(pkg.name)}\n💵 <b>Rp${ui.money(o.price)}</b>\n💰 Saldo: Rp${ui.money(u.balance)}\n\nLanjutkan pembayaran?`;
  const buttons = [['✅ Bayar Sekarang', `pay:${o.id}`], ['❌ Batalkan', `cancel:${o.id}`], ['↩️ Produk', 'products'], ['👋 Home', 'home']];
  if (c.callbackQuery) return render(c, text, buttons);
  return c.reply(text, { parse_mode: 'HTML', ...kb(buttons) });
}

async function nextOrderField(c, p) {
  const s = sessions.get(c.from.id);
  const f = p.fields[s.fieldIndex];
  if (!f) { s.step = 'order_confirm'; sessions.set(c.from.id, s); return confirmOrder(c, store.getOrder(s.orderId)); }
  const text = `📝 <b>Data Pesanan</b>\n\nBagian ${s.fieldIndex + 1}/${p.fields.length}\n📌 <b>${ui.escapeHtml(f.label)}</b>\n\nKirim data ini sebagai pesan biasa.`;
  const buttons = cancelWizardButtons();
  if (c.callbackQuery) return render(c, text, buttons);
  return c.reply(text, { parse_mode: 'HTML', ...kb(buttons) });
}

bot.action(/^pay:(.+)$/, async c => {
  if (isStaff(c.from.id)) return ack(c, 'Admin tidak dapat membeli produk.', true);
  const o = store.getOrder(c.match[1]);
  if (!o || o.buyerId !== c.from.id) return ack(c, 'Order bukan milikmu', true);
  if (o.status !== 'awaiting_payment') return ack(c, 'Order sudah diproses');
  const p = store.getProduct(o.productId);
  try {
    if (p.deliveryType === 'stock') {
      const item = await withOrderLock(`${p.id}:${o.packageId}`, async () => {
        const fresh = store.getOrder(o.id);
        if (!fresh || fresh.status !== 'awaiting_payment') throw Error('Order sudah diproses atau sudah tidak aktif.');
        const reserved = store.beginStockOrder(o.id);
        try {
          await c.reply(`🎉 <b>Order Berhasil</b>\n\n📦 ${ui.escapeHtml(p.name)}\n⏱️ ${ui.escapeHtml(store.getPackage(p, o.packageId)?.name || o.packageId)}\n🧾 Resi: <code>${ui.escapeHtml(fresh.receiptId)}</code>\n\n🔐 <b>Data akun:</b>\n<code>${ui.escapeHtml(reserved.value)}</code>`, { parse_mode: 'HTML' });
          store.commitStockOrder(o.id);
          return reserved;
        } catch (deliveryErr) {
          try { store.rollbackStockOrder(o.id, deliveryErr.message || 'Telegram delivery gagal'); } catch (rollbackErr) { console.error('[ROLLBACK]', rollbackErr); }
          throw deliveryErr;
        }
      });
      sessions.delete(c.from.id);
      await notifyAdminOrder(c.telegram, store.getOrder(o.id), 'success');
      await notifyStockEmpty(c.telegram, p, store.getPackage(p, o.packageId));
      return render(c, `✅ <b>Pesanan terkirim</b>\n\n🧾 Resi: <code>${ui.escapeHtml(o.receiptId)}</code>\n📦 ${ui.escapeHtml(p.name)}\n🔐 Data sudah dikirim di pesan sebelumnya.`, [
        ['🧾 Pesanan Saya', 'orders'], ['🛍️ Beli Lagi', 'products'], ['👋 Home', 'home']
      ]);
    }
    store.payOrder(o.id);
    await notifyAdminOrder(c.telegram, store.getOrder(o.id), 'paid');
    sessions.delete(c.from.id);
    return render(c, `✅ <b>Pembayaran diterima</b>\n\n🆔 <code>${o.id}</code>\n📦 ${ui.escapeHtml(p.name)}\n\n⏳ Pesanan masuk proses aktivasi/manual.`, [
      ['🧾 Pesanan Saya', 'orders'], ['👋 Home', 'home']
    ]);
  } catch (e) {
    console.error('[PAY]', e);
    const msg = e.message || 'Pembayaran gagal';
    if (o.status === 'paid') {
      try { store.failOrderAndRefund(o.id, msg); } catch (refundErr) { console.error('[REFUND]', refundErr); }
    }
    try { await notifyAdminOrder(c.telegram, store.getOrder(o.id), 'failed'); } catch {}
    return ack(c, msg, true);
  }
});

bot.action(/^cancel:(.+)$/, async c => {
  const o = store.getOrder(c.match[1]);
  if (!o || o.buyerId !== c.from.id) return ack(c, 'Tidak diizinkan', true);
  if (o.status !== 'awaiting_payment') return ack(c, 'Order sudah tidak bisa dibatalkan', true);
  o.status = 'cancelled'; o.cancelledAt = Date.now(); store.appendOrderEvent(o.id, 'cancelled', 'Buyer membatalkan order sebelum pembayaran.'); sessions.delete(c.from.id);
  await ack(c, 'Order dibatalkan');
  return render(c, '❌ <b>Pesanan dibatalkan.</b>', mainKb(c.from.id));
});

bot.action('orders', async c => {
  if (isStaff(c.from.id)) return ack(c, 'Gunakan Panel Admin untuk melihat order.', true);
  const os = store.listOrdersByUser(c.from.id);
  if (!os.length) return render(c, '🧾 <b>Pesanan Saya</b>\n\nBelum ada pesanan.', [['🛍️ Belanja', 'products'], ['👋 Home', 'home']]);
  const b = os.slice(0, 15).map(o => [`🧾 ${o.id} • ${o.status}`, `order:${o.id}`]);
  return render(c, '🧾 <b>Pesanan Saya</b>\n\nPilih pesanan:', b.concat([['👋 Home', 'home']]));
});

bot.action(/^order:(.+)$/, async c => {
  const o = store.getOrder(c.match[1]);
  if (!o || o.buyerId !== c.from.id) return ack(c, 'Tidak diizinkan', true);
  const p = store.getProduct(o.productId);
  return render(c, `🧾 <b>Detail Pesanan</b>\n\n🔖 Resi: <code>${ui.escapeHtml(o.receiptId || '-')}</code>\n🆔 <code>${o.id}</code>\n📦 ${ui.escapeHtml(p?.name || o.productId)}\n💵 Rp${ui.money(o.price)}\n📌 Status: <b>${ui.escapeHtml(o.status)}</b>${o.failureReason ? `\n⚠️ ${ui.escapeHtml(o.failureReason)}` : ''}`, [['↩️ Pesanan', 'orders'], ['🛍️ Belanja', 'products'], ['👋 Home', 'home']]);
});

bot.action('wallet', async c => {
  if (isOwner(c.from.id)) return ack(c, 'Admin tidak memakai saldo buyer.', true);
  const u = store.user(c.from.id);
  await ack(c, `Saldo Rp${ui.money(u.balance)}`);
  return render(c, `💰 <b>Saldo Saya</b>\n\nSaldo: <b>Rp${ui.money(u.balance)}</b>`, [['💳 Deposit', 'deposit'], ['🛍️ Belanja', 'products'], ['🧾 Riwayat', 'orders'], ['👋 Home', 'home']]);
});

bot.action('deposit', async c => {
  if (isOwner(c.from.id)) return ack(c, 'Admin tidak dapat deposit sebagai buyer.', true);
  sessions.set(c.from.id, { step: 'deposit_amount' });
  await ack(c, 'Masukkan nominal deposit');
  return render(c, '💳 <b>Deposit Saldo</b>\n\nKirim nominal yang ingin ditambahkan.\nContoh: <code>50000</code>\n\nSetelah nominal dibuat, QRIS dari admin akan tampil dan kamu diminta mengirim foto bukti pembayaran.', cancelWizardButtons());
});

bot.action('help', c => render(c, 'ℹ️ <b>Bantuan</b>\n\n1. Pilih produk\n2. Pilih paket yang bertanda ✅\n3. Isi data jika diminta\n4. Bayar dengan saldo\n5. Produk stok dikirim otomatis; produk form diproses manual.', [['🛍️ Produk', 'products'], ['💰 Saldo', 'wallet'], ['👋 Home', 'home']]));

bot.action('cancel_wizard', async c => {
  const s = sessions.get(c.from.id);
  if (s?.step === 'deposit_proof' && s.depositId) { try { store.rejectDeposit(s.depositId, 'Dibatalkan buyer'); } catch {} }
  sessions.delete(c.from.id);
  await ack(c, 'Proses dibatalkan');
  return render(c, '❌ <b>Proses dibatalkan.</b>', mainKb(c.from.id));
});

// BUYER TEXT INPUTS
bot.on('text', async c => {
  const s = sessions.get(c.from.id);
  if (!s) return;
  if (isOwner(c.from.id) && !s.step.startsWith('admin_')) {
    if (s.step === 'deposit_amount' || s.step === 'deposit_proof' || s.step === 'order_field') return c.reply('⚠️ Akun admin tidak dapat memakai flow buyer.');
  }

  if (s.step === 'order_field') {
    const o = store.getOrder(s.orderId), p = o && store.getProduct(o.productId);
    if (!o || !p) { sessions.delete(c.from.id); return c.reply('❌ Sesi order tidak ditemukan.'); }
    const f = p.fields[s.fieldIndex];
    const value = c.message.text.trim();
    if (f.required && !value) return c.reply('⚠️ Data wajib diisi.');
    s.answers[f.id] = value; s.fieldIndex++; o.answers = s.answers; store.save();
    try { await c.deleteMessage(); } catch {}
    if (s.fieldIndex < p.fields.length) return nextOrderField(c, p);
    s.step = 'order_confirm'; sessions.set(c.from.id, s);
    return confirmOrder(c, o);
  }

  if (s.step === 'deposit_amount') {
    const n = Number(c.message.text.trim());
    const min = Number(store.getSetting('minDeposit')) || 1000;
    if (!Number.isFinite(n) || n < min) return c.reply(`⚠️ Minimal deposit Rp${ui.money(min)}.`);
    const qris = store.getSetting('qrisFileId');
    if (!qris) return c.reply('⚠️ QRIS deposit belum dipasang admin.');
    let d;
    try { d = store.createDeposit({ userId: c.from.id, amount: n }); } catch (e) { return c.reply(`⚠️ ${e.message}`); }
    s.step = 'deposit_proof'; s.depositId = d.id; sessions.set(c.from.id, s);
    const sticker = store.getSetting('depositStickerFileId');
    if (sticker && store.getSetting('depositStickerEnabled')) {
      try {
        const m = await c.replyWithSticker(sticker);
        setTimeout(() => c.telegram.deleteMessage(c.chat.id, m.message_id).catch(() => {}), 5000);
      } catch (e) { console.error('[STICKER]', e); }
    }
    try {
      const cap = store.getSetting('qrisCaption') || 'QRIS Deposit';
      await c.replyWithPhoto(qris, { caption: `💳 <b>${ui.escapeHtml(cap)}</b>\n\n🆔 ID Deposit: <code>${d.id}</code>\n💵 Nominal: <b>Rp${ui.money(d.amount)}</b>\n\nSilakan bayar sesuai nominal di atas. Setelah selesai, kirim <b>foto bukti pembayaran</b> di chat ini.`, parse_mode: 'HTML' });
    } catch (e) {
      sessions.delete(c.from.id); try { store.rejectDeposit(d.id, 'QRIS gagal ditampilkan'); } catch {}
      return c.reply('❌ QRIS gagal ditampilkan. Deposit dibatalkan otomatis.');
    }
    return c.reply(`✅ <b>Deposit dibuat</b>\n\n🆔 <code>${d.id}</code>\n💵 Nominal: <b>Rp${ui.money(d.amount)}</b>\n\nKirim foto bukti pembayaran.`, { parse_mode: 'HTML', ...kb([['❌ Batalkan', 'cancel_wizard'], ['👋 Home', 'home']]) });
  }
  if (s.step === 'deposit_proof') return c.reply('📎 Kirim bukti pembayaran sebagai foto.');

  if (!isStaff(c.from.id)) return;

  if (s.step === 'admin_restock') {
    const p = store.getProduct(s.productId);
    const pkg = store.getPackage(p, s.packageId);
    const lines = c.message.text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    if (!p || !pkg || p.deliveryType !== 'stock') return c.reply('⚠️ Produk atau paket tidak valid.');
    try {
      store.addStock(p.id, pkg.id, lines);
      sessions.delete(c.from.id);
      return c.reply(`✅ <b>Restock berhasil</b>\n\n📦 ${ui.escapeHtml(p.name)}\n⏱️ Paket: <b>${ui.escapeHtml(pkg.name)}</b>\n➕ Ditambahkan: <b>${lines.length}</b>\n📊 Stok paket sekarang: <b>${store.availableStock(p, pkg.id)}</b>`, { parse_mode: 'HTML', ...kb([['👀 Cek Stok', `admin:stock:${p.id}:${pkg.id}`], ['📥 Restock Lagi', `admin:restock:${p.id}`], ['🛠️ Admin', 'admin']]) });
    } catch (e) { return c.reply(`⚠️ ${e.message}`); }
  }
  if (s.step === 'admin_price') {
    const n = Number(c.message.text.trim());
    if (!Number.isFinite(n) || n < 0) return c.reply('⚠️ Harga tidak valid.');
    const p = store.getProduct(s.productId), pkg = store.getPackage(p, s.packageId);
    if (!pkg) { sessions.delete(c.from.id); return c.reply('❌ Paket tidak ditemukan.'); }
    pkg.price = n; store.save(); sessions.delete(c.from.id);
    return c.reply(`✅ Harga <b>${ui.escapeHtml(pkg.name)}</b> diubah menjadi <b>Rp${ui.money(n)}</b>.`, { parse_mode: 'HTML', ...kb([['💳 Paket', `admin:packages:${p.id}`], ['🛠️ Admin', 'admin']]) });
  }
  if (s.step === 'admin_editname') {
    const name = c.message.text.trim(); if (!name) return c.reply('⚠️ Nama tidak boleh kosong.');
    const p = store.updateProduct(s.productId, { name }); sessions.delete(c.from.id);
    return c.reply(`✅ Nama produk menjadi <b>${ui.escapeHtml(p.name)}</b>.`, { parse_mode: 'HTML', ...kb([['📦 Produk', 'admin:products'], ['🛠️ Admin', 'admin']]) });
  }
  if (s.step === 'admin_addproduct_id') {
    const id = c.message.text.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!id) return c.reply('⚠️ ID tidak valid. Gunakan huruf, angka, _ atau -.');
    if (store.getProduct(id)) return c.reply('⚠️ ID sudah dipakai.');
    s.id = id; s.step = 'admin_addproduct_name'; sessions.set(c.from.id, s); return c.reply('2️⃣ Kirim <b>nama produk</b>.', { parse_mode: 'HTML' });
  }
  if (s.step === 'admin_addproduct_name') {
    const name = c.message.text.trim(); if (!name) return c.reply('⚠️ Nama tidak boleh kosong.');
    s.name = name; s.step = 'admin_addproduct_emoji'; sessions.set(c.from.id, s); return c.reply('3️⃣ Kirim <b>emoji produk</b> atau <code>-</code> untuk default 📦.', { parse_mode: 'HTML' });
  }
  if (s.step === 'admin_addproduct_emoji') {
    s.emoji = c.message.text.trim() === '-' ? '📦' : c.message.text.trim().slice(0, 4);
    s.step = 'admin_addproduct_model'; sessions.set(c.from.id, s); return c.reply('4️⃣ Kirim <b>nama model</b> yang kamu mau. Contoh: <code>Akun Siap Pakai</code>, <code>Invite Family</code>, <code>Code</code>.', { parse_mode: 'HTML' });
  }
  if (s.step === 'admin_addproduct_model') {
    const model = c.message.text.trim(); if (!model) return c.reply('⚠️ Model tidak boleh kosong.');
    s.model = model; s.step = 'admin_addproduct_type'; sessions.set(c.from.id, s);
    return c.reply('5️⃣ Pilih tipe delivery produk:', kb([['📦 Stok Otomatis', 'admin:addtype:stock'], ['📝 Form / Manual', 'admin:addtype:form'], ['❌ Batalkan', 'cancel_wizard']]));
  }
  if (s.step === 'admin_addproduct_description') {
    s.description = c.message.text.trim() === '-' ? '' : c.message.text.trim();
    if (s.deliveryType === 'form') {
      s.step = 'admin_addproduct_fields';
      sessions.set(c.from.id, s);
      return c.reply('6️⃣ Kirim <b>field buyer</b>, satu per baris dengan format <code>id|Label|required</code>.\nContoh:\n<code>email|Email|required</code>\n<code>target|Username|optional</code>\n\nKetik <code>-</code> jika tidak ada field.', { parse_mode: 'HTML' });
    }
    s.fields = []; s.step = 'admin_addproduct_packages'; sessions.set(c.from.id, s);
    return c.reply('6️⃣ Kirim <b>paket + harga</b>, satu per baris dengan format <code>id|Nama Paket|Harga</code>.\nContoh:\n<code>1m|1 Bulan|25000</code>\n<code>3m|3 Bulan|60000</code>', { parse_mode: 'HTML' });
  }
  if (s.step === 'admin_addproduct_fields') {
    const raw = c.message.text.trim();
    s.fields = [];
    if (raw !== '-') {
      const lines = raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      for (const line of lines) {
        const [id, label, req = 'required'] = line.split('|').map(x => x.trim());
        if (!id || !label || !['required', 'optional'].includes(req.toLowerCase())) return c.reply('⚠️ Format field salah. Gunakan id|Label|required atau id|Label|optional.');
        s.fields.push({ id: id.toLowerCase().replace(/[^a-z0-9_-]/g, '_'), label, type: 'text', required: req.toLowerCase() === 'required' });
      }
    }
    s.step = 'admin_addproduct_packages'; sessions.set(c.from.id, s);
    return c.reply('7️⃣ Sekarang kirim <b>paket + harga</b>, satu per baris dengan format <code>id|Nama Paket|Harga</code>.\nContoh:\n<code>1m|1 Bulan|25000</code>\n<code>3m|3 Bulan|60000</code>', { parse_mode: 'HTML' });
  }
  if (s.step === 'admin_addproduct_packages') {
    const lines = c.message.text.trim().split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const packages = [];
    for (const line of lines) {
      const [id, name, priceRaw] = line.split('|').map(x => x.trim());
      const price = Number(priceRaw);
      if (!id || !name || !Number.isFinite(price) || price < 0) return c.reply('⚠️ Format paket salah. Gunakan id|Nama Paket|Harga.');
      if (packages.some(x => x.id === id)) return c.reply(`⚠️ ID paket <code>${ui.escapeHtml(id)}</code> duplikat.`, { parse_mode: 'HTML' });
      packages.push({ id: id.toLowerCase().replace(/[^a-z0-9_-]/g, '_'), name, price });
    }
    if (!packages.length) return c.reply('⚠️ Minimal satu paket wajib dibuat.');
    try {
      const p = store.createProduct({ id: s.id, name: s.name, emoji: s.emoji, model: s.model, description: s.description, deliveryType: s.deliveryType, fields: s.fields || [], packages, stock: [] });
      sessions.delete(c.from.id);
      return c.reply(`✅ <b>Produk berhasil dibuat</b>\n\n${p.emoji} <b>${ui.escapeHtml(p.name)}</b>\n🆔 <code>${p.id}</code>\n⚙️ Model: <b>${ui.escapeHtml(p.model)}</b>\n📦 Tipe: <b>${p.deliveryType === 'stock' ? 'Stok' : 'Form/Manual'}</b>\n💳 Paket: <b>${p.packages.length}</b>`, { parse_mode: 'HTML', ...kb([[p.deliveryType === 'stock' ? '📥 Restock' : '💳 Paket/Harga', p.deliveryType === 'stock' ? `admin:restock:${p.id}` : `admin:packages:${p.id}`], ['📦 Produk', 'admin:products'], ['🛠️ Admin', 'admin']]) });
    } catch (e) { return c.reply(`⚠️ ${e.message}`); }
  }
  if (s.step === 'owner_addadmin') {
    if (!isOwner(c.from.id)) { sessions.delete(c.from.id); return c.reply('❌ Hanya Owner.'); }
    const uid = Number(c.message.text.trim());
    if (!Number.isInteger(uid) || uid <= 0) return c.reply('⚠️ User ID tidak valid.');
    if (OWNER_IDS.includes(uid)) return c.reply('⚠️ User tersebut sudah menjadi Owner.');
    try { store.addAdmin(uid); sessions.delete(c.from.id); return c.reply(`✅ <b>Admin ditambahkan</b>\n\n👤 User ID: <code>${uid}</code>\n🔐 Semua fitur operasional aktif; Kelola Admin hanya Owner.`, { parse_mode: 'HTML', ...kb([['👥 Kelola Admin', 'admin:admins'], ['🛠️ Admin', 'admin']]) }); }
    catch (e) { return c.reply(`⚠️ ${e.message}`); }
  }
  if (s.step === 'admin_balance_user') {
    const parts = c.message.text.trim().split(/\s+/);
    if (parts.length !== 2) return c.reply('Format: USER_ID NOMINAL');
    const uid = Number(parts[0]), amt = Number(parts[1]);
    if (!Number.isInteger(uid) || !Number.isFinite(amt) || amt <= 0) return c.reply('⚠️ Format tidak valid.');
    const u = store.credit(uid, amt); sessions.delete(c.from.id);
    return c.reply(`✅ Saldo user <code>${uid}</code> sekarang <b>Rp${ui.money(u.balance)}</b>.`, { parse_mode: 'HTML', ...kb([['💳 Saldo Lagi', 'admin:balance'], ['🛠️ Admin', 'admin']]) });
  }
  if (s.step === 'admin_setbanner') return c.reply('📸 Kirim foto banner.');
  if (s.step === 'admin_setqris') return c.reply('💳 Kirim foto QRIS.');
  if (s.step === 'admin_setsticker') return c.reply('🏷️ Kirim sticker.');
  if (s.step === 'admin_store_name') {
    const name = c.message.text.trim();
    if (!name) return c.reply('⚠️ Nama store tidak boleh kosong.');
    if (name.length > 64) return c.reply('⚠️ Nama store maksimal 64 karakter.');
    store.setSetting('storeName', name);
    sessions.delete(c.from.id);
    return c.reply(`✅ Nama store diubah menjadi <b>${ui.escapeHtml(name)}</b>.`, { parse_mode: 'HTML', ...kb([['⚙️ Pengaturan', 'admin:settings'], ['🛠️ Admin', 'admin']]) });
  }
  if (s.step === 'admin_welcome') {
    const welcome = c.message.text.trim();
    if (!welcome) return c.reply('⚠️ Welcome tidak boleh kosong.');
    if (welcome.length > 3500) return c.reply('⚠️ Welcome terlalu panjang. Maksimal 3500 karakter.');
    store.setSetting('welcomeText', welcome);
    sessions.delete(c.from.id);
    return c.reply('✅ Welcome /start berhasil diubah.', kb([['⚙️ Pengaturan', 'admin:settings'], ['👀 Preview', 'admin:previewwelcome'], ['🛠️ Admin', 'admin']]));
  }
  if (s.step === 'admin_broadcast') {
    const users = store.listUsers(); let ok = 0;
    for (const u of users) { try { await c.telegram.sendMessage(u.id, c.message.text); ok++; } catch {} }
    sessions.delete(c.from.id);
    return c.reply(`✅ Broadcast selesai. Terkirim ${ok}/${users.length}.`, kb([['🛠️ Admin', 'admin']]));
  }
});

// ADMIN PANEL
function adminGuard(c) { return isStaff(c.from.id); }
function ownerGuard(c) { return isOwner(c.from.id); }
function adminKb(id) {
  const rows = [
    ['📦 Produk', 'admin:products'], ['➕ Tambah Produk', 'admin:addproduct'],
    ['📥 Restock', 'admin:restock'], ['👀 Cek Stok', 'admin:stockall'],
    ['💰 Saldo User', 'admin:balance'], ['💳 Deposit Pending', 'admin:deposits'],
    ['🧾 Order', 'admin:orders'], ['📊 Statistik', 'admin:stats'], ['📤 Broadcast', 'admin:broadcast'],
    ['⚙️ Pengaturan', 'admin:settings']
  ];
  if (isOwner(id)) rows.splice(2, 0, ['👥 Kelola Admin', 'admin:admins']);
  rows.push(['👋 Home', 'home']);
  return rows;
}

bot.action('admin', async c => { if (!adminGuard(c)) return ack(c, 'Akses ditolak', true); await ack(c, 'Panel admin'); return render(c, '🛠️ <b>ADMIN PANEL</b>\n\nAdmin hanya bisa kelola produk, restock, cek stok, saldo, deposit, dan pengaturan. Tidak bisa membeli.', adminKb(c.from.id)); });
bot.action('admin:stockall', async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  const lines = store.products.flatMap(p => p.packages.map(pkg => `• ${p.emoji || '📦'} ${ui.escapeHtml(p.name)} — ${ui.escapeHtml(pkg.name)}: <b>${store.availableStock(p, pkg.id)}</b>`));
  return render(c, `👀 <b>STOK SEMUA PRODUK</b>\n\n${lines.join('\n') || 'Belum ada produk.'}`, [['📥 Restock', 'admin:restock'], ['🛠️ Admin', 'admin']]);
});

bot.action('admin:admins', async c => {
  if (!ownerGuard(c)) return ack(c, 'Khusus Owner', true);
  const ids = store.listAdmins();
  const buttons = ids.map(id => [`👤 ${id}`, `admin:admin:${id}`]);
  buttons.push(['➕ Tambah Admin', 'admin:addadmin'], ['🛠️ Admin', 'admin']);
  return render(c, `👥 <b>Kelola Admin</b>\n\nOwner: <code>${OWNER_IDS.join(', ') || '-'}</code>\nAdmin aktif: <b>${ids.length}</b>`, buttons);
});

bot.action('admin:addadmin', async c => {
  if (!ownerGuard(c)) return ack(c, 'Khusus Owner', true);
  sessions.set(c.from.id, { step: 'owner_addadmin' });
  return render(c, '➕ <b>Tambah Admin</b>\n\nKirim <b>User ID Telegram</b>. Contoh: <code>123456789</code>\nGunakan User ID, bukan username.', cancelWizardButtons());
});

bot.action(/^admin:admin:(-?\d+)$/, async c => {
  if (!ownerGuard(c)) return ack(c, 'Khusus Owner', true);
  const id = Number(c.match[1]);
  if (!store.listAdmins().includes(id)) return ack(c, 'Admin tidak ditemukan', true);
  return render(c, `👤 <b>Admin ${id}</b>\n\nAdmin ini memiliki semua fitur operasional toko kecuali Kelola Admin.`, [['🗑️ Hapus Admin', `admin:adminremove:${id}`], ['↩️ Kelola Admin', 'admin:admins']]);
});

bot.action(/^admin:adminremove:(-?\d+)$/, async c => {
  if (!ownerGuard(c)) return ack(c, 'Khusus Owner', true);
  const id = Number(c.match[1]);
  store.removeAdmin(id); await ack(c, 'Admin dihapus');
  return render(c, `✅ Admin <code>${id}</code> dihapus.`, [['👥 Kelola Admin', 'admin:admins'], ['🛠️ Admin', 'admin']]);
});

bot.action('admin:products', async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  const bs = store.products.map(p => { const a = store.productAvailability(p); return [`${a.available ? '✅' : '❌'} ${p.emoji || '📦'} ${p.name}`, `admin:product:${p.id}`]; });
  return render(c, '📦 <b>Kelola Produk</b>\n\n✅ siap dijual\n❌ belum siap / stok habis\n\nPilih produk:', bs.concat([['➕ Tambah Produk', 'admin:addproduct'], ['↩️ Admin', 'admin']]));
});

bot.action(/^admin:product:(.+)$/, async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  const p = store.getProduct(c.match[1]); if (!p) return ack(c, 'Produk tidak ditemukan', true);
  const a = store.productAvailability(p);
  const buttons = [];
  if (p.deliveryType === 'stock') { buttons.push(['📥 Restock', `admin:restock:${p.id}`], ['👀 Cek Stok', `admin:stock:${p.id}`]); }
  buttons.push(['💳 Paket/Harga', `admin:packages:${p.id}`], ['✏️ Edit Nama', `admin:editname:${p.id}`], ['🗑️ Hapus', `admin:delete:${p.id}`], ['↩️ Produk', 'admin:products'], ['🛠️ Admin', 'admin']);
  const packageSummary = p.packages.map(x => `• ${ui.escapeHtml(x.name)} — Rp${ui.money(x.price)}${p.deliveryType === 'stock' ? ` — stok ${store.availableStock(p, x.id)}` : ''}`).join('\n');
  return render(c, `${p.emoji || '📦'} <b>${ui.escapeHtml(p.name)}</b>\n\n🆔 <code>${p.id}</code>\n⚙️ Model: <b>${ui.escapeHtml(p.model || (p.deliveryType === 'stock' ? 'Stok Akun' : 'Form / Manual'))}</b>\n📦 Tipe: <b>${p.deliveryType === 'stock' ? 'Stok per paket' : 'Form / Manual'}</b>\n📊 Total stok: <b>${p.deliveryType === 'stock' ? store.availableStock(p) : 'N/A'}</b>\n📌 Status: <b>${a.available ? '✅ Siap' : `❌ ${ui.escapeHtml(a.reason)}`}</b>\n\n<b>Paket:</b>\n${packageSummary || 'Belum ada paket.'}`, buttons);
});

// Package-specific stock view must be registered before the product-only route.
bot.action(/^admin:stock:(.+):(.+)$/, async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  const p = store.getProduct(c.match[1]); const pkg = store.getPackage(p, c.match[2]);
  if (!p || !pkg) return ack(c, 'Produk/paket tidak ditemukan', true);
  if (p.deliveryType !== 'stock') return ack(c, 'Produk ini tidak menggunakan stok', true);
  const items = Array.isArray(pkg.stock) ? pkg.stock : [];
  const list = items.slice(0, MAX_STOCK_PREVIEW).map((x, i) => `${i + 1}. <code>${ui.escapeHtml(x.value)}</code>`).join('\n') || 'Stok kosong.';
  return render(c, `👀 <b>Cek Stok</b>\n\n📦 ${ui.escapeHtml(p.name)}\n⏱️ ${ui.escapeHtml(pkg.name)}\n📊 Stok: <b>${items.length}</b>\n\n${list}${items.length > MAX_STOCK_PREVIEW ? `\n\n… dan ${items.length - MAX_STOCK_PREVIEW} lainnya.` : ''}`, [['📥 Restock Paket Ini', `admin:restock:${p.id}:${pkg.id}`], ['↩️ Semua Paket', `admin:stock:${p.id}`], ['🛠️ Admin', 'admin']]);
});

bot.action(/^admin:stock:(.+)$/, async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  const p = store.getProduct(c.match[1]); if (!p) return ack(c, 'Produk tidak ditemukan', true);
  if (p.deliveryType !== 'stock') return ack(c, 'Produk ini tidak menggunakan stok', true);
  const bs = p.packages.map(x => [`${store.availableStock(p, x.id) > 0 ? '✅' : '❌'} ${x.name} • ${store.availableStock(p, x.id)} stok`, `admin:stock:${p.id}:${x.id}`]);
  return render(c, `👀 <b>Cek Stok</b>\n\n📦 ${ui.escapeHtml(p.name)}\n📊 Total semua paket: <b>${store.availableStock(p)}</b>\n\nPilih paket untuk melihat detail stok:`, bs.concat([['📥 Restock', `admin:restock:${p.id}`], ['↩️ Detail', `admin:product:${p.id}`], ['🛠️ Admin', 'admin']]));
});

bot.action('admin:restock', async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  const stockProducts = store.products.filter(p => p.deliveryType === 'stock');
  if (!stockProducts.length) return render(c, '📥 <b>Restock</b>\n\nTidak ada produk yang menggunakan stok.', [['↩️ Admin', 'admin']]);
  await ack(c, 'Pilih produk');
  return render(c, '📥 <b>Restock</b>\n\n<b>Langkah 1/2:</b> Pilih produk.', stockProducts.map(p => [`📦 ${p.name} • ${store.availableStock(p)} total`, `admin:restock:${p.id}`]).concat([['↩️ Admin', 'admin']]));
});

bot.action(/^admin:restock:(.+):(.+)$/, async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  const p = store.getProduct(c.match[1]);
  const pkg = store.getPackage(p, c.match[2]);
  if (!p || !pkg) return ack(c, 'Produk/paket tidak ditemukan', true);
  if (p.deliveryType !== 'stock') return ack(c, 'Produk form/manual tidak membutuhkan restock', true);
  sessions.set(c.from.id, { step: 'admin_restock', productId: p.id, packageId: pkg.id });
  await ack(c, `Paket ${pkg.name}`);
  return render(c, `📥 <b>Restock</b>\n\n📦 ${ui.escapeHtml(p.name)}\n⏱️ <b>${ui.escapeHtml(pkg.name)}</b>\n📊 Stok saat ini: <b>${store.availableStock(p, pkg.id)}</b>\n\nKirim <b>satu item per baris</b>. Semua item akan masuk ke paket <b>${ui.escapeHtml(pkg.name)}</b> saja.\n\nContoh:\n<code>email1:password1\nemail2:password2\nemail3:password3</code>`, cancelWizardButtons());
});

bot.action(/^admin:restock:(.+)$/, async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  const p = store.getProduct(c.match[1]);
  if (!p) return ack(c, 'Produk tidak ditemukan', true);
  if (p.deliveryType !== 'stock') return ack(c, 'Produk form/manual tidak membutuhkan restock', true);
  const bs = p.packages.map(x => [`${store.availableStock(p, x.id) > 0 ? '✅' : '❌'} ${x.name} • ${store.availableStock(p, x.id)} stok`, `admin:restock:${p.id}:${x.id}`]);
  return render(c, `📥 <b>Restock ${ui.escapeHtml(p.name)}</b>\n\n<b>Langkah 2/2:</b> Pilih paket/durasi.\nStok yang kamu kirim nanti hanya masuk ke paket yang dipilih.`, bs.concat([['↩️ Produk', `admin:product:${p.id}`], ['🛠️ Admin', 'admin']]));
});

bot.action(/^admin:packages:(.+)$/, async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  const p = store.getProduct(c.match[1]); if (!p) return ack(c, 'Produk tidak ditemukan', true);
  const bs = p.packages.map(x => [`💳 ${x.name} • Rp${ui.money(x.price)}`, `admin:setprice:${p.id}:${x.id}`]);
  return render(c, `💳 <b>Paket & Harga</b>\n\n${ui.escapeHtml(p.name)}\n\nAtur harga > Rp0 agar paket aktif untuk buyer.`, bs.concat([['↩️ Produk', `admin:product:${p.id}`], ['🛠️ Admin', 'admin']]));
});

bot.action(/^admin:setprice:(.+):(.+)$/, async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  const p = store.getProduct(c.match[1]), pkg = store.getPackage(p, c.match[2]); if (!p || !pkg) return ack(c, 'Paket tidak ditemukan', true);
  sessions.set(c.from.id, { step: 'admin_price', productId: p.id, packageId: pkg.id });
  return render(c, `✏️ <b>Ubah Harga</b>\n\n${ui.escapeHtml(p.name)} — ${ui.escapeHtml(pkg.name)}\n\nKirim harga baru, contoh <code>25000</code>.\nKirim <code>0</code> untuk menonaktifkan paket.`, cancelWizardButtons());
});

bot.action(/^admin:editname:(.+)$/, async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  if (!store.getProduct(c.match[1])) return ack(c, 'Produk tidak ditemukan', true);
  sessions.set(c.from.id, { step: 'admin_editname', productId: c.match[1] });
  return render(c, '✏️ <b>Edit Nama Produk</b>\n\nKirim nama baru:', cancelWizardButtons());
});

bot.action(/^admin:delete:(.+)$/, async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  const p = store.getProduct(c.match[1]); if (!p) return ack(c, 'Produk tidak ditemukan', true);
  return render(c, `⚠️ <b>Hapus produk?</b>\n\n${ui.escapeHtml(p.name)}\n📦 Total stok semua paket: ${store.availableStock(p)}\n\nProduk akan dihapus permanen beserta stok yang tersisa.`, [['✅ Ya, Hapus', `admin:deleteconfirm:${p.id}`], ['❌ Batal', `admin:product:${p.id}`]]);
});

bot.action(/^admin:deleteconfirm:(.+)$/, async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  try { const p = store.deleteProduct(c.match[1]); await ack(c, 'Produk dihapus'); return render(c, `✅ Produk <b>${ui.escapeHtml(p.name)}</b> dihapus.`, [['📦 Produk', 'admin:products'], ['🛠️ Admin', 'admin']]); }
  catch (e) { return ack(c, e.message, true); }
});

bot.action('admin:addproduct', async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  sessions.set(c.from.id, { step: 'admin_addproduct_id' });
  return render(c, '➕ <b>Tambah Produk</b>\n\nKita buat produk dari nol.\n\n1️⃣ Kirim <b>ID produk</b> unik, contoh <code>netflix_premium_1</code>.\n\nSemua model, field, paket, harga, dan tipe delivery akan kamu tentukan sendiri.', cancelWizardButtons());
});

bot.action(/^admin:addtype:(stock|form)$/, async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  const s = sessions.get(c.from.id);
  if (!s || s.step !== 'admin_addproduct_type') return ack(c, 'Sesi tambah produk tidak aktif', true);
  s.deliveryType = c.match[1];
  s.step = 'admin_addproduct_description';
  sessions.set(c.from.id, s);
  await ack(c, s.deliveryType === 'stock' ? 'Model stok dipilih' : 'Model form/manual dipilih');
  return render(c, `⚙️ <b>Tipe Produk</b>\n\n✅ ${s.deliveryType === 'stock' ? 'Stok otomatis' : 'Form / aktivasi manual'}\n\nSekarang kirim <b>deskripsi produk</b>.\nKetik <code>-</code> bila tidak ingin deskripsi.`, cancelWizardButtons());
});

bot.action('admin:balance', async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  sessions.set(c.from.id, { step: 'admin_balance_user' });
  return render(c, '💰 <b>Tambah Saldo Manual</b>\n\nKirim <code>USER_ID NOMINAL</code>\nContoh: <code>123456789 50000</code>\n\nGunakan User ID, bukan username.', cancelWizardButtons());
});

bot.action('admin:settings', async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  return render(c, `⚙️ <b>Pengaturan Store</b>\n\n🏪 Nama Store: <b>${ui.escapeHtml(store.getSetting('storeName') || 'Premium Store')}</b>\n👋 Welcome: <b>${store.getSetting('welcomeText') ? '✅' : '❌'}</b>\n🖼️ Banner: ${store.getSetting('bannerFileId') ? '✅' : '❌'}\n💳 QRIS: ${store.getSetting('qrisFileId') ? '✅' : '❌'}\n🏷️ Sticker: ${store.getSetting('depositStickerFileId') ? '✅' : '❌'}\n⏱️ Hapus sticker 5 detik: ${store.getSetting('depositStickerEnabled') ? 'ON' : 'OFF'}\n\nPlaceholder welcome: <code>{name}</code> = nama buyer, <code>{store}</code> = nama store.`, [['🏪 Nama Store', 'admin:setstorename'], ['👋 Welcome', 'admin:setwelcome'], ['🖼️ Set Banner', 'admin:setbanner'], ['💳 Set QRIS', 'admin:setqris'], ['🏷️ Set Sticker', 'admin:setsticker'], ['⏱️ Toggle 5 Detik', 'admin:toggle5s'], ['↩️ Admin', 'admin']]);
});

bot.action('admin:setstorename', async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  sessions.set(c.from.id, { step: 'admin_store_name' });
  return render(c, '🏪 <b>Ubah Nama Store</b>\n\nKirim nama store baru. Nama ini akan tampil di menu buyer dan tidak perlu lagi disimpan di ENV.', cancelWizardButtons());
});

bot.action('admin:setwelcome', async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  sessions.set(c.from.id, { step: 'admin_welcome' });
  return render(c, '👋 <b>Ubah Welcome / Pesan /start</b>\n\nKirim teks welcome baru. Gunakan <code>{name}</code> untuk nama buyer dan <code>{store}</code> untuk nama store.\n\nContoh:\n<code>Selamat datang {name} di {store}!\n\nPilih produk untuk mulai.</code>', cancelWizardButtons());
});

bot.action('admin:setbanner', async c => { if (!adminGuard(c)) return ack(c, 'Akses ditolak', true); sessions.set(c.from.id, { step: 'admin_setbanner' }); return render(c, '🖼️ <b>Set Banner</b>\n\nKirim foto banner. Caption foto akan dipakai sebagai caption banner.', cancelWizardButtons()); });
bot.action('admin:setqris', async c => { if (!adminGuard(c)) return ack(c, 'Akses ditolak', true); sessions.set(c.from.id, { step: 'admin_setqris' }); return render(c, '💳 <b>Set QRIS</b>\n\nKirim foto QRIS. Caption opsional.', cancelWizardButtons()); });
bot.action('admin:setsticker', async c => { if (!adminGuard(c)) return ack(c, 'Akses ditolak', true); sessions.set(c.from.id, { step: 'admin_setsticker' }); return render(c, '🏷️ <b>Set Sticker Deposit</b>\n\nKirim sticker. Sticker akan dihapus otomatis setelah 5 detik bila toggle aktif.', cancelWizardButtons()); });
bot.action('admin:previewwelcome', async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  const preview = ui.homeText(store.getSetting('storeName') || 'Premium Store', c.from.first_name || 'Kak', store.getSetting('welcomeText') || '', false);
  return render(c, `👀 <b>Preview Welcome</b>\n\n${preview}`, [['⚙️ Pengaturan', 'admin:settings'], ['🛠️ Admin', 'admin']]);
});

bot.action('admin:toggle5s', async c => { if (!adminGuard(c)) return ack(c, 'Akses ditolak', true); const v = !store.getSetting('depositStickerEnabled'); store.setSetting('depositStickerEnabled', v); await ack(c, v ? 'ON' : 'OFF'); return render(c, '⚙️ <b>Pengaturan Store</b>\n\nHapus sticker 5 detik: <b>' + (v ? 'ON' : 'OFF') + '</b>', [['🖼️ Set Banner', 'admin:setbanner'], ['💳 Set QRIS', 'admin:setqris'], ['🏷️ Set Sticker', 'admin:setsticker'], ['⏱️ Toggle 5 Detik', 'admin:toggle5s'], ['↩️ Admin', 'admin']]); });

bot.action('admin:deposits', async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  const ds = store.listPendingDeposits().slice(0, 15);
  return render(c, ds.length ? '💳 <b>Deposit Pending</b>\n\nPilih deposit:' : '💳 <b>Deposit Pending</b>\n\nTidak ada deposit pending.', (ds.length ? ds.map(d => [`💳 ${d.id} • Rp${ui.money(d.amount)}`, `admin:deposit:${d.id}`]) : []).concat([['↩️ Admin', 'admin']]));
});

bot.action(/^admin:deposit:(?!approve:|cancel:)([A-Za-z0-9_-]+)$/, async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  const d = store.getDeposit(c.match[1]); if (!d) return ack(c, 'Deposit tidak ditemukan', true);
  return render(c, `💳 <b>Detail Deposit</b>\n\n🆔 <code>${d.id}</code>\n👤 User ID: <code>${d.userId}</code>\n💵 Nominal: <b>Rp${ui.money(d.amount)}</b>\n📌 Status: ${d.status}\n📎 Bukti: ${d.proof ? '✅ Ada' : '❌ Belum ada'}`, [['✅ Approve', `admin:deposit:approve:${d.id}`], ['❌ Cancel', `admin:deposit:cancel:${d.id}`], ['↩️ Pending', 'admin:deposits'], ['🛠️ Admin', 'admin']]);
});

bot.action(/^admin:deposit:approve:(.+)$/, async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  try {
    const d = store.approveDeposit(c.match[1]); await ack(c, 'Deposit disetujui');
    try { await c.telegram.sendMessage(d.userId, `✅ <b>Deposit berhasil</b>\n\nID: <code>${d.id}</code>\nSaldo masuk: <b>Rp${ui.money(d.amount)}</b>\nSaldo sekarang: <b>Rp${ui.money(d.balanceAfter)}</b>`, { parse_mode: 'HTML' }); } catch {}
    return render(c, '✅ <b>Deposit disetujui.</b>', [['💳 Pending', 'admin:deposits'], ['🛠️ Admin', 'admin']]);
  } catch (e) { return ack(c, e.message, true); }
});

bot.action(/^admin:deposit:cancel:(.+)$/, async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  try {
    const d = store.rejectDeposit(c.match[1]); await ack(c, 'Deposit dicancel');
    try { await c.telegram.sendMessage(d.userId, `❌ <b>Deposit dibatalkan</b>\n\nID: <code>${d.id}</code>\nNominal: Rp${ui.money(d.amount)}`, { parse_mode: 'HTML' }); } catch {}
    return render(c, '❌ <b>Deposit dicancel.</b>', [['💳 Pending', 'admin:deposits'], ['🛠️ Admin', 'admin']]);
  } catch (e) { return ack(c, e.message, true); }
});

bot.action('admin:orders', async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  const os = Object.values(store.store.orders || {}).sort((a,b) => b.createdAt - a.createdAt).slice(0, 25);
  const bs = os.map(o => [`${o.status === 'completed' ? '✅' : o.status === 'refunded' || o.status === 'failed' ? '❌' : '🟡'} ${o.receiptId || o.id} • Rp${ui.money(o.price)}`, `admin:receipt:${o.id}`]);
  return render(c, '🧾 <b>Order Terbaru</b>\n\nPilih order untuk melihat resi dan seluruh log proses.', bs.concat([['🛠️ Admin', 'admin']]));
});

bot.action(/^admin:receipt:(.+)$/, async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  const o = store.getOrder(c.match[1]);
  if (!o) return ack(c, 'Order tidak ditemukan', true);
  const p = store.getProduct(o.productId);
  const pkg = store.getPackage(p, o.packageId);
  return render(c, orderReceiptText(o, p, pkg), [['🔄 Refresh Resi', `admin:receipt:${o.id}`], ['↩️ Order', 'admin:orders'], ['🛠️ Admin', 'admin']]);
});

bot.action('admin:stats', async c => {
  if (!adminGuard(c)) return ack(c, 'Akses ditolak', true);
  const s = store.stats();
  return render(c, `📊 <b>Statistik</b>\n\n👤 User: ${s.users}\n📦 Produk: ${s.products}\n✅ Produk configured: ${s.configuredProducts}\n🧾 Order: ${s.orders}\n✅ Sukses: ${s.completed}\n💰 Omzet: Rp${ui.money(s.revenue)}\n💳 Deposit pending: ${s.pendingDeposits}`, [['🛠️ Admin', 'admin']]);
});

bot.action('admin:broadcast', async c => { if (!adminGuard(c)) return ack(c, 'Akses ditolak', true); sessions.set(c.from.id, { step: 'admin_broadcast' }); return render(c, '📤 <b>Broadcast</b>\n\nKirim pesan yang akan dikirim ke semua user yang terdaftar.', cancelWizardButtons()); });

// MEDIA HANDLERS
bot.on('photo', async c => {
  const s = sessions.get(c.from.id); if (!s) return;
  const photo = c.message.photo?.at(-1); if (!photo) return;
  if (isStaff(c.from.id) && s.step === 'admin_setbanner') {
    store.setSetting('bannerFileId', photo.file_id); store.setSetting('bannerCaption', c.message.caption || ''); sessions.delete(c.from.id);
    return c.reply('✅ Banner berhasil disimpan.', kb([['⚙️ Pengaturan', 'admin:settings'], ['🛠️ Admin', 'admin']]));
  }
  if (isStaff(c.from.id) && s.step === 'admin_setqris') {
    store.setSetting('qrisFileId', photo.file_id); store.setSetting('qrisCaption', c.message.caption || ''); sessions.delete(c.from.id);
    return c.reply('✅ QRIS deposit berhasil disimpan.', kb([['⚙️ Pengaturan', 'admin:settings'], ['🛠️ Admin', 'admin']]));
  }
  if (s.step === 'deposit_proof' && !isOwner(c.from.id)) {
    const d = store.getDeposit(s.depositId); if (!d || d.status !== 'pending') { sessions.delete(c.from.id); return c.reply('⚠️ Deposit sudah tidak aktif.'); }
    try { store.setDepositProof(d.id, { type: 'photo', fileId: photo.file_id, caption: c.message.caption || '' }); } catch (e) { return c.reply(`⚠️ ${e.message}`); }
    sessions.delete(c.from.id);
    let notified = 0;
    for (const oid of new Set([...OWNER_IDS, ...store.listAdmins()])) {
      try {
        await c.telegram.sendPhoto(oid, photo.file_id, { caption: `💳 <b>Deposit Pending</b>\n\n🆔 ID: <code>${d.id}</code>\n👤 User ID: <code>${d.userId}</code>\n💵 Nominal: <b>Rp${ui.money(d.amount)}</b>`, parse_mode: 'HTML', ...kb([['✅ Approve', `admin:deposit:approve:${d.id}`], ['❌ Cancel', `admin:deposit:cancel:${d.id}`]]) });
        notified++;
      } catch (e) { console.error('[DEPOSIT NOTIFY]', e.message); }
    }
    return c.reply(`✅ Bukti diterima. Deposit <code>${d.id}</code> menunggu verifikasi admin.`, { parse_mode: 'HTML', ...kb([['💰 Saldo', 'wallet'], ['👋 Home', 'home']]) });
  }
});

bot.on('sticker', async c => {
  const s = sessions.get(c.from.id); if (!s || !isStaff(c.from.id) || s.step !== 'admin_setsticker') return;
  store.setSetting('depositStickerFileId', c.message.sticker.file_id); sessions.delete(c.from.id);
  return c.reply('✅ Sticker deposit tersimpan. Sticker akan dihapus otomatis setelah 5 detik jika toggle aktif.', kb([['⚙️ Pengaturan', 'admin:settings'], ['🛠️ Admin', 'admin']]));
});

async function notifyStockEmpty(telegram, product, pkg = null) {
  if (!product || product.deliveryType !== 'stock' || !pkg) return;
  if (store.availableStock(product, pkg.id) !== 0 || pkg.stockAlerted) return;
  pkg.stockAlerted = true;
  store.save();
  for (const oid of new Set([...OWNER_IDS, ...store.listAdmins()])) {
    try {
      await telegram.sendMessage(oid, `🔴 <b>STOK HABIS</b>\n\n📦 ${ui.escapeHtml(product.name)}\n⏱️ Paket: <b>${ui.escapeHtml(pkg.name)}</b>\n🆔 <code>${product.id}</code>\n\nSilakan restock paket ini dari Admin Panel.`, { parse_mode: 'HTML', ...kb([['📥 Restock Paket Ini', `admin:restock:${product.id}:${pkg.id}`], ['👀 Cek Stok', `admin:stock:${product.id}:${pkg.id}`], ['🛠️ Admin', 'admin']]) });
    } catch {}
  }
}

bot.command('admin', async c => { if (!isStaff(c.from.id)) return c.reply('❌ Akses ditolak.'); return c.reply('🛠️ <b>ADMIN PANEL</b>', { parse_mode: 'HTML', ...kb(adminKb(c.from.id)) }); });
bot.command('saldo', c => {
  if (!isOwner(c.from.id)) return c.reply('❌ Akses ditolak.');
  const p = c.message.text.split(/\s+/); if (p.length < 3) return c.reply('Format: /saldo USER_ID JUMLAH');
  try { const u = store.credit(Number(p[1]), Number(p[2])); return c.reply(`✅ Saldo <code>${u.id}</code> = Rp${ui.money(u.balance)}`, { parse_mode: 'HTML' }); }
  catch (e) { return c.reply('❌ ' + e.message); }
});

const recovered = store.recoverProcessingOrders();
if (recovered) console.log(`♻️ Recovered ${recovered} stuck processing order(s).`);
bot.catch(e => console.error('[BOT ERROR]', e));
bot.launch().then(() => console.log('✅ Premium Store bot running')).catch(e => { console.error(e); process.exit(1); });
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
