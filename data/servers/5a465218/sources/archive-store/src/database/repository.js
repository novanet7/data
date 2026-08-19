'use strict';

/**
 * Generic JSON repository — mimics a subset of Mongoose Model API
 * so existing code needs minimal changes.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const os = require('os');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// Serialize read-modify-write operations per collection so concurrent async
// handlers in the same bot process cannot overwrite each other's changes.
const collectionLocks = new Map();
async function withCollectionLock(name, fn) {
  const prev = collectionLocks.get(name) || Promise.resolve();
  let release;
  const next = new Promise(resolve => { release = resolve; });
  const tail = prev.then(() => next);
  collectionLocks.set(name, tail);
  await prev;
  try { return await fn(); }
  finally {
    release();
    if (collectionLocks.get(name) === tail) collectionLocks.delete(name);
  }
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readCollection(name) {
  ensureDir();
  const file = path.join(DATA_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '[]', 'utf8');
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function writeCollection(name, data) {
  ensureDir();
  const file = path.join(DATA_DIR, `${name}.json`);
  const tmp = path.join(DATA_DIR, `.${name}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  const payload = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

// Backups are scheduled globally/admin-managed; stock mutations do not trigger per-mutation backups.
// Deep-clone to avoid mutation of stored objects
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// Match a document against a MongoDB-style filter object
function matchFilter(doc, filter) {
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$or') {
      if (!value.some(f => matchFilter(doc, f))) return false;
      continue;
    }
    if (key === '$and') {
      if (!value.every(f => matchFilter(doc, f))) return false;
      continue;
    }
    const docVal = getNestedValue(doc, key);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // Query operators
      if ('$in' in value) {
        if (!value.$in.includes(docVal)) return false;
      } else if ('$nin' in value) {
        if (value.$nin.includes(docVal)) return false;
      } else if ('$ne' in value) {
        if (docVal === value.$ne) return false;
      } else if ('$gt' in value) {
        if (!(compareValues(docVal, value.$gt) > 0)) return false;
      } else if ('$gte' in value) {
        if (!(compareValues(docVal, value.$gte) >= 0)) return false;
      } else if ('$lt' in value) {
        if (!(compareValues(docVal, value.$lt) < 0)) return false;
      } else if ('$lte' in value) {
        if (!(compareValues(docVal, value.$lte) <= 0)) return false;
      } else if ('$exists' in value) {
        const exists = docVal !== undefined && docVal !== null;
        if (value.$exists !== exists) return false;
      } else if ('$regex' in value) {
        const flags = value.$options || '';
        if (!new RegExp(value.$regex, flags).test(String(docVal || ''))) return false;
      } else {
        // Plain object equality (partial match on nested)
        if (JSON.stringify(docVal) !== JSON.stringify(value)) return false;
      }
    } else {
      if (docVal !== value) return false;
    }
  }
  return true;
}

function compareValues(a, b) {
  const ad = a instanceof Date ? a.getTime() : (typeof a === 'string' && !Number.isNaN(Date.parse(a)) ? Date.parse(a) : null);
  const bd = b instanceof Date ? b.getTime() : (typeof b === 'string' && !Number.isNaN(Date.parse(b)) ? Date.parse(b) : null);
  if (ad !== null && bd !== null) return ad - bd;
  return a < b ? -1 : (a > b ? 1 : 0);
}

function getNestedValue(obj, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setNestedValue(obj, key, value) {
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function applyUpdate(doc, update) {
  if (!update || typeof update !== 'object') return;

  const { $set, $inc, $push, $pull, $setOnInsert, $unset, $addToSet } = update;

  if ($set) {
    for (const [k, v] of Object.entries($set)) setNestedValue(doc, k, v);
  }
  if ($inc) {
    for (const [k, v] of Object.entries($inc)) {
      const cur = getNestedValue(doc, k) || 0;
      setNestedValue(doc, k, cur + v);
    }
  }
  if ($push) {
    for (const [k, v] of Object.entries($push)) {
      if (!Array.isArray(getNestedValue(doc, k))) setNestedValue(doc, k, []);
      getNestedValue(doc, k).push(v);
    }
  }
  if ($pull) {
    for (const [k, v] of Object.entries($pull)) {
      const arr = getNestedValue(doc, k);
      if (Array.isArray(arr)) {
        setNestedValue(doc, k, arr.filter(item => item !== v));
      }
    }
  }
  if ($addToSet) {
    for (const [k, v] of Object.entries($addToSet)) {
      if (!Array.isArray(getNestedValue(doc, k))) setNestedValue(doc, k, []);
      const arr = getNestedValue(doc, k);
      if (!arr.includes(v)) arr.push(v);
    }
  }
  if ($unset) {
    for (const k of Object.keys($unset)) setNestedValue(doc, k, undefined);
  }
  // $setOnInsert is only applied during upsert insert — handled in findOneAndUpdate
}

function applySort(docs, sort) {
  if (!sort) return docs;
  return [...docs].sort((a, b) => {
    for (const [k, dir] of Object.entries(sort)) {
      const av = getNestedValue(a, k);
      const bv = getNestedValue(b, k);
      if (av < bv) return dir === 1 ? -1 : 1;
      if (av > bv) return dir === 1 ? 1 : -1;
    }
    return 0;
  });
}

function applyProjection(doc, select) {
  if (!select) return doc;
  const fields = typeof select === 'string'
    ? select.trim().split(/\s+/).filter(Boolean)
    : Object.keys(select);

  const include = fields.filter(f => select[f] !== 0 && !f.startsWith('-'));
  const exclude = fields.filter(f => f.startsWith('-')).map(f => f.slice(1));

  if (exclude.length > 0) {
    const result = clone(doc);
    for (const f of exclude) delete result[f];
    return result;
  }
  if (include.length > 0) {
    const result = { _id: doc._id };
    for (const f of include) setNestedValue(result, f, getNestedValue(doc, f));
    return result;
  }
  return doc;
}

class QueryChain {
  constructor(docs) {
    this._docs = docs;
    this._sort = null;
    this._limit = null;
    this._skip = 0;
    this._select = null;
    this._lean = false;
    this._populate = null;
  }

  sort(s) { this._sort = s; return this; }
  limit(n) { this._limit = n; return this; }
  skip(n) { this._skip = n; return this; }
  select(s) { this._select = s; return this; }
  lean() { this._lean = true; return this; }
  populate() { return this; } // no-op for JSON DB

  then(resolve, reject) {
    return this._exec().then(resolve, reject);
  }

  catch(fn) { return this._exec().catch(fn); }

  async _exec() {
    let docs = clone(this._docs);
    if (this._sort) docs = applySort(docs, this._sort);
    if (this._skip) docs = docs.slice(this._skip);
    if (this._limit) docs = docs.slice(0, this._limit);
    if (this._select) docs = docs.map(d => applyProjection(d, this._select));
    return docs;
  }
}

class Repository {
  constructor(name, defaults = {}) {
    this.name = name;
    this.defaults = defaults;
  }

  _now() { return new Date().toISOString(); }

  _newDoc(data) {
    const now = this._now();
    return {
      _id: uuidv4(),
      ...clone(this.defaults),
      ...clone(data),
      createdAt: data.createdAt || now,
      updatedAt: data.updatedAt || now,
    };
  }

  // --- Create ---

  async create(data) {
    return withCollectionLock(this.name, async () => {
      const docs = readCollection(this.name);
      const doc = this._newDoc(data);
      docs.push(doc);
      writeCollection(this.name, docs);
      return clone(doc);
    });
  }

  async insertMany(items, opts = {}) {
    return withCollectionLock(this.name, async () => {
      const docs = readCollection(this.name);
      const created = [];
      for (const item of items) {
        const doc = this._newDoc(item);
        docs.push(doc);
        created.push(clone(doc));
      }
      writeCollection(this.name, docs);
      return created;
    });
  }

  // --- Read ---

  findById(id) {
    const docs = readCollection(this.name);
    const doc = docs.find(d => d._id === id);
    return Promise.resolve(doc ? clone(doc) : null);
  }

  findOne(filter = {}) {
    const docs = readCollection(this.name);
    const doc = docs.find(d => matchFilter(d, filter));
    const result = doc ? clone(doc) : null;
    // Chainable
    const p = Promise.resolve(result);
    p.select = () => p;
    p.lean = () => p;
    p.populate = () => p;
    return p;
  }

  find(filter = {}) {
    const docs = readCollection(this.name);
    const matched = docs.filter(d => matchFilter(d, filter));
    return new QueryChain(matched);
  }

  async countDocuments(filter = {}) {
    const docs = readCollection(this.name);
    return docs.filter(d => matchFilter(d, filter)).length;
  }

  async aggregate(pipeline) {
    // Support a limited subset: $match, $group, $sort, $limit
    let docs = readCollection(this.name).map(clone);

    for (const stage of pipeline) {
      if (stage.$match) {
        docs = docs.filter(d => matchFilter(d, stage.$match));
      } else if (stage.$group) {
        const groupSpec = stage.$group;
        const groupId = groupSpec._id;
        const groups = {};

        for (const doc of docs) {
          const key = typeof groupId === 'string' && groupId.startsWith('$')
            ? getNestedValue(doc, groupId.slice(1))
            : JSON.stringify(groupId);

          if (!groups[key]) {
            groups[key] = { _id: typeof groupId === 'string' && groupId.startsWith('$')
              ? getNestedValue(doc, groupId.slice(1))
              : groupId };
          }

          for (const [field, expr] of Object.entries(groupSpec)) {
            if (field === '_id') continue;
            if (expr.$sum !== undefined) {
              const val = typeof expr.$sum === 'string' && expr.$sum.startsWith('$')
                ? (getNestedValue(doc, expr.$sum.slice(1)) || 0)
                : (expr.$sum || 0);
              groups[key][field] = (groups[key][field] || 0) + val;
            } else if (expr.$count !== undefined) {
              groups[key][field] = (groups[key][field] || 0) + 1;
            }
          }
        }

        docs = Object.values(groups);
      } else if (stage.$sort) {
        docs = applySort(docs, stage.$sort);
      } else if (stage.$limit) {
        docs = docs.slice(0, stage.$limit);
      } else if (stage.$skip) {
        docs = docs.slice(stage.$skip);
      }
    }

    return docs;
  }

  // --- Update ---

  async findByIdAndUpdate(id, update, opts = {}) {
    return withCollectionLock(this.name, async () => {
    const docs = readCollection(this.name);
    const beforeDocs = clone(docs);
    const idx = docs.findIndex(d => d._id === id);
    if (idx === -1) {
      if (opts.upsert) {
        const doc = this._newDoc({});
        doc._id = id;
        if (update.$setOnInsert) applyUpdate(doc, { $set: update.$setOnInsert });
        applyUpdate(doc, update);
        docs.push(doc);
        writeCollection(this.name, docs);
        return clone(doc);
      }
      return null;
    }
    applyUpdate(docs[idx], update);
    docs[idx].updatedAt = this._now();
    writeCollection(this.name, docs);
    return clone(docs[idx]);
    });
  }

  async findOneAndUpdate(filter, update, opts = {}) {
    return withCollectionLock(this.name, async () => {
    const docs = readCollection(this.name);
    const beforeDocs = clone(docs);
    let sort = opts.sort || null;
    let candidates = docs.filter(d => matchFilter(d, filter));
    if (sort) candidates = applySort(candidates, sort);

    const target = candidates[0];

    if (!target) {
      if (opts.upsert) {
        const doc = this._newDoc(filter);
        if (update.$setOnInsert) applyUpdate(doc, { $set: update.$setOnInsert });
        applyUpdate(doc, update);
        docs.push(doc);
        writeCollection(this.name, docs);
        return clone(doc);
      }
      return null;
    }

    const idx = docs.findIndex(d => d._id === target._id);
    applyUpdate(docs[idx], update);
    docs[idx].updatedAt = this._now();
    writeCollection(this.name, docs);
    return clone(opts.new ? docs[idx] : target);
    });
  }

  async updateMany(filter, update) {
    return withCollectionLock(this.name, async () => {
    const docs = readCollection(this.name);
    const beforeDocs = clone(docs);
    let modifiedCount = 0;
    for (const doc of docs) {
      if (matchFilter(doc, filter)) {
        applyUpdate(doc, update);
        doc.updatedAt = this._now();
        modifiedCount++;
      }
    }
    writeCollection(this.name, docs);
    return { modifiedCount };
    });
  }

  async updateOne(filter, update, opts = {}) {
    return withCollectionLock(this.name, async () => {
    const docs = readCollection(this.name);
    const beforeDocs = clone(docs);
    const idx = docs.findIndex(d => matchFilter(d, filter));
    if (idx === -1) {
      if (opts.upsert) {
        const doc = this._newDoc(filter);
        if (update.$setOnInsert) applyUpdate(doc, { $set: update.$setOnInsert });
        applyUpdate(doc, update);
        docs.push(doc);
        writeCollection(this.name, docs);
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }
    applyUpdate(docs[idx], update);
    docs[idx].updatedAt = this._now();
    writeCollection(this.name, docs);
    return { matchedCount: 1, modifiedCount: 1 };
    });
  }

  // --- Delete ---

  async findOneAndDelete(filter) {
    return withCollectionLock(this.name, async () => {
    const docs = readCollection(this.name);
    const idx = docs.findIndex(d => matchFilter(d, filter));
    if (idx === -1) return null;
    const [removed] = docs.splice(idx, 1);
    writeCollection(this.name, docs);
    return clone(removed);
    });
  }

  async deleteMany(filter) {
    return withCollectionLock(this.name, async () => {
    const docs = readCollection(this.name);
    const before = docs.length;
    const remaining = docs.filter(d => !matchFilter(d, filter));
    writeCollection(this.name, remaining);
    return { deletedCount: before - remaining.length };
    });
  }

  async deleteOne(filter) {
    return withCollectionLock(this.name, async () => {
    const docs = readCollection(this.name);
    const idx = docs.findIndex(d => matchFilter(d, filter));
    if (idx === -1) return { deletedCount: 0 };
    docs.splice(idx, 1);
    writeCollection(this.name, docs);
    return { deletedCount: 1 };
    });
  }

  // Alias
  async findByIdAndDelete(id) {
    return this.findOneAndDelete({ _id: id });
  }
}

module.exports = { Repository, readCollection, writeCollection };
