'use strict';

const fs = require('fs');
const path = require('path');
const { Markup } = require('telegraf');

const USERS_FILE = path.join(process.cwd(), 'data', 'customers.json');

function loadTargets(ownerIds = []) {
  if (!fs.existsSync(USERS_FILE)) {
    throw new Error('data/customers.json tidak ditemukan.');
  }

  const raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));

  let records = [];
  if (Array.isArray(raw)) {
    records = raw;
  } else if (Array.isArray(raw.users)) {
    records = raw.users;
  } else if (raw && typeof raw === 'object') {
    records = Object.values(raw).filter(v => v && typeof v === 'object');
  }

  const ownerSet = new Set(ownerIds.map(String));
  const ids = new Set();

  for (const user of records) {
    if (!user || typeof user !== 'object') continue;

    const candidates = [
      user.telegramId,
      user.telegram_id,
      user.userId,
      user.user_id,
      user.chatId,
      user.chat_id,
      user.id,
    ];

    for (const value of candidates) {
      if (value == null) continue;

      const id = String(value).trim();
      if (!/^-?\d+$/.test(id)) continue;
      if (ownerSet.has(id)) continue;

      ids.add(id);
      break;
    }
  }

  return [...ids];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class BroadcastHandler {
  static register(bot) {
    bot.action('owner:broadcast', async ctx => {
      await ctx.answerCbQuery();

      ctx.session = ctx.session || {};
      ctx.session.broadcast = {
        waiting: true,
        sourceChatId: null,
        sourceMessageId: null,
      };

      await ctx.reply(
        '📢 <b>BROADCAST</b>\n\n' +
        'Kirim pesan yang ingin dibroadcast sekarang.\n\n' +
        '✅ Bisa teks + Premium Custom Emoji.\n' +
        '❌ Untuk versi pertama, kirim sebagai pesan teks.\n\n' +
        'Kirim /cancel untuk membatalkan.',
        { parse_mode: 'HTML' }
      );
    });

    bot.action('owner:broadcast:send', async ctx => {
      await ctx.answerCbQuery('⏳ Broadcast dimulai...');

      const state = ctx.session?.broadcast;
      if (!state?.sourceChatId || !state?.sourceMessageId) {
        await ctx.reply('❌ Tidak ada pesan broadcast yang siap dikirim.');
        return;
      }

      ctx.session.broadcast = null;

      try {
        const ownerIds = String(process.env.PLATFORM_OWNER_IDS || '')
          .split(',')
          .map(v => v.trim())
          .filter(Boolean);

        const targets = loadTargets(ownerIds);

        if (!targets.length) {
          await ctx.reply('❌ Tidak ada target user yang ditemukan.');
          return;
        }

        let success = 0;
        let failed = 0;

        const progress = await ctx.reply(
          `⏳ <b>Broadcast berjalan...</b>\n\n` +
          `👥 Target: <b>${targets.length}</b>\n` +
          `✅ Berhasil: <b>0</b>\n` +
          `❌ Gagal: <b>0</b>`,
          { parse_mode: 'HTML' }
        );

        for (let i = 0; i < targets.length; i++) {
          const targetId = targets[i];

          try {
            await ctx.telegram.copyMessage(
              targetId,
              state.sourceChatId,
              state.sourceMessageId
            );
            success++;
          } catch (err) {
            failed++;
          }

          if ((i + 1) % 10 === 0 || i === targets.length - 1) {
            try {
              await ctx.telegram.editMessageText(
                ctx.chat.id,
                progress.message_id,
                undefined,
                `<blockquote><b>📢 BROADCAST BERJALAN</b>\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `👥 Target: <b>${targets.length}</b>\n` +
                `📊 Progress: <b>${i + 1}/${targets.length}</b>\n` +
                `✅ Berhasil: <b>${success}</b>\n` +
                `❌ Gagal: <b>${failed}</b></blockquote>`,
                { parse_mode: 'HTML' }
              );
            } catch (err) {
      console.error('[Broadcast target]', err);
    }
          }

          await sleep(80);
        }

        await ctx.reply(
          `<blockquote><b>🎉 BROADCAST SELESAI</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `👥 Target: <b>${targets.length}</b>\n` +
          `✅ Berhasil: <b>${success}</b>\n` +
          `❌ Gagal: <b>${failed}</b></blockquote>`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        console.error('[BroadcastHandler] gagal:', err);
        await ctx.reply(`❌ Broadcast gagal: ${err.message}`);
      }
    });

    bot.action('owner:broadcast:cancel', async ctx => {
      await ctx.answerCbQuery('Broadcast dibatalkan.');
      if (ctx.session) ctx.session.broadcast = null;
      await ctx.reply('❌ Broadcast dibatalkan.');
    });
  }

  static async handleTextInput(ctx) {
    if (!ctx.store?.isOwner?.(ctx.from?.id)) return false;

    const state = ctx.session?.broadcast;
    if (!state?.waiting) return false;

    if (String(ctx.message?.text || '').trim() === '/cancel') {
      ctx.session.broadcast = null;
      await ctx.reply('❌ Broadcast dibatalkan.');
      return true;
    }

    state.waiting = false;
    state.sourceChatId = ctx.chat.id;
    state.sourceMessageId = ctx.message.message_id;

    let targetCount = 0;

    try {
      const ownerIds = String(
          process.env.PLATFORM_OWNER_IDS ||
          process.env.PLATFORM_OWNER_ID ||
          ''
        )
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);

      targetCount = loadTargets(ownerIds).length;
    } catch (err) {
      console.error('[Broadcast target]', err);
    }

    await ctx.reply(
      `<blockquote><b>📢 KONFIRMASI BROADCAST</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `👥 Target: <b>${targetCount}</b> user\n\n` +
      `✅ Pesan akan dikirim sebagai pesan asli, jadi Premium Custom Emoji yang kamu pakai akan ikut.\n\n` +
      `Lanjut kirim broadcast?</blockquote>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(' Kirim Broadcast', 'owner:broadcast:send'),
            Markup.button.callback(' Batal', 'owner:broadcast:cancel'),
          ],
        ]),
      }
    );

    return true;
  }
}

module.exports = BroadcastHandler;
