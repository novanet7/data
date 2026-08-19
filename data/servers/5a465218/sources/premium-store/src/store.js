const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');

const DATA = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA, 'store.json');
const PRODUCTS_FILE = path.join(DATA, 'products.json');
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const DEFAULT_SETTINGS = {
  storeName: 'Premium Store',
  welcomeText: 'Halo {name}!\n\n📦 Produk tersedia\n⚡ Proses otomatis\n🔔 Notifikasi langsung',
  currency: 'IDR',
  bannerFileId: null,
  bannerCaption: '',
  qrisFileId: null,
  qrisCaption: '',
  depositStickerFileId: null,
  depositStickerEnabled: true,
  minDeposit: 1000,
  adminIds: []
};

let store = readJson(STORE_FILE, { users: {}, orders: {}, deposits: {}, settings: {} });
store.users ||= {};
store.orders ||= {};
store.deposits ||= {};
store.settings ||= {};
Object.assign(store.settings, DEFAULT_SETTINGS, store.settings);
if (!Array.isArray(store.settings.adminIds)) store.settings.adminIds = [];
store.settings.adminIds = store.settings.adminIds.map(Number).filter(Number.isFinite);


let products = readJson(PRODUCTS_FILE, []);
if (!Array.isArray(products)) products = [];

function normalizeStockArray(arr) {
  return (Array.isArray(arr) ? arr : []).map((x, i) => {
    if (typeof x === 'string') return { id: `legacy_${i}_${Date.now()}`, value: x, addedAt: Date.now() };
    return { id: String(x.id || uuid().slice(0, 12)), value: String(x.value ?? ''), addedAt: x.addedAt || Date.now() };
  }).filter(x => x.value !== '');
}

function normalizeProduct(p) {
  p.id = String(p.id || '').trim();
  p.name = String(p.name || p.id || 'Produk');
  p.emoji = p.emoji || '📦';
  p.description = p.description || '';
  p.model = String(p.model || (p.deliveryType === 'form' ? 'Form / Manual' : 'Stok Akun'));
  p.deliveryType = p.deliveryType === 'form' ? 'form' : 'stock';
  p.fields = Array.isArray(p.fields) ? p.fields : [];
  p.packages = Array.isArray(p.packages) ? p.packages : [];
  p.packages = p.packages.map((x, i) => ({
    id: String(x.id || `pkg_${i + 1}`),
    name: String(x.name || `Paket ${i + 1}`),
    price: Math.max(0, Number(x.price) || 0),
    stock: normalizeStockArray(x.stock),
    stockAlerted: Boolean(x.stockAlerted)
  }));

  // Migrate the old product-level stock into the first package so older stores keep working.
  if (p.deliveryType === 'stock' && Array.isArray(p.stock) && p.stock.length) {
    if (!p.packages.length) {
      p.packages.push({ id: 'default', name: 'Default', price: 0, stock: [], stockAlerted: false });
    }
    const migrated = normalizeStockArray(p.stock);
    const target = p.packages[0];
    const existingIds = new Set(target.stock.map(x => String(x.id)));
    for (const item of migrated) if (!existingIds.has(String(item.id))) target.stock.push(item);
  }
  p.stock = []; // stock now belongs to each package
  p.stockAlerted = false;
  return p;
}

products = products.map(normalizeProduct).filter(p => p.id);

function save() {
  writeJson(STORE_FILE, store);
  writeJson(PRODUCTS_FILE, products);
}

function user(id, extra = {}) {
  const n = Number(id);
  if (!Number.isFinite(n)) throw Error('User ID tidak valid');
  const key = String(n);
  if (!store.users[key]) {
    store.users[key] = { id: n, balance: 0, createdAt: Date.now() };
  }
  if (extra.firstName !== undefined) store.users[key].firstName = extra.firstName;
  if (extra.username !== undefined) store.users[key].username = extra.username;
  save();
  return store.users[key];
}

function getProduct(id) { return products.find(p => p.id === String(id)); }
function getPackage(product, pkgId) { return product?.packages?.find(x => x.id === String(pkgId)); }
function availableStock(product, packageId = null) {
  if (!product) return 0;
  if (packageId) {
    const pkg = getPackage(product, packageId);
    return Array.isArray(pkg?.stock) ? pkg.stock.length : 0;
  }
  return Array.isArray(product?.packages) ? product.packages.reduce((sum, pkg) => sum + (Array.isArray(pkg.stock) ? pkg.stock.length : 0), 0) : 0;
}

