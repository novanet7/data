'use strict';

const Store      = require('../models/Store');
const BotManager = require('./BotManager');
const logger     = require('../utils/logger');

class StoreLoader {
  static async syncAll() {
    logger.info('[StoreLoader] Starting full sync from DB...');

    // Hanya load store yang status active DAN belum expired (atau tidak ada expiresAt)
    const now = new Date().toISOString();
    const stores = await Store.find({ status: 'active' });

    // Filter: skip yang sudah expired
    const activeStores = stores.filter(s => {
      if (!s.expiresAt) return true;          // legacy — no expiry
      return s.expiresAt > now;               // not yet expired
    }).slice(0, 1); // Single-store mode: load at most one active bot.

    const result = { success: 0, failed: 0, skipped: 0, errors: [] };

    for (const store of activeStores) {
      if (!store.botToken) {
        logger.warn(`[StoreLoader] ${store.storeId} has no bot token — skipping`);
        result.skipped++;
        continue;
      }
      if (BotManager.isRunning(store.storeId)) {
        result.skipped++;
        continue;
      }
      try {
        await BotManager.load(store);
        result.success++;
        logger.info(`[StoreLoader] ✅ ${store.storeId} (@${store.botUsername}) started`);
      } catch (err) {
        result.failed++;
        result.errors.push({ storeId: store.storeId, error: err.message });
        logger.error(`[StoreLoader] ❌ ${store.storeId} failed:`, err.message);
      }
    }

    logger.info(
      `[StoreLoader] Sync complete — ` +
      `${result.success} started, ${result.failed} failed, ${result.skipped} skipped`
    );
    return result;
  }

  static async loadOne(storeId) {
    const store = await Store.findOne({ storeId, status: 'active' });
    if (!store) throw new Error(`Store ${storeId} not found or not active`);
    return BotManager.load(store);
  }

  static async reloadOne(storeId) {
    return BotManager.restart(storeId);
  }

  static async stopAll(reason = 'shutdown') {
    const ids = BotManager.getAllIds();
    logger.info(`[StoreLoader] Stopping ${ids.length} bots (${reason})...`);
    await Promise.allSettled(ids.map(id => BotManager.unload(id, reason)));
    logger.info('[StoreLoader] All bots stopped');
  }

  static async healthCheck() {
    logger.debug('[StoreLoader] Running health check...');
    const now    = new Date().toISOString();
    const stores = (await Store.find({ status: 'active' })).slice(0, 1); // Single-store mode
    let recovered = 0;

    for (const store of stores) {
      if (!store.botToken) continue;
      // Skip expired
      if (store.expiresAt && store.expiresAt <= now) continue;
      if (BotManager.isRunning(store.storeId)) continue;

      logger.warn(`[StoreLoader] ${store.storeId} not running — attempting recovery...`);
      try {
        await BotManager.load(store);
        recovered++;
      } catch (err) {
        logger.error(`[StoreLoader] health recovery failed for ${store.storeId}:`, err.message);
      }
    }

    if (recovered > 0) logger.info(`[StoreLoader] Health check recovered ${recovered} bots`);
    return { checked: stores.length, recovered };
  }
}

module.exports = StoreLoader;
