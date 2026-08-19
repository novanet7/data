'use strict';

const Order = require('../../models/Order');
const Product = require('../../models/Product');
const OrderService = require('../../services/orderService');
const SessionService = require('../../services/sessionService');
const Store = require('../../models/Store');
const AuditLog = require('../../models/AuditLog');
const buyerKeyboard = require('../../keyboards/buyerKeyboard');
const LoadingAnimation = require('../../utils/loadingAnimation');
const logger = require('../../utils/logger');
const Encryption = require('../../utils/encryption');
const BuyerWallet = require('../../models/BuyerWallet');
const { withInventoryLock } = require('../../utils/inventoryLock');

// One delivery lock per store/product prevents two concurrent buyers from reserving the same session.

async function sendReplacingBuyerMessage(bot, buyerId, orderId, text, extra = {}) {
  const waiter = SessionService.getOtpWaiter(buyerId, orderId);

  if (waiter?.lastMessageId) {
    try {
      await bot.telegram.deleteMessage(Number(buyerId), waiter.lastMessageId);
    } catch {}
  }

  const sent = await bot.telegram.sendMessage(Number(buyerId), text, extra);

  SessionService.registerOtpWaiter(buyerId, {
    ...(waiter || {}),
    orderId,
    lastMessageId: sent.message_id,
  });

  return sent;
}

const deliveryLocks = new Map();
async function withDeliveryLock(key, fn) {
  const prev = deliveryLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise(resolve => { release = resolve; });
  const tail = prev.then(() => next);
  deliveryLocks.set(key, tail);
  await prev;
  try { return await fn(); } finally { release(); if (deliveryLocks.get(key) === tail) deliveryLocks.delete(key); }
}

async function stopBuyerAnimation(bot, order, finalText, options = {}) {
  try {
    const msgId = order?.metadata?.loadingAnimMsgId;
    if (msgId) {
      try {
        await bot.telegram.editMessageText(order.buyerId, msgId, null, finalText, {
          parse_mode: 'Markdown', ...options,
        });
        return;
      } catch {}
    }
    await bot.telegram.sendMessage(order.buyerId, finalText, {
      parse_mode: 'Markdown', ...options,
    });
  } catch (err) {
    logger.error('[PaymentVerify] buyer notification:', err.message);
  }
}

