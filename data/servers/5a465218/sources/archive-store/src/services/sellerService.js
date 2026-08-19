'use strict';

const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const Product = require('../models/Product');
const Store = require('../models/Store');
const SellerDeposit = require('../models/SellerDeposit');
const SellerWallet = require('../models/SellerWallet');
const SellerWithdrawal = require('../models/SellerWithdrawal');
const AuditLog = require('../models/AuditLog');
const Notification = require('./notificationService');
const SnapshotService = require('./snapshotService');
const IdPricing = require('./idPricingService');
const Encryption = require('../utils/encryption');
const { withInventoryLock } = require('../utils/inventoryLock');
const { withKeyLock } = require('../utils/keyLock');
const SessionService = require('./sessionService');

let TelegramClient, StringSession, NewMessage;
try {
  ({ TelegramClient } = require('telegram'));
  ({ StringSession } = require('telegram/sessions'));
  ({ NewMessage } = require('telegram/events'));
} catch {
  TelegramClient = null;
  StringSession = null;
  NewMessage = null;
}

const SESSIONS_DIR = path.join(__dirname, '..', '..', 'data', 'sessions');
const SELLER_DIR = path.join(__dirname, '..', '..', 'data', 'seller_sessions');
const pending = new Map();
const clients = new Map();

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function key(storeId, sellerId) { return `${storeId}:${sellerId}`; }
function apiConfig() {
  const apiId = parseInt(process.env.TG_API_ID || '0', 10);
  const apiHash = process.env.TG_API_HASH || '';
  if (!apiId || !apiHash) throw new Error('TG_API_ID dan TG_API_HASH belum diset.');
  return { apiId, apiHash };
}
function priceFmt(n) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(n || 0);
}

function normalizeSellerPhone(value) {
  let raw = String(value || '').trim();
  raw = raw.replace(/[\s().-]/g, '');
  if (raw.startsWith('+62')) return `+${raw.slice(1)}`;
  if (raw.startsWith('62')) return `+${raw}`;
  if (raw.startsWith('0')) return `+62${raw.slice(1)}`;
  return raw.startsWith('+') ? raw : `+${raw}`;
}

const SPAMBOT_CLEAR_MESSAGE = 'Kabar baik, akun Anda tidak dibatasi. Anda bebas, sebebas burung yang terbang lepas.';
const SPAMBOT_CLEAR_MESSAGES = [
  SPAMBOT_CLEAR_MESSAGE,
  'Good news, no limits are currently applied to your account. You’re free as a bird!',
  "Good news, no limits are currently applied to your account. You're free as a bird!",
];

function classifySpamText(text) {
  // Seller deposits pass when SpamBot returns either the Indonesian or English clear message.
  const actual = String(text || '').trim();
  return SPAMBOT_CLEAR_MESSAGES.includes(actual) ? 'clear' : 'rejected';
}

async function logoutSession(sessionString) {
  if (!TelegramClient || !StringSession) return;
  const { apiId, apiHash } = apiConfig();
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 2, autoReconnect: false, useWSS: true,
  });
  try {
    await client.connect();
    const Api = require('telegram').Api;
    await client.invoke(new Api.auth.LogOut({}));
  } finally {
    await client.disconnect().catch(() => {});
  }
}

function idCategory(id) {
  const info = IdPricing.getIdInfo(id);
  if (!info.valid) return 'unknown';
  return `ID ${info.prefix} — ${info.digitLength} Digit`;
}

async function getStatusMultiplier(storeId, status) {
  const store = await Store.findOne({ storeId });
  const cfg = store?.settings?.sellerPricing || {};
  if (cfg.enabled === false) return 0;
  const map = {
    clear: Number(cfg.clearMultiplier ?? 1),
    warning: Number(cfg.warningMultiplier ?? 0.75),
    limited: Number(cfg.limitedMultiplier ?? 0.5),
    unknown: Number(cfg.unknownMultiplier ?? 0),
  };
  return Math.max(0, Math.min(1, Number.isFinite(map[status]) ? map[status] : 0));
}

