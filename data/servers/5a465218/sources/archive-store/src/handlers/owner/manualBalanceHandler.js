'use strict';

const { Markup } = require('telegraf');
const BuyerWallet = require('../../models/BuyerWallet');
const adminBalanceService = require('../../services/adminBalanceService');

function fmt(n) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(n || 0);
}

class ManualBalanceHandler {
  static register(bot) {
    bot.action('owner:manual_balance', async ctx => {
      await ctx.answerCbQuery();
      ctx.session.flow = 'admin_manual_balance_user';
      ctx.saveSession();
      await ctx.editMessageText(
        '➕ *Tambah Saldo Manual*\n\nMasukkan *User ID Telegram* buyer:',
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(' Batal', 'owner:cancel')]]) }
      );
    });

    bot.action('owner:manual_balance_history', async ctx => {
      try {
        await ctx.answerCbQuery();
        const AuditLog = require('../../models/AuditLog');
        const rows = await AuditLog.find({ storeId: ctx.storeId, action: 'ADMIN_MANUAL_BALANCE_CREDIT' }).sort({ createdAt: -1 }).limit(10);
        const text = rows.length
          ? rows.map((r, i) => `${i + 1}. 👤 \`${String(r.details?.userId || '-').replace(/`/g, '')}\` — ${fmt(r.details?.amount || 0)} — ${new Date(r.createdAt).toLocaleString('id-ID')}`).join('\n')
          : 'Belum ada penambahan saldo manual.';
        await ctx.editMessageText(` *Riwayat Tambah Saldo Manual*\n\n${text}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅ Kembali', callback_data: 'owner:back_main' }]] } });
      } catch (err) {
        await ctx.reply(`❌ Gagal membuka riwayat saldo: ${err.message}`).catch(() => {});
      }
    });
  }

  static async handleTextInput(ctx) {
    const flow = ctx.session?.flow;
    const text = String(ctx.message?.text || '').trim();
    if (!flow || !text) return false;

    if (flow === 'admin_manual_balance_user') {
      if (!/^\d{3,20}$/.test(text)) { await ctx.reply('❌ User ID tidak valid. Masukkan ID Telegram berupa angka.'); return true; }
      const wallet = await BuyerWallet.getOrCreate(ctx.storeId, text);
      ctx.session.manualBalance = { userId: text, beforeBalance: Number(wallet.balance || 0) };
      ctx.session.flow = 'admin_manual_balance_amount';
      ctx.saveSession();
      await ctx.reply(`💰 Saldo buyer saat ini: *${fmt(wallet.balance)}*\n\nMasukkan nominal yang ingin ditambahkan:`, { parse_mode: 'Markdown' });
      return true;
    }

    if (flow === 'admin_manual_balance_amount') {
      const amount = Math.floor(Number(text.replace(/[^\d]/g, '')));
      if (!Number.isSafeInteger(amount) || amount <= 0) { await ctx.reply('❌ Nominal tidak valid.'); return true; }
      const draft = ctx.session.manualBalance;
      if (!draft?.userId) { ctx.session.flow = null; ctx.saveSession(); await ctx.reply('❌ Sesi admin sudah habis.'); return true; }
      const after = draft.beforeBalance + amount;
      ctx.session.manualBalance.amount = amount;
      ctx.session.flow = 'admin_manual_balance_confirm';
      ctx.saveSession();
      await ctx.reply(
        `⚠️ *KONFIRMASI TAMBAH SALDO*\n\n` +
        `👤 User ID: \`${draft.userId}\`\n` +
        `💰 Saldo saat ini: *${fmt(draft.beforeBalance)}*\n` +
        `➕ Tambahan: *${fmt(amount)}*\n` +
        `💵 Saldo setelahnya: *${fmt(after)}*`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(' TAMBAH SALDO', 'owner:manual_balance_confirm')], [Markup.button.callback(' Batal', 'owner:cancel')]]) }
      );
      return true;
    }
    return false;
  }

  static async confirm(ctx, bot) {
    const draft = ctx.session?.manualBalance;
    if (!draft?.userId || !draft.amount) throw new Error('Data penambahan saldo tidak lengkap.');
    const result = await adminBalanceService.credit({ storeId: ctx.storeId, adminId: ctx.from.id, userId: draft.userId, amount: draft.amount });
    ctx.session.flow = null; ctx.session.manualBalance = null; ctx.saveSession();
    await ctx.editMessageText(
      `✅ *Saldo berhasil ditambahkan*\n\n👤 User ID: \`${draft.userId}\`\n➕ Tambahan: *${fmt(result.amount)}*\n💰 Saldo sekarang: *${fmt(result.afterBalance)}*`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅ Panel Admin', callback_data: 'owner:back_main' }]] } }
    );
    try {
      await bot.telegram.sendMessage(String(draft.userId), `💰 *Saldo Bertambah*\n\nAdmin menambahkan *${fmt(result.amount)}* ke saldo kamu.\n\n💳 Saldo sekarang: *${fmt(result.afterBalance)}*`, { parse_mode: 'Markdown' });
    } catch {}
  }
}

module.exports = ManualBalanceHandler;
