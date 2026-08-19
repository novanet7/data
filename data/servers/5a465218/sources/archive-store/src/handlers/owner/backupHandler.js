'use strict';

const { Markup } = require('telegraf');
const Backup = require('../../services/backupService');
const SnapshotService = require('../../services/snapshotService');
const SessionService = require('../../services/sessionService');
const Product = require('../../models/Product');
const AuditLog = require('../../models/AuditLog');

function menu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(' Export Portable JSON', 'owner:backup:export')],
    [Markup.button.callback(' Import Portable JSON', 'owner:backup:import')],
    [Markup.button.callback(' Backup Sekarang', 'owner:backup:create')],
    [Markup.button.callback(' Daftar Backup', 'owner:backup:list')],
    [Markup.button.callback(' Hapus Semua Sesi', 'owner:sessions:delete')],
    [Markup.button.callback(' Reset Total (TEST)', 'owner:reset:total')],
    [Markup.button.callback('⬅ Kembali', 'owner:back_main')],
  ]);
}

function deleteConfirmMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(' YA, HAPUS SEMUA', 'owner:sessions:delete:confirm')],
    [Markup.button.callback(' BATAL', 'owner:backup')],
  ]);
}

class BackupHandler {
  static register(bot) {
    bot.action('owner:backup', async ctx => {
      await ctx.answerCbQuery('💾 Membuka backup...');
      await this.show(ctx);
    });

    // EXPORT JSON TERBARU
    bot.action('owner:backup:export', async ctx => {
      try {
        await ctx.answerCbQuery('📤 Membuat Export JSON...');

        const result = await SnapshotService.sendToOwner('manual-export');

        await ctx.reply(
          `✅ <b>EXPORT BERHASIL</b>\n\n` +
          `📄 <code>${result.filename}</code>\n` +
          `📦 Ukuran: <b>${result.size}</b> bytes\n\n` +
          `File JSON sudah dikirim ke Owner.`,
          { parse_mode: 'HTML' }
        );

        await this.show(ctx);
      } catch (err) {
        console.error('[BackupHandler] export gagal:', err);
        await ctx.reply(`❌ Export gagal: ${err.message}`);
      }
    });

    // IMPORT PORTABLE JSON
    bot.action('owner:backup:import', async ctx => {
      await ctx.answerCbQuery('📥 Kirim file JSON...');
      await ctx.reply(
        '📥 <b>IMPORT PORTABLE BACKUP</b>\n\n' +
        'Kirim file <code>.json</code> hasil Export Portable ke chat ini.\n\n' +
        'Backup akan dipulihkan termasuk database, saldo, stok, dan session.',
        { parse_mode: 'HTML' }
      );
      ctx.session = ctx.session || {};
      ctx.session.awaitingPortableImport = true;
    });

    // TERIMA FILE PORTABLE JSON
    bot.on('document', async ctx => {
      try {
        if (!ctx.session?.awaitingPortableImport) return;

        const doc = ctx.message.document;
        if (!doc.file_name?.toLowerCase().endsWith('.json')) {
          return ctx.reply('❌ File harus berformat JSON.');
        }

        ctx.session.awaitingPortableImport = false;

        await ctx.reply('⏳ Memproses portable backup...');

        const link = await ctx.telegram.getFileLink(doc.file_id);
        const https = require('https');

        const buffer = await new Promise((resolve, reject) => {
          https.get(link.href, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
          }).on('error', reject);
        });

        const result = await SnapshotService.restoreSnapshot(buffer);

        await ctx.reply(
          `✅ <b>IMPORT BERHASIL</b>\n\n` +
          `📄 Database: <b>${result.jsonCount}</b> file\n` +
          `📱 Session buyer: <b>${result.sessionCount}</b>\n` +
          `👤 Session seller: <b>${result.sellerSessionCount}</b>\n\n` +
          `🔄 Restart bot/server agar runtime memuat seluruh kondisi hasil restore.`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        console.error('[BackupHandler] portable import gagal:', err);
        ctx.session && (ctx.session.awaitingPortableImport = false);
        await ctx.reply(`❌ Import gagal: ${err.message}`);
      }
    });

    // BACKUP MANUAL
    bot.action('owner:backup:create', async ctx => {
      try {
        await ctx.answerCbQuery('💾 Membuat backup...');

        const backup = await Backup.createBackup('admin_manual');

        const sentBackup = await ctx.replyWithDocument(
          { source: backup.zipPath },
          {
            caption:
              `💾 <b>BACKUP BERHASIL</b>\n\n` +
              `📁 <code>${backup.name}</code>\n` +
              `📦 Database + saldo + session`,
            parse_mode: 'HTML',
          }
        );
        
        // Lindungi pesan ZIP dari pembersihan UI StoreRuntime.
        if (sentBackup?.message_id) {
          ctx.__uiPreserveMessageIds =
            ctx.__uiPreserveMessageIds || new Set();
          ctx.__uiPreserveMessageIds.add(sentBackup.message_id);
        }


        await this.show(ctx);
      } catch (err) {
        await ctx.reply(`❌ Backup gagal: ${err.message}`);
      }
    });

    // LIST BACKUP
    bot.action('owner:backup:list', async ctx => {
      try {
        await ctx.answerCbQuery('📋 Memuat backup...');

        const rows = Backup.listBackups().slice(0, 10);

        if (!rows.length) {
          return ctx.editMessageText(
            '📋 *Backup*\n\nBelum ada backup.',
            { parse_mode: 'Markdown', ...menu() }
          );
        }

        const buttons = [];

        const text = rows
          .map((r, i) =>
            `${i + 1}. ${r.createdAt || r.name}\n   🏷️ ${r.reason}`
          )
          .join('\n\n');

        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          buttons.push([
            Markup.button.callback(
              ` Restore ${i + 1}`,
              `owner:backup:restore:${i}`
            ),
          ]);
        }

        buttons.push(
          [Markup.button.callback(' Refresh', 'owner:backup:list')],
          [Markup.button.callback('⬅ Kembali', 'owner:backup')]
        );

        await ctx.editMessageText(
          ` *Backup Tersedia*\n\n${text}\n\n` +
          `⚠️ Restore akan membuat backup pengaman terlebih dahulu.`,
          {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons },
          }
        );
      } catch (err) {
        await ctx.reply(`❌ Gagal membaca backup: ${err.message}`);
      }
    });

    // RESTORE
    bot.action(/^owner:backup:restore:(\d+)$/, async ctx => {
      try {
        await ctx.answerCbQuery('♻️ Memulihkan backup...');

        const rows = Backup.listBackups().slice(0, 10);
        const index = Number(ctx.match[1]);
        const selected = rows[index];

        if (!selected) {
          throw new Error('Backup tidak ditemukan atau sudah berubah.');
        }

        await Backup.restoreBackup(selected.name);

        await ctx.reply(
          '✅ Database berhasil dipulihkan.\n\n' +
          'Backup sebelum restore juga otomatis dibuat.\n\n' +
          '🔄 Silakan restart bot dari panel/server agar runtime memuat kondisi terbaru.'
        );

        await this.show(ctx);
      } catch (err) {
        await ctx.reply(`❌ Restore gagal: ${err.message}`);
      }
    });

    // RESET TOTAL - KHUSUS TEST BACKUP/RESTORE
    bot.action('owner:reset:total', async ctx => {
      await ctx.answerCbQuery('⚠️ Reset Total');
      await ctx.editMessageText(
        `🧨 <b>RESET TOTAL - TEST BACKUP</b>\n\n` +
        `Ini akan menghapus:\n` +
        `• Semua session buyer/seller\n` +
        `• Semua saldo buyer\n` +
        `• Semua saldo seller\n` +
        `• Semua stok Telegram\n\n` +
        `User, order dan data transaksi tetap ada.\n\n` +
        `⚠️ Pastikan backup sudah berhasil dikirim sebelum lanjut!`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [Markup.button.callback(' YA, RESET TOTAL', 'owner:reset:total:confirm')],
              [Markup.button.callback(' BATAL', 'owner:backup')],
            ],
          },
        }
      );
    });

    bot.action('owner:reset:total:confirm', async ctx => {
      try {
        await ctx.answerCbQuery('⏳ Reset sedang diproses...');

        // Backup terakhir sebelum reset.
        const backup = await SnapshotService.sendToOwner('before-total-reset');

        // Hapus semua session.
        const sessions = await SessionService.clearAllStoredSessions();

        const BuyerWallet = require('../../models/BuyerWallet');
        const SellerWallet = require('../../models/SellerWallet');

        // Nolkan semua saldo pada database JSON.
        await BuyerWallet.resetAllBalances({
          storeId: ctx.storeId,
        });

        await SellerWallet.resetAllBalances({
          storeId: ctx.storeId,
        });

        // Kosongkan stok Telegram.
        const products = await Product.find({
          storeId: ctx.storeId,
          productType: 'telegram_session',
          status: { $ne: 'deleted' },
        });

        for (const product of products) {
          await Product.findOneAndUpdate(
            { _id: product._id, storeId: ctx.storeId },
            { $set: { stockCount: 0, status: 'out_of_stock' } }
          );
        }

        await AuditLog.log({
          storeId: ctx.storeId,
          actorId: ctx.from.id,
          actorType: 'owner',
          action: 'TOTAL_BACKUP_TEST_RESET',
          entity: 'System',
          entityId: null,
          details: {
            removedSessions: sessions.removedCount,
            productsReset: products.length,
            backupFilename: backup.filename,
          },
          result: 'success',
        });

        await ctx.editMessageText(
          `✅ <b>RESET TOTAL BERHASIL</b>\n\n` +
          `🧹 Session: <b>${sessions.removedCount}</b>\n` +
          `💳 Saldo buyer: <b>0</b>\n` +
          `💰 Saldo seller: <b>0</b>\n` +
          `📦 Produk dikosongkan: <b>${products.length}</b>\n\n` +
          `💾 Backup sebelum reset sudah dikirim ke Owner.\n\n` +
          `Sekarang coba <b>Restore</b> backup tadi untuk memastikan saldo, session, dan data kembali.`,
          { parse_mode: 'HTML', ...menu() }
        );
      } catch (err) {
        console.error('[BackupHandler] reset total gagal:', err);
        await ctx.reply(`❌ Reset Total gagal: ${err.message}`);
      }
    });

    // KONFIRMASI HAPUS
    bot.action('owner:sessions:delete', async ctx => {
      await ctx.answerCbQuery('⚠️ Perhatian');

      await ctx.editMessageText(
        `⚠️ <b>HAPUS SEMUA SESI</b>\n\n` +
        `Operasi ini akan:\n` +
        `• Menghapus semua file session Telegram\n` +
        `• Menghapus seller session\n` +
        `• Memutus client Telegram yang aktif\n` +
        `• Mengosongkan stok akun Telegram\n\n` +
        `<b>TIDAK</b> menghapus:\n` +
        `• User\n` +
        `• Saldo\n` +
        `• Order\n` +
        `• Produk\n` +
        `• Pengaturan pembayaran\n\n` +
        `🔐 Backup JSON otomatis dikirim ke Owner sebelum penghapusan.\n\n` +
        `<b>Yakin ingin melanjutkan?</b>`,
        {
          parse_mode: 'HTML',
          ...deleteConfirmMenu(),
        }
      );
    });

    // EKSEKUSI HAPUS
    bot.action('owner:sessions:delete:confirm', async ctx => {
      try {
        await ctx.answerCbQuery('⏳ Backup dan hapus sedang diproses...');

        // 1. BACKUP TERLEBIH DAHULU
        const backup = await SnapshotService.sendToOwner('before-delete-all-sessions');

        // 2. HAPUS SEMUA SESSION
        const result = await SessionService.clearAllStoredSessions();

        // 3. KOSONGKAN STOCK TELEGRAM
        const products = await Product.find({
          storeId: ctx.storeId,
          productType: 'telegram_session',
          status: { $ne: 'deleted' },
        });

        let productsReset = 0;

        for (const product of products) {
          await Product.findOneAndUpdate(
            {
              _id: product._id,
              storeId: ctx.storeId,
              productType: 'telegram_session',
            },
            {
              $set: {
                stockCount: 0,
                status: 'out_of_stock',
              },
            }
          );

          productsReset++;
        }

        // 4. AUDIT LOG
        await AuditLog.log({
          storeId: ctx.storeId,
          actorId: ctx.from.id,
          actorType: 'owner',
          action: 'ALL_TELEGRAM_SESSIONS_DELETED',
          entity: 'Session',
          entityId: null,
          details: {
            removedSessions: result.removedCount,
            failedSessions: result.failedCount,
            productsReset,
            backupFilename: backup.filename,
            backupSize: backup.size,
          },
          result: result.failedCount > 0 ? 'partial' : 'success',
        });

        const status =
          result.failedCount > 0
            ? `⚠️ <b>Selesai sebagian</b>\nGagal menghapus: ${result.failedCount}`
            : `✅ <b>Semua sesi berhasil dihapus</b>`;

        await ctx.editMessageText(
          `${status}\n\n` +
          `🧹 Session dihapus: <b>${result.removedCount}</b>\n` +
          `📦 Produk dikosongkan: <b>${productsReset}</b>\n\n` +
          `💾 Backup pengaman:\n` +
          `<code>${backup.filename}</code>\n\n` +
          `📌 Backup sudah dikirim ke Owner sebelum penghapusan.`,
          {
            parse_mode: 'HTML',
            ...menu(),
          }
        );
      } catch (err) {
        console.error('[BackupHandler] delete sessions gagal:', err);

        await ctx.reply(
          `❌ <b>GAGAL MENGHAPUS SESI</b>\n\n` +
          `${String(err.message || err)}`,
          { parse_mode: 'HTML' }
        );
      }
    });
  }

  static async show(ctx) {
    const rows = Backup.listBackups().slice(0, 3);

    const last = rows.length
      ? rows
          .map(r => `• ${r.createdAt || r.name} — ${r.reason}`)
          .join('\n')
      : 'Belum ada backup.';

    await ctx
      .editMessageText(
        `💾 *Backup & Recovery*\n\n` +
        `Backup berkala aktif.\n` +
        `Export JSON dapat dikirim langsung ke Owner.\n` +
        `Backup otomatis dibuat sebelum penghapusan sesi.\n\n` +
        `*Backup terbaru:*\n${last}`,
        {
          parse_mode: 'Markdown',
          ...menu(),
        }
      )
      .catch(async () => {
        await ctx.reply(
          `💾 *Backup & Recovery*\n\n` +
          `Backup terbaru:\n${last}`,
          {
            parse_mode: 'Markdown',
            ...menu(),
          }
        );
      });
  }
}

module.exports = BackupHandler;
