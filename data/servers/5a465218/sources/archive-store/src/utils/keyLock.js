'use strict';

const locks = new Map();

async function withKeyLock(key, fn) {
  const k = String(key);
  const previous = locks.get(k) || Promise.resolve();
  let release;
  const next = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => next);
  locks.set(k, tail);
  await previous;
  try { return await fn(); }
  finally {
    release();
    if (locks.get(k) === tail) locks.delete(k);
  }
}

module.exports = { withKeyLock };
