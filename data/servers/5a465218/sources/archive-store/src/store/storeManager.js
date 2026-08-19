'use strict';

/**
 * StoreManager — compatibility shim around BotManager + StoreLoader.
 *
 * Existing code (webhooks, app.js, etc.) can continue calling StoreManager methods.
 * All real logic now lives in src/core/.
 */

const BotManager  = require('../core/BotManager');
const StoreLoader = require('../core/StoreLoader');
const Store       = require('../models/Store');
const logger      = require('../utils/logger');

const StoreManager = {
  /**
   * Start a store bot.
   * @param {object} storeDoc
   */
  async startStore(storeDoc) {
    return BotManager.load(storeDoc);
  },

  /**
   * Stop a store bot.
   */
  async stopStore(storeId) {
    return BotManager.unload(storeId, 'manual');
  },

  /**
   * Restart a store bot.
   */
  async restartStore(storeId) {
    return BotManager.restart(storeId);
  },

  /**
   * Initialize all active stores from DB (called at app startup).
   */
  async initializeAll() {
    return StoreLoader.syncAll();
  },

  /**
   * Get the Telegraf bot instance for a store.
   */
  getBot(storeId) {
    return BotManager.getBot(storeId);
  },

  /**
   * Handle incoming webhook for a store.
   */
  handleWebhook(storeId, req, res) {
    BotManager.handleWebhook(storeId, req, res);
  },

  /**
   * List all active store IDs.
   */
  getActiveStores() {
    return BotManager.getRunning();
  },

  /**
   * Registry stats.
   */
  getStats() {
    return BotManager.getStats();
  },

  /**
   * Check if a store bot is currently running.
   */
  isRunning(storeId) {
    return BotManager.isRunning(storeId);
  },
};

module.exports = StoreManager;
