'use strict';

const { Repository } = require('../database/repository');

const repo = new Repository('seller_withdrawals', {
  storeId: null,
  sellerId: null,
  sellerUsername: null,
  bankName: null,
  accountNumber: null,
 accountName: null,
  amount: 0,
  status: 'pending', // pending | approved | rejected
  rejectionReason: null,
  processedAt: null,
  processedBy: null,
  balanceAtRequest: 0,
  balanceAfterHold: 0,
  balanceHeld: false,
  metadata: {},
});

const SellerWithdrawal = {
  async create(data) { return repo.create(data); },
  find(filter) { return repo.find(filter); },
  async findOne(filter) { return repo.findOne(filter); },
  async findOneAndUpdate(filter, update, opts = {}) { return repo.findOneAndUpdate(filter, update, opts); },
};

module.exports = SellerWithdrawal;
