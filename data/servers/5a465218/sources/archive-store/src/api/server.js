'use strict';

const express = require('express');
const app = express();
const logger = require('../utils/logger');

// Body parsing
app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
  logger.http(`${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    env: process.env.NODE_ENV || 'development',
  });
});

// Routes
app.use('/webhooks', require('./routes/webhooks'));
app.use('/api/stores', require('./routes/stores'));

// Payment return page
app.get('/payment/return', (req, res) => {
  res.send('<html><body style="font-family:sans-serif;text-align:center;padding:50px"><h2>✅ Pembayaran berhasil diproses.</h2><p>Silakan tutup halaman ini dan kembali ke Telegram.</p></body></html>');
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('API error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Export app — listening is handled by app.js
module.exports = app;
