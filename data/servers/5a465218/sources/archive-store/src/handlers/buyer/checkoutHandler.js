'use strict';

const Order = require('../../models/Order');
const Product = require('../../models/Product');
const OrderService = require('../../services/orderService');
const buyerKeyboard = require('../../keyboards/buyerKeyboard');
const MessageFormatter = require('../../utils/messageFormatter');
const logger = require('../../utils/logger');
const { v4: uuidv4 } = require('uuid');
const SessionService = require('../../services/sessionService');
const IdPricing = require('../../services/idPricingService');
const { withInventoryLock } = require('../../utils/inventoryLock');
const purchaseLocks = new Map();
const checkoutDrafts = new Map();
const CHECKOUT_DRAFT_TTL = 15 * 60 * 1000;
async function withPurchaseLock(key, fn) {
  const prev = purchaseLocks.get(key) || Promise.resolve();
  let release; const next = new Promise(r => { release = r; });
  const tail = prev.then(() => next); purchaseLocks.set(key, tail); await prev;
  try { return await fn(); } finally { release(); if (purchaseLocks.get(key) === tail) purchaseLocks.delete(key); }
}

async function rollbackPurchaseIfNeeded({ order, debitedAmount, storeId, buyerId, reason }) {
  const BuyerWallet = require('../../models/BuyerWallet');
  const orderId = order?.orderId ? String(order.orderId) : null;
  let productId = order?.productId ? String(order.productId) : null;

  if (orderId) {
    const fresh = await Order.findOne({ orderId, storeId }).catch(() => null);
    productId = productId || (fresh?.productId ? String(fresh.productId) : null);

    // A failed delivery may already have reserved one or more sessions.
    // Always release only this order's pre-OTP reservations; the session file
    // remains on disk and becomes available to the next buyer.
    if (productId) {
      try {
        await withInventoryLock(storeId, productId, async () => {
          const released = SessionService.releaseSessionReservationByOrderId(
            storeId, orderId, { beforeOtpOnly: true }
          );
          await SessionService.syncStockCount(storeId, productId);
          if (released) {
            logger.info(`[CheckoutRollback] session reservation released | order=${orderId} | released=${released}`);
          }
        });
      } catch (releaseErr) {
        logger.error(`[CheckoutRollback] gagal mengembalikan session | order=${orderId}: ${releaseErr.message}`);
      }
    }

    await Order.findOneAndUpdate(
      { orderId, storeId, status: { $nin: ['completed', 'failed'] } },
      {
        $set: {
          status: 'cancelled',
          notes: reason || 'Pembelian gagal',
          rolledBackAt: new Date().toISOString(),
        },
      }
    ).catch(() => {});
  }

  if (debitedAmount > 0 && orderId) {
    await BuyerWallet.credit(storeId, buyerId, debitedAmount, {
      orderId,
      transactionId: `order:${orderId}:rollback`,
      source: 'purchase_rollback',
      reason: reason || 'purchase_failed',
    }).catch(() => {});
  }
}

class CheckoutHandler {
  static rememberCheckoutDraft(storeId, buyerId, pending) {
    const token = String(pending?.checkoutToken || '');
    if (!token) return;
    checkoutDrafts.set(token, { storeId: String(storeId), buyerId: String(buyerId), ...pending, createdAt: Date.now() });
    const timer = setTimeout(() => checkoutDrafts.delete(token), CHECKOUT_DRAFT_TTL);
    timer.unref?.();
  }


  static async safeEditOrReply(ctx, text, options) {
    try {
      return await ctx.editMessageText(text, options);
    } catch (err) {
      logger.warn('[Checkout] editMessageText failed, falling back to reply:', err.message);
      return ctx.reply(text, options);
    }
  }

