'use strict';

const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const Notification = require('./notificationService');
const Encryption = require('../utils/encryption');
const buyerKeyboard = require('../keyboards/buyerKeyboard');

let TelegramClient, StringSession, NewMessage;
let telegramLoadError = null;
try {
  ({ TelegramClient } = require('telegram'));
  ({ StringSession } = require('telegram/sessions'));
  ({ NewMessage } = require('telegram/events'));
} catch (err) {
  telegramLoadError = err;
  TelegramClient = null;
  StringSession = null;
  NewMessage = null;
}

const SESSIONS_DIR = path.join(__dirname, '..', '..', 'data', 'sessions');
const pendingSessions = new Map();
const activeClients = new Map();
const otpWaiters = new Map();
const otpListeners = new Map();


const TELEGRAM_PROFILE_COLORS = {
  0: { name: 'Merah', emoji: '🔴' },
  1: { name: 'Orange', emoji: '🟠' },
  2: { name: 'Violet', emoji: '🟣' },
  3: { name: 'Hijau', emoji: '🟢' },
  4: { name: 'Cyan', emoji: '🔵' },
  5: { name: 'Biru', emoji: '🔵' },
  6: { name: 'Pink', emoji: '🩷' },
};

function getTelegramProfileColor(me) {
  const pc = me?.profileColor;

  let colorId = null;

  if (pc && pc.color !== undefined && pc.color !== null) {
    colorId = Number(pc.color);
  }

  const known = TELEGRAM_PROFILE_COLORS[colorId];

  return {
    id: Number.isFinite(colorId) ? colorId : null,
    name: known?.name || (colorId !== null ? `Palette ${colorId}` : null),
    emoji: known?.emoji || '🎨',
    available: colorId !== null,
  };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function sessionKey(storeId, productId) {
  return `${storeId}:${productId}`;
}

function sessionFile(storeId, productId, phone) {
  const dir = path.join(SESSIONS_DIR, storeId);
  ensureDir(dir);
  return path.join(dir, `${productId}_${phone.replace(/\D/g, '')}.session`);
}

function setPending(storeId, productId, data) {
  pendingSessions.set(sessionKey(storeId, productId), { ...data, updatedAt: Date.now() });
}
function getPending(storeId, productId) {
  return pendingSessions.get(sessionKey(storeId, productId)) || null;
}
function clearPending(storeId, productId) {
  pendingSessions.delete(sessionKey(storeId, productId));
}

async function startTelegramLogin(storeId, productId, phoneNumber) {
  if (!TelegramClient || !StringSession) {
    throw new Error(`Modul Telegram gagal dimuat: ${telegramLoadError?.message || 'dependency tidak tersedia'}. Jalankan npm install/npm ci dan pastikan dependency telegram terpasang.`);
  }

  const phone = phoneNumber.replace(/\D/g, '');
  if (phone.length < 7) throw new Error('Nomor telepon tidak valid.');

  const Api = require('telegram').Api;
  const apiId = parseInt(process.env.TG_API_ID || '0', 10);
  const apiHash = process.env.TG_API_HASH || '';
  if (!apiId || !apiHash) throw new Error('TG_API_ID dan TG_API_HASH belum diset.');

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 999,
    autoReconnect: true,
    useWSS: true,
  });
  await client.connect();

  let phoneCodeHash;
  try {
    const sent = await client.invoke(new Api.auth.SendCode({
      phoneNumber: `+${phone}`,
      apiId,
      apiHash,
      settings: new Api.CodeSettings({ allowFlashcall: false }),
    }));
    phoneCodeHash = sent.phoneCodeHash;
  } catch (err) {
    await client.disconnect().catch(() => {});
    throw new Error(`Gagal kirim OTP: ${err.message}`);
  }

  const key = sessionKey(storeId, productId);
  setPending(storeId, productId, { type: 'telegram', phone, phoneCodeHash, step: 'otp' });
  activeClients.set(key, client);

  setTimeout(() => {
    activeClients.get(key)?.disconnect().catch(() => {});
    activeClients.delete(key);
    clearPending(storeId, productId);
  }, 5 * 60 * 1000);

  return { phone };
}

async function submitTelegramOTP(storeId, productId, otp) {
  const key = sessionKey(storeId, productId);
  const pending = getPending(storeId, productId);
  const client = activeClients.get(key);
  if (!pending || !client) throw new Error('Sesi login sudah habis. Mulai lagi.');

  const Api = require('telegram').Api;
  try {
    await client.invoke(new Api.auth.SignIn({
      phoneNumber: `+${pending.phone}`,
      phoneCodeHash: pending.phoneCodeHash,
      phoneCode: otp.trim(),
    }));
  } catch (err) {
    const msg = err.message || err.errorMessage || '';
    if (msg.includes('SESSION_PASSWORD_NEEDED') || err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      pending.step = 'password';
      setPending(storeId, productId, pending);
      const timerKey = `${key}:timer`;
      const oldTimer = activeClients.get(timerKey);
      if (oldTimer) clearTimeout(oldTimer);
      activeClients.set(timerKey, setTimeout(() => {
        activeClients.get(key)?.disconnect().catch(() => {});
        activeClients.delete(key);
        activeClients.delete(timerKey);
        clearPending(storeId, productId);
      }, 10 * 60 * 1000));
      return { needsPassword: true };
    }
    throw new Error(`OTP salah atau kadaluarsa: ${msg}`);
  }

  return saveTelegramSession(storeId, productId, pending, client);
}

async function submitTelegramPassword(storeId, productId, password) {
  const key = sessionKey(storeId, productId);
  const pending = getPending(storeId, productId);
  const client = activeClients.get(key);
  if (!pending || !client) throw new Error('Sesi login sudah habis. Mulai lagi.');

  try {
    await client.signInWithPassword(
      { id: parseInt(process.env.TG_API_ID, 10), hash: process.env.TG_API_HASH },
      { password: async () => password, onError: async () => true }
    );
  } catch (err) {
    const msg = err.message || err.errorMessage || String(err);
    if (msg.includes('PASSWORD_HASH_INVALID') || msg.includes('2FA_INVALID')) {
      throw new Error('Password 2FA salah.');
    }
    if (msg.includes('FLOOD_WAIT')) {
      const seconds = msg.match(/FLOOD_WAIT_(\d+)/)?.[1] || '?';
      throw new Error(`Terlalu banyak percobaan. Tunggu ${seconds} detik.`);
    }
    throw new Error(`Gagal verifikasi password: ${msg}`);
  }

  const result = await saveTelegramSession(storeId, productId, pending, client, password);
  const timer = activeClients.get(`${key}:timer`);
  if (timer) clearTimeout(timer);
  activeClients.delete(`${key}:timer`);
  return result;
}

