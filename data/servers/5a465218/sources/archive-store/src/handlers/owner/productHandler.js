'use strict';

const Product = require('../../models/Product');
const SessionService = require('../../services/sessionService');
const AuditLog = require('../../models/AuditLog');
const ownerKeyboard = require('../../keyboards/ownerKeyboard');

const PRODUCT_TYPE_LABELS = { telegram_session: '📱 Akun Telegram' };
const BUYER_CATEGORY_MAP = { telegram_session: 'telegram' };

class ProductHandler {
  static register(bot) {
    bot.action('owner:add_product', async ctx => {
      await ctx.answerCbQuery();
      ctx.session.flow = 'add_product';
      ctx.session.addProduct = { step: 'name' };
      ctx.saveSession();
      await ctx.editMessageText(
        '📱 *Tambah Produk Akun Telegram*\n\nMasukkan nama produk:\n_(Contoh: Telegram Fresh, Telegram ID 1)_',
        { parse_mode: 'Markdown', ...ownerKeyboard.cancelButton() }
      );
    });

    bot.action(/^ptype:(.+)$/, async ctx => {
      await ctx.answerCbQuery();
      if (ctx.match[1] !== 'telegram_session' || ctx.session.flow !== 'add_product') return;
      ctx.session.addProduct.productType = 'telegram_session';
      ctx.session.addProduct.step = 'price';
      ctx.saveSession();
      await ctx.editMessageText(
        '📱 *Akun Telegram*\n\nMasukkan harga per slot (angka, contoh: 15000):',
        { parse_mode: 'Markdown', ...ownerKeyboard.cancelButton() }
      );
    });

    bot.action('owner:product_list', async ctx => {
      await ctx.answerCbQuery();
      const products = await Product.find({
        storeId: ctx.storeId,
        productType: 'telegram_session',
        status: { $ne: 'deleted' },
      }).sort({ createdAt: -1 }).limit(50);

      if (!products.length) {
        await ctx.editMessageText(
          '📱 *Produk Akun Telegram*\n\nBelum ada produk. Tambah produk atau gunakan Restock Telegram.',
          { parse_mode: 'Markdown', ...ownerKeyboard.backButton() }
        );
        return;
      }

      await ctx.editMessageText(
        `📱 *Produk Akun Telegram* (${products.length})`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              ...products.map(p => [{
                text: `${p.name} (${p.stockCount})${p.status === 'active' ? '' : ' (Inactive)'}`,
                callback_data: `owner:view_product:${p._id}`,
              }]),
              [{ text: '⬅ Kembali', callback_data: 'owner:back_main' }],
            ],
          },
        }
      );
    });

    bot.action(/^owner:view_product:(.+)$/, async ctx => {
      await ctx.answerCbQuery();
      const product = await Product.findOne({
        _id: ctx.match[1], storeId: ctx.storeId, productType: 'telegram_session',
      });
      if (!product) return ctx.reply('❌ Produk tidak ditemukan.');

      const available = SessionService.countAvailableSessions(ctx.storeId, String(product._id), 'telegram_session');
      const text =
        `📱 *${escapeMd(product.name)}*\n\n` +
        `💰 Harga: ${formatPrice(product.price)}\n` +
        `📦 Stok: ${available}\n` +
        `📊 Status: ${product.status}\n` +
        `🔢 Maks/Order: ${product.maxPerOrder}`;

      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...ownerKeyboard.productActions(String(product._id)) });
    });

    bot.action(/^owner:restock_product:(.+)$/, async ctx => {
      await ctx.answerCbQuery();
      const product = await Product.findOne({ _id: ctx.match[1], storeId: ctx.storeId, productType: 'telegram_session' });
      if (!product) return;
      await ctx.editMessageText(
        `📥 *Restock ${escapeMd(product.name)}*`,
        { parse_mode: 'Markdown', ...ownerKeyboard.restockMenu(String(product._id)) }
      );
    });

    bot.action(/^owner:toggle:(.+)$/, async ctx => {
      await ctx.answerCbQuery();
      const product = await Product.findOne({ _id: ctx.match[1], storeId: ctx.storeId, productType: 'telegram_session' });
      if (!product) return;
      product.status = product.status === 'active' ? 'inactive' : (product.stockCount > 0 ? 'active' : 'out_of_stock');
      await product.save();
      await ctx.reply(`✅ Status produk: ${product.status}`, ownerKeyboard.backButton('owner:product_list'));
    });

    bot.action('owner:rename_product', async ctx => {
      await ctx.answerCbQuery();
      const products = await Product.find({ storeId: ctx.storeId, productType: 'telegram_session', status: { $ne: 'deleted' } })
        .sort({ name: 1 }).limit(50);
      if (!products.length) return ctx.editMessageText('❌ Belum ada produk.', ownerKeyboard.backButton());
      await ctx.editMessageText('✏️ Pilih produk:', {
        ...ownerKeyboard.productSelectMenu(products, 'owner:rename'),
        parse_mode: 'Markdown',
      });
    });

    bot.action(/^owner:rename:(.+)$/, async ctx => {
      await ctx.answerCbQuery();
      ctx.session.flow = 'rename_product';
      ctx.session.renameProductId = ctx.match[1];
      ctx.saveSession();
      await ctx.editMessageText('✏️ Masukkan nama produk baru:', { ...ownerKeyboard.cancelButton() });
    });

    bot.action('owner:delete_product', async ctx => {
      await ctx.answerCbQuery();
      const products = await Product.find({ storeId: ctx.storeId, productType: 'telegram_session', status: { $ne: 'deleted' } })
        .sort({ name: 1 }).limit(50);
      if (!products.length) return ctx.editMessageText('❌ Belum ada produk.', ownerKeyboard.backButton());
      await ctx.editMessageText('🗑️ Pilih produk:', {
        ...ownerKeyboard.productSelectMenu(products, 'owner:delete'),
        parse_mode: 'Markdown',
      });
    });

    bot.action(/^owner:delete:(.+)$/, async ctx => {
      await ctx.answerCbQuery();
      const product = await Product.findOne({ _id: ctx.match[1], storeId: ctx.storeId, productType: 'telegram_session' });
      if (!product) return;
      await ctx.editMessageText(
        `🗑️ Hapus *${escapeMd(product.name)}*?`,
        { parse_mode: 'Markdown', ...ownerKeyboard.confirmAction('delete_product', String(product._id)) }
      );
    });

    bot.action(/^confirm:delete_product:(.+)$/, async ctx => {
      await ctx.answerCbQuery();
      await Product.findOneAndUpdate(
        { _id: ctx.match[1], storeId: ctx.storeId, productType: 'telegram_session' },
        { $set: { status: 'deleted' } }
      );
      await AuditLog.log({
        storeId: ctx.storeId, actorId: ctx.from.id, actorType: 'owner',
        action: 'PRODUCT_DELETED', entity: 'Product', entityId: ctx.match[1], result: 'success',
      });
      await ctx.editMessageText('✅ Produk dihapus.', ownerKeyboard.backButton('owner:product_list'));
    });

    bot.action('owner:cancel', async ctx => {
      await ctx.answerCbQuery();
      ctx.session.flow = null;
      ctx.session.addProduct = null;
      ctx.session.renameProductId = null;
      ctx.session.idPricePrefix = null;
      ctx.session.idPriceDigits = null;
      ctx.saveSession();
      await ctx.editMessageText(
        `🏪 *${escapeMd(ctx.store.settings.storeName)}*`,
        { parse_mode: 'Markdown', ...ownerKeyboard.mainMenu() }
      );
    });

    bot.action('owner:back_main', async ctx => {
      await ctx.answerCbQuery();
      await ctx.editMessageText(
        `🏪 *${escapeMd(ctx.store.settings.storeName)}*`,
        { parse_mode: 'Markdown', ...ownerKeyboard.mainMenu() }
      );
    });

    bot.action('owner:refresh', async ctx => {
      await ctx.answerCbQuery();
      const products = await Product.find({ storeId: ctx.storeId, productType: 'telegram_session', status: { $ne: 'deleted' } });
      const total = products.reduce((n, p) => n + (p.stockCount || 0), 0);
      await ctx.editMessageText(
        `🏪 *${escapeMd(ctx.store.settings.storeName)}*\n\n📱 Produk Telegram: ${products.length}\n📦 Total stok: ${total}`,
        { parse_mode: 'Markdown', ...ownerKeyboard.mainMenu() }
      );
    });
  }

  static async handleTextInput(ctx) {
    const flow = ctx.session?.flow;
    if (flow === 'add_product') return this.handleAddProduct(ctx, ctx.message.text.trim());
    if (flow === 'rename_product') return this.handleRename(ctx, ctx.message.text.trim());
    return false;
  }

  static async handleAddProduct(ctx, text) {
    const ap = ctx.session.addProduct || {};
    if (!ap.step || ap.step === 'name') {
      if (text.length < 2 || text.length > 100) {
        await ctx.reply('❌ Nama produk 2-100 karakter.', ownerKeyboard.cancelButton());
        return true;
      }
      ap.name = text;
      ap.step = 'type';
      ctx.session.addProduct = ap;
      ctx.saveSession();
      await ctx.reply('Pilih tipe produk:', { ...ownerKeyboard.productTypeSelect() });
      return true;
    }

    if (ap.step === 'type') return true;

    if (ap.step === 'price') {
      const price = Number(text.replace(/[^\d]/g, ''));
      if (!Number.isFinite(price) || price < 0) {
        await ctx.reply('❌ Harga tidak valid.');
        return true;
      }
      ap.price = price;
      ap.step = 'confirm';
      ctx.session.addProduct = ap;
      ctx.saveSession();
      await ctx.reply(
        `📦 *${escapeMd(ap.name)}*\n📱 Akun Telegram\n💰 ${formatPrice(price)}\n\nSimpan produk?`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: ' Simpan', callback_data: 'owner:confirm_add_product' },
              { text: ' Batal', callback_data: 'owner:cancel' },
            ]],
          },
        }
      );
      return true;
    }
    return false;
  }

  static async handleRename(ctx, text) {
    const id = ctx.session.renameProductId;
    if (!id) return false;
    if (text.length < 2 || text.length > 100) {
      await ctx.reply('❌ Nama produk 2-100 karakter.');
      return true;
    }
    await Product.findOneAndUpdate({ _id: id, storeId: ctx.storeId, productType: 'telegram_session' }, { $set: { name: text } });
    ctx.session.flow = null;
    ctx.session.renameProductId = null;
    ctx.saveSession();
    await ctx.reply('✅ Nama produk diperbarui.', ownerKeyboard.backButton('owner:product_list'));
    return true;
  }
}

