'use strict';
const axios = require('axios');
const crypto = require('crypto');
const Invoice = require('../models/Invoice');

const PROD = 'https://app.valqenix.com/api/v1';
const SANDBOX = 'https://app.valqenix.com/api/sandbox/v1';

class ValqenixPayment {
  static base(sandbox = false) { return sandbox ? SANDBOX : PROD; }
  static async createPayment({ apiKey, amount, note, storeId, buyerId, sandbox = false }) {
    const response = await axios.post(`${this.base(Boolean(sandbox))}/payments`, { amount: Number(amount), note }, { headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 15000 });
    if (!response.data?.success) throw new Error(response.data?.message || 'Gagal membuat pembayaran Valqenix.');
    const d = response.data.data || response.data;
    const invoice = await Invoice.create({ storeId, orderId: note, buyerId: String(buyerId), amount: Number(amount), currency: 'IDR', paymentMethod: 'valqenix', externalId: d.reference, qrCodeUrl: d.qr_data_url || null, paymentUrl: d.payment_link || null, status: d.status || 'pending', expiresAt: d.expires_at || null, rawResponse: d });
    return { invoice, reference: d.reference, paymentLink: d.payment_link, qrDataUrl: d.qr_data_url, totalPay: d.total_pay, expiresAt: d.expires_at };
  }
  static async getBalance(apiKey, sandbox = false) {
    const response = await axios.get(`${this.base(Boolean(sandbox))}/balance`, { headers: { 'X-API-Key': apiKey, Accept: 'application/json' }, timeout: 10000 });
    if (!response.data?.success) throw new Error(response.data?.message || 'API Key Valqenix tidak dapat diverifikasi.');
    return response.data.data || response.data;
  }

  static async getPayment(apiKey, reference, sandbox = false) {
    const response = await axios.get(`${this.base(Boolean(sandbox))}/payments/${encodeURIComponent(reference)}`, { headers: { 'X-API-Key': apiKey, Accept: 'application/json' }, timeout: 10000 });
    if (!response.data?.success) throw new Error(response.data?.message || 'Gagal mengecek pembayaran Valqenix.');
    return response.data.data || response.data;
  }
  static verifyWebhook({ rawBody, timestamp, signature, secret, toleranceSeconds = 300 }) {
    if (!secret || !timestamp || !signature) return false;
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;
    const millis = ts < 1e12 ? ts * 1000 : ts;
    if (Math.abs(Date.now() - millis) > toleranceSeconds * 1000) return false;
    const payload = `${timestamp}.${rawBody}`;
    const digest = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
    const expected = Buffer.from(`v1=${digest}`);
    const received = Buffer.from(signature);
    return expected.length === received.length && crypto.timingSafeEqual(expected, received);
  }
}
module.exports = ValqenixPayment;