  static register(bot) {
    bot.action(/^shop:checkout:(.+):(\d+)$/, async ctx => {
      await ctx.answerCbQuery();
      const productId = ctx.match[1];
      const quantity = parseInt(ctx.match[2], 10);
      const product = await Product.findOne({
        _id: productId, storeId: ctx.storeId,
        productType: 'telegram_session', status: 'active',
      });

      if (!product || product.stockCount < quantity) {
        await ctx.editMessageText(
          MessageFormatter.buildBox(null, ctx.store.settings.storeName, ['❌ Produk tidak tersedia atau stok tidak cukup.']),
          { parse_mode: 'HTML', ...buyerKeyboard.backToShop() }
        );
        return;
      }

      const eligibleSessions = SessionService.countAvailableSessionsForBuyer(
        ctx.storeId,
        String(product._id),
        String(ctx.from.id)
      );
      if (eligibleSessions < quantity) {
        const warningLines = eligibleSessions === 0
          ? [
              '⚠️ Stok NOKOS masih sama seperti sebelumnya.',
              '',
              'Nomor tersebut baru saja mengalami masalah OTP untuk akun Anda.',
              'Mohon tunggu sekitar 2 jam sampai batas OTP selesai, atau gunakan nomor lain yang tersedia.',
            ]
          : [
              `⚠️ Stok yang bisa dipakai untuk akun Anda hanya ${eligibleSessions} nomor.`,
              '',
              'Nomor lain sedang menunggu batas OTP selesai.',
            ];
        await ctx.editMessageText(
          MessageFormatter.buildBox(null, ctx.store.settings.storeName, warningLines),
          { parse_mode: 'HTML', ...buyerKeyboard.backToShop() }
        );
        return;
      }

      ctx.session.pendingCheckout = {
        productId,
        quantity,
        expectedTotal: Number(product.price || 0) * Number(quantity || 1),
        createdAt: new Date().toISOString(),
        checkoutToken: uuidv4(),
      };
      ctx.saveSession();
      await this.showWalletCheckout(ctx, product, quantity);
    });

    bot.action(/^shop:confirm_checkout:([A-Za-z0-9_-]{8,64})$/, async ctx => {
      // Acknowledge immediately so Telegram never leaves the button spinner
      // stuck while the purchase/stock/session delivery is being processed.
      await ctx.answerCbQuery('⏳ Memproses pembelian...', { show_alert: false }).catch(() => {});
      try {
        const checkoutToken = String(ctx.match[1] || '');
        let pending = ctx.session?.pendingCheckout;
        if ((!pending || String(pending.checkoutToken || '') !== checkoutToken)) {
          const draft = checkoutDrafts.get(checkoutToken);
          if (draft && draft.storeId === String(ctx.storeId) && draft.buyerId === String(ctx.from.id) && (Date.now() - Number(draft.createdAt || 0)) <= CHECKOUT_DRAFT_TTL) {
            pending = { ...draft, checkoutToken };
          }
        }
        const productId = String(pending?.productId || '');
        const quantity = Number(pending?.quantity || 0);

        if (!pending || !productId || !quantity || String(pending.checkoutToken || '') !== checkoutToken) {
          await CheckoutHandler.safeEditOrReply(
            ctx,
            '❌ Sesi checkout sudah habis. Silakan pilih produk lagi.',
            { parse_mode: 'HTML', ...buyerKeyboard.backToShop() }
          );
          return;
        }

        const eligibleSessions = SessionService.countAvailableSessionsForBuyer(
          ctx.storeId,
          String(pending.productId),
          String(ctx.from.id)
        );
        if (eligibleSessions < Number(pending.quantity || 1)) {
          const warning = eligibleSessions === 0
            ? '⚠️ Stok NOKOS masih sama seperti sebelumnya.\n\nNomor tersebut baru saja mengalami masalah OTP untuk akun Anda.\nMohon tunggu sekitar 2 jam sampai batas OTP selesai, atau gunakan nomor lain yang tersedia.'
            : `⚠️ Stok yang bisa dipakai untuk akun Anda hanya ${eligibleSessions} nomor.`;
          await CheckoutHandler.safeEditOrReply(ctx, warning, { parse_mode: 'HTML', ...buyerKeyboard.backToShop() });
          return;
        }

        const result = await CheckoutHandler.processWalletPurchase(
          bot, ctx, pending.productId, pending.quantity, checkoutToken, pending.selectedSessionTelegramId || null
        );

        // processWalletPurchase normally sends the final delivery screen itself.
        // For non-success results, always give the buyer an explicit response so
        // the callback can never look like it was ignored.
        if (result?.success) checkoutDrafts.delete(checkoutToken);
        if (!result?.success) {
          const reason = result?.reason || 'Pembelian tidak dapat diproses.';
          await CheckoutHandler.safeEditOrReply(
            ctx,
            `❌ ${reason}`,
            { parse_mode: 'HTML', ...buyerKeyboard.backToShop() }
          ).catch(() => {});
        }
      } catch (err) {
        logger.error('[Checkout] confirm callback:', err.stack || err.message);
        await CheckoutHandler.safeEditOrReply(
          ctx,
          `❌ Pembelian gagal: ${err.message || 'Terjadi kesalahan.'}`,
          { parse_mode: 'HTML', ...buyerKeyboard.backToShop() }
        ).catch(() => {});
      }
    });

    bot.action(/^pay:method:(.+)$/, async ctx => {
      await ctx.answerCbQuery();
      const method = ctx.match[1];
      if (method !== 'wallet') return ctx.reply('❌ Pembelian akun wajib menggunakan saldo bot.');
      const pending = ctx.session.pendingCheckout;
      if (!pending) return ctx.reply('❌ Sesi checkout sudah habis.');
      return CheckoutHandler.processWalletPurchase(bot, ctx, pending.productId, pending.quantity, pending.checkoutToken || null, pending.selectedSessionTelegramId || null);
    });

    bot.action(/^order:status:(.+)$/, async ctx => {
      await ctx.answerCbQuery();
      const order = await Order.findOne({
        orderId: ctx.match[1], storeId: ctx.storeId, buyerId: String(ctx.from.id),
      });
      if (!order) return ctx.answerCbQuery('Pesanan tidak ditemukan');

      const statusMap = {
        awaiting_payment: '💳 Menunggu Bayar',
        paid: '✅ Dibayar — Menunggu Pengiriman',
        completed: '✅ Selesai',
        failed: '❌ Gagal',
        cancelled: '🚫 Dibatalkan',
      };
      await ctx.editMessageText(
        MessageFormatter.buildBox(null, ctx.store.settings.storeName, [
          '📋 Status Pesanan', '',
          `🆔 ${order.orderId}`,
          `📦 ${order.productName} x${order.quantity}`,
          `💰 ${formatPrice(order.totalAmount)}`,
          `📊 ${statusMap[order.status] || order.status}`,
        ]),
        { parse_mode: 'HTML', ...buyerKeyboard.orderStatus(order.orderId) }
      );
    });

    bot.action(/^pay:upload_proof:(.+)$/, async ctx => {
      await ctx.answerCbQuery();
      ctx.session.uploadingProofFor = ctx.match[1];
      ctx.saveSession();
      await ctx.reply(
        MessageFormatter.buildBox(null, ctx.store.settings.storeName, [
          '📸 *Kirim Bukti Bayar*', '',
          `🆔 Order: ${ctx.match[1]}`,
          '', 'Silakan kirim screenshot/foto bukti pembayaran.',
        ]),
        { parse_mode: 'HTML', ...buyerKeyboard.cancelButton() }
      );
    });
  }

