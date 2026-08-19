'use strict';

/**
 * Store model — backed by JSON file DB.
 * Extended schema includes bot lifecycle fields:
 *   botStatus, lastHeartbeat, lifecycleState, webhookMode, runtimeConfig
 */

const { Repository } = require('../database/repository');
const Encryption = require('../utils/encryption');

const repo = new Repository('stores', {
  settings: {
    storeName: 'My Digital Store',
    welcomeMessage: '👋 Welcome to our store!',
    thankYouMessage: '✅ Thank you for your purchase!',
    footerText: '',
    supportContact: '',
    currency: 'IDR',
    logoUrl: null,
    bannerUrl: null,
    bannerFileId: null,
    bannerType: null, // 'photo' | 'video' | 'animation'
    welcomeStickerFileId: null,
    notifyOwnerOnSale: true,
    autoDelivery: true,
    maintenanceMode: false,
    salesChannelId: null,
    sellerPricing: { enabled: true, prices: {}, fsPrices: {}, nfsPrices: {} },
    idPricing: { enabled: true, prices: {}, fsPrices: {}, nfsPrices: {} },
    telepremium: { enabled: false, prices: { 1: 0, 3: 0, 6: 0, 12: 0 } },
  },
  paymentSettings: {
    qris: { enabled: false, imageUrl: null, paymentName: null },
    valqenix: { enabled: false, apiKey: null, webhookSecret: null, sandbox: false },
  },
  status: 'active',
  plan: 'free',
  stats: { totalOrders: 0, totalRevenue: 0, totalProducts: 0, totalCustomers: 0 },
  webhookUrl: null,
  lastActive: null,
  webhookMode: false,
  // ── Lifecycle fields ──────────────────────────────────────────────────────
  botStatus:     'stopped',   // running | stopped | error | suspended
  lifecycleState: 'idle',     // idle | loading | running | stopping | stopped | error
  lastHeartbeat: null,
  expiresAt: null,            // ISO string — null = no expiry (legacy)
  runtimeConfig: {
    autoRestart: true,
    lastError: null,
    startedAt: null,
    restartCount: 0,
  },
});

// ─── Encryption helpers ────────────────────────────────────────────────────

function encryptDoc(data) {
  const d = { ...data };
  if (d.botToken && !_isEncrypted(d.botToken)) d.botToken = Encryption.encrypt(d.botToken);
  if (d.paymentSettings) {
    const ps = { ...d.paymentSettings };
    if (ps.valqenix?.apiKey && !_isEncrypted(ps.valqenix.apiKey)) ps.valqenix = { ...ps.valqenix, apiKey: Encryption.encrypt(ps.valqenix.apiKey) };
    if (ps.valqenix?.webhookSecret && !_isEncrypted(ps.valqenix.webhookSecret)) ps.valqenix = { ...ps.valqenix, webhookSecret: Encryption.encrypt(ps.valqenix.webhookSecret) };
    d.paymentSettings = ps;
  }
  for (const key of ['paymentSettings.valqenix.apiKey', 'paymentSettings.valqenix.webhookSecret']) {
    if (Object.prototype.hasOwnProperty.call(d, key) && d[key] && !_isEncrypted(d[key])) d[key] = Encryption.encrypt(d[key]);
  }
  return d;
}

function decryptDoc(doc) {
  if (!doc) return null;
  if (doc.botToken)                         doc.botToken = Encryption.decrypt(doc.botToken);
  if (doc.paymentSettings?.valqenix?.apiKey) doc.paymentSettings.valqenix.apiKey = Encryption.decrypt(doc.paymentSettings.valqenix.apiKey);
  if (doc.paymentSettings?.valqenix?.webhookSecret) doc.paymentSettings.valqenix.webhookSecret = Encryption.decrypt(doc.paymentSettings.valqenix.webhookSecret);
  return doc;
}

/** Detect if a string is already AES-CBC encrypted (iv:ciphertext hex pattern) */
function _isEncrypted(val) {
  if (!val || typeof val !== 'string') return false;
  const parts = val.split(':');
  return parts.length >= 2 && /^[0-9a-f]{32}$/i.test(parts[0]);
}

// ─── Document wrapper (adds instance methods) ──────────────────────────────

function wrapDoc(doc) {
  if (!doc) return null;
  decryptDoc(doc);

  doc.isOwner = function (telegramId) {
    const configured = String(process.env.PLATFORM_OWNER_IDS || '').trim();

    const ownerIds = configured
      ? configured.split(',').map(id => id.trim()).filter(Boolean)
      : [];

    if (this.ownerId != null) {
      ownerIds.push(String(this.ownerId));
    }

    return ownerIds.includes(String(telegramId));
  };

  doc.save = async function () {
    const d = { ...this };
    ['save', 'isOwner', 'updateStats', 'markBotStatus'].forEach(k => delete d[k]);
    const toSave = encryptDoc(d);
    await repo.findOneAndUpdate({ _id: this._id }, { $set: toSave }, { new: true });
  };

  doc.updateStats = async function (field, increment = 1) {
    this.stats[field] = (this.stats[field] || 0) + increment;
    await this.save();
  };

  doc.markBotStatus = async function (status) {
    this.botStatus = status;
    this.lifecycleState = status;
    this.lastHeartbeat = new Date().toISOString();
    await Store.findOneAndUpdate(
      { _id: this._id },
      { $set: { botStatus: status, lifecycleState: status, lastHeartbeat: this.lastHeartbeat } }
    );
  };

  return doc;
}

// ─── Public API ────────────────────────────────────────────────────────────

const Store = {
  async create(data) {
    if (!data.lastActive) data.lastActive = new Date().toISOString();
    if (!data.runtimeConfig) data.runtimeConfig = { autoRestart: true, lastError: null, startedAt: null, restartCount: 0 };
    const doc = await repo.create(encryptDoc(data));
    return wrapDoc(doc);
  },

  find(filter) {
    const q = repo.find(filter);
    const orig = q._exec.bind(q);
    q._exec = async () => (await orig()).map(wrapDoc);
    return q;
  },

  findOne(filter) {
    let _sel = null;
    const obj = {
      select(s) { _sel = s; return obj; },
      lean()    { return obj; },
      populate(){ return obj; },
      then(resolve, reject) {
        return repo.findOne(filter)
          .then(doc => wrapDoc(doc))
          .then(resolve, reject);
      },
      catch(fn) { return this.then(undefined, fn); },
    };
    return obj;
  },

  async findById(id) {
    return wrapDoc(await repo.findById(id));
  },

  async findOneAndUpdate(filter, update, opts = {}) {
    // Encrypt sensitive fields inside $set
    if (update.$set) {
      const encrypted = encryptDoc(update.$set);
      update = { ...update, $set: encrypted };
    }
    return wrapDoc(await repo.findOneAndUpdate(filter, update, opts));
  },

  async findByIdAndUpdate(id, update, opts = {}) {
    if (update.$set) update = { ...update, $set: encryptDoc(update.$set) };
    return wrapDoc(await repo.findByIdAndUpdate(id, update, opts));
  },

  async updateMany(filter, update) { return repo.updateMany(filter, update); },
  async countDocuments(filter)     { return repo.countDocuments(filter); },
  async aggregate(pipeline)        { return repo.aggregate(pipeline); },
};

module.exports = Store;
