'use strict';

const { Markup } = require('telegraf');

const ownerKeyboard = {
  mainMenu: () => Markup.inlineKeyboard([
    [
      Markup.button.callback('📱 Produk Telegram', 'owner:product_list'),
      Markup.button.callback('📦 Restock Telegram', 'owner:restock'),
    ],
    [
      Markup.button.callback('➕ Tambah Produk', 'owner:add_product'),
      Markup.button.callback('💳 Pembayaran', 'owner:payment_settings'),
    ],
    [Markup.button.callback('👤 Seller Marketplace', 'owner:seller_settings')],
    [Markup.button.callback('💸 Penarikan Seller', 'owner:seller_withdrawals')],
    [Markup.button.callback('🆔 Pricelist ID', 'owner:id_pricelist')],
    [Markup.button.callback('💵 Tambah Saldo Buyer', 'owner:manual_balance'), Markup.button.callback('📋 Riwayat Saldo', 'owner:manual_balance_history')],
    [Markup.button.callback('🔎 Lacak Pesanan', 'owner:order_tracking')],
    [Markup.button.callback('👋 Welcome', 'owner:welcome'), Markup.button.callback('💾 Backup & Recovery', 'owner:backup')],
    [Markup.button.callback('🎨 Set Emoji', 'owner:custom_emoji'), Markup.button.callback('🖼️ Banner', 'owner:banner')],
    [Markup.button.callback('🌟 Telegram Premium', 'owner:telepremium')],
    [Markup.button.callback('📢 Broadcast', 'owner:broadcast')],
    [Markup.button.callback('🔄 Refresh', 'owner:refresh')],
  ]),

  productTypeSelect: () => Markup.inlineKeyboard([
    [Markup.button.callback('📱 Akun Telegram', 'ptype:telegram_session')],
    [Markup.button.callback('🚫 Batal', 'owner:cancel')],
  ]),

  productSelectMenu: (products, action) => Markup.inlineKeyboard([
    ...products.map(p => [{ text: p.name, callback_data: `${action}:${p._id}` }]),
    [{ text: '⬅️ Kembali', callback_data: 'owner:back_main' }],
  ]),

  productActions: (productId) => Markup.inlineKeyboard([
    [
      Markup.button.callback('📦 Restock', `owner:restock_product:${productId}`),
      Markup.button.callback('✏️ Rename', `owner:rename:${productId}`),
    ],
    [
      Markup.button.callback('🗑️ Hapus', `owner:delete:${productId}`),
      Markup.button.callback('🔄 Toggle Status', `owner:toggle:${productId}`),
    ],
    [Markup.button.callback('⬅️ Kembali', 'owner:product_list')],
  ]),

  // Buyer inventory uses ID buckets. Admin restock itself does not ask the
  // admin to choose a bucket; the bot detects the real Telegram ID after login.
  restockCategoryMenu: () => Markup.inlineKeyboard([
    [1, 2, 3].map(n => Markup.button.callback(`🆔 ID ${n}`, `restock:id:${n}`)),
    [4, 5, 6].map(n => Markup.button.callback(`🆔 ID ${n}`, `restock:id:${n}`)),
    [7, 8].map(n => Markup.button.callback(`🆔 ID ${n}`, `restock:id:${n}`)),
    [Markup.button.callback('⬅️ Kembali', 'owner:back_main')],
  ]),

  restockIdDigitMenu: (prefix, buckets = []) => {
    const configured = new Map(buckets.map(b => [Number(b.digitLength), b]));
    const digits = [8, 9, 10];
    return Markup.inlineKeyboard([
      digits.map(d => {
        const b = configured.get(d);
        const price = Number(b?.price || 0);
        const stock = Number(b?.stockCount || 0);
        return Markup.button.callback(
          `🔢 ${d}D — ${price > 0 ? formatPrice(price) : 'Belum diset'} (${stock})`,
          `restock:id:${prefix}:${d}`
        );
      }),
      [Markup.button.callback('⬅️ Kembali', 'owner:restock')],
    ]);
  },

  restockMenu: (productId) => Markup.inlineKeyboard([
    [Markup.button.callback('🔐 Login Session Telegram', `session:login_tg:${productId}`)],
    [Markup.button.callback('⬅️ Kembali', `owner:view_product:${productId}`)],
  ]),

  idPricingPrefixMenu: () => Markup.inlineKeyboard([
    [1, 2, 3].map(n => Markup.button.callback(`🆔 ID ${n}`, `owner:idprice:prefix:${n}`)),
    [4, 5, 6].map(n => Markup.button.callback(`🆔 ID ${n}`, `owner:idprice:prefix:${n}`)),
    [7, 8].map(n => Markup.button.callback(`🆔 ID ${n}`, `owner:idprice:prefix:${n}`)),
    [Markup.button.callback('⬅️ Kembali', 'owner:back_main')],
  ]),

  idPricingDigitMenu: (prefix, prices) => {
    const digits = [8, 9, 10];
    const rows = [];
    for (const d of digits) {
      const fsPrice = Number(prices?.fs?.[String(d)] ?? prices?.[String(d)] ?? 0);
      const nfsPrice = Number(prices?.nfs?.[String(d)] || 0);
      rows.push([
        Markup.button.callback(`🔢 ${d}D FS — ${fsPrice > 0 ? formatPrice(fsPrice) : 'Belum diset'}`, `owner:idprice:status:${prefix}:${d}:fs`),
        Markup.button.callback(`${d}D NFS — ${nfsPrice > 0 ? formatPrice(nfsPrice) : 'Belum diset'}`, `owner:idprice:status:${prefix}:${d}:nfs`)
      ]);
    }
    rows.push([Markup.button.callback('⬅️ Kembali', 'owner:id_pricelist')]);
    return Markup.inlineKeyboard(rows);
  },

  bannerMenu: (active = false) => Markup.inlineKeyboard([
    [Markup.button.callback('📤 Set / Ganti Banner', 'owner:banner:set')],
    ...(active ? [[Markup.button.callback('🗑️ Hapus Banner', 'owner:banner:delete')]] : []),
    [Markup.button.callback('⬅️ Kembali', 'owner:back_main')],
  ]),

  welcomeMenu: (active = false) => Markup.inlineKeyboard([
    [Markup.button.callback(' Atur Sticker Welcome', 'owner:welcome:set_sticker')],
    ...(active ? [[Markup.button.callback('🗑️ Hapus Sticker Welcome', 'owner:welcome:delete_sticker')]] : []),
    [Markup.button.callback('⬅️ Kembali', 'owner:back_main')],
  ]),



  telePremiumSettings: (cfg = {}) => Markup.inlineKeyboard([
    [Markup.button.callback(`🌟 1 Bulan — ${cfg.prices?.[1] > 0 ? formatPrice(cfg.prices[1]) : 'Belum diset'}`, 'owner:telepremium:price:1')],
    [Markup.button.callback(`🌟 3 Bulan — ${cfg.prices?.[3] > 0 ? formatPrice(cfg.prices[3]) : 'Belum diset'}`, 'owner:telepremium:price:3')],
    [Markup.button.callback(`🌟 6 Bulan — ${cfg.prices?.[6] > 0 ? formatPrice(cfg.prices[6]) : 'Belum diset'}`, 'owner:telepremium:price:6')],
    [Markup.button.callback(`🌟 12 Bulan — ${cfg.prices?.[12] > 0 ? formatPrice(cfg.prices[12]) : 'Belum diset'}`, 'owner:telepremium:price:12')],
    [Markup.button.callback(cfg.enabled ? '🔴 Tutup Telegram Premium' : '🟢 Buka Telegram Premium', 'owner:telepremium:toggle')],
    [Markup.button.callback('⬅️ Kembali', 'owner:back_main')],
  ]),

  paymentSettingsMenu: (cfg = {}) => Markup.inlineKeyboard([
    [Markup.button.callback(`📷 QRIS Manual ${cfg.qris?.enabled ? '🟢 ON' : '⚪ OFF'}`, 'pay:qris')],
    [Markup.button.callback(`🌐 Valqenix Gateway ${cfg.valqenix?.enabled ? '🟢 ON' : '⚪ OFF'}`, 'pay:valqenix')],
    [Markup.button.callback(`🔄 Manual + Gateway${cfg.qris?.enabled && cfg.valqenix?.enabled ? ' (ON)' : ' (OFF)'}`, 'pay:toggle_both')],
    [Markup.button.callback('⬅️ Kembali', 'owner:back_main')],
  ]),

  qrisSettingsMenu: (cfg = {}) => Markup.inlineKeyboard([
    [Markup.button.callback(cfg?.imageUrl ? '🖼️ Ganti Foto QRIS' : '📤 Tambahkan Foto QRIS', 'pay:qris:set_photo')],
    ...(cfg?.imageUrl ? [[Markup.button.callback(`${cfg?.enabled ? '🟢 Matikan QRIS' : '🟢 Nyalakan QRIS'}`, 'pay:qris:toggle')]] : []),
    [Markup.button.callback('⬅️ Kembali', 'owner:payment_settings')],
  ]),

  confirmAction: (action, id) => Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Konfirmasi', `confirm:${action}:${id}`),
      Markup.button.callback('🚫 Batal', 'owner:cancel'),
    ],
  ]),

  backButton: (action = 'owner:back_main') => Markup.inlineKeyboard([
    [Markup.button.callback('⬅️ Kembali', action)],
  ]),

  cancelButton: () => Markup.inlineKeyboard([
    [Markup.button.callback('🚫 Batal', 'owner:cancel')],
  ]),
};

function formatPrice(n) { return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(n || 0); }

module.exports = ownerKeyboard;
