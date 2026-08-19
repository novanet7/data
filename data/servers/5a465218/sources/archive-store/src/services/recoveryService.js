'use strict';

const Order = require('../models/Order');
const BuyerWallet = require('../models/BuyerWallet');
const OrderService = require('./orderService');
const Product = require('../models/Product');
const logger = require('../utils/logger');

/**
 * Crash recovery for money/order workflows.
 * It is intentionally conservative: only orders with durable evidence of payment
 * are resumed. Unknown/ambiguous orders are left untouched for admin review.
 */
class RecoveryService {
  static async recoverStore(storeId, bot) {
    const stats = { inspected: 0, resumed: 0, failed: 0, skipped: 0 };
    if (!storeId || !bot) return stats;

    const candidates = await Order.find({
      storeId,
      status: { $in: ['paid', 'awaiting_payment'] },
    }).sort({ updatedAt: 1 }).limit(100);

    for (const order of candidates) {
      stats.inspected++;
      try {
        let current = await Order.findOne({ orderId: order.orderId, storeId });
        if (!current) { stats.skipped++; continue; }

        // A wallet debit is durable proof that checkout passed the payment step.
        // If the process died before markPaid(), restore the paid state first.
        if (current.status === 'awaiting_payment' && current.paymentMethod === 'wallet') {
          const wallet = await BuyerWallet.findOne({ storeId, buyerId: String(current.buyerId) });
          const tx = (wallet?.transactions || []).find(t =>
            t.transactionId === `order:${current.orderId}:debit` &&
            t.type === 'debit' && Number(t.amount) === Number(current.totalAmount)
          );
          if (tx) {
            const paid = await OrderService.markPaid(current.orderId, 'wallet');
            if (!paid.success && paid.order?.status !== 'paid') {
              stats.skipped++;
              continue;
            }
            current = paid.order || await Order.findOne({ orderId: current.orderId, storeId });
          }
        }

        if (current.status !== 'paid') {
          stats.skipped++;
          continue;
        }

        const product = await Product.findOne({
          _id: current.productId,
          storeId,
          productType: 'telegram_session',
        });
        if (!product) {
          await Order.findOneAndUpdate(
            { orderId: current.orderId, storeId, status: 'paid' },
            { $set: { status: 'failed', notes: 'Recovery: produk inventory tidak ditemukan' } }
          );
          if (current.paymentMethod === 'wallet') {
            await BuyerWallet.credit(storeId, current.buyerId, Number(current.totalAmount || 0), {
              orderId: current.orderId,
              transactionId: `order:${current.orderId}:refund:recovery:missing-product`,
              source: 'recovery_refund',
            });
          }
          stats.failed++;
          continue;
        }

        const OwnerPaymentVerifyHandler = require('../handlers/common/ownerPaymentVerify');
        const result = await OwnerPaymentVerifyHandler.deliverSession(bot, current, product);
        if (result?.success || result?.duplicate) stats.resumed++;
        else stats.failed++;
      } catch (err) {
        stats.failed++;
        logger.error(`[Recovery] ${storeId}/${order.orderId}: ${err.message}`);
      }
    }

    return stats;
  }

  static async recoverAll(BotManager) {
    const result = {};
    for (const storeId of BotManager.getRunning()) {
      const bot = BotManager.getBot(storeId);
      try {
        result[storeId] = await this.recoverStore(storeId, bot);
      } catch (err) {
        logger.error(`[Recovery] store ${storeId}: ${err.message}`);
      }
    }
    return result;
  }
}

module.exports = RecoveryService;
