'use strict';

const CustomEmojiService = require('../services/customEmojiService');

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function price(n) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(n || 0);
}

function markdownToHtml(text) {
  let raw = String(text ?? '');
  const stash = [];
  const token = value => { const i = stash.push(value) - 1; return `\u0000${i}\u0000`; };
  raw = raw.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, label, url) => token(`<a href="${esc(url)}">${esc(label)}</a>`));
  raw = raw.replace(/`([^`\n]+)`/g, (_, v) => token(`<code>${esc(v)}</code>`));
  raw = raw.replace(/\*([^*\n]+)\*/g, (_, v) => token(`<b>${esc(v)}</b>`));
  raw = raw.replace(/_([^_\n]+)_/g, (_, v) => token(`<i>${esc(v)}</i>`));
  raw = raw.replace(/\\([_*`])/g, '$1');
  raw = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  raw = raw.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
  return raw;
}

function decorateBlockquote(inner) {
  let body = String(inner ?? '').trim();
  if (!body) return '<blockquote><b>✦ VALQENIX</b>\n━━━━━━━━━━━━━━━━━━</blockquote>';

  // Normalize line breaks and make the first line the consistent page heading.
  const lines = body.split(/\r?\n/);
  const firstIndex = lines.findIndex(line => String(line).replace(/<[^>]+>/g, '').trim());
  const idx = firstIndex >= 0 ? firstIndex : 0;
  const first = String(lines[idx] || '').trim();
  const visibleFirst = first.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  const heading = visibleFirst.replace(/^✦\s*/i, '').trim();
  lines[idx] = `<b>✦ ${esc(heading || 'VALQENIX')}</b>`;
  if (lines[idx + 1] !== '━━━━━━━━━━━━━━━━━━') lines.splice(idx + 1, 0, '━━━━━━━━━━━━━━━━━━');
  return `<blockquote>${lines.map(line => line || ' ').join('\n')}</blockquote>`;
}

/**
 * One global Telegram UI format: blockquote + bold heading + separator.
 * Input messages from users are never passed through this helper.
 */

function applyCustomEmojis(text) {
  if (typeof text !== 'string' || !text) return text;

  const data = CustomEmojiService.all();
  const entries = Object.entries(data)
    .filter(([emoji, cfg]) => emoji && cfg?.customEmojiId)
    .sort((a, b) => Array.from(b[0]).length - Array.from(a[0]).length);

  if (!entries.length) return text;

  const placeholders = [];

  const token = html => {
    const i = placeholders.push(html) - 1;
    return `\u0001CUSTOM_EMOJI_${i}\u0002`;
  };

  let result = String(text);

  for (const [emoji, cfg] of entries) {
    const id = String(cfg.customEmojiId);
    const fallback = esc(emoji);

    result = result.split(emoji).join(
      token(`<tg-emoji emoji-id="${esc(id)}">${fallback}</tg-emoji>`)
    );
  }

  return result.replace(
    /\u0001CUSTOM_EMOJI_(\d+)\u0002/g,
    (_, i) => placeholders[Number(i)]
  );
}



/**
 * Decorate inline-keyboard buttons with Telegram Premium custom emoji icons.
 * The existing 76-emoji mapping is the source of truth. A leading configured
 * fallback emoji in a button label becomes icon_custom_emoji_id, while the
 * visible button text keeps only the label. Buttons that are pure emoji
 * (for example the 76-item Set Emoji selector) are left untouched.
 */
function applyCustomEmojiIconsToReplyMarkup(replyMarkup) {
  if (!replyMarkup || !Array.isArray(replyMarkup.inline_keyboard)) return replyMarkup;

  const data = CustomEmojiService.all();
  const configured = Object.entries(data)
    .filter(([emoji, cfg]) => emoji && cfg?.customEmojiId)
    .sort((a, b) => Array.from(b[0]).length - Array.from(a[0]).length);

  if (!configured.length) return replyMarkup;

  const keyboard = replyMarkup.inline_keyboard.map(row => Array.isArray(row)
    ? row.map(button => {
        if (!button || typeof button !== 'object' || typeof button.text !== 'string') return button;
        if (button.icon_custom_emoji_id) return button;

        for (const [fallbackEmoji, cfg] of configured) {
          if (!button.text.startsWith(fallbackEmoji)) continue;

          const rest = button.text.slice(fallbackEmoji.length).trimStart();
          // Keep pure emoji buttons unchanged; this protects the 76-item
          // admin selector from becoming icon-only duplicates.
          if (!rest) return button;

          return {
            ...button,
            text: rest,
            icon_custom_emoji_id: String(cfg.customEmojiId)
          };
        }

        return button;
      })
    : row
  );

  return { ...replyMarkup, inline_keyboard: keyboard };
}