async function saveTelegramSession(storeId, productId, pending, client, password = null) {
  const sessionString = client.session.save();
  const me = await client.getMe();
  const telegramId = String(me.id);
  const profileColor = getTelegramProfileColor(me);
  const file = sessionFile(storeId, productId, pending.phone);
  atomicWriteJson(file, {
    type: 'telegram',
    telegramId,
    phone: pending.phone,
    profileColor,
    sessionString,
    ...(password ? { twoFaPasswordEncrypted: Encryption.encrypt(password) } : {}),
    loggedIn: true,
    soldTo: null,
    loginAt: new Date().toISOString(),
  });

  await client.disconnect().catch(() => {});
  const key = sessionKey(storeId, productId);
  activeClients.delete(key);
  clearPending(storeId, productId);
  return {
    success: true,
    phone: pending.phone,
    telegramId,
    profileColor,
    sessionString,
    sessionFile: file,
    twoFaPasswordEncrypted: password ? Encryption.encrypt(password) : null
  };
}

function pruneExpiredOtpCooldowns(data) {
  if (!Array.isArray(data?.otpCooldowns)) return [];
  const now = Date.now();
  const active = data.otpCooldowns.filter(entry => Number(entry?.until || 0) > now);
  if (active.length !== data.otpCooldowns.length) data.otpCooldowns = active;
  return active;
}

function isSessionInOtpCooldown(data, buyerId) {
  if (!buyerId) return false;
  const cooldowns = pruneExpiredOtpCooldowns(data);
  const bid = String(buyerId);
  return cooldowns.some(entry => String(entry?.buyerId || '') === bid && Number(entry?.until || 0) > Date.now());
}

function countAvailableSessions(storeId, productId, buyerId = null) {
  const dir = path.join(SESSIONS_DIR, storeId);
  if (!fs.existsSync(dir)) return 0;

  let count = 0;
  for (const fname of fs.readdirSync(dir)) {
    if (!fname.startsWith(`${productId}_`) || !fname.endsWith('.session')) continue;
    const file = path.join(dir, fname);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const before = JSON.stringify(data.otpCooldowns || []);
      pruneExpiredOtpCooldowns(data);
      if (JSON.stringify(data.otpCooldowns || []) !== before) atomicWriteJson(file, data);
      if (data.loggedIn && !data.soldTo && !isSessionInOtpCooldown(data, buyerId)) count++;
    } catch {}
  }
  return count;
}

function getAvailableSessionByTelegramId(storeId, productId, telegramId, buyerId = null) {
  const dir = path.join(SESSIONS_DIR, String(storeId));
  if (!fs.existsSync(dir)) return null;
  const target = String(telegramId || '');
  if (!target) return null;

  for (const fname of fs.readdirSync(dir)) {
    if (!fname.startsWith(`${productId}_`) || !fname.endsWith('.session')) continue;
    const file = path.join(dir, fname);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const before = JSON.stringify(data.otpCooldowns || []);
      pruneExpiredOtpCooldowns(data);
      if (JSON.stringify(data.otpCooldowns || []) !== before) atomicWriteJson(file, data);
      if (String(data.telegramId || '') !== target) continue;
      if (data.loggedIn && !data.soldTo && !isSessionInOtpCooldown(data, buyerId)) {
        return { type: 'telegram_session', data, file };
      }
    } catch {}
  }
  return null;
}

function getAvailableSessionDetails(storeId, productId, buyerId = null, limit = 50) {
  const dir = path.join(SESSIONS_DIR, String(storeId));
  if (!fs.existsSync(dir)) return [];

  const out = [];
  const max = Math.max(1, Math.min(Number(limit) || 50, 100));

  for (const fname of fs.readdirSync(dir)) {
    if (!fname.startsWith(`${productId}_`) || !fname.endsWith('.session')) continue;
    const file = path.join(dir, fname);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const before = JSON.stringify(data.otpCooldowns || []);
      pruneExpiredOtpCooldowns(data);
      if (JSON.stringify(data.otpCooldowns || []) !== before) atomicWriteJson(file, data);
      if (!data.loggedIn || data.soldTo || isSessionInOtpCooldown(data, buyerId)) continue;
      out.push({
        type: 'telegram_session',
        file,
        data,
        telegramId: String(data.telegramId || ''),
        phone: String(data.phone || ''),
      });
      if (out.length >= max) break;
    } catch {}
  }

  return out;
}

function getAvailableSession(storeId, productId, buyerId = null) {
  const dir = path.join(SESSIONS_DIR, storeId);
  if (!fs.existsSync(dir)) return null;

  for (const fname of fs.readdirSync(dir)) {
    if (!fname.startsWith(`${productId}_`) || !fname.endsWith('.session')) continue;
    const file = path.join(dir, fname);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const before = JSON.stringify(data.otpCooldowns || []);
      pruneExpiredOtpCooldowns(data);
      if (JSON.stringify(data.otpCooldowns || []) !== before) atomicWriteJson(file, data);
      if (data.loggedIn && !data.soldTo && !isSessionInOtpCooldown(data, buyerId)) {
        return { type: 'telegram_session', data, file };
      }
    } catch {}
  }
  return null;
}

function addBuyerOtpCooldownByOrderId(storeId, orderId, buyerId, cooldownMs = 2 * 60 * 60 * 1000) {
  const dir = path.join(SESSIONS_DIR, String(storeId));
  if (!fs.existsSync(dir)) return 0;
  const bid = String(buyerId || '');
  if (!bid) return 0;
  const until = Date.now() + Number(cooldownMs || 0);
  let changed = 0;
  for (const fname of fs.readdirSync(dir)) {
    if (!fname.endsWith('.session')) continue;
    const file = path.join(dir, fname);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (String(data.orderId || '') !== String(orderId) || String(data.soldTo || '') !== bid) continue;
      pruneExpiredOtpCooldowns(data);
      if (!Array.isArray(data.otpCooldowns)) data.otpCooldowns = [];
      data.otpCooldowns = data.otpCooldowns.filter(entry => String(entry?.buyerId || '') !== bid);
      data.otpCooldowns.push({ buyerId: bid, until, reason: 'otp_timeout', orderId: String(orderId), createdAt: new Date().toISOString() });
      atomicWriteJson(file, data);
      changed++;
    } catch {}
  }
  return changed;
}

function getSoldSessionsByOrderId(storeId, productId, orderId) {
  const dir = path.join(SESSIONS_DIR, storeId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const fname of fs.readdirSync(dir)) {
    if (!fname.startsWith(`${productId}_`) || !fname.endsWith('.session')) continue;
    const file = path.join(dir, fname);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (String(data.orderId || '') === String(orderId) && String(data.soldTo || '') !== '') {
        out.push({ type: 'telegram_session', data, file });
      }
    } catch {}
  }
  return out;
}

