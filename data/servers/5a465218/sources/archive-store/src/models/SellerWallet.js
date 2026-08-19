'use strict';

const { Repository } = require('../database/repository');

const repo = new Repository('seller_wallets', {
  storeId: null,
  sellerId: null,
  balance: 0,
  totalEarned: 0,
  totalWithdrawn: 0,
  transactions: [],
  currency: 'IDR',
  metadata: {},
});

const SellerWallet = {
  async create(data) { return repo.create(data); },
  async findOne(filter) { return repo.findOne(filter); },
  async findOneAndUpdate(filter, update, opts = {}) { return repo.findOneAndUpdate(filter, update, opts); },
  async resetAllBalances(filter = {}) {
    return repo.updateMany(filter, {
      $set: { balance: 0 }
    });
  },
};

module.exports = SellerWallet;
