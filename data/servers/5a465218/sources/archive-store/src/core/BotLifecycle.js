'use strict';

const { Telegraf } = require('telegraf');
const Encryption = require('../utils/encryption');
const logger = require('../utils/logger');
const Validators = require('../utils/validators');

const STATES = {
  IDLE:     'idle',
  LOADING:  'loading',
  RUNNING:  'running',
  STOPPING: 'stopping',
  STOPPED:  'stopped',
  ERROR:    'error',
};

class BotLifecycle {
  constructor(storeDoc, options = {}) {
    this.store     = storeDoc;
    this.storeId   = storeDoc.storeId;
    this.options   = options;

    this.bot       = null;
    this.state     = STATES.IDLE;
    this.error     = null;
    this.startedAt = null;
    this.lastHeartbeat = null;
    this._heartbeatTimer = null;
    this._recoveryAttempts = 0;
    this._maxRecoveryAttempts = 5;
    this._recoveryDelay = 10000;
    this._webhookPath = null;
  }

  async start() {
    if (this.state === STATES.RUNNING) {
      logger.warn(`[BotLifecycle] ${this.storeId} already running`);
      return this;
    }

    this._setState(STATES.LOADING);
    this.error = null;

    try {
      const token = this._decryptToken(this.store.botToken);
      if (!token) throw new Error('Bot token missing or unreadable');

      if (!Validators.isBotTokenFormat(token)) {
        throw new Error('Bot token format invalid');
      }

      this.bot = new Telegraf(token, {
        handlerTimeout: 90_000,
        telegram: { webhookReply: false },
      });

      const self = this;
      this.bot.use((ctx, next) => {
        ctx.storeId = self.storeId;
        ctx.store   = self.store;
        return next();
      });

      if (typeof this.options.registerHandlers === 'function') {
        await this.options.registerHandlers(this.bot, this.store);
      }

      this.bot.catch(async (err, ctx) => {
        logger.error(`[Bot:${self.storeId}] error:`, err.message);
        try {
          if (ctx?.callbackQuery) {
            await ctx.answerCbQuery('❌ Terjadi kesalahan.').catch(() => {});
          } else if (ctx) {
            await ctx.reply('❌ Terjadi kesalahan. Ketik /start untuk coba lagi.').catch(() => {});
          }
        } catch {}
        if (typeof self.options.onError === 'function') {
          self.options.onError(self.storeId, err);
        }
      });

      // ALWAYS use polling — webhook requires a public server
      try {
        await this.bot.telegram.deleteWebhook({ drop_pending_updates: false });
      } catch (e) {
        logger.debug(`[BotLifecycle] ${this.storeId} deleteWebhook:`, e.message);
      }

      this.bot.launch({
        allowedUpdates: ['message', 'callback_query', 'photo'],
      }).catch(err => this._handlePollingError(err));

      logger.info(`[BotLifecycle] ${this.storeId} polling started (@${this.store.botUsername})`);

      this.startedAt = new Date();
      this._recoveryAttempts = 0;
      this._startHeartbeat();
      this._setState(STATES.RUNNING);

      return this;
    } catch (err) {
      this.error = err;
      this._setState(STATES.ERROR);
      logger.error(`[BotLifecycle] ${this.storeId} failed to start:`, err.message);
      throw err;
    }
  }

  async stop(reason = 'manual') {
    if (this.state === STATES.STOPPED || this.state === STATES.IDLE) return;
    this._setState(STATES.STOPPING);
    this._stopHeartbeat();
    try {
      if (this.bot) {
        this.bot.stop(reason);
        this.bot = null;
      }
    } catch (err) {
      logger.warn(`[BotLifecycle] ${this.storeId} stop error:`, err.message);
    }
    this._setState(STATES.STOPPED);
    logger.info(`[BotLifecycle] ${this.storeId} stopped (${reason})`);
  }

  async restart(reason = 'restart') {
    logger.info(`[BotLifecycle] ${this.storeId} restarting (${reason})...`);
    await this.stop(reason);
    await new Promise(r => setTimeout(r, 2000));
    await this.start();
  }

  updateStore(newStoreDoc) { this.store = newStoreDoc; }
  handleUpdate(update) {
    if (!this.bot) throw new Error(`Bot ${this.storeId} not running`);
    return this.bot.handleUpdate(update);
  }

  isRunning() { return this.state === STATES.RUNNING; }
  getWebhookPath() { return this._webhookPath; }
  getState() { return this.state; }
  getInfo() {
    return {
      storeId: this.storeId,
      state:   this.state,
      startedAt: this.startedAt,
      lastHeartbeat: this.lastHeartbeat,
      recoveryAttempts: this._recoveryAttempts,
      error: this.error?.message || null,
    };
  }

  _setState(state) {
    const prev = this.state;
    this.state = state;
    if (prev !== state && typeof this.options.onStateChange === 'function') {
      this.options.onStateChange(this.storeId, state, prev);
    }
  }

  _decryptToken(raw) {
    if (!raw) return null;
    try { return Encryption.decrypt(raw) || raw; } catch { return raw; }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      this.lastHeartbeat = new Date();
    }, 30_000);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  async _handlePollingError(err) {
    logger.error(`[BotLifecycle] ${this.storeId} polling error:`, err.message);
    this._setState(STATES.ERROR);
    this.error = err;
    await this._attemptRecovery();
  }

  async _attemptRecovery() {
    if (this._recoveryAttempts >= this._maxRecoveryAttempts) {
      logger.error(`[BotLifecycle] ${this.storeId} max recovery attempts reached`);
      if (typeof this.options.onError === 'function') {
        this.options.onError(this.storeId, this.error);
      }
      return;
    }
    const delay = this._recoveryDelay * Math.pow(2, this._recoveryAttempts);
    this._recoveryAttempts++;
    logger.info(`[BotLifecycle] ${this.storeId} recovery attempt ${this._recoveryAttempts} in ${delay}ms...`);
    await new Promise(r => setTimeout(r, delay));
    try {
      await this.restart('auto-recovery');
    } catch (err) {
      logger.error(`[BotLifecycle] ${this.storeId} recovery failed:`, err.message);
      await this._attemptRecovery();
    }
  }
}

BotLifecycle.STATES = STATES;
module.exports = BotLifecycle;
