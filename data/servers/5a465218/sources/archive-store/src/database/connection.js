'use strict';
const logger = require('../utils/logger');
const { querySync } = require('../pg-sync');
class PostgresDB {
  constructor() { this.isConnected = false; }
  connect() {
    querySync('SELECT 1');
    this.isConnected = true;
    logger.info('✅ PostgreSQL database ready');
    return Promise.resolve(this);
  }
  disconnect() { this.isConnected = false; return Promise.resolve(); }
  getStatus() { return { isConnected: this.isConnected, type: 'postgresql' }; }
}
module.exports = new PostgresDB();
