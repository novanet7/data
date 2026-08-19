'use strict';

const Product = require('../../models/Product');
const Store = require('../../models/Store');
const ownerKeyboard = require('../../keyboards/ownerKeyboard');
const SessionService = require('../../services/sessionService');
const { withInventoryLock } = require('../../utils/inventoryLock');
const AuditLog = require('../../models/AuditLog');
const IdPricing = require('../../services/idPricingService');
const Notification = require('../../services/notificationService');
const SnapshotService = require('../../services/snapshotService');
const logger = require('../../utils/logger');
const NokosStatusService = require('../../services/nokosStatusService');


class SessionRestockHandler {
  static register(bot) {
    bot.action('owner:restock', async ctx => {
      await ctx.answerCbQuery();

      // Admin restock does NOT ask for ID/prefix/digit first.
      // The bot determines the real Telegram ID after login and routes the
      // account automatically to the matching buyer bucket (1..8 + digit length).
      const stagingProductId = `__admin_restock__${ctx.from.id}`;
      ctx.session.flow = 'tg_phone';
      ctx.session.restockProductId = stagingProductId;
      ctx.session.restockTargetPrefix = null;
      ctx.session.restockTargetDigits = null;
      ctx.saveSession();

      await ctx.editMessageText(
        '📥 *Restock Akun Telegram*\n\n' +
        'Kirim nomor Telegram akun yang mau direstock.\n' +
        'Contoh: `+628123456789`\n\n' +
        '🤖 *ID dan jumlah digit akan dideteksi otomatis oleh bot setelah login.*\n' +
        'Akun akan langsung masuk ke stok ID yang sesuai dengan Telegram ID aslinya.\n\n' +
        'Tidak perlu pilih ID dan tidak perlu membuat produk manual.',
        { parse_mode: 'Markdown', ...ownerKeyboard.cancelButton() }
      );
    });

    bot.action(/^session:login_tg:(.+)$/, async ctx => {
      await ctx.answerCbQuery();
      const productId = ctx.match[1];
      const product = await Product.findOne({
        _id: productId, storeId: ctx.storeId, productType: 'telegram_session',
      });
      if (!product) return;

      ctx.session.flow = 'tg_phone';
      ctx.session.restockProductId = String(product._id);
      ctx.saveSession();

      await ctx.editMessageText(
        `📲 *Login Akun Telegram*\n\nProduk: *${escapeMd(product.name)}*\n\nKirim nomor Telegram lengkap dengan kode negara.\nContoh: \`+628123456789\``,
        { parse_mode: 'Markdown', ...ownerKeyboard.cancelButton() }
      );
    });
  }

  static async handleTextInput(ctx) {
    const flow = ctx.session?.flow;
    const text = ctx.message?.text?.trim();
    if (!flow || !text) return false;

    if (flow === 'tg_phone') {
      const productId = ctx.session.restockProductId;
      if (!productId) return false;
      try {
        await SessionService.startTelegramLogin(ctx.storeId, productId, text);
        ctx.session.flow = 'tg_otp';
        ctx.saveSession();
        await ctx.reply('📩 OTP sudah dikirim ke nomor tersebut.\n\nMasukkan kode OTP Telegram:');
      } catch (err) {
        await ctx.reply(`❌ ${err.message}\n\nKirim nomor lagi atau tekan Batal.`, ownerKeyboard.cancelButton());
      }
      return true;
    }

    if (flow === 'tg_otp') {
      const productId = ctx.session.restockProductId;
      try {
        const result = await SessionService.submitTelegramOTP(ctx.storeId, productId, text);
        if (result.needsPassword) {
          ctx.session.flow = 'tg_2fa';
          ctx.saveSession();
          await ctx.reply('🔐 Akun ini memakai 2FA.\n\nMasukkan password 2FA Telegram:');
          return true;
        }
        await this.finishRestock(ctx, result);
      } catch (err) {
        await ctx.reply(`❌ ${err.message}`);
      }
      return true;
    }

    if (flow === 'tg_2fa') {
      const productId = ctx.session.restockProductId;
      try {
        const result = await SessionService.submitTelegramPassword(ctx.storeId, productId, text);
        await this.finishRestock(ctx, result);
      } catch (err) {
        await ctx.reply(`❌ ${err.message}`);
      }
      return true;
    }

    return false;
  }

