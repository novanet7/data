'use strict';

const express    = require('express');
const router     = express.Router();
const Store      = require('../../models/Store');
const BotManager = require('../../core/BotManager');
const StoreLoader = require('../../core/StoreLoader');

// ── Create store (disabled in single-store mode) ───────────────────────────
router.post('/create', async (req, res) => {
  return res.status(410).json({ error: 'Single-store mode: store creation is disabled.' });
});

// ── Get store info ────────────────────────────────────────────────────────────
router.get('/:storeId', async (req, res) => {
  try {
    const store = await Store.findOne({ storeId: req.params.storeId });
    if (!store) return res.status(404).json({ error: 'Store not found' });

    // Strip sensitive fields
    const safe = { ...store };
    delete safe.botToken;
    if (safe.paymentSettings?.valqenix) { delete safe.paymentSettings.valqenix.apiKey; delete safe.paymentSettings.valqenix.webhookSecret; }

    const botInfo = BotManager.getInfo(store.storeId);
    res.json({ success: true, store: safe, bot: botInfo });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Restart bot ───────────────────────────────────────────────────────────────
router.post('/:storeId/restart', async (req, res) => {
  try {
    await BotManager.restart(req.params.storeId);
    res.json({ success: true, message: 'Bot restarted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stop bot ──────────────────────────────────────────────────────────────────
router.post('/:storeId/stop', async (req, res) => {
  try {
    await BotManager.unload(req.params.storeId, 'api-stop');
    await Store.findOneAndUpdate({ storeId: req.params.storeId }, { $set: { botStatus: 'stopped', 'runtimeConfig.autoRestart': false } });
    res.json({ success: true, message: 'Bot stopped' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start bot ─────────────────────────────────────────────────────────────────
router.post('/:storeId/start', async (req, res) => {
  try {
    await StoreLoader.loadOne(req.params.storeId);
    await Store.findOneAndUpdate({ storeId: req.params.storeId }, { $set: { botStatus: 'running', 'runtimeConfig.autoRestart': true } });
    res.json({ success: true, message: 'Bot started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Platform stats ────────────────────────────────────────────────────────────
router.get('/platform/stats', async (req, res) => {
  try {
    const botStats   = BotManager.getStats();
    const totalStores  = await Store.countDocuments({});
    const activeStores = await Store.countDocuments({ status: 'active' });
    res.json({ success: true, stats: { ...botStats, totalStores, activeStores } });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
