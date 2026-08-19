'use strict';

const Joi = require('joi');
const axios = require('axios');
const logger = require('./logger');

class Validators {
  static async validateBotToken(token) {
    try {
      const response = await axios.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 10000 });
      if (response.data.ok) return { valid: true, bot: response.data.result };
      return { valid: false, error: 'Invalid token' };
    } catch (error) {
      if (error.response?.status === 401) {
        return { valid: false, error: 'Invalid or expired bot token' };
      }

      logger.error('[Validators] Bot token validation failed:', {
        message: error?.message,
        code: error?.code,
        status: error?.response?.status,
        data: error?.response?.data,
      });

      return {
        valid: false,
        error: `Failed to validate token: ${error?.code || error?.message || 'Unknown error'}`,
      };
    }
  }

  static isValidTelegramId(id) { return /^\d+$/.test(String(id)); }
  static isBotTokenFormat(token) {
    return !!token && typeof token === 'string' && /^\d{8,12}:[A-Za-z0-9_-]{35,}$/.test(token.trim());
  }

  static productSchema = Joi.object({
    name: Joi.string().min(2).max(100).required(),
    description: Joi.string().max(1000).optional(),
    price: Joi.number().min(0).required(),
    category: Joi.string().valid('Telegram Accounts').required(),
    maxPerOrder: Joi.number().integer().min(1).max(100).default(10),
  });

  static storeSettingsSchema = Joi.object({
    storeName: Joi.string().min(2).max(100).required(),
    welcomeMessage: Joi.string().max(500).optional(),
    thankYouMessage: Joi.string().max(500).optional(),
    footerText: Joi.string().max(200).optional(),
    supportContact: Joi.string().max(100).optional(),
    currency: Joi.string().valid('IDR').default('IDR'),
  });

  static validateProduct(data) { return this.productSchema.validate(data, { abortEarly: false }); }
  static validateStoreSettings(data) { return this.storeSettingsSchema.validate(data, { abortEarly: false }); }
  static sanitizeText(text) { return String(text || '').replace(/[<>]/g, '').trim().slice(0, 4096); }

  static formatCurrency(amount) {
    return new Intl.NumberFormat('id-ID', {
      style: 'currency', currency: 'IDR', minimumFractionDigits: 0,
    }).format(amount);
  }
}

module.exports = Validators;
