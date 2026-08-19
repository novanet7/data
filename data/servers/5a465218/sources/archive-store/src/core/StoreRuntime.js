'use strict';

const { sessionMiddleware } = require('../middleware/sessionManager');
const storeContextMiddleware = require('../middleware/storeContext');
const { rateLimitMiddleware } = require('../middleware/rateLimiter');
const errorHandler = require('../middleware/errorHandler');

const StartHandler = require('../handlers/buyer/startHandler');
const ShopHandler = require('../handlers/buyer/shopHandler');
const CheckoutHandler = require('../handlers/buyer/checkoutHandler');
const TopupHandler = require('../handlers/buyer/topupHandler');
const { ProductHandler, registerConfirmAddProduct } = require('../handlers/owner/productHandler');
const SessionRestockHandler = require('../handlers/owner/sessionRestockHandler');
const PaymentSettingsHandler = require('../handlers/owner/paymentSettingsHandler');
const OwnerPaymentVerifyHandler = require('../handlers/common/ownerPaymentVerify');
const CustomEmojiHandler = require('../handlers/owner/customEmojiHandler');
const SellerHandler = require('../handlers/sellerHandler');
const SellerSettingsHandler = require('../handlers/owner/sellerSettingsHandler');
const WithdrawalHandler = require('../handlers/owner/withdrawalHandler');
const IdPricingHandler = require('../handlers/owner/idPricingHandler');
const ManualBalanceHandler = require('../handlers/owner/manualBalanceHandler');
const BackupHandler = require('../handlers/owner/backupHandler');
const BroadcastHandler = require('../handlers/owner/broadcastHandler');
const WelcomeHandler = require('../handlers/owner/welcomeHandler');
const BannerHandler = require('../handlers/owner/bannerHandler');
const OrderTrackingHandler = require('../handlers/owner/orderTrackingHandler');
const TelePremiumBuyerHandler = require('../handlers/buyer/telePremiumHandler');
const TelePremiumAdminHandler = require('../handlers/owner/telePremiumAdminHandler');
const logger = require('../utils/logger');
const callbackToast = require('../utils/callbackToast');
const SubscriptionGate = require('../middleware/subscriptionGate');
const { normalizeTelegramText, applyCustomEmojiIconsToReplyMarkup } = require('../utils/messageFormatter');

const UI_FORMAT_PATCH = Symbol.for('valqenix.uiFormatPatch.v1');

// Telegram bot API sends that bypass ctx.reply/editMessageText are normalized here
// as well, so notifications, direct service messages, and handler replies use the
// same compact blockquote UI. Already-formatted HTML blockquotes are left intact.
const toHtmlBlockquoteGlobal = (text, parseMode = '') => normalizeTelegramText(text, parseMode);
const decorateReplyMarkupGlobal = markup => applyCustomEmojiIconsToReplyMarkup(markup);

function patchTelegramUi(telegram) {
  if (!telegram || telegram[UI_FORMAT_PATCH]) return;

  const isPremiumEmojiUnsupportedError = err => {
    const code = Number(err?.response?.error_code || err?.response?.errorCode || err?.code || 0);
    const message = String(err?.response?.description || err?.description || err?.message || '').toLowerCase();
    return code === 400 && (
      message.includes('icon_custom_emoji_id') ||
      message.includes('custom emoji') ||
      message.includes('custom_emoji_id')
    );
  };

  const callWithCustomEmojiFallback = async (original, args, optionsIndex, originalReplyMarkup, preparedOptions) => {
    try {
      return await original(...args);
    } catch (err) {
      // Telegram can reject custom-emoji button icons when the bot/account
      // cannot use them. In that case transparently retry the exact same
      // request with the original Unicode emoji labels. No user-visible error.
      if (!originalReplyMarkup || !isPremiumEmojiUnsupportedError(err)) throw err;

      const fallbackOptions = { ...preparedOptions, reply_markup: originalReplyMarkup };
      const retryArgs = [...args];
      retryArgs[optionsIndex] = fallbackOptions;
      return original(...retryArgs);
    }
  };

  const patchTextMethod = (method, textIndex, optionsIndex) => {
    const original = telegram[method]?.bind(telegram);
    if (!original) return;
    telegram[method] = async (...args) => {
      const sourceOptions = { ...(args[optionsIndex] || {}) };
      const originalReplyMarkup = sourceOptions.reply_markup;
      const opts = { ...sourceOptions };
      if (opts.reply_markup) opts.reply_markup = decorateReplyMarkupGlobal(opts.reply_markup);
      if (typeof args[textIndex] === 'string') {
        args[textIndex] = normalizeTelegramText(args[textIndex], opts.parse_mode || '');
        opts.parse_mode = 'HTML';
      }
      args[optionsIndex] = opts;
      return callWithCustomEmojiFallback(original, args, optionsIndex, originalReplyMarkup, opts);
    };
  };

  patchTextMethod('sendMessage', 1, 2);
  patchTextMethod('editMessageText', 3, 4);

  for (const method of ['sendPhoto', 'sendVideo', 'sendAnimation', 'sendDocument', 'sendAudio']) {
    const original = telegram[method]?.bind(telegram);
    if (!original) continue;
    telegram[method] = async (...args) => {
      const optionsIndex = 2;
      const sourceOptions = { ...(args[optionsIndex] || {}) };
      const originalReplyMarkup = sourceOptions.reply_markup;
      const opts = { ...sourceOptions };
      if (opts.reply_markup) opts.reply_markup = decorateReplyMarkupGlobal(opts.reply_markup);
      if (typeof opts.caption === 'string') {
        opts.caption = normalizeTelegramText(opts.caption, opts.parse_mode || '');
        opts.parse_mode = 'HTML';
      }
      args[optionsIndex] = opts;
      return callWithCustomEmojiFallback(original, args, optionsIndex, originalReplyMarkup, opts);
    };
  }

  Object.defineProperty(telegram, UI_FORMAT_PATCH, { value: true, enumerable: false, configurable: false });
}

