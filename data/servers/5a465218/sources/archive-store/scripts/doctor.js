'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
let failed = false;

function ok(msg) { console.log(`✅ ${msg}`); }
function fail(msg) { failed = true; console.error(`❌ ${msg}`); }

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) fail(`Node.js >=18 diperlukan. Versi saat ini ${process.version}`);
else ok(`Node.js ${process.version}`);
ok(`Platform ${process.platform}/${process.arch}`);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
for (const name of Object.keys(pkg.dependencies || {})) {
  try { require.resolve(name, { paths: [ROOT] }); ok(`Dependency tersedia: ${name}`); }
  catch { fail(`Dependency tidak ditemukan: ${name}`); }
}

for (const dir of ['logs', 'uploads', 'data', 'data/sessions', 'data/seller_sessions']) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
  if (fs.existsSync(full)) ok(`Folder runtime siap: ${dir}`);
}

const envPath = path.join(ROOT, '.env');
if (!fs.existsSync(envPath)) {
  console.warn('⚠️ .env belum ada. Jalankan: npm run setup');
} else {
  ok('.env tersedia');
}

if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
  const requiredEnv = ['PLATFORM_BOT_TOKEN', 'PLATFORM_OWNER_ID', 'TG_API_ID', 'TG_API_HASH'];
  for (const name of requiredEnv) {
    if (String(process.env[name] || '').trim()) ok(`Konfigurasi tersedia: ${name}`);
    else fail(`Konfigurasi belum diisi: ${name}`);
  }
  for (const name of ['ENCRYPTION_KEY', 'JWT_SECRET', 'WEBHOOK_SECRET']) {
    const value = String(process.env[name] || '').trim();
    if (!value || /change-this-to-a-strong-random/.test(value)) fail(`Secret belum aman/diisi: ${name}`);
    else ok(`Secret tersedia: ${name}`);
  }
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`PORT tidak valid: ${process.env.PORT}`);
  else ok(`PORT valid: ${port}`);
}

const syntax = cp.spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'static-check.js')], { encoding: 'utf8' });
if (syntax.status !== 0) failed = true;

// Resolve local CommonJS imports without executing the application.
const src = path.join(ROOT, 'src');
const files = [];
(function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full);
    else if (ent.name.endsWith('.js')) files.push(full);
  }
})(src);
const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  let m;
  while ((m = re.exec(text))) {
    const req = m[1];
    if (!req.startsWith('.')) continue;
    try {
      const resolved = Module.createRequire(file).resolve(req);
      if (!resolved) throw new Error('module tidak dapat di-resolve');
    } catch (err) {
      fail(`Local require rusak: ${path.relative(ROOT, file)} -> ${req} (${err.message})`);
    }
  }
}

if (failed) {
  console.error('\nDoctor: FAILED');
  process.exit(1);
}
console.log('\nDoctor: ALL CHECKS PASSED');
