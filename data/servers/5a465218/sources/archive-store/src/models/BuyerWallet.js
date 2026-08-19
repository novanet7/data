'use strict';
const { Repository } = require('../database/repository');
const repo = new Repository('buyer_wallets', { balance: 0, totalTopup: 0, totalSpent: 0, transactions: [] });
const locks = new Map();
async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const next = new Promise(r => { release = r; });
  const tail = prev.then(() => next);
  locks.set(key, tail);
  await prev;
  try { return await fn(); } finally { release(); if (locks.get(key) === tail) locks.delete(key); }
}
const Wallet = {
  async getOrCreate(storeId, buyerId) {
    const sid = String(storeId);
    const uid = String(buyerId);
    let w = await repo.findOne({ storeId: sid, buyerId: uid });
    if (!w) w = await repo.create({ storeId: sid, buyerId: uid });
    return w;
  },

  async credit(storeId, buyerId, amount, meta = {}) {
    return withLock(`wallet:${storeId}:${buyerId}`, async () => {
      const n = Number(amount);
      if (!Number.isFinite(n) || n <= 0) throw new Error('Nominal credit wallet tidak valid.');
      const w = await this.getOrCreate(storeId, buyerId);
      const transactionId = String(meta.transactionId || `${meta.source || 'credit'}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`);
      if ((w.transactions || []).some(t => t.transactionId === transactionId)) {
        return { success: true, duplicate: true, wallet: w };
      }
      const source = String(meta.source || 'credit');
      const isRefund = source.includes('refund');
      const inc = { balance: n };
      if (!isRefund && ['topup', 'gateway', 'valqenix', 'manual', 'admin_manual'].some(k => source.includes(k))) inc.totalTopup = n;
      const tx = { transactionId, type: isRefund ? 'refund' : 'credit', amount: n, source, meta: { ...meta, transactionId }, createdAt: new Date().toISOString() };
      const updated = await repo.findOneAndUpdate(
        { _id: w._id },
        { $inc: inc, $push: { transactions: tx }, $set: { updatedAt: new Date().toISOString(), lastTopup: meta } },
        { new: true }
      );
      return { success: true, duplicate: false, wallet: updated };
    });
  },

  async debit(storeId, buyerId, amount, meta = {}) {
    return withLock(`wallet:${storeId}:${buyerId}`, async () => {
      const n = Number(amount);
      if (!Number.isFinite(n) || n <= 0) return { success: false, reason: 'Nominal debit wallet tidak valid.' };
      const w = await this.getOrCreate(storeId, buyerId);
      const transactionId = String(meta.transactionId || `${meta.orderId ? `order:${meta.orderId}:debit` : `debit:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`}`);
      const existing = (w.transactions || []).find(t => t.transactionId === transactionId);
      if (existing) return { success: true, duplicate: true, wallet: w };
      if (Number(w.balance || 0) < n) return { success: false, wallet: w };
      const tx = { transactionId, type: 'debit', amount: n, source: String(meta.source || 'purchase'), meta: { ...meta, transactionId }, createdAt: new Date().toISOString() };
      const updated = await repo.findOneAndUpdate(
        { _id: w._id, balance: { $gte: n } },
        { $inc: { balance: -n, totalSpent: n }, $push: { transactions: tx }, $set: { updatedAt: new Date().toISOString(), lastSpend: meta } },
        { new: true }
      );
      return updated ? { success: true, duplicate: false, wallet: updated } : { success: false, wallet: w };
    });
  },

  findOne(filter) { return repo.findOne(filter); },
  async resetAllBalances(filter = {}) {
    return repo.updateMany(filter, {
      $set: { balance: 0 }
    });
  },
};
module.exports = Wallet;
