'use strict';

const fs = require('fs');
const path = require('path');

const MAP_FILE = path.join(__dirname, '..', 'emoji', 'custom_emojis.json');
let rawMap = {};
try { rawMap = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')); } catch (_) { rawMap = {}; }

const entries = Object.entries(rawMap)
  .filter(([emoji, cfg]) => emoji && cfg && /^\d+$/.test(String(cfg.customEmojiId || '')))
  .sort((a, b) => Array.from(b[0]).length - Array.from(a[0]).length);

const byEmoji = new Map(entries);
const PATCH = Symbol.for('telegram.saas.archivePremiumEmoji.v7');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isPremiumEmojiUnsupportedError(err) {
  const code = Number(err?.response?.error_code || err?.response?.errorCode || err?.code || 0);
  const message = String(err?.response?.description || err?.description || err?.message || '').toLowerCase();
  return code === 400 && (
    message.includes('icon_custom_emoji_id') ||
    message.includes('custom emoji') ||
    message.includes('custom_emoji_id') ||
    message.includes('premium')
  );
}

function protectExistingCustomEmojiTags(text) {
  const protectedTags = [];
  const source = String(text ?? '');
  const protectedText = source.replace(
    /<tg-emoji\b[^>]*>[\s\S]*?<\/tg-emoji>/gi,
    match => {
      const index = protectedTags.push(match) - 1;
      return `\u0003ARCHIVE_TG_EMOJI_${index}\u0004`;
    }
  );
  return { protectedText, protectedTags };
}

function normalizeExistingCustomEmojiTags(text) {
  const source = String(text ?? '');
  return source.replace(
    /<tg-emoji\b[^>]*>([\s\S]*?)<\/tg-emoji>/gi,
    (full, inner) => {
      const visible = String(inner).replace(/<[^>]+>/g, '').trim();
      const cfg = byEmoji.get(visible);
      if (!cfg) return full;
      return `<tg-emoji emoji-id="${String(cfg.customEmojiId)}">${escapeHtml(visible)}</tg-emoji>`;
    }
  );
}

function replaceBareArchiveEmojis(text) {
  if (typeof text !== 'string' || !text || !entries.length) return text;
  let result = String(text);
  for (const [emoji, cfg] of entries) {
    result = result.split(emoji).join(
      `<tg-emoji emoji-id="${String(cfg.customEmojiId)}">${escapeHtml(emoji)}</tg-emoji>`
    );
  }
  return result;
}

function applyArchiveCustomEmojis(text) {
  return replaceBareArchiveEmojis(text);
}

function applyArchiveCustomEmojisToMarkdownV2(text) {
  if (typeof text !== 'string' || !text || !entries.length) return text;
  let result = String(text);
  // Longest emoji first prevents variation-selector / ZWJ collisions.
  for (const [emoji, cfg] of entries) {
    const replacement = `![${emoji}](tg://emoji?id=${String(cfg.customEmojiId)})`;
    result = result.split(emoji).join(replacement);
  }
  return result;
}

function applyArchiveCustomEmojisToHtml(text) {
  if (typeof text !== 'string' || !text || !entries.length) return text;

  const source = String(text);
  const protectedTags = [];
  const token = index => `\u0003ARCHIVE_TG_EMOJI_${index}\u0004`;

  // Normalize existing custom-emoji tags first. This is important for Tagall,
  // which already embeds custom emoji IDs of its own: the Archive mapping must
  // be the single source of truth.
  const protectedText = source.replace(
    /<tg-emoji\b[^>]*>[\s\S]*?<\/tg-emoji>/gi,
    match => {
      const normalized = normalizeExistingCustomEmojiTags(match);
      const index = protectedTags.push(normalized) - 1;
      return token(index);
    }
  );

  // Never replace emoji inside arbitrary HTML tag attributes. Only transform
  // text nodes, exactly like the proven Archive formatter.
  const converted = protectedText
    .split(/(<[^>]+>)/g)
    .map(part => part.startsWith('<') ? part : replaceBareArchiveEmojis(part))
    .join('');

  return converted.replace(
    /\u0003ARCHIVE_TG_EMOJI_(\d+)\u0004/g,
    (_, index) => protectedTags[Number(index)]
  );
}

function markdownLegacyToHtml(text) {
  let raw = String(text ?? '');
  const stash = [];
  const token = value => { const i = stash.push(value) - 1; return `\u0000${i}\u0000`; };
  raw = raw.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, label, url) => token(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`));
  raw = raw.replace(/`([^`\n]+)`/g, (_, v) => token(`<code>${escapeHtml(v)}</code>`));
  raw = raw.replace(/\*([^*\n]+)\*/g, (_, v) => token(`<b>${escapeHtml(v)}</b>`));
  raw = raw.replace(/_([^_\n]+)_/g, (_, v) => token(`<i>${escapeHtml(v)}</i>`));
  raw = raw.replace(/\\([_*`])/g, '$1');
  raw = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  raw = raw.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
  return raw;
}

function decorateButton(button) {
  if (!button || typeof button !== 'object' || typeof button.text !== 'string') return button;

  const originalText = button.text;
  if (button.icon_custom_emoji_id) {
    // Replace source/project IDs too, using the visible fallback emoji as the source of truth.
    for (const [fallback, cfg] of entries) {
      if (!originalText.startsWith(fallback)) continue;
      const rest = originalText.slice(fallback.length).trimStart();
      return {
        ...button,
        text: rest || originalText,
        icon_custom_emoji_id: String(cfg.customEmojiId)
      };
    }
    return button;
  }

  for (const [fallback, cfg] of entries) {
    if (!originalText.startsWith(fallback)) continue;
    const rest = originalText.slice(fallback.length).trimStart();
    if (!rest) return { ...button, icon_custom_emoji_id: String(cfg.customEmojiId) };
    return {
      ...button,
      text: rest,
      icon_custom_emoji_id: String(cfg.customEmojiId)
    };
  }
  return button;
}

function applyArchiveCustomEmojiIconsToReplyMarkup(replyMarkup) {
  if (!replyMarkup || !Array.isArray(replyMarkup.inline_keyboard) || !entries.length) return replyMarkup;
  return {
    ...replyMarkup,
    inline_keyboard: replyMarkup.inline_keyboard.map(row => Array.isArray(row)
      ? row.map(decorateButton)
      : row
    )
  };
}

function removePremiumIconsForFallback(replyMarkup, decoratedMarkup) {
  if (!decoratedMarkup || !Array.isArray(decoratedMarkup.inline_keyboard)) return decoratedMarkup;
  if (!replyMarkup || !Array.isArray(replyMarkup.inline_keyboard)) return decoratedMarkup;
  return {
    ...decoratedMarkup,
    inline_keyboard: decoratedMarkup.inline_keyboard.map((row, r) => Array.isArray(row)
      ? row.map((button, c) => {
          const original = replyMarkup.inline_keyboard?.[r]?.[c];
          if (!button || typeof button !== 'object') return button;
          const fallback = original && typeof original === 'object' ? original : button;
          const out = { ...fallback };
          delete out.icon_custom_emoji_id;
          delete out.hide;
          return out;
        })
      : row
    )
  };
}

function buildPreparedOptions(sourceOptions) {
  const opts = { ...(sourceOptions || {}) };
  if (opts.reply_markup) opts.reply_markup = applyArchiveCustomEmojiIconsToReplyMarkup(opts.reply_markup);
  const parseMode = String(opts.parse_mode || '').toUpperCase();

  if (typeof opts.text === 'string') {
    if (parseMode === 'MARKDOWNV2') {
      opts.text = applyArchiveCustomEmojisToMarkdownV2(opts.text);
    } else if (parseMode === 'MARKDOWN') {
      opts.text = applyArchiveCustomEmojisToHtml(markdownLegacyToHtml(opts.text));
      opts.parse_mode = 'HTML';
    } else {
      opts.text = applyArchiveCustomEmojisToHtml(opts.text);
      opts.parse_mode = 'HTML';
    }
  }
  if (typeof opts.caption === 'string') {
    if (parseMode === 'MARKDOWNV2') {
      opts.caption = applyArchiveCustomEmojisToMarkdownV2(opts.caption);
      opts.parse_mode = 'MarkdownV2';
    } else if (parseMode === 'MARKDOWN') {
      opts.caption = applyArchiveCustomEmojisToHtml(markdownLegacyToHtml(opts.caption));
      opts.parse_mode = 'HTML';
    } else {
      opts.caption = applyArchiveCustomEmojisToHtml(opts.caption);
      opts.parse_mode = 'HTML';
    }
  }
  return opts;
}

function patchMethod(telegram, method, textIndex, optionsIndex) {
  const original = telegram?.[method]?.bind(telegram);
  if (!original) return;
  telegram[method] = async (...args) => {
    const sourceOptions = { ...(args[optionsIndex] || {}) };
    const originalMarkup = sourceOptions.reply_markup;
    const prepared = buildPreparedOptions(sourceOptions);
    if (typeof args[textIndex] === 'string') {
      const parseMode = String(prepared.parse_mode || sourceOptions.parse_mode || '').toUpperCase();
      args[textIndex] = parseMode === 'MARKDOWNV2'
        ? applyArchiveCustomEmojisToMarkdownV2(args[textIndex])
        : applyArchiveCustomEmojisToHtml(args[textIndex]);
      if (parseMode !== 'MARKDOWNV2') prepared.parse_mode = 'HTML';
    }
    args[optionsIndex] = prepared;
    try {
      return await original(...args);
    } catch (err) {
      if (!isPremiumEmojiUnsupportedError(err)) throw err;
      const fallback = { ...sourceOptions };
      if (originalMarkup) fallback.reply_markup = removePremiumIconsForFallback(originalMarkup, prepared.reply_markup);
      args[optionsIndex] = fallback;
      return original(...args);
    }
  };
}


const CONTEXT_PATCH = Symbol.for('telegram.saas.archivePremiumEmoji.context.v8');

function installContext(ctxModule) {
  const Context = ctxModule?.Context || ctxModule;
  if (!Context?.prototype || Context.prototype[CONTEXT_PATCH]) return;

  const transformExtra = extra => {
    const source = { ...(extra || {}) };
    if (source.reply_markup) source.reply_markup = applyArchiveCustomEmojiIconsToReplyMarkup(source.reply_markup);
    if (typeof source.caption === 'string') {
      const mode = String(source.parse_mode || '').toUpperCase();
      source.caption = mode === 'MARKDOWNV2'
        ? applyArchiveCustomEmojisToMarkdownV2(source.caption)
        : mode === 'MARKDOWN'
          ? applyArchiveCustomEmojisToHtml(markdownLegacyToHtml(source.caption))
          : applyArchiveCustomEmojisToHtml(source.caption);
      if (mode !== 'MARKDOWNV2') source.parse_mode = 'HTML';
    }
    return source;
  };

  const transformText = (text, extra) => {
    if (typeof text !== 'string') return { text, extra: transformExtra(extra) };
    const opts = transformExtra(extra);
    const mode = String(opts.parse_mode || '').toUpperCase();
    const outText = mode === 'MARKDOWNV2'
      ? applyArchiveCustomEmojisToMarkdownV2(text)
      : mode === 'MARKDOWN'
        ? applyArchiveCustomEmojisToHtml(markdownLegacyToHtml(text))
        : applyArchiveCustomEmojisToHtml(text);
    if (mode !== 'MARKDOWNV2') opts.parse_mode = 'HTML';
    return { text: outText, extra: opts };
  };

  const patchReplyLike = (method, textIndex, extraIndex) => {
    const original = Context.prototype[method];
    if (typeof original !== 'function') return;
    Context.prototype[method] = function(...args) {
      const { text, extra } = transformText(args[textIndex], args[extraIndex]);
      args[textIndex] = text;
      args[extraIndex] = extra;
      return original.apply(this, args);
    };
  };

  patchReplyLike('reply', 0, 1);
  patchReplyLike('sendMessage', 1, 2);
  patchReplyLike('editMessageText', 0, 1);
  patchReplyLike('replyWithHTML', 0, 1);
  patchReplyLike('replyWithMarkdown', 0, 1);
  patchReplyLike('replyWithMarkdownV2', 0, 1);

  const patchMedia = (method, extraIndex) => {
    const original = Context.prototype[method];
    if (typeof original !== 'function') return;
    Context.prototype[method] = function(...args) {
      args[extraIndex] = transformExtra(args[extraIndex]);
      return original.apply(this, args);
    };
  };

  for (const method of ['replyWithPhoto','replyWithAnimation','replyWithVideo','replyWithDocument','replyWithAudio']) {
    patchMedia(method, 1);
  }

  Object.defineProperty(Context.prototype, CONTEXT_PATCH, { value: true, enumerable: false, configurable: false });
}

function install(telegram) {
  if (!telegram || telegram[PATCH]) return;

  // Match Archive Store's proven integration point: patch the high-level Telegram
  // convenience methods used by Telegraf handlers, then also patch callApi as a
  // final safety net for direct Telegram calls.
  patchMethod(telegram, 'sendMessage', 1, 2);
  patchMethod(telegram, 'editMessageText', 3, 4);
  for (const method of ['sendPhoto', 'sendVideo', 'sendAnimation', 'sendDocument', 'sendAudio']) {
    const original = telegram?.[method]?.bind(telegram);
    if (!original) continue;
    telegram[method] = async (...args) => {
      const optionsIndex = 2;
      const sourceOptions = { ...(args[optionsIndex] || {}) };
      const originalMarkup = sourceOptions.reply_markup;
      const prepared = buildPreparedOptions(sourceOptions);
      args[optionsIndex] = prepared;
      try {
        return await original(...args);
      } catch (err) {
        if (!isPremiumEmojiUnsupportedError(err)) throw err;
        args[optionsIndex] = {
          ...sourceOptions,
          reply_markup: originalMarkup
            ? removePremiumIconsForFallback(originalMarkup, prepared.reply_markup)
            : undefined
        };
        return original(...args);
      }
    };
  }

  const originalCallApi = telegram.callApi?.bind(telegram);
  if (originalCallApi) {
    telegram.callApi = async (method, payload, ...rest) => {
      if (!payload || typeof payload !== 'object') return originalCallApi(method, payload, ...rest);
      const source = { ...payload };
      const prepared = { ...payload };
      if (prepared.reply_markup) prepared.reply_markup = applyArchiveCustomEmojiIconsToReplyMarkup(prepared.reply_markup);
      if (typeof prepared.text === 'string') {
        const mode = String(prepared.parse_mode || '').toUpperCase();
        prepared.text = mode === 'MARKDOWNV2'
          ? applyArchiveCustomEmojisToMarkdownV2(prepared.text)
          : mode === 'MARKDOWN'
            ? applyArchiveCustomEmojisToHtml(markdownLegacyToHtml(prepared.text))
            : applyArchiveCustomEmojisToHtml(prepared.text);
        if (mode !== 'MARKDOWNV2') prepared.parse_mode = 'HTML';
      }
      if (typeof prepared.caption === 'string') {
        const mode = String(prepared.parse_mode || '').toUpperCase();
        prepared.caption = mode === 'MARKDOWNV2'
          ? applyArchiveCustomEmojisToMarkdownV2(prepared.caption)
          : mode === 'MARKDOWN'
            ? applyArchiveCustomEmojisToHtml(markdownLegacyToHtml(prepared.caption))
            : applyArchiveCustomEmojisToHtml(prepared.caption);
        if (mode !== 'MARKDOWNV2') prepared.parse_mode = 'HTML';
      }
      const changed = JSON.stringify(prepared) !== JSON.stringify(source);
      if (!changed) return originalCallApi(method, payload, ...rest);
      try {
        return await originalCallApi(method, prepared, ...rest);
      } catch (err) {
        if (!isPremiumEmojiUnsupportedError(err)) throw err;
        return originalCallApi(method, source, ...rest);
      }
    };
  }

  Object.defineProperty(telegram, PATCH, { value: true, enumerable: false, configurable: false });
}

async function probe(telegram, chatId) {
  const first = entries[0];
  if (!first) throw new Error('Archive custom emoji mapping kosong.');
  const [emoji, cfg] = first;
  return telegram.callApi('sendMessage', {
    chat_id: chatId,
    text: `<b>🔎</b> <tg-emoji emoji-id="${String(cfg.customEmojiId)}">${escapeHtml(emoji)}</tg-emoji> <code>Archive ID: ${String(cfg.customEmojiId)}</code>`,
    parse_mode: 'HTML'
  });
}

module.exports = {
  install,
  installContext,
  probe,
  entries,
  applyArchiveCustomEmojis,
  applyArchiveCustomEmojisToHtml,
  applyArchiveCustomEmojisToMarkdownV2,
  markdownLegacyToHtml,
  applyArchiveCustomEmojiIconsToReplyMarkup,
  isPremiumEmojiUnsupportedError
};
