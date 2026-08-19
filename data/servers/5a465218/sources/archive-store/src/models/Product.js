'use strict';

const { Repository } = require('../database/repository');

const repo = new Repository('products', {
  description: '',
  imageUrl: null,
  imageFileId: null,
  stockCount: 0,
  soldCount: 0,
  maxPerOrder: 10,
  status: 'active',
  productType: 'telegram_session',
  category: 'Telegram Accounts',
  metadata: {},
});

function wrapDoc(doc) {
  if (!doc) return null;
  Object.defineProperty(doc, 'isAvailable', {
    get: () => doc.status === 'active' && doc.stockCount > 0,
    enumerable: false,
    configurable: true,
  });
  doc.save = async function() {
    const d = { ...this };
    delete d.save;
    await Product.findOneAndUpdate({ _id: d._id }, { $set: d }, { new: true });
  };
  return doc;
}

const Product = {
  CATEGORIES: ['Telegram Accounts'],

  async create(data) {
    const doc = await repo.create({ productType: 'telegram_session', category: 'Telegram Accounts', ...data });
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
  async findByIdAndUpdate(id, update, opts = {}) { return wrapDoc(await repo.findByIdAndUpdate(id, update, opts)); },
  async findOneAndUpdate(filter, update, opts = {}) { return wrapDoc(await repo.findOneAndUpdate(filter, update, opts)); },
  async findOneAndDelete(filter) { return wrapDoc(await repo.findOneAndDelete(filter)); },
  async countDocuments(filter) { return repo.countDocuments(filter); },
  async updateMany(filter, update) { return repo.updateMany(filter, update); },
  async aggregate(pipeline) { return repo.aggregate(pipeline); },
};

module.exports = Product;
