'use strict';

const logger = require('../utils/logger');
const MessageFormatter = require('../utils/messageFormatter');

function channelId() {
  return String(process.env.NOTIFICATION_CHANNEL_ID || '').trim();
}

async function send(bot, text) {
  const id = channelId();
  if (!id || !bot?.telegram) return false;

  const rawText = String(text ?? '');
  // Build the final HTML ourselves and do not rely on the global Telegram
  // patch to inject Premium Emoji later. This prevents a second formatting pass
  // from stripping/escaping <tg-emoji> tags before the Bot API sees them.
  const formattedText = MessageFormatter.normalize(rawText, 'HTML');

  try {
    await bot.telegram.sendMessage(id, formattedText, { parse_mode: 'HTML', disable_web_page_preview: true });
    return true;
  } catch (err) {
    try {
      await bot.telegram.sendMessage(id, MessageFormatter.normalize(rawText.replace(/<tg-emoji\b[^>]*>(.*?)<\/tg-emoji>/g, '$1'), 'HTML'), { parse_mode: 'HTML', disable_web_page_preview: true });
      logger.warn(`[Notifications] Premium Emoji rejected, Unicode fallback used: ${err.message}`);
      return true;
    } catch (fallbackErr) {
      logger.warn(`[Notifications] channel failed: ${fallbackErr.message}`);
      return false;
    }
  }
}

function esc(v) { return String(v ?? '-').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function money(v) { return new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',minimumFractionDigits:0}).format(Number(v||0)); }

async function sale(bot, order) {
  return send(bot, `🛒 <b>PEMBELIAN BARU</b>\n\n👤 Pembeli: <b>${esc(order.buyerUsername ? '@'+order.buyerUsername.replace(/^@/,'') : order.buyerId)}</b>\n📦 Jumlah: <b>${order.quantity}</b> akun\n🆔 Tipe akun: <b>${esc(order.productName)}</b>\n💰 Harga: <b>${money(order.totalAmount)}</b>\n🔖 Order: <code>${esc(order.orderId)}</code>`);
}

async function otpEvent(bot, data) {
  return send(bot, `🔐 <b>OTP MASUK</b>\n\n👤 Pembeli: <b>${esc(data.username ? '@'+String(data.username).replace(/^@/,'') : data.userId)}</b>\n📦 Jumlah pembelian: <b>${esc(data.quantity)}</b> akun\n🆔 Tipe akun: <b>${esc(data.productName)}</b>\n💰 Harga: <b>${money(data.totalAmount)}</b>\n🔖 Order: <code>${esc(data.orderId)}</code>\n\n🔒 Kode OTP dan password tidak dikirim ke channel.`);
}


async function stockEmpty(bot, product, ownerId = null) {
  const text = `⚠️ <b>STOK HABIS</b>\n\n` +
    `📦 Produk: <b>${esc(product?.name || product?._id || '-')}</b>\n` +
    `🆔 Product ID: <code>${esc(product?._id || '-')}</code>\n\n` +
    `Stok akun yang tersedia saat ini: <b>0</b>.`;

  let sent = false;
  if (channelId()) sent = await send(bot, text) || sent;

  const oid = String(ownerId || process.env.PLATFORM_OWNER_ID || '').trim();
  if (oid && bot?.telegram) {
    try {
      const ownerText = MessageFormatter.applyCustomEmojisToHtml(text);
      try {
        await bot.telegram.sendMessage(oid, ownerText, { parse_mode: 'HTML', disable_web_page_preview: true });
      } catch (err) {
        // Preserve the original Unicode emoji when the client/server rejects
        // the Premium Custom Emoji entities.
        await bot.telegram.sendMessage(oid, text, { parse_mode: 'HTML', disable_web_page_preview: true });
      }
      sent = true;
    } catch (err) {
      logger.warn(`[Notifications] owner stock warning failed: ${err.message}`);
    }
  }
  return sent;
}

async function sellerDeposit(bot, deposit, status='credited') {
  return send(bot, `📥 <b>SETORAN AKUN</b>\n\n👤 Seller: <b>${esc(deposit.sellerUsername ? '@'+String(deposit.sellerUsername).replace(/^@/,'') : deposit.sellerId)}</b>\n🆔 Telegram ID: <code>${esc(deposit.telegramId)}</code>\n🏷️ Tipe akun: <b>ID ${esc(deposit.metadata?.idPrefix)} — ${esc(deposit.metadata?.idDigits)} digit</b>\n💰 Harga setoran: <b>${money(deposit.price)}</b>\n📊 Status: <b>${esc(status)}</b>`);
}

module.exports = { send, sale, otpEvent, sellerDeposit, stockEmpty };
