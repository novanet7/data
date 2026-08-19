'use strict';

const Store = require('../../models/Store');
const ownerKeyboard = require('../../keyboards/ownerKeyboard');
const AuditLog = require('../../models/AuditLog');
const Valqenix = require('../../payments/valqenix');

class PaymentSettingsHandler {
  static async show(ctx) {
    const store = await Store.findOne({ storeId: ctx.storeId });
    const ps = store?.paymentSettings || {};
    const text = `💳 *Pembayaran*\n\n` +
      `📷 QRIS Manual: ${ps.qris?.enabled ? '🟢 ON' : '⚪ OFF'}\n` +
      `🌐 Valqenix: ${ps.valqenix?.enabled ? '🟢 ON' : '⚪ OFF'}\n\n` +
      `Keduanya bisa aktif bersamaan.\n` +
      `Valqenix digunakan untuk gateway QRIS/top up sesuai konfigurasi.`;
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...ownerKeyboard.paymentSettingsMenu(ps) });
  }

  static register(bot) {
    bot.action('owner:payment_settings', async ctx => { await ctx.answerCbQuery(); await this.show(ctx); });

    bot.action('pay:qris', async ctx => {
      await ctx.answerCbQuery('📷 Pengaturan QRIS Manual');
      const store = await Store.findOne({ storeId: ctx.storeId });
      const qris = store?.paymentSettings?.qris || {};

      // First-time setup: clicking QRIS immediately asks for the QRIS photo.
      if (!qris.imageUrl) {
        ctx.session.flow = 'pay_qris_image';
        ctx.saveSession();
        return ctx.editMessageText(
          '📷 *QRIS MANUAL BELUM DISET*\n\n' +
          'Kirim *foto QRIS* sekarang.\n' +
          'Setelah foto berhasil diterima, QRIS otomatis *ON*.',
          { parse_mode: 'Markdown', ...ownerKeyboard.cancelButton() }
        );
      }

      return ctx.editMessageText(
        '📷 *QRIS MANUAL*\n\n' +
        `Status: ${qris.enabled ? '🟢 ON' : '⚪ OFF'}\n` +
        `Foto: ✅ Tersimpan\n` +
        `Nama: ${qris.paymentName || 'QRIS Payment'}\n\n` +
        'Pilih tindakan di bawah.',
        { parse_mode: 'Markdown', ...ownerKeyboard.qrisSettingsMenu(qris) }
      );
    });

    bot.action('pay:qris:set_photo', async ctx => {
      await ctx.answerCbQuery('📤 Kirim foto QRIS baru');
      ctx.session.flow = 'pay_qris_image';
      ctx.saveSession();
      await ctx.editMessageText(
        '📷 *GANTI / SET FOTO QRIS*\n\n' +
        'Kirim *foto QRIS baru* sekarang.\n' +
        'Setelah tersimpan, QRIS otomatis *ON*.\n\n' +
        'Foto lama akan diganti.',
        { parse_mode: 'Markdown', ...ownerKeyboard.cancelButton() }
      );
    });

    bot.action('pay:qris:toggle', async ctx => {
      await ctx.answerCbQuery();
      const store = await Store.findOne({ storeId: ctx.storeId });
      const qris = store?.paymentSettings?.qris || {};
      if (!qris.imageUrl) {
        ctx.session.flow = 'pay_qris_image';
        ctx.saveSession();
        return ctx.editMessageText(
          '📷 QRIS belum memiliki foto.\n\nKirim *foto QRIS* untuk mengaktifkan QRIS.',
          { parse_mode: 'Markdown', ...ownerKeyboard.cancelButton() }
        );
      }
      const enabled = !qris.enabled;
      await Store.findOneAndUpdate({ storeId: ctx.storeId }, { $set: { 'paymentSettings.qris.enabled': enabled } });
      await AuditLog.log({ storeId: ctx.storeId, actorId: ctx.from.id, actorType: 'owner', action: 'PAYMENT_TOGGLED', entity: 'Store', entityId: ctx.storeId, details: { provider: 'qris', enabled }, result: 'success' });
      const updated = await Store.findOne({ storeId: ctx.storeId });
      return ctx.editMessageText(
        '📷 *QRIS MANUAL*\n\n' +
        `Status: ${updated.paymentSettings?.qris?.enabled ? '🟢 ON' : '⚪ OFF'}\n` +
        'Foto: ✅ Tersimpan\n' +
        `Nama: ${updated.paymentSettings?.qris?.paymentName || 'QRIS Payment'}\n\n` +
        'Pilih tindakan di bawah.',
        { parse_mode: 'Markdown', ...ownerKeyboard.qrisSettingsMenu(updated.paymentSettings?.qris || {}) }
      );
    });

    bot.action('pay:valqenix', async ctx => {
      await ctx.answerCbQuery();
      const store = await Store.findOne({ storeId: ctx.storeId });
      if (store?.paymentSettings?.valqenix?.apiKey) {
        const enabled = !store.paymentSettings.valqenix.enabled;
        if (enabled && !store.paymentSettings.valqenix.webhookSecret) {
          return ctx.editMessageText('❌ Webhook Secret belum diset. Lengkapi konfigurasi Valqenix dulu.', { parse_mode: 'Markdown', ...ownerKeyboard.backButton('owner:payment_settings') });
        }
        await Store.findOneAndUpdate({ storeId: ctx.storeId }, { $set: { 'paymentSettings.valqenix.enabled': enabled } });
        await this.show(ctx);
        return;
      }
      ctx.session.flow = 'pay_valqenix_apikey'; ctx.saveSession();
      await ctx.editMessageText('🌐 *Valqenix Gateway*\n\nKirim *API Key Valqenix*. API key disimpan terenkripsi di server.', { parse_mode: 'Markdown', ...ownerKeyboard.cancelButton() });
    });

    bot.action('pay:toggle_both', async ctx => {
      await ctx.answerCbQuery();
      const store = await Store.findOne({ storeId: ctx.storeId });
      const qris = store?.paymentSettings?.qris || {};
      const gateway = store?.paymentSettings?.valqenix || {};
      const bothOn = !!qris.enabled && !!gateway.enabled;
      if (bothOn) {
        await Store.findOneAndUpdate({ storeId: ctx.storeId }, { $set: { 'paymentSettings.qris.enabled': false, 'paymentSettings.valqenix.enabled': false } });
      } else {
        const qrisReady = !!qris.imageUrl;
        const gatewayReady = !!gateway.apiKey && !!gateway.webhookSecret;
        if (!qrisReady && !gatewayReady) {
          return ctx.editMessageText(
            '❌ Belum bisa mengaktifkan keduanya.\n\nUpload QRIS untuk Manual dan lengkapi API Key + Webhook Secret untuk Valqenix.',
            { parse_mode: 'Markdown', ...ownerKeyboard.backButton('owner:payment_settings') }
          );
        }
        await Store.findOneAndUpdate({ storeId: ctx.storeId }, { $set: {
          'paymentSettings.qris.enabled': qrisReady,
          'paymentSettings.valqenix.enabled': gatewayReady,
        } });
      }
      await this.show(ctx);
    });
  }

  static async handleTextInput(ctx) {
    const flow = ctx.session?.flow;
    if (!flow || !flow.startsWith('pay_')) return false;
    const text = String(ctx.message?.text || '').trim();
    if (flow === 'pay_valqenix_apikey') {
      if (!text || text.length < 8) { await ctx.reply('❌ API Key Valqenix tidak valid.'); return true; }
      try {
        await Valqenix.getBalance(text, false);
      } catch (err) {
        await ctx.reply(`❌ API Key Valqenix gagal diverifikasi.\n\n${err.message}`);
        return true;
      }
      await Store.findOneAndUpdate({ storeId: ctx.storeId }, { $set: { 'paymentSettings.valqenix.apiKey': text, 'paymentSettings.valqenix.enabled': false } });
      ctx.session.flow = 'pay_valqenix_secret'; ctx.saveSession();
      await AuditLog.log({ storeId: ctx.storeId, actorId: ctx.from.id, actorType: 'owner', action: 'PAYMENT_CONFIGURED', entity: 'Store', entityId: ctx.storeId, details: { provider: 'valqenix', apiKeyVerified: true }, result: 'success' });
      await ctx.reply('✅ API Key Valqenix terverifikasi.\n\n🔐 Sekarang kirim *Webhook Secret Valqenix* untuk verifikasi payment.paid.', { parse_mode: 'Markdown' }); return true;
    }
    if (flow === 'pay_valqenix_secret') {
      if (!text || text.length < 8) { await ctx.reply('❌ Webhook Secret Valqenix tidak valid.'); return true; }
      await Store.findOneAndUpdate({ storeId: ctx.storeId }, { $set: { 'paymentSettings.valqenix.webhookSecret': text, 'paymentSettings.valqenix.enabled': true } });
      ctx.session.flow = null; ctx.saveSession();
      await AuditLog.log({ storeId: ctx.storeId, actorId: ctx.from.id, actorType: 'owner', action: 'PAYMENT_CONFIGURED', entity: 'Store', entityId: ctx.storeId, details: { provider: 'valqenix', webhookConfigured: true }, result: 'success' });
      const webhookUrl = `${String(process.env.BASE_URL || '').replace(/\/$/, '')}/webhooks/valqenix/${ctx.storeId}`;
      await ctx.reply(`✅ Valqenix terhubung dan gateway diaktifkan.\n\n🔔 Webhook URL yang harus didaftarkan di dashboard Valqenix:\n\`${webhookUrl}\``, { parse_mode: 'Markdown', ...ownerKeyboard.backButton('owner:payment_settings') }); return true;
    }
    return false;
  }

  static async handlePhotoInput(ctx) {
    if (ctx.session?.flow !== 'pay_qris_image') return false;
    const photos = ctx.message.photo; if (!photos?.length) return false;
    const fileId = photos[photos.length - 1].file_id;
    const current = await Store.findOne({ storeId: ctx.storeId });
    const currentName = current?.paymentSettings?.qris?.paymentName || 'QRIS Payment';
    await Store.findOneAndUpdate({ storeId: ctx.storeId }, { $set: { 'paymentSettings.qris.enabled': true, 'paymentSettings.qris.imageUrl': fileId, 'paymentSettings.qris.paymentName': currentName } });
    ctx.session.flow = null; ctx.session.qrisPaymentName = null; ctx.saveSession();
    await AuditLog.log({ storeId: ctx.storeId, actorId: ctx.from.id, actorType: 'owner', action: 'PAYMENT_CONFIGURED', entity: 'Store', entityId: ctx.storeId, details: { provider: 'qris' }, result: 'success' });
    await ctx.reply('✅ QRIS Manual tersimpan dan aktif.', ownerKeyboard.backButton('owner:payment_settings')); return true;
  }
}

module.exports = PaymentSettingsHandler;
