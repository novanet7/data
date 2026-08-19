'use strict';

const Store = require('../../models/Store');
const IdPricing = require('../../services/idPricingService');
const ownerKeyboard = require('../../keyboards/ownerKeyboard');
const AuditLog = require('../../models/AuditLog');

class IdPricingHandler {
  static register(bot) {
    bot.action('owner:id_pricelist', async ctx => {
      await ctx.answerCbQuery();
      await ctx.editMessageText(
        '💰 *Pricelist ID Telegram*\n\nPilih digit awal ID. Harga diatur terpisah berdasarkan awalan ID dan jumlah digit.',
        { parse_mode: 'Markdown', ...ownerKeyboard.idPricingPrefixMenu() }
      );
    });

    bot.action(/^owner:idprice:prefix:([1-8])$/, async ctx => {
      await ctx.answerCbQuery();
      const prefix = ctx.match[1];
      const prices = await this.getPrefixPrices(ctx.storeId, prefix);
      await ctx.editMessageText(
        `💰 *Pricelist ID ${prefix}*\n\nPilih jumlah digit yang ingin diatur:`,
        { parse_mode: 'Markdown', ...ownerKeyboard.idPricingDigitMenu(prefix, prices) }
      );
    });

    bot.action(/^owner:idprice:digit:([1-8]):(\d{1,2})$/, async ctx => {
      await ctx.answerCbQuery();
      return this.openStatusPriceFlow(ctx, ctx.match[1], Number(ctx.match[2]), 'fs');
    });

    bot.action(/^owner:idprice:status:([1-8]):(8|9|10):(fs|nfs)$/, async ctx => {
      await ctx.answerCbQuery();
      return this.openStatusPriceFlow(ctx, ctx.match[1], Number(ctx.match[2]), ctx.match[3]);
    });
  }

  static async openStatusPriceFlow(ctx, prefix, digits, status = 'fs') {
    if (![8, 9, 10].includes(Number(digits))) return;
    const normalizedStatus = IdPricing.normalizeStatus(status);
    const store = await Store.findOne({ storeId: ctx.storeId });
    const current = IdPricing.getConfiguredPrice(store, prefix, Number(digits), normalizedStatus);
    ctx.session.flow = 'id_price';
    ctx.session.idPricePrefix = prefix;
    ctx.session.idPriceDigits = Number(digits);
    ctx.session.idPriceStatus = normalizedStatus;
    ctx.saveSession();

    await ctx.editMessageText(
      `⚙️ *Atur Harga ${normalizedStatus.toUpperCase()} — ID ${prefix} — ${digits} Digit*\n\n` +
      `Harga sekarang: *${formatPrice(current)}*\n\n` +
      `Kirim harga buyer dalam angka.\nContoh: \`50000\``,
      { parse_mode: 'Markdown', ...ownerKeyboard.cancelButton() }
    );
  }

  static async getPrefixPrices(storeId, prefix) {
    const store = await Store.findOne({ storeId });
    const prices = { fs: {}, nfs: {} };
    for (const digits of IdPricing.DEFAULT_DIGITS) {
      prices.fs[String(digits)] = IdPricing.getConfiguredPrice(store, prefix, digits, 'fs');
      prices.nfs[String(digits)] = IdPricing.getConfiguredPrice(store, prefix, digits, 'nfs');
    }
    return prices;
  }

  static async handleTextInput(ctx) {
    if (ctx.session?.flow !== 'id_price') return false;

    const prefix = String(ctx.session.idPricePrefix || '');
    const digits = Number(ctx.session.idPriceDigits || 0);
    const status = IdPricing.normalizeStatus(ctx.session.idPriceStatus || 'fs');
    const price = Number(String(ctx.message?.text || '').replace(/[^\d]/g, ''));
    if (!IdPricing.PREFIXES.includes(prefix) || !Number.isInteger(digits) || ![8, 9, 10].includes(digits)) {
      ctx.session.flow = null;
      ctx.session.idPricePrefix = null;
      ctx.session.idPriceDigits = null;
      ctx.session.idPriceStatus = null;
      ctx.saveSession();
      await ctx.reply('❌ Sesi pengaturan harga tidak valid.');
      return true;
    }
    if (!Number.isFinite(price) || price < 0) {
      await ctx.reply('❌ Harga tidak valid. Contoh: 50000');
      return true;
    }

    await IdPricing.setBuyerPrice(ctx.storeId, prefix, digits, price, status);
    ctx.session.flow = null;
    ctx.session.idPricePrefix = null;
    ctx.session.idPriceDigits = null;
    ctx.session.idPriceStatus = null;
    ctx.saveSession();

    await AuditLog.log({
      storeId: ctx.storeId,
      actorId: ctx.from.id,
      actorType: 'owner',
      action: 'ID_PRICELIST_UPDATED',
      entity: 'Store',
      entityId: String(ctx.storeId),
      details: { prefix, digits, status, price },
      result: 'success',
    });

    const prices = await this.getPrefixPrices(ctx.storeId, prefix);
    await ctx.reply(
      `✅ *Harga berhasil disimpan*\n\n` +
      `🆔 Awalan ID: *${prefix}*\n` +
      `🔢 Jumlah digit: *${digits}*\n` +
      `📦 Status: *${status.toUpperCase()}*\n` +
      `💰 Harga buyer: *${formatPrice(price)}*`,
      { parse_mode: 'Markdown', ...ownerKeyboard.idPricingDigitMenu(prefix, prices) }
    );
    return true;
  }
}

function formatPrice(n) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency', currency: 'IDR', minimumFractionDigits: 0,
  }).format(n || 0);
}

module.exports = IdPricingHandler;
