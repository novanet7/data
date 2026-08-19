'use strict';

const { Repository } = require('../database/repository');
const { v4: uuidv4 } = require('uuid');

const repo = new Repository('telepremium_orders', {
  orderId: null,
  storeId: null,
  buyerId: null,
  buyerName: null,
  buyerUsername: null,
  targetUsername: null,
  durationMonths: 0,
  deliveryType: null,
  productName: null,
  price: 0,
  status: 'pending', // pending | processing | completed | cancelled
  cancelReason: null,
  createdAt: null,
  processingAt: null,
  completedAt: null,
  cancelledAt: null,
  completedBy: null,
  cancelledBy: null,
  refundAmount: 0,
  refundTransactionId: null,
  metadata: {},
});

function wrap(doc) {
  if (!doc) return null;
  doc.save = async function () {
    const d = { ...this };
    delete d.save;
    await repo.findOneAndUpdate({ _id: d._id }, { $set: d }, { new: true });
  };
  return doc;
}

const TelePremiumOrder = {
  async create(data) {
    const now = new Date().toISOString();
    const orderId = data.orderId || `TPR-${uuidv4().slice(0, 8).toUpperCase()}`;
    const doc = await repo.create({ ...data, orderId, createdAt: data.createdAt || now });
    return wrap(doc);
  },
  find(filter) {
    const q = repo.find(filter);
    const exec = q._exec.bind(q);
    q._exec = async () => (await exec()).map(wrap);
    return q;
  },
  async findOne(filter) { return wrap(await repo.findOne(filter)); },
  async findOneAndUpdate(filter, update, opts = {}) { return wrap(await repo.findOneAndUpdate(filter, update, opts)); },
  async countDocuments(filter) { return repo.countDocuments(filter); },
};

module.exports = TelePremiumOrder;
