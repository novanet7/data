'use strict';

// Premium Emoji sender bridge for the existing GramJS Auto Comment/Jaseb flow.
// The business logic is intentionally untouched. This helper only converts
// Archive Unicode mappings / stored <tg-emoji> markers into HTML that GramJS
// parses into Telegram MessageEntityCustomEmoji entities.
const fs = require('fs');
const path = require('path');

const MAP_FILE = path.join(process.cwd(), 'sources', 'archive-store', 'data', 'custom_emojis.json');
const FALLBACK_MAP_FILE = path.join(__dirname, '..', '..', '..', '..', 'emoji', 'custom_emojis.json');

function loadMap() {
  const files = [MAP_FILE, FALLBACK_MAP_FILE];
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const entries = Object.entries(parsed)
        .filter(([emoji, cfg]) => emoji && cfg && /^\d+$/.test(String(cfg.customEmojiId || '')))
        .sort((a, b) => Array.from(b[0]).length - Array.from(a[0]).length);
      if (entries.length) return entries;
    } catch (_) {}
  }
  return [];
}

const ENTRIES = loadMap();
const TG_EMOJI_RE = /<tg-emoji\b[^>]*?\bemoji-id\s*=\s*["']\d+["'][^>]*>[\s\S]*?<\/tg-emoji>/gi;

function preparePremiumMessage(text) {
  const source = String(text ?? '');
  if (!source) return { message: source, parseMode: undefined, premium: false };

  // Protect already captured Premium IDs from the Telegram input bridge.
  const protectedTags = [];
  let working = source.replace(TG_EMOJI_RE, match => {
    const index = protectedTags.push(match) - 1;
    return `\u0001TG_PREMIUM_${index}\u0002`;
  });

  // Upgrade older saved messages that contain only the Archive Unicode emoji.
  // Only text outside the protected Telegram/HTML-like tags is changed.
  const replaceTextNode = value => {
    let out = value;
    for (const [emoji, cfg] of ENTRIES) {
      const id = String(cfg.customEmojiId);
      out = out.split(emoji).join(`<tg-emoji emoji-id="${id}">${emoji}</tg-emoji>`);
    }
    return out;
  };

  working = working
    .split(/(<[^>]+>)/g)
    .map(part => part.startsWith('<') ? part : replaceTextNode(part))
    .join('');

  working = working.replace(/\u0001TG_PREMIUM_(\d+)\u0002/g, (_, i) => protectedTags[Number(i)]);

  const premium = /<tg-emoji\b[^>]*?\bemoji-id\s*=\s*["']\d+["'][^>]*>[\s\S]*?<\/tg-emoji>/i.test(working);
  return {
    message: working,
    parseMode: premium ? 'html' : undefined,
    premium
  };
}

module.exports = { preparePremiumMessage, entries: ENTRIES };