function markSessionOtpDeliveredByOrderId(storeId, orderId) {
  try {
    const dir = path.join(SESSIONS_DIR, String(storeId));
    if (!fs.existsSync(dir)) return false;

    let changed = false;

    for (const fname of fs.readdirSync(dir)) {
      if (!fname.endsWith('.session')) continue;

      const file = path.join(dir, fname);

      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (
          String(data.orderId || '') === String(orderId) &&
          String(data.soldTo || '') !== '' &&
          !data.otpDeliveredAt
        ) {
          data.otpDeliveredAt = new Date().toISOString();
          atomicWriteJson(file, data);
          changed = true;
        }
      } catch {}
    }

    return changed;
  } catch {
    return false;
  }
}
function markSessionDelivered(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.deliveredAt) return false;
    data.deliveredAt = new Date().toISOString();
    atomicWriteJson(file, data);
    return true;
  } catch { return false; }
}

function markSessionSold(file, buyerId, orderId) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));

    // Never overwrite an existing reservation.
    if (!data.loggedIn || data.soldTo || data.orderId) {
      return false;
    }

    if (!buyerId || !orderId) {
      return false;
    }

    data.soldTo = String(buyerId);
    data.orderId = String(orderId);
    data.soldAt = new Date().toISOString();
    data.deliveryState = 'reserved';

    atomicWriteJson(file, data);
    return true;
  } catch {
    return false;
  }
}

function markSessionDeliveryStarted(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));

    if (!data.soldTo || !data.orderId) return false;

    // Legacy/already-delivered session.
    if (data.deliveredAt || data.deliveryState === 'delivered') {
      return false;
    }

    // Telegram delivery may already have happened before a crash.
    // Never automatically send it again.
    if (data.deliveryState === 'delivery_started') {
      return false;
    }

    data.deliveryState = 'delivery_started';
    data.deliveryStartedAt = new Date().toISOString();

    atomicWriteJson(file, data);
    return true;
  } catch {
    return false;
  }
}

function markSessionDeliveryDelivered(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));

    if (!data.soldTo || !data.orderId) return false;
    if (data.deliveredAt) return false;

    data.deliveryState = 'delivered';
    data.deliveredAt = new Date().toISOString();

    atomicWriteJson(file, data);
    return true;
  } catch {
    return false;
  }
}

function getSessionDeliveryState(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));

    // Backward compatibility:
    // session lama belum memiliki deliveryState, tetapi jika deliveredAt
    // sudah ada berarti akun tersebut sudah berhasil dikirim.
    if (data.deliveredAt) return 'delivered';
    if (data.deliveryState) return String(data.deliveryState);

    return 'reserved';
  } catch {
    return 'unknown';
  }
}


function restoreTimedOutOrderSessions(storeId, productId, orderId, buyerId, options = {}) {
  const dir = path.join(SESSIONS_DIR, String(storeId));
  if (!fs.existsSync(dir)) return 0;

  const targetOrder = String(orderId || '');
  const targetBuyer = String(buyerId || '');
  const selectedTelegramId = String(options.selectedSessionTelegramId || '');
  const cooldownMs = Number(options.cooldownMs || 0);
  const cooldownReason = String(options.cooldownReason || 'otp_timeout');
  let released = 0;

  for (const fname of fs.readdirSync(dir)) {
    if (!fname.endsWith('.session')) continue;
    if (productId && !fname.startsWith(`${String(productId)}_`)) continue;

    const file = path.join(dir, fname);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const orderMatch = targetOrder && String(data.orderId || '') === targetOrder;
      const selectedMatch = selectedTelegramId && String(data.telegramId || '') === selectedTelegramId;
      const buyerMatch = !targetBuyer || String(data.soldTo || '') === targetBuyer;

      if (!buyerMatch || (!orderMatch && !selectedMatch)) continue;
      if (data.otpDeliveredAt) continue;

      pruneExpiredOtpCooldowns(data);
      if (cooldownMs > 0 && targetBuyer) {
        if (!Array.isArray(data.otpCooldowns)) data.otpCooldowns = [];
        data.otpCooldowns = data.otpCooldowns.filter(entry => String(entry?.buyerId || '') !== targetBuyer);
        data.otpCooldowns.push({
          buyerId: targetBuyer,
          until: Date.now() + cooldownMs,
          reason: cooldownReason,
          orderId: targetOrder,
          createdAt: new Date().toISOString(),
        });
      }

      delete data.soldTo;
      delete data.orderId;
      delete data.soldAt;
      delete data.deliveryState;
      delete data.deliveryStartedAt;
      delete data.deliveredAt;
      delete data.otpDeliveredAt;
      atomicWriteJson(file, data);
      released++;
    } catch (err) {
      logger.warn?.(`[SessionRecovery] gagal restore ${fname}: ${err.message}`);
    }
  }

  return released;
}

function releaseSessionReservationByOrderId(storeId, orderId, options = {}) {
  const dir = path.join(SESSIONS_DIR, storeId);
  if (!fs.existsSync(dir)) return 0;

  let released = 0;

  for (const fname of fs.readdirSync(dir)) {
    if (!fname.endsWith('.session')) continue;

    const file = path.join(dir, fname);

    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));

      if (
        String(data.orderId || '') !== String(orderId) ||
        String(data.soldTo || '') === ''
      ) {
        continue;
      }

      /*
       * Normal rollback hanya melepas reservation yang belum dikirim.
       * Timeout OTP adalah pengecualian: selama otpDeliveredAt belum ada,
       * order dianggap belum berhasil dan session harus kembali ke stock,
       * termasuk session yang sudah sempat dikirim ke buyer tetapi login
       * belum pernah berhasil.
       */
      const deliveryState = String(
        data.deliveryState ||
        (data.deliveredAt ? 'delivered' : 'reserved')
      );

      if (options.beforeOtpOnly) {
        if (data.otpDeliveredAt) continue;
      } else {
        if (deliveryState !== 'reserved') continue;
        if (data.deliveredAt) continue;
      }

      if (options.cooldownBuyerId && Number(options.cooldownMs || 0) > 0) {
        const bid = String(options.cooldownBuyerId);
        pruneExpiredOtpCooldowns(data);
        if (!Array.isArray(data.otpCooldowns)) data.otpCooldowns = [];
        data.otpCooldowns = data.otpCooldowns.filter(entry => String(entry?.buyerId || '') !== bid);
        data.otpCooldowns.push({
          buyerId: bid,
          until: Date.now() + Number(options.cooldownMs),
          reason: String(options.cooldownReason || 'otp_timeout'),
          orderId: String(orderId),
          createdAt: new Date().toISOString(),
        });
      }

      delete data.soldTo;
      delete data.orderId;
      delete data.soldAt;
      delete data.deliveryState;
      delete data.deliveryStartedAt;

      atomicWriteJson(file, data);
      released++;
    } catch {}
  }

  return released;
}

