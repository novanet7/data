'use strict';

/**
 * BotManager — the central registry and lifecycle manager for all tenant bots.
 *
 * Responsibilities:
 *   - maintain an in-memory Map of { storeId → BotLifecycle }
 *   - expose load / unload / restart / status APIs
 *   - emit state change events (via onStateChange callback → DB write)
 *   - propagate webhook updates to the correct bot
 *   - provide statistics for the platform API
 *
 * Usage:
 *   const BotManager = require('./BotManager');
 *   await BotManager.load(storeDoc);
 *   BotManager.handleWebhook(storeId, req, res);
 */

const EventEmitter = require('events');
const BotLifecycle = require('./BotLifecycle');
// StoreRuntime is required lazily inside load() to break circular dependency:
// BotManager → StoreRuntime → BotLifecycleHandler → BotManager
const Store         = require('../models/Store');
const AuditLog      = require('../models/AuditLog');
const logger        = require('../utils/logger');

class BotManagerClass extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, BotLifecycle>} */
    this._registry = new Map();
    this._persistStateDebounce = new Map();   // storeId → timer
  }

  // ─── Core Operations ───────────────────────────────────────────────────────

  /**
   * Load and start a bot for the given store.
   * Idempotent — returns existing lifecycle if already running.
   */
  async load(storeDoc) {
    const storeId = storeDoc.storeId;

    if (this._registry.has(storeId)) {
      const existing = this._registry.get(storeId);
      if (existing.isRunning()) {
        logger.debug(`[BotManager] ${storeId} already running — skipping load`);
        return existing;
      }
      // Remove stale entry
      this._registry.delete(storeId);
    }

    const lifecycle = new BotLifecycle(storeDoc, {
      registerHandlers: require('./StoreRuntime').registerHandlers.bind(require('./StoreRuntime')),

      onStateChange: (sid, newState, oldState) => {
        this._onLifecycleStateChange(sid, newState, oldState);
      },

      onError: (sid, err) => {
        logger.error(`[BotManager] ${sid} unrecoverable error`, { message: err?.message || String(err), stack: err?.stack || null });
        this.emit('bot:error', { storeId: sid, error: err });
        // Mark in DB
        this._persistBotStatus(sid, 'error', err.message);
      },
    });

    this._registry.set(storeId, lifecycle);

    try {
      await lifecycle.start();
      await this._persistBotStatus(storeId, 'running');
      this.emit('bot:started', { storeId });
      return lifecycle;
    } catch (err) {
      this._registry.delete(storeId);
      await this._persistBotStatus(storeId, 'error', err.message);
      throw err;
    }
  }

  /**
   * Stop and remove a bot from the registry.
   */
  async unload(storeId, reason = 'manual') {
    const lifecycle = this._registry.get(storeId);
    if (!lifecycle) {
      logger.debug(`[BotManager] ${storeId} not in registry — nothing to unload`);
      return;
    }

    await lifecycle.stop(reason);
    this._registry.delete(storeId);
    await this._persistBotStatus(storeId, 'stopped');
    this.emit('bot:stopped', { storeId, reason });
    logger.info(`[BotManager] ${storeId} unloaded (${reason})`);
  }

  /**
   * Restart a bot — stop → re-fetch from DB → start fresh.
   */
  async restart(storeId) {
    await this.unload(storeId, 'restart');

    const storeDoc = await Store.findOne({ storeId });
    if (!storeDoc) throw new Error(`Store ${storeId} not found in DB`);
    if (storeDoc.status === 'suspended') throw new Error(`Store ${storeId} is suspended`);

    await this.load(storeDoc);
    this.emit('bot:restarted', { storeId });
    logger.info(`[BotManager] ${storeId} restarted`);
  }

  /**
   * Update the in-memory store reference (e.g. after settings change).
   * Avoids a full restart for non-token setting changes.
   */
  async refreshStore(storeId) {
    const lifecycle = this._registry.get(storeId);
    if (!lifecycle) return;
    const storeDoc = await Store.findOne({ storeId });
    if (storeDoc) lifecycle.updateStore(storeDoc);
  }

  // ─── Webhook Routing ───────────────────────────────────────────────────────

  /**
   * Route incoming webhook to the correct bot instance.
   * Called from Express route handler.
   */
  handleWebhook(storeId, req, res) {
    const lifecycle = this._registry.get(storeId);
    if (!lifecycle || !lifecycle.isRunning()) {
      logger.warn(`[BotManager] webhook for unknown/stopped store: ${storeId}`);
      res.status(404).json({ error: 'Bot not found or not running' });
      return;
    }
    lifecycle.handleUpdate(req.body)
      .then(() => res.sendStatus(200))
      .catch(err => {
        logger.error(`[BotManager] webhook handler error for ${storeId}:`, err.message);
        res.sendStatus(500);
      });
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  get(storeId) { return this._registry.get(storeId) || null; }
  has(storeId) { return this._registry.has(storeId); }
  isRunning(storeId) { return this._registry.get(storeId)?.isRunning() || false; }
  getBot(storeId) { return this._registry.get(storeId)?.bot || null; }

  getAllIds()   { return Array.from(this._registry.keys()); }
  getRunning()  { return this.getAllIds().filter(id => this.isRunning(id)); }

  getStats() {
    const all     = this.getAllIds();
    const running = this.getRunning();
    const infos   = all.map(id => this._registry.get(id).getInfo());
    return {
      total:   all.length,
      running: running.length,
      stopped: all.length - running.length,
      bots:    infos,
    };
  }

  getInfo(storeId) {
    return this._registry.get(storeId)?.getInfo() || null;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _onLifecycleStateChange(storeId, newState, oldState) {
    logger.info(`[BotManager] ${storeId} state: ${oldState} → ${newState}`);
    this.emit('bot:stateChange', { storeId, newState, oldState });

    // Debounce DB write to avoid hammering DB during rapid transitions
    const existing = this._persistStateDebounce.get(storeId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this._persistStateDebounce.delete(storeId);
      this._persistBotStatus(storeId, newState).catch(() => {});
    }, 500);

    this._persistStateDebounce.set(storeId, timer);
  }

  async _persistBotStatus(storeId, status, errorMsg = null) {
    try {
      const update = {
        botStatus: status,
        lastHeartbeat: new Date().toISOString(),
        lifecycleState: status,
      };
      if (errorMsg) update['runtimeConfig.lastError'] = errorMsg;

      await Store.findOneAndUpdate({ storeId }, { $set: update });
    } catch (err) {
      logger.warn(`[BotManager] failed to persist bot status for ${storeId}:`, err.message);
    }
  }
}

// Singleton
const BotManager = new BotManagerClass();
module.exports = BotManager;
