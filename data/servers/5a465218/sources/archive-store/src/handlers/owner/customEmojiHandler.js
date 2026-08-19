'use strict';

const CustomEmojiService = require('../../services/customEmojiService');

// Keep callback payloads short and ASCII-only. Telegram limits callback_data to
// 64 bytes; the selected emoji itself is stored in the session, not in the
// callback payload.
const BASE_EMOJIS = [
  '❌', '✅', '💰', '🆔', '📦', '⚠️', '💳', '📱', '👤', '🏦', '👋', '📥',
  '⏳', '🔐', '📋', '📊', '💾', '🏪', '🔢', '📷', '🚫', '📤', '💼', '💵',
  '✦', '➕', '🏷️', '⏰', '🚪', '🔄', '📞', '🌐', '🛒', '🔖', '🗑️', '🔒',
  '➖', '⚙️', '🔎', '📩', '🔴', '🎨', '⏱️', '✏️', '⚪', '🚀', '🔧', '💸',
  '🔵', '🔑', '📌', '📄', '♻️', '🧹', '👀', '✨', '📸', '📂', '📝', '🛍️',
  '🧾', '📜', '🛠️', '🎉', '📁', '🧨', '📢', '🔍', '⬅️', '🔔', '📎', '🤖',
  '📲', '👑', '🔗', '💬', '🖼️', '🟢', '⬅', '⬛', '⬜', '👥', '🕒', '🟠',
  '🟡', '🟣', '🟥', '🟦', '🟧', '🟩', '🟪', '🟫', '🩷', '🟨', 'ℹ️', '↩️', '🎞️'
];

const getEmojiList = () => {
  // Keep any previously configured/auto-discovered emoji visible in Set Emoji,
  // even if it was not present in the original static list.
  const configuredKeys = Object.keys(CustomEmojiService.all());
  return Array.from(new Set([...BASE_EMOJIS, ...configuredKeys]));
};

async function safeAnswerCbQuery(ctx, text, options) {
  try {
    if (!ctx?.callbackQuery) return;
    await ctx.answerCbQuery(text, options);
  } catch (_) {
    // Callback query may already be answered/expired. Never let that crash the
    // owner handler or the bot update loop.
  }
}

class CustomEmojiHandler {
  static async handleTextInput(ctx) {
    if (!ctx.store?.isOwner(ctx.from.id)) return false;

    const pending = ctx.session?.customEmojiPending;
    if (!pending?.emoji) return false;

    const createdAt = Number(pending.createdAt || 0);
    if (createdAt && Date.now() - createdAt > 10 * 60 * 1000) {
      delete ctx.session.customEmojiPending;
      ctx.saveSession?.();
      await ctx.reply('❌ Sesi Set Emoji sudah kedaluwarsa. Silakan pilih emoji lagi dari menu Set Emoji.');
      return true;
    }

    try {
      const entities = [
        ...(Array.isArray(ctx.message?.entities) ? ctx.message.entities : []),
        ...(Array.isArray(ctx.message?.caption_entities) ? ctx.message.caption_entities : [])
      ];

      const custom = entities.find(entity => (
        entity?.type === 'custom_emoji' &&
        entity?.custom_emoji_id &&
        /^\d+$/.test(String(entity.custom_emoji_id))
      ));

      if (!custom) {
        await ctx.reply(
          '❌ Pesan tersebut bukan Custom Emoji Premium.\n\n' +
          'Silakan kirim 1 emoji premium langsung dari Telegram.'
        );
        return true;
      }

      const saved = CustomEmojiService.set(pending.emoji, custom.custom_emoji_id);

      delete ctx.session.customEmojiPending;
      ctx.saveSession?.();

      await ctx.reply(
        '✅ Emoji berhasil disimpan!\n\n' +
        `Emoji: ${saved.fallback}\n` +
        `Custom Emoji ID: ${saved.customEmojiId}`
      );
    } catch (err) {
      try {
        await ctx.reply(
          '❌ Gagal menyimpan Custom Emoji.\n\n' +
          `Alasan: ${err?.message || 'Unknown error'}`
        );
      } catch (_) {
        // Ignore secondary Telegram send errors.
      }
    }

    return true;
  }

