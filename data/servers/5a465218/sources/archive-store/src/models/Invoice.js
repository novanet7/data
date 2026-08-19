'use strict';

const { Repository } = require('../database/repository');
const { v4: uuidv4 } = require('uuid');

const repo = new Repository('invoices', {
  currency: 'IDR',
  externalId: null,
  qrCodeUrl: null,
  paymentUrl: null,
  virtualAccount: null,
  status: 'pending',
  expiresAt: null,
  paidAt: null,
  rawResponse: {},
  webhookPayload: {},
});

function wrapDoc(doc) {
  if (!doc) return null;
  doc.save = async function() {
    const d = { ...this };
    delete d.save;
    await repo.findOneAndUpdate({ _id: d._id }, { $set: d }, { new: true });
  };
  return doc;
}

const Invoice = {
  async create(data) {
    if (!data.invoiceId) data.invoiceId = `INV-${Date.now()}-${uuidv4().slice(0, 6).toUpperCase()}`;
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

module.exports = Invoice;