function productConfigured(product) {
  return Boolean(product?.name) && Array.isArray(product?.packages) && product.packages.some(p => Number(p.price) > 0);
}

function productAvailability(product, packageId = null) {
  if (!product) return { available: false, reason: 'Produk tidak ditemukan' };
  if (!productConfigured(product)) return { available: false, reason: 'Belum diset admin' };
  const pkg = packageId ? getPackage(product, packageId) : null;
  if (packageId && !pkg) return { available: false, reason: 'Paket tidak ditemukan' };
  if (pkg && Number(pkg.price) <= 0) return { available: false, reason: 'Harga belum diset' };
  if (product.deliveryType === 'stock') {
    if (pkg) {
      if (availableStock(product, pkg.id) < 1) return { available: false, reason: 'Stok habis' };
    } else if (!product.packages.some(x => Number(x.price) > 0 && availableStock(product, x.id) > 0)) {
      return { available: false, reason: 'Semua stok habis' };
    }
  }
  return { available: true, reason: '' };
}

function addStock(productId, packageId, values) {
  const p = getProduct(productId);
  if (!p) throw Error('Produk tidak ditemukan');
  if (p.deliveryType !== 'stock') throw Error('Produk ini menggunakan form/manual, tidak membutuhkan stok');
  const pkg = getPackage(p, packageId);
  if (!pkg) throw Error('Paket tidak ditemukan');
  if (!Array.isArray(pkg.stock)) pkg.stock = [];
  let added = 0;
  for (const raw of values || []) {
    const value = String(raw ?? '').trim();
    if (!value) continue;
    pkg.stock.push({ id: uuid().slice(0, 12), value, addedAt: Date.now() });
    added++;
  }
  if (!added) throw Error('Tidak ada stok valid yang ditambahkan');
  pkg.stockAlerted = false;
  save();
  return p;
}

function removeStock(productId, packageId, count = 1) {
  const p = getProduct(productId);
  if (!p) throw Error('Produk tidak ditemukan');
  if (p.deliveryType !== 'stock') throw Error('Produk ini tidak menggunakan stok');
  const pkg = getPackage(p, packageId);
  if (!pkg) throw Error('Paket tidak ditemukan');
  const n = Math.max(0, Number(count) || 0);
  const removed = pkg.stock.splice(0, n);
  if (availableStock(p, pkg.id) > 0) pkg.stockAlerted = false;
  save();
  return removed;
}

function createProduct(data) {
  const id = String(data.id || '').trim();
  if (!id) throw Error('ID produk wajib diisi');
  if (getProduct(id)) throw Error('ID produk sudah digunakan');
  const p = normalizeProduct({
    id,
    name: data.name,
    description: data.description || '',
    model: data.model || '',
    emoji: data.emoji || '📦',
    deliveryType: data.deliveryType || 'stock',
    fields: data.fields || [],
    packages: data.packages || [{ id: 'default', name: '1 Bulan', price: 0 }],
    stock: data.stock || []
  });
  products.push(p);
  save();
  return p;
}

function updateProduct(id, patch) {
  const p = getProduct(id);
  if (!p) throw Error('Produk tidak ditemukan');
  Object.assign(p, patch);
  normalizeProduct(p);
  save();
  return p;
}

function deleteProduct(id) {
  const i = products.findIndex(p => p.id === String(id));
  if (i < 0) throw Error('Produk tidak ditemukan');
  const active = Object.values(store.orders || {}).some(o => o.productId === String(id) && ['processing', 'paid'].includes(o.status));
  if (active) throw Error('Produk sedang diproses oleh order aktif dan belum aman untuk dihapus');
  const p = products[i];
  products.splice(i, 1);
  save();
  return p;
}

function appendOrderEvent(id, type, message, meta = {}) {
  const o = getOrder(id);
  if (!o) return null;
  if (!Array.isArray(o.events)) o.events = [];
  o.events.push({ at: Date.now(), type: String(type || 'info'), message: String(message || ''), ...meta });
  save();
  return o;
}