function applyCustomEmojisToHtml(text) {
  if (typeof text !== 'string' || !text) return text;

  // Protect already-rendered Premium Emoji tags from a second formatting pass.
  // StoreRuntime patches direct Telegram API calls globally, while some services
  // (for example channel notifications) already normalize the message first.
  // Without this guard a second pass would create nested <tg-emoji> tags and
  // Telegram would reject the message, causing the Unicode fallback to appear.
  const protectedTags = [];
  const protectedText = String(text).replace(
    /<tg-emoji\b[^>]*>[\s\S]*?<\/tg-emoji>/gi,
    match => {
      const index = protectedTags.push(match) - 1;
      return `\u0003TG_EMOJI_${index}\u0004`;
    }
  );

  const converted = protectedText
    .split(/(<[^>]+>)/g)
    .map(part => part.startsWith('<') ? part : applyCustomEmojis(part))
    .join('');

  return converted.replace(/\u0003TG_EMOJI_(\d+)\u0004/g, (_, index) => protectedTags[Number(index)]);
}

function normalizeTelegramText(text, parseMode = '') {
  if (typeof text !== 'string') return text;

  const raw = text.trim();

  if (!raw) {
    return '<blockquote><b>✦ VALQENIX</b>\n━━━━━━━━━━━━━━━━━━</blockquote>';
  }

  // Pesan yang sudah berupa HTML blockquote tetap dipertahankan,
  // tetapi emoji Unicode yang sudah dikonfigurasi diubah menjadi
  // Telegram Premium Custom Emoji.
  if (/^<blockquote(?:\s|>)/i.test(raw)) {
    return applyCustomEmojisToHtml(
      raw.replace(/<br\s*\/?\s*>/gi, '\n')
    );
  }

  const mode = String(parseMode || '').toUpperCase();

  // HTML eksplisit dipertahankan. Markdown/plain text dikonversi dahulu.
  const html = mode === 'HTML' ? raw : markdownToHtml(raw);

  return applyCustomEmojisToHtml(
    decorateBlockquote(html)
  );
}

function box(title, lines = [], footer = '') {
  const cleanTitle = String(title || 'VALQENIX').trim();
  const body = [`<b>✦ ${esc(cleanTitle)}</b>`, '━━━━━━━━━━━━━━━━━━'];
  for (const line of lines) body.push(esc(line));
  if (footer) body.push('━━━━━━━━━━━━━━━━━━', esc(footer));
  return `<blockquote>${body.join('\n')}</blockquote>`;
}

class MessageFormatter {
  static normalize(text, parseMode = '') { return normalizeTelegramText(text, parseMode); }

  static buildBox(_unused, title, lines = [], showFooter = true) {
    return box(title, lines, showFooter ? '' : '');
  }

  static categoryMenu(_unused, storeName, welcomeMsg, activeCategories, footer, username = '') {
    const lines = [];
    const displayName = username
      ? `Senang melihat kamu kembali, @${username}.`
      : 'Senang melihat kamu kembali.';
    lines.push(displayName);
    lines.push('', '📤 Temukan akun Telegram yang sesuai dengan kebutuhanmu dengan mudah dan cepat.');
    lines.push('', '👋 Pilih menu di bawah untuk mulai berbelanja.');
    if (footer) lines.push('', `ℹ️ ${footer}`);
    return box('👋 WELCOME TO MY STORE', lines);
  }

  static productListInCategory(_unused, storeName, categoryLabel, products) {
    const lines = [`📂 ${categoryLabel}`, ''];
    for (const p of products) {
      lines.push(`${p.stockCount > 0 ? '✅' : '❌'} ${p.name}`);
      lines.push(`   💰 ${price(p.price)} | 📦 ${p.stockCount} slot`);
    }
    return box(storeName, lines);
  }

  static productDetail(_unused, storeName, product, qty = 1) {
    const lines = [
      `📱 ${product.name}`, '',
      `💰 Harga: ${price(product.price)} / slot`,
      `📦 Stok: ${product.stockCount > 0 ? `${product.stockCount} slot tersedia` : '❌ Kosong'}`,
    ];
    if (product.description) lines.push('', `📝 ${product.description}`);
    if (product.stockCount > 0) lines.push('', `🛒 Total: ${price(product.price * qty)}`, '', 'Pilih jumlah slot:');
    return box(storeName, lines);
  }

  static menuScreen(title, lines = []) { return box(title, lines); }

  static selectionScreen(title, description, footer = '') {
    const lines = [];
    if (description) lines.push(description);
    if (footer) lines.push('', footer);
    return box(title, lines);
  }

  static orderStatus(_unused, storeName, orders) {
    const status = { awaiting_payment: '💳 Menunggu Bayar', pending: '⏳ Diproses', paid: '✅ Dibayar — Menunggu Pengiriman', completed: '✅ Selesai', failed: '❌ Gagal', cancelled: '🚫 Dibatalkan' };
    const lines = ['📋 Riwayat Pesanan', ''];
    if (!orders.length) lines.push('Belum ada pesanan.');
    for (const o of orders) {
      lines.push(
        `🆔 ${o.orderId}`,
        `📦 ${o.productName} x${o.quantity}`,
        `💰 ${price(o.totalAmount)}`,
        `📊 ${status[o.status] || o.status}`,
        '',
      );
    }
    lines.push('Tekan tombol Lacak untuk melihat status terbaru pesanan.');
    return box(storeName, lines);
  }
}

module.exports = MessageFormatter;
module.exports.normalizeTelegramText = normalizeTelegramText;

module.exports.applyCustomEmojisToHtml = applyCustomEmojisToHtml;
module.exports.applyCustomEmojiIconsToReplyMarkup = applyCustomEmojiIconsToReplyMarkup;
