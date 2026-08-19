'use strict';

const Order = require('../models/Order');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const AuditLog = require('../models/AuditLog');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const Notification = require('./notificationService');
const SnapshotService = require('./snapshotService');

class OrderService {
  static async createOrder(storeId, buyerId, buyerUsername, productId, quantity, checkoutToken = null, pricingOverride = null) {
    const product = await Product.findOne({
      _id: productId, storeId, productType: 'telegram_session',
    });
    if (!product) throw new Error('Produk Telegram tidak ditemukan.');
    if (product.status === 'out_of_stock' || product.stockCount < quantity) throw new Error('Stok tidak mencukupi.');
    if (quantity > product.maxPerOrder) throw new Error(`Maksimal ${product.maxPerOrder} slot per order.`);

    const orderId = `ORD-${uuidv4().slice(0, 8).toUpperCase()}`;
    const finalPrice = Number(pricingOverride?.priceOverride);
    const effectivePrice = Number.isFinite(finalPrice) && finalPrice >= 0 ? finalPrice : Number(product.price || 0);
    const overrideMetadata = pricingOverride && typeof pricingOverride === 'object'
      ? {
          sessionStatus: pricingOverride.sessionStatus || null,
          selectedSessionTelegramId: pricingOverride.selectedSessionTelegramId || null,
          selectedSessionPrice: effectivePrice,
        }
      : {};
    const order = await Order.create({
      orderId, storeId, buyerId: String(buyerId), buyerUsername,
      productId, productName: product.name, productPrice: effectivePrice,
      quantity, totalAmount: effectivePrice * quantity, currency: 'IDR',
      metadata: { checkoutToken: checkoutToken ? String(checkoutToken) : null, ...overrideMetadata },
      status: 'awaiting_payment',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    await AuditLog.log({
      storeId, actorId: buyerId, actorType: 'buyer',
      action: 'ORDER_CREATED', entity: 'Order', entityId: orderId,
      details: { productId, quantity, totalAmount: order.totalAmount },
      result: 'success',
    });
    logger.info(`Order created: ${orderId} by ${buyerId}`);
    return order;
  }


  static async findByCheckoutToken(storeId, buyerId, checkoutToken) {
    if (!checkoutToken) return null;
    return Order.findOne({
      storeId,
      buyerId: String(buyerId),
      'metadata.checkoutToken': String(checkoutToken),
    });
  }

  static async markPaid(orderId, paymentMethod, invoiceId = null) {
    const current = await Order.findOne({ orderId });
    if (!current) throw new Error('Order tidak ditemukan.');
    if (!['awaiting_payment', 'pending'].includes(current.status)) {
      return { success: false, reason: `Status order tidak valid: ${current.status}`, order: current };
    }

    const paidAt = new Date().toISOString();
    const update = { $set: { status: 'paid', paidAt, paymentMethod } };
    if (invoiceId) update.$set.invoiceId = invoiceId;
    const order = await Order.findOneAndUpdate(
      { orderId, status: { $in: ['awaiting_payment', 'pending'] } },
      update,
      { new: true }
    );
    if (!order) {
      const latest = await Order.findOne({ orderId });
      return { success: false, reason: `Status order tidak valid: ${latest?.status || 'unknown'}`, order: latest };
    }

    await Customer.findOneAndUpdate(
      { storeId: order.storeId, telegramId: order.buyerId },
      {
        $inc: { totalOrders: 1, totalSpent: order.totalAmount },
        $set: { lastOrderAt: new Date() },
        $setOnInsert: { firstOrderAt: new Date() },
      },
      { upsert: true }
    );

    await AuditLog.log({
      storeId: order.storeId, actorId: order.buyerId, actorType: 'buyer',
      action: 'ORDER_PAID', entity: 'Order', entityId: orderId,
      details: { paymentMethod, invoiceId, amount: order.totalAmount },
      result: 'success',
    });
    try {
      const BotManager = require('../core/BotManager');
      await Notification.sale(BotManager.getBot(order.storeId), order);
    } catch (err) { logger.warn(`[OrderService] notification failed: ${err.message}`); }

    // Backup otomatis setelah order benar-benar berhasil dibayar.
    try {
      const backup = await SnapshotService.sendToOwner('buyer-purchase');
      logger.info(`[ORDER BACKUP] sent=${backup.filename} size=${backup.size}`);
    } catch (err) {
      logger.warn(`[ORDER BACKUP] gagal: ${err.message}`);
    }

    return { success: true, order };
  }

  static async cancelOrder(orderId, reason = 'Cancelled by user') {
    const current = await Order.findOne({ orderId });
    if (!current) throw new Error('Order tidak ditemukan.');
    if (!['awaiting_payment', 'pending'].includes(current.status)) {
      return { success: false, reason: `Order tidak dapat dibatalkan dari status ${current.status}`, order: current };
    }
    const order = await Order.findOneAndUpdate(
      { orderId, status: { $in: ['awaiting_payment', 'pending'] } },
      { $set: { status: 'cancelled', notes: reason } },
      { new: true }
    );
    if (!order) {
      const latest = await Order.findOne({ orderId });
      return { success: false, reason: `Order tidak dapat dibatalkan dari status ${latest?.status || 'unknown'}`, order: latest };
    }
    await AuditLog.log({
      storeId: order.storeId, actorId: order.buyerId, actorType: 'buyer',
      action: 'ORDER_CANCELLED', entity: 'Order', entityId: orderId,
      details: { reason }, result: 'success',
    });
    return { success: true };
  }

  static async getBuyerOrders(storeId, buyerId, limit = 10) {
    return Order.find({ storeId, buyerId: String(buyerId) })
      .sort({ createdAt: -1 }).limit(limit).lean();
  }

  static async getOtpTimeoutCandidates(limit = 100) {
    const now = new Date().toISOString();
    return Order.find({
      $or: [
        {
          'metadata.otpStatus': 'pending',
          'metadata.otpPendingUntil': { $lt: now },
          'metadata.otpTimeoutAt': { $exists: false },
          status: { $in: ['paid', 'completed'] },
        },
        {
          'metadata.otpStatus': 'timeout',
          $or: [
            { 'metadata.otpRefunded': { $ne: true }, 'metadata.otpRefundRequired': true },
            { 'metadata.otpStockReleased': { $ne: true } },
          ],
          status: 'failed',
        },
      ],
    }).sort({ 'metadata.otpPendingUntil': 1, 'metadata.otpTimeoutAt': 1 }).limit(limit);
  }

  static async expireOldOrders() {
    const expired = await Order.find({
      status: 'awaiting_payment',
      expiresAt: { $lt: new Date() },
    });
    for (const order of expired) await this.cancelOrder(order.orderId, 'Payment timeout');
    if (expired.length) logger.info(`Expired ${expired.length} orders`);
    return expired.length;
  }
}

module.exports = OrderService;