class StoreRuntime {
  static async registerHandlers(bot, storeDoc) {
    patchTelegramUi(bot.telegram);
    bot.use(rateLimitMiddleware);

    // Prevent rapid/double callback clicks. The lock lasts for the whole
    // handler execution, so approve/pay/refund actions cannot run twice
    // concurrently from repeated taps.
    const inFlight = new Set();
    const recent = new Map();
    const recentAny = new Map();
    const cleanupLocks = () => {
      const cutoff = Date.now() - 10_000;
      for (const [k, ts] of recent) if (ts < cutoff) recent.delete(k);
      for (const [k, ts] of recentAny) if (ts < cutoff) recentAny.delete(k);
    };
    const lockCleanupTimer = setInterval(cleanupLocks, 60_000);
    lockCleanupTimer.unref?.();
    bot.use(async (ctx, next) => {
      if (!ctx.callbackQuery) return next();
      const userKey = `${ctx.storeId}:${ctx.from?.id}`;
      const key = `${userKey}:${ctx.callbackQuery.data}`;
      const now = Date.now();

      // Global anti-spam guard: every inline button is rate-limited, even
      // when the user taps different buttons in rapid succession. This is
      // intentionally short so normal navigation still feels responsive.
      const lastAny = recentAny.get(userKey) || 0;
      if (now - lastAny < 350) {
        await ctx.answerCbQuery('⚠️ Jangan klik terlalu cepat.', { show_alert: false }).catch(() => {});
        return;
      }
      recentAny.set(userKey, now);

      if (inFlight.has(key)) {
        await ctx.answerCbQuery('⏳ Aksi masih diproses, tunggu sebentar...', { show_alert: false }).catch(() => {});
        return;
      }
      const last = recent.get(key) || 0;
      if (now - last < 1200) {
        await ctx.answerCbQuery('⚠️ Jangan klik terlalu cepat.', { show_alert: false }).catch(() => {});
        return;
      }
      recent.set(key, now);
      inFlight.add(key);
      try { return await next(); } finally { inFlight.delete(key); }
    });
    bot.use(sessionMiddleware);
    bot.use(storeContextMiddleware);

    // Mandatory channel subscription gate. Owners are exempt; all other users
    // must join the configured channel and pass the verification button before
    // any buyer/seller/admin flow can continue.
    SubscriptionGate.register(bot);

    // Give every inline-button click a Telegram toast at the top. Existing
    // handlers are allowed to provide their own more specific toast; this
    // middleware only fills the gap so buttons never feel unresponsive.
    bot.use(async (ctx, next) => {
      if (!ctx.callbackQuery) return next();

      let answered = false;
      let failed = false;
      const originalAnswer = ctx.answerCbQuery.bind(ctx);
      ctx.answerCbQuery = async (...args) => {
        answered = true;
        // Many handlers intentionally call answerCbQuery() with an empty
        // string just to remove Telegram's loading spinner. Convert that
        // empty acknowledgement into a visible top-of-chat toast.
        if (!args.length || args[0] === undefined || args[0] === '') {
          args = [callbackToast(ctx.callbackQuery?.data), ...(args.length > 1 ? [args[1]] : [])];
        }
        return originalAnswer(...args);
      };

      try {
        await next();
      } catch (err) {
        failed = true;
        throw err;
      } finally {
        if (!answered && !failed) {
          await originalAnswer(callbackToast(ctx.callbackQuery?.data)).catch(() => {});
        }
      }
    });

    // Protect every owner-only callback at the runtime boundary.
    // Buttons are not an authorization mechanism: callback_data can be forged.
    bot.use(async (ctx, next) => {
      const data = String(ctx.callbackQuery?.data || '');
      // Only callbacks that are actually owner/admin actions are protected here.
      // Buyer payment callbacks (pay:method, pay:upload_proof) and the buyer
      // session completion callback must remain accessible to the buyer.
      const ownerOnly =
        data.startsWith('owner:') ||
        data.startsWith('ptype:') ||
        data.startsWith('restock:') ||
        data === 'pay:qris' ||
        data === 'pay:valqenix' ||
        data === 'pay:toggle_both' ||
        data.startsWith('session:login_tg:') ||
        data.startsWith('confirm:delete_product:');
      if (ownerOnly && !ctx.store?.isOwner?.(ctx.from?.id)) {
        if (ctx.callbackQuery) await ctx.answerCbQuery('❌ Hanya admin/owner.', { show_alert: true }).catch(() => {});
        return;
      }
      return next();
    });

    // Compact UI: keep one active bot message per user. When a button creates
    // a new bot message, the previous bot UI message is removed after the
    // handler finishes. User-entered messages (numbers, OTP, account input,
    // etc.) are never deleted by this middleware.
    const activeUi = new Map();
    const uiKey = ctx => `${ctx.storeId || 'main'}:${ctx.chat?.id || ctx.from?.id || 'unknown'}`;
    const rememberUiMessage = (ctx, msg) => {
      if (msg?.message_id) {
        ctx.__uiNewMessageIds = ctx.__uiNewMessageIds || new Set();
        ctx.__uiNewMessageIds.add(msg.message_id);
      }
      return msg;
    };

    const toHtmlBlockquote = (text, parseMode = '') => normalizeTelegramText(text, parseMode);

    bot.use(async (ctx, next) => {
      const isUiMessage = name => /^reply(?:WithPhoto|WithVideo|WithAnimation|WithDocument|WithAudio)?$/.test(name) || name === 'reply';
      const originals = {};
      const names = ['reply','replyWithPhoto','replyWithVideo','replyWithAnimation','replyWithDocument','replyWithAudio','replyWithSticker'];
      for (const name of names) {
        if (typeof ctx[name] !== 'function') continue;
        originals[name] = ctx[name].bind(ctx);
        ctx[name] = async (...args) => {
          // Keep inbound/input messages untouched: these are bot-send methods only.
          if (name === 'reply' && typeof args[0] === 'string') {
            const opts = { ...(args[1] || {}) };
            if (opts.reply_markup) opts.reply_markup = decorateReplyMarkupGlobal(opts.reply_markup);
            if (typeof args[0] === 'string') {
              args[0] = toHtmlBlockquote(args[0], opts.parse_mode || '');
              opts.parse_mode = 'HTML';
              args[1] = opts;
            }
          } else if (args[1]?.caption && typeof args[1].caption === 'string') {
            const opts = { ...args[1] };
            if (opts.reply_markup) opts.reply_markup = decorateReplyMarkupGlobal(opts.reply_markup);
            opts.caption = toHtmlBlockquote(opts.caption, opts.parse_mode || '');
            opts.parse_mode = 'HTML';
            args[1] = opts;
          }
const msg = await originals[name](...args);
          return rememberUiMessage(ctx, msg);
        };
      }

      const originalEdit = typeof ctx.editMessageText === 'function' ? ctx.editMessageText.bind(ctx) : null;
      if (originalEdit) {
        ctx.editMessageText = async (text, options = {}) => {
          let opts = { ...options };
          if (opts.reply_markup) opts.reply_markup = decorateReplyMarkupGlobal(opts.reply_markup);
          let value = text;
          if (typeof value === 'string') {
            value = toHtmlBlockquote(value, opts.parse_mode || '');
            opts.parse_mode = 'HTML';
          }
          const msg = await originalEdit(value, opts);
          const id = ctx.callbackQuery?.message?.message_id;
          if (id) {
            ctx.__uiNewMessageIds = ctx.__uiNewMessageIds || new Set();
            ctx.__uiNewMessageIds.add(id);
          }
          return msg;
        };
      }

      const key = uiKey(ctx);
      const previous = activeUi.get(key);
      try {
        await next();
      } finally {
        const currentId = ctx.callbackQuery?.message?.message_id || null;
        const created = [...(ctx.__uiNewMessageIds || [])];
        const keep = created.length ? created[created.length - 1] : currentId || previous || null;
        if (keep) activeUi.set(key, keep);

        // Remove the previous screen and any extra bot messages produced by
        // the same action. Keep only the newest screen. Incoming user text
        // (numbers, OTP, account credentials, etc.) is never touched.
        if (ctx.chat?.id) {
          const preserved = ctx.__uiPreserveMessageIds || new Set();
          if (ctx.session?.bannerMessageId) preserved.add(Number(ctx.session.bannerMessageId));
          const stale = new Set([...(previous ? [previous] : []), ...created.slice(0, -1)]);
          for (const id of preserved) stale.delete(id);
          if (currentId && currentId !== keep && !created.includes(currentId)) stale.add(currentId);
          stale.delete(keep);
          for (const messageId of stale) {
            await ctx.telegram.deleteMessage(ctx.chat.id, messageId).catch(() => {});
          }
        }
      }
    });

    StartHandler.register(bot);
    ShopHandler.register(bot);
    CheckoutHandler.register(bot);
    TopupHandler.register(bot);

    ProductHandler.register(bot);
    registerConfirmAddProduct(bot);
    SessionRestockHandler.register(bot);
    PaymentSettingsHandler.register(bot);
    OwnerPaymentVerifyHandler.register(bot);
    CustomEmojiHandler.register(bot);
    SellerHandler.register(bot);
    SellerSettingsHandler.register(bot);
    WithdrawalHandler.register(bot);
    IdPricingHandler.register(bot);
    ManualBalanceHandler.register(bot);
    BackupHandler.register(bot);
    BroadcastHandler.register(bot);
    WelcomeHandler.register(bot);
    BannerHandler.register(bot);
    OrderTrackingHandler.register(bot);
    TelePremiumBuyerHandler.register(bot);
    TelePremiumAdminHandler.register(bot);
    bot.action('owner:manual_balance_confirm', async ctx => {
      await ctx.answerCbQuery('⏳ Memproses...');
      try { await ManualBalanceHandler.confirm(ctx, bot); } catch (err) { await ctx.reply(`❌ ${err.message}`); }
    });

    bot.on('text', async ctx => {
      if (!ctx.store) return;

      if (ctx.store.isOwner(ctx.from.id)) {
        if (await BroadcastHandler.handleTextInput(ctx)) return;
        if (await CustomEmojiHandler.handleTextInput(ctx)) return;
        if (await ProductHandler.handleTextInput(ctx)) return;
        if (await SessionRestockHandler.handleTextInput(ctx)) return;
        if (await PaymentSettingsHandler.handleTextInput(ctx)) return;
        if (await SellerSettingsHandler.handleTextInput(ctx)) return;
        if (await IdPricingHandler.handleTextInput(ctx)) return;
        if (await ManualBalanceHandler.handleTextInput(ctx)) return;
        if (await OrderTrackingHandler.handleTextInput(ctx)) return;
        if (await TelePremiumAdminHandler.handleTextInput(ctx)) return;
      }

      if (await TopupHandler.handleTextInput(ctx)) return;
      if (await SellerHandler.handleTextInput(ctx)) return;
      if (await TelePremiumBuyerHandler.handleTextInput(ctx, bot)) return;
    });

    bot.on('sticker', async ctx => {
      if (ctx.store?.isOwner(ctx.from.id)) {
        await WelcomeHandler.handleSticker(ctx);
      }
    });

    bot.on('video', async ctx => {
      if (ctx.store?.isOwner(ctx.from.id)) {
        await BannerHandler.handleMedia(ctx);
      }
    });

    bot.on('animation', async ctx => {
      if (ctx.store?.isOwner(ctx.from.id)) {
        await BannerHandler.handleMedia(ctx);
      }
    });

    bot.on('photo', async ctx => {
      if (await CheckoutHandler.handleProofUpload(ctx)) return;
      if (await TopupHandler.handlePhoto(ctx)) return;
      if (ctx.store?.isOwner(ctx.from.id)) {
        await PaymentSettingsHandler.handlePhotoInput(ctx);
        if (ctx.session?.flow === 'store_banner') return BannerHandler.handleMedia(ctx);
      }
    });

    bot.catch(errorHandler);
    logger.info(`[StoreRuntime] Telegram account shop + payment handlers registered for ${storeDoc.storeId}`);
  }
}

module.exports = StoreRuntime;
