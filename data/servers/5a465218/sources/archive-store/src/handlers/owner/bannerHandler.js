'use strict';

const Store = require('../../models/Store');
const AuditLog = require('../../models/AuditLog');
const ownerKeyboard = require('../../keyboards/ownerKeyboard');

class BannerHandler {
  static register(bot) {
    bot.action('owner:banner', async ctx => {
      await ctx.answerCbQuery('🖼️ Pengaturan banner');
      const store = await Store.findOne({ storeId: ctx.storeId });
      const settings = store?.settings || {};
      const active = Boolean(settings.bannerFileId);
      const type = settings.bannerType || (settings.bannerFileId ? 'photo' : null);

      await ctx.editMessageText(
        `<b>🖼️ BANNER STORE</b>\n\n` +
        `Status: <b>${active ? '🟢 Aktif' : '⚪ Belum diset'}</b>\n` +
        (type ? `Tipe: <b>${type}</b>\n` : '') +
        `\nBanner akan tampil di bagian paling atas toko dan tetap dipertahankan saat pesan/menu berganti.`,
        { parse_mode: 'HTML', ...ownerKeyboard.bannerMenu(active) }
      );
    });

    bot.action('owner:banner:set', async ctx => {
      await ctx.answerCbQuery('📤 Kirim banner');
      ctx.session.flow = 'store_banner';
      ctx.saveSession();
      await ctx.editMessageText(
        '🖼️ <b>SET BANNER STORE</b>\n\n' +
        '📤 Kirim <b>1 foto atau GIF</b> sebagai banner toko.\n' +
        '🎞️ GIF akan disimpan sebagai animation dan tetap bergerak di chat.\n\n' +
        'Banner lama akan diganti setelah file baru berhasil disimpan.\n' +
        'Urutan di buyer: <b>Banner → Pesan → Tombol</b>.',
        { parse_mode: 'HTML', ...ownerKeyboard.cancelButton() }
      );
    });

    bot.action('owner:banner:delete', async ctx => {
      await ctx.answerCbQuery('🗑️ Menghapus banner');
      await Store.findOneAndUpdate(
        { storeId: ctx.storeId },
        { $set: {
          'settings.bannerFileId': null,
          'settings.bannerType': null,
          'settings.bannerUrl': null,
        } }
      );
      ctx.session.flow = null;
      ctx.saveSession();

      await AuditLog.log({
        storeId: ctx.storeId,
        actorId: ctx.from.id,
        actorType: 'owner',
        action: 'STORE_BANNER_DELETED',
        entity: 'Store',
        entityId: ctx.storeId,
        details: {},
        result: 'success',
      });

      await ctx.editMessageText(
        '🖼️ <b>BANNER STORE</b>\n\n✅ Banner berhasil dihapus.',
        { parse_mode: 'HTML', ...ownerKeyboard.backButton('owner:banner') }
      );
    });
  }

  static async handleMedia(ctx) {
    if (!ctx.store?.isOwner?.(ctx.from?.id)) return false;
    if (ctx.session?.flow !== 'store_banner') return false;

    const msg = ctx.message || {};
    let fileId = null;
    let bannerType = null;

    if (msg.photo?.length) {
      fileId = msg.photo[msg.photo.length - 1]?.file_id;
      bannerType = 'photo';
    } else if (msg.video?.file_id) {
      fileId = msg.video.file_id;
      bannerType = 'video';
    } else if (msg.animation?.file_id) {
      fileId = msg.animation.file_id;
      bannerType = 'animation';
    }

    if (!fileId) return false;

    await Store.findOneAndUpdate(
      { storeId: ctx.storeId },
      { $set: {
        'settings.bannerFileId': fileId,
        'settings.bannerType': bannerType,
        'settings.bannerUrl': null,
      } }
    );

    ctx.session.flow = null;
    ctx.saveSession();

    await AuditLog.log({
      storeId: ctx.storeId,
      actorId: ctx.from.id,
      actorType: 'owner',
      action: 'STORE_BANNER_SET',
      entity: 'Store',
      entityId: ctx.storeId,
      details: { bannerType },
      result: 'success',
    });

    await ctx.reply(
      `🖼️ <b>BANNER STORE BERHASIL DISIMPAN</b>\n\n` +
      `Tipe: <b>${bannerType}</b>\n\n` +
      `Banner akan tampil di atas pesan dan tombol saat buyer membuka toko.`,
      { parse_mode: 'HTML', ...ownerKeyboard.backButton('owner:banner') }
    );
    return true;
  }
}

module.exports = BannerHandler;
