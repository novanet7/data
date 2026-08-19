'use strict';

const Store = require('../../models/Store');
const IdPricing = require('../../services/idPricingService');
const AuditLog = require('../../models/AuditLog');
const { Markup } = require('telegraf');

// Seller pricing is intentionally simpler than the old status/multiplier system:
// ID prefix 1-8 -> digit length 8/9/10 -> direct Rupiah price.
const SELLER_PREFIXES = ['1', '2', '3', '4', '5', '6', '7', '8'];
const SELLER_DIGITS = [8, 9, 10];

function fmt(n) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(n || 0);
}

function mainMenu(enabled = true) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`${enabled ? '' : ''} Setor Akun: ${enabled ? 'ON' : 'OFF'}`, 'owner:seller_toggle')],
    [Markup.button.callback(' Atur Harga Seller', 'owner:seller_price_menu')],
    [Markup.button.callback('⬅ Kembali', 'owner:back_main')],
  ]);
}

function prefixMenu() {
  const rows = [];
  for (let i = 0; i < SELLER_PREFIXES.length; i += 3) {
    rows.push(SELLER_PREFIXES.slice(i, i + 3).map(n =>
      Markup.button.callback(` ID ${n}`, `owner:seller_price:prefix:${n}`)
    ));
  }
  rows.push([Markup.button.callback('⬅ Kembali', 'owner:seller_settings')]);
  return Markup.inlineKeyboard(rows);
}

function normalizeStatus(status) { return String(status || 'fs').toLowerCase() === 'nfs' ? 'nfs' : 'fs'; }

function getSellerPrice(store, prefix, digits, status = 'fs') {
  const cfg = store?.settings?.sellerPricing || {};
  const normalized = normalizeStatus(status);
  const prices = normalized === 'nfs' ? cfg.nfsPrices : cfg.fsPrices;
  const value = prices?.[String(prefix)]?.[String(digits)] ?? (normalized === 'fs' ? cfg.prices?.[String(prefix)]?.[String(digits)] : 0);
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function getPrefixPrices(storeId, prefix) {
  const store = await Store.findOne({ storeId });
  const prices = { fs: {}, nfs: {} };
  for (const d of SELLER_DIGITS) {
    prices.fs[String(d)] = getSellerPrice(store, prefix, d, 'fs');
    prices.nfs[String(d)] = getSellerPrice(store, prefix, d, 'nfs');
  }
  return prices;
}

function digitMenu(prefix, prices = {}) {
  const rows = [];
  for (const d of SELLER_DIGITS) {
    rows.push([
      Markup.button.callback(` ${d}D FS — ${Number(prices.fs?.[String(d)] || 0) > 0 ? fmt(prices.fs[String(d)]) : 'Belum diset'}`, `owner:seller_price:status:${prefix}:${d}:fs`),
    ]);
    rows.push([
      Markup.button.callback(` ${d}D NFS — ${Number(prices.nfs?.[String(d)] || 0) > 0 ? fmt(prices.nfs[String(d)]) : 'Belum diset'}`, `owner:seller_price:status:${prefix}:${d}:nfs`),
    ]);
  }
  rows.push([Markup.button.callback('⬅ Kembali', 'owner:seller_price_menu')]);
  return Markup.inlineKeyboard(rows);
}

async function openSellerStatusPriceFlow(ctx, prefix, digits, status = 'fs') {
  try {
    await ctx.answerCbQuery();
    const normalized = normalizeStatus(status);
    const store = await Store.findOne({ storeId: ctx.storeId });
    const current = getSellerPrice(store, prefix, digits, normalized);
    ctx.session.flow = 'seller_price';
    ctx.session.sellerPricePrefix = prefix;
    ctx.session.sellerPriceDigits = digits;
    ctx.session.sellerPriceStatus = normalized;
    ctx.saveSession();
    await ctx.editMessageText(
      `⚙️ *Atur Harga Seller ${normalized.toUpperCase()}*\n\n` +
      `🆔 ID ${prefix}\n` +
      `🔢 ${digits} Digit\n\n` +
      `Harga sekarang: *${fmt(current)}*\n\n` +
      `Kirim harga seller langsung dalam Rupiah.\nContoh: \`35000\``,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(' Batal', 'owner:seller_price_menu')]]) }
    );
  } catch (err) {
    await ctx.reply(` Gagal membuka pengaturan harga: ${err.message}`).catch(() => {});
  }
}