class OwnerPaymentVerifyHandler {
  static register(bot) {
    bot.action(/^owner:confirm_payment:(.+)$/, async ctx => {
      await ctx.answerCbQuery('✅ Memproses...');
      const orderId = ctx.match[1];

      try {
        const result = await OrderService.markPaid(orderId, 'qris_manual');
        if (!result.success) return ctx.reply(`❌ ${result.reason}`);

        const order = result.order;
        const product = await Product.findOne({
          _id: order.productId, storeId: order.storeId, productType: 'telegram_session',
        });
        if (!product) throw new Error('Produk Telegram tidak ditemukan.');

        await AuditLog.log({
          storeId: order.storeId, actorId: ctx.from.id, actorType: 'owner',
          action: 'PAYMENT_MANUALLY_CONFIRMED', entity: 'Order', entityId: orderId,
          details: { method: 'qris_manual' }, result: 'success',
        });

        await OwnerPaymentVerifyHandler.deliverSession(bot, order, product);
        await ctx.reply('✅ Pembayaran dikonfirmasi & akun Telegram dikirim.');
      } catch (err) {
        logger.error('[PaymentVerify] confirm:', err.message);
        await ctx.reply(`❌ ${err.message}`);
      }
    });

      bot.action(/^session:get_otp:([^:]+)$/, async ctx => {
        const orderId = String(ctx.match[1] || '');
        const buyerId = String(ctx.from.id);
        const storeId = String(ctx.storeId || '');

      await ctx.answerCbQuery('🔐 Menyiapkan pemantauan OTP...');

      try {
        const order = await Order.findOne({
          orderId,
          storeId,
          buyerId,
        });

        if (!order) {
          return ctx.reply('❌ Order tidak ditemukan atau bukan milik kamu.');
        }

        if (!['paid', 'completed'].includes(String(order.status))) {
          return ctx.reply(
            `❌ Order belum siap untuk login. Status: ${order.status}`
          );
        }

        const waiter = SessionService.getOtpWaiter(buyerId, orderId);

        if (!waiter) {
          return ctx.reply(
            '⏰ Sesi OTP sudah tidak tersedia atau sudah berakhir. Silakan hubungi admin.'
          );
        }

        if (String(waiter.orderId) !== orderId) {
          return ctx.reply('❌ Sesi OTP tidak cocok dengan order ini.');
        }

        if (!waiter.sessionString || !waiter.phone) {
          return ctx.reply(
            '❌ Data sesi login tidak lengkap. Silakan hubungi admin.'
          );
        }

        try {
          await SessionService.startOtpListener(
            bot,
            storeId,
            buyerId,
            orderId,
            waiter.phone,
            waiter.sessionString,
            waiter.productName || order.productName || 'Akun Telegram',
            waiter.profileColor || null,
            waiter.twoFaPassword || null
          );
        } catch (listenerErr) {
          logger.error(`[PaymentVerify] start OTP listener failed: ${listenerErr.message}`);
          const rollback = await SessionService.cancelOtpOrder(storeId, orderId, buyerId).catch(() => ({ success: false }));
          if (rollback?.success) {
            await ctx.editMessageText(
              `❌ *Pemantauan OTP gagal dimulai.*\n\n` +
              `Pesanan dibatalkan otomatis.\n` +
              `Saldo dikembalikan dan session dikembalikan ke stok.`,
              { parse_mode: 'Markdown', ...buyerKeyboard.backToShop() }
            );
            return;
          }
          await ctx.reply(`❌ Gagal mengaktifkan pemantauan OTP: ${listenerErr.message}`);
          return;
        }
        await ctx.reply(
          `👀 *Pemantauan OTP AKTIF*

` +
          `🆔 Order: \`${orderId}\`
` +
          `📞 Nomor: \`+${waiter.phone}\`

` +
          `Silakan lanjutkan login Telegram menggunakan nomor tersebut.
` +
          `Bot sekarang sedang menunggu kode login.

` +
          `⏱️ Masa tunggu: *10 menit*.
` +
          `⚠️ Jangan bagikan kode OTP kepada siapa pun.`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        logger.error(
          `[PaymentVerify] start OTP listener failed: ${err.message}`
        );

        try {
          await ctx.reply(
            `❌ Gagal mengaktifkan pemantauan OTP: ${err.message}`
          );
        } catch {}
      }
    });

    
bot.action(/^session:cancel_otp:(.+)$/, async ctx => {
      await ctx.answerCbQuery('Membatalkan proses OTP...');
      const orderId = String(ctx.match[1] || '');
      const buyerId = String(ctx.from.id);
      const storeId = String(ctx.storeId || '');

      try {
        const result = await SessionService.cancelOtpOrder(storeId, orderId, buyerId);
        if (!result.success) {
          return ctx.reply(
            result.reason === 'otp_already_delivered'
              ? '❌ OTP sudah diterima, pesanan tidak dapat dibatalkan dari menu ini.'
              : `❌ ${result.reason || 'Pesanan tidak dapat dibatalkan.'}`
          );
        }

        const amountText = result.refunded
          ? `💰 Saldo dikembalikan: *${new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(result.amount)}*\\n`
          : '';

        await ctx.editMessageText(
          `✅ *PESANAN DIBATALKAN*\n\n` +
          `🆔 Order: \`${orderId}\`\n` +
          amountText +
          `📦 Stock session dikembalikan ke inventory.`,
          { parse_mode: 'Markdown', ...buyerKeyboard.backToShop() }
        );
      } catch (err) {
        logger.error(`[PaymentVerify] cancel OTP failed: ${err.message}`);
        try { await ctx.reply(`❌ Gagal membatalkan proses OTP: ${err.message}`); } catch {}
      }
    });

    bot.action(/^session:buyer_logout:(.+)$/, async ctx => {
      await ctx.answerCbQuery('Mengeluarkan perangkat bot...');
      const orderId = ctx.match[1];

      try {
        const order = await Order.findOne({
          orderId,
          storeId: ctx.storeId,
          buyerId: String(ctx.from.id),
        });

        if (!order) return ctx.reply('❌ Order tidak ditemukan.');

        const soldSessions = SessionService.getSoldSessionsByOrderId(
          ctx.storeId,
          order.productId,
          orderId
        );

        const sessionInfo = soldSessions[0]?.data || null;
        const sessionString =
          sessionInfo?.sessionString ||
          SessionService.getSessionStringByOrderId(orderId);

        if (!sessionString) {
          return ctx.reply('❌ Session bot tidak ditemukan.');
        }

        // Logout SESSION BOT dari akun Telegram.
        // Sesi/perangkat buyer tetap dibiarkan aktif.
        await SessionService.terminateOtherSessions(sessionString);

        await SessionService.stopOtpListener(ctx.from.id, orderId);

        await ctx.editMessageText(
          `🚪 *PERANGKAT BOT DIKELUARKAN*\\n\\n` +
          `✅ Session bot sudah logout dari akun Telegram.\\n\\n` +
          `📱 *Sesi Telegram kamu tetap aman.*\\n` +
          `Bot sudah tidak lagi login pada akun ini.`,
          {
            parse_mode: 'Markdown',
            ...buyerKeyboard.backToShop(),
          }
        );
      } catch (err) {
        logger.error('[PaymentVerify] logout:', err.message);
        try {
          await ctx.reply(`❌ Gagal mengeluarkan perangkat bot: ${err.message}`);
        } catch {}
      }
    });
  }

  static async deliverSession(bot, order, product) {
    const { storeId, buyerId, productId, orderId, quantity } = order;
    return withDeliveryLock(`delivery:${storeId}:${productId}`, async () => withInventoryLock(storeId, productId, async () => {
      const freshOrder = await Order.findOne({ orderId, storeId });
      if (!freshOrder) throw new Error('Order tidak ditemukan.');
      if (freshOrder.status === 'completed') return { success: true, delivered: freshOrder.quantity, duplicate: true };
      if (!['paid', 'pending'].includes(freshOrder.status)) throw new Error(`Order tidak dapat dikirim dari status ${freshOrder.status}.`);

      // Crash-safe delivery: sessions already reserved for this order are reused
      // instead of reserving a second set after a restart/crash.
      const existing = SessionService.getSoldSessionsByOrderId(storeId, productId, orderId);
      const delivered = [...existing];
      const target = Number(quantity);

      // Reserve only the remaining quantity. If the process crashed after a
      // session was marked sold, recovery will see it here and won't duplicate it.
      const selectedTelegramId = freshOrder?.metadata?.selectedSessionTelegramId
        ? String(freshOrder.metadata.selectedSessionTelegramId)
        : null;

      while (delivered.length < target) {
        const session = selectedTelegramId && delivered.length === 0
          ? SessionService.getAvailableSessionByTelegramId(storeId, productId, selectedTelegramId, buyerId)
          : SessionService.getAvailableSession(storeId, productId, buyerId);

        if (!session?.file) {
          if (selectedTelegramId && delivered.length === 0) {
            throw new Error('Nomor yang dipilih sudah tidak tersedia. Saldo akan dikembalikan otomatis.');
          }
          break;
        }

        if (!SessionService.markSessionSold(session.file, buyerId, orderId)) continue;
        const refreshed = SessionService.getSoldSessionsByOrderId(storeId, productId, orderId)
          .find(item => item.file === session.file);
        delivered.push(refreshed || session);
      }

      // Only send a session that has not already been delivered. This makes a
      // crash between Telegram send and order finalization recoverable without
      // sending the same account again.
      for (const item of delivered) {
        if (item.data?.deliveredAt || item.data?.deliveryState === 'delivered') continue;
        const data = item.data;
        if (!data?.sessionString) continue;

        await this.deliverTelegramSession(
          bot, storeId, buyerId, orderId, data.phone, data.sessionString,
          product.name,
          data.profileColor || null,
          data.twoFaPasswordEncrypted
            ? Encryption.decrypt(data.twoFaPasswordEncrypted)
            : (data.twoFaPassword || null)
        );

        // Telegram berhasil menerima instruksi delivery.
        // Tandai session sebagai benar-benar delivered.
        const marked = SessionService.markSessionDeliveryDelivered(item.file);
        if (!marked) {
          throw new Error(`Gagal menandai session delivered: ${item.file}`);
        }
      }

      // Recalculate stock from actual inventory instead of blindly decrementing.
      // This keeps stock correct if the process crashed between reserve and update.
      await SessionService.syncStockCount(storeId, productId);

      const deliveredCount = delivered.length;
      const missing = Math.max(0, target - deliveredCount);
      let refunded = 0;
      if (missing > 0 && order.paymentMethod === 'wallet') {
        refunded = Number(order.productPrice || 0) * missing;
        if (refunded > 0) {
          await BuyerWallet.credit(storeId, buyerId, refunded, {
            orderId,
            transactionId: `order:${orderId}:refund:partial:${missing}`,
            source: 'partial_delivery_refund',
            missing,
          });
        }
      }

      const completed = await Order.findOneAndUpdate(
        { orderId, storeId, status: { $in: ['paid', 'pending'] } },
        { $set: { status: 'completed', completedAt: new Date().toISOString(), deliveredAt: new Date().toISOString(), deliveredItems: delivered.map(x => ({ file: x.file, deliveredAt: x.data?.deliveredAt || new Date().toISOString() })), notes: missing > 0 ? `Partial delivery: ${deliveredCount}/${target}; refund ${refunded}` : null } },
        { new: true }
      );
      if (!completed) {
        const latest = await Order.findOne({ orderId, storeId });
        if (latest?.status === 'completed') return { success: true, delivered: deliveredCount, duplicate: true, refunded };
      }
      return { success: true, delivered: deliveredCount, refunded, partial: missing > 0 };
    }));
  }

  static async deliverTelegramSession(bot, storeId, buyerId, orderId, phone, sessionString, productName, profileColor = null, twoFaPassword = null) {
    SessionService.registerOtpWaiter(buyerId, {
      orderId,
      phone,
      productName,
      sessionString,
      profileColor,
      twoFaPassword,
    });

    await sendReplacingBuyerMessage(
      bot,
      buyerId,
      orderId,
      `📱 *PESANAN SIAP — MULAI PROSES OTP*\n\n` +
      `📦 Produk: ${productName}\n` +
      `📞 Nomor: \`+${phone}\`\n` +
      `🆔 Order: \`${orderId}\`\n\n` +
      `⚠️ *Langkah wajib:*\n` +
      `1. Tekan tombol *🔐 Dapatkan OTP Sekarang* terlebih dahulu.\n` +
      `2. Setelah tombol ditekan, bot mulai memantau kode login.\n` +
      `3. Baru login Telegram menggunakan nomor \`+${phone}\`.\n\n` +
      `⏱️ *Masa tunggu kode: 10 menit.*\n` +
      `⚠️ Jangan bagikan kode login kepada siapa pun.`,
      {
        parse_mode: 'Markdown',
        reply_markup: buyerKeyboard.getOtpMenu(orderId, phone).reply_markup,
      }
    );
  }
}

module.exports = OwnerPaymentVerifyHandler;
