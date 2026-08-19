'use strict';

const Store = require('../models/Store');
const Customer = require('../models/Customer');
const logger = require('../utils/logger');

async function storeContextMiddleware(ctx, next) {
  const storeId = ctx.storeId;
  if (!storeId) return next();

  try {
    // Always fetch fresh store data from DB so that any setting changes
    // (e.g. QRIS setup, payment settings) are immediately visible.
    const store = await Store.findOne({ storeId });
    if (!store || store.status === 'suspended') {
      logger.warn(`[storeContext] Store ${storeId} not found or suspended`);
      try { await ctx.reply('🏪 Toko tidak ditemukan atau sedang ditangguhkan.'); } catch {}
      return;
    }
    ctx.store = store;

    // Maintenance mode check (skip for owners)
    if (store.settings?.maintenanceMode && !store.isOwner?.(ctx.from?.id)) {
      await ctx.reply('🔧 Toko sedang dalam maintenance. Coba lagi nanti.');
      return;
    }

    // Upsert customer record
    if (ctx.from) {
      try {
        const customer = await Customer.findOneAndUpdate(
          { storeId, telegramId: String(ctx.from.id) },
          {
            $set: {
              username: ctx.from.username || null,
              firstName: ctx.from.first_name || null,
              lastName: ctx.from.last_name || null,
              languageCode: ctx.from.language_code || 'en',
            },
          },
          { upsert: true, new: true }
        );

        if (customer?.isBlocked) {
          await ctx.reply('🚫 Kamu telah diblokir dari toko ini.');
          return;
        }

        ctx.customer = customer;
      } catch (err) {
        logger.error('[storeContext] Customer upsert error:', err.message);
        // Non-fatal — continue without customer record
      }
    }

    return next();
  } catch (error) {
    logger.error('[storeContext] Middleware error:', error.message);
    return next();
  }
}

module.exports = storeContextMiddleware;
