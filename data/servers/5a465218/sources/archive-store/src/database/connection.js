'use strict';

/**
 * JSON File Database - replaces MongoDB/Mongoose
 * Stores all data in /data/*.json files
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

class JsonDB {
  constructor() {
    this.isConnected = false;
    this._cache = {};
    this._collections = [
      'stores', 'products', 'orders', 'invoices', 'customers', 'audit_logs', 'users',
      'onboarding_sessions', 'topups', 'buyer_wallets', 'seller_wallets', 'seller_deposits',
      'seller_withdrawals'
    ];
  }

  connect() {
    for (const col of this._collections) {
      const file = path.join(DATA_DIR, `${col}.json`);
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify([]), 'utf8');
      }
    }
    this.isConnected = true;
    logger.info('✅ JSON database ready at ' + DATA_DIR);
    return Promise.resolve(this);
  }

  disconnect() {
    this.isConnected = false;
    return Promise.resolve();
  }

  getStatus() {
    return { isConnected: this.isConnected, type: 'json-file', dir: DATA_DIR };
  }

  // Low-level read/write
  _read(collection) {
    const file = path.join(DATA_DIR, `${collection}.json`);
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return [];
    }
  }

  _write(collection, data) {
    const file = path.join(DATA_DIR, `${collection}.json`);
    const tmp = path.join(DATA_DIR, `.${collection}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  }
}

const db = new JsonDB();
module.exports = db;