function makeReceiptId() {
  return `RESI-${uuid().slice(0, 10).toUpperCase()}`;
}

function getOrderReceipt(id) {
  const o = getOrder(id);
  if (!o) return null;
  if (!o.receiptId) { o.receiptId = makeReceiptId(); save(); }
  return { receiptId: o.receiptId, orderId: o.id, events: Array.isArray(o.events) ? o.events : [] };
}

function createOrder({ buyerId, productId, packageId, answers = {} }) {
  const p = getProduct(productId);
  const pkg = getPackage(p, packageId);
  if (!p || !pkg) throw Error('Produk/paket tidak ditemukan');
  const availability = productAvailability(p, pkg.id);
  if (!availability.available) throw Error(availability.reason);
  const id = `ORD-${uuid().slice(0, 8).toUpperCase()}`;
  const order = {
    id,
    buyerId: Number(buyerId),
    productId: p.id,
    packageId: pkg.id,
    answers,
    price: Number(pkg.price),
    status: 'awaiting_payment',
    createdAt: Date.now(),
    receiptId: makeReceiptId(),
    events: [],
    delivery: null,
    refunded: false
  };
  store.orders[id] = order;
  appendOrderEvent(id, 'created', 'Order dibuat dan menunggu pembayaran.');
  return order;
}

function getOrder(id) { return store.orders[String(id)]; }

function payOrder(id) {
  const o = getOrder(id);
  if (!o) throw Error('Order tidak ditemukan');
  if (o.status !== 'awaiting_payment') return o;
  const u = user(o.buyerId);
  if (u.balance < o.price) throw Error('Saldo tidak cukup');
  u.balance -= o.price;
  o.status = 'paid';
  o.paidAt = Date.now();
  appendOrderEvent(id, 'paid', 'Saldo buyer berhasil dipotong dan order dibayar.');
  return o;
}

function refundOrder(id, reason = '') {
  const o = getOrder(id);
  if (!o || o.refunded) return false;
  const u = user(o.buyerId);
  u.balance += Number(o.price) || 0;
  o.refunded = true;
  o.status = 'refunded';
  if (reason) o.failureReason = reason;
  o.refundedAt = Date.now();
  appendOrderEvent(id, 'refund', reason || 'Saldo dikembalikan ke buyer.');
  return true;
}

function returnReservedStock(id) {
  const o = getOrder(id);
  if (!o || !o.delivery?.stockId) return false;
  const p = getProduct(o.productId);
  const pkg = getPackage(p, o.packageId);
  if (!p || !pkg) return false;
  const stockId = String(o.delivery.stockId);
  if (!pkg.stock.some(item => String(item.id) === stockId)) {
    pkg.stock.unshift({ id: stockId, value: o.delivery.value, addedAt: o.delivery.addedAt || Date.now() });
  }
  pkg.stockAlerted = false;
  o.delivery = null;
  save();
  return true;
}

// Atomic order operation: reserve the correct package stock and debit buyer together.
function purchaseStockOrder(id) {
  const item = beginStockOrder(id);
  try {
    commitStockOrder(id);
    return item;
  } catch (err) {
    try { rollbackStockOrder(id, err.message || String(err)); } catch {}
    throw err;
  }
}

function completeStockDelivery(id) {
  const o = getOrder(id);
  if (!o) throw Error('Order tidak ditemukan');
  if (o.status === 'completed' && o.delivery) return { id: o.delivery.stockId, value: o.delivery.value };
  if (o.status !== 'paid') throw Error('Order belum dibayar');
  const p = getProduct(o.productId);
  const pkg = getPackage(p, o.packageId);
  if (!p || !pkg || !pkg.stock?.length) return null;
  const item = pkg.stock.shift();
  if (!item?.value) {
    if (item) pkg.stock.unshift(item);
    save();
    return null;
  }
  o.delivery = { type: 'stock', value: item.value, stockId: item.id, packageId: pkg.id, deliveredAt: Date.now(), addedAt: item.addedAt || Date.now() };
  o.status = 'completed';
  o.completedAt = Date.now();
  appendOrderEvent(id, 'completed', 'Delivery stok berhasil.', { stockId: item.id });
  return item;
}