class SellerSettingsHandler {
  static register(bot) {
    bot.action('owner:seller_settings', async ctx => {
      try {
        await ctx.answerCbQuery();
        const store = await Store.findOne({ storeId: ctx.storeId });
        const cfg = store?.settings?.sellerPricing || {};
        const enabled = cfg.enabled !== false;
        await ctx.editMessageText(
          `💼 *Seller Marketplace*\n\n` +
          `📥 Setor akun: ${enabled ? '🟢 ON' : '🔴 OFF'}\n\n` +
          `Harga seller diatur langsung berdasarkan *ID 1–8* dan *jumlah digit 8D, 9D, atau 10D*.\n` +
          `Tidak ada pilihan CLEAR/WARNING/LIMITED/UNKNOWN dan tidak ada persentase.\n\n` +
          `Pilih *Atur Harga Seller* untuk mengatur harga per ID.`,
          { parse_mode: 'Markdown', ...mainMenu(enabled) }
        );
      } catch (err) {
        await ctx.reply(`❌ Gagal membuka Atur Seller: ${err.message}`).catch(() => {});
      }
    });

    bot.action('owner:seller_toggle', async ctx => {
      try {
        await ctx.answerCbQuery();
        const store = await Store.findOne({ storeId: ctx.storeId });
        const enabled = store?.settings?.sellerPricing?.enabled !== false;
        await Store.findOneAndUpdate({ storeId: ctx.storeId }, { $set: { 'settings.sellerPricing.enabled': !enabled } });
        const fresh = await Store.findOne({ storeId: ctx.storeId });
        const cfg = fresh?.settings?.sellerPricing || {};
        await ctx.editMessageText(
          `💼 *Seller Marketplace*\n\n📥 Setor akun: ${cfg.enabled !== false ? '🟢 ON' : '🔴 OFF'}\n\nHarga seller mengikuti ID 1–8 dan digit 8D/9D/10D.`,
          { parse_mode: 'Markdown', ...mainMenu(cfg.enabled !== false) }
        );
      } catch (err) {
        await ctx.reply(`❌ Gagal mengubah status seller: ${err.message}`).catch(() => {});
      }
    });

    bot.action('owner:seller_price_menu', async ctx => {
      try {
        await ctx.answerCbQuery();
        await ctx.editMessageText(
          `💰 *Atur Harga Seller*\n\n` +
          `Pilih awalan ID.\n` +
          `Setelah itu pilih 8D, 9D, atau 10D.\n\n` +
          `Harga dimasukkan langsung dalam Rupiah.`,
          { parse_mode: 'Markdown', ...prefixMenu() }
        );
      } catch (err) {
        await ctx.reply(`❌ Gagal membuka harga seller: ${err.message}`).catch(() => {});
      }
    });

    bot.action(/^owner:seller_price:prefix:([1-8])$/, async ctx => {
      try {
        await ctx.answerCbQuery();
        const prefix = ctx.match[1];
        const prices = await getPrefixPrices(ctx.storeId, prefix);
        await ctx.editMessageText(
          `💰 *Harga Seller — ID ${prefix}*\n\nPilih jumlah digit:`,
          { parse_mode: 'Markdown', ...digitMenu(prefix, prices) }
        );
      } catch (err) {
        await ctx.reply(`❌ Gagal membuka ID seller: ${err.message}`).catch(() => {});
      }
    });

    bot.action(/^owner:seller_price:digit:([1-8]):(8|9|10)$/, async ctx => {
      return openSellerStatusPriceFlow(ctx, ctx.match[1], Number(ctx.match[2]), 'fs');
    });

    bot.action(/^owner:seller_price:status:([1-8]):(8|9|10):(fs|nfs)$/, async ctx => {
      return openSellerStatusPriceFlow(ctx, ctx.match[1], Number(ctx.match[2]), ctx.match[3]);
    });
  }

  static async handleTextInput(ctx) {
    if (ctx.session?.flow !== 'seller_price') return false;

    const prefix = String(ctx.session.sellerPricePrefix || '');
    const digits = Number(ctx.session.sellerPriceDigits || 0);
    const status = normalizeStatus(ctx.session.sellerPriceStatus || 'fs');
    const price = Math.floor(Number(String(ctx.message?.text || '').replace(/[^\d]/g, '')));

    if (!SELLER_PREFIXES.includes(prefix) || !SELLER_DIGITS.includes(digits)) {
      ctx.session.flow = null;
      ctx.session.sellerPricePrefix = null;
      ctx.session.sellerPriceDigits = null;
      ctx.session.sellerPriceStatus = null;
      ctx.saveSession();
      await ctx.reply('❌ Sesi pengaturan harga seller tidak valid. Buka Atur Seller lagi.');
      return true;
    }
    if (!Number.isSafeInteger(price) || price < 0) {
      await ctx.reply('❌ Harga tidak valid. Masukkan angka Rupiah, contoh: 35000');
      return true;
    }

    const pricePath = status === 'nfs'
      ? `settings.sellerPricing.nfsPrices.${prefix}.${digits}`
      : `settings.sellerPricing.fsPrices.${prefix}.${digits}`;
    const updateSet = { [pricePath]: price, 'settings.sellerPricing.enabled': true };
    if (status === 'fs') updateSet[`settings.sellerPricing.prices.${prefix}.${digits}`] = price;
    await Store.findOneAndUpdate({ storeId: ctx.storeId }, { $set: updateSet });
    await AuditLog.log({
      storeId: ctx.storeId,
      actorId: ctx.from.id,
      actorType: 'owner',
      action: 'SELLER_ID_PRICE_UPDATED',
      entity: 'Store',
      entityId: String(ctx.storeId),
      details: { prefix, digits, status, price },
      result: 'success',
    });

    ctx.session.flow = null;
    ctx.session.sellerPricePrefix = null;
    ctx.session.sellerPriceDigits = null;
    ctx.session.sellerPriceStatus = null;
    ctx.saveSession();

    const prices = await getPrefixPrices(ctx.storeId, prefix);
    await ctx.reply(
      `✅ *Harga seller berhasil disimpan*\n\n` +
      `🆔 ID ${prefix} — ${digits} Digit\n` +
      ` Status: *${status.toUpperCase()}*\n` +
      `💰 Harga seller: *${fmt(price)}*`,
      { parse_mode: 'Markdown', ...digitMenu(prefix, prices) }
    );
    return true;
  }
}

module.exports = SellerSettingsHandler;
