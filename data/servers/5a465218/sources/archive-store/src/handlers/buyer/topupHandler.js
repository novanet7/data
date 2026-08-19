'use strict';
const { Markup } = require('telegraf');
const Store = require('../../models/Store');
const Topup = require('../../models/Topup');
const BuyerWallet = require('../../models/BuyerWallet');
const buyerKeyboard = require('../../keyboards/buyerKeyboard');
const WalletService = require('../../services/walletService');
const Valqenix = require('../../payments/valqenix');
const logger = require('../../utils/logger');

function fmt(n) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
  }).format(n || 0);
}


function promptTopupAmount(ctx, method) {
  ctx.session.topupMethod = method;
  ctx.session.flow = 'topup_amount';
  ctx.saveSession();
  const label = method === 'valqenix' ? '🌐 Valqenix' : '📷 QRIS Manual';
  return TopupHandler.safeEditOrReply(
    ctx,
    `💰 *Top Up Saldo*\n\nMetode aktif: *${label}*\nMasukkan nominal lu (minimal Rp2.000) bismillah di lebihin.`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: ' Batal', callback_data: 'topup:cancel' }]] } }
  );
}

class TopupHandler {
  static async safeEditOrReply(ctx, text, options) {
    try {
      return await ctx.editMessageText(text, options);
    } catch (err) {
      logger.warn('[Topup] editMessageText failed, falling back to reply:', err.message);
      return ctx.reply(text, options);
    }
  }

  static register(bot) {
    bot.action('buyer:wallet', async ctx => {
      await ctx.answerCbQuery();
      await this.showWallet(ctx);
    });
    bot.action('buyer:topup', async ctx => {
      await ctx.answerCbQuery();
      await this.showMethods(ctx);
    });
    bot.action('buyer:deposit', async ctx => {
      await ctx.answerCbQuery();
      await this.showMethods(ctx);
    });

    bot.action(/^topup:method:(manual|valqenix)$/, async ctx => {
      await ctx.answerCbQuery();
      return promptTopupAmount(ctx, ctx.match[1]);
    });

    bot.action('topup:cancel', async ctx => {
      await ctx.answerCbQuery();
      ctx.session.flow = null;
      ctx.session.topupMethod = null;
      ctx.saveSession();
      await this.showWallet(ctx);
    });

    bot.action(/^topup:approve:(.+)$/, async ctx => {
      if (!ctx.store.isOwner(ctx.from.id)) return;
      await ctx.answerCbQuery();
      const id = ctx.match[1];
      const t = await Topup.findOne({ _id: id, storeId: ctx.storeId, paymentMethod: 'qris_manual' });
      if (!t || t.status !== 'pending') return ctx.reply('❌ Top up tidak valid atau sudah diproses.');
      const r = await WalletService.creditTopup(id, 'manual', ctx.storeId);
      if (!r.success) return ctx.reply(`❌ ${r.reason}`);
      await Topup.findOneAndUpdate(
        { _id: id, storeId: ctx.storeId, status: 'pending' },
        {
          $set: {
            status: 'approved',
            approvedBy: String(ctx.from.id),
            approvedAt: new Date().toISOString()
          }
        }
      );

      // Update pesan Owner agar tombol approve/reject hilang.
      try {
        if (ctx.callbackQuery?.message?.photo) {
          await ctx.editMessageCaption(
            `✅ <b>TOP UP MANUAL DISETUJUI</b>\n\n` +
            `👤 Buyer: <code>${t.buyerId}</code>\n` +
            `💵 Nominal: <b>${fmt(r.amount)}</b>\n` +
            `🆔 Topup: <code>${t._id}</code>\n\n` +
            `Saldo buyer sudah dikreditkan.`,
            {
              parse_mode: 'HTML'
            }
          );
        }
      } catch (editErr) {
        console.warn('[Topup] gagal update pesan approve Owner:', editErr.message);
      }

      await ctx.answerCbQuery('✅ Top up disetujui');
      await ctx.reply(`✅ Top up disetujui. Saldo buyer +${fmt(r.amount)}.`);
    });

    bot.action(/^topup:reject:(.+)$/, async ctx => {
      if (!ctx.store.isOwner(ctx.from.id)) return;
      await ctx.answerCbQuery();
      const id = ctx.match[1];
      const t = await Topup.findOne({ _id: id, storeId: ctx.storeId });
      if (!t || t.status !== 'pending') return ctx.reply('❌ Top up tidak valid.');
      await Topup.findOneAndUpdate(
        { _id: id, storeId: ctx.storeId, status: 'pending' },
        {
          $set: {
            status: 'rejected',
            rejectedAt: new Date().toISOString(),
            rejectedBy: String(ctx.from.id)
          }
        }
      );

      // Notifikasi balik ke Buyer ketika deposit ditolak.
      try {
        await ctx.telegram.sendMessage(
          String(t.buyerId),
          `❌ <b>TOP UP DITOLAK</b>\n\n` +
          `💰 Nominal: <b>${fmt(t.amount)}</b>\n` +
          `🆔 Topup: <code>${t._id}</code>\n\n` +
          `Bukti pembayaran kamu ditolak oleh admin.\n` +
          `Saldo tidak bertambah.`,
          { parse_mode: 'HTML' }
        );
      } catch (notifyErr) {
        console.warn('[Topup] gagal mengirim notifikasi reject ke buyer:', notifyErr.message);
      }

      // Update pesan Owner agar status langsung terlihat.
      try {
        if (ctx.callbackQuery?.message?.photo) {
          await ctx.editMessageCaption(
            `❌ <b>TOP UP MANUAL DITOLAK</b>\n\n` +
            `👤 Buyer: <code>${t.buyerId}</code>\n` +
            `💵 Nominal: <b>${fmt(t.amount)}</b>\n` +
            `🆔 Topup: <code>${t._id}</code>\n\n` +
            `Deposit ditolak. Saldo buyer tidak bertambah.`,
            {
              parse_mode: 'HTML'
            }
          );
        }
      } catch (editErr) {
        console.warn('[Topup] gagal update pesan reject Owner:', editErr.message);
      }

      await ctx.answerCbQuery('❌ Top up ditolak');
      await ctx.reply('❌ Top up ditolak. Saldo tidak bertambah.');
    });
  }

