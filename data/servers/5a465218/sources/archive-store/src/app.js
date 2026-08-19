'use strict';

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');
['logs', 'uploads', 'data', 'data/sessions', 'data/seller_sessions'].forEach(dir => {
  const p = path.join(__dirname, '..', dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

const logger = require('./utils/logger');
const database = require('./database/connection');
const Store = require('./models/Store');
const User = require('./models/User');
const AuditLog = require('./models/AuditLog');
const BotManager = require('./core/BotManager');
const StoreLoader = require('./core/StoreLoader');
const Validators = require('./utils/validators');
const OrderService = require('./services/orderService');
const RecoveryService = require('./services/recoveryService');
const cron = require('node-cron');
const Topup = require('./models/Topup');
const WalletService = require('./services/walletService');
const Valqenix = require('./payments/valqenix');
const Backup = require('./services/backupService');

const SINGLE_STORE_ID = process.env.STORE_ID || 'main';

Backup.startSchedule();

function envRequired(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} belum diset di .env`);
  return value;
}

async function ensureOwner(ownerId) {
  let user = await User.findOne({ telegramId: String(ownerId) });
  if (!user) {
    user = await User.create({
      telegramId: String(ownerId),
      role: 'owner',
      maxStores: 1,
      stores: [SINGLE_STORE_ID],
    });
  } else {
    await User.findOneAndUpdate(
      { telegramId: String(ownerId) },
      { $set: { role: 'owner', maxStores: 1, stores: [SINGLE_STORE_ID] } }
    );
  }
  return user;
}

async function ensureSingleStore() {
  const token = envRequired('PLATFORM_BOT_TOKEN');
  const ownerId = envRequired('PLATFORM_OWNER_ID');

  if (!Validators.isBotTokenFormat(token)) {
    throw new Error('PLATFORM_BOT_TOKEN format tidak valid.');
  }
  if (!Validators.isValidTelegramId(ownerId)) {
    throw new Error('PLATFORM_OWNER_ID tidak valid.');
  }

  const validation = await Validators.validateBotToken(token);
  if (!validation.valid) throw new Error(`PLATFORM_BOT_TOKEN tidak valid: ${validation.error}`);

  const botInfo = validation.bot;
  let store = await Store.findOne({ storeId: SINGLE_STORE_ID });

  // If an old single-store record exists, migrate it to the platform bot so
  // there is exactly one runtime and no separate SaaS/platform bot remains.
  if (!store) {
    store = await Store.create({
      storeId: SINGLE_STORE_ID,
      ownerId: String(ownerId),
      botToken: token,
      botUsername: botInfo.username,
      botId: String(botInfo.id),
      expiresAt: null,
      settings: {
        storeName: process.env.STORE_NAME || 'Telegram Store',
        welcomeMessage: '👋 Selamat datang di Telegram Store!',
        thankYouMessage: '✅ Terima kasih sudah berbelanja!',
      },
      status: 'active',
      botStatus: 'loading',
      lifecycleState: 'idle',
      runtimeConfig: { autoRestart: true, lastError: null, startedAt: null, restartCount: 0 },
    });
    await AuditLog.log({
      storeId: SINGLE_STORE_ID,
      actorId: ownerId,
      actorType: 'system',
      action: 'SINGLE_STORE_INITIALIZED',
      entity: 'Store',
      entityId: SINGLE_STORE_ID,
      details: { botUsername: botInfo.username },
      result: 'success',
    });
  } else {
    await Store.findOneAndUpdate(
      { storeId: SINGLE_STORE_ID },
      {
        $set: {
          ownerId: String(ownerId),
          botToken: token,
          botUsername: botInfo.username,
          botId: String(botInfo.id),
          status: 'active',
          expiresAt: null,
          'runtimeConfig.autoRestart': true,
        },
      }
    );
    store = await Store.findOne({ storeId: SINGLE_STORE_ID });
  }

  await ensureOwner(ownerId);

  // Any legacy active stores are no longer runnable in single-store mode.
  const active = await Store.find({ status: 'active' });
  for (const legacy of active) {
    if (String(legacy.storeId) === SINGLE_STORE_ID) continue;
    await BotManager.unload(legacy.storeId, 'single-store-mode').catch(() => {});
    await Store.findOneAndUpdate(
      { storeId: legacy.storeId },
      { $set: { status: 'disabled', botStatus: 'stopped', 'runtimeConfig.autoRestart': false } }
    );
    logger.warn(`[SingleStore] Disabled legacy store ${legacy.storeId}`);
  }

  return Store.findOne({ storeId: SINGLE_STORE_ID });
}

async function checkStoreExpiry() {
  // Single-store mode is permanent by default (expiresAt = null).
  // Keep this hook only for backwards compatibility with a manually configured expiry.
  try {
    const now = new Date().toISOString();
    const expired = await Store.find({ status: 'active', expiresAt: { $lt: now } });
    for (const store of expired) {
      const bot = BotManager.getBot(store.storeId);
      await BotManager.unload(store.storeId, 'expired').catch(() => {});
      await Store.findOneAndUpdate(
        { storeId: store.storeId },
        { $set: { status: 'suspended', botStatus: 'stopped', 'runtimeConfig.autoRestart': false } }
      );
      if (bot && store.ownerId) {
        await bot.telegram.sendMessage(
          String(store.ownerId),
          `⚠️ *Toko dihentikan karena masa aktif berakhir.*\n\n🏪 ${store.settings?.storeName || 'Telegram Store'}`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }
    }
  } catch (err) {
    logger.error('Expiry check error:', err.message);
  }
}

async function reconcileValqenixTopups() {
  try {
    const store = await Store.findOne({ storeId: SINGLE_STORE_ID, status: 'active' });
    const cfg = store?.paymentSettings?.valqenix;
    if (!store || !cfg?.enabled || !cfg.apiKey) return;

    const pending = await Topup.find({
      storeId: store.storeId,
      paymentMethod: 'valqenix',
      status: 'pending',
    }).limit(25);

    for (const topup of pending) {
      if (!topup.reference) continue;
      try {
        const payment = await Valqenix.getPayment(cfg.apiKey, topup.reference, !!cfg.sandbox);
        const status = String(payment?.status || '').toLowerCase();
        if (status === 'paid') {
          const credited = await WalletService.creditTopup(topup._id, 'valqenix_poll', topup.storeId);
          if (credited.success) logger.info(`[Valqenix] Reconciled paid topup ${topup.reference}`);
        } else if (['expired', 'cancelled', 'failed'].includes(status)) {
          await Topup.findOneAndUpdate(
            { _id: topup._id, status: 'pending' },
            { $set: { status, updatedAt: new Date().toISOString() } }
          );
        }
      } catch (err) {
        logger.warn(`[Valqenix] Reconcile ${topup.reference} failed: ${err.message}`);
      }
    }
  } catch (err) {
    logger.warn(`[Valqenix] Reconciliation failed: ${err.message}`);
  }
}

function setupCronJobs() {
  cron.schedule('*/10 * * * *', async () => {
    try { await OrderService.expireOldOrders(); }
    catch (err) { logger.error('Cron order expiry:', err.message); }
  });
  cron.schedule('* * * * *', async () => {
    try {
      const SessionService = require('./services/sessionService');
      const expired = await OrderService.getOtpTimeoutCandidates();
      for (const order of expired) {
        try {
          await SessionService.expireOtpOrder(order.storeId, order.orderId, order.buyerId);
        } catch (err) {
          logger.error(`[OTP Timeout Recovery] order=${order.orderId} failed: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error('Cron OTP timeout recovery:', err.message);
    }
  });
  cron.schedule('*/5 * * * *', async () => {
    try { await StoreLoader.healthCheck(); }
    catch (err) { logger.error('Cron health check:', err.message); }
  });
  cron.schedule('0 * * * *', checkStoreExpiry);
  cron.schedule('*/2 * * * *', reconcileValqenixTopups);
  cron.schedule('*/3 * * * *', async () => {
    try {
      const result = await RecoveryService.recoverAll(BotManager);
      const count = Object.values(result).reduce((n, r) => n + Number(r?.resumed || 0), 0);
      if (count) logger.info(`[Recovery] resumed ${count} interrupted order(s)`);
    } catch (err) { logger.error(`[Recovery] cron failed: ${err.message}`); }
  });
  logger.info('Cron jobs scheduled');
}

