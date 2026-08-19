'use strict';

const { RateLimiterMemory } = require('rate-limiter-flexible');
const logger = require('../utils/logger');

const rateLimiter = new RateLimiterMemory({
  points: parseInt(process.env.RATE_LIMIT_MAX) || 30,
  duration: parseInt(process.env.RATE_LIMIT_WINDOW) || 60,
  blockDuration: 60,
});

const strictRateLimiter = new RateLimiterMemory({
  points: 5,
  duration: 60,
  blockDuration: 300,
});

const checkoutRateLimiter = new RateLimiterMemory({
  points: 3,
  duration: 60,
  blockDuration: 120,
});

async function rateLimitMiddleware(ctx, next) {
  const userId = ctx.from?.id;
  if (!userId) return next();
  const key = `${ctx.storeId || 'main'}:${userId}`;

  try {
    await rateLimiter.consume(key);
    return next();
  } catch (rejRes) {
    const secs = Math.round(rejRes.msBeforeNext / 1000) || 1;
    logger.warn(`Rate limit exceeded for user ${userId}`, { secs });
    try {
      await ctx.reply(`⚠️ Terlalu banyak permintaan. Tunggu ${secs} seconds.`);
    } catch {}
    return;
  }
}

async function strictRateLimitMiddleware(ctx, next) {
  const userId = ctx.from?.id;
  if (!userId) return next();

  try {
    await strictRateLimiter.consume(`${ctx.storeId || 'main'}:${userId}`);
    return next();
  } catch (rejRes) {
    const secs = Math.round(rejRes.msBeforeNext / 1000) || 1;
    logger.warn(`Strict rate limit hit for user ${userId}`);
    try {
      await ctx.reply(`🚫 Aksi dibatasi. Tunggu ${secs} seconds.`);
    } catch {}
    return;
  }
}

async function checkoutRateLimitMiddleware(ctx, next) {
  const userId = ctx.from?.id;
  if (!userId) return next();

  try {
    await checkoutRateLimiter.consume(`${ctx.storeId || 'main'}:${userId}`);
    return next();
  } catch {
    try {
      await ctx.reply('⚠️ Terlalu banyak percobaan checkout. Tunggu sebentar.');
    } catch {}
    return;
  }
}

module.exports = {
  rateLimitMiddleware,
  strictRateLimitMiddleware,
  checkoutRateLimitMiddleware,
};
