'use strict';

const Order = require('../../models/Order');
const ownerKeyboard = require('../../keyboards/ownerKeyboard');
const TelePremiumOrder = require('../../models/TelePremiumOrder');

function formatPrice(n) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
  }).format(Number(n || 0));
}

function escapeHtml(value) {
  return String(value ?? '-')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return escapeHtml(value);
  return d.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
}

function statusLabel(order) {
  const metadata = order?.metadata || {};
  const otpStatus = String(metadata.otpStatus || '').toLowerCase();
  if (otpStatus === 'timeout') return '⏰ Timeout OTP — Gagal & refund';
  if (otpStatus === 'cancelled') return '🚫 Dibatalkan buyer — refund';
  if (otpStatus === 'delivered' || metadata.otpDeliveredAt) return '✅ OTP diterima — selesai';
  if (otpStatus === 'pending') return '🟡 Menunggu OTP';

  const labels = {
    awaiting_payment: '💳 Menunggu pembayaran',
    pending: '⏳ Menunggu proses',
    paid: '💰 Sudah dibayar / menunggu OTP',
    completed: '✅ Berhasil / selesai',
    failed: '❌ Gagal',
    cancelled: '🚫 Dibatalkan',
  };
  return labels[order?.status] || String(order?.status || 'Tidak diketahui');
}

function otpStatusLabel(order) {
  const value = String(order?.metadata?.otpStatus || '').toLowerCase();
  const labels = {
    pending: '🟡 Monitoring aktif / menunggu OTP',
    delivered: '✅ OTP diterima',
    timeout: '⏰ Timeout 10 menit',
    cancelled: '🚫 Dibatalkan buyer',
  };
  return labels[value] || (value ? escapeHtml(value) : '—');
}

function refundLabel(order) {
  const meta = order?.metadata || {};
  if (meta.otpRefunded === true) {
    const amount = Number(meta.otpRefundAmount || 0);
    const when = meta.otpRefundedAt ? ` — ${formatDate(meta.otpRefundedAt)}` : '';
    return `✅ Sudah dikembalikan${amount ? ` (${formatPrice(amount)})` : ''}${when}`;
  }
  if (meta.otpRefundRequired === true) return '🟡 Menunggu refund';
  return '—';
}

function sessionStateLabel(order) {
  const meta = order?.metadata || {};
  if (meta.otpStockReleased === true) {
    return meta.otpStatus === 'timeout'
      ? '📦 Kembali ke stock — cooldown buyer aktif'
      : '📦 Kembali ke stock';
  }
  if (meta.otpDeliveredAt || meta.otpStatus === 'delivered') return '✅ Sudah dipakai / OTP diterima';
  if (meta.otpMonitoringStartedAt) return '🔒 Reserved — monitoring OTP';
  if (order?.status === 'paid' || order?.status === 'pending') return '🔒 Reserved';
  return '—';
}

function paymentLabel(method) {
  const labels = {
    wallet: 'Saldo buyer',
    qris_manual: 'QRIS Manual',
    valqenix: 'Valqenix Gateway',
  };
  return labels[method] || escapeHtml(method || '-');
}

function buildText(order) {
  const metadata = order.metadata || {};
  const buyer = order.buyerUsername ? `@${order.buyerUsername}` : String(order.buyerId || '-');
  const otpUntil = metadata.otpPendingUntil || metadata.otpTimeoutAt || null;
  const cooldownUntil = metadata.otpCooldownUntil || null;
  const lines = [
    '📋 <b>LACAK PESANAN LENGKAP</b>',
    '',
    `<b>🆔 Order / Resi:</b> <code>${escapeHtml(order.orderId || '-')}</code>`,
    `<b>📊 Status:</b> ${statusLabel(order)}`,
    `<b>👤 Buyer:</b> ${escapeHtml(buyer)}`,
    `<b>🔢 Buyer ID:</b> <code>${escapeHtml(order.buyerId || '-')}</code>`,
    `<b>📦 Produk:</b> ${escapeHtml(order.productName || order.productId || '-')}`,
    `<b>🔢 Quantity:</b> ${Number(order.quantity || 0)}`,
    `<b>💰 Harga/Unit:</b> ${formatPrice(order.productPrice)}`,
    `<b>💵 Total:</b> ${formatPrice(order.totalAmount)}`,
    `<b>🏦 Metode:</b> ${paymentLabel(order.paymentMethod)}`,
    '',
    '<b>🕒 WAKTU</b>',
    `<b>Dibuat:</b> ${formatDate(order.createdAt)}`,
    `<b>Dibayar:</b> ${formatDate(order.paidAt)}`,
    `<b>Monitoring OTP:</b> ${formatDate(metadata.otpMonitoringStartedAt)}`,
    `<b>OTP diterima:</b> ${formatDate(metadata.otpDeliveredAt)}`,
    `<b>Timeout OTP:</b> ${formatDate(metadata.otpTimeoutAt)}`,
    `<b>Dibatalkan:</b> ${formatDate(metadata.otpCancelAt)}`,
    `<b>Selesai:</b> ${formatDate(order.deliveredAt || order.completedAt)}`,
    '',
    '<b>🔐 STATUS OTP</b>',
    `<b>Status OTP:</b> ${otpStatusLabel(order)}`,
    `<b>Deadline:</b> ${formatDate(otpUntil)}`,
    `<b>Session:</b> ${sessionStateLabel(order)}`,
    '',
    '<b>💳 REFUND</b>',
    `<b>Status:</b> ${refundLabel(order)}`,
    `<b>Nominal refund:</b> ${formatPrice(metadata.otpRefundAmount || 0)}`,
    `<b>Alasan:</b> ${escapeHtml(order.notes || metadata.otpRefundReason || '-')}`,
    '',
    '<b>📦 STOCK / COOLDOWN</b>',
    `<b>Stock dikembalikan:</b> ${metadata.otpStockReleased ? `✅ Ya${metadata.otpStockReleasedAt ? ` — ${formatDate(metadata.otpStockReleasedAt)}` : ''}` : '❌ Belum'}`,
    `<b>Cooldown buyer:</b> ${cooldownUntil ? `⏳ Sampai ${formatDate(cooldownUntil)}` : '—'}`,
    `<b>Session keluar permanen:</b> ${metadata.otpDeliveredAt ? '✅ Setelah OTP diterima' : '❌ Tidak'}`,
  ];

  if (metadata.sessionPhone) lines.push(`<b>📞 Nomor:</b> <code>${escapeHtml(metadata.sessionPhone)}</code>`);
  if (metadata.sessionTelegramId) lines.push(`<b>🆔 Telegram ID akun:</b> <code>${escapeHtml(metadata.sessionTelegramId)}</code>`);
  if (metadata.otpRefundTransactionId) lines.push(`<b>🧾 Refund TX:</b> <code>${escapeHtml(metadata.otpRefundTransactionId)}</code>`);
  if (metadata.checkoutToken) lines.push(`<b>🔑 Checkout token:</b> <code>${escapeHtml(metadata.checkoutToken)}</code>`);
  return lines.join('\n');
}


