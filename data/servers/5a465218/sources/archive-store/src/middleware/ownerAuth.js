'use strict';

const Store = require('../models/Store');
const logger = require('../utils/logger');

async function ownerAuthMiddleware(ctx, next) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const storeId = ctx.storeId;
  if (!storeId) return;

  try {
    const store = ctx.store;
    if (!store) {
      await ctx.reply('❌ Store not found.');
      return;
    }

    if (!store.isOwner(userId)) {
      logger.warn(`Unauthorized owner action attempt by ${userId} on store ${storeId}`);
      await ctx.reply('🚫 You are not authorized to manage this store.');
      return;
    }

    if (store.status === 'suspended') {
      await ctx.reply('🚫 This store has been suspended. Contact support.');
      return;
    }

    ctx.isOwner = true;
    return next();
  } catch (error) {
    logger.error('Owner auth middleware error:', error);
    await ctx.reply('❌ Authentication error. Please try again.');
  }
}

module.exports = ownerAuthMiddleware;