async function getConfiguredSellerPrice(storeId, status, prefix, digits) {
  const p = String(prefix);
  const d = Number(digits);
  if (!['1','2','3','4','5','6','7','8'].includes(p) || ![8, 9, 10].includes(d)) return null;
  const store = await Store.findOne({ storeId });
  const cfg = store?.settings?.sellerPricing || {};
  const normalized = String(status || 'fs').toLowerCase() === 'nfs' ? 'nfs' : 'fs';
  const direct = (normalized === 'nfs' ? cfg?.nfsPrices?.[p]?.[String(d)] : cfg?.fsPrices?.[p]?.[String(d)])
    ?? (normalized === 'fs' ? cfg?.prices?.[p]?.[String(d)] : undefined);
  if (direct === undefined || direct === null || direct === '') return null;
  const n = Number(direct);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function defaultStatusMultiplier(status) {
  return ({ clear: 1, warning: 0.75, limited: 0.5, unknown: 0 })[status] ?? 0;
}

async function startLogin(storeId, sellerId, phoneNumber) {
  if (!TelegramClient || !StringSession) throw new Error('Module "telegram" belum terinstall.');
  const normalizedPhone = normalizeSellerPhone(phoneNumber);
  if (!/^\+62\d{7,14}$/.test(normalizedPhone)) {
    throw new Error('Nomor seller tidak valid. Contoh: +628123456789');
  }
  const phone = normalizedPhone.slice(1);
  const { apiId, apiHash } = apiConfig();
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5, autoReconnect: true, useWSS: false,
  });
  await client.connect();
  const Api = require('telegram').Api;
  let sent;
  try {
    sent = await client.invoke(new Api.auth.SendCode({
      phoneNumber: `+${phone}`, apiId, apiHash,
      settings: new Api.CodeSettings({ allowFlashcall: false }),
    }));
  } catch (err) {
    await client.disconnect().catch(() => {});
    throw new Error(`Gagal kirim OTP: ${err.message}`);
  }
  const k = key(storeId, sellerId);
  pending.set(k, { phone, phoneCodeHash: sent.phoneCodeHash, step: 'otp' });
  clients.set(k, client);
  setTimeout(() => cleanup(k), 10 * 60 * 1000);
  return { phone };
}

async function submitOtp(storeId, sellerId, otp) {
  const k = key(storeId, sellerId);
  const p = pending.get(k);
  const client = clients.get(k);
  if (!p || !client) throw new Error('Sesi login sudah habis. Mulai lagi.');
  const Api = require('telegram').Api;
  try {
    await client.invoke(new Api.auth.SignIn({
      phoneNumber: `+${p.phone}`,
      phoneCodeHash: p.phoneCodeHash,
      phoneCode: String(otp).trim(),
    }));
  } catch (err) {
    const msg = err.message || err.errorMessage || '';
    if (msg.includes('SESSION_PASSWORD_NEEDED') || err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      p.step = 'password'; pending.set(k, p); return { needsPassword: true };
    }
    throw new Error(`OTP salah atau kadaluarsa: ${msg}`);
  }
  return finalizeLogin(storeId, sellerId, client, p, null);
}

async function submitPassword(storeId, sellerId, password) {
  const k = key(storeId, sellerId);
  const p = pending.get(k);
  const client = clients.get(k);
  if (!p || !client) throw new Error('Sesi login sudah habis. Mulai lagi.');
  try {
    await client.signInWithPassword(
      { id: parseInt(process.env.TG_API_ID, 10), hash: process.env.TG_API_HASH },
      { password: async () => password, onError: async () => true }
    );
  } catch (err) {
    const msg = err.message || err.errorMessage || String(err);
    if (msg.includes('PASSWORD_HASH_INVALID') || msg.includes('2FA_INVALID')) throw new Error('Password 2FA salah.');
    throw new Error(`Gagal verifikasi password: ${msg}`);
  }
  return finalizeLogin(storeId, sellerId, client, p, String(password));
}

