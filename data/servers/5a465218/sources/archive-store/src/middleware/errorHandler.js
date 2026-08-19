'use strict';

const logger = require('../utils/logger');

async function errorHandler(error, ctx) {
  logger.error('[Bot] Unhandled error', {
    message: error?.message || String(error),
    stack: error?.stack || null,
    updateType: ctx?.updateType,
    callbackData: ctx?.callbackQuery?.data || null,
    userId: ctx?.from?.id,
    storeId: ctx?.storeId,
  });

  try {
    if (ctx?.callbackQuery) {
      await ctx.answerCbQuery('❌ Terjadi kesalahan. Coba lagi.').catch(() => {});
    } else if (ctx) {
      await ctx.reply('❌ Terjadi kesalahan. Silakan coba lagi atau ketik /start.').catch(() => {});
    }
  } catch {}
}

module.exports = errorHandler;