function failOrderAndRefund(id, reason = 'Delivery gagal') {
  const o = getOrder(id);
  if (!o) return false;
  if (['processing','paid'].includes(o.status)) { rollbackStockOrder(id, reason); return true; }
  if (o.status === 'awaiting_payment' || o.status === 'cancelled' || o.status === 'refunded') { o.failureReason = reason; appendOrderEvent(id, 'failed', reason); save(); return true; }
  if (!o.refunded) refundOrder(id, reason);
  return true;
}

function credit(id, amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw Error('Nominal tidak valid');
  const u = user(id);
  u.balance += n;
  save();
  return u;
}

function debit(id, amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw Error('Nominal tidak valid');
  const u = user(id);
  if (u.balance < n) throw Error('Saldo tidak cukup');
  u.balance -= n;
  save();
  return u;
}

function listOrdersByUser(id) {
  return Object.values(store.orders).filter(o => o.buyerId === Number(id)).sort((a, b) => b.createdAt - a.createdAt);
}
function listUsers() { return Object.values(store.users).sort((a, b) => b.createdAt - a.createdAt); }

function createDeposit({ userId, amount }) {
  const n = Number(amount);
  const min = Number(store.settings.minDeposit) || 1000;
  if (!Number.isFinite(n) || n < min) throw Error(`Minimal deposit Rp${min.toLocaleString('id-ID')}`);
  const id = `DEP-${uuid().slice(0, 8).toUpperCase()}`;
  const d = { id, userId: Number(userId), amount: n, status: 'pending', createdAt: Date.now(), proof: null };
  store.deposits[id] = d;
  save();
  return d;
}
function getDeposit(id) { return store.deposits?.[String(id)]; }
function setDepositProof(id, proof) {
  const d = getDeposit(id);
  if (!d) throw Error('Deposit tidak ditemukan');
  if (d.status !== 'pending') throw Error('Deposit sudah diproses');
  d.proof = proof;
  d.proofAt = Date.now();
  save();
  return d;
}
function approveDeposit(id) {
  const d = getDeposit(id);
  if (!d) throw Error('Deposit tidak ditemukan');
  if (d.status !== 'pending') throw Error('Deposit sudah diproses');
  const u = credit(d.userId, d.amount);
  d.status = 'approved';
  d.approvedAt = Date.now();
  d.balanceAfter = u.balance;
  save();
  return d;
}
function rejectDeposit(id, reason = 'Ditolak admin') {
  const d = getDeposit(id);
  if (!d) throw Error('Deposit tidak ditemukan');
  if (d.status !== 'pending') throw Error('Deposit sudah diproses');
  d.status = 'rejected';
  d.rejectionReason = reason;
  d.rejectedAt = Date.now();
  save();
  return d;
}
function listPendingDeposits() {
  return Object.values(store.deposits || {}).filter(d => d.status === 'pending').sort((a, b) => b.createdAt - a.createdAt);
}
function setSetting(key, value) { store.settings[key] = value; save(); return store.settings[key]; }
function getSetting(key) { return store.settings[key]; }
function markStockAlerted(productId, value = true) {
  const p = getProduct(productId); if (!p) return false;
  p.stockAlerted = Boolean(value); save(); return p.stockAlerted;
}

function isAdmin(id) { return store.settings.adminIds.includes(Number(id)); }
function addAdmin(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw Error('User ID admin tidak valid');
  if (!store.settings.adminIds.includes(n)) store.settings.adminIds.push(n);
  save();
  return n;
}
function removeAdmin(id) {
  const n = Number(id);
  store.settings.adminIds = store.settings.adminIds.filter(x => x !== n);
  save();
  return n;
}
function listAdmins() { return [...store.settings.adminIds]; }

function beginStockOrder(id) {
  const o = getOrder(id);
  if (!o) throw Error('Order tidak ditemukan');
  if (o.status !== 'awaiting_payment') throw Error('Order sudah diproses');
  const p = getProduct(o.productId);
  if (!p) throw Error('Produk tidak ditemukan');
  if (p.deliveryType !== 'stock') throw Error('Produk ini bukan stok otomatis');
  const pkg = getPackage(p, o.packageId);
  const availability = productAvailability(p, pkg?.id);
  if (!availability.available) throw Error(availability.reason);
  const u = user(o.buyerId);
  if (u.balance < o.price) throw Error('Saldo tidak cukup');
  const item = pkg.stock.shift();
  if (!item || !item.value) { if (item) pkg.stock.unshift(item); save(); throw Error('Stok tidak valid'); }
  u.balance -= o.price;
  o.status = 'processing';
  o.paidAt = Date.now();
  o.processingAt = Date.now();
  o.delivery = { type: 'stock', value: item.value, stockId: item.id, packageId: pkg.id, reservedAt: Date.now(), addedAt: item.addedAt || Date.now() };
  appendOrderEvent(id, 'processing', 'Stok dikunci, saldo dipotong, menunggu delivery.');
  save();
  return item;
}