function registerConfirmAddProduct(bot) {
  bot.action('owner:confirm_add_product', async ctx => {
    await ctx.answerCbQuery();
    const ap = ctx.session.addProduct;
    if (!ap?.name || ap.price === undefined) {
      await ctx.editMessageText('❌ Sesi habis.', ownerKeyboard.backButton());
      return;
    }

    const product = await Product.create({
      storeId: ctx.storeId,
      name: ap.name,
      description: '',
      price: ap.price,
      category: 'Telegram Accounts',
      productType: 'telegram_session',
      maxPerOrder: 10,
      status: 'out_of_stock',
      stockCount: 0,
      metadata: {},
    });

    ctx.session.flow = null;
    ctx.session.addProduct = null;
    ctx.saveSession();

    await AuditLog.log({
      storeId: ctx.storeId, actorId: ctx.from.id, actorType: 'owner',
      action: 'PRODUCT_CREATED', entity: 'Product', entityId: String(product._id),
      details: { name: product.name, productType: 'telegram_session', price: product.price },
      result: 'success',
    });

    await ctx.editMessageText(
      `✅ *Produk dibuat!*\n\n📱 ${escapeMd(product.name)}\n💰 ${formatPrice(product.price)}\n\nSekarang tambahkan stok Telegram.`,
      { parse_mode: 'Markdown', ...ownerKeyboard.productActions(String(product._id)) }
    );
  });
}

function escapeMd(t) { return t ? String(t).replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&') : ''; }
function formatPrice(n) { return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(n); }

module.exports = { ProductHandler, registerConfirmAddProduct, PRODUCT_TYPE_LABELS, BUYER_CATEGORY_MAP };