  static async handleTextInput(ctx) {
    if (ctx.session?.flow !== 'topup_amount') return false;
    const amount = Number(String(ctx.message?.text || '').replace(/[^0-9]/g, ''));
    if (!Number.isInteger(amount) || amount < 1000) {
      await ctx.reply('❌ Minimal top up Rp1.000.');
      return true;
    }

    const method = ctx.session.topupMethod;
    ctx.session.flow = null;
    ctx.session.topupMethod = null;
    ctx.saveSession();

    const store = await Store.findOne({ storeId: ctx.storeId });
    if (method === 'valqenix') {
      if (!store?.paymentSettings?.valqenix?.enabled || !store.paymentSettings.valqenix.apiKey || !store.paymentSettings.valqenix.webhookSecret) {
        await ctx.reply('❌ Valqenix sedang tidak aktif.');
        return true;
      }
      try {
        const reference = `TOPUP-${ctx.from.id}-${Date.now()}`;
        const p = await Valqenix.createPayment({
          apiKey: store.paymentSettings.valqenix.apiKey,
          amount,
          note: reference,
          storeId: ctx.storeId,
          buyerId: ctx.from.id,
          sandbox: !!store.paymentSettings.valqenix.sandbox,
        });
        await Topup.create({
          storeId: ctx.storeId,
          buyerId: String(ctx.from.id),
          amount,
          paymentMethod: 'valqenix',
          reference: p.reference,
          invoiceId: p.invoice.invoiceId,
          status: 'pending',
          rawResponse: p,
        });
        const caption = `🌐 *Valqenix Top Up*\n\n💰 Saldo masuk: *${fmt(amount)}*\n💳 Total bayar: *${fmt(p.totalPay || amount)}*\n🆔 Ref: \`${p.reference}\`\n\n⏳ Saldo otomatis masuk setelah pembayaran *paid*.`;
        if (p.qrDataUrl) {
          try {
            if (String(p.qrDataUrl).startsWith('data:image/')) {
              const base64 = String(p.qrDataUrl).split(',')[1];
              await ctx.replyWithPhoto({ source: Buffer.from(base64, 'base64') }, { caption, parse_mode: 'Markdown' });
            } else {
              await ctx.replyWithPhoto(p.qrDataUrl, { caption, parse_mode: 'Markdown' });
            }
          } catch (qrErr) {
            logger.warn('[Topup Valqenix QR]', qrErr.message);
            await ctx.reply(caption, { parse_mode: 'Markdown' });
          }
        } else {
          await ctx.reply(caption, { parse_mode: 'Markdown' });
        }
        if (p.paymentLink) await ctx.reply(`🔗 *Link pembayaran:* ${p.paymentLink}`, { parse_mode: 'Markdown' });
        return true;
      } catch (e) {
        logger.error('[Topup Valqenix]', e.message);
        await ctx.reply(`❌ Gagal membuat pembayaran: ${e.message}`);
        return true;
      }
    }

    if (method !== 'manual') {
      await ctx.reply('❌ Metode top up tidak valid. Buka menu Top Up lagi.');
      return true;
    }

    if (!store?.paymentSettings?.qris?.enabled) {
      await ctx.reply('❌ QRIS Manual sedang OFF di pengaturan admin.');
      return true;
    }
    if (!store.paymentSettings.qris.imageUrl) {
      await ctx.reply('❌ QRIS Manual ON, tetapi foto QRIS belum diupload admin.');
      return true;
    }

    const t = await Topup.create({
      storeId: ctx.storeId,
      buyerId: String(ctx.from.id),
      amount,
      paymentMethod: 'qris_manual',
      status: 'pending',
    });
    ctx.session.uploadingTopupProof = String(t._id);
    ctx.saveSession();

    const caption = `📤 *Top Up Manual*\n\nNominal: *${fmt(amount)}*\nSilakan scan QRIS toko, bayar sesuai nominal, lalu kirim screenshot bukti pembayaran di chat ini.`;
    try {
      await ctx.replyWithPhoto(store.paymentSettings.qris.imageUrl, { caption, parse_mode: 'Markdown' });
    } catch (qrErr) {
      logger.warn('[Topup QRIS Manual QR]', qrErr.message);
      await ctx.reply(caption, { parse_mode: 'Markdown' });
    }
    return true;
  }

