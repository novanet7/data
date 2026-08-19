'use strict';

const Store = require('../../models/Store');
const AuditLog = require('../../models/AuditLog');
const ownerKeyboard = require('../../keyboards/ownerKeyboard');

class WelcomeHandler {
  static register(bot) {
    bot.action('owner:welcome', async ctx => {
      await ctx.answerCbQuery('👋 Pengaturan welcome');
      const store = await Store.findOne({ storeId: ctx.storeId });
      const active = Boolean(store?.settings?.welcomeStickerFileId);
      await ctx.editMessageText(
        `<b>✦ WELCOME SETTINGS</b>\n\n` +
        `Sticker welcome: <b>${active ? '🟢 Aktif' : '⚪ Belum diset'}</b>\n\n` +
        `Sticker akan tampil saat /start dan otomatis dihapus setelah 5 detik.`,
        { parse_mode: 'HTML', ...ownerKeyboard.welcomeMenu(active) }
      );
    });

    bot.action('owner:welcome:set_sticker', async ctx => {
      await ctx.answerCbQuery('📎 Kirim sticker welcome');
      ctx.session.flow = 'welcome_sticker';
      ctx.saveSession();
      await ctx.editMessageText(
        '👋 <b>SET WELCOME STICKER</b>\n\n📤 Kirim <b>1 sticker</b> di chat ini.\n\n👋 Sticker lama akan diganti setelah sticker baru berhasil disimpan.',
        { parse_mode: 'HTML', ...ownerKeyboard.cancelButton() }
      );
    });

    bot.action('owner:welcome:delete_sticker', async ctx => {
      await ctx.answerCbQuery('🗑️ Menghapus sticker');
      await Store.findOneAndUpdate({ storeId: ctx.storeId }, { $set: { 'settings.welcomeStickerFileId': null } });
      ctx.session.flow = null;
      ctx.saveSession();
      await AuditLog.log({
        storeId: ctx.storeId, actorId: ctx.from.id, actorType: 'owner',
        action: 'WELCOME_STICKER_DELETED', entity: 'Store', entityId: ctx.storeId,
        details: {}, result: 'success',
      });
      await ctx.editMessageText('👋 <b>WELCOME STICKER</b>\n\n❌ Sticker welcome sudah dihapus.', { parse_mode: 'HTML', ...ownerKeyboard.backButton('owner:welcome') });
    });
  }

  static async handleSticker(ctx) {
    if (ctx.session?.flow !== 'welcome_sticker' || !ctx.store?.isOwner?.(ctx.from?.id)) return false;
    const fileId = ctx.message?.sticker?.file_id;
    if (!fileId) return false;
    await Store.findOneAndUpdate({ storeId: ctx.storeId }, { $set: { 'settings.welcomeStickerFileId': fileId } });
    ctx.session.flow = null;
    ctx.saveSession();
    await AuditLog.log({
      storeId: ctx.storeId, actorId: ctx.from.id, actorType: 'owner',
      action: 'WELCOME_STICKER_SET', entity: 'Store', entityId: ctx.storeId,
      details: { fileId }, result: 'success',
    });
    await ctx.reply('👋 <b>WELCOME STICKER BERHASIL DISIMPAN</b>\n\n📤 Sticker akan tampil selama 5 detik saat user menjalankan /start.', {
      parse_mode: 'HTML', ...ownerKeyboard.backButton('owner:welcome'),
    });
    return true;
  }
}

module.exports = WelcomeHandler;