  static register(bot) {
    const PAGE_SIZE = 9;
    const COLS = 3;

    const renderMenu = async (ctx, page = 0) => {
      const emojis = getEmojiList();
      const data = CustomEmojiService.all();
      const totalPages = Math.max(1, Math.ceil(emojis.length / PAGE_SIZE));
      const safePage = Math.min(Math.max(Number(page) || 0, 0), totalPages - 1);
      const start = safePage * PAGE_SIZE;
      const visible = emojis.slice(start, start + PAGE_SIZE);
      const rows = [];

      for (let i = 0; i < visible.length; i += COLS) {
        rows.push(visible.slice(i, i + COLS).map((emoji, offset) => {
          const index = start + i + offset;
          const configured = Boolean(data[emoji]?.customEmojiId);
          return {
            text: `${configured ? '✅' : '⬜'} ${emoji}`,
            callback_data: `owner:custom_emoji:set:${index}:${safePage}`
          };
        }));
      }

      const nav = [];
      if (safePage > 0) {
        nav.push({ text: '⬅️ Sebelumnya', callback_data: `owner:custom_emoji:page:${safePage - 1}` });
      }
      nav.push({ text: `${safePage + 1}/${totalPages}`, callback_data: 'owner:custom_emoji:noop' });
      if (safePage < totalPages - 1) {
        nav.push({ text: 'Berikutnya ➡', callback_data: `owner:custom_emoji:page:${safePage + 1}` });
      }
      rows.push(nav);
      rows.push([{ text: '◀️ Kembali', callback_data: 'owner:back_main' }]);

      const from = start + 1;
      const to = Math.min(start + visible.length, emojis.length);
      const text =
        '🎨 SET EMOJI PREMIUM\n' +
        '━━━━━━━━━━━━━━━━━━\n\n' +
        `📄 Halaman ${safePage + 1}/${totalPages}\n` +
        `🔢 Menampilkan ${from}–${to} dari ${emojis.length} emoji\n\n` +
        'Pilih emoji yang ingin diganti dengan Custom Emoji Premium.\n' +
        '✅ = sudah mempunyai Custom Emoji\n' +
        '⬜ = belum di-set';

      if (ctx.callbackQuery?.message?.text || ctx.callbackQuery?.message?.caption) {
        try {
          await ctx.editMessageText(text, { reply_markup: { inline_keyboard: rows } });
          return;
        } catch (err) {
          // Fallback when current message cannot be edited (e.g. photo/animation).
        }
      }
      await ctx.reply(text, { reply_markup: { inline_keyboard: rows } });
    };

    bot.action('owner:custom_emoji', async ctx => {
      try {
        await safeAnswerCbQuery(ctx);
        await renderMenu(ctx, 0);
      } catch (err) {
        await safeAnswerCbQuery(ctx, `Gagal membuka Set Emoji: ${err?.message || 'Unknown error'}`, { show_alert: true });
      }
    });

    bot.action(/^owner:custom_emoji:page:(\d+)$/, async ctx => {
      try {
        await safeAnswerCbQuery(ctx);
        await renderMenu(ctx, Number(ctx.match?.[1]));
      } catch (err) {
        await safeAnswerCbQuery(ctx, `Gagal membuka halaman: ${err?.message || 'Unknown error'}`, { show_alert: true });
      }
    });

    bot.action('owner:custom_emoji:noop', async ctx => {
      await safeAnswerCbQuery(ctx);
    });

    bot.action(/^owner:custom_emoji:set:(\d+):(\d+)$/, async ctx => {
      const emojis = getEmojiList();

      try {
        const index = Number(ctx.match?.[1]);
        const page = Number(ctx.match?.[2]);
        if (!Number.isInteger(index) || index < 0 || index >= emojis.length) {
          await safeAnswerCbQuery(ctx, 'Emoji tidak valid.', { show_alert: true });
          return;
        }

        const emoji = emojis[index];

        if (!ctx.session) ctx.session = {};
        ctx.session.customEmojiPending = {
          emoji,
          page: Number.isInteger(page) ? page : 0,
          createdAt: Date.now()
        };
        ctx.saveSession?.();

        await safeAnswerCbQuery(ctx);
        await ctx.reply(
          '🎨 Set Emoji Premium\n\n' +
          `Emoji: ${emoji}\n\n` +
          'Silakan kirim 1 emoji premium yang ingin digunakan sebagai pengganti emoji ini.'
        );
      } catch (err) {
        await safeAnswerCbQuery(ctx, `Gagal memproses emoji: ${err?.message || 'Unknown error'}`, { show_alert: true });
      }
    });
  }
}

module.exports = CustomEmojiHandler;