async function main() {
  logger.info('🚀 Starting Telegram Store (single-store mode)...');
  await database.connect();
  logger.info('JSON database connected');

  const app = require('./api/server');
  const PORT = parseInt(process.env.PORT || '3000', 10);
  await new Promise(resolve => app.listen(PORT, () => {
    logger.info(`✅ HTTP server running on port ${PORT}`);
    resolve();
  }));

  const store = await ensureSingleStore();
  await StoreLoader.syncAll();

  // syncAll should start exactly one bot: the platform bot configured in .env.
  if (!BotManager.isRunning(store.storeId)) {
    await BotManager.load(store);
  }

  await RecoveryService.recoverAll(BotManager);
  setupCronJobs();
  await checkStoreExpiry();
  await reconcileValqenixTopups();
  logger.info(`✅ Single store ready: @${store.botUsername}`);
  logger.info('All systems operational');
}

async function shutdown(signal) {
  logger.info(`${signal} — shutting down...`);
  try { await StoreLoader.stopAll(signal); }
  catch (err) { logger.error('Shutdown error:', err.message); }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', err => logger.error('Uncaught: ' + err.message + '\n' + err.stack));
process.on('unhandledRejection', reason => logger.error('Unhandled rejection: ' + (reason?.stack || reason)));

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