async function syncStockCount(storeId, productId) {
  const count = countAvailableSessions(storeId, productId);
  const Product = require('../models/Product');
  const Store = require('../models/Store');
  const Notification = require('./notificationService');
  const product = await Product.findOne({ _id: productId, storeId });
  if (product) {
    const previousCount = Number(product.stockCount || 0);
    const notifiedAt = product.metadata?.stockEmptyNotifiedAt || null;

    if (count > 0) {
      await Product.findOneAndUpdate(
        { _id: productId, storeId },
        {
          $set: { stockCount: count, status: 'active' },
          $unset: { 'metadata.stockEmptyNotifiedAt': true },
        }
      );
    } else {
      await Product.findOneAndUpdate(
        { _id: productId, storeId },
        { $set: { stockCount: 0, status: 'out_of_stock' } }
      );

      if (!notifiedAt && (previousCount > 0 || product.status !== 'out_of_stock')) {
        try {
          const store = await Store.findOne({ storeId });
          const BotManager = require('../core/BotManager');
          const bot = BotManager.getBot(storeId);
          const sent = await Notification.stockEmpty(bot, product, store?.ownerId || null);
          if (sent) {
            await Product.findOneAndUpdate(
              { _id: productId, storeId },
              { $set: { 'metadata.stockEmptyNotifiedAt': new Date().toISOString() } }
            );
          }
        } catch (err) {
          logger.warn(`[StockWarning] gagal kirim notifikasi stok habis | product=${productId}: ${err.message}`);
        }
      }
    }
  }
  return count;
}

function otpWaiterKey(buyerId, orderId) {
  return `${String(buyerId)}:${String(orderId)}`;
}

function otpListenerKey(buyerId, orderId) {
  return `${String(buyerId)}:${String(orderId)}`;
}

function registerOtpWaiter(buyerId, info) {
  const orderId = String(info?.orderId || '');
  if (!orderId) throw new Error('orderId wajib untuk OTP waiter.');

  const key = otpWaiterKey(buyerId, orderId);

  const registeredAt = Date.now();

  otpWaiters.set(key, {
    ...info,
    buyerId: String(buyerId),
    orderId,
    registeredAt,
  });
}

function getOtpWaiter(buyerId, orderId) {
  if (!orderId) return null;
  return otpWaiters.get(otpWaiterKey(buyerId, orderId));
}

function clearOtpWaiter(buyerId, orderId) {
  if (orderId) {
    otpWaiters.delete(otpWaiterKey(buyerId, orderId));
    return;
  }

  const prefix = `${String(buyerId)}:`;
  for (const key of otpWaiters.keys()) {
    if (key.startsWith(prefix)) otpWaiters.delete(key);
  }
}


  /*
   * Terapkan profile color stock ke akun Telegram buyer.
   *
   * Tidak boleh menggagalkan delivery:
   * - Premium + color valid  -> color diterapkan.
   * - Non-Premium / API error -> hanya warning, delivery tetap lanjut.
   */
  async function applyTelegramProfileColor(client, profileColor) {
    const colorId = Number(profileColor?.id);

    if (!Number.isInteger(colorId) || colorId < 0) {
      return { applied: false, skipped: true, reason: 'profileColor tidak valid' };
    }

    try {
      const Api = require('telegram').Api;

      if (!Api?.account?.UpdateColor) {
        return { applied: false, skipped: true, reason: 'API tidak tersedia' };
      }

      await client.invoke(new Api.account.UpdateColor({
        forProfile: true,
        color: colorId,
      }));

      logger.info(`[ProfileColor] berhasil diterapkan | colorId=${colorId}`);

      return { applied: true, colorId };
    } catch (err) {
      const msg = String(err?.message || err?.errorMessage || err || '');

      if (
        msg.includes('PREMIUM_ACCOUNT_REQUIRED') ||
        msg.includes('PREMIUM_REQUIRED')
      ) {
        logger.info(
          `[ProfileColor] dilewati: akun bukan Premium | colorId=${colorId}`
        );

        return {
          applied: false,
          skipped: true,
          reason: 'PREMIUM_ACCOUNT_REQUIRED',
        };
      }

      logger.warn(
        `[ProfileColor] gagal diterapkan | colorId=${colorId} | ${msg}`
      );

      return { applied: false, skipped: false, reason: msg };
    }
  }


