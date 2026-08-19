'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
for (const dir of ['logs', 'uploads', 'data', 'data/sessions', 'data/seller_sessions']) {
  fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
}

// Keep npm install self-contained: initialize the runtime folders and verify
// every external dependency that the application imports. No secrets are
// generated here; setup.js handles .env creation explicitly.
const required = [
  'axios', 'dotenv', 'express', 'joi', 'node-cron',
  'rate-limiter-flexible', 'telegraf', 'telegram', 'uuid',
  'winston', 'winston-daily-rotate-file'
];
const missing = [];
for (const name of required) {
  try { require.resolve(name); }
  catch { missing.push(name); }
}
if (missing.length) {
  console.error(`❌ Dependency check failed after npm install: ${missing.join(', ')}`);
  process.exit(1);
}

const check = cp.spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'static-check.js')], { stdio: 'inherit' });
if (check.status !== 0) process.exit(check.status || 1);

console.log('✅ npm install verification complete.');
console.log('➡ Next: npm run setup, edit .env, then npm start');
