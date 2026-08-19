'use strict';

const { Markup } = require('telegraf');

const buyerKeyboard = {
  mainShop: () => Markup.inlineKeyboard([
    [Markup.button.callback('📱 Akun Telegram', 'shop:cat:telegram')],
    [
      Markup.button.callback('💰 Deposit', 'buyer:topup'),
      Markup.button.callback('💵 Saldo', 'buyer:wallet'),
    ],
    [
      Markup.button.callback('📋 Pesananku', 'shop:my_orders'),
      Markup.button.callback('👤 Jadi Seller', 'seller:start'),
    ],
    [Markup.button.callback('🌟 Telegram Premium', 'buyer:telepremium')],
  ]),

  idPrefixMenu: (stockMap) => Markup.inlineKeyboard([
    [
      Markup.button.callback(`${stockMap['1'] > 0 ? '✅' : '❌'} ID 1 (${Number(stockMap['1'] || 0)})`, 'shop:idprefix:1'),
      Markup.button.callback(`${stockMap['2'] > 0 ? '✅' : '❌'} ID 2 (${Number(stockMap['2'] || 0)})`, 'shop:idprefix:2'),
      Markup.button.callback(`${stockMap['3'] > 0 ? '✅' : '❌'} ID 3 (${Number(stockMap['3'] || 0)})`, 'shop:idprefix:3'),
    ],
    [
      Markup.button.callback(`${stockMap['4'] > 0 ? '✅' : '❌'} ID 4 (${Number(stockMap['4'] || 0)})`, 'shop:idprefix:4'),
      Markup.button.callback(`${stockMap['5'] > 0 ? '✅' : '❌'} ID 5 (${Number(stockMap['5'] || 0)})`, 'shop:idprefix:5'),
      Markup.button.callback(`${stockMap['6'] > 0 ? '✅' : '❌'} ID 6 (${Number(stockMap['6'] || 0)})`, 'shop:idprefix:6'),
    ],
    [
      Markup.button.callback(`${stockMap['7'] > 0 ? '✅' : '❌'} ID 7 (${Number(stockMap['7'] || 0)})`, 'shop:idprefix:7'),
      Markup.button.callback(`${stockMap['8'] > 0 ? '✅' : '❌'} ID 8 (${Number(stockMap['8'] || 0)})`, 'shop:idprefix:8'),
    ],
    [Markup.button.callback('📦 Produk Lain', 'shop:manual_products')],
    [Markup.button.callback('⬅️ Kembali', 'shop:start')],
  ]),

  idDigitMenu: (prefix, buckets) => Markup.inlineKeyboard([
    ...buckets.map(b => [Markup.button.callback(
      `🔢 ${b.digitLength} Digit (${b.stockCount}) — ${formatPrice(b.price)}`,
      b.product ? `shop:ids:${prefix}:${b.digitLength}` : 'noop'
    )]),
    [Markup.button.callback('⬅️ Kembali', 'shop:cat:telegram')],
  ]),

  stockSessionList: (sessions, pageInfo = null) => {
    const rows = sessions.map((s, index) => [Markup.button.callback(
      `🛒 Beli #${index + 1} — ${s.telegramId}`,
      `shop:sessionbuy:${s.callbackToken}`
    )]);

    if (pageInfo && Number(pageInfo.totalPages || 1) > 1) {
      const page = Number(pageInfo.page || 1);
      const totalPages = Number(pageInfo.totalPages || 1);
      const nav = [];
      if (page > 1) nav.push(Markup.button.callback('⬅️ Sebelumnya', `shop:idpage:${pageInfo.prefix}:${page - 1}`));
      if (page < totalPages) nav.push(Markup.button.callback('➡ Berikutnya', `shop:idpage:${pageInfo.prefix}:${page + 1}`));
      if (nav.length) rows.push(nav);
    }

    rows.push([Markup.button.callback('⬅️ Kembali', 'shop:cat:telegram')]);
    return Markup.inlineKeyboard(rows);
  },

  productListInCategory: (products) => Markup.inlineKeyboard([
    ...products.map(p => [Markup.button.callback(
      `📦 ${p.name} — ${formatPrice(p.price)}`,
      `shop:product:${p._id}`
    )]),
    [Markup.button.callback('⬅️ Kembali', 'shop:start')],
  ]),

  quantitySelector: (productId, currentQty, maxQty, price) => {
    const row = [];
    if (currentQty > 1) row.push(Markup.button.callback('➖', `qty:minus:${productId}`));
    row.push(Markup.button.callback(`🔢 ${currentQty} slot`, 'noop'));
    if (currentQty < maxQty) row.push(Markup.button.callback('➕', `qty:plus:${productId}`));

    return Markup.inlineKeyboard([
      row,
      [Markup.button.callback(`🛒 Beli — ${formatPrice(price * currentQty)}`, `shop:checkout:${productId}:${currentQty}`)],
      [Markup.button.callback('⬅️ Kembali', 'shop:cat:telegram')],
    ]);
  },

  paymentMethodSelect: (methods) => Markup.inlineKeyboard([
    ...methods.map(m => [Markup.button.callback(`💳 ${m.label}`, `pay:method:${m.type}`)]),
    [Markup.button.callback('🚫 Batalkan', 'shop:cancel_order')],
  ]),

  orderStatus: (orderId) => Markup.inlineKeyboard([
    [Markup.button.callback('📊 Cek Status', `order:status:${orderId}`)],
    [Markup.button.callback('📋 Kembali ke Riwayat', 'shop:my_orders')],
  ]),

  orderHistory: (orders) => Markup.inlineKeyboard([
    ...orders.map(order => [
      Markup.button.callback(`🔎 Lacak ${order.orderId}`, `order:status:${order.orderId}`)
    ]),
    [Markup.button.callback('🏪 Menu Utama', 'shop:start')],
  ]),

  qrisPayment: (orderId) => Markup.inlineKeyboard([
    [Markup.button.callback('📤 Kirim Bukti Bayar', `pay:upload_proof:${orderId}`)],
    [Markup.button.callback('🚫 Batalkan', 'shop:cancel_order')],
  ]),

  backToShop: () => Markup.inlineKeyboard([
    [Markup.button.callback('🏪 Kembali ke Toko', 'shop:start')],
  ]),

  telePremiumMenu: (prices = {}) => Markup.inlineKeyboard([
    [Markup.button.callback(`🌟 1 Bulan (Login) — ${prices?.[1] > 0 ? formatPrice(prices[1]) : 'Belum diset'}`, 'telepremium:buy:1')],
    [Markup.button.callback(`🌟 3 Bulan (Gift) — ${prices?.[3] > 0 ? formatPrice(prices[3]) : 'Belum diset'}`, 'telepremium:buy:3')],
    [Markup.button.callback(`🌟 6 Bulan (Gift) — ${prices?.[6] > 0 ? formatPrice(prices[6]) : 'Belum diset'}`, 'telepremium:buy:6')],
    [Markup.button.callback(`🌟 12 Bulan (Gift) — ${prices?.[12] > 0 ? formatPrice(prices[12]) : 'Belum diset'}`, 'telepremium:buy:12')],
    [Markup.button.callback('⬅️ Kembali', 'shop:start')],
  ]),

  telePremiumCancel: () => Markup.inlineKeyboard([
    [Markup.button.callback('🚫 Batalkan', 'telepremium:cancel_input')],
  ]),

  telePremiumAdminActions: (orderId, status = 'pending') => {
    const rows = [];
    if (status === 'pending') rows.push([Markup.button.callback('✅ Sudah Selesai', `owner:telepremium:done:${orderId}`), Markup.button.callback('🔄 Lagi di Proses', `owner:telepremium:processing:${orderId}`)]);
    if (status === 'processing') rows.push([Markup.button.callback('✅ Sudah Selesai', `owner:telepremium:done:${orderId}`)]);
    if (status === 'pending' || status === 'processing') rows.push([Markup.button.callback('❌ Cancel', `owner:telepremium:cancel:${orderId}`)]);
    return Markup.inlineKeyboard(rows);
  },


  cancelButton: () => Markup.inlineKeyboard([
    [Markup.button.callback('🚫 Batalkan', 'shop:cancel_order')],
  ]),

  purchaseConfirm: (productId, quantity, total, checkoutToken) => Markup.inlineKeyboard([
    [Markup.button.callback(`✅ Konfirmasi Beli — ${formatPrice(total)}`, `shop:confirm_checkout:${String(checkoutToken || '')}`)],
    [Markup.button.callback('💰 Cek Saldo Lagi', 'buyer:wallet'), Markup.button.callback('💳 Deposit / Top Up', 'buyer:topup')],
    [Markup.button.callback('⬅️ Kembali', `shop:product:${productId}`)],
  ]),

  walletMenu: () => Markup.inlineKeyboard([
    [Markup.button.callback('💳 Deposit / Top Up', 'buyer:topup')],
    [Markup.button.callback('💰 Cek Saldo Lagi', 'buyer:wallet')],
    [Markup.button.callback('🏪 Kembali ke Toko', 'shop:start')],
  ]),

  loginCompleteMenu: (orderId) => Markup.inlineKeyboard([
    [Markup.button.callback('✅ Login Berhasil', `session:confirm_login:${orderId}`)],
    [Markup.button.callback('🗑️ Hapus Perangkat Bot', `session:buyer_logout:${orderId}`)],
  ]),

  getOtpMenu: (orderId, phone) => Markup.inlineKeyboard([
    [Markup.button.callback(
      '🔐 Dapatkan OTP Sekarang',
      `session:get_otp:${String(orderId)}`
    )],
    [Markup.button.callback('🚫 Batalkan', `session:cancel_otp:${orderId}`)],
  ]),

  // Saat monitoring OTP aktif tidak ada tombol apa pun.
  otpActiveMenu: () => undefined,

  // Setelah OTP masuk hanya tersedia tombol untuk mengeluarkan perangkat bot.
  otpReadyMenu: (orderId) => Markup.inlineKeyboard([
    [Markup.button.callback('🗑️ Hapus Perangkat Bot', `session:buyer_logout:${orderId}`)],
  ]),

  logoutSessionMenu: (orderId) => Markup.inlineKeyboard([
    [Markup.button.callback('🗑️ Hapus Perangkat Bot', `session:buyer_logout:${orderId}`)],
    [Markup.button.callback('🏪 Menu Utama', 'shop:start')],
  ]),
};


function formatPrice(amount) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
  }).format(amount);
}

module.exports = buyerKeyboard;
