'use strict';

const { Repository } = require('../database/repository');
const Encryption = require('../utils/encryption');

const repo = new Repository('onboarding_sessions', {
  phoneNumber: null,
  encryptedSessionData: null,
  otpAttempts: 0,
  maxOtpAttempts: 3,
  activatedAt: null,
  revokedAt: null,
  revokedReason: null,
  metadata: {},
});

function wrapDoc(doc) {
  if (!doc) return null;
  // Decrypt session data
  if (doc.encryptedSessionData) {
    doc.encryptedSessionData = Encryption.decrypt(doc.encryptedSessionData);
  }
  Object.defineProperty(doc, 'isExpired', {
    get: function() { return new Date() > new Date(this.expiresAt); },
    enumerable: false,
    configurable: true,
  });
  doc.save = async function() {
    const d = { ...this };
    delete d.save; delete d.revoke;
    // Re-encrypt before write
    if (d.encryptedSessionData) d.encryptedSessionData = Encryption.encrypt(d.encryptedSessionData);
    await repo.findOneAndUpdate({ _id: d._id }, { $set: d }, { new: true });
  };
  doc.revoke = async function(reason = 'Manual revocation') {
    this.status = 'revoked';
    this.revokedAt = new Date().toISOString();
    this.revokedReason = reason;
    this.encryptedSessionData = null;
    await this.save();
  };
  return doc;
}

function encryptDoc(data) {
  const d = { ...data };
  if (d.encryptedSessionData) d.encryptedSessionData = Encryption.encrypt(d.encryptedSessionData);
  return d;
}

const OnboardingSession = {
  async create(data) {
    const encrypted = encryptDoc(data);
    const doc = await repo.create(encrypted);
    return wrapDoc(doc);
  },
  find(filter) {
    const q = repo.find(filter);
    const orig = q._exec.bind(q);
    q._exec = async () => (await orig()).map(wrapDoc);
    return q;
  },
  async findOne(filter) { return wrapDoc(await repo.findOne(filter)); },
  async findById(id) { return wrapDoc(await repo.findById(id)); },
  async findOneAndUpdate(filter, update, opts = {}) {
    if (update.$set?.encryptedSessionData) {
      update.$set.encryptedSessionData = Encryption.encrypt(update.$set.encryptedSessionData);
    }
    return wrapDoc(await repo.findOneAndUpdate(filter, update, opts));
  },
  async updateMany(filter, update) { return repo.updateMany(filter, update); },
  async countDocuments(filter) { return repo.countDocuments(filter); },
};

module.exports = OnboardingSession;
