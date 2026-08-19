'use strict';

const { Markup } = require('telegraf');
const SellerWithdrawal = require('../../models/SellerWithdrawal');
const SellerService = require('../../services/sellerService');

function fmt(n) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(n || 0);
}
function safe(t) { return String(t || '-').replace(/[_*`\[\]()~>#+=|{}.!-]/g, '\\$&'); }

function menu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(' Penarikan Pending', 'owner:seller_withdrawals')],
    [Markup.button.callback('⬅ Kembali', 'owner:back_main')],
  ]);
}

class WithdrawalHandler {
  static register(bot) {
    bot.action('owner:seller_withdrawals', async ctx => {
      try {
        await ctx.answerCbQuery();
        const rows = await SellerWithdrawal.find({ storeId: ctx.storeId, status: 'pending' }).sort({ createdAt: -1 }).limit(20);
        if (!rows.length) {
          await ctx.editMessageText('🏦 *Penarikan Seller*\n\nTidak ada penarikan yang menunggu.', { parse_mode: 'Markdown', ...menu() });
          return;
        }

        const text = rows.map((r, i) =>
          `${i + 1}. 👤 \`${safe(r.sellerId)}\`\n` +
          `🏦 Bank: *${safe(r.bankName)}*\n` +
          `💳 Rekening: \`${safe(r.accountNumber)}\`\n` +
          `👤 Nama: *${safe(r.accountName)}*\n` +
          `💰 Jumlah: *${fmt(r.amount)}*\n` +
          `💵 Saldo setelah hold: *${fmt(r.balanceAfterHold || 0)}*`
        ).join('\n\n');

        const buttons = [];
        for (const r of rows) {
          buttons.push([Markup.button.callback(` Transfer ${fmt(r.amount)}`, `owner:wd:approve:${r._id}`)]);
          buttons.push([Markup.button.callback(' Tolak & Kembalikan Saldo', `owner:wd:reject:${r._id}`)]);
        }
        buttons.push([Markup.button.callback(' Refresh', 'owner:seller_withdrawals')]);
        buttons.push([Markup.button.callback('⬅ Kembali', 'owner:back_main')]);

        await ctx.editMessageText(` *Penarikan Seller Pending*\n\n${text}`, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons },
        });
      } catch (err) {
        await ctx.reply(`❌ Gagal membuka penarikan seller: ${err.message}`).catch(() => {});
      }
    });

    bot.action(/^owner:wd:approve:(.+)$/, async ctx => {
      try {
        await ctx.answerCbQuery();
        const r = await SellerService.approveWithdrawal(ctx.storeId, ctx.match[1], ctx.from.id);
        await ctx.editMessageText(
          `✅ *Penarikan disetujui*\n\n💰 ${fmt(r.amount)}\n🏦 ${safe(r.bankName)}\n💳 ${safe(r.accountNumber)}\n\nTransfer bank harus sudah benar-benar dilakukan.`,
          { parse_mode: 'Markdown', ...menu() }
        );
      } catch (err) {
        await ctx.reply(`❌ ${err.message}`).catch(() => {});
      }
    });

    bot.action(/^owner:wd:reject:(.+)$/, async ctx => {
      try {
        await ctx.answerCbQuery();
        await SellerService.rejectWithdrawal(ctx.storeId, ctx.match[1], ctx.from.id, 'Ditolak admin');
        await ctx.editMessageText('❌ *Penarikan ditolak*\n\nSaldo seller sudah dikembalikan ke wallet.', { parse_mode: 'Markdown', ...menu() });
      } catch (err) {
        await ctx.reply(`❌ ${err.message}`).catch(() => {});
      }
    });
  }
}

module.exports = WithdrawalHandler;