  static async finishRestock(ctx, result) {
    const sourceProductId = ctx.session.restockProductId;
    if (!sourceProductId) return;
    const isStaging = String(sourceProductId).startsWith('__admin_restock__');

    // The selected ID/digit is only a shortcut for choosing the price bucket.
    // The actual Telegram ID is authoritative, so inventory can never land in
    // the wrong buyer bucket.
    let targetProductId = isStaging ? null : sourceProductId;
    let routedProduct = isStaging ? null : await Product.findOne({ _id: sourceProductId, storeId: ctx.storeId, productType: 'telegram_session' });
    const actualId = result.telegramId;
    const info = IdPricing.getIdInfo(actualId);
    let nokosStatus = 'fs';
    let nokosStatusReason = 'legacy_default';
    let nokosStatusDetectedAt = null;

    // Detect FS/NFS from SangMata using the just-authenticated Telegram session.
    // Failure keeps the legacy FS routing so an external detector outage never
    // destroys or strands an otherwise valid restock.
    try {
      const detected = await NokosStatusService.detectNokosStatus(result.sessionString, actualId);
      nokosStatus = detected.status === 'nfs' ? 'nfs' : 'fs';
      nokosStatusReason = detected.reason || 'detected';
      nokosStatusDetectedAt = detected.detectedAt || new Date().toISOString();
    } catch (err) {
      nokosStatus = 'fs';
      nokosStatusReason = 'detection_error_fallback_fs';
      logger.warn(`[RESTOCK] SangMata detection failed id=${actualId}: ${err.message}`);
    }

    if (info.valid) {
      const freshStore = await Store.findOne({ storeId: ctx.storeId });
      const actualPrice = IdPricing.getConfiguredPrice(freshStore, info.prefix, info.digitLength, nokosStatus);
      if (actualPrice <= 0) {
        await ctx.reply(
          `❌ Akun login berhasil, tetapi harga *ID ${info.prefix} — ${info.digitLength} Digit* belum diset.\n\n` +
          `Stok belum dimasukkan agar akun tidak masuk ke bucket yang salah/gratis. Atur Pricelist ID lalu lakukan restock lagi.`,
          { parse_mode: 'Markdown', ...ownerKeyboard.backButton('owner:id_pricelist') }
        );
        ctx.session.flow = null;
        ctx.session.restockProductId = null;
        ctx.saveSession();
        return;
      }
      const bucket = await IdPricing.ensureBucketForId(ctx.storeId, actualId);
      targetProductId = String(bucket.product._id);
      routedProduct = bucket.product;
    }

    // Login is always started in a temporary staging bucket. After Telegram
    // returns the real user ID, move the session into the exact buyer bucket.
    if (!targetProductId) {
      if (result.sessionFile) {
        try { require('fs').unlinkSync(result.sessionFile); } catch {}
      }
      await ctx.reply('❌ Telegram ID tidak valid sehingga akun tidak dimasukkan ke stok.');
      ctx.session.flow = null;
      ctx.session.restockProductId = null;
      ctx.saveSession();
      return;
    }

    await withInventoryLock(ctx.storeId, targetProductId, async () => {
      const fs = require('fs');
      const path = require('path');
      if (result.sessionFile) {
        const dir = path.dirname(result.sessionFile);
        const targetFile = path.join(dir, `${targetProductId}_${String(actualId)}.session`);
        try {
          // Never overwrite an existing unsold session for the same Telegram ID.
          if (path.resolve(result.sessionFile) !== path.resolve(targetFile) && fs.existsSync(targetFile)) {
            const existing = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
            if (existing.loggedIn && !existing.soldTo) {
              throw new Error('Akun Telegram dengan ID tersebut sudah ada di inventory.');
            }
            fs.unlinkSync(targetFile);
          }
          const data = JSON.parse(fs.readFileSync(result.sessionFile, 'utf8'));
          data.telegramId = String(actualId);
            data.profileColor = data.profileColor || result.profileColor || null;
            data.idPrefix = info.prefix;
          data.idDigits = info.digitLength;
          data.nokosStatus = nokosStatus;
          data.nokosStatusReason = nokosStatusReason;
          data.nokosStatusDetectedAt = nokosStatusDetectedAt;
          fs.writeFileSync(targetFile, JSON.stringify(data, null, 2), 'utf8');
          if (path.resolve(result.sessionFile) !== path.resolve(targetFile)) fs.unlinkSync(result.sessionFile);
        } catch (err) {
          await ctx.reply(`❌ Gagal memindahkan session ke bucket ID yang sesuai: ${err.message}`);
          throw err;
        }
      }

      const count = await SessionService.syncStockCount(ctx.storeId, targetProductId, 'telegram_session');
      const product = routedProduct || await Product.findOne({ _id: targetProductId, storeId: ctx.storeId });

      ctx.session.flow = null;
      ctx.session.restockProductId = null;
      ctx.session.restockSubcat = null;
      ctx.session.restockTargetPrefix = null;
      ctx.session.restockTargetDigits = null;
      ctx.saveSession();

      await AuditLog.log({
        storeId: ctx.storeId,
        actorId: ctx.from.id,
        actorType: 'owner',
        action: 'TELEGRAM_ACCOUNT_RESTOCKED',
        entity: 'Product',
        entityId: targetProductId,
        details: { phone: result.phone, telegramId: actualId, stockCount: count, targetProductId, nokosStatus, nokosStatusReason },
        result: 'success',
      });

      // Harga akun mengikuti status FS/NFS yang baru dideteksi.
      const notifyPrice = IdPricing.getConfiguredPrice(
        await Store.findOne({ storeId: ctx.storeId }),
        info.prefix,
        info.digitLength,
        nokosStatus
      );

      // Notifikasi restock ke channel monitoring.
      // Notifikasi tidak boleh menggagalkan proses restock.
      try {
        const sent = await Notification.send(
          ctx.telegram,
          `📥 <b>RESTOCK AKUN TELEGRAM</b>\n\n` +
          `👑 Owner ID: <code>${escapeHtml(ctx.from.id)}</code>\n` +
          `📱 Produk: <b>${escapeHtml(product?.name || 'Akun Telegram')}</b>\n` +
          `🏷️ ID Prefix: <b>${escapeHtml(info.prefix)}</b>\n` +
          `🔢 Digit ID: <b>${escapeHtml(info.digitLength)}</b>\n` +
          `💰 Harga: <b>${escapeHtml(formatPrice(notifyPrice))}</b>\n` +
          `📌 Status: <b>${escapeHtml(nokosStatus.toUpperCase())}</b>\n` +
          `📦 Stok sekarang: <b>${escapeHtml(count)}</b>\n` +
          `🆔 Product ID: <code>${escapeHtml(targetProductId)}</code>`
        );

        logger.info(`[RESTOCK NOTIFY] sent=${sent} channel=${process.env.NOTIFICATION_CHANNEL_ID}`);
      } catch (err) {
        logger.warn(`[RESTOCK NOTIFY] gagal: ${err.message}`);
      }

      // Backup otomatis setelah restock benar-benar berhasil.
      try {
        const backup = await SnapshotService.sendToOwner('restock');
        logger.info(`[RESTOCK BACKUP] sent=${backup.filename} size=${backup.size}`);
      } catch (err) {
        logger.warn(`[RESTOCK BACKUP] gagal: ${err.message}`);
      }

      await ctx.reply(
        `✅ *Akun Telegram berhasil ditambahkan!*\n\n` +
        `📱 ${escapeMd(product?.name || 'Akun Telegram')}\n` +
        `🆔 ID: ${escapeMd(actualId)}\n` +
        `📞 +${result.phone}\n` +
        `📦 Stok sekarang: ${count}`,
        { parse_mode: 'Markdown', ...ownerKeyboard.backButton('owner:restock') }
      );
    });
  }
}

function escapeHtml(t) {
  return String(t ?? '-')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeMd(t) { return t ? String(t).replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&') : ''; }
function formatPrice(n) { return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(n); }

module.exports = SessionRestockHandler;
