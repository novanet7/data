const { availableStock, productAvailability } = require('./store');
const BTN_PER_ROW = 3;
function chunks(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
function normalizeButton(x) {
  if (Array.isArray(x)) return { text: String(x[0] ?? ''), callback_data: String(x[1] ?? '') };
  if (x && typeof x === 'object') return { text: String(x.text ?? ''), callback_data: String(x.callback_data ?? x.data ?? '') };
  return { text: String(x ?? ''), callback_data: String(x ?? '') };
}
function rows(buttons) {
  return chunks((buttons || []).map(normalizeButton), BTN_PER_ROW)
    .map(row => row.filter(btn => btn.text && btn.callback_data))
    .filter(row => row.length > 0);
}
function money(n) { return new Intl.NumberFormat('id-ID').format(Number(n) || 0); }
function escapeHtml(s = '') { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function homeText(storeName = 'Premium Store', name = 'Kak', welcome = '', isAdmin = false) {
  const template = welcome || 'Halo {name}!\n\n📦 Produk tersedia\n⚡ Proses otomatis\n🔔 Notifikasi langsung';
  const body = String(template).replaceAll('{name}', escapeHtml(name)).replaceAll('{store}', escapeHtml(storeName));
  return `🛍️ <b>${escapeHtml(storeName)}</b>\n\n${body}${isAdmin ? '\n🛠️ Mode admin aktif' : ''}`;
}
function productText(p) {
  const a = productAvailability(p);
  const stock = p.deliveryType === 'stock' ? `\n📦 Stok: <b>${availableStock(p)}</b>` : '\n⚙️ Model: <b>Form / Aktivasi</b>';
  const model = p.model ? `\n⚙️ Model: <b>${escapeHtml(p.model)}</b>` : '';
  return `${p.emoji || '📦'} <b>${escapeHtml(p.name)}</b>\n\n${escapeHtml(p.description || '')}${model}${stock}\n📌 Status: <b>${a.available ? '✅ Siap dipesan' : `❌ ${escapeHtml(a.reason)}`}</b>\n\nPilih paket:`;
}
module.exports = { rows, money, homeText, productText, escapeHtml };
