'use strict';

const crypto = require('crypto');
const logger = require('./logger');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default-32-char-key-for-dev-only!';
const IV_LENGTH = 16;
const ALGORITHM = 'aes-256-cbc';

class Encryption {
  /**
   * Encrypt sensitive data using AES-256-CBC
   */
  static encrypt(text) {
    if (!text) return null;
    try {
      const iv = crypto.randomBytes(IV_LENGTH);
      const key = Buffer.from(ENCRYPTION_KEY.slice(0, 32).padEnd(32, '0'));
      const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
      let encrypted = cipher.update(String(text), 'utf8', 'hex');
      encrypted += cipher.final('hex');
      return `${iv.toString('hex')}:${encrypted}`;
    } catch (error) {
      logger.error('Encryption error:', error.message);
      throw new Error('Failed to encrypt data');
    }
  }

  /**
   * Decrypt AES-256-CBC encrypted data
   */
  static decrypt(encryptedText) {
    if (!encryptedText) return null;
    try {
      const parts = encryptedText.split(':');
      if (parts.length < 2) return encryptedText; // not encrypted, return as-is
      const ivHex = parts[0];
      const encrypted = parts.slice(1).join(':');
      const iv = Buffer.from(ivHex, 'hex');
      const key = Buffer.from(ENCRYPTION_KEY.slice(0, 32).padEnd(32, '0'));
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (error) {
      // Return raw value if decrypt fails (e.g., not encrypted)
      return encryptedText;
    }
  }

  /**
   * Hash sensitive data (one-way)
   */
  static hash(data) {
    return crypto.createHash('sha256').update(String(data)).digest('hex');
  }

  /**
   * Generate secure random token
   */
  static generateToken(length = 32) {
    return crypto.randomBytes(length).toString('hex');
  }

  /**
   * Generate numeric OTP
   */
  static generateOTP(length = 6) {
    const digits = '0123456789';
    let otp = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
      otp += digits[bytes[i] % 10];
    }
    return otp;
  }

  /**
   * Verify HMAC signature (webhook validation)
   */
  static verifyHmac(payload, signature, secret) {
    try {
      const computed = crypto
        .createHmac('sha256', secret)
        .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
        .digest('hex');
      const sig = signature.replace('sha256=', '');
      return crypto.timingSafeEqual(
        Buffer.from(computed, 'hex'),
        Buffer.from(sig, 'hex')
      );
    } catch {
      return false;
    }
  }

  /**
   * Mask sensitive string for safe logging
   */
  static mask(str, visibleChars = 4) {
    if (!str || str.length <= visibleChars * 2) return '***';
    return str.slice(0, visibleChars) + '***' + str.slice(-visibleChars);
  }
}

module.exports = Encryption;
