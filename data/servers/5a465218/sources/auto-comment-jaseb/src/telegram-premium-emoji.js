'use strict';

// Premium Emoji bridge for the GramJS sender.
// The business logic of Auto Comment / Jaseb is intentionally untouched.
// This module only converts the same Archive unicode -> customEmojiId mapping
// into MTProto MessageEntityCustomEmoji entities before sendMessage().

const fs = require('fs');
const path = require('path');
const { Api } = require('telegram');
const bigInt = require('big-integer');

// Use the Archive custom-emoji database as the source of truth, exactly like
// the proven Archive formatter. Keep the root mapping as a fallback only.
const ARCHIVE_MAP = process.env.ARCHIVE_CUSTOM_EMOJI_FILE || path.join(
  __dirname, '..', '..', '..', 'sources', 'archive-store', 'data', 'custom_emojis.json'
);
const ROOT_MAP = process.env.CUSTOM_EMOJI_MAP_FILE || path.join(
  __dirname, '..', '..', '..', 'emoji', 'custom_emojis.json'
);
const TAGALL_MAP = process.env.TAGALL_EMOJI_FILE || path.join(
  __dirname, '..', '..', '..', 'sources', 'tagall', 'src', 'emoji.js'
);

function readJsonMap(file) {
  try {
    if (!file || !fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function readTagallMap(file) {
  try {
    if (!file || !fs.existsSync(file)) return {};
    delete require.cache[require.resolve(file)];
    const mod = require(file);
    const table = mod?.EMOJI && typeof mod.EMOJI === 'object' ? mod.EMOJI : {};
    const out = {};
    for (const item of Object.values(table)) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const visible = String(item[0] || '');
      const id = String(item[1] || '');
      if (visible && /^\d+$/.test(id)) out[visible] = { fallback: visible, customEmojiId: id };
    }
    return out;
  } catch (_) {
    return {};
  }
}

function buildEntries() {
  // IMPORTANT: Archive wins. Root/Tagall are fallback only and can never
  // replace an Archive customEmojiId.
  const merged = {
    ...readTagallMap(TAGALL_MAP),
    ...readJsonMap(ROOT_MAP),
    ...readJsonMap(ARCHIVE_MAP)
  };

  return Object.entries(merged)
    .filter(([emoji, cfg]) => emoji && cfg && /^\d+$/.test(String(cfg.customEmojiId || '')))
    .sort((a, b) => Array.from(b[0]).length - Array.from(a[0]).length);
}

const HTML_ESCAPE = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

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

function normalizeExistingCustomEmojiTags(text, byEmoji) {
  const source = String(text ?? '');
  return source.replace(
    /<tg-emoji\b[^>]*\bemoji-id\s*=\s*["'](\d+)["'][^>]*>([\s\S]*?)<\/tg-emoji>/gi,
    (full, id, inner) => {
      const visible = String(inner).replace(/<[^>]+>/g, '').trim();
      const cfg = byEmoji.get(visible);
      if (!cfg) return full;
      return `<tg-emoji emoji-id="${String(cfg.customEmojiId)}">${HTML_ESCAPE(visible)}</tg-emoji>`;
    }
  );
}

// Same basic mechanism as Archive: Unicode fallback -> <tg-emoji emoji-id="...">…
function applyArchiveCustomEmojisToHtml(text) {
  if (typeof text !== 'string' || !text) return text;
  const entries = buildEntries();
  if (!entries.length) return text;

  const byEmoji = new Map(entries);
  const protectedTags = [];
  const token = index => `\u0003ARCHIVE_TG_EMOJI_${index}\u0004`;

  // Keep already tagged emojis intact, but normalize their IDs against Archive.
  const protectedText = String(text).replace(
    /<tg-emoji\b[^>]*>[\s\S]*?<\/tg-emoji>/gi,
    match => {
      const normalized = normalizeExistingCustomEmojiTags(match, byEmoji);
      const index = protectedTags.push(normalized) - 1;
      return token(index);
    }
  );

  // Never touch arbitrary HTML tags; only text nodes are converted.
  const converted = protectedText
    .split(/(<[^>]+>)/g)
    .map(part => part.startsWith('<') ? part : replaceBareArchiveEmojis(part, entries))
    .join('');

  return converted.replace(
    /\u0003ARCHIVE_TG_EMOJI_(\d+)\u0004/g,
    (_, index) => protectedTags[Number(index)]
  );
}

function replaceBareArchiveEmojis(text, entries = buildEntries()) {
  if (typeof text !== 'string' || !text || !entries.length) return text;
  let result = String(text);
  for (const [emoji, cfg] of entries) {
    result = result.split(emoji).join(
      `<tg-emoji emoji-id="${String(cfg.customEmojiId)}">${HTML_ESCAPE(emoji)}</tg-emoji>`
    );
  }
  return result;
}

function extractExplicitCustomEmoji(text) {
  const source = String(text ?? '');
  const entities = [];
  let out = '';
  let cursor = 0;

  const markerRe = /<tg-emoji\b[^>]*\bemoji-id\s*=\s*["'](\d+)["'][^>]*>([\s\S]*?)<\/tg-emoji>|!\[([^\]]*)\]\(tg:\/\/emoji\?id=(\d+)\)/gi;
  let match;

  while ((match = markerRe.exec(source))) {
    out += source.slice(cursor, match.index);
    const visible = String(match[2] ?? match[3] ?? '');
    const id = String(match[1] ?? match[4] ?? '');
    const offset = out.length; // JS string offsets are UTF-16, same as Telegram entities.
    out += visible;
    if (visible && /^\d+$/.test(id)) {
      entities.push({ offset, length: visible.length, id });
    }
    cursor = match.index + match[0].length;
  }

  out += source.slice(cursor);
  return { text: out, entities };
}

function findCustomEmojiEntities(text) {
  const source = String(text ?? '');
  if (!source) return [];

  const entries = buildEntries();
  if (!entries.length) return [];

  const entities = [];
  let cursor = 0;

  while (cursor < source.length) {
    let best = null;

    for (const [emoji, cfg] of entries) {
      const index = source.indexOf(emoji, cursor);
      if (index < 0) continue;
      if (!best || index < best.index || (index === best.index && emoji.length > best.emoji.length)) {
        best = { index, emoji, cfg };
      }
    }

    if (!best) break;

    entities.push(new Api.MessageEntityCustomEmoji({
      offset: best.index,
      length: best.emoji.length,
      documentId: bigInt(String(best.cfg.customEmojiId))
    }));

    cursor = best.index + best.emoji.length;
  }

  return entities;
}

function preparePremiumMessage(client, text) {
  const source = String(text ?? '');
  if (!source) return { message: source, formattingEntities: [] };

  // 1) Respect explicit Premium markers saved by the Bot API input handler.
  const explicit = extractExplicitCustomEmoji(source);
  if (explicit.entities.length) {
    return {
      message: explicit.text,
      formattingEntities: explicit.entities.map(e => new Api.MessageEntityCustomEmoji({
        offset: e.offset,
        length: e.length,
        documentId: bigInt(String(e.id))
      }))
    };
  }

  // 2) For ordinary saved text, use the exact Archive mechanism:
  // Unicode -> <tg-emoji> -> MTProto custom-emoji entity.
  // This is presentation-only; the caller's Auto Comment/Jaseb logic is untouched.
  const html = applyArchiveCustomEmojisToHtml(source);
  const tagged = extractExplicitCustomEmoji(html);
  if (tagged.entities.length) {
    return {
      message: tagged.text,
      formattingEntities: tagged.entities.map(e => new Api.MessageEntityCustomEmoji({
        offset: e.offset,
        length: e.length,
        documentId: bigInt(String(e.id))
      }))
    };
  }

  // 3) Preserve any normal GramJS formatting that may already be present.
  let message = source;
  let formattingEntities = [];
  try {
    const parser = client?.parseMode;
    if (parser && typeof parser.parse === 'function') {
      const parsed = parser.parse(source);
      if (Array.isArray(parsed)) {
        message = String(parsed[0] ?? source);
        formattingEntities = Array.isArray(parsed[1]) ? [...parsed[1]] : [];
      }
    }
  } catch (_) {}

  return { message, formattingEntities: formattingEntities.concat(findCustomEmojiEntities(message)) };
}

module.exports = {
  preparePremiumMessage,
  findCustomEmojiEntities,
  applyArchiveCustomEmojisToHtml,
  buildEntries
};
