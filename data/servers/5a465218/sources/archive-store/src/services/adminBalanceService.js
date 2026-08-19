'use strict';

const BuyerWallet = require('../models/BuyerWallet');
const AuditLog = require('../models/AuditLog');

async function createManualTopup({ storeId, adminId, userId, amount, note = '' }) {
  return credit({ storeId, adminId, userId, amount, note });
}

async function credit({ storeId, adminId, userId, amount, note = '' }) {
  const sid = String(storeId || '').trim();
  const uid = String(userId || '').trim();
  const n = Math.floor(Number(amount));
  if (!sid) throw new Error('Store ID wajib ada.');
  if (!/^\d{3,20}$/.test(uid)) throw new Error('User ID Telegram tidak valid.');
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Nominal harus bilangan bulat positif.');

  const beforeWallet = await BuyerWallet.getOrCreate(sid, uid);
  const before = Number(beforeWallet.balance || 0);
  const updated = await BuyerWallet.credit(sid, uid, n, { source: 'admin_manual', adminId: String(adminId), note });
  const after = Number(updated?.balance ?? before + n);

  await AuditLog.log({
    storeId: sid,
    actorId: adminId,
    actorType: 'owner',
    action: 'ADMIN_MANUAL_BALANCE_CREDIT',
    entity: 'BuyerWallet',
    entityId: String(updated?._id || beforeWallet._id),
    details: { userId: uid, amount: n, beforeBalance: before, afterBalance: after, note },
    result: 'success',
  });

  return { wallet: updated, beforeBalance: before, afterBalance: after, amount: n };
}

module.exports = { createManualTopup, credit };
