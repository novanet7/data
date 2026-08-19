'use strict';

/**
 * QRIS Manual Payment Handler
 * 
 * This is a manual payment flow where:
 * 1. Store owner uploads QRIS image
 * 2. Buyer scans and pays
 * 3. Buyer uploads payment proof
 * 4. Owner verifies and confirms
 */

class QrisManual {
  static async initializePayment(order, store) {
    return {
      method: 'qris_manual',
      orderId: order.orderId,
      amount: order.totalAmount,
      qrisImageFileId: store.paymentSettings.qris.imageUrl,
      paymentName: store.paymentSettings.qris.paymentName,
      requiresManualVerification: true,
    };
  }

  static formatPaymentInstructions(order, store) {
    const fmt = (n) => new Intl.NumberFormat('id-ID', {
      style: 'currency', currency: 'IDR', minimumFractionDigits: 0
    }).format(n);

    return `📷 *QRIS Payment Instructions*\n\n` +
      `🏪 ${store.settings.storeName}\n` +
      `🆔 Order: \`${order.orderId}\`\n` +
      `💰 Amount: *${fmt(order.totalAmount)}*\n\n` +
      `📋 *Steps:*\n` +
      `1. Open your payment app\n` +
      `2. Scan the QRIS code\n` +
      `3. Pay exactly *${fmt(order.totalAmount)}*\n` +
      `4. Take a screenshot/photo of payment proof\n` +
      `5. Upload the proof using the button below\n\n` +
      `⏰ Payment expires in 30 minutes\n` +
      `⚠️ Pay exactly the amount shown`;
  }
}

module.exports = QrisManual;