async function expireOtpOrder(storeId, orderId, buyerId) {
  const { withInventoryLock } = require('../utils/inventoryLock');
  const Order = require('../models/Order');
  const BuyerWallet = require('../models/BuyerWallet');

  const sid = String(storeId);
  const oid = String(orderId);
  const bid = String(buyerId);
  const now = new Date().toISOString();

  let order = await Order.findOne({
    orderId: oid,
    storeId: sid,
    buyerId: bid,
  });

  if (!order) {
    return { success: false, refunded: false, reason: 'order_not_found' };
  }

  // OTP yang sudah diterima selalu menang. Jangan pernah rollback stock/refund
  // apabila event OTP datang sebelum worker timeout sempat mengklaim order.
  if (String(order?.metadata?.otpStatus || '') === 'delivered' || order?.metadata?.otpDeliveredAt) {
    return { success: false, refunded: false, reason: 'otp_already_delivered' };
  }

  const pendingUntil = order?.metadata?.otpPendingUntil
    ? Date.parse(order.metadata.otpPendingUntil)
    : NaN;
  const timeoutAt = order?.metadata?.otpTimeoutAt;
  const alreadyTimedOut = String(order?.metadata?.otpStatus || '') === 'timeout' && !!timeoutAt;

  if (!alreadyTimedOut) {
    if (String(order?.metadata?.otpStatus || '') !== 'pending') {
      return { success: false, refunded: false, reason: 'otp_not_pending' };
    }
    if (Number.isFinite(pendingUntil) && pendingUntil > Date.now()) {
      return { success: false, refunded: false, reason: 'otp_not_due' };
    }
  }

  const amount = Number(order.totalAmount || 0);
  const isWallet = String(order.paymentMethod || '') === 'wallet';

  // Claim timeout atomically. Hanya satu worker boleh membuat order menjadi
  // timeout; event OTP yang sudah lebih dahulu menandai delivered tidak bisa
  // ikut terambil oleh filter ini.
  if (!alreadyTimedOut) {
    const claimed = await Order.findOneAndUpdate(
      {
        orderId: oid,
        storeId: sid,
        buyerId: bid,
        status: { $in: ['paid', 'completed'] },
        'metadata.otpStatus': 'pending',
        'metadata.otpPendingUntil': { $lte: now },
        'metadata.otpTimeoutAt': { $exists: false },
      },
      {
        $set: {
          status: 'failed',
          notes: 'OTP tidak diterima dalam 10 menit',
          'metadata.otpStatus': 'timeout',
          'metadata.otpTimeoutAt': now,
          'metadata.otpRefunded': false,
          'metadata.otpRefundAmount': 0,
          'metadata.otpRefundRequired': isWallet && amount > 0,
          'metadata.otpStockReleased': false,
          'metadata.otpRefundReason': 'OTP tidak diterima dalam 10 menit',
          'metadata.otpCooldownUntil': new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        },
        $unset: {
          'metadata.otpPendingUntil': true,
        },
      },
      { new: true }
    );

    if (!claimed) {
      const latest = await Order.findOne({ orderId: oid, storeId: sid, buyerId: bid });
      if (!latest) return { success: false, refunded: false, reason: 'order_not_found' };
      if (latest?.metadata?.otpDeliveredAt || latest?.metadata?.otpStatus === 'delivered') {
        return { success: false, refunded: false, reason: 'otp_already_delivered' };
      }
      if (latest?.metadata?.otpStatus !== 'timeout' || !latest?.metadata?.otpTimeoutAt) {
        return { success: false, refunded: false, reason: 'timeout_claim_lost' };
      }
      order = latest;
    } else {
      order = claimed;
    }
  }

  // Refund bersifat idempotent lewat transactionId tetap. Jika proses crash
  // sesudah refund tetapi sebelum flag disimpan, retry hanya akan menerima
  // duplicate=true dan tidak menggandakan saldo.
  if (
    order?.metadata?.otpRefundRequired === true &&
    order?.metadata?.otpRefunded !== true &&
    amount > 0
  ) {
    const credit = await BuyerWallet.credit(sid, bid, amount, {
      orderId: oid,
      transactionId: `order:${oid}:refund:otp_timeout`,
      source: 'otp_timeout_refund',
      reason: 'OTP tidak diterima dalam 10 menit',
    });

    await Order.findOneAndUpdate(
      { orderId: oid, storeId: sid, buyerId: bid, 'metadata.otpStatus': 'timeout' },
      {
        $set: {
          'metadata.otpRefunded': true,
          'metadata.otpRefundAmount': amount,
          'metadata.otpRefundTransactionId': `order:${oid}:refund:otp_timeout`,
          'metadata.otpRefundedAt': new Date().toISOString(),
        },
      },
      { new: true }
    );

    order = await Order.findOne({ orderId: oid, storeId: sid, buyerId: bid });
    logger.info(
      `[OtpTimeout] refund ${credit.duplicate ? 'already applied' : 'applied'} | order=${oid} | buyer=${bid} | amount=${amount}`
    );
  }

  // Stock rollback wajib dilakukan setelah timeout diklaim. Dengan begitu,
  // OTP yang datang di antara polling dan rollback tidak akan kehilangan stock.
  const productId = String(order?.productId || '');
  if (!productId) throw new Error(`Product ID tidak ditemukan untuk order ${oid}.`);

  if (order?.metadata?.otpStockReleased !== true) {
    await withInventoryLock(sid, productId, async () => {
      // Timeout cleanup hanya me-release reservation untuk order ini. File
      // session TIDAK pernah dihapus; setelah soldTo/orderId dibersihkan, file
      // kembali terhitung sebagai stock aktif.
      const selectedSessionTelegramId = String(order?.metadata?.selectedSessionTelegramId || '');
      let released = restoreTimedOutOrderSessions(
        sid,
        productId,
        oid,
        bid,
        {
          selectedSessionTelegramId,
          cooldownMs: 2 * 60 * 60 * 1000,
          cooldownReason: 'otp_timeout',
        }
      );

      if (!released) {
        released = releaseSessionReservationByOrderId(
          sid,
          oid,
          {
            beforeOtpOnly: true,
            cooldownBuyerId: bid,
            cooldownMs: 2 * 60 * 60 * 1000,
            cooldownReason: 'otp_timeout',
          }
        );
      }

      await syncStockCount(sid, productId);

      await Order.findOneAndUpdate(
        { orderId: oid, storeId: sid, buyerId: bid, 'metadata.otpStatus': 'timeout' },
        { $set: { 'metadata.otpStockReleased': true, 'metadata.otpStockReleasedAt': new Date().toISOString() } },
        { new: true }
      );

      logger.info(
        `[OtpTimeout] stock returned | order=${oid} | released=${released} | product=${productId}`
      );
    });
  }

  order = await Order.findOne({ orderId: oid, storeId: sid, buyerId: bid });
  const refunded = order?.metadata?.otpRefunded === true;

  // Notify the buyer exactly once. This also covers cron-based timeout recovery
  // after a process restart, not only the in-memory GramJS listener timeout.
  if (order && order?.metadata?.otpTimeoutNotified !== true) {
    try {
      const BotManager = require('../core/BotManager');
      const bot = BotManager.getBot(sid);
      if (bot) {
        await bot.telegram.sendMessage(
          bid,
          `❌ OTP tidak diterima dalam waktu 10 menit.\n` +
          `Pesanan dibatalkan otomatis.\n` +
          `Saldo telah dikembalikan dan akun dikembalikan ke stok.\n` +
          `Silahkan beli ulang pakai nomor lain.`,
          { parse_mode: 'Markdown' }
        );
        await Order.findOneAndUpdate(
          { orderId: oid, storeId: sid, buyerId: bid, 'metadata.otpStatus': 'timeout' },
          { $set: { 'metadata.otpTimeoutNotified': true } },
          { new: true }
        );
      }
    } catch (notifyErr) {
      logger.warn(`[OtpTimeout] gagal kirim notifikasi buyer | order=${oid}: ${notifyErr.message}`);
    }
  }

  return {
    success: true,
    duplicate: alreadyTimedOut,
    refunded,
    amount: Number(order?.metadata?.otpRefundAmount || 0),
  };
}

