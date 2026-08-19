'use strict';

const { Repository } = require('../database/repository');
const { v4: uuidv4 } = require('uuid');

const repo = new Repository('orders', {
  buyerUsername: null,
  currency: 'IDR',
  status: 'pending',
  paymentMethod: null,
  paymentProofUrl: null,
  paymentProofFileId: null,
  invoiceId: null,
  invoiceUrl: null,
  expiresAt: null,
  paidAt: null,
  deliveredAt: null,
  deliveredItems: [],
  notes: null,
  metadata: {},
});

function wrapDoc(doc) {
  if (!doc) return null;
  doc.markPaid = async function() {
    this.status = 'paid';
    this.paidAt = new Date().toISOString();
    await Order.findOneAndUpdate({ _id: this._id }, { $set: { status: 'paid', paidAt: this.paidAt } });
  };
  doc.markCompleted = async function(deliveredItems) {
    this.status = 'completed';
    this.deliveredAt = new Date().toISOString();
    this.deliveredItems = deliveredItems;
    await Order.findOneAndUpdate({ _id: this._id }, { $set: { status: 'completed', deliveredAt: this.deliveredAt, deliveredItems } });
  };
  doc.save = async function() {
    const d = { ...this };
    delete d.save; delete d.markPaid; delete d.markCompleted;
    await repo.findOneAndUpdate({ _id: d._id }, { $set: d }, { new: true });
  };
  return doc;
}

const Order = {
  async create(data) {
    if (!data.orderId) data.orderId = `ORD-${uuidv4().slice(0, 8).toUpperCase()}`;
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
  async findOneAndDelete(filter) { return wrapDoc(await repo.findOneAndDelete(filter)); },
  async countDocuments(filter) { return repo.countDocuments(filter); },
  async aggregate(pipeline) { return repo.aggregate(pipeline); },
  async updateMany(filter, update) { return repo.updateMany(filter, update); },
};

module.exports = Order;
