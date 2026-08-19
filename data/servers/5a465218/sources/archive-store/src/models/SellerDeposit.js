'use strict';

const { Repository } = require('../database/repository');

const repo = new Repository('seller_deposits', {
  storeId: null,
  sellerId: null,
  sellerUsername: null,
  telegramId: null,
  phone: null,
  status: 'pending',
  spamStatus: 'unknown',
  spamMessage: null,
  spamCheckedAt: null,
  idCategory: null,
  price: 0,
  productId: null,
  productName: null,
  sessionFile: null,
  sessionReady: false,
  sellerLoggedOut: false,
  nonCurrentSessions: null,
  walletCredited: false,
  creditedAt: null,
  rejectionReason: null,
  metadata: {},
});

const SellerDeposit = {
  async create(data) { return repo.create(data); },
  find(filter) { return repo.find(filter); },
  async findOne(filter) { return repo.findOne(filter); },
  async findById(id) { return repo.findById(id); },
  async findOneAndUpdate(filter, update, opts = {}) { return repo.findOneAndUpdate(filter, update, opts); },
  async countDocuments(filter) { return repo.countDocuments(filter); },
};

module.exports = SellerDeposit;
