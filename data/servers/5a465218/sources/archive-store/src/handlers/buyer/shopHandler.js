'use strict';

const Product = require('../../models/Product');
const buyerKeyboard = require('../../keyboards/buyerKeyboard');
const MessageFormatter = require('../../utils/messageFormatter');
const logger = require('../../utils/logger');
const CheckoutHandler = require('./checkoutHandler');
const IdPricing = require('../../services/idPricingService');
const SessionService = require('../../services/sessionService');
const crypto = require('crypto');

function formatPrice(amount) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Number(amount) || 0);
}

class ShopHandler {
  static register(bot) {
    bot.action('shop:start', async (ctx) => {
      await ctx.answerCbQuery();
      await ShopHandler.showShopMenu(ctx);
    });

    bot.action('shop:cat:telegram', async (ctx) => {
      await ctx.answerCbQuery();
      await ShopHandler.showCategoryProducts(ctx);
    });

    bot.action(/^shop:idprefix:([1-8])$/, async (ctx) => {
      await ctx.answerCbQuery();
      await ShopHandler.showIdPrefix(ctx, ctx.match[1], 1);
    });

    bot.action(/^shop:idpage:([1-8]):(\d+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      await ShopHandler.showIdPrefix(ctx, ctx.match[1], Number(ctx.match[2]));
    });

    bot.action(/^shop:ids:([1-8]):(8|9|10)$/, async (ctx) => {
      await ctx.answerCbQuery();
      await ShopHandler.showStockSessions(ctx, ctx.match[1], Number(ctx.match[2]));
    });

    bot.action(/^shop:sessionbuy:([A-Za-z0-9_-]{8,32})$/, async (ctx) => {
      await ctx.answerCbQuery('🛒 Menyiapkan pembelian...', { show_alert: false }).catch(() => {});
      const token = String(ctx.match[1] || '');
      const choice = ctx.session?.shopSessionChoices?.[token];

      if (!choice || !choice.productId || !choice.telegramId || Date.now() - Number(choice.createdAt || 0) > 15 * 60 * 1000) {
        await ctx.editMessageText(
          MessageFormatter.buildBox(null, ctx.store.settings.storeName, [
            '❌ Tombol pembelian sudah kedaluwarsa.',
            '',
            'Silakan buka menu ID lagi dan pilih nomor yang masih tersedia.',
          ]),
          { parse_mode: 'HTML', ...buyerKeyboard.backToShop() }
        ).catch(() => ctx.reply('❌ Tombol pembelian sudah kedaluwarsa.', buyerKeyboard.backToShop()));
        return;
      }

      const productId = String(choice.productId);
      const telegramId = String(choice.telegramId);
      const product = await Product.findOne({
        _id: productId,
        storeId: ctx.storeId,
        productType: 'telegram_session',
        status: 'active',
      });
      if (!product) {
        await ctx.editMessageText(
          MessageFormatter.buildBox(null, ctx.store.settings.storeName, ['❌ Produk sudah tidak tersedia.']),
          { parse_mode: 'HTML', ...buyerKeyboard.backToShop() }
        );
        return;
      }

      const session = SessionService.getAvailableSessionByTelegramId(
        ctx.storeId,
        productId,
        telegramId,
        String(ctx.from.id)
      );
      if (!session?.data) {
        await ctx.editMessageText(
          MessageFormatter.buildBox(null, ctx.store.settings.storeName, [
            '⚠️ Nomor tersebut baru saja diambil atau sedang tidak tersedia.',
            '',
            'Silakan pilih nomor lain yang masih tersedia.',
          ]),
          { parse_mode: 'HTML', ...buyerKeyboard.backToShop() }
        );
        return;
      }

      const wallet = await require('../../models/BuyerWallet').getOrCreate(ctx.storeId, ctx.from.id);
      const info = IdPricing.getIdInfo(telegramId);
      const nokosStatus = IdPricing.normalizeStatus(session.data.nokosStatus || 'fs');
      const selectedPrice = info.valid
        ? IdPricing.getConfiguredPrice(ctx.store, info.prefix, info.digitLength, nokosStatus)
        : Number(product.price || 0);
      const total = Number(selectedPrice || 0);
      if (total <= 0) {
        await ctx.editMessageText(
          MessageFormatter.buildBox(null, ctx.store.settings.storeName, [
            '❌ Harga akun belum tersedia untuk status tersebut.',
            '',
            `ID: ${telegramId}`,
            `Status: ${nokosStatus.toUpperCase()}`,
            '',
            'Silakan hubungi owner toko.',
          ]),
          { parse_mode: 'HTML', ...buyerKeyboard.backToShop() }
        );
        return;
      }
      const selectedLabel = [
        `🆔 ID: ${telegramId}`,
        `💰 Harga: ${formatPrice(selectedPrice)}`,
        `📌 Status: ${nokosStatus.toUpperCase()}`,
        `🎨 ${await ShopHandler.resolveColorLabel(ctx, session.data)}`,
        session.data.phone ? `📞 Nomor: +${String(session.data.phone).replace(/\D/g, '')}` : null,
        '',
        `💳 Saldo kamu: ${formatPrice(wallet.balance)}`,
        '',
        wallet.balance >= total ? 'Saldo cukup. Lanjutkan ke konfirmasi pembelian.' : '❌ Saldo belum mencukupi.',
      ].filter(v => v !== null);

      const checkoutToken = require('crypto').randomBytes(12).toString('hex');
      ctx.session.pendingCheckout = {
        productId,
        quantity: 1,
        expectedTotal: total,
        selectedSessionTelegramId: telegramId,
        selectedSessionStatus: nokosStatus,
        selectedSessionPrice: selectedPrice,
        createdAt: new Date().toISOString(),
        checkoutToken,
      };
      ctx.saveSession();
      CheckoutHandler.rememberCheckoutDraft(ctx.storeId, ctx.from.id, ctx.session.pendingCheckout);

      const markup = buyerKeyboard.purchaseConfirm(productId, 1, total, checkoutToken);
      await ctx.editMessageText(
        MessageFormatter.buildBox(null, ctx.store.settings.storeName, [
          '🛒 Konfirmasi Nomor', '',
          ...selectedLabel,
        ]),
        { parse_mode: 'HTML', ...markup }
      );
    });

    bot.action('shop:manual_products', async (ctx) => {
      await ctx.answerCbQuery();
      await ShopHandler.showManualProducts(ctx);
    });

    bot.action(/^shop:product:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const productId = ctx.match[1];
      const product = await Product.findOne({
        _id: productId,
        storeId: ctx.storeId,
        productType: 'telegram_session',
        status: { $in: ['active', 'out_of_stock'] },
      });
      const storeName = ctx.store.settings.storeName;
      if (!product) {
        await ctx.reply('❌ Produk tidak tersedia.', buyerKeyboard.backToShop());
        return;
      }

      ctx.session.currentProductId = productId;
      ctx.session.currentQty = 1;
      ctx.saveSession();

      const text = MessageFormatter.productDetail(null, storeName, product, 1);
      if (product.stockCount <= 0) {
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: ' Stok Kosong kaya hati kamu', callback_data: 'noop' }],
              [{ text: '⬅ Kembali', callback_data: 'shop:cat:telegram' }],
            ],
          },
        });
        return;
      }

      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        ...buyerKeyboard.quantitySelector(
          productId, 1, Math.min(product.maxPerOrder, product.stockCount), product.price
        ),
      });
    });

    bot.action(/^qty:(plus|minus):(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const productId = ctx.match[2];
      const product = await Product.findOne({
        _id: productId, storeId: ctx.storeId, productType: 'telegram_session',
      });
      if (!product) return;

      let qty = ctx.session.currentQty || 1;
      const maxQty = Math.min(product.maxPerOrder, product.stockCount);
      if (ctx.match[1] === 'plus' && qty < maxQty) qty++;
      if (ctx.match[1] === 'minus' && qty > 1) qty--;

      ctx.session.currentQty = qty;
      ctx.saveSession();

      await ctx.editMessageText(
        MessageFormatter.productDetail(null, ctx.store.settings.storeName, product, qty),
        {
          parse_mode: 'HTML',
          ...buyerKeyboard.quantitySelector(productId, qty, maxQty, product.price),
        }
      );
    });

    bot.action('noop', async (ctx) => ctx.answerCbQuery('❌ Stok habis'));

    bot.action('shop:my_orders', async (ctx) => {
      await ctx.answerCbQuery();
      const Order = require('../../models/Order');
      const orders = await Order.find({
        storeId: ctx.storeId,
        buyerId: String(ctx.from.id),
      }).sort({ createdAt: -1 }).limit(10);

      await ctx.editMessageText(
        MessageFormatter.orderStatus(null, ctx.store.settings.storeName, orders),
        { parse_mode: 'HTML', ...buyerKeyboard.orderHistory(orders) }
      );
    });

    bot.action('shop:cancel_order', async (ctx) => {
      await ctx.answerCbQuery();
      const OrderService = require('../../services/orderService');
      const orderId = ctx.session.currentOrderId;
      if (orderId) await OrderService.cancelOrder(orderId, 'Dibatalkan oleh pembeli').catch(() => {});
      ctx.session.pendingCheckout = null;
      ctx.session.currentOrderId = null;
      ctx.saveSession();
      await ShopHandler.showShopMenu(ctx);
    });
  }

  static async showShopMenu(ctx, opts = {}) {
    const store = ctx.store;
    const text = MessageFormatter.categoryMenu(
      null,
      store.settings.storeName,
      store.settings.welcomeMessage || '',
      ['telegram'],
      store.settings.footerText || '',
      ctx.from?.username || ''
    );

    const fresh = !!opts.freshStart;
    if (fresh) {
      const bannerFileId = store.settings?.bannerFileId;
      if (bannerFileId && !ctx.session?.bannerMessageId) {
        try {
          const type = store.settings?.bannerType || 'photo';
          let bannerMessage;
          if (type === 'video') bannerMessage = await ctx.replyWithVideo(bannerFileId);
          else if (type === 'animation') bannerMessage = await ctx.replyWithAnimation(bannerFileId);
          else bannerMessage = await ctx.replyWithPhoto(bannerFileId);

          if (bannerMessage?.message_id) {
            ctx.session.bannerMessageId = bannerMessage.message_id;
            ctx.saveSession();
            ctx.__uiPreserveMessageIds = ctx.__uiPreserveMessageIds || new Set();
            ctx.__uiPreserveMessageIds.add(bannerMessage.message_id);
          }
        } catch (err) {
          logger.warn('[ShopHandler] banner failed:', err.message);
        }
      }
      await ctx.reply(text, { parse_mode: 'HTML', ...buyerKeyboard.mainShop() });
      return;
    }

    if (ctx.session?.bannerMessageId) {
      ctx.__uiPreserveMessageIds = ctx.__uiPreserveMessageIds || new Set();
      ctx.__uiPreserveMessageIds.add(Number(ctx.session.bannerMessageId));
    }

    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...buyerKeyboard.mainShop() });
    } catch {
      await ctx.reply(text, { parse_mode: 'HTML', ...buyerKeyboard.mainShop() });
    }
  }

  static async showCategoryProducts(ctx) {
    if (ctx.session?.bannerMessageId) {
      ctx.__uiPreserveMessageIds = ctx.__uiPreserveMessageIds || new Set();
      ctx.__uiPreserveMessageIds.add(Number(ctx.session.bannerMessageId));
    }
    const stockMap = await IdPricing.getAllPrefixStock(ctx.storeId);
    const totalStock = Object.values(stockMap).reduce((sum, n) => sum + Number(n || 0), 0);
    const storeName = ctx.store.settings.storeName;

    await ctx.editMessageText(
      MessageFormatter.buildBox(null, storeName, [
        '📱 Pilih nokos Telegram yang tersedia.', '',
        `📦 Total stok: ${totalStock} akun`,
        '🔎 Pilih ID yang ingin kamu cari.',
      ]),
      { parse_mode: 'HTML', ...buyerKeyboard.idPrefixMenu(stockMap) }
    );
  }

  static async showIdPrefix(ctx, prefix, page = 1) {
    if (ctx.session?.bannerMessageId) {
      ctx.__uiPreserveMessageIds = ctx.__uiPreserveMessageIds || new Set();
      ctx.__uiPreserveMessageIds.add(Number(ctx.session.bannerMessageId));
    }

    const buckets = await IdPricing.getPrefixBuckets(ctx.storeId, prefix);
    const storeName = ctx.store.settings.storeName;
    const totalStock = buckets.reduce((sum, b) => sum + Number(b.stockCount || 0), 0);

    if (!buckets.length || totalStock <= 0) {
      await ctx.editMessageText(
        MessageFormatter.buildBox(null, storeName, [
          `ID ${prefix}`, '',
          '📦 Total stok: 0 akun',
          '',
          '❌ Belum ada nomor yang tersedia untuk ID ini.',
        ]),
        { parse_mode: 'HTML', ...buyerKeyboard.backToShop() }
      );
      return;
    }

    // Ambil cukup banyak kandidat supaya pagination benar-benar bisa menampilkan
    // maksimal 5 akun per halaman dan tetap menghormati cooldown buyer.
    const allSessions = [];
    for (const bucket of buckets) {
      if (!bucket.product || Number(bucket.stockCount || 0) <= 0) continue;
      const items = SessionService.getAvailableSessionDetails(
        ctx.storeId,
        String(bucket.product._id),
        String(ctx.from.id),
        100
      );
      for (const item of items) {
        const sessionTelegramId = String(item.telegramId || 'Tidak diketahui');
        const sessionStatus = IdPricing.normalizeStatus(item.data?.nokosStatus || 'fs');
        const sessionPrice = IdPricing.getConfiguredPrice(
          ctx.store, prefix, Number(bucket.digitLength), sessionStatus
        ) || Number(bucket.price || 0);
        allSessions.push({
          productId: String(bucket.product._id),
          digitLength: Number(bucket.digitLength),
          telegramId: sessionTelegramId,
          price: Number(sessionPrice || 0),
          status: sessionStatus,
          phone: item.phone,
          data: item.data,
        });
      }
      if (allSessions.length >= 100) break;
    }

    if (!allSessions.length) {
      await ctx.editMessageText(
        MessageFormatter.buildBox(null, storeName, [
          `ID ${prefix}`, '',
          `📦 Total stok: ${totalStock} akun`,
          '',
          '⚠️ Stok fisik masih tercatat, tetapi nomor sedang dipakai/cooldown sehingga belum bisa dibeli akun kamu.',
          '',
          'Coba pilih lagi beberapa saat kemudian atau gunakan ID lain.',
        ]),
        { parse_mode: 'HTML', ...buyerKeyboard.backToShop() }
      );
      return;
    }

    const pageSize = 5;
    const totalPages = Math.max(1, Math.ceil(allSessions.length / pageSize));
    const safePage = Math.min(Math.max(Number(page) || 1, 1), totalPages);
    const pageItems = allSessions.slice((safePage - 1) * pageSize, safePage * pageSize);

    const sessions = [];
    ctx.session.shopSessionChoices = ctx.session.shopSessionChoices || {};
    for (const item of pageItems) {
      const callbackToken = crypto.randomBytes(6).toString('hex');
      ctx.session.shopSessionChoices[callbackToken] = {
        productId: String(item.productId),
        telegramId: String(item.telegramId || ''),
        status: IdPricing.normalizeStatus(item.status || 'fs'),
        price: Number(item.price || 0),
        createdAt: Date.now(),
      };
      const color = await ShopHandler.resolveColorLabel(ctx, item.data);
      sessions.push({ ...item, color, callbackToken });
    }

    const digitLabels = [...new Set(allSessions.map((item) => Number(item.digitLength)).filter(Number.isFinite))];
    const digitText = digitLabels.length === 1 ? `${digitLabels[0]} Digit` : 'Nomor Tersedia';
    const lines = [
      `🆔 ID ${prefix} • ${digitText}`,
      '',
      `📦 Stok Tersedia : ${totalStock} akun`,
      `📄 Halaman       : ${safePage}/${totalPages}`,
      `ℹ️ Menampilkan   : ${(safePage - 1) * pageSize + 1}–${(safePage - 1) * pageSize + sessions.length} dari ${allSessions.length} akun yang bisa dibeli`,
      '',
      '━━━━━━━━━━━━━━━━━━',
      '',
    ];

    sessions.forEach((item, index) => {
      const number = (safePage - 1) * pageSize + index + 1;
      lines.push(
        `${number}. 🆔 ${item.telegramId} (${item.digitLength} digit)`,
        `   💰 ${formatPrice(item.price)}`,
        `   🏷️ Status: ${(item.status || 'fs').toUpperCase()}`,
        `   🎨 ${item.color}`, 
        item.phone ? `   📞 +${String(item.phone).replace(/\D/g, '')}` : '   📞 Nomor tidak terdeteksi',
        ''
      );
    });

    lines.push('━━━━━━━━━━━━━━━━━━', '', '⚡ Akun siap dibeli.', 'Silakan pilih tombol "🛒 Beli" pada nomor yang kamu inginkan.');

    const now = Date.now();
    ctx.session.shopSessionChoices = Object.fromEntries(
      Object.entries(ctx.session.shopSessionChoices || {})
        .filter(([, value]) => value && now - Number(value.createdAt || 0) < 15 * 60 * 1000)
        .slice(-200)
    );
    ctx.saveSession();

    await ctx.editMessageText(
      MessageFormatter.buildBox(null, storeName, lines),
      { parse_mode: 'HTML', ...buyerKeyboard.stockSessionList(sessions, { page: safePage, totalPages, prefix }) }
    );
  }

  static async showStockSessions(ctx, prefix, digitLength) {
    if (ctx.session?.bannerMessageId) {
      ctx.__uiPreserveMessageIds = ctx.__uiPreserveMessageIds || new Set();
      ctx.__uiPreserveMessageIds.add(Number(ctx.session.bannerMessageId));
    }

    const buckets = await IdPricing.getPrefixBuckets(ctx.storeId, prefix);
    const bucket = buckets.find(b => Number(b.digitLength) === Number(digitLength));
    const product = bucket?.product;
    const storeName = ctx.store.settings.storeName;

    if (!product) {
      await ctx.editMessageText(
        MessageFormatter.buildBox(null, storeName, [`ID ${prefix} — ${digitLength} Digit`, '', 'Stok belum tersedia.']),
        { parse_mode: 'HTML', ...buyerKeyboard.backToShop() }
      );
      return;
    }

    const rawSessions = SessionService.getAvailableSessionDetails(
      ctx.storeId,
      String(product._id),
      String(ctx.from.id),
      40
    );

    if (!rawSessions.length) {
      await ctx.editMessageText(
        MessageFormatter.buildBox(null, storeName, [
          `ID ${prefix} — ${digitLength} Digit`, '',
          '❌ Tidak ada nomor yang bisa dipakai akun kamu saat ini.',
          '',
          'Jika stok hanya tersisa nomor yang sedang cooldown untuk kamu, silakan tunggu sampai batas OTP selesai.',
        ]),
        { parse_mode: 'HTML', ...buyerKeyboard.backToShop() }
      );
      return;
    }

    const sessions = [];
    for (const item of rawSessions) {
      const sessionStatus = IdPricing.normalizeStatus(item.data?.nokosStatus || 'fs');
      const info = IdPricing.getIdInfo(item.telegramId || '');
      const sessionPrice = info.valid
        ? IdPricing.getConfiguredPrice(ctx.store, prefix, Number(digitLength), sessionStatus) || Number(product.price || 0)
        : Number(product.price || 0);
      const color = await ShopHandler.resolveColorLabel(ctx, item.data);
      const callbackToken = crypto.randomBytes(6).toString('hex');
      ctx.session.shopSessionChoices = ctx.session.shopSessionChoices || {};
      ctx.session.shopSessionChoices[callbackToken] = {
        productId: String(product._id),
        telegramId: String(item.telegramId || ''),
        status: sessionStatus,
        price: Number(sessionPrice || 0),
        createdAt: Date.now(),
      };
      sessions.push({
        productId: String(product._id),
        telegramId: item.telegramId || 'Tidak diketahui',
        price: Number(sessionPrice || 0),
        status: sessionStatus,
        phone: item.phone,
        color,
        callbackToken,
      });
    }

    const lines = [
      `🆔 ID ${prefix} — ${digitLength} Digit`,
      '',
      `📦 Total stok: ${sessions.length} akun`,
      `💰 Harga: mengikuti status FS / NFS`,
      '',
    ];

    sessions.forEach((item, index) => {
      lines.push(
        `${index + 1}. 🆔 ${item.telegramId}`,
        `   💰 ${formatPrice(item.price)}`,
        `   🏷️ Status: ${(item.status || 'fs').toUpperCase()}`,
        `   🎨 ${item.color}`, 
        item.phone ? `   📞 +${String(item.phone).replace(/\D/g, '')}` : '   📞 Nomor tidak terdeteksi',
        ''
      );
    });

    if (Number(bucket.stockCount || 0) > sessions.length) {
      lines.push(`ℹ️ Menampilkan ${sessions.length} dari ${bucket.stockCount} stok yang tersedia untuk akun kamu.`);
    }

    const now = Date.now();
    ctx.session.shopSessionChoices = Object.fromEntries(
      Object.entries(ctx.session.shopSessionChoices || {})
        .filter(([, value]) => value && now - Number(value.createdAt || 0) < 15 * 60 * 1000)
        .slice(-100)
    );
    ctx.saveSession();

    await ctx.editMessageText(
      MessageFormatter.buildBox(null, storeName, lines),
      { parse_mode: 'HTML', ...buyerKeyboard.stockSessionList(sessions) }
    );
  }

  static async resolveColorLabel(ctx, sessionData) {
    const mapping = {
      0: { name: 'Merah', emoji: '🟥' },
      1: { name: 'Oranye', emoji: '🟧' },
      2: { name: 'Ungu', emoji: '🟪' },
      3: { name: 'Hijau', emoji: '🟩' },
      4: { name: 'Cyan', emoji: '🟦' },
      5: { name: 'Biru', emoji: '🟦' },
      6: { name: 'Pink', emoji: '🩷' },
      7: { name: 'Cokelat', emoji: '🟫' },
      8: { name: 'Hitam', emoji: '⬛' },
      9: { name: 'Putih', emoji: '⬜' },
    };

    const candidates = [];
    const telegramId = String(sessionData?.telegramId || '');

    if (telegramId && ctx?.telegram?.getChat) {
      try {
        const chat = await Promise.race([
          ctx.telegram.getChat(telegramId),
          new Promise((_, reject) => setTimeout(() => reject(new Error('getChat timeout')), 2500)),
        ]);
        candidates.push(chat?.accent_color_id, chat?.profile_accent_color_id);
      } catch (err) {
        logger.debug?.(`[ShopHandler] warna real-time getChat gagal ${telegramId}: ${err.message}`);
      }
    }

    candidates.push(sessionData?.profileColor?.id);
    candidates.push(sessionData?.accent_color_id, sessionData?.profile_accent_color_id);

    for (const value of candidates) {
      const id = Number(value);
      if (Number.isInteger(id) && mapping[id]) {
        return `${mapping[id].emoji} ${mapping[id].name}`;
      }
    }

    return '⚪ Warna tidak terdeteksi bot';
  }

  static async showManualProducts(ctx) {
    if (ctx.session?.bannerMessageId) {
      ctx.__uiPreserveMessageIds = ctx.__uiPreserveMessageIds || new Set();
      ctx.__uiPreserveMessageIds.add(Number(ctx.session.bannerMessageId));
    }
    const allProducts = await Product.find({
      storeId: ctx.storeId,
      productType: 'telegram_session',
      status: { $in: ['active', 'out_of_stock'] },
    }).sort({ createdAt: 1 }).limit(50);
    const products = allProducts.filter(p => !p.metadata?.idBucket);
    const storeName = ctx.store.settings.storeName;
    if (!products.length) {
      await ctx.editMessageText(
        MessageFormatter.buildBox(null, storeName, ['Produk lainnya', '', 'belum ada jir udh balik lagi ae.']),
        { parse_mode: 'HTML', ...buyerKeyboard.idPrefixMenu(await IdPricing.getAllPrefixStock(ctx.storeId)) }
      );
      return;
    }

    await ctx.editMessageText(
      MessageFormatter.productListInCategory(null, storeName, 'Produk lainnya', products),
      { parse_mode: 'HTML', ...buyerKeyboard.productListInCategory(products) }
    );
  }
}

module.exports = ShopHandler;
