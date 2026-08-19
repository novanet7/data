'use strict';

// Process-local mutex for inventory mutations. All stock/session mutations in this
// application run in one Node process, so serializing them prevents two callbacks
// from reserving/writing the same inventory at the same time.
const locks = new Map();

async function withInventoryLock(storeId, productId, fn) {
  const key = `${String(storeId)}:${String(productId)}`;
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const next = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => next);
  locks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

module.exports = { withInventoryLock };
