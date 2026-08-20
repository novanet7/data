#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 18) {
  console.error(`❌ Node.js >=18 diperlukan. Versi saat ini ${process.version}`);
  process.exit(1);
}
const ENV_FILE = path.join(ROOT, '.env');
const EXAMPLE = path.join(ROOT, '.env.example');

for (const dir of ['logs', 'uploads', 'data', 'data/sessions', 'data/seller_sessions']) {
  fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
}

if (!fs.existsSync(ENV_FILE)) {
  let env = fs.readFileSync(EXAMPLE, 'utf8');
  env = env
    .replace('ENCRYPTION_KEY=change-this-to-a-strong-random-key', `ENCRYPTION_KEY=${crypto.randomBytes(16).toString('hex')}`)
    .replace('JWT_SECRET=change-this-to-a-strong-random-secret', `JWT_SECRET=${crypto.randomBytes(32).toString('hex')}`)
    .replace('WEBHOOK_SECRET=change-this-to-a-strong-random-secret', `WEBHOOK_SECRET=${crypto.randomBytes(16).toString('hex')}`);
  fs.writeFileSync(ENV_FILE, env);
  console.log('✅ .env dibuat dari .env.example');
} else {
  console.log('ℹ️ .env sudah ada');
}

console.log('✅ Folder runtime siap.');
console.log('➡ Isi PLATFORM_BOT_TOKEN, PLATFORM_OWNER_ID, TG_API_ID, dan TG_API_HASH di .env.');
console.log('➡ Setelah itu jalankan: npm run doctor && npm start');
