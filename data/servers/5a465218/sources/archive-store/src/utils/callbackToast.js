'use strict';

/**
 * Human-friendly Telegram callback toast. Keep these short because Telegram
 * displays them as a small notification at the top of the chat.
 */
function callbackToast(data) {
  const s = String(data || '');

  let m;
  if ((m = s.match(/^owner:idprice:prefix:([1-8])$/))) return `🆔 ID ${m[1]} dipilih`;
  if ((m = s.match(/^owner:idprice:digit:[1-8]:(8|9|10)$/))) return `🔢 ${m[1]}D dipilih`;
  if ((m = s.match(/^owner:seller_price:prefix:([1-8])$/))) return `🆔 ID ${m[1]} dipilih`;
  if ((m = s.match(/^owner:seller_price:digit:[1-8]:(8|9|10)$/))) return `🔢 ${m[1]}D dipilih`;
  if ((m = s.match(/^shop:idprefix:([1-8])$/))) return `🆔 ID ${m[1]} dipilih`;
  if ((m = s.match(/^qty:(plus|minus):/))) return m[1] === 'plus' ? '➕ Jumlah ditambah' : '➖ Jumlah dikurangi';

  const exact = {
    'shop:start': '🛍️ Membuka toko...',
    'shop:cat:telegram': '📱 Membuka produk Telegram...',
    'shop:manual_products': '📦 Membuka produk manual...',
    'shop:my_orders': '🧾 Membuka pesanan kamu...',
    'shop:cancel_order': '↩️ Membatalkan pesanan...',
    'buyer:wallet': '💰 Membuka saldo...',
    'buyer:topup': '💳 Membuka Top Up...',
    'topup:cancel': '↩️ Kembali ke saldo...',
    'owner:id_pricelist': '💰 Membuka Pricelist ID...',
    'owner:seller_settings': '💼 Membuka pengaturan Seller...',
    'owner:seller_price_menu': '💰 Membuka harga Seller...',
    'owner:seller_toggle': '⚙️ Mengubah status setor...',
    'owner:payment_settings': '💳 Membuka pembayaran...',
    'owner:manual_balance': '💰 Membuka saldo manual...',
    'owner:withdrawals': '🏦 Membuka penarikan...',
    'owner:withdrawal_history': '📜 Membuka riwayat penarikan...',
    'owner:seller_balance_history': '📊 Membuka riwayat saldo Seller...',
    'owner:products': '📦 Membuka produk...',
    'owner:restock': '📥 Membuka Restock Telegram...',
    'owner:seller': '💼 Membuka Seller Marketplace...',
    'noop': '❌ Stok sedang kosong',
  };
  if (exact[s]) return exact[s];

  if (s.startsWith('topup:method:')) return '💳 Metode pembayaran dipilih';
  if (s.startsWith('topup:')) return '💳 Top Up diproses...';
  if (s.startsWith('pay:')) return '💳 Pembayaran diproses...';
  if (s.startsWith('withdraw:')) return '🏦 Penarikan diproses...';
  if (s.startsWith('seller:')) return '💼 Seller diproses...';
  if (s.startsWith('restock:') || s.startsWith('session:')) return '📥 Restock diproses...';
  if (s.startsWith('owner:product')) return '📦 Produk diproses...';
  if (s.startsWith('ptype:')) return '🏷️ Tipe produk dipilih';
  if (s.startsWith('confirm:')) return '⚠️ Konfirmasi diproses...';
  if (s.startsWith('admin:')) return '🛠️ Pengaturan admin diproses...';

  return '✅ Diproses';
}

module.exports = callbackToast;
