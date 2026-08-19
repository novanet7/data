'use strict';

const Store = require('../models/Store');
const Product = require('../models/Product');

const PREFIXES = ['1','2','3','4','5','6','7','8'];
const DEFAULT_DIGITS = [8, 9, 10]; // Telegram ID pricelist hanya 8, 9, dan 10 digit

function normalizeId(id) {
  return String(id ?? '').replace(/\D/g, '');
}

function getIdInfo(id) {
  const digits = normalizeId(id);
  if (!digits) return { valid: false, prefix: null, digitLength: 0, key: null };
  const prefix = digits.charAt(0);
  const digitLength = digits.length;
  return {
    valid: PREFIXES.includes(prefix) && DEFAULT_DIGITS.includes(digitLength),
    prefix,
    digitLength,
    key: `${prefix}:${digitLength}`,
  };
}

function normalizeStatus(status) {
  const value = String(status || 'fs').toLowerCase();
  return value === 'nfs' ? 'nfs' : 'fs';
}

function getConfiguredPrice(store, prefix, digitLength, status = 'fs') {
  const normalizedStatus = normalizeStatus(status);
  const cfg = store?.settings?.idPricing || {};
  const statusPrices = normalizedStatus === 'nfs' ? cfg.nfsPrices : cfg.fsPrices;
  const legacy = cfg.prices;
  const value = statusPrices?.[String(prefix)]?.[String(digitLength)] ?? (normalizedStatus === 'fs' ? legacy?.[String(prefix)]?.[String(digitLength)] : 0);
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function getConfiguredPrices(store) {
  const result = {};
  for (const prefix of PREFIXES) {
    result[prefix] = {};
    for (const digits of DEFAULT_DIGITS) {
      result[prefix][digits] = getConfiguredPrice(store, prefix, digits);
    }
  }
  return result;
}

async function setBuyerPrice(storeId, prefix, digitLength, price, status = 'fs') {
  const p = String(prefix);
  const d = String(digitLength);
  const amount = Number(price);
  const normalizedStatus = normalizeStatus(status);
  if (!PREFIXES.includes(p)) throw new Error('Awalan ID harus 1-8.');
  if (!Number.isInteger(Number(d)) || ![8, 9, 10].includes(Number(d))) throw new Error('Jumlah digit yang didukung hanya 8, 9, atau 10.');
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Harga tidak valid.');

  const pricePath = normalizedStatus === 'nfs'
    ? `settings.idPricing.nfsPrices.${p}.${d}`
    : `settings.idPricing.fsPrices.${p}.${d}`;
  const updateSet = { [pricePath]: Math.floor(amount), 'settings.idPricing.enabled': true };
  if (normalizedStatus === 'fs') updateSet[`settings.idPricing.prices.${p}.${d}`] = Math.floor(amount);

  await Store.findOneAndUpdate(
    { storeId },
    { $set: updateSet }
  );

  // Keep the canonical inventory bucket price in sync so existing checkout/payment
  // code continues to work unchanged. Setting a price also creates the bucket,
  // so it is immediately visible in the owner pricelist and buyer menu.
  const product = await ensureIdBucketProduct(storeId, p, Number(d));
  if (product && normalizedStatus === 'fs') {
    await Product.findOneAndUpdate({ _id: product._id, storeId }, { $set: { price: Math.floor(amount) } });
  }
  return amount;
}

function getConfiguredPricesByStatus(store) {
  const result = { fs: {}, nfs: {} };
  for (const status of ['fs', 'nfs']) {
    for (const prefix of PREFIXES) {
      result[status][prefix] = {};
      for (const digits of DEFAULT_DIGITS) result[status][prefix][digits] = getConfiguredPrice(store, prefix, digits, status);
    }
  }
  return result;
}

async function getPricing(storeId) {
  const store = await Store.findOne({ storeId });
  return getConfiguredPrices(store);
}

async function ensureIdBucketProduct(storeId, prefix, digitLength) {
  const p = String(prefix);
  const d = Number(digitLength);
  if (!PREFIXES.includes(p) || !Number.isInteger(d) || ![8, 9, 10].includes(d)) return null;

  let product = await Product.findOne({
    storeId,
    productType: 'telegram_session',
    'metadata.idBucket': true,
    'metadata.idPrefix': p,
    'metadata.idDigits': d,
    status: { $ne: 'deleted' },
  });
  if (product) return product;

  const store = await Store.findOne({ storeId });
  const price = getConfiguredPrice(store, p, d);
  product = await Product.create({
    storeId,
    name: `ID ${p} — ${d} Digit`,
    description: `Akun Telegram dengan ID diawali ${p} dan berjumlah ${d} digit.`,
    price,
    category: 'Telegram Accounts',
    productType: 'telegram_session',
    maxPerOrder: 10,
    status: 'out_of_stock',
    stockCount: 0,
    metadata: {
      idBucket: true,
      idPrefix: p,
      idDigits: d,
      idKey: `${p}:${d}`,
    },
  });
  return product;
}

async function ensureBucketForId(storeId, telegramId) {
  const info = getIdInfo(telegramId);
  if (!info.valid) return { info, product: null, buyerPrice: 0 };
  const product = await ensureIdBucketProduct(storeId, info.prefix, info.digitLength);
  const store = await Store.findOne({ storeId });
  const buyerPrice = getConfiguredPrice(store, info.prefix, info.digitLength);
  if (product && Number(product.price) !== buyerPrice) {
    await Product.findOneAndUpdate({ _id: product._id, storeId }, { $set: { price: buyerPrice } });
    product.price = buyerPrice;
  }
  return { info, product, buyerPrice };
}

async function getPrefixBuckets(storeId, prefix) {
  const p = String(prefix);
  const store = await Store.findOne({ storeId });
  const configured = [];
  for (const d of DEFAULT_DIGITS) {
    const product = await Product.findOne({
      storeId,
      productType: 'telegram_session',
      'metadata.idBucket': true,
      'metadata.idPrefix': p,
      'metadata.idDigits': d,
      status: { $ne: 'deleted' },
    });
    const price = getConfiguredPrice(store, p, d);
    const stock = Number(product?.stockCount || 0);
    if (product || price > 0 || stock > 0) {
      configured.push({ digitLength: d, price, stockCount: stock, product });
    }
  }
  return configured;
}

async function getPrefixStock(storeId, prefix) {
  const buckets = await getPrefixBuckets(storeId, prefix);
  return buckets.reduce((sum, item) => sum + Number(item.stockCount || 0), 0);
}

async function getAllPrefixStock(storeId) {
  const result = {};
  for (const prefix of PREFIXES) result[prefix] = await getPrefixStock(storeId, prefix);
  return result;
}

function getBuyerPriceForSession(store, prefix, digitLength, status = 'fs') {
  return getConfiguredPrice(store, prefix, digitLength, status);
}

module.exports = {
  PREFIXES,
  DEFAULT_DIGITS,
  normalizeId,
  getIdInfo,
  getConfiguredPrice,
  getConfiguredPrices,
  getConfiguredPricesByStatus,
  getBuyerPriceForSession,
  normalizeStatus,
  setBuyerPrice,
  getPricing,
  ensureIdBucketProduct,
  ensureBucketForId,
  getPrefixBuckets,
  getPrefixStock,
  getAllPrefixStock,
};
