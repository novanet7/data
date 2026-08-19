'use strict';

// The tenant runtime intentionally reuses the exact Archive custom-emoji bridge
// so the four source projects receive the same Premium-Emoji behavior without
// editing their business logic.
try {
  const bridgePath = require('path').join(__dirname, 'premium-bridge.js');
  const bridge = require(bridgePath);
  const bridgeSource = bridge;
  let Telegram, TelegrafModule;
  try { TelegrafModule = require('telegraf'); ({ Telegram } = TelegrafModule); } catch (_) { Telegram = null; TelegrafModule = null; }
  try { bridgeSource.installContext(TelegrafModule); } catch (_) {}
  if (Telegram?.prototype && !Telegram.prototype.__saasArchiveEmojiRuntimeInstalled) {
    const PATCH = Symbol.for('telegram.saas.archivePremiumEmoji.tenant.v7');
    if (!Telegram.prototype[PATCH]) {
      const originalCallApi = Telegram.prototype.callApi;
      Telegram.prototype.callApi = async function(method, payload, ...rest) {
        if (!payload || typeof payload !== 'object') return originalCallApi.call(this, method, payload, ...rest);
        const source = { ...payload };
        const prepared = { ...payload };
        if (prepared.reply_markup) prepared.reply_markup = bridgeSource.applyArchiveCustomEmojiIconsToReplyMarkup(prepared.reply_markup);
        if (typeof prepared.text === 'string') {
          const mode = String(prepared.parse_mode || '').toUpperCase();
          prepared.text = mode === 'MARKDOWNV2'
            ? bridgeSource.applyArchiveCustomEmojisToMarkdownV2(prepared.text)
            : mode === 'MARKDOWN'
              ? bridgeSource.applyArchiveCustomEmojisToHtml(bridgeSource.markdownLegacyToHtml(prepared.text))
              : bridgeSource.applyArchiveCustomEmojisToHtml(prepared.text);
          if (mode !== 'MARKDOWNV2') prepared.parse_mode = 'HTML';
        }
        if (typeof prepared.caption === 'string') {
          const mode = String(prepared.parse_mode || '').toUpperCase();
          prepared.caption = mode === 'MARKDOWNV2'
            ? bridgeSource.applyArchiveCustomEmojisToMarkdownV2(prepared.caption)
            : mode === 'MARKDOWN'
              ? bridgeSource.applyArchiveCustomEmojisToHtml(bridgeSource.markdownLegacyToHtml(prepared.caption))
              : bridgeSource.applyArchiveCustomEmojisToHtml(prepared.caption);
          if (mode !== 'MARKDOWNV2') prepared.parse_mode = 'HTML';
        }
        try {
          return await originalCallApi.call(this, method, prepared, ...rest);
        } catch (err) {
          if (!bridgeSource.isPremiumEmojiUnsupportedError(err)) throw err;
          return originalCallApi.call(this, method, source, ...rest);
        }
      };
      Object.defineProperty(Telegram.prototype, PATCH, { value: true, enumerable: false, configurable: false });
    }
  }
} catch (_) {
  // Runtime bridge must never prevent a tenant bot from starting.
}