async function finalizeLogin(storeId, sellerId, client, p, twoFaPassword = null) {
  const me = await client.getMe();
  const sessionString = client.session.save();
    const profileColor = SessionService.getTelegramProfileColor(me);
ensureDir(SELLER_DIR);
  const dir = path.join(SELLER_DIR, String(storeId)); ensureDir(dir);
  const file = path.join(dir, `${sellerId}_${String(me.id)}.session`);
  fs.writeFileSync(file, JSON.stringify({
    type: 'seller_telegram', telegramId: String(me.id), phone: p.phone,
    profileColor,
    sessionString, twoFaPasswordEncrypted: twoFaPassword ? Encryption.encrypt(twoFaPassword) : null, createdAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  await client.disconnect().catch(() => {});
  cleanup(key(storeId, sellerId), false);
  return {
    telegramId: String(me.id),
    phone: p.phone,
    profileColor,
    sessionString, sessionFile: file, twoFaPassword };
}

function cleanup(k, removeFile = false) {
  const c = clients.get(k);
  if (c) c.disconnect().catch(() => {});
  clients.delete(k); pending.delete(k);
  if (removeFile) {
    // reserved for future cleanup policy
  }
}

async function checkSpamStatus(sessionString) {
  if (!TelegramClient || !StringSession || !NewMessage) throw new Error('Module "telegram" belum terinstall.');
  const { apiId, apiHash } = apiConfig();
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 3, autoReconnect: false, useWSS: true,
  });
  await client.connect();
  try {
    const me = await client.getMe();
    const spamBot = await client.getEntity('SpamBot');
    const spamBotId = String(spamBot.id);
    const response = await new Promise(async (resolve, reject) => {
      let timer;
      const handler = async event => {
        try {
          const message = event?.message;
          if (!message) return;
          const senderId = message?.senderId?.toString?.() || message?.fromId?.userId?.toString?.() || '';
          if (senderId !== spamBotId) return;
          const text = String(message.message || '').trim();
          if (!text) return;
          clearTimeout(timer);
          client.removeEventHandler(handler);
          resolve(text);
        } catch (e) { reject(e); }
      };
      client.addEventHandler(handler, new NewMessage({ incoming: true }));
      timer = setTimeout(() => {
        client.removeEventHandler(handler);
        reject(new Error('Spam Info Bot tidak merespons dalam batas waktu.'));
      }, 20000);
      try { await client.sendMessage(spamBot, { message: '/start' }); }
      catch (e) { clearTimeout(timer); client.removeEventHandler(handler); reject(e); }
    });
    const status = classifySpamText(response);
    return {
      telegramId: String(me.id),
      username: me.username || null,
      status,
      message: response,
      passed: status === 'clear',
      requiredMessage: SPAMBOT_CLEAR_MESSAGE,
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

async function checkSessionClear(sessionString) {
  if (!TelegramClient || !StringSession) throw new Error('Module "telegram" belum terinstall.');
  const { apiId, apiHash } = apiConfig();
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 3, autoReconnect: false, useWSS: true,
  });
  await client.connect();
  try {
    const me = await client.getMe();
    const Api = require('telegram').Api;
    const result = await client.invoke(new Api.account.GetAuthorizations());
    const auths = result?.authorizations || [];
    const others = auths.filter(a => !a.current);
    return { telegramId: String(me.id), currentSession: true, nonCurrentSessions: others.length, cleared: others.length === 0 };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

function sellerSessionData(deposit) {
  if (!deposit?.sessionFile || !fs.existsSync(deposit.sessionFile)) throw new Error('Session seller tidak ditemukan.');
  return JSON.parse(fs.readFileSync(deposit.sessionFile, 'utf8'));
}

async function determinePrice(storeId, spamStatus, telegramId) {
  const bucket = await IdPricing.ensureBucketForId(storeId, telegramId);
  const category = idCategory(telegramId);
  const base = Number(bucket.buyerPrice || bucket.product?.price || 0);
  const directSellerPrice = await getConfiguredSellerPrice(storeId, spamStatus, bucket.info.prefix, bucket.info.digitLength);
  // Seller price is always direct: ID prefix + digit length. No percentage fallback.
  const hasDirectPrice = directSellerPrice !== null;
  const price = hasDirectPrice ? Math.floor(directSellerPrice) : 0;
  return {
    category,
    product: bucket.product,
    price,
    buyerPrice: base,
    multiplier: null,
    directSellerPrice: hasDirectPrice ? directSellerPrice : null,
    idPrefix: bucket.info.prefix,
    idDigits: bucket.info.digitLength,
  };
}

async function creditWallet(deposit) {
  if (!deposit || deposit.status !== 'ready_to_credit') return false;
  const amount = Number(deposit.price || 0);
  if (amount <= 0) throw new Error('Harga seller belum tersedia.');

  const transactionId = `seller-deposit:${deposit._id}`;
  const wallet = await SellerWallet.findOne({ storeId: deposit.storeId, sellerId: String(deposit.sellerId) });
  const existingTx = wallet?.transactions?.find?.(t => String(t.transactionId) === transactionId);
  if (!deposit.walletCredited && existingTx) {
    await SellerDeposit.findOneAndUpdate(
      { _id: deposit._id },
      { $set: { walletCredited: true, creditedAt: new Date().toISOString(), status: 'credited' } }
    );
    return true;
  }
  if (deposit.walletCredited) return false;

  const updatedWallet = await SellerWallet.findOneAndUpdate(
    { storeId: deposit.storeId, sellerId: String(deposit.sellerId) },
    {
      $inc: { balance: amount, totalEarned: amount },
      $push: {
        transactions: {
          transactionId,
          type: 'credit',
          amount,
          source: 'seller_deposit',
          meta: {
            transactionId,
            depositId: String(deposit._id),
            telegramId: String(deposit.telegramId),
          },
          createdAt: new Date().toISOString(),
        },
      },
      $setOnInsert: { currency: 'IDR' },
    },
    { upsert: true, new: true }
  );

  await SellerDeposit.findOneAndUpdate(
    { _id: deposit._id },
    { $set: { walletCredited: true, creditedAt: new Date().toISOString(), status: 'credited' } }
  );

  await AuditLog.log({
    storeId: deposit.storeId, actorId: deposit.sellerId, actorType: 'seller',
    action: 'SELLER_WALLET_CREDITED', entity: 'SellerDeposit', entityId: deposit._id,
    details: { amount, telegramId: deposit.telegramId, transactionId, walletId: updatedWallet?._id || null }, result: 'success',
  });
  try {
    const BotManager = require('../core/BotManager');
    await Notification.sellerDeposit(BotManager.getBot(deposit.storeId), deposit, 'credited');
  } catch (err) { logger.warn(`[SellerService] notification failed: ${err.message}`); }

  // Backup otomatis setelah saldo seller benar-benar dikreditkan.
  try {
    const backup = await SnapshotService.sendToOwner('seller-deposit');
    logger.info(`[SELLER BACKUP] sent=${backup.filename} size=${backup.size}`);
  } catch (err) {
    logger.warn(`[SELLER BACKUP] gagal: ${err.message}`);
  }

  return true;
}

const finalizeLocks = new Map();

async function withFinalizeLock(depositId, fn) {
  const key = String(depositId);
  const previous = finalizeLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => next);
  finalizeLocks.set(key, tail);
  await previous;
  try { return await fn(); } finally {
    release();
    if (finalizeLocks.get(key) === tail) finalizeLocks.delete(key);
  }
}

async function finalizeDeposit(depositId) {
  return withFinalizeLock(depositId, async () => {
    const deposit = await SellerDeposit.findById(depositId);
    if (!deposit) throw new Error('Setoran tidak ditemukan.');
    if (deposit.walletCredited) return { deposit, credited: false };

    const data = sellerSessionData(deposit);
    const check = await checkSessionClear(data.sessionString);
    if (!check.cleared) {
      await SellerDeposit.findOneAndUpdate(
        { _id: depositId },
        { $set: { sellerLoggedOut: false, nonCurrentSessions: check.nonCurrentSessions, status: 'awaiting_session_clear' } }
      );
      return { deposit: await SellerDeposit.findById(depositId), credited: false, check };
    }

    if (deposit.price <= 0 || !deposit.productId) {
      throw new Error('Setoran belum punya produk/harga yang valid.');
    }

    return withInventoryLock(deposit.storeId, deposit.productId, async () => {
      // Re-read inside the inventory lock so concurrent finalization cannot add
      // the same account twice.
      const lockedDeposit = await SellerDeposit.findById(depositId);
      if (!lockedDeposit) throw new Error('Setoran tidak ditemukan.');
      if (lockedDeposit.walletCredited) return { deposit: lockedDeposit, credited: false, check };

      ensureDir(path.join(SESSIONS_DIR, String(deposit.storeId)));
      const target = path.join(SESSIONS_DIR, String(deposit.storeId), `${deposit.productId}_${String(deposit.telegramId)}.session`);

      let existingTarget = null;
      if (fs.existsSync(target)) {
        try {
          existingTarget = JSON.parse(fs.readFileSync(target, 'utf8'));
        } catch (err) {
          throw new Error(`File inventory rusak atau tidak valid: ${err.message}`);
        }

        const sameDeposit = String(existingTarget.sourceDepositId || '') === String(lockedDeposit._id);
        const sameTelegram = String(existingTarget.telegramId || '') === String(lockedDeposit.telegramId);
        const unsold = String(existingTarget.soldTo || '') === '';

        if (!(sameDeposit || (sameTelegram && unsold))) {
          throw new Error('Akun Telegram dengan ID tersebut sudah pernah masuk inventory. Gunakan akun lain.');
        }

        // Recovery path: the inventory file already exists for this exact deposit
        // or for the same Telegram ID, so we only need to sync stock and wallet.
        await SellerDeposit.findOneAndUpdate(
          { _id: depositId },
          { $set: { sessionReady: true, sellerLoggedOut: true, nonCurrentSessions: 0, status: 'ready_to_credit', sessionFile: target } }
        );
        const fresh = await SellerDeposit.findById(depositId);
        await SessionService.syncStockCount(deposit.storeId, deposit.productId);
        await creditWallet(fresh);
        return { deposit: await SellerDeposit.findById(depositId), credited: true, check, recovered: true };
      }

      const payload = {
        type: 'telegram',
        telegramId: String(deposit.telegramId),
        phone: data.phone,
        profileColor: data.profileColor || null,
        sessionString: data.sessionString,
        loggedIn: true, soldTo: null, sellerId: String(deposit.sellerId),
        sourceDepositId: deposit._id,
        spamStatus: deposit.spamStatus,
        nokosStatus: deposit.metadata?.nokosStatus || 'fs',
        nokosStatusReason: deposit.metadata?.nokosStatusReason || 'legacy_default',
        nokosStatusDetectedAt: deposit.metadata?.nokosStatusDetectedAt || null,
        idPrefix: deposit.metadata?.idPrefix || String(deposit.telegramId).charAt(0),
        idDigits: deposit.metadata?.idDigits || String(deposit.telegramId).length,
        loginAt: new Date().toISOString(),
        twoFaPasswordEncrypted: data.twoFaPasswordEncrypted || null,
      };
      const tmpTarget = `${target}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpTarget, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmpTarget, target);
      try { fs.chmodSync(target, 0o600); } catch {}

      await SessionService.syncStockCount(deposit.storeId, deposit.productId);
      await SellerDeposit.findOneAndUpdate(
        { _id: depositId },
        { $set: { sessionReady: true, sellerLoggedOut: true, nonCurrentSessions: 0, status: 'ready_to_credit', sessionFile: target } }
      );
      const fresh = await SellerDeposit.findById(depositId);
      await creditWallet(fresh);
      return { deposit: await SellerDeposit.findById(depositId), credited: true, check };
    });
  });
}
async function getWallet(storeId, sellerId) {
  return SellerWallet.findOne({ storeId, sellerId: String(sellerId) });
}

async function requestWithdrawal(storeId, sellerId, data) {
  const sid = String(sellerId);
  const lockKey = `seller-withdraw:${String(storeId)}:${sid}`;
  return withKeyLock(lockKey, async () => {
    const amount = Math.floor(Number(data.amount || 0));
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Jumlah penarikan tidak valid.');

    const pending = await SellerWithdrawal.findOne({ storeId, sellerId: sid, status: 'pending' });
    if (pending) throw new Error('Masih ada penarikan yang menunggu proses admin. Selesaikan penarikan sebelumnya terlebih dahulu.');

    const wallet = await getWallet(storeId, sid);
    const balance = Number(wallet?.balance || 0);
    if (amount > balance) throw new Error(`Saldo tidak cukup. Saldo tersedia ${priceFmt(balance)}.`);

    const updated = await SellerWallet.findOneAndUpdate(
      { storeId, sellerId: sid, balance: { $gte: amount } },
      { $inc: { balance: -amount } },
      { new: true }
    );
    if (!updated) throw new Error('Saldo berubah atau tidak mencukupi. Silakan coba lagi.');

    try {
      const req = await SellerWithdrawal.create({
        storeId, sellerId: sid, sellerUsername: data.sellerUsername || null,
        bankName: String(data.bankName || '').trim(),
        accountNumber: String(data.accountNumber || '').trim(),
        accountName: String(data.accountName || '').trim(),
        amount, status: 'pending', balanceAtRequest: balance,
        balanceAfterHold: Number(updated.balance || 0), balanceHeld: true,
      });
      await AuditLog.log({
        storeId, actorId: sid, actorType: 'seller', action: 'SELLER_WITHDRAWAL_REQUESTED',
        entity: 'SellerWithdrawal', entityId: req._id,
        details: { amount, bankName: req.bankName, accountNumber: req.accountNumber, accountName: req.accountName, balanceAtRequest: balance },
        result: 'success',
      });
      return req;
    } catch (err) {
      await SellerWallet.findOneAndUpdate({ storeId, sellerId: sid }, { $inc: { balance: amount } }, { new: true });
      throw err;
    }
  });
}

async function approveWithdrawal(storeId, withdrawalId, adminId) {
  return withKeyLock(`seller-withdraw-action:${String(storeId)}:${String(withdrawalId)}`, async () => {
    const req = await SellerWithdrawal.findOne({ _id: withdrawalId, storeId, status: 'pending' });
    if (!req) throw new Error('Penarikan tidak ditemukan atau sudah diproses.');
    const updated = await SellerWithdrawal.findOneAndUpdate(
      { _id: withdrawalId, storeId, status: 'pending' },
      { $set: { status: 'approved', processedAt: new Date().toISOString(), processedBy: String(adminId), balanceHeld: false } },
      { new: true }
    );
    if (!updated) throw new Error('Penarikan sudah diproses.');
    await SellerWallet.findOneAndUpdate(
      { storeId: req.storeId, sellerId: String(req.sellerId) },
      { $inc: { totalWithdrawn: Number(req.amount || 0) } },
      { new: true }
    );
    await AuditLog.log({
      storeId: req.storeId, actorId: adminId, actorType: 'owner', action: 'SELLER_WITHDRAWAL_APPROVED',
      entity: 'SellerWithdrawal', entityId: req._id, details: { sellerId: req.sellerId, amount: req.amount }, result: 'success',
    });
    return updated;
  });
}

async function rejectWithdrawal(storeId, withdrawalId, adminId, reason = 'Ditolak admin') {
  return withKeyLock(`seller-withdraw-action:${String(storeId)}:${String(withdrawalId)}`, async () => {
    const req = await SellerWithdrawal.findOne({ _id: withdrawalId, storeId, status: 'pending' });
    if (!req) throw new Error('Penarikan tidak ditemukan atau sudah diproses.');
    const updated = await SellerWithdrawal.findOneAndUpdate(
      { _id: withdrawalId, storeId, status: 'pending' },
      { $set: { status: 'rejected', rejectionReason: reason, processedAt: new Date().toISOString(), processedBy: String(adminId), balanceHeld: false } },
      { new: true }
    );
    if (!updated) throw new Error('Penarikan sudah diproses.');
    await SellerWallet.findOneAndUpdate(
      { storeId: req.storeId, sellerId: String(req.sellerId) },
      { $inc: { balance: Number(req.amount || 0) } },
      { new: true }
    );
    await AuditLog.log({
      storeId: req.storeId, actorId: adminId, actorType: 'owner', action: 'SELLER_WITHDRAWAL_REJECTED',
      entity: 'SellerWithdrawal', entityId: req._id, details: { sellerId: req.sellerId, amount: req.amount, reason }, result: 'success',
    });
    return updated;
  });
}

module.exports = {
  normalizeSellerPhone,
  startLogin, submitOtp, submitPassword, checkSpamStatus, checkSessionClear,
  determinePrice, finalizeDeposit, getWallet, sellerSessionData, idCategory,
  logoutSession, SPAMBOT_CLEAR_MESSAGE,
  priceFmt, defaultStatusMultiplier, getStatusMultiplier, getConfiguredSellerPrice,
  requestWithdrawal, approveWithdrawal, rejectWithdrawal,
};
