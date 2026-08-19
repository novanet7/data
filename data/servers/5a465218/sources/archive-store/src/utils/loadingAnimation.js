'use strict';

const logger = require('./logger');

/**
 * LoadingAnimation — Spinner animation via editMessageText.
 *
 * Shows a rotating spinner (| / - \) in a single bubble,
 * editing it every 2 seconds until stopped.
 *
 * Usage:
 *   const anim = await LoadingAnimation.start(bot, chatId, 'Menunggu approve...\nEstimasi maksimal 10 menit');
 *   // ... later ...
 *   await anim.stop(bot, '✅ Pembayaran berhasil di approve!\n\n🚀 Pesanan sedang diproses...\nEstimasi 1-5 menit');
 */

const FRAMES = ['|', '/', '-', '\\'];
const INTERVAL_MS = 2000;

class LoadingAnimation {
  /**
   * Start a loading animation.
   * @param {object} bot       - Telegraf bot instance (bot.telegram)
   * @param {number} chatId    - Telegram chat ID
   * @param {string} message   - Message body (shown after spinner char)
   * @returns {LoadingAnimation}
   */
  static async start(bot, chatId, message) {
    const anim = new LoadingAnimation(bot, chatId, message);
    await anim._init();
    return anim;
  }

  constructor(bot, chatId, message) {
    this._bot = bot;
    this._chatId = chatId;
    this._message = message;
    this._frameIdx = 0;
    this._msgId = null;
    this._timer = null;
    this._stopped = false;
  }

  async _init() {
    try {
      const frame = FRAMES[this._frameIdx];
      const sent = await this._bot.telegram.sendMessage(
        this._chatId,
        `${frame} ${this._message}`,
        { parse_mode: 'Markdown' }
      );
      this._msgId = sent.message_id;
      this._timer = setInterval(() => this._tick(), INTERVAL_MS);
    } catch (err) {
      logger.error('[LoadingAnimation] Failed to send initial message:', err.message);
    }
  }

  _tick() {
    if (this._stopped || !this._msgId) return;
    this._frameIdx = (this._frameIdx + 1) % FRAMES.length;
    const frame = FRAMES[this._frameIdx];
    this._bot.telegram.editMessageText(
      this._chatId,
      this._msgId,
      null,
      `${frame} ${this._message}`,
      { parse_mode: 'Markdown' }
    ).catch((err) => {
      // Ignore "message is not modified" errors
      if (!err.message?.includes('message is not modified')) {
        logger.warn('[LoadingAnimation] Edit error:', err.message);
      }
    });
  }

  /**
   * Stop the animation and replace the message with a final text.
   * @param {string|null} finalText - Text to show after animation stops. If null, deletes the message.
   * @param {object} options        - Extra Telegraf options (reply_markup, etc.)
   */
  async stop(finalText = null, options = {}) {
    if (this._stopped) return;
    this._stopped = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (!this._msgId) return;
    try {
      if (finalText) {
        await this._bot.telegram.editMessageText(
          this._chatId,
          this._msgId,
          null,
          finalText,
          { parse_mode: 'Markdown', ...options }
        );
      } else {
        await this._bot.telegram.deleteMessage(this._chatId, this._msgId).catch(() => {});
      }
    } catch (err) {
      logger.error('[LoadingAnimation] Failed to stop animation:', err.message);
    }
  }

  /** Returns the message ID of the animation bubble (useful for reply_markup later) */
  get messageId() { return this._msgId; }
}

module.exports = LoadingAnimation;