function telePremiumStatusLabel(order) {
  const labels = {
    pending: '🟡 Menunggu diproses',
    processing: '🔄 Sedang diproses',
    completed: '✅ Sudah selesai',
    cancelled: '❌ Dibatalkan / refund',
  };
  return labels[order?.status] || String(order?.status || '-');
}

function buildTelePremiumText(order) {
  const buyer = order.buyerUsername ? `@${order.buyerUsername}` : String(order.buyerId || '-');
  const target = order.targetUsername ? `@${order.targetUsername}` : 'Owner @rax1xcode (Login)';
  return [
    '🌟 <b>LACAK TELEGRAM PREMIUM</b>',
    '',
    `<b>🔖 Resi:</b> <code>${escapeHtml(order.orderId)}</code>`,
    `<b>📊 Status:</b> ${telePremiumStatusLabel(order)}`,
    `<b>👤 Nama pemesan:</b> ${escapeHtml(order.buyerName || '-')}`,
    `<b>👤 Username pemesan:</b> ${escapeHtml(buyer)}`,
    `<b>🌟 Username tujuan:</b> ${escapeHtml(target)}`,
    `<b>🆔 ID:</b> <code>${escapeHtml(order.buyerId || '-')}</code>`,
    `<b>📦 Produk:</b> ${escapeHtml(order.productName || '-')}`,
    `<b>💰 Harga:</b> ${formatPrice(order.price)}`,
    `<b>🕒 Dibuat:</b> ${formatDate(order.createdAt)}`,
    `<b>🔄 Diproses:</b> ${formatDate(order.processingAt)}`,
    `<b>✅ Selesai:</b> ${formatDate(order.completedAt)}`,
    `<b>❌ Dibatalkan:</b> ${formatDate(order.cancelledAt)}`,
    `<b>💳 Refund:</b> ${Number(order.refundAmount || 0) > 0 ? `✅ ${formatPrice(order.refundAmount)}` : '—'}`,
    `<b>📝 Alasan:</b> ${escapeHtml(order.cancelReason || '-')}`,
  ].join('\n');
}

class OrderTrackingHandler {
  static register(bot) {
    bot.action('owner:order_tracking', async ctx => {
      await ctx.answerCbQuery().catch(() => {});
      ctx.session.flow = 'owner_order_tracking';
      ctx.saveSession();
      await ctx.reply(
        '<b>Lacak Pesanan</b>\n\nKirim Order ID yang ingin dilacak.\nContoh: <code>ORD-XXXXXXXX</code>',
        { parse_mode: 'HTML', ...ownerKeyboard.cancelButton() }
      );
    });
  }

  static async handleTextInput(ctx) {
    if (ctx.session.flow !== 'owner_order_tracking') return false;

    const orderId = String(ctx.message?.text || '').trim().toUpperCase();
    if (!orderId || orderId.length > 100) {
      await ctx.reply('Order ID tidak valid. Silakan kirim Order ID yang benar.');
      return true;
    }

    if (!/^(?:ORD|TPR)-[A-Z0-9-]+$/.test(orderId)) {
      await ctx.reply('Format Order ID tidak valid. Contoh: ORD-XXXXXXXX');
      return true;
    }

    ctx.session.flow = null;
    ctx.saveSession();

    if (/^TPR-[A-Z0-9-]+$/i.test(orderId)) {
      const premiumOrder = await TelePremiumOrder.findOne({ orderId, storeId: ctx.storeId });
      if (!premiumOrder) {
        await ctx.reply('Resi Telegram Premium tidak ditemukan di toko ini.', ownerKeyboard.backButton());
        return true;
      }
      await ctx.reply(buildTelePremiumText(premiumOrder), {
        parse_mode: 'HTML',
        ...ownerKeyboard.backButton(),
      });
      return true;
    }

    const order = await Order.findOne({ orderId, storeId: ctx.storeId });
    if (!order) {
      await ctx.reply('Order tidak ditemukan di toko ini.', ownerKeyboard.backButton());
      return true;
    }

    await ctx.reply(buildText(order), {
      parse_mode: 'HTML',
      ...ownerKeyboard.backButton(),
    });
    return true;
  }
}

module.exports = OrderTrackingHandler;