function commitStockOrder(id) {
  const o = getOrder(id);
  if (!o) throw Error('Order tidak ditemukan');
  if (o.status === 'completed') return o;
  if (o.status !== 'processing') throw Error('Order tidak dalam status processing');
  o.status = 'completed';
  o.completedAt = Date.now();
  if (o.delivery) o.delivery.deliveredAt = Date.now();
  appendOrderEvent(id, 'completed', 'Delivery stok berhasil dikirim buyer.', { stockId: o.delivery?.stockId });
  save();
  return o;
}

function rollbackStockOrder(id, reason = 'Delivery gagal') {
  const o = getOrder(id);
  if (!o) throw Error('Order tidak ditemukan');
  if (o.status === 'refunded' && o.refunded) return o;
  if (!['processing','paid'].includes(o.status)) return o;
  const p = getProduct(o.productId);
  const pkg = getPackage(p, o.packageId);
  if (o.delivery?.stockId && pkg && !pkg.stock.some(x => String(x.id) === String(o.delivery.stockId))) {
    pkg.stock.unshift({ id: o.delivery.stockId, value: o.delivery.value, addedAt: o.delivery.addedAt || Date.now() });
    pkg.stockAlerted = false;
  }
  const u = user(o.buyerId);
  if (!o.refunded) { u.balance += Number(o.price) || 0; o.refunded = true; o.refundedAt = Date.now(); }
  o.status = 'refunded';
  o.failureReason = String(reason || 'Delivery gagal');
  o.failedAt = Date.now();
  if (o.delivery) o.delivery.rolledBackAt = Date.now();
  appendOrderEvent(id, 'rollback', `Rollback aman: stok dikembalikan dan saldo direfund. ${o.failureReason}`);
  save();
  return o;
}

function recoverProcessingOrders(maxAgeMs = 5 * 60 * 1000) {
  const now = Date.now(); let recovered = 0;
  for (const o of Object.values(store.orders || {})) {
    if (o.status !== 'processing') continue;
    if (!o.processingAt || now - o.processingAt < maxAgeMs) continue;
    try { rollbackStockOrder(o.id, 'Proses delivery terputus/restart bot; order dipulihkan otomatis.'); recovered++; } catch (e) { appendOrderEvent(o.id, 'error', `Pemulihan processing gagal: ${e.message}`); }
  }
  if (recovered) save();
  return recovered;
}

function stats() {
  const orders = Object.values(store.orders);
  const completed = orders.filter(o => o.status === 'completed');
  const deps = Object.values(store.deposits || {});
  return {
    users: Object.keys(store.users).length,
    products: products.length,
    configuredProducts: products.filter(productConfigured).length,
    orders: orders.length,
    completed: completed.length,
    revenue: completed.reduce((s, o) => s + Number(o.price || 0), 0),
    deposits: deps.length,
    pendingDeposits: deps.filter(d => d.status === 'pending').length
  };
}

module.exports = {
  user, getProduct, getPackage, availableStock, productConfigured, productAvailability,
  createOrder, getOrder, getOrderReceipt, appendOrderEvent, payOrder, refundOrder, returnReservedStock, completeStockDelivery,
  purchaseStockOrder, failOrderAndRefund, credit, debit, addStock, removeStock,
  createProduct, updateProduct, deleteProduct, listOrdersByUser, listUsers, stats, save,
  isAdmin, addAdmin, removeAdmin, listAdmins, beginStockOrder, commitStockOrder, rollbackStockOrder, recoverProcessingOrders,
  setSetting, getSetting, getDeposit, setDepositProof, approveDeposit, rejectDeposit,
  listPendingDeposits, createDeposit, markStockAlerted, store,
  get products() { return products; }
};
