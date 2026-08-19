'use strict';

const express = require('express');
const Store = require('../../models/Store');
const Topup = require('../../models/Topup');
const WalletService = require('../../services/walletService');
const Valqenix = require('../../payments/valqenix');
const router = express.Router();

const BotManager = require('../../core/BotManager');
const OrderService = require('../../services/orderService');
const OwnerPaymentVerifyHandler = require('../../handlers/common/ownerPaymentVerify');
const Invoice = require('../../models/Invoice');
const logger = require('../../utils/logger');

router.post('/bot/:storeId', (req, res) => {
  BotManager.handleWebhook(req.params.storeId, req, res);
});

// Valqenix payment webhook — used for buyer wallet top-ups.
router.post('/valqenix/:storeId', async (req, res) => {
  try {
    const store = await Store.findOne({ storeId: req.params.storeId });
    const cfg = store?.paymentSettings?.valqenix;
    if (!store || !cfg?.enabled || !cfg.webhookSecret) return res.status(403).send('Forbidden');
    const ok = Valqenix.verifyWebhook({
      rawBody: req.rawBody || JSON.stringify(req.body),
      timestamp: req.get('X-Valqenix-Timestamp'),
      signature: req.get('X-Valqenix-Signature'),
      secret: cfg.webhookSecret,
    });
    if (!ok) return res.status(401).send('Invalid signature');
    const eventId = req.get('X-Valqenix-Event-ID') || req.get('Idempotency-Key');
    const deliveryId = req.get('X-Valqenix-Delivery-ID') || null;
    const event = req.get('X-Valqenix-Event') || req.body?.event || req.body?.data?.event || req.body?.type;
    if (event !== 'payment.paid') return res.status(200).send('OK');
    const reference = req.body?.data?.reference || req.body?.reference || req.body?.payment?.reference;
    if (!reference) return res.status(400).send('Missing reference');
    const topup = await Topup.findOne({ storeId: store.storeId, reference });
    if (!topup) return res.status(404).send('Topup not found');
    if (topup.status === 'credited') return res.status(200).send('OK');
    if (eventId && topup.webhookEventId === eventId) return res.status(200).send('OK');
    if (deliveryId && topup.webhookDeliveryId === deliveryId) return res.status(200).send('OK');
    await Topup.findOneAndUpdate({ _id: topup._id }, { $set: { webhookEventId: eventId || null, webhookDeliveryId: deliveryId, status: 'approved', webhookPayload: req.body } });
    const result = await WalletService.creditTopup(topup._id, 'valqenix', topup.storeId);
    if (!result.success && !String(result.reason || '').includes('sudah')) return res.status(409).send(result.reason);
    return res.status(200).send('OK');
  } catch (err) {
    require('../../utils/logger').error('[Valqenix webhook]', err.message);
    return res.status(500).send('ERROR');
  }
});

module.exports = router;