async function cancelOtpOrder(storeId, orderId, buyerId) {
  const { withInventoryLock } = require('../utils/inventoryLock');
  const Order = require('../models/Order');
  const BuyerWallet = require('../models/BuyerWallet');

  const sid = String(storeId);
  const oid = String(orderId);
  const bid = String(buyerId);
  const order = await Order.findOne({ orderId: oid, storeId: sid, buyerId: bid });

  if (!order) return { success: false, reason: 'Order tidak ditemukan.' };
  if (order?.metadata?.otpStatus === 'delivered' || order?.metadata?.otpDeliveredAt) {
    return { success: false, reason: 'otp_already_delivered' };
  }
  if (!['paid', 'completed'].includes(String(order.status))) {
    return { success: false, reason: `Order tidak dapat dibatalkan dari status ${order.status}.` };
  }

  const amount = Number(order.totalAmount || 0);
  const isWallet = String(order.paymentMethod || '') === 'wallet';
  const claimed = await Order.findOneAndUpdate(
    {
      orderId: oid,
      storeId: sid,
      buyerId: bid,
      status: { $in: ['paid', 'completed'] },
      'metadata.otpStatus': { $ne: 'delivered' },
      'metadata.otpDeliveredAt': { $exists: false },
      'metadata.otpCancelAt': { $exists: false },
    },
    {
      $set: {
        status: 'failed',
        notes: 'Dibatalkan oleh pembeli sebelum monitoring OTP',
        'metadata.otpStatus': 'cancelled',
        'metadata.otpCancelAt': new Date().toISOString(),
        'metadata.otpRefunded': false,
        'metadata.otpRefundAmount': 0,
        'metadata.otpStockReleased': false,
        'metadata.otpRefundRequired': isWallet && amount > 0,
        'metadata.otpRefundReason': 'Dibatalkan oleh pembeli sebelum monitoring OTP',
      },
      $unset: {
        'metadata.otpPendingUntil': true,
        'metadata.otpTimeoutAt': true,
      },
    },
    { new: true }
  );

  if (!claimed) {
    const latest = await Order.findOne({ orderId: oid, storeId: sid, buyerId: bid });
    if (latest?.metadata?.otpDeliveredAt || latest?.metadata?.otpStatus === 'delivered') {
      return { success: false, reason: 'otp_already_delivered' };
    }
    return { success: false, reason: 'Pesanan sudah diproses atau sedang dibatalkan.' };
  }

  if (isWallet && amount > 0) {
    const txId = `order:${oid}:refund:otp_cancel`;
    const credit = await BuyerWallet.credit(sid, bid, amount, {
      orderId: oid,
      transactionId: txId,
      source: 'otp_cancel_refund',
      reason: 'Pembeli membatalkan proses OTP sebelum monitoring dimulai',
    });

    await Order.findOneAndUpdate(
      { orderId: oid, storeId: sid, buyerId: bid, 'metadata.otpStatus': 'cancelled' },
      {
        $set: {
          'metadata.otpRefunded': true,
          'metadata.otpRefundAmount': amount,
          'metadata.otpRefundTransactionId': txId,
          'metadata.otpRefundedAt': new Date().toISOString(),
        },
      },
      { new: true }
    );

    logger.info(`[OtpCancel] refund ${credit.duplicate ? 'already applied' : 'applied'} | order=${oid} | amount=${amount}`);
  }

  const productId = String(claimed.productId || '');
  if (!productId) throw new Error(`Product ID tidak ditemukan untuk order ${oid}.`);

  await withInventoryLock(sid, productId, async () => {
    const released = releaseSessionReservationByOrderId(sid, oid, { beforeOtpOnly: true });
    await syncStockCount(sid, productId);
    await Order.findOneAndUpdate(
      { orderId: oid, storeId: sid, buyerId: bid, 'metadata.otpStatus': 'cancelled' },
      { $set: { 'metadata.otpStockReleased': true, 'metadata.otpStockReleasedAt': new Date().toISOString() } },
      { new: true }
    );
    logger.info(`[OtpCancel] stock returned | order=${oid} | released=${released} | product=${productId}`);
  });

  clearOtpWaiter(bid, oid);
  await stopOtpListener(bid, oid);

  return {
    success: true,
    refunded: isWallet && amount > 0,
    amount: isWallet && amount > 0 ? amount : 0,
  };
}

