'use strict';
const { Repository } = require('../database/repository');
const repo = new Repository('topups', { status: 'pending', paymentMethod: null, reference: null, proofFileId: null, rawResponse: {}, webhookEventId: null, webhookDeliveryId: null });
const Topup = {
  async create(data) { return repo.create(data); },
  find(filter) { return repo.find(filter); },
  async findOne(filter) { return repo.findOne(filter); },
  async findOneAndUpdate(filter, update, opts = {}) { return repo.findOneAndUpdate(filter, update, opts); },
};
module.exports = Topup;
