'use strict';

const { Repository } = require('../database/repository');

const repo = new Repository('customers', {
  username: null,
  firstName: null,
  lastName: null,
  languageCode: 'en',
  totalOrders: 0,
  totalSpent: 0,
  isBlocked: false,
  blockedReason: null,
  lastOrderAt: null,
  firstOrderAt: null,
  notes: null,
  metadata: {},
});

function wrapDoc(doc) {
  if (!doc) return null;
  doc.save = async function() {
    const d = { ...this };
    delete d.save; delete d.recordOrder;
    await Customer.findOneAndUpdate({ _id: d._id }, { $set: d }, { new: true });
  };
  doc.recordOrder = async function(amount) {
    this.totalOrders += 1;
    this.totalSpent += amount;
    const now = new Date().toISOString();
    this.lastOrderAt = now;
    if (!this.firstOrderAt) this.firstOrderAt = now;
    await this.save();
  };
  return doc;
}

const Customer = {
  async create(data) {
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
  async aggregate(pipeline) { return repo.aggregate(pipeline); },
};

module.exports = Customer;