async function startOtpListener(bot, storeId, buyerId, orderId, phone, sessionString, productName, profileColor = null, twoFaPassword = null) {
  const bId = String(buyerId);
  const oId = String(orderId);
  const listenerKey = otpListenerKey(bId, oId);

  await stopOtpListener(bId, oId);

  // Persist the OTP deadline so timeout/refund still happens after a process restart.
  try {
    const Order = require('../models/Order');
    await Order.findOneAndUpdate(
      { orderId: oId, storeId: String(storeId), buyerId: bId },
      {
        $set: {
          'metadata.otpStatus': 'pending',
          'metadata.otpPendingUntil': new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          'metadata.otpMonitoringStartedAt': new Date().toISOString(),
          ...(phone ? { 'metadata.sessionPhone': String(phone) } : {}),
        },
        $unset: {
          'metadata.otpTimeoutAt': true,
          'metadata.otpRefunded': true,
          'metadata.otpRefundAmount': true,
        },
      },
      { new: true }
    );
  } catch (err) {
    logger.warn(`[OtpListener] gagal menyimpan deadline OTP | order=${oId}: ${err.message}`);
  }

  if (!TelegramClient || !StringSession || !NewMessage) {
    throw new Error(
      `Modul Telegram gagal dimuat: ${telegramLoadError?.message || 'dependency tidak tersedia'}.`
    );
  }

  const apiId = parseInt(process.env.TG_API_ID || '0', 10);
  const apiHash = String(process.env.TG_API_HASH || '').trim();

  if (!apiId || !apiHash) {
    throw new Error('TG_API_ID / TG_API_HASH belum diset.');
  }

  const client = new TelegramClient(
    new StringSession(String(sessionString || '')),
    apiId,
    apiHash,
    {
      connectionRetries: 5,
      requestRetries: 3,
      autoReconnect: true,
      // Jangan gunakan WSS untuk listener GramJS server-side.
      useWSS: false,
    }
  );

  /*
   * Penting:
   * Listener OTP tidak boleh membuat proses checkout ikut menggantung
   * hanya karena update loop GramJS mengalami timeout.
   */
  try {
    await client.connect();

    // Profile color harus diterapkan pada sesi akun buyer.
    // Error di sini TIDAK boleh menggagalkan proses OTP/delivery.
    await applyTelegramProfileColor(client, profileColor);
  } catch (err) {
    try {
      await client.disconnect();
    } catch {}

    throw new Error(`Gagal menghubungkan sesi Telegram OTP: ${err.message || err}`);
  }

  let stopped = false;
  let otpDelivered = false;

  const cleanup = async (sendExpiredMessage = false, refundTimedOutOrder = false, releaseReservation = true) => {
    if (stopped) return;
    stopped = true;

    const entry = otpListeners.get(listenerKey);
    if (entry?.timeout) clearTimeout(entry.timeout);

    const listener = otpListeners.get(listenerKey);
    otpListeners.delete(listenerKey);

    if (listener?.orderId) {
      otpWaiters.delete(otpWaiterKey(bId, listener.orderId));
    }

    /*
     * Jika OTP belum pernah diterima sampai listener berhenti/timeout,
     * reservation session dikembalikan ke stock.
     *
     * Jika OTP sudah diterima, otpDeliveredAt sudah ditulis dan
     * reservation TIDAK boleh dikembalikan.
     */
    if (!otpDelivered && refundTimedOutOrder) {
      try {
        await expireOtpOrder(storeId, orderId, buyerId);
      } catch (err) {
        logger.error(
          `[OtpListener] timeout cleanup gagal | order=${orderId}: ${err.message}`
        );
      }
    }

    try {
      await client.disconnect();
    } catch {}

    // expireOtpOrder() sendiri mengirim notifikasi timeout secara idempotent.
    // Dengan begitu timeout recovery dari cron juga memberi tahu buyer tanpa
    // membuat pesan timeout ganda ketika listener masih hidup.
    void sendExpiredMessage;
  };

  const timeout = setTimeout(() => {
    cleanup(true, true).catch(err => {
      logger.warn(`[OtpListener] cleanup timeout gagal: ${err.message}`);
    });
  }, 10 * 60 * 1000);

  otpListeners.set(listenerKey, {
    client,
    timeout,
    cleanup,
    orderId: String(orderId),
  });

  /*
   * Hanya proses pesan masuk.
   * Telegram biasanya mengirim kode login dari akun service 777000.
   */
  client.addEventHandler(
    async event => {
      if (stopped) return;

      try {
        const message = event?.message;
        if (!message) return;

        const text = String(message.message || '').trim();
        if (!text) return;

        const senderId =
          message?.senderId?.toString?.() ||
          message?.fromId?.userId?.toString?.() ||
          '';

        const isTelegramService =
          senderId === '777000' ||
          senderId === '42777';

        /*
         * OTP login Telegram normalnya berasal dari 777000.
         * Untuk pesan non-service, tetap izinkan pesan yang memang
         * mengandung kode 5-6 digit agar flow kompatibel.
         */
        const otpMatch = text.match(/\b(\d{5,6})\b/);

        if (!isTelegramService && !otpMatch) return;

        const otpCode = otpMatch?.[1] || null;

        if (otpCode && otpDelivered) {
          logger.info(`[OtpListener] OTP duplicate diabaikan untuk order ${orderId}`);
          return;
        }

        if (otpCode) {
          otpDelivered = true;


            // OTP sudah diterima buyer.
            // Baru pada titik ini session dianggap benar-benar keluar dari stok.
            try {
              markSessionOtpDeliveredByOrderId(storeId, orderId);
            } catch (stockErr) {
              logger.warn(
                `[OtpListener] gagal menandai session keluar dari stok: ${stockErr.message}`
              );
            }

            try {
              const Order = require('../models/Order');
              await Order.findOneAndUpdate(
                { orderId, storeId, buyerId: String(buyerId) },
                {
                  $set: {
                    'metadata.otpStatus': 'delivered',
                    'metadata.otpDeliveredAt': new Date().toISOString(),
                  },
                  $unset: {
                    'metadata.otpPendingUntil': true,
                    'metadata.otpTimeoutAt': true,
                  },
                },
                { new: true }
              );
            } catch (orderErr) {
              logger.warn(
                `[OtpListener] gagal mencatat OTP delivered | order=${orderId}: ${orderErr.message}`
              );
            }

          try {
            const BotManager = require('../core/BotManager');
            const Order = require('../models/Order');

            const order = await Order.findOne({ orderId });

            await Notification.otpEvent(
              BotManager.getBot(storeId),
              {
                username: order?.buyerUsername,
                userId: buyerId,
                quantity: order?.quantity || 1,
                productName: order?.productName || productName || 'Akun Telegram',
                totalAmount: order?.totalAmount || 0,
                orderId,
              }
            );
          } catch (err) {
            logger.warn(
              `[SessionService] OTP notification failed: ${err.message}`
            );
          }
        }

        const msg = otpCode
          ? `🔐 *KODE LOGIN — LOGIN ULANG*

📱 Nomor: \`+${phone}\`
📦 Produk: ${productName}
🆔 Order: \`${orderId}\`

*Kode login:*
\`\`\`
${otpCode}
\`\`\`
${twoFaPassword ? `\n🔑 *Sandi 2FA:* \`${twoFaPassword}\`\n` : ''}
Masukkan kode ini di Telegram untuk melanjutkan login.

⚠️ Jangan bagikan kode ini kepada siapa pun.`
          : `📩 *Pesan masuk di nomor +${phone}:*

${text}

🆔 Order: \`${orderId}\``;

        try {
          await bot.telegram.sendMessage(
            bId,
            msg,
            {
              parse_mode: 'Markdown',
              reply_markup: otpCode
                ? buyerKeyboard.otpReadyMenu(orderId).reply_markup
                : undefined,
            }
          );

          if (otpCode) {
            logger.info(
              `[OtpListener] ✅ OTP berhasil dikirim ke buyer ${bId} untuk order ${orderId}`
            );
          }
        } catch (err) {
          /*
           * Kalau pengiriman ke buyer gagal, jangan matikan GramJS listener.
           * Buyer masih bisa menerima update berikutnya.
           */
          logger.error(
            `[OtpListener] gagal mengirim pesan ke buyer ${bId}: ${err.message}`
          );
        }
      } catch (err) {
        /*
         * Error satu event tidak boleh mematikan listener.
         */
        logger.error(`[OtpListener] event error: ${err.message}`);
      }
    },
    new NewMessage({ incoming: true })
  );

  logger.info(
    `[OtpListener] ✅ listener aktif | buyer=${bId} | order=${orderId} | phone=+${phone}`
  );

  /*
   * startOtpListener hanya menyiapkan listener.
   * Jangan menunggu update loop di sini.
   */
  return {
    success: true,
    buyerId: bId,
    orderId: String(orderId),
    phone: String(phone),
    listening: true,
  };
}

function getSessionStringByOrderId(orderId) {
  if (!fs.existsSync(SESSIONS_DIR)) return null;
  for (const storeId of fs.readdirSync(SESSIONS_DIR)) {
    const dir = path.join(SESSIONS_DIR, storeId);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const fname of fs.readdirSync(dir).filter(f => f.endsWith('.session'))) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8'));
        if (data.orderId === orderId && data.sessionString) return data.sessionString;
      } catch {}
    }
  }
  return null;
}

