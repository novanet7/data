'use strict';

const { Markup } = require('telegraf');
const logger = require('../utils/logger');

/**
 * Mandatory channel subscription gate.
 * Configure REQUIRED_SUBSCRIPTION_CHANNEL_ID and REQUIRED_SUBSCRIPTION_CHANNEL_URL.
 * NOTIFICATION_CHANNEL_ID/URL are accepted as a backwards-compatible fallback,
 * so the same channel can be used for both logging and mandatory subscription.
 */
class SubscriptionGate {
  static register(bot) {
    const cache = new Map();
    const CACHE_MS = 15_000;

    const channelId = String(
      process.env.REQUIRED_SUBSCRIPTION_CHANNEL_ID ||
      process.env.NOTIFICATION_CHANNEL_ID || ''
    ).trim();
    const channelUrl = String(
      process.env.REQUIRED_SUBSCRIPTION_CHANNEL_URL ||
      process.env.NOTIFICATION_CHANNEL_URL || ''
    ).trim();

    const enabled = Boolean(channelId);

    const isAllowedStatus = member => {
      if (!member) return false;
      return member.status === 'creator' || member.status === 'administrator' ||
        member.status === 'member' || (member.status === 'restricted' && member.is_member !== false);
    };

    const keyFor = ctx => `${ctx.storeId || 'main'}:${ctx.from?.id || 'unknown'}`;

    const check = async ctx => {
      if (!enabled || !ctx.from?.id) return true;
      if (ctx.store?.isOwner?.(ctx.from.id)) return true;

      const key = keyFor(ctx);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.allowed;

      try {
        const member = await ctx.telegram.getChatMember(channelId, ctx.from.id);
        const allowed = isAllowedStatus(member);
        cache.set(key, { allowed, expiresAt: Date.now() + CACHE_MS });
        return allowed;
      } catch (err) {
        logger.warn(`[SubscriptionGate] Cannot verify ${ctx.from.id}: ${err.message}`);
        // Fail closed: if the mandatory channel cannot be checked, do not let
        // an unverified user continue as though verification succeeded.
        cache.delete(key);
        return false;
      }
    };

    const prompt = async ctx => {
      const text =
        '<blockquote><b>🔒 Verifikasi Akses</b>\n\n' +
        'Untuk menggunakan bot, kamu wajib bergabung ke channel terlebih dahulu.\n\n' +
        'Setelah bergabung, tekan tombol <b>✅ Cek Verifikasi</b>.</blockquote>';
      const rows = [];
      if (channelUrl) rows.push([Markup.button.url('📢 Gabung Channel', channelUrl)]);
      rows.push([Markup.button.callback(' Cek Verifikasi', 'subscription:check')]);
      await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) }).catch(() => {});
    };

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    // Small 5-segment progress bar. The verification window remains 15 seconds.
    const verificationLoadingFrames = [
      '[▱▱▱▱▱] 0%',
      '[▰▱▱▱▱] 20%',
      '[▰▰▱▱▱] 40%',
      '[▰▰▰▱▱] 60%',
      '[▰▰▰▰▱] 80%',
      '[▰▰▰▰▰] 100%'
    ];

    const showVerificationLoading = async ctx => {
      const loadingText = frame =>
        '<blockquote><b>Verifikasi Akses</b>\n\n' +
        'Sedang memeriksa keanggotaan channel...\n\n' +
        `<code>${frame}</code>\n\n` +
        'Mohon tunggu sekitar 15 detik.</blockquote>';

      const canEdit = Boolean(ctx.callbackQuery?.message?.message_id);
      const render = async frame => {
        if (canEdit) {
          await ctx.editMessageText(loadingText(frame), { parse_mode: 'HTML' }).catch(() => {});
        } else {
          await ctx.reply(loadingText(frame), { parse_mode: 'HTML' }).catch(() => {});
        }
      };

      await render(verificationLoadingFrames[0]);
      const intervalMs = 3000;
      for (let i = 1; i < verificationLoadingFrames.length; i += 1) {
        await sleep(intervalMs);
        await render(verificationLoadingFrames[i]);
      }
    };

    bot.use(async (ctx, next) => {
      if (!enabled) return next();

      const data = String(ctx.callbackQuery?.data || '');
      if (data === 'subscription:check') {
        await ctx.answerCbQuery().catch(() => {});
        await showVerificationLoading(ctx);
        // Force a fresh membership check after the loading window so a cached
        // negative result cannot hide a channel join that happened meanwhile.
        cache.delete(keyFor(ctx));
        const allowed = await check(ctx);
        if (allowed) {
          cache.delete(keyFor(ctx));
          const successText = '<blockquote><b>Verifikasi berhasil.</b>\n\nSekarang kamu sudah bisa menggunakan bot.</blockquote>';
          if (ctx.callbackQuery?.message?.message_id) {
            await ctx.editMessageText(successText, { parse_mode: 'HTML' }).catch(() => {});
          } else {
            await ctx.reply(successText, { parse_mode: 'HTML' }).catch(() => {});
          }
        } else {
          const notVerifiedText =
            '<blockquote><b>Verifikasi belum berhasil</b>\n\n' +
            'Kamu masih belum terdeteksi bergabung ke channel.\n' +
            'Silakan bergabung terlebih dahulu, lalu tekan <b>Cek Verifikasi</b> lagi.</blockquote>';
          const rows = [];
          if (channelUrl) rows.push([Markup.button.url('Gabung Channel', channelUrl)]);
          rows.push([Markup.button.callback('Cek Verifikasi', 'subscription:check')]);
          if (ctx.callbackQuery?.message?.message_id) {
            await ctx.editMessageText(notVerifiedText, {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard(rows)
            }).catch(() => {});
          } else {
            await prompt(ctx);
          }
        }
        return;
      }

      if (await check(ctx)) return next();

      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('🔒 Wajib bergabung ke channel terlebih dahulu.', { show_alert: true }).catch(() => {});
      }
      await prompt(ctx);
    });

    return { enabled, channelId };
  }
}

module.exports = SubscriptionGate;