  static async handlePhoto(ctx) {
    const id = ctx.session?.uploadingTopupProof;
    if (!id) return false;
    const photo = ctx.message?.photo;
    if (!photo?.length) return false;
    const fileId = photo[photo.length - 1].file_id;
    const t = await Topup.findOne({ _id: id, storeId: ctx.storeId, buyerId: String(ctx.from.id) });
    if (!t) return false;
    await Topup.findOneAndUpdate(
      { _id: id, storeId: ctx.storeId },
      { $set: { proofFileId: fileId, status: 'pending' } }
    );
    // Keep the in-memory record in sync. The previous code checked t.proofFileId
    // immediately after the DB update, but t was the old object, so the proof
    // was always considered missing and the Owner notification block was skipped.
    t.proofFileId = fileId;
    t.status = 'pending';

    ctx.session.uploadingTopupProof = null;
    ctx.saveSession();
    await ctx.reply('⏳ Bukti top up diterima. Menunggu verifikasi admin.');

    const store = await Store.findOne({ storeId: ctx.storeId });
    const ownerChatId = store?.ownerId ? String(store.ownerId) : null;
    if (ownerChatId && t.proofFileId) {
      try {
        // Kirim FOTO bukti pembayaran langsung ke Owner.
        await ctx.telegram.sendPhoto(
          ownerChatId,
          t.proofFileId,
          {
            caption:
              `💰 TOP UP MANUAL BARU\n\n` +
              `👤 Buyer: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.id}\n` +
              `🆔 Buyer ID: ${ctx.from.id}\n` +
              `💵 Nominal: ${fmt(t.amount)}\n` +
              `🆔 Topup: ${t._id}\n\n` +
              `📷 Bukti pembayaran terlampir.`,
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.callback(' APPROVE', `topup:approve:${t._id}`),
                Markup.button.callback(' TOLAK', `topup:reject:${t._id}`)
              ]
            ]).reply_markup
          }
        );
      } catch (sendErr) {
        console.error('[Topup] gagal mengirim foto bukti ke Owner:', sendErr.message);

        // Fallback: minimal kirim informasi topup jika foto gagal.
        try {
          await ctx.telegram.sendMessage(
            ownerChatId,
            `⚠️ <b>TOP UP MANUAL BARU</b>\n\n` +
            `👤 Buyer: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.id}\n` +
            `🆔 Buyer ID: ${ctx.from.id}\n` +
            `💵 Nominal: ${fmt(t.amount)}\n` +
            `🆔 Topup: <code>${t._id}</code>\n\n` +
            `⚠️ Foto bukti gagal dikirim. Silakan cek Topup ID.`,
            {
              parse_mode: 'HTML',
              reply_markup: Markup.inlineKeyboard([
                [
                  Markup.button.callback(' APPROVE', `topup:approve:${t._id}`),
                  Markup.button.callback(' TOLAK', `topup:reject:${t._id}`)
                ]
              ]).reply_markup
            }
          );
        } catch (fallbackErr) {
          console.error('[Topup] fallback Owner juga gagal:', fallbackErr.message);
        }
      }
    } else {
      console.warn('[Topup] ownerId tidak tersedia; bukti top up tersimpan tetapi notifikasi Owner tidak dapat dikirim.');
    }
    return true;
  }

  static async showWallet(ctx) {
    const w = await BuyerWallet.getOrCreate(ctx.storeId, ctx.from.id);
    const store = await Store.findOne({ storeId: ctx.storeId });
    const active = [];
    if (store?.paymentSettings?.qris?.enabled) active.push('QRIS Manual');
    if (store?.paymentSettings?.valqenix?.enabled) active.push('Valqenix');
    const methodText = active.length ? `Metode aktif: ${active.join(' • ')}` : 'Belum ada metode deposit aktif di admin.';
    await this.safeEditOrReply(
      ctx,
      `💰 *Saldo Kamu*\n\nSaldo: *${fmt(w.balance)}*\n\nDeposit bisa dipakai kapan saja, tidak perlu menunggu saldo habis.\n${methodText}`,
      { parse_mode: 'Markdown', ...buyerKeyboard.walletMenu() }
    );
  }

  static async showMethods(ctx) {
    const store = await Store.findOne({ storeId: ctx.storeId });
    const ps = store?.paymentSettings || {};
    const qris = ps.qris || {};
    const gateway = ps.valqenix || {};

    const activeMethods = [];
    if (qris.enabled) activeMethods.push({ key: 'manual', label: `📷 QRIS Manual${qris.imageUrl ? '' : ' ⚠️'}` });
    if (gateway.enabled) activeMethods.push({ key: 'valqenix', label: `🌐 Valqenix${gateway.apiKey ? '' : ' ⚠️'}` });

    if (activeMethods.length === 1) {
      return promptTopupAmount(ctx, activeMethods[0].key);
    }

    const rows = [];
    for (const method of activeMethods) {
      rows.push([Markup.button.callback(method.label, `topup:method:${method.key}`)]);
    }
    const note = !rows.length
      ? ' Belum ada metode top up yang diaktifkan admin.'
      : 'Pilih metode top up yang aktif. Jika keduanya aktif, kamu bisa memilih salah satu.';
    if (!rows.length) rows.push([Markup.button.callback(' Belum ada metode aktif', 'noop')]);
    rows.push([Markup.button.callback('⬅ Kembali', 'buyer:wallet')]);
    await this.safeEditOrReply(
      ctx,
      ` *Pilih Metode Top Up*\n\n${note}`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
    );
  }
}

module.exports = TopupHandler;
