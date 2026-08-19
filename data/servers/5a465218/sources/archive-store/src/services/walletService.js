'use strict';
const BuyerWallet = require('../models/BuyerWallet');
const Topup = require('../models/Topup');
const AuditLog = require('../models/AuditLog');
const Notification = require('./notificationService');
const logger = require('../utils/logger');
const MessageFormatter = require('../utils/messageFormatter');
const SnapshotService = require('./snapshotService');
const locks = new Map();
class WalletService {
  static async get(storeId, buyerId) { return BuyerWallet.getOrCreate(storeId, buyerId); }
  static async creditTopup(topupId, source = 'gateway', storeId = null) {
    const key = `${storeId || '*'}:${String(topupId)}`;
    const prev = locks.get(key) || Promise.resolve();
    let release; const next = new Promise(r => { release = r; }); const tail = prev.then(() => next); locks.set(key, tail);
    await prev;
    try {
    const topup = await Topup.findOne({ _id: topupId, ...(storeId ? { storeId } : {}) });
    if (!topup || topup.status === 'credited') return { success: false, reason: 'Top up tidak ditemukan atau sudah dikreditkan.' };
    if (topup.status !== 'pending' && topup.status !== 'approved') return { success: false, reason: 'Status top up tidak valid.' };
    const amount = Number(topup.amount || 0);
    if (amount <= 0) return { success: false, reason: 'Nominal top up tidak valid.' };
    const creditResult = await BuyerWallet.credit(topup.storeId, topup.buyerId, amount, { topupId: topup._id, transactionId: `topup:${topup._id}`, source: `topup:${source}` });
    if (!creditResult?.success) throw new Error('Gagal memperbarui saldo buyer.');
    await Topup.findOneAndUpdate({ _id: topup._id, storeId: topup.storeId, status: { $in: ['pending', 'approved'] } }, { $set: { status: 'credited', creditedAt: new Date().toISOString() } });
    await AuditLog.log({ storeId: topup.storeId, actorId: topup.buyerId, actorType: 'system', action: 'BUYER_WALLET_CREDITED', entity: 'Topup', entityId: topup._id, details: { amount, source }, result: 'success' });
    try {
      const BotManager = require('../core/BotManager');
      const bot = BotManager.getBot(topup.storeId);

      const username = topup.buyerUsername || topup.buyerId;
      const money = new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0,
      }).format(amount);

      const method = String(topup.paymentMethod || source);

      // 1. Notifikasi langsung ke Buyer.
      if (bot?.telegram && topup.buyerId) {
        const buyerNotice = MessageFormatter.applyCustomEmojisToHtml(
          `✅ <b>DEPOSIT BERHASIL</b>\n\n` +
          `💰 Saldo bertambah: <b>${money}</b>\n` +
          `🏦 Metode: <b>${method}</b>\n` +
          `🔖 ID Topup: <code>${String(topup._id)}</code>\n\n` +
          `Saldo sudah masuk dan dapat digunakan untuk pembelian.`
        );

        await bot.telegram.sendMessage(
          String(topup.buyerId),
          buyerNotice,
          {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }
        );
      }

      // 2. Tetap kirim notifikasi ke channel Owner/admin jika dikonfigurasi.
      await Notification.send(
        bot,
        `💳 <b>DEPOSIT BERHASIL</b>\n\n` +
        `👤 Pembeli: <b>${String(username).startsWith('@') ? username : '@' + username}</b>\n` +
        `💰 Jumlah: <b>${money}</b>\n` +
        `🏦 Metode: <b>${method}</b>\n` +
        `🔖 ID: <code>${String(topup._id)}</code>`
      );
    } catch (err) {
      logger.warn(`[WalletService] notification failed: ${err.message}`);
    }
    try {
      const backup = await SnapshotService.sendToOwner('buyer-topup');
      logger.info(`[TOPUP BACKUP] sent=${backup.filename}`);
    } catch (err) {
      logger.warn(`[TOPUP BACKUP] gagal: ${err.message}`);
    }
    return { success: true, amount };
    } finally { release(); if (locks.get(key) === tail) locks.delete(key); }
  }
}
module.exports = WalletService;
