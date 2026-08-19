'use strict';

function escapeMd(t) { return t ? String(t).replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&') : ''; }

const buyerKeyboard = require('../../keyboards/buyerKeyboard');
const logger = require('../../utils/logger');
const MessageFormatter = require('../../utils/messageFormatter');

class StartHandler {
  static register(bot) {

    bot.start(async (ctx) => {
      try {
        const store = ctx.store;

        if (!store) {
          await ctx.reply('🏪 Toko tidak ditemukan atau sedang tidak tersedia. Coba lagi nanti.');
          return;
        }

        if (store.settings?.maintenanceMode && !store.isOwner?.(ctx.from.id)) {
          await ctx.reply('🔧 Toko sedang dalam maintenance. Coba lagi nanti.');
          return;
        }

        // ── Owner → panel owner ─────────────────────────────────────────────
        if (store.isOwner?.(ctx.from.id)) {
          const ownerKeyboard = require('../../keyboards/ownerKeyboard');
          const username = ctx.from?.username || String(ctx.from?.first_name || 'Owner');
          await ctx.reply(
            MessageFormatter.menuScreen('👋 WELCOME TO MY STORE', [
                                      `Senang melihat kamu kembali, @${username}.`,
                                      '',
                                      '📤 Kelola toko dan semua kebutuhanmu dengan mudah melalui menu yang tersedia.',
                                      '',
                                      '👋 Pilih menu di bawah untuk mulai mengelola toko.',
                                    ]),
            { parse_mode: 'HTML', ...ownerKeyboard.mainMenu() }
          );
          return;
        }

        // ── Buyer: langsung ke toko, tanpa pilihan tema ─────────────────────
        const stickerId = store.settings?.welcomeStickerFileId;
        if (stickerId) {
          try {
            const sticker = await ctx.replyWithSticker(stickerId);
            if (sticker?.message_id) {
              ctx.__uiPreserveMessageIds = ctx.__uiPreserveMessageIds || new Set();
              ctx.__uiPreserveMessageIds.add(sticker.message_id);
              setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, sticker.message_id).catch(() => {}), 5000).unref?.();
            }
          } catch (err) {
            logger.warn('[StartHandler] welcome sticker failed:', err.message);
          }
        }
        // Fresh /start: remove the previous banner so every /start gets a new one.
        // Missing/deleted messages are ignored so this can never break /start.
        if (ctx.session?.bannerMessageId && ctx.chat?.id) {
          const previousBannerId = Number(ctx.session.bannerMessageId);
          if (Number.isInteger(previousBannerId) && previousBannerId > 0) {
            try {
              await ctx.telegram.deleteMessage(ctx.chat.id, previousBannerId);
            } catch (err) {
              logger.warn('[StartHandler] previous banner delete skipped:', err?.message || err);
            }
          }
          ctx.session.bannerMessageId = null;
          ctx.saveSession?.();
        }

        const ShopHandler = require('./shopHandler');
        await ShopHandler.showShopMenu(ctx, { freshStart: true });

      } catch (err) {
        logger.error(`[StartHandler] /start error: ${err?.stack || err?.message || err}`);
        try { await ctx.reply('❌ Terjadi kesalahan. Coba ketik /start lagi.'); } catch {}
      }
    });

    // ── /menu command ───────────────────────────────────────────────────────
    bot.command('menu', async (ctx) => {
      const store = ctx.store;
      if (!store) { await ctx.reply('🏪 Toko tidak tersedia.'); return; }

      if (store.isOwner?.(ctx.from.id)) {
        const ownerKeyboard = require('../../keyboards/ownerKeyboard');
        await ctx.reply(
          MessageFormatter.menuScreen('PANEL OWNER', [
            `Welcome back, @${ctx.from?.username || String(ctx.from?.first_name || 'Owner')}.`,
            '',
            'Panel pengelolaan toko tersedia di bawah.',
          ]),
          { parse_mode: 'HTML', ...ownerKeyboard.mainMenu() }
        );
        return;
      }

      const ShopHandler = require('./shopHandler');
      await ShopHandler.showShopMenu(ctx);
    });

    // ── /admin command ──────────────────────────────────────────────────────
    bot.command(['admin', 'ownerpanel'], async (ctx) => {
      const store = ctx.store;
      if (!store) return;
      if (!store.isOwner?.(ctx.from.id)) {
        await ctx.reply('❌ Kamu bukan owner toko ini.');
        return;
      }
      const ownerKeyboard = require('../../keyboards/ownerKeyboard');
      await ctx.reply(
        MessageFormatter.menuScreen('PANEL OWNER', [
          `Hai welcome,elu lagi bae @${ctx.from?.username || String(ctx.from?.first_name || 'Owner')}.`,
          '',
          'pilihan tombol di bawah ya manis pilih mana hayo.',
        ]),
        { parse_mode: 'HTML', ...ownerKeyboard.mainMenu() }
      );
    });

    // ── /help ───────────────────────────────────────────────────────────────
    bot.help(async (ctx) => {
      const store = ctx.store;
      const support = store?.settings?.supportContact;
      await ctx.reply(
        MessageFormatter.menuScreen('BANTUAN', [
          'Ketik /start untuk membuka toko.',
          '',
          support ? `💬 Support: ${support}` : 'Jika membutuhkan bantuan,gada yg punya lagi badmood jualan.',
        ]),
        { parse_mode: 'HTML' }
      );
    });
  }
}

module.exports = StartHandler;
