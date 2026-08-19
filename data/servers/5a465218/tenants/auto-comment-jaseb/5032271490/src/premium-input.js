'use strict';

// Convert Telegram Bot API custom-emoji entities received from the admin into
// a portable marker that the GramJS sender can later turn back into
// MessageEntityCustomEmoji. This is intentionally input-only; it does not
// change any Auto Comment/Jaseb business logic.
function toPremiumText(message) {
  const text = String(message?.text || '');
  const entities = Array.isArray(message?.entities) ? message.entities : [];
  if (!text || !entities.length) return text;

  const custom = entities
    .filter(e => String(e?.type || '').toLowerCase() === 'custom_emoji')
    .map(e => ({
      offset: Number(e.offset),
      length: Number(e.length),
      id: String(e.custom_emoji_id || e.customEmojiId || '')
    }))
    .filter(e => Number.isInteger(e.offset) && Number.isInteger(e.length) && e.length > 0 && /^\d+$/.test(e.id))
    .sort((a, b) => a.offset - b.offset);

  if (!custom.length) return text;

  // Insert from right to left so Telegram's UTF-16 offsets remain valid.
  let out = text;
  for (let i = custom.length - 1; i >= 0; i--) {
    const e = custom[i];
    const visible = text.slice(e.offset, e.offset + e.length);
    out = `${out.slice(0, e.offset)}<tg-emoji emoji-id="${e.id}">${visible}</tg-emoji>${out.slice(e.offset + e.length)}`;
  }
  return out;
}

module.exports = { toPremiumText };
