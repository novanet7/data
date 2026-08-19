'use strict';

const { Repository } = require('../database/repository');

const repo = new Repository('users', {
  username: null,
  firstName: null,
  lastName: null,
  role: 'user',
  stores: [],
  isPlatformBanned: false,
  bannedReason: null,
  lastSeen: null,
  registeredAt: null,
  apiKey: null,
  plan: 'free',
  // FIX: maxStores changed to 0 (= unlimited) by default.
  // 0 means no limit — can create as many stores as VPS can handle.
  maxStores: 0,
  metadata: {},
});

function wrapDoc(doc) {
  if (!doc) return null;
  if (!doc.lastSeen) doc.lastSeen = doc.createdAt;
  if (!doc.registeredAt) doc.registeredAt = doc.createdAt;
  if (!Array.isArray(doc.stores)) doc.stores = [];

  doc.canCreateStore = function() {
    if (this.isPlatformBanned) return false;
    // FIX: 0 or null/undefined means unlimited
    if (!this.maxStores || this.maxStores <= 0) return true;
    return this.stores.length < this.maxStores;
  };

  doc.isOwnerOf = function(storeId) {
    return this.stores.includes(storeId);
  };

  doc.save = async function() {
    const d = { ...this };
    delete d.save; delete d.canCreateStore; delete d.isOwnerOf;
    await repo.findOneAndUpdate({ _id: d._id }, { $set: d }, { new: true });
  };

  return doc;
}

const User = {
  async create(data) {
    if (!data.lastSeen) data.lastSeen = new Date().toISOString();
    if (!data.registeredAt) data.registeredAt = new Date().toISOString();
    // FIX: default maxStores to 0 (unlimited) for new users
    if (data.maxStores === undefined || data.maxStores === null) data.maxStores = 0;
    const doc = await repo.create(data);
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
  async findOneAndUpdate(filter, update, opts = {}) { return wrapDoc(await repo.findOneAndUpdate(filter, update, opts)); },
  async countDocuments(filter) { return repo.countDocuments(filter); },
  async updateMany(filter, update) { return repo.updateMany(filter, update); },
};

module.exports = User;
