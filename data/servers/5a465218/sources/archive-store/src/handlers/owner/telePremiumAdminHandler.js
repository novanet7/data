'use strict';

const TelePremiumService = require('../../services/telePremiumService');
const TelePremiumOrder = require('../../models/TelePremiumOrder');
const Store = require('../../models/Store');
const MessageFormatter = require('../../utils/messageFormatter');
const ownerKeyboard = require('../../keyboards/ownerKeyboard');
const Notification = require('../../services/notificationService');
const BuyerWallet = require('../../models/BuyerWallet');
const logger = require('../../utils/logger');

function esc(v) { return String(v ?? '-').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

class TelePremiumAdminHandler {
  static register(bot) {
    bot.action('owner:telepremium', async ctx => {
      await ctx.answerCbQuery().catch(() => {});
      await TelePremiumAdminHandler.showMenu(ctx);
    });

    bot.action('owner:telepremium:toggle', async ctx => {
      await ctx.answerCbQuery().catch(() => {});
      const cfg = TelePremiumService.getConfig(ctx.store);
      const enabled = !cfg.enabled;
      await TelePremiumService.setEnabled(ctx.storeId, enabled);
      ctx.store.settings = ctx.store.settings || {};
      ctx.store.settings.telepremium = { ...cfg, enabled };
      await TelePremiumAdminHandler.showMenu(ctx, `Telegram Premium ${enabled ? 'dibuka' : 'ditutup'}.`);
    });

    bot.action(/^owner:telepremium:price:(1|3|6|12)$/, async ctx => {
      await ctx.answerCbQuery().catch(() => {});
      const months = Number(ctx.match[1]);
      ctx.session.flow = 'owner_telepremium_price';
      ctx.session.telepremiumPriceMonths = months;
      ctx.saveSession();
      await ctx.reply(`🌟 Kirim harga untuk Telegram Premium ${months} bulan.\nContoh: <code>150000</code>`, { parse_mode: 'HTML', ...ownerKeyboard.cancelButton() });
    });

    bot.action(/^owner:telepremium:(processing|done|cancel):([A-Z0-9-]+)$/i, async ctx => {
      await ctx.answerCbQuery().catch(() => {});
      await TelePremiumAdminHandler.processOrderAction(ctx, ctx.match[1].toLowerCase(), ctx.match[2], bot);
    });
  }

  static async showMenu(ctx, notice = '') {
    const cfg = TelePremiumService.getConfig(ctx.store);
    const lines = [
      notice ? `✅ ${notice}` : null,
      `Status: ${cfg.enabled ? '🟢 TERBUKA' : '⚪ TERTUTUP'}`,
      '',
      `🌟 1 Bulan (Login): ${cfg.prices[1] > 0 ? TelePremiumService.fmt(cfg.prices[1]) : 'Belum diset'}`,
      `🌟 3 Bulan (Gift): ${cfg.prices[3] > 0 ? TelePremiumService.fmt(cfg.prices[3]) : 'Belum diset'}`,
      `🌟 6 Bulan (Gift): ${cfg.prices[6] > 0 ? TelePremiumService.fmt(cfg.prices[6]) : 'Belum diset'}`,
      `🌟 12 Bulan (Gift): ${cfg.prices[12] > 0 ? TelePremiumService.fmt(cfg.prices[12]) : 'Belum diset'}`,
      '',
      'Atur harga dari tombol di bawah. Jika harga 0/belum diset, produk tidak bisa dibeli buyer.',
    ].filter(v => v !== null);
    await ctx.reply(MessageFormatter.selectionScreen('🌟 TELEGRAM PREMIUM', lines), ownerKeyboard.telePremiumSettings(cfg));
  }

  static async handleTextInput(ctx) {
    if (ctx.session.flow !== 'owner_telepremium_price') return false;
    const months = Number(ctx.session.telepremiumPriceMonths);
    const raw = String(ctx.message?.text || '').trim().replace(/[^0-9]/g, '');
    const price = Number(raw);
    ctx.session.flow = null;
    ctx.session.telepremiumPriceMonths = null;
    ctx.saveSession();
    try {
      if (!raw || !Number.isFinite(price) || price < 0) throw new Error('Harga tidak valid.');
      await TelePremiumService.setPrice(ctx.storeId, months, price);
      await TelePremiumAdminHandler.showMenu(ctx, `Harga ${months} bulan berhasil disimpan.`);
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`, ownerKeyboard.backButton('owner:telepremium'));
    }
    return true;
  }

  static async processOrderAction(ctx, action, orderId, bot) {
    const order = await TelePremiumOrder.findOne({ storeId: ctx.storeId, orderId });
    if (!order) return ctx.reply('❌ Resi Tele Premium tidak ditemukan.');

    try {
      if (action === 'processing') {
        const updated = await TelePremiumService.markProcessing(orderId, ctx.from.id);
        if (!updated) return ctx.reply('⚠️ Pesanan sudah tidak dalam status yang bisa diproses.');
        await ctx.telegram.sendMessage(String(order.buyerId), MessageFormatter.normalize(`🌟 <b>Telegram Premium sedang diproses.</b>\n\n🔖 Resi: <code>${esc(orderId)}</code>`, 'HTML'), { parse_mode: 'HTML' }).catch(() => {});
        await TelePremiumAdminHandler.refreshAdminMessage(ctx, updated, '🔄 Lagi di proses');
        return;
      }
      if (action === 'done') {
        const updated = await TelePremiumService.markCompleted(orderId, ctx.from.id);
        if (!updated) return ctx.reply('⚠️ Pesanan sudah selesai/dibatalkan sebelumnya.');
        await ctx.telegram.sendMessage(String(order.buyerId), MessageFormatter.normalize(`🌟 <b>Telegram Premium sudah selesai.</b>\n\n📦 Produk: <b>${esc(order.productName)}</b>\n🔖 Resi: <code>${esc(orderId)}</code>`, 'HTML'), { parse_mode: 'HTML' }).catch(() => {});
        await Notification.send(bot, `🌟 <b>TELEPREM SELESAI</b>\n\n👤 Buyer: <b>${esc(order.buyerUsername ? '@'+order.buyerUsername : order.buyerId)}</b>\n${order.deliveryType === 'gift' ? `🌟 Tujuan: <b>@${esc(order.targetUsername)}</b>\n` : ''}💰 Harga: <b>${TelePremiumService.fmt(order.price)}</b>\n📦 Produk: <b>${esc(order.productName)}</b>\n🔖 Resi: <code>${esc(order.orderId)}</code>`);
        await TelePremiumAdminHandler.refreshAdminMessage(ctx, updated, '✅ Sudah selesai');
        return;
      }
      if (action === 'cancel') {
        const refunded = await TelePremiumService.refundOrder(order, 'Dibatalkan oleh admin', ctx.from.id);
        await ctx.telegram.sendMessage(String(order.buyerId), MessageFormatter.normalize(`❌ <b>Pesanan Telegram Premium dibatalkan.</b>\n\n🔖 Resi: <code>${esc(orderId)}</code>\n💰 Saldo ${TelePremiumService.fmt(refunded.amount)} sudah dikembalikan ke wallet kamu.`, 'HTML'), { parse_mode: 'HTML' }).catch(() => {});
        // Deliberately no channel notification on cancel, per requested flow.
        const fresh = await TelePremiumOrder.findOne({ storeId: ctx.storeId, orderId });
        await TelePremiumAdminHandler.refreshAdminMessage(ctx, fresh, '❌ Cancel + refund');
      }
    } catch (err) {
      logger.error(`[TelePremiumAdmin] action=${action} order=${orderId} failed: ${err.stack || err.message}`);
      await ctx.reply(`❌ Gagal memproses resi ${orderId}: ${err.message}`);
    }
  }

  static async refreshAdminMessage(ctx, order, statusText) {
    const chatId = ctx.callbackQuery?.message?.chat?.id || ctx.from?.id;
    const messageId = Number(order?.metadata?.adminMessageId || ctx.callbackQuery?.message?.message_id || 0);
    if (!chatId || !messageId) return;
    const lines = [
      `🌟 <b>PROSES PEMBELIAN TELEPREM</b>`,
      '',
      `📌 Status: <b>${esc(statusText)}</b>`,
      `👤 Nama: <b>${esc(order.buyerName)}</b>`,
      `👤 Username: <b>${esc(order.buyerUsername ? '@'+order.buyerUsername : '-')}</b>`,
      order.deliveryType === 'gift' ? `🌟 Username yang dikirimi: <b>@${esc(order.targetUsername)}</b>` : null,
      `🆔 ID: <code>${esc(order.buyerId)}</code>`,
      `💰 Harga: <b>${TelePremiumService.fmt(order.price)}</b>`,
      `📦 Produk: <b>${esc(order.productName)}</b>`,
      `🔖 Resi: <code>${esc(order.orderId)}</code>`,
    ].filter(Boolean).join('\n');
    try {
      await ctx.telegram.editMessageText(chatId, messageId, undefined, MessageFormatter.normalize(lines, 'HTML'), {
        parse_mode: 'HTML',
        ...ownerKeyboard.telePremiumAdminActions(order.orderId, order.status),
      });
    } catch (_) {}
  }
}

module.exports = TelePremiumAdminHandler;
