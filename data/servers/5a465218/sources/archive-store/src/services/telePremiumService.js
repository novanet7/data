'use strict';

const TelePremiumOrder = require('../models/TelePremiumOrder');
const BuyerWallet = require('../models/BuyerWallet');
const AuditLog = require('../models/AuditLog');
const Notification = require('./notificationService');
const logger = require('../utils/logger');

const DURATION = {
  1: { key: '1', label: '1 Bulan', deliveryType: 'login', productName: 'Telegram Premium 1 Bulan (Login)' },
  3: { key: '3', label: '3 Bulan', deliveryType: 'gift', productName: 'Telegram Premium 3 Bulan (Gift)' },
  6: { key: '6', label: '6 Bulan', deliveryType: 'gift', productName: 'Telegram Premium 6 Bulan (Gift)' },
  12: { key: '12', label: '12 Bulan', deliveryType: 'gift', productName: 'Telegram Premium 12 Bulan (Gift)' },
};

function fmt(v) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(Number(v || 0));
}

function cleanUsername(value) {
  return String(value || '').trim().replace(/^@+/, '');
}

function isValidUsername(value) {
  const u = cleanUsername(value);
  return /^[A-Za-z0-9_]{5,32}$/.test(u);
}

function getConfig(store) {
  const cfg = store?.settings?.telepremium || {};
  return {
    enabled: cfg.enabled === true,
    prices: {
      1: Number(cfg.prices?.[1] || 0),
      3: Number(cfg.prices?.[3] || 0),
      6: Number(cfg.prices?.[6] || 0),
      12: Number(cfg.prices?.[12] || 0),
    },
  };
}

function durationInfo(months) {
  return DURATION[Number(months)] || null;
}

async function getByOrderId(storeId, orderId) {
  return TelePremiumOrder.findOne({ storeId, orderId: String(orderId) });
}

async function debitForOrder(storeId, buyerId, amount, orderId) {
  return BuyerWallet.debit(storeId, buyerId, amount, {
    orderId,
    source: 'telepremium_purchase',
    transactionId: `telepremium:${orderId}:debit`,
  });
}

async function refundOrder(order, reason, actorId = 'system') {
  if (!order) return { success: false, reason: 'Order tidak ditemukan.' };
  if (order.status === 'cancelled' && Number(order.refundAmount || 0) > 0) return { success: true, duplicate: true, amount: Number(order.refundAmount) };
  const amount = Number(order.price || 0);
  if (amount <= 0) return { success: false, reason: 'Nominal refund tidak valid.' };
  const tx = `telepremium:${order.orderId}:refund`;
  const credited = await BuyerWallet.credit(order.storeId, order.buyerId, amount, {
    source: 'telepremium_refund',
    orderId: order.orderId,
    transactionId: tx,
    reason,
  });
  if (!credited?.success) throw new Error('Gagal mengembalikan saldo buyer.');
  await TelePremiumOrder.findOneAndUpdate(
    { _id: order._id },
    {
      $set: {
        status: 'cancelled',
        cancelReason: String(reason || 'Dibatalkan'),
        cancelledAt: new Date().toISOString(),
        cancelledBy: String(actorId || 'system'),
        refundAmount: amount,
        refundTransactionId: tx,
      },
    },
    { new: true }
  );
  await AuditLog.log({
    storeId: order.storeId,
    actorId,
    actorType: 'system',
    action: 'TELEPREMIUM_CANCELLED_REFUNDED',
    entity: 'TelePremiumOrder',
    entityId: order.orderId,
    details: { amount, reason, refundTransactionId: tx },
    result: 'success',
  });
  return { success: true, duplicate: !!credited.duplicate, amount };
}

async function createPurchase({ store, buyer, months, targetUsername = null }) {
  const cfg = getConfig(store);
  if (!cfg.enabled) throw new Error('Telegram Premium sedang ditutup. Silakan coba lagi nanti.');
  const info = durationInfo(months);
  if (!info) throw new Error('Durasi Telegram Premium tidak valid.');
  const price = cfg.prices[Number(months)] || 0;
  if (price <= 0) throw new Error(`Harga ${info.label} belum diset oleh admin.`);
  const target = info.deliveryType === 'gift' ? cleanUsername(targetUsername) : null;
  if (info.deliveryType === 'gift' && !isValidUsername(target)) throw new Error('Username tujuan tidak valid. Contoh: @username');

  const username = cleanUsername(buyer.username);
  const order = await TelePremiumOrder.create({
    storeId: String(store.storeId),
    buyerId: String(buyer.id),
    buyerName: String(buyer.name || buyer.username || buyer.id),
    buyerUsername: username || null,
    targetUsername: target,
    durationMonths: Number(months),
    deliveryType: info.deliveryType,
    productName: info.productName,
    price,
    status: 'pending',
    metadata: { paymentSource: 'buyer_wallet' },
  });

  const debited = await debitForOrder(store.storeId, buyer.id, price, order.orderId);
  if (!debited?.success) {
    await TelePremiumOrder.findOneAndUpdate({ _id: order._id }, { $set: { status: 'cancelled', cancelReason: 'Saldo tidak mencukupi', cancelledAt: new Date().toISOString() } });
    throw new Error('Saldo tidak mencukupi.');
  }

  await AuditLog.log({
    storeId: store.storeId,
    actorId: buyer.id,
    actorType: 'buyer',
    action: 'TELEPREMIUM_PURCHASE_CREATED',
    entity: 'TelePremiumOrder',
    entityId: order.orderId,
    details: { months, price, targetUsername: target, deliveryType: info.deliveryType },
    result: 'success',
  });

  return TelePremiumOrder.findOne({ _id: order._id });
}

async function setPrice(storeId, months, price) {
  const m = Number(months);
  if (!durationInfo(m)) throw new Error('Durasi tidak valid.');
  const n = Number(price);
  if (!Number.isFinite(n) || n < 0 || n > 999999999) throw new Error('Harga tidak valid.');
  const store = await require('../models/Store').findOne({ storeId });
  const current = getConfig(store);
  current.prices[m] = Math.floor(n);
  await require('../models/Store').findOneAndUpdate({ storeId }, { $set: { 'settings.telepremium.prices': current.prices } }, { new: true });
  return current.prices;
}

async function setEnabled(storeId, enabled) {
  await require('../models/Store').findOneAndUpdate({ storeId }, { $set: { 'settings.telepremium.enabled': !!enabled } }, { new: true });
  return !!enabled;
}

async function markProcessing(orderId, adminId) {
  return TelePremiumOrder.findOneAndUpdate(
    { orderId, status: 'pending' },
    { $set: { status: 'processing', processingAt: new Date().toISOString(), completedBy: null, cancelledBy: null } },
    { new: true }
  );
}

async function markCompleted(orderId, adminId) {
  return TelePremiumOrder.findOneAndUpdate(
    { orderId, status: { $in: ['pending', 'processing'] } },
    { $set: { status: 'completed', completedAt: new Date().toISOString(), completedBy: String(adminId || '') } },
    { new: true }
  );
}

module.exports = {
  DURATION,
  fmt,
  cleanUsername,
  isValidUsername,
  getConfig,
  durationInfo,
  getByOrderId,
  createPurchase,
  setPrice,
  setEnabled,
  markProcessing,
  markCompleted,
  refundOrder,
};
