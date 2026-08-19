'use strict';

const SellerService = require('../services/sellerService');
const NokosStatusService = require('../services/nokosStatusService');
const SellerDeposit = require('../models/SellerDeposit');
const SellerWallet = require('../models/SellerWallet');
const AuditLog = require('../models/AuditLog');
const Product = require('../models/Product');
const { Markup } = require('telegraf');

function fmt(n) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(n || 0);
}
function esc(t) { return String(t || '').replace(/[_*\[\]()~`>#+=|{}.!-]/g, '\\$&'); }

function menu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(' Setor Akun Telegram', 'seller:deposit')],
    [Markup.button.callback(' Setoran Saya', 'seller:deposits')],
    [Markup.button.callback(' Saldo Seller', 'seller:wallet')],
    [Markup.button.callback(' Tarik Saldo', 'seller:withdraw')],
    [Markup.button.callback('⬅ Kembali ke Toko', 'shop:start')],
  ]);
}

function checkMenu(depositId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(' Cek Sesi', `seller:check:${depositId}`)],
    [Markup.button.callback(' Saldo Seller', 'seller:wallet')],
    [Markup.button.callback(' Tarik Saldo', 'seller:withdraw')],
  ]);
}

class SellerHandler {
  static register(bot) {
    bot.action('seller:start', async ctx => {
      await ctx.answerCbQuery();
      const wallet = await SellerService.getWallet(ctx.storeId, ctx.from.id);
      const deposits = await SellerDeposit.find({ storeId: ctx.storeId, sellerId: String(ctx.from.id) }).sort({ createdAt: -1 }).limit(5);
      const pending = deposits.filter(d => ['awaiting_session_clear', 'pending'].includes(d.status)).length;
      await ctx.editMessageText(
        `💼 *Seller Marketplace*\n\n` +
        `💰 Saldo: *${fmt(wallet?.balance || 0)}*\n` +
        `📦 Setoran aktif: *${pending}*\n\n` +
        `Setorkan akun Telegram milikmu. Sistem akan memeriksa status anti\-spam, ID, harga, lalu menunggu sesi lain keluar sebelum saldo dibayarkan.`,
        { parse_mode: 'Markdown', ...menu() }
      );
    });

    bot.action('seller:deposit', async ctx => {
      await ctx.answerCbQuery();
      const store = await require('../models/Store').findOne({ storeId: ctx.storeId });
      if (store?.settings?.sellerPricing?.enabled === false) {
        return ctx.editMessageText(' *Setor akun sedang ditutup oleh admin.*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅ Kembali', 'seller:start')]]) });
      }
      ctx.session.flow = 'seller_phone';
      ctx.saveSession();
      await ctx.editMessageText(
        `📥 *Setor Akun Telegram*\n\n` +
        `Kirim nomor Telegram akun yang ingin disetor dengan kode negara dan + di awal.\n` +
        `Contoh: \`+628912345678\`\n\n` +
        `⚠️ Pastikan kamu udah move on ya sebelum di jual ke aku,janji aku rawat kok.`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(' Batal', 'seller:cancel')]]) }
      );
    });

    bot.action('seller:cancel', async ctx => {
      await ctx.answerCbQuery();
      ctx.session.flow = null;
      ctx.session.sellerDepositId = null;
      ctx.saveSession();
      await ctx.editMessageText('💼 *Seller Marketplace*', { parse_mode: 'Markdown', ...menu() });
    });

    bot.action('seller:wallet', async ctx => {
      await ctx.answerCbQuery();
      const wallet = await SellerService.getWallet(ctx.storeId, ctx.from.id);
      await ctx.editMessageText(
        `💰 *Saldo Seller*\n\n` +
        `Saldo tersedia: *${fmt(wallet?.balance || 0)}*\n` +
        `Total penghasilan: ${fmt(wallet?.totalEarned || 0)}\n` +
        `Total dicairkan: ${fmt(wallet?.totalWithdrawn || 0)}\n\n` +
        `Pilih Tarik Saldo untuk mengajukan pencairan ke rekening bank.`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
          [Markup.button.callback(' Tarik Saldo', 'seller:withdraw')],
          [Markup.button.callback(' Riwayat Penarikan', 'seller:withdrawals')],
          [Markup.button.callback(' Riwayat Saldo', 'seller:balance_history')],
          [Markup.button.callback('⬅ Seller Menu', 'seller:start')],
        ]) }
      );
    });

    bot.action('seller:withdraw', async ctx => {
      await ctx.answerCbQuery();
      const wallet = await SellerService.getWallet(ctx.storeId, ctx.from.id);
      await ctx.editMessageText(
        `🏦 *Tarik Saldo Seller*\n\n` +
        `💰 Saldo tersedia: *${fmt(wallet?.balance || 0)}*\n\n` +
        `Masukkan data rekening secara berurutan:\n` +
        `1️⃣ Nama bank contoh dana\n` +
        `2️⃣ Nomor rekening\n` +
        `3️⃣ Nama pemilik rekening\n` +
        `4️⃣ Jumlah penarikan\n\n` +
        `Contoh format berikutnya akan diminta satu per satu.`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(' Batal', 'seller:cancel')]]) }
      );
      ctx.session.flow = 'seller_withdraw_bank';
      ctx.session.withdrawDraft = {};
      ctx.saveSession();
    });

    bot.action('seller:withdrawals', async ctx => {
      try {
        await ctx.answerCbQuery();
        const Withdrawal = require('../models/SellerWithdrawal');
        const rows = await Withdrawal.find({ storeId: ctx.storeId, sellerId: String(ctx.from.id) }).sort({ createdAt: -1 }).limit(10);
        const status = { pending: '⏳ Menunggu admin', approved: '✅ Diproses', rejected: '❌ Ditolak' };
        const text = rows.length
          ? rows.map((r,i) => `${i+1}. ${fmt(r.amount)} — ${status[r.status] || r.status}\n   ${esc(r.bankName)} • ${esc(r.accountNumber)}`).join('\n\n')
          : 'Belum ada permintaan penarikan.';
        await ctx.editMessageText(`🏦 *Riwayat Penarikan*\n\n${text}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
          [Markup.button.callback(' Tarik Saldo', 'seller:withdraw')],
          [Markup.button.callback(' Riwayat Saldo', 'seller:balance_history')],
          [Markup.button.callback('⬅ Seller Menu', 'seller:start')],
        ]) });
      } catch (err) {
        await ctx.reply(` Gagal membuka riwayat penarikan: ${err.message}`).catch(() => {});
      }
    });

    bot.action('seller:balance_history', async ctx => {
      try {
        await ctx.answerCbQuery();
        const Withdrawal = require('../models/SellerWithdrawal');
        const deposits = await SellerDeposit.find({ storeId: ctx.storeId, sellerId: String(ctx.from.id), walletCredited: true }).sort({ createdAt: -1 }).limit(10);
        const withdrawals = await Withdrawal.find({ storeId: ctx.storeId, sellerId: String(ctx.from.id) }).sort({ createdAt: -1 }).limit(10);
        const events = [
          ...deposits.map(d => ({ at: d.creditedAt || d.updatedAt || d.createdAt, text: `➕ ${fmt(d.price || 0)} — Setoran akun` })),
          ...withdrawals.map(w => ({ at: w.createdAt, text: `➖ ${fmt(w.amount || 0)} — Penarikan ${w.status === 'rejected' ? 'ditolak/dikembalikan' : w.status === 'approved' ? 'disetujui' : 'menunggu admin'}` })),
        ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 20);
        const text = events.length ? events.map((e, i) => `${i + 1}. ${e.text}\n   ${new Date(e.at).toLocaleString('id-ID')}`).join('\n\n') : 'Belum ada riwayat perubahan saldo.';
        await ctx.editMessageText(`📊 *Riwayat Saldo Seller*\n\n${text}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
          [Markup.button.callback(' Saldo Seller', 'seller:wallet')],
          [Markup.button.callback(' Riwayat Penarikan', 'seller:withdrawals')],
          [Markup.button.callback('⬅ Seller Menu', 'seller:start')],
        ]) });
      } catch (err) {
        await ctx.reply(` Gagal membuka riwayat saldo: ${err.message}`).catch(() => {});
      }
    });

    bot.action('seller:deposits', async ctx => {
      await ctx.answerCbQuery();
      const deposits = await SellerDeposit.find({ storeId: ctx.storeId, sellerId: String(ctx.from.id) }).sort({ createdAt: -1 }).limit(10);
      if (!deposits.length) {
        await ctx.editMessageText('📋 *Setoran Saya*\n\nBelum ada setoran.', { parse_mode: 'Markdown', ...menu() });
        return;
      }
      const status = {
        pending: '⏳ Login', checking: '🔎 Checking', awaiting_session_clear: '🚪 Menunggu logout',
        ready_to_credit: '💳 Siap bayar', credited: '✅ Dibayar', rejected: '❌ Ditolak',
      };
      const lines = deposits.map((d, i) => `${i + 1}. 🆔 ${esc(d.telegramId || '-')} — ${status[d.status] || d.status} — ${String(d.metadata?.nokosStatus || 'fs').toUpperCase()} — ${fmt(d.price)}`);
      await ctx.editMessageText(`📋 *Setoran Saya*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown', ...menu() });
    });

    bot.action(/^seller:check:(.+)$/, async ctx => {
      await ctx.answerCbQuery('🔎 Mengecek sesi...');
      try {
        const deposit = await SellerDeposit.findOne({ _id: ctx.match[1], storeId: ctx.storeId, sellerId: String(ctx.from.id) });
        if (!deposit) return ctx.reply('❌ Setoran tidak ditemukan.');
        if (deposit.walletCredited) return ctx.reply(`✅ Setoran sudah selesai. Saldo ${fmt(deposit.price)} sudah masuk.`);
        const result = await SellerService.finalizeDeposit(deposit._id);
        if (result.credited) {
          await ctx.editMessageText(
            `🎉 *Setoran Selesai*\n\n` +
            `🆔 Telegram ID: \`${esc(result.deposit.telegramId)}\`\n` +
            `📊 Status Spam: ${esc(result.deposit.spamStatus)}\n` +
            ` Status Nokos: *${esc(String(result.deposit.metadata?.nokosStatus || 'fs').toUpperCase())}*\n` +
            `💰 Harga: *${fmt(result.deposit.price)}*\n\n` +
            `✅ Sesi sudah bersih dan akun masuk inventory. Saldo seller sudah ditambahkan.`,
            { parse_mode: 'Markdown', ...menu() }
          );
          return;
        }
        const n = result.check?.nonCurrentSessions ?? result.deposit.nonCurrentSessions ?? '?';
        await ctx.editMessageText(
          `⏳ *Belum Bisa Dibayar*\n\n` +
          `Sistem masih mendeteksi *${n}* perangkat lain.\n\n` +
          `Silakan keluar dari akun Telegram pada perangkat/sesi lain sesuai instruksi, lalu tekan *Cek Sesi* lagi.\n\n` +
          `💰 Saldo belum ditambahkan.`,
          { parse_mode: 'Markdown', ...checkMenu(deposit._id) }
        );
      } catch (err) {
        await ctx.reply(`❌ Gagal cek sesi: ${err.message}`, checkMenu(ctx.match[1]));
      }
    });
  }

  static async handleTextInput(ctx) {
    const flow = ctx.session?.flow;
    const text = ctx.message?.text?.trim();
    if (!flow || !text) return false;

    if (flow === 'seller_phone') {
      const normalized = SellerService.normalizeSellerPhone(text);
      if (!/^\+62\d{7,14}$/.test(normalized)) {
        await ctx.reply(
          `❌ *Nomor tidak valid*\n\n` +
          `Gunakan nomor Indonesia yang valid.\n` +
          `Contoh: \`08123456789\`, \`628123456789\`, atau \`+628123456789\`.`,
          { parse_mode: 'Markdown' }
        );
        return true;
      }
      try {
        await SellerService.startLogin(ctx.storeId, ctx.from.id, normalized);
        ctx.session.flow = 'seller_otp';
        ctx.saveSession();
        await ctx.reply('📩 OTP sudah dikirim. Masukkan kode OTP Telegram:');
      } catch (err) { await ctx.reply(`❌ ${err.message}`); }
      return true;
    }

    if (flow === 'seller_otp') {
      try {
        const result = await SellerService.submitOtp(ctx.storeId, ctx.from.id, text);
        if (result.needsPassword) {
          ctx.session.flow = 'seller_2fa'; ctx.saveSession();
          await ctx.reply('🔐 Akun memakai 2FA. Masukkan password 2FA:');
          return true;
        }
        await this.finishLogin(ctx, result);
      } catch (err) { await ctx.reply(`❌ ${err.message}`); }
      return true;
    }

    if (flow === 'seller_2fa') {
      try {
        const result = await SellerService.submitPassword(ctx.storeId, ctx.from.id, text);
        await this.finishLogin(ctx, result);
      } catch (err) { await ctx.reply(`❌ ${err.message}`); }
      return true;
    }

    if (flow === 'seller_withdraw_bank') {
      ctx.session.withdrawDraft = { bankName: text };
      ctx.session.flow = 'seller_withdraw_account';
      ctx.saveSession();
      await ctx.reply('🏦 Masukkan *nomor rekening*:', { parse_mode: 'Markdown' });
      return true;
    }
    if (flow === 'seller_withdraw_account') {
      if (!/^\d{5,30}$/.test(text)) { await ctx.reply('❌ Nomor rekening harus 5-30 digit.'); return true; }
      ctx.session.withdrawDraft.accountNumber = text;
      ctx.session.flow = 'seller_withdraw_name';
      ctx.saveSession();
      await ctx.reply('👤 Masukkan *nama pemilik rekening*:', { parse_mode: 'Markdown' });
      return true;
    }
    if (flow === 'seller_withdraw_name') {
      if (!/^[A-Za-zÀ-ÿ .'\-]{2,100}$/.test(text)) { await ctx.reply('❌ Nama rekening tidak valid.'); return true; }
      ctx.session.withdrawDraft.accountName = text;
      ctx.session.flow = 'seller_withdraw_amount';
      ctx.saveSession();
      const wallet = await SellerService.getWallet(ctx.storeId, ctx.from.id);
      await ctx.reply(`💰 Masukkan *jumlah penarikan*.\nSaldo tersedia: *${fmt(wallet?.balance || 0)}*`, { parse_mode: 'Markdown' });
      return true;
    }
    if (flow === 'seller_withdraw_amount') {
      const amount = Math.floor(Number(text.replace(/[^\d]/g, '')));
      const wallet = await SellerService.getWallet(ctx.storeId, ctx.from.id);
      if (!Number.isFinite(amount) || amount <= 0) { await ctx.reply('❌ Jumlah tidak valid.'); return true; }
      if (amount > Number(wallet?.balance || 0)) { await ctx.reply(`❌ *Penarikan gagal*\n\n💰 Saldo tersedia: *${fmt(wallet?.balance || 0)}*\n💸 Jumlah penarikan: *${fmt(amount)}*\n\nJumlah penarikan melebihi saldo yang tersedia.`, { parse_mode: 'Markdown' }); return true; }
      try {
        const req = await SellerService.requestWithdrawal(ctx.storeId, ctx.from.id, {
          sellerUsername: ctx.from.username || null,
          bankName: ctx.session.withdrawDraft.bankName,
          accountNumber: ctx.session.withdrawDraft.accountNumber,
          accountName: ctx.session.withdrawDraft.accountName,
          amount,
        });
        ctx.session.flow = null; ctx.session.withdrawDraft = null; ctx.saveSession();
        const heldWallet = await SellerService.getWallet(ctx.storeId, ctx.from.id);
        const adminText =
          `🏦 *PENARIKAN SELLER BARU*\n\n` +
          `👤 Seller: ${ctx.from.username ? '@' + esc(ctx.from.username) : '`' + ctx.from.id + '`'}\n` +
          `🆔 Seller ID: \`${ctx.from.id}\`\n\n` +
          `🏦 Bank: *${esc(req.bankName)}*\n` +
          `💳 No. Rekening: \`${esc(req.accountNumber)}\`\n` +
          `👤 Nama Rekening: *${esc(req.accountName)}*\n\n` +
          `💰 Saldo Seller sebelum: *${fmt(req.balanceAtRequest)}*\n` +
          `💸 Jumlah Penarikan: *${fmt(req.amount)}*\n` +
          `💵 Saldo setelah hold: *${fmt(req.balanceAfterHold)}*\n\n` +
          `⏳ Status: *MENUNGGU APPROVAL*`;
        if (ctx.store?.ownerId) {
          await ctx.telegram.sendMessage(ctx.store.ownerId, adminText, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback(' APPROVE', `owner:wd:approve:${req._id}`)],
              [Markup.button.callback(' TOLAK', `owner:wd:reject:${req._id}`)],
            ]),
          }).catch(() => {});
        }
        await ctx.reply(
          `✅ *Permintaan penarikan dibuat*\n\n` +
          `🏦 Bank: ${esc(req.bankName)}\n` +
          `💳 Rekening: ${esc(req.accountNumber)}\n` +
          `👤 Nama: ${esc(req.accountName)}\n` +
          `💰 Jumlah: *${fmt(req.amount)}*\n\n` +
          `⏳ Status: Menunggu proses admin.\n` +
          `Saldo tersebut sudah ditahan agar tidak bisa ditarik dua kali.`,
          { parse_mode: 'Markdown', ...menu() }
        );
      } catch (err) { await ctx.reply(`❌ ${err.message}`); }
      return true;
    }
    return false;
  }

  static async finishLogin(ctx, result) {
    let spam;
    try {
      spam = await SellerService.checkSpamStatus(result.sessionString);
    } catch (err) {
      await SellerService.logoutSession(result.sessionString).catch(() => {});
      await ctx.reply(
        `❌ *Setoran ditolak*\n\n` +
        `Pengecekan SpamBot wajib dilakukan, tetapi tidak berhasil diselesaikan.\n` +
        `Session bot sudah ditutup dari akun.`,
        { parse_mode: 'Markdown', ...menu() }
      );
      return;
    }

    // Only the exact SpamBot clear message is accepted. Any other response is rejected.
    if (!spam.passed) {
      await SellerService.logoutSession(result.sessionString).catch(() => {});
      if (result.sessionFile) { try { require('fs').unlinkSync(result.sessionFile); } catch {} }
      await AuditLog.log({
        storeId: ctx.storeId, actorId: ctx.from.id, actorType: 'seller',
        action: 'SELLER_ACCOUNT_REJECTED_SPAMBOT', entity: 'SellerDeposit',
        details: { telegramId: result.telegramId, spamStatus: spam.status, spamMessage: spam.message },
        result: 'rejected',
      });
      await ctx.reply(
        `❌ *Setoran Akun Tidak Dapat Diproses*\n\n` +
        `Mohon maaf, akun yang Anda setorkan tidak dapat diterima karena terindikasi tidak memenuhi persyaratan atau terdapat masalah pada akun *(limit)*.\n\n` +
        `Akun tidak dapat diproses lebih lanjut dan *tidak masuk ke inventory*. Saldo setoran juga *tidak ditambahkan*.\n\n` +
        `🔐 Sesi akun bot telah keluar secara otomatis.\n` +
        `─────────────\n` +
        `Silakan gunakan akun lain yang memenuhi persyaratan.`,
        { parse_mode: 'Markdown', ...menu() }
      );
      return;
    }

    let nokosStatus = 'fs';
    let nokosStatusReason = 'legacy_default';
    let nokosStatusDetectedAt = null;
    try {
      const detected = await NokosStatusService.detectNokosStatus(result.sessionString, result.telegramId);
      nokosStatus = detected.status === 'nfs' ? 'nfs' : 'fs';
      nokosStatusReason = detected.reason || 'detected';
      nokosStatusDetectedAt = detected.detectedAt || new Date().toISOString();
    } catch (err) {
      nokosStatus = 'fs';
      nokosStatusReason = 'detection_error_fallback_fs';
    }

    const pricing = await SellerService.determinePrice(ctx.storeId, nokosStatus, result.telegramId);

    // Seller deposit is always auto-routed to the ID-prefix + digit bucket.
    // No manual product selection is required and no unrelated product is used as fallback.
    const product = pricing.product;
    const basePrice = Number(pricing.buyerPrice || product?.price || 0);
    const price = Number(pricing.price || 0);
    const deposit = await SellerDeposit.create({
      storeId: ctx.storeId,
      sellerId: String(ctx.from.id),
      sellerUsername: ctx.from.username || null,
      telegramId: result.telegramId,
      phone: result.phone,
      status: price > 0 ? 'awaiting_session_clear' : 'rejected',
      spamStatus: spam.status,
      spamMessage: spam.message,
      spamCheckedAt: new Date().toISOString(),
      idCategory: pricing.category,
      price,
      productId: product?._id || null,
      productName: product?.name || null,
      sessionFile: result.sessionFile,
      sessionReady: true,
      metadata: { basePrice, priceMultiplier: pricing.multiplier, idPrefix: pricing.idPrefix, idDigits: pricing.idDigits, idKey: `${pricing.idPrefix}:${pricing.idDigits}`, nokosStatus, nokosStatusReason, nokosStatusDetectedAt },
      rejectionReason: price <= 0 ? `Harga seller ${nokosStatus.toUpperCase()} belum dikonfigurasi.` : null,
    });

    ctx.session.flow = null;
    ctx.session.sellerDepositId = String(deposit._id);
    ctx.saveSession();

    await AuditLog.log({
      storeId: ctx.storeId, actorId: ctx.from.id, actorType: 'seller',
      action: 'SELLER_ACCOUNT_CHECKED', entity: 'SellerDeposit', entityId: deposit._id,
      details: { telegramId: result.telegramId, spamStatus: spam.status, nokosStatus, idCategory: pricing.category, price }, result: price > 0 ? 'success' : 'rejected',
    });

    if (price <= 0) {
      await SellerService.logoutSession(result.sessionString).catch(() => {});
      if (result.sessionFile) { try { require('fs').unlinkSync(result.sessionFile); } catch {} }
      await ctx.reply(
        `❌ *Akun belum bisa diterima*\n\n` +
        `🆔 ID: \`${esc(result.telegramId)}\`\n` +
        `📊 Status Spam: *${esc(spam.status)}*\n` +
        ` Status Nokos: *${esc(nokosStatus.toUpperCase())}*\n` +
        `🏷️ Kategori ID: ${esc(pricing.category)}\n\n` +
        `Alasan: ${esc(deposit.rejectionReason)}`,
        { parse_mode: 'Markdown', ...menu() }
      );
      return;
    }

    await ctx.reply(
      `✅ *Akun lolos pengecekan awal*\n\n` +
      `🆔 Telegram ID: \`${esc(result.telegramId)}\`\n` +
      `📊 Status Spam: *${esc(spam.status)}*\n` +
      `🏷️ Kategori ID: *${esc(pricing.category)}*\n` +
      `🔢 Awalan: *${esc(pricing.idPrefix || '-')}* | Digit: *${pricing.idDigits || '-'}*\n` +
      `📦 Produk: ${esc(product?.name || '-') }\n` +
      `💰 Harga seller: *${fmt(price)}*\n\n` +
      `🚪 *Tahap terakhir:* keluar dari akun Telegram pada perangkat/sesi lain sesuai instruksi. Session yang diserahkan ke sistem tetap menjadi session inventory.\n\n` +
      `Setelah selesai, tekan *Cek Sesi*. Saldo hanya masuk jika sistem sudah mendeteksi tidak ada sesi lain.`,
      { parse_mode: 'Markdown', ...checkMenu(deposit._id) }
    );
  }
}

module.exports = SellerHandler;