async function terminateOtherSessions(sessionString) {
  if (!TelegramClient || !StringSession) {
    throw new Error('Modul Telegram tidak tersedia.');
  }

  const apiId = parseInt(process.env.TG_API_ID || '0', 10);
  const apiHash = String(process.env.TG_API_HASH || '').trim();

  if (!apiId || !apiHash) {
    throw new Error('TG_API_ID / TG_API_HASH belum diset.');
  }

  if (!String(sessionString || '').trim()) {
    throw new Error('Session Telegram tidak ditemukan.');
  }

  const client = new TelegramClient(
    new StringSession(String(sessionString)),
    apiId,
    apiHash,
    {
      connectionRetries: 3,
      requestRetries: 2,
      autoReconnect: false,
      useWSS: false,
    }
  );

  try {
    await client.connect();

    const Api = require('telegram').Api;

    // Logout SESI BOT yang sedang terhubung.
    // Tidak menggunakan ResetAuthorizations karena method tersebut
    // mempertahankan sesi saat ini dan justru mengeluarkan sesi lain.
    await client.invoke(new Api.auth.LogOut({}));

    return true;
  } finally {
    try {
      await client.disconnect();
    } catch {}
  }
}

async function stopOtpListener(buyerId, orderId = null, options = {}) {
  const bId = String(buyerId);

  // Jika orderId diberikan, hentikan listener OTP untuk
  // buyer + order tersebut saja.
  if (orderId) {
    const oId = String(orderId);
    const key = otpListenerKey(bId, oId);
    const entry = otpListeners.get(key);

    if (!entry) {
      clearOtpWaiter(bId, oId);
      return;
    }

    /*
     * Gunakan cleanup yang sama dengan timeout agar reservation
     * dikembalikan bila OTP belum pernah diterima.
     */
    if (typeof entry.cleanup === 'function') {
      await entry.cleanup(false, false, options.releaseReservation === true);
      return;
    }

    clearTimeout(entry.timeout);

    try {
      await entry.client.disconnect();
    } catch {}

    otpListeners.delete(key);
    clearOtpWaiter(bId, oId);
    return;
  }

  // Backward-compatible fallback:
  // jika orderId tidak diberikan, hentikan SEMUA listener buyer.
  const prefix = `${bId}:`;
  const keys = [];

  for (const key of otpListeners.keys()) {
    if (key.startsWith(prefix)) {
      keys.push(key);
    }
  }

  for (const key of keys) {
    const entry = otpListeners.get(key);

    if (!entry) continue;

    if (typeof entry.cleanup === 'function') {
      await entry.cleanup(false, false, options.releaseReservation === true);
    } else {
      clearTimeout(entry.timeout);
      try {
        await entry.client.disconnect();
      } catch {}
      otpListeners.delete(key);

      if (entry.orderId) {
        clearOtpWaiter(bId, entry.orderId);
      }
    }
  }

  clearOtpWaiter(bId);
}

function getActiveClient(storeId, productId) {
  return activeClients.get(sessionKey(storeId, productId));
}


/**
 * Hapus seluruh session Telegram yang tersimpan di disk.
 *
 * Tidak menghapus database, user, saldo, order, product, atau konfigurasi.
 * File session admin-restock juga ikut dibersihkan karena operasi ini
 * memang dimaksudkan sebagai reset seluruh akun Telegram yang tersimpan.
 */
async function clearAllStoredSessions() {
  const removed = [];
  const failed = [];

  const dirs = [
    SESSIONS_DIR,
    path.join(__dirname, '..', '..', 'data', 'seller_sessions'),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    for (const storeId of fs.readdirSync(dir)) {
      const storeDir = path.join(dir, storeId);

      let stat;
      try {
        stat = fs.statSync(storeDir);
      } catch {
        continue;
      }

      if (!stat.isDirectory()) continue;

      for (const filename of fs.readdirSync(storeDir)) {
        if (!filename.endsWith('.session')) continue;

        const file = path.join(storeDir, filename);

        try {
          fs.unlinkSync(file);
          removed.push(path.relative(path.join(__dirname, '..', '..', 'data'), file));
        } catch (err) {
          failed.push({
            path: path.relative(path.join(__dirname, '..', '..', 'data'), file),
            error: err.message,
          });
        }
      }
    }
  }

  // Putuskan client yang masih aktif di memory.
  for (const [key, client] of activeClients.entries()) {
    try {
      if (client && typeof client.disconnect === 'function') {
        await client.disconnect();
      }
    } catch (err) {
      logger.warn(`[SessionService] gagal disconnect ${key}: ${err.message}`);
    }
    activeClients.delete(key);
  }

  // Hentikan listener OTP yang masih aktif.
  for (const [key, entry] of otpListeners.entries()) {
    try {
      if (typeof entry.cleanup === 'function') {
        await entry.cleanup(false);
      } else {
        if (entry.timeout) clearTimeout(entry.timeout);
        if (entry.client && typeof entry.client.disconnect === 'function') {
          await entry.client.disconnect();
        }
      }
    } catch (err) {
      logger.warn(`[SessionService] gagal cleanup OTP ${key}: ${err.message}`);
    }

    otpListeners.delete(key);
  }

  pendingSessions.clear();
  otpWaiters.clear();

  return {
    removedCount: removed.length,
    failedCount: failed.length,
    removed,
    failed,
  };
}

module.exports = {
  startTelegramLogin,
  submitTelegramOTP,
  submitTelegramPassword,
  getAvailableSession,
  getAvailableSessionByTelegramId,
  getAvailableSessionDetails,
  countAvailableSessionsForBuyer: (storeId, productId, buyerId) => countAvailableSessions(storeId, productId, buyerId),
  addBuyerOtpCooldownByOrderId,
  getSoldSessionsByOrderId,
  markSessionSold,
    markSessionOtpDeliveredByOrderId,
    releaseSessionReservationByOrderId,
    restoreTimedOutOrderSessions,
    markSessionDelivered,
markSessionDeliveryStarted,
markSessionDeliveryDelivered,
getSessionDeliveryState,
  countAvailableSessions,
  syncStockCount,
  registerOtpWaiter,
  getOtpWaiter,
  clearOtpWaiter,
  startOtpListener,
  terminateOtherSessions,
  getSessionStringByOrderId,
  stopOtpListener,
  activeClients,
  getActiveClient,
  getTelegramProfileColor,
  setPending,
  getPending,
  clearPending,
  expireOtpOrder,
  cancelOtpOrder,
  clearAllStoredSessions,
};
