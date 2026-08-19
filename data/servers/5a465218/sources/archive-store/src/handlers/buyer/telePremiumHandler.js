'use strict';

const buyerKeyboard = require('../../keyboards/buyerKeyboard');
const TelePremiumService = require('../../services/telePremiumService');
const Wallet = require('../../models/BuyerWallet');
const Notification = require('../../services/notificationService');
const MessageFormatter = require('../../utils/messageFormatter');
const logger = require('../../utils/logger');

function esc(v) { return String(v ?? '-').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

class TelePremiumHandler {
  static register(bot) {
    bot.action('buyer:telepremium', async ctx => {
      await ctx.answerCbQuery().catch(() => {});
      await TelePremiumHandler.showMenu(ctx);
    });

    bot.action(/^telepremium:buy:(1|3|6|12)$/, async ctx => {
      await ctx.answerCbQuery().catch(() => {});
      try {
        const months = Number(ctx.match[1]);
        const cfg = TelePremiumService.getConfig(ctx.store);
        const price = cfg.prices[months] || 0;
        const info = TelePremiumService.durationInfo(months);
        if (!cfg.enabled) return ctx.reply('🌟 Telegram Premium sedang ditutup oleh admin. Silakan coba lagi nanti.');
        if (!info || price <= 0) return ctx.reply('🌟 Produk Telegram Premium ini belum tersedia karena harganya belum diset admin.');

        const wallet = await Wallet.getOrCreate(ctx.storeId, String(ctx.from.id));
        if (Number(wallet.balance || 0) < price) {
          return ctx.reply(`💰 Saldo kamu tidak cukup.\n\nHarga: ${TelePremiumService.fmt(price)}\nSaldo: ${TelePremiumService.fmt(wallet.balance)}\n\nSilakan deposit terlebih dahulu.`, buyerKeyboard.walletMenu());
        }

        if (info.deliveryType === 'login') {
          const order = await TelePremiumService.createPurchase({
            store: ctx.store,
            buyer: { id: ctx.from.id, username: ctx.from.username, name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') },
            months,
          });
          await TelePremiumHandler.notifyOwner(bot, ctx.store, order);
          await ctx.reply(
            `🌟 <b>Pembelian Telegram Premium berhasil dibuat.</b>\n\n` +
            `📦 Produk: <b>${esc(info.productName)}</b>\n` +
            `💰 Harga: <b>${TelePremiumService.fmt(price)}</b>\n` +
            `🔖 Resi: <code>${esc(order.orderId)}</code>\n\n` +
            `Silakan hubungkan owner <b>@rax1xcode</b> untuk proses login 1 bulan.\n` +
            `Setelah selesai, owner akan menandai pesanan sebagai selesai.`,
            buyerKeyboard.backToShop()
          );
          return;
        }

        ctx.session.flow = 'telepremium_target';
        ctx.session.telepremiumDraft = { months, price };
        ctx.saveSession();
        await ctx.reply(
          `🌟 <b>${esc(info.productName)}</b>\n\n` +
          `💰 Harga: <b>${TelePremiumService.fmt(price)}</b>\n\n` +
          `Silakan kirim <b>username Telegram penerima</b> untuk pengiriman Premium.\n` +
          `Contoh: <code>@username</code>\n\n` +
          `Username ini akan dipakai sebagai tujuan Gift.`,
          buyerKeyboard.telePremiumCancel()
        );
      } catch (err) {
        logger.error(`[TelePremium] buy failed: ${err.stack || err.message}`);
        await ctx.reply(`❌ Gagal membuat pesanan Telegram Premium: ${err.message}`);
      }
    });

    bot.action('telepremium:cancel_input', async ctx => {
      await ctx.answerCbQuery().catch(() => {});
      ctx.session.flow = null;
      ctx.session.telepremiumDraft = null;
      ctx.saveSession();
      await TelePremiumHandler.showMenu(ctx);
    });

    bot.action(/^telepremium:confirm:(\d+):(\d+)$/, async ctx => {
      await ctx.answerCbQuery().catch(() => {});
    });
  }

  static async showMenu(ctx) {
    const cfg = TelePremiumService.getConfig(ctx.store);
    if (!cfg.enabled) {
      await ctx.reply(
        MessageFormatter.selectionScreen('🌟 TELEGRAM PREMIUM', 'Layanan Telegram Premium sedang ditutup sementara oleh admin.', 'Silakan coba lagi nanti.'),
        buyerKeyboard.backToShop()
      );
      return;
    }
    const rows = [
      'Pilih produk Telegram Premium yang kamu butuhkan.',
      '',
      '🌟 1 Bulan digunakan untuk proses login akun pembeli.',
      '🌟 3, 6, dan 12 Bulan dikirim sebagai Gift ke username tujuan.',
    ];
    await ctx.reply(MessageFormatter.selectionScreen('🌟 TELEGRAM PREMIUM', rows), buyerKeyboard.telePremiumMenu(cfg.prices));
  }

  static async handleTextInput(ctx, bot) {
    if (ctx.session.flow !== 'telepremium_target') return false;
    const draft = ctx.session.telepremiumDraft || {};
    const username = TelePremiumService.cleanUsername(ctx.message?.text || '');
    if (!TelePremiumService.isValidUsername(username)) {
      await ctx.reply('❌ Username tidak valid. Kirim username Telegram seperti <code>@username</code>.', { parse_mode: 'HTML' });
      return true;
    }
    try {
      const months = Number(draft.months);
      const order = await TelePremiumService.createPurchase({
        store: ctx.store,
        buyer: { id: ctx.from.id, username: ctx.from.username, name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') },
        months,
        targetUsername: username,
      });
      ctx.session.flow = null;
      ctx.session.telepremiumDraft = null;
      ctx.saveSession();

      await TelePremiumHandler.notifyOwner(bot, ctx.store, order);
      await ctx.reply(
        `🌟 <b>Pesanan Telegram Premium dibuat.</b>\n\n` +
        `📦 Produk: <b>${esc(order.productName)}</b>\n` +
        `👤 Username penerima: <b>@${esc(username)}</b>\n` +
        `💰 Harga: <b>${TelePremiumService.fmt(order.price)}</b>\n` +
        `🔖 Resi: <code>${esc(order.orderId)}</code>\n\n` +
        `Pesanan sedang diproses admin.`,
        buyerKeyboard.backToShop()
      );
    } catch (err) {
      ctx.session.flow = null;
      ctx.session.telepremiumDraft = null;
      ctx.saveSession();
      await ctx.reply(`❌ Gagal membuat pesanan: ${err.message}`);
    }
    return true;
  }

  static async notifyOwner(bot, store, order) {
    const ownerId = String(store.ownerId || process.env.PLATFORM_OWNER_ID || '').trim();
    if (!ownerId || !bot?.telegram) return;
    const targetLine = order.deliveryType === 'gift'
      ? `🌟 Username yang dikirimi: <b>@${esc(order.targetUsername)}</b>\n`
      : '';
    const buyerUsername = order.buyerUsername ? `@${String(order.buyerUsername).replace(/^@/, '')}` : '-';
    const text =
      `🌟 <b>PROSES PEMBELIAN TELEPREM</b>\n\n` +
      `👤 Nama: <b>${esc(order.buyerName)}</b>\n` +
      `👤 Username: <b>${esc(buyerUsername)}</b>\n` +
      targetLine +
      `🆔 ID: <code>${esc(order.buyerId)}</code>\n` +
      `💰 Harga: <b>${TelePremiumService.fmt(order.price)}</b>\n` +
      `📦 Produk: <b>${esc(order.productName)}</b>\n` +
      `🔖 Resi: <code>${esc(order.orderId)}</code>`;

    try {
      const msg = await bot.telegram.sendMessage(ownerId, MessageFormatter.normalize(text, 'HTML'), {
        parse_mode: 'HTML',
        ...buyerKeyboard.telePremiumAdminActions(order.orderId),
      });
      await require('../../models/TelePremiumOrder').findOneAndUpdate(
        { _id: order._id },
        { $set: { 'metadata.adminMessageId': msg?.message_id || null, 'metadata.ownerChatId': ownerId } },
        { new: true }
      );
    } catch (err) {
      logger.warn(`[TelePremium] admin notification failed: ${err.message}`);
    }
  }
}

module.exports = TelePremiumHandler;