  static async processWalletPurchase(bot, ctx, productId, quantity, checkoutToken = null, selectedSessionTelegramId = null) {
    const BuyerWallet = require('../../models/BuyerWallet');
    let order = null;
    let debitedAmount = 0;

    try {
      return await withPurchaseLock(`purchase:${ctx.storeId}:${ctx.from.id}:${productId}:${quantity}:${selectedSessionTelegramId || 'any'}:${checkoutToken || 'legacy'}`, async () => {
        const latestProduct = await Product.findOne({
          _id: productId,
          storeId: ctx.storeId,
          productType: 'telegram_session',
          status: 'active',
        });
        const existingOrder = await OrderService.findByCheckoutToken(ctx.storeId, ctx.from.id, checkoutToken);
        if (existingOrder) {
          if (['paid', 'completed'].includes(existingOrder.status)) {
            ctx.session.currentOrderId = existingOrder.orderId;
            ctx.session.pendingCheckout = null;
            ctx.saveSession();
            return { success: true, orderId: existingOrder.orderId, duplicate: true };
          }
          if (['awaiting_payment', 'pending'].includes(existingOrder.status)) {
            return { success: false, reason: 'Checkout sedang diproses. Tunggu sebentar.' };
          }
          return { success: false, reason: 'Tombol checkout ini sudah diproses. Silakan buat checkout baru.' };
        }

        if (!latestProduct || Number(latestProduct.stockCount || 0) < Number(quantity)) {
          throw new Error('Stok tidak mencukupi.');
        }

        let selectedStatus = null;
        let selectedPrice = null;
        if (selectedSessionTelegramId) {
          const selectedSession = SessionService.getAvailableSessionByTelegramId(
            ctx.storeId, productId, String(selectedSessionTelegramId), String(ctx.from.id)
          );
          if (!selectedSession?.data) throw new Error('Akun yang dipilih sudah tidak tersedia.');
          const info = IdPricing.getIdInfo(selectedSessionTelegramId);
          selectedStatus = IdPricing.normalizeStatus(selectedSession.data.nokosStatus || 'fs');
          selectedPrice = info.valid
            ? IdPricing.getConfiguredPrice(ctx.store, info.prefix, info.digitLength, selectedStatus)
            : Number(latestProduct.price || 0);
          if (!(selectedPrice > 0)) throw new Error(`Harga ${selectedStatus.toUpperCase()} untuk akun terpilih belum diset.`);
        }

        order = await OrderService.createOrder(
          ctx.storeId,
          ctx.from.id,
          ctx.from.username,
          productId,
          quantity,
          checkoutToken,
          selectedPrice != null ? { priceOverride: selectedPrice, sessionStatus: selectedStatus, selectedSessionTelegramId } : null
        );

        if (selectedSessionTelegramId) {
          order = await Order.findOneAndUpdate(
            { orderId: order.orderId, storeId: ctx.storeId },
            { $set: { 'metadata.selectedSessionTelegramId': String(selectedSessionTelegramId), 'metadata.selectedSessionStatus': selectedStatus || 'fs', 'metadata.selectedSessionPrice': Number(selectedPrice || order.productPrice || 0) } },
            { new: true }
          );
        }

        const wallet = await BuyerWallet.getOrCreate(ctx.storeId, ctx.from.id);
        if (Number(wallet.balance || 0) < Number(order.totalAmount)) {
          await OrderService.cancelOrder(order.orderId, 'Saldo buyer tidak mencukupi');
          await this.safeEditOrReply(
            ctx,
            `❌ *Saldo tidak cukup*

Harga: ${formatPrice(order.totalAmount)}
Saldo: ${formatPrice(wallet.balance)}

Silakan Top Up terlebih dahulu.`,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [{ text: ' Deposit / Top Up', callback_data: 'buyer:topup' }],
                  [{ text: ' Cek Saldo Lagi', callback_data: 'buyer:wallet' }],
                  [{ text: '⬅ Kembali', callback_data: `shop:product:${productId}` }],
                ],
              },
            }
          );
          return { success: false, reason: 'Saldo tidak cukup' };
        }

        const deb = await BuyerWallet.debit(ctx.storeId, ctx.from.id, order.totalAmount, {
          orderId: order.orderId,
          transactionId: `order:${order.orderId}:debit`,
          source: 'purchase',
        });
        if (!deb.success) {
          await OrderService.cancelOrder(order.orderId, 'Saldo buyer tidak mencukupi');
          throw new Error('Saldo tidak mencukupi.');
        }
        debitedAmount = Number(order.totalAmount || 0);

        await OrderService.markPaid(order.orderId, 'wallet');
        const product = await Product.findOne({
          _id: order.productId,
          storeId: order.storeId,
          productType: 'telegram_session',
        });
        const OwnerPaymentVerifyHandler = require('../common/ownerPaymentVerify');
        await OwnerPaymentVerifyHandler.deliverSession(bot, order, product);

        ctx.session.currentOrderId = order.orderId;
        ctx.session.pendingCheckout = null;
        ctx.saveSession();

        return { success: true, orderId: order.orderId };
      });
    } catch (err) {
      logger.error('[Checkout] wallet purchase:', err.message);
      await rollbackPurchaseIfNeeded({
        order,
        debitedAmount,
        storeId: ctx.storeId,
        buyerId: ctx.from.id,
        reason: `Pembelian gagal: ${err.message}`,
      });
      await ctx.editMessageText(`❌ ${err.message}`, { parse_mode:'HTML', ...buyerKeyboard.backToShop() }).catch(async () => {
        await ctx.reply(`❌ ${err.message}`, { parse_mode:'HTML', ...buyerKeyboard.backToShop() });
      });
      return { success: false, reason: err.message };
    }
  }

  static async showWalletCheckout(ctx, product, quantity) {
    const BuyerWallet = require('../../models/BuyerWallet');
    const wallet = await BuyerWallet.getOrCreate(ctx.storeId, ctx.from.id);
    const total = product.price * quantity;
    const message = MessageFormatter.buildBox(null, ctx.store.settings.storeName, [
      '🛒 *Konfirmasi Pembelian*', '',
      `📦 ${product.name} ×${quantity}`,
      `💰 Total: ${formatPrice(total)}`,
      `💳 Saldo: ${formatPrice(wallet.balance)}`,
      '',
      wallet.balance >= total ? 'Saldo cukup. Klik *Konfirmasi Beli* di bawah.' : '❌ Saldo tidak cukup. Top Up terlebih dahulu.',
    ]);
    const confirmMarkup = buyerKeyboard.purchaseConfirm(product._id, quantity, total, pendingToken(ctx.session.pendingCheckout));
    const markup = wallet.balance >= total
      ? { reply_markup: confirmMarkup.reply_markup }
      : { reply_markup:{ inline_keyboard:[[{ text:' Deposit / Top Up', callback_data:'buyer:topup' }],[{ text:' Cek Saldo Lagi', callback_data:'buyer:wallet' }],[{ text:'⬅ Kembali', callback_data:'shop:cat:telegram' }]] } };
    await this.safeEditOrReply(ctx, message, { parse_mode:'HTML', ...markup });
  }

  static async handleQrisManual(ctx, order) {
    const qris = ctx.store.paymentSettings?.qris;
    if (!qris?.enabled) throw new Error('QRIS Manual belum dikonfigurasi.');

    const caption = MessageFormatter.buildBox(null, ctx.store.settings.storeName, [
      '📷 *Pembayaran QRIS*', '',
      `🆔 Order: ${order.orderId}`,
      `💰 Jumlah: ${formatPrice(order.totalAmount)}`,
      '', '1. Scan QRIS', '2. Bayar tepat sesuai nominal',
      '3. Upload bukti pembayaran', '', '⏰ Berlaku 30 menit',
    ]);

    if (qris.imageUrl) {
      try {
        await ctx.replyWithPhoto(qris.imageUrl, {
          caption, parse_mode: 'HTML', ...buyerKeyboard.qrisPayment(order.orderId),
        });
        return;
      } catch (err) {
        logger.warn('[QRIS] gagal kirim gambar:', err.message);
      }
    }
    await ctx.editMessageText(caption, { parse_mode: 'HTML', ...buyerKeyboard.qrisPayment(order.orderId) });
  }

  static async handleProofUpload(ctx) {
    const orderId = ctx.session?.uploadingProofFor;
    if (!orderId || !ctx.message?.photo?.length) return false;

    const order = await Order.findOne({
      orderId, storeId: ctx.storeId, buyerId: String(ctx.from.id),
    });
    if (!order) {
      await ctx.reply('❌ Order tidak ditemukan.');
      return true;
    }

    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    await Order.findOneAndUpdate(
      { orderId, storeId: ctx.storeId },
      {
        $set: {
          paymentProofFileId: fileId,
          paymentProofUrl: fileId,
          paymentMethod: 'qris_manual',
          proofSubmittedAt: new Date().toISOString(),
        },
      }
    );

    ctx.session.uploadingProofFor = null;
    ctx.saveSession();

    const ownerCaption =
      `📸 *Bukti Bayar Masuk!*\n\n` +
      `📦 Produk: ${order.productName} ×${order.quantity}\n` +
      `🆔 Order: \`${orderId}\`\n` +
      `💰 Nominal: ${formatPrice(order.totalAmount)}\n` +
      `👤 Pembeli: ${ctx.from.username ? '@' + ctx.from.username : ctx.from.id}\n\n` +
      `Verifikasi pembayaran:`;

    await ctx.telegram.sendPhoto(ctx.store.ownerId, fileId, {
      caption: ownerCaption,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: ' Approve', callback_data: `owner:confirm_payment:${orderId}` },
          { text: ' Tolak', callback_data: `owner:reject_payment:${orderId}` },
        ]],
      },
    });

    await ctx.reply('✅ Bukti pembayaran sudah dikirim ke owner yang ganteng. sabar yaa paling 1 menit.');
    return true;
  }
}

function formatPrice(n) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency', currency: 'IDR', minimumFractionDigits: 0,
  }).format(n);
}

function pendingToken(pending) {
  return String(pending?.checkoutToken || '');
}

module.exports = CheckoutHandler;
