'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const axios = require('axios');
const { Telegraf } = require('telegraf');

let bot = null;
let ownerId = null;
let db = null;
let tenant = null;
let timer = null;
let poller = null;
let running = false;
let pendingReason = null;
let lastTenantSignature = '';
let lastBackup = null;
let lastContentSignature = '';
let retryTimer = null;
let ready = false;
let readyResolve = null;
let readyPromise = Promise.resolve();
let suppressedUntil = 0;
let startupStateSignature = '';
let retryMs = Number(process.env.SAAS_BACKUP_RETRY_MS || 15000);
const DEBOUNCE_MS = Number(process.env.SAAS_BACKUP_DEBOUNCE_MS || 7000);
const POLL_MS = Number(process.env.SAAS_BACKUP_POLL_MS || 3000);
const TMP_ROOT = path.join(os.tmpdir(), 'telegram-saas-backups');
const DATA_ROOT = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const OUTBOX_ROOT = path.join(DATA_ROOT, 'backup-outbox');
let backupSendChain = Promise.resolve();
fs.mkdirSync(TMP_ROOT, { recursive: true });
fs.mkdirSync(OUTBOX_ROOT, { recursive: true });

function safeName(v) { return String(v || 'backup').replace(/[^a-zA-Z0-9._-]/g, '_'); }
function nowStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
function settings() { return db?.settings?.() || {}; }
function setSetting(k, v) { if (db?.setSetting) db.setSetting(k, v); }

function backupConfig() {
  const b = settings().backup || {};
  const customReady = b.mode === 'custom' && !!b.tokenEnc && !!decryptSecret(b.tokenEnc);
  return {
    enabled: b.enabled !== false,
    // No custom bot configured = always use the main SaaS bot.
    mode: customReady ? 'custom' : 'saas',
    chatId: b.chatId ? Number(b.chatId) : Number(ownerId),
    botUsername: customReady ? (b.botUsername || null) : null,
    tokenEnc: customReady ? b.tokenEnc : null
  };
}
function deriveBackupKey() {
  const seed = `${process.env.SAAS_BOT_TOKEN || ''}:${ownerId || ''}:telegram-saas-backup-v1`;
  return crypto.createHash('sha256').update(seed).digest();
}
function encryptSecret(value) {
  if (!value) return null;
  const key = deriveBackupKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${data.toString('base64')}`;
}
function decryptSecret(value) {
  if (!value) return null;
  try {
    const [ivB64, tagB64, dataB64] = String(value).split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveBackupKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch { return null; }
}
async function validateBackupBot(token) {
  if (!token || !/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(String(token))) throw new Error('Token bot backup tidak valid.');
  const t = new Telegraf(String(token));
  const me = await t.telegram.getMe();
  return { token: String(token), username: me.username || '', firstName: me.first_name || '' };
}
async function configureBackupDestination({ mode = 'saas', token = null, chatId = null }) {
  mode = mode === 'custom' ? 'custom' : 'saas';
  if (mode === 'saas') {
    setSetting('backup', { enabled: true, mode: 'saas', chatId: Number(chatId || ownerId), botUsername: null, tokenEnc: null });
    // A destination change must not reuse the previous sender's Telegram file_id.
    // Force the next backup cycle to create/send a fresh global snapshot to the new destination.
    lastContentSignature = '';
    lastBackup = null;
    await forceBackup('backup-destination-configured:saas');
    return { mode: 'saas', chatId: Number(chatId || ownerId), botUsername: null };
  }
  const validated = await validateBackupBot(token);
  const target = Number(chatId || ownerId);
  if (!Number.isFinite(target) || target === 0) throw new Error('Chat ID owner backup tidak valid.');
  setSetting('backup', { enabled: true, mode: 'custom', chatId: target, botUsername: validated.username || null, tokenEnc: encryptSecret(validated.token) });
  // Immediately prove the destination works with a fresh global snapshot. This
  // also guarantees the first automatic backup is actually delivered by the
  // newly selected bot instead of waiting for a later state change.
  await forceBackup('backup-destination-configured');
  // Telegram file_id values belong to the bot that originally uploaded the file.
  // Never treat a file_id from Bot SaaS as transferable to the custom backup bot.
  // Force a fresh snapshot/upload for the newly selected destination.
  lastContentSignature = '';
  lastBackup = null;
  return { mode: 'custom', chatId: target, botUsername: validated.username || null };
}
async function testBackupDestination() {
  const dest = backupTelegram();
  if (dest.mode === 'custom') {
    const me = await new Telegraf(decryptSecret(settings().backup?.tokenEnc)).telegram.getMe();
    return { ok: true, mode: dest.mode, username: me.username || null, chatId: dest.chatId };
  }
  const me = await bot.telegram.getMe();
  return { ok: true, mode: dest.mode, username: me.username || null, chatId: dest.chatId };
}
function backupDestinationInfo() {
  const cfg = backupConfig();
  return { enabled: cfg.enabled, mode: cfg.mode, chatId: cfg.chatId, botUsername: cfg.botUsername };
}
function backupTelegram() {
  const cfg = backupConfig();
  if (cfg.mode === 'custom') {
    const token = decryptSecret(cfg.tokenEnc);
    if (!token) throw new Error('Token bot backup custom tidak dapat dibaca. Set ulang bot backup.');
    return { telegram: new Telegraf(token).telegram, chatId: cfg.chatId, mode: 'custom', botUsername: cfg.botUsername };
  }
  if (!bot) throw new Error('Bot SaaS belum diinisialisasi.');
  return { telegram: bot.telegram, chatId: cfg.chatId, mode: 'saas', botUsername: null };
}
function tenantRoot(rec) { return tenant.dir(rec.type, rec.ownerId); }

function listSessionFiles(root) {
  const out = [];
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name.endsWith('.session')) out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

function queue(reason = 'state-change') {
  // Never drop a persistent change. During startup we remember the event and
  // flush it as soon as markReady() is called.
  if (!ready || Date.now() < suppressedUntil) {
    pendingReason = pendingReason ? `${pendingReason},${reason}` : reason;
    return;
  }
  pendingReason = pendingReason ? `${pendingReason},${reason}` : reason;
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (running) {
      return;
    }
    const why = pendingReason;
    pendingReason = null;
    timer = null;
    flush(why).catch(e => {
      console.error('[SAAS BACKUP] flush failed:', e.message);
      scheduleRetry();
    });
  }, DEBOUNCE_MS);
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    const why = pendingReason || 'retry-after-send-failure';
    if (!pendingReason) pendingReason = why;
    flush(why).catch(e => {
      console.error('[SAAS BACKUP] retry failed:', e.message);
      retryMs = Math.min(retryMs * 2, 5 * 60 * 1000);
      scheduleRetry();
    });
  }, retryMs);
  retryTimer.unref?.();
}

function hashFile(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function copyTree(src, dst, filter) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (filter && !filter(ent.name, src)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyTree(s, d, filter);
    else if (ent.isSymbolicLink()) {
      try { fs.symlinkSync(fs.readlinkSync(s), d); } catch {}
    } else fs.copyFileSync(s, d);
  }
}

function copyTenantRuntime(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  const excluded = new Set(['src', 'node_modules', '.git', 'logs', 'backups', 'tmp', 'cache']);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (excluded.has(ent.name)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyTree(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

function stableSaasState() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'saas.json'), 'utf8'));
    if (raw && raw.settings) delete raw.settings.lastBackup;
    if (raw && raw.tenants && typeof raw.tenants === 'object') {
      for (const [k, rec] of Object.entries(raw.tenants)) {
        if (!rec || typeof rec !== 'object') continue;
        for (const transient of ['status','pid','dir','logs','exitCode','signal','updatedAt']) delete rec[transient];
      }
    }
    return raw;
  } catch {
    return null;
  }
}

function readJsonSafe(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Auto Comment + Jaseb intentionally backs up only the configuration/state
// needed to reconstruct the service. Monitoring logs, counters, sent history,
// transient sender flags, UI metadata, and other runtime noise are excluded.
function jasebPersistentStateFromRoot(root) {
  const file = path.join(root, 'data', 'app.json');
  const raw = readJsonSafe(file, {}) || {};
  const accounts = Array.isArray(raw.accounts) ? raw.accounts.map(a => ({
    id: a.id,
    owner_id: a.owner_id,
    enabled: a.enabled,
    phone: a.phone || '',
    session: a.session || '',
    telegram_user_id: a.telegram_user_id || '',
    username: a.username || '',
    label: a.label || ''
  })) : [];
  const keywords = Array.isArray(raw.keywords) ? raw.keywords.map(k => ({
    id: k.id,
    owner_id: k.owner_id,
    target_id: k.target_id ?? null,
    word: k.word || '',
    comment: k.comment || '',
    enabled: k.enabled !== 0,
    created_at: k.created_at || null
  })) : [];
  const targets = Array.isArray(raw.targets) ? raw.targets.map(t => ({
    id: t.id,
    owner_id: t.owner_id,
    enabled: t.enabled !== 0,
    account_id: t.account_id,
    channel_ref: t.channel_ref || '',
    channel_peer_id: t.channel_peer_id || '',
    channel_title: t.channel_title || '',
    discussion_ref: t.discussion_ref || '',
    discussion_peer_id: t.discussion_peer_id || '',
    discussion_title: t.discussion_title || '',
    created_at: t.created_at || null
  })) : [];
  const jaseb = {};
  if (raw.jaseb && typeof raw.jaseb === 'object') {
    for (const [owner, value] of Object.entries(raw.jaseb)) {
      if (!value || typeof value !== 'object') continue;
      jaseb[owner] = {
        // Required to restore the Jaseb configuration itself.
        text: value.text || '',
        interval_min: value.interval_min ?? null,
        groups: Array.isArray(value.groups) ? value.groups : [],
        enabled: value.enabled === true
      };
    }
  }
  return { version: 1, accounts, keywords, targets, jaseb };
}

function writeJasebPersistentState(root, state) {
  const out = path.join(root, 'data', 'app.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    users: [],
    accounts: state.accounts || [],
    keywords: state.keywords || [],
    targets: state.targets || [],
    logs: [],
    sender: {},
    sent: [],
    meta: {},
    jaseb: state.jaseb || {}
  }, null, 2));
}

function contentSignature() {
  const h = crypto.createHash('sha256');
  const hashFileContent = (file, label) => {
    try {
      const st = fs.statSync(file);
      h.update(label);
      h.update(String(st.size));
      h.update(fs.readFileSync(file));
    } catch {}
  };
  const stable = stableSaasState();
  if (stable) h.update(`SAAS:${JSON.stringify(stable)}`);

  const hashTree = (root, label) => {
    if (!fs.existsSync(root)) return;
    const files = [];
    const walk = dir => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
        if (['logs','backups','tmp','cache','.git','node_modules'].includes(ent.name)) continue;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.isFile()) files.push(p);
      }
    };
    walk(root);
    for (const file of files.sort()) hashFileContent(file, `${label}${path.relative(root,file)}:`);
  };
  hashTree(path.join(__dirname, '..', 'catalog'), 'CAT:');
  hashTree(path.join(__dirname, '..', 'emoji'), 'EMO:');

  const tenants = db.listTenants().sort((a,b)=>String(a.type+a.ownerId).localeCompare(String(b.type+b.ownerId)));
  for (const rec of tenants) {
    h.update(`TENANT:${rec.type}:${rec.ownerId}`);
    const root = tenantRoot(rec);
    if (rec.type === 'auto-comment-jaseb') {
      const state = jasebPersistentStateFromRoot(root);
      h.update(`JASEB:${JSON.stringify(state)}`);
      continue;
    }
    const sessionRoots = [
      path.join(root, 'sessions'),
      path.join(root, 'seller_sessions'),
      path.join(root, 'data', 'sessions'),
      path.join(root, 'data', 'seller_sessions')
    ];
    for (const sr of sessionRoots) {
      const files = listSessionFiles(sr);
      for (const rel of files) {
        const full = path.join(sr, rel);
        try {
          const st = fs.statSync(full);
          h.update(`SESSION:${rec.type}:${rec.ownerId}:${path.relative(root,sr)}:${rel}:${st.size}:${st.mtimeMs}`);
        } catch {}
      }
    }
    // Cover every persistent tenant database/config file, not only JSON.
    // This catches SQLite/DB files used by TagAll as well as store.json and
    // archive data, so an un-sent change made shortly before a hard crash is
    // detected on the next startup. Volatile/runtime folders are excluded.
    const dataDir = path.join(root, 'data');
    if (!fs.existsSync(dataDir)) continue;
    const files = [];
    const walk = dir => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
        if (['logs','backups','tmp','cache','.git','node_modules','sessions','seller_sessions','runtime','uploads'].includes(ent.name)) continue;
        const fp = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(fp);
        else if (ent.isFile() && !ent.name.endsWith('.lock') && !ent.name.endsWith('.tmp')) files.push(fp);
      }
    };
    walk(dataDir);
    for (const file of files.sort()) {
      try {
        const st = fs.statSync(file);
        h.update(`DATA:${rec.type}:${rec.ownerId}:${path.relative(dataDir,file)}:${st.size}:${st.mtimeMs}`);
      } catch {}
    }
  }
  return h.digest('hex');
}


function outboxFileName(prefix, stamp = nowStamp()) {
  return `${safeName(prefix)}-${stamp}-${process.pid}-${crypto.randomBytes(3).toString('hex')}.zip`;
}

function stageOutbox(zipPath, reason) {
  fs.mkdirSync(OUTBOX_ROOT, { recursive: true });
  const staged = path.join(OUTBOX_ROOT, outboxFileName(`pending-${reason}`));
  fs.copyFileSync(zipPath, staged);
  return staged;
}

function clearOutbox() {
  for (const file of listOutbox()) { try { fs.rmSync(file, { force: true }); } catch {} }
}

function listOutbox() {
  if (!fs.existsSync(OUTBOX_ROOT)) return [];
  return fs.readdirSync(OUTBOX_ROOT, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.zip'))
    .map(e => path.join(OUTBOX_ROOT, e.name))
    .sort((a,b) => a.localeCompare(b));
}

async function sendOutboxIfAny() {
  const files = listOutbox();
  if (!files.length) return 0;
  let sent = 0;
  for (const file of files) {
    const dest = backupTelegram();
    const stream = fs.createReadStream(file);
    await dest.telegram.sendDocument(dest.chatId, { source: stream, filename: path.basename(file) }, {
      caption: `📦 <b>Backup SaaS Pending Recovery</b>\n\n✅ Backup yang tertunda sebelum restart/server down berhasil dikirim ulang.\n🕐 ${new Date().toLocaleString('id-ID')}`,
      parse_mode: 'HTML'
    });
    fs.rmSync(file, { force: true });
    sent += 1;
  }
  return sent;
}


// Build a standards-compliant ZIP using Node.js only. This avoids depending on
// the host having the `zip` CLI installed (which caused ENOENT on Pterodactyl).
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return { time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2), date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() };
}
function zipWriteU16(b, o, v) { b.writeUInt16LE(v & 0xFFFF, o); }
function zipWriteU32(b, o, v) { b.writeUInt32LE(v >>> 0, o); }
function collectZipEntries(root) {
  const entries = [];
  const walk = (dir, rel='') => {
    const names = fs.readdirSync(dir).sort((a,b)=>a.localeCompare(b));
    for (const name of names) {
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(full);
      if (st.isDirectory()) {
        entries.push({ name: `${r}/`, data: Buffer.alloc(0), mtime: st.mtime });
        walk(full, r);
      } else if (st.isFile()) {
        entries.push({ name: r, data: fs.readFileSync(full), mtime: st.mtime });
      }
    }
  };
  walk(root);
  return entries;
}
function writeZipFile(root, outFile) {
  const entries = collectZipEntries(root);
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data;
    if (name.length > 0xFFFF || data.length > 0xFFFFFFFF || offset > 0xFFFFFFFF) throw new Error('Backup terlalu besar untuk ZIP classic (>4GB atau nama file terlalu panjang).');
    const { time, date } = dosDateTime(e.mtime);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    zipWriteU32(local, 0, 0x04034B50);
    zipWriteU16(local, 4, 20);
    zipWriteU16(local, 6, 0);
    zipWriteU16(local, 8, 0); // stored / no compression
    zipWriteU16(local, 10, time);
    zipWriteU16(local, 12, date);
    zipWriteU32(local, 14, crc);
    zipWriteU32(local, 18, data.length);
    zipWriteU32(local, 22, data.length);
    zipWriteU16(local, 26, name.length);
    zipWriteU16(local, 28, 0);
    name.copy(local, 30);
    chunks.push(local, data);

    const c = Buffer.alloc(46 + name.length);
    zipWriteU32(c, 0, 0x02014B50);
    zipWriteU16(c, 4, 20); // made by
    zipWriteU16(c, 6, 20);
    zipWriteU16(c, 8, 0);
    zipWriteU16(c, 10, 0);
    zipWriteU16(c, 12, time);
    zipWriteU16(c, 14, date);
    zipWriteU32(c, 16, crc);
    zipWriteU32(c, 20, data.length);
    zipWriteU32(c, 24, data.length);
    zipWriteU16(c, 28, name.length);
    zipWriteU16(c, 30, 0);
    zipWriteU16(c, 32, 0);
    zipWriteU16(c, 34, 0);
    zipWriteU16(c, 36, 0);
    zipWriteU32(c, 38, e.name.endsWith('/') ? 0x10 : 0);
    zipWriteU32(c, 42, offset);
    name.copy(c, 46);
    central.push(c);
    offset += local.length + data.length;
  }
  const centralData = Buffer.concat(central);
  const end = Buffer.alloc(22);
  zipWriteU32(end, 0, 0x06054B50);
  zipWriteU16(end, 4, 0);
  zipWriteU16(end, 6, 0);
  zipWriteU16(end, 8, entries.length);
  zipWriteU16(end, 10, entries.length);
  zipWriteU32(end, 12, centralData.length);
  zipWriteU32(end, 16, offset);
  zipWriteU16(end, 20, 0);
  fs.writeFileSync(outFile, Buffer.concat([...chunks, centralData, end]));
}

async function buildBackup(reason) {
  const stamp = nowStamp();
  const workRoot = path.join(TMP_ROOT, `work-${stamp}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(workRoot, { recursive: true });
  const dataDir = path.join(workRoot, 'data');
  const tenantDir = path.join(workRoot, 'tenants');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(tenantDir, { recursive: true });

  const dataFile = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'saas.json');
  if (fs.existsSync(dataFile)) fs.copyFileSync(dataFile, path.join(dataDir, 'saas.json'));

  const rootEnv = path.join(__dirname, '..', '.env');
  if (fs.existsSync(rootEnv)) fs.copyFileSync(rootEnv, path.join(workRoot, '.env'));
  copyTree(path.join(__dirname, '..', 'catalog'), path.join(workRoot, 'catalog'));
  copyTree(path.join(__dirname, '..', 'emoji'), path.join(workRoot, 'emoji'));

  const tenants = db.listTenants();
  for (const rec of tenants) {
    const src = tenantRoot(rec);
    const dst = path.join(tenantDir, safeName(rec.type), safeName(rec.ownerId));
    if (rec.type === 'auto-comment-jaseb') {
      writeJasebPersistentState(dst, jasebPersistentStateFromRoot(src));
    } else {
      copyTenantRuntime(src, dst);
    }
  }

  let sessionFileCount = 0;
  let sellerSessionFileCount = 0;
  for (const rec of tenants) {
    const runtimeRoot = path.join(tenantDir, safeName(rec.type), safeName(rec.ownerId));
    sessionFileCount += listSessionFiles(runtimeRoot).filter(x => x.split('/').includes('sessions')).length;
    sellerSessionFileCount += listSessionFiles(runtimeRoot).filter(x => x.split('/').includes('seller_sessions')).length;
  }

  const manifest = {
    format: 'telegram-saas-global-backup',
    version: 1,
    createdAt: Date.now(),
    timestamp: new Date().toISOString(),
    reason,
    tenantCount: tenants.length,
    sessionFileCount,
    sellerSessionFileCount,
    tenants: tenants.map(x => ({ type: x.type, ownerId: x.ownerId, status: x.status, autostart: x.autostart, expiresAt: x.expiresAt || null })),
    includes: ['data/saas.json', '.env', 'catalog', 'emoji', 'tenant-persistent-runtime'],
    note: 'Auto Comment + Jaseb backup intentionally includes only account session/identity data, keywords, targets, and Jaseb text/interval/groups. Logs, counters, sent history, monitor state, sender flags, and runtime/cache data are excluded.'
  };
  fs.writeFileSync(path.join(workRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const zip = path.join(TMP_ROOT, `telegram-saas-backup-${stamp}.zip`);
  writeZipFile(workRoot, zip);
  return { zip, workRoot, manifest, size: fs.statSync(zip).size, checksum: hashFile(zip), contentSignature: contentSignature() };
}

async function sendBackup(reason, force = false) {
  if (!ownerId) throw new Error('Owner SaaS belum diinisialisasi.');

  let dest = backupTelegram();
  let built = null;
  let stagedOutbox = null;
  let attempts = 0;
  // Build a stable snapshot: if important persistent data changes while the zip
  // is being assembled, rebuild so the file and signature describe the same state.
  while (attempts < 3) {
    attempts += 1;
    built = await buildBackup(reason);
    const after = contentSignature();
    if (after === built.contentSignature) break;
    fs.rmSync(built.zip, { force: true });
    fs.rmSync(built.workRoot, { recursive: true, force: true });
    if (attempts >= 3) throw new Error('Data berubah terus saat backup dibuat; backup dibatalkan agar snapshot tidak inkonsisten.');
  }

  // Durable outbox: if the server dies after the snapshot is created but before
  // Telegram accepts it, the staged file survives and is retried on next boot.
  stagedOutbox = stageOutbox(built.zip, reason);

  const doSend = async (target, filePath) => {
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {});
    return target.telegram.sendDocument(target.chatId, { source: stream, filename: path.basename(filePath) }, {
      caption: `🛡️ <b>Backup SaaS Otomatis</b>\n\n📌 Event: <b>${String(reason).slice(0,180)}</b>\n🏪 Store/Tenant: <b>${built.manifest.tenantCount}</b>\n💾 Size: <b>${(built.size / 1024 / 1024).toFixed(2)} MB</b>\n🔐 SHA-256: <code>${built.checksum}</code>\n🕐 ${new Date().toLocaleString('id-ID')}\n\n✅ Backup berhasil dikirim.`,
      parse_mode: 'HTML'
    });
  };

  try {
    let msg;
    try {
      msg = await doSend(dest, stagedOutbox);
    } catch (primaryError) {
      if (dest.mode !== 'custom') throw primaryError;
      console.error('[SAAS BACKUP] custom destination failed, falling back to SaaS:', primaryError.message);
      const fallback = { telegram: bot?.telegram, chatId: Number(ownerId), mode: 'saas', botUsername: null };
      if (!fallback.telegram) throw primaryError;
      msg = await doSend(fallback, stagedOutbox);
      dest = fallback;
      try { await bot.telegram.sendMessage(Number(ownerId), `⚠️ <b>Bot Backup Custom gagal menerima backup.</b>\n\nError: <code>${String(primaryError.message).slice(0,500)}</code>\n\n✅ Backup global otomatis dialihkan sementara ke <b>Bot SaaS</b>.`, {parse_mode:'HTML'}); } catch {}
    }

    lastBackup = {
      fileId: msg.document?.file_id || null,
      fileName: msg.document?.file_name || path.basename(built.zip),
      size: built.size,
      checksum: built.checksum,
      contentSignature: built.contentSignature || contentSignature(),
      createdAt: Date.now(),
      reason,
      senderMode: dest.mode,
      senderBotUsername: dest.botUsername || null
    };
    lastContentSignature = lastBackup.contentSignature;
    db.suspendBackupHooks?.(true);
    try { setSetting('lastBackup', lastBackup); } finally { db.suspendBackupHooks?.(false); }
    fs.rmSync(stagedOutbox, { force: true });
    stagedOutbox = null;
    clearOutbox();
    return lastBackup;
  } finally {
    fs.rmSync(built.zip, { force: true });
    fs.rmSync(built.workRoot, { recursive: true, force: true });
  }
}

async function flush(reason = 'state-change', force = false) {
  if (running) {
    pendingReason = pendingReason ? `${pendingReason},${reason}` : reason;
    return lastBackup;
  }
  running = true;
  try {
    const before = lastBackup?.createdAt || 0;
    const result = await sendBackup(reason, force);
    retryMs = Number(process.env.SAAS_BACKUP_RETRY_MS || 15000);
    if ((result?.createdAt || 0) > before) {
      console.log(`[SAAS BACKUP] sent: ${reason}`);
    }
    return result;
  } catch (e) {
    console.error('[SAAS BACKUP] send failed:', e.message);
    pendingReason = pendingReason ? `${pendingReason},${reason}` : reason;
    throw e;
  } finally {
    running = false;
    if (pendingReason && !timer) {
      timer = setTimeout(() => {
        timer = null;
        const why = pendingReason;
        pendingReason = null;
        flush(why).catch(err => {
          console.error('[SAAS BACKUP] deferred flush failed:', err.message);
          scheduleRetry();
        });
      }, DEBOUNCE_MS);
      timer.unref?.();
    }
  }
}

function hashBufferFile(file, h) {
  try {
    const st = fs.statSync(file);
    h.update(file);
    h.update(String(st.size));
    h.update(fs.readFileSync(file));
    return true;
  } catch { return false; }
}

// Hanya pantau data persisten yang bermakna. Session/log/temp yang berubah-ubah
// tidak dijadikan trigger agar backup tidak terkirim terus-menerus.
function tenantDataSignature() {
  const h = crypto.createHash('sha256');
  const addStat = (file, label) => {
    try {
      const st = fs.statSync(file);
      h.update(`F:${label}:${st.size}:${st.mtimeMs}`);
      return true;
    } catch { return false; }
  };

  const walkPersistentData = (root, rel='') => {
    if (!fs.existsSync(root)) return;
    for (const ent of fs.readdirSync(root, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
      // These directories/files are runtime noise and must never trigger a
      // global backup just because a live tenant is active.
      if (['logs','backups','tmp','cache','.git','node_modules','runtime','uploads','sessions','seller_sessions'].includes(ent.name)) continue;
      const full = path.join(root, ent.name);
      const r = path.join(rel, ent.name).split(path.sep).join('/');
      try {
        const st = fs.statSync(full);
        if (ent.isDirectory()) {
          h.update(`D:${r}`);
          walkPersistentData(full, r);
        } else if (ent.isFile() && !ent.name.endsWith('.lock') && !ent.name.endsWith('.tmp')) {
          h.update(`F:${r}:${st.size}:${st.mtimeMs}`);
        }
      } catch {}
    }
  };

  const addSessionFiles = (root, label) => {
    const files = [];
    const walk = dir => {
      if (!fs.existsSync(dir)) return;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.isFile() && ent.name.endsWith('.session')) files.push(full);
      }
    };
    walk(root);
    for (const file of files.sort()) {
      try {
        const st = fs.statSync(file);
        h.update(`SESSION:${label}:${path.relative(root,file).split(path.sep).join('/').replace(/^\.\//,'')}:${st.size}:${st.mtimeMs}`);
      } catch {}
    }
  };

  for (const rec of db.listTenants().sort((a,b)=>String(a.type+a.ownerId).localeCompare(String(b.type+b.ownerId)))) {
    const root = tenantRoot(rec);
    h.update(`TENANT:${rec.type}:${rec.ownerId}:${rec.autostart !== false}`);

    if (rec.type === 'auto-comment-jaseb') {
      // Jaseb: only critical configuration/data is part of the trigger.
      // Monitoring logs, sent history, live counters and UI/runtime noise are
      // deliberately ignored, even though the app writes them frequently.
      h.update(`JASEB:${JSON.stringify(jasebPersistentStateFromRoot(root))}`);
      continue;
    }

    // All other stores: changes to persistent data are significant. This
    // covers Premium/Archive JSON and TagAll SQLite (+ WAL/SHM) while ignoring
    // runtime/log/cache directories. Session files remain critical where they
    // exist and are tracked separately so a session add/remove also triggers a
    // global snapshot.
    const dataDir = path.join(root, 'data');
    walkPersistentData(dataDir);

    for (const srName of ['sessions','seller_sessions','data/sessions','data/seller_sessions']) {
      addSessionFiles(path.join(root, ...srName.split('/')), `${rec.type}:${rec.ownerId}:${srName}`);
    }

    // Also include root-level persistent config files such as .env, but ignore
    // known runtime folders and transient logs.
    for (const name of ['.env','config.json','store.json']) {
      const file = path.join(root, name);
      if (fs.existsSync(file)) addStat(file, `${rec.type}:${rec.ownerId}:${name}`);
    }
  }
  return h.digest('hex');
}

function startPolling() {
  clearInterval(poller);
  lastTenantSignature = tenantDataSignature();
  poller = setInterval(() => {
    try {
      const sig = tenantDataSignature();
      if (sig !== lastTenantSignature) {
        lastTenantSignature = sig;
        queue('tenant-persistent-data-change');
      }
    } catch (e) { console.error('[SAAS BACKUP] data watch failed:', e.message); }
  }, POLL_MS);
  poller.unref?.();
}

async function init({ telegramBot, database, tenantManager, owner }) {
  bot = telegramBot; db = database; tenant = tenantManager; ownerId = Number(owner);
  ready = false;
  readyPromise = new Promise(resolve => { readyResolve = resolve; });
  suppressedUntil = Date.now() + Number(process.env.SAAS_BACKUP_STARTUP_GRACE_MS || 15000);
  pendingReason = null;
  clearTimeout(timer);
  timer = null;
  // Capture a startup baseline so changes made before markReady() are not lost.
  try { startupStateSignature = contentSignature(); } catch { startupStateSignature = ''; }
  db.setBackupHook?.(queue);
  const saved = settings().lastBackup;
  if (saved) {
    lastBackup = saved;
    lastContentSignature = String(saved.contentSignature || '');
  }
}


function markReady() {
  clearTimeout(timer);
  timer = null;
  ready = true;
  suppressedUntil = 0;
  try { readyResolve?.(); } catch {}
  readyResolve = null;
  const currentTenantSig = tenantDataSignature();
  const currentContentSig = contentSignature();
  const changedDuringStartup = Boolean(startupStateSignature) && startupStateSignature !== currentContentSig;
  lastTenantSignature = currentTenantSig;
  lastContentSignature = currentContentSig;
  startupStateSignature = currentContentSig;
  startPolling();
  const savedSignature = String(lastBackup?.contentSignature || '');
  const changedSinceLastDeliveredBackup = Boolean(savedSignature) && savedSignature !== currentContentSig;
  const hasPendingLocalBackup = listOutbox().length > 0;
  if (changedDuringStartup || changedSinceLastDeliveredBackup || hasPendingLocalBackup || pendingReason || !savedSignature) {
    const why = pendingReason || (hasPendingLocalBackup ? 'recovery-pending-backup' : changedSinceLastDeliveredBackup ? 'state-changed-since-last-backup' : changedDuringStartup ? 'startup-state-change' : 'startup-initial-backup');
    pendingReason = null;
    queue(why);
  }
}

async function forceBackup(reason = 'manual') {
  // Explicit/manual critical backups must never depend on the parent polling
  // lifecycle being marked "ready". The bot/database/tenant dependencies are
  // initialized before any user action can reach this function. Waiting on a
  // separate readiness promise could deadlock a valid tenant creation for 30s
  // and report a false backup failure.
  if (!bot || !db || !tenant || !ownerId) {
    pendingReason = pendingReason ? `${pendingReason},${reason}` : reason;
    throw new Error('Backup belum dapat dijalankan karena subsystem SaaS belum terinisialisasi.');
  }
  clearTimeout(timer);
  timer = null;
  pendingReason = null;
  return flush(reason, true);
}

async function resendLast() {
  const task = backupSendChain.then(async () => {
    const saved = settings().lastBackup || lastBackup;
    const dest = backupTelegram();

  // A Telegram file_id is scoped to the bot that uploaded it. If the active
  // destination bot differs from the bot that created the saved file_id,
  // rebuild the global snapshot and upload it through the active destination.
  if (saved?.fileId && (saved.senderMode || 'saas') === dest.mode) {
    return dest.telegram.sendDocument(dest.chatId, saved.fileId, {
      caption: `📦 Backup terakhir\n🕐 ${new Date(saved.createdAt || Date.now()).toLocaleString('id-ID')}\n🔐 ${saved.checksum || 'checksum tidak tersedia'}`
    });
  }

  const built = await buildBackup('manual-resend');
  try {
    const msg = await dest.telegram.sendDocument(dest.chatId, {
      source: fs.createReadStream(built.zip),
      filename: path.basename(built.zip)
    }, {
      caption: `📦 <b>Backup SaaS</b>\n\n🏪 Store/Tenant: <b>${built.manifest.tenantCount}</b>\n💾 Size: <b>${(built.size / 1024 / 1024).toFixed(2)} MB</b>\n🔐 SHA-256: <code>${built.checksum}</code>\n🕐 ${new Date().toLocaleString('id-ID')}`,
      parse_mode: 'HTML'
    });
    const result = {
      fileId: msg.document?.file_id || null,
      fileName: msg.document?.file_name || path.basename(built.zip),
      size: built.size,
      checksum: built.checksum,
      createdAt: Date.now(),
      reason: 'manual-resend',
      senderMode: dest.mode,
      senderBotUsername: dest.botUsername || null
    };
    lastBackup = result;
    lastContentSignature = built.contentSignature || contentSignature();
    if (result.fileId) {
      db.suspendBackupHooks?.(true);
      try { setSetting('lastBackup', result); } finally { db.suspendBackupHooks?.(false); }
    }
    return result;
  } finally {
    fs.rmSync(built.zip, { force: true });
    fs.rmSync(built.workRoot, { recursive: true, force: true });
  }
  });
  backupSendChain = task.catch(() => {});
  return task;
}

async function downloadTelegramDocument(fileId) {
  const link = await bot.telegram.getFileLink(fileId);
  const response = await axios.get(link.href || link, { responseType: 'arraybuffer', timeout: 120000 });
  return Buffer.from(response.data);
}

async function restoreFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 100) throw new Error('File backup tidak valid.');
  const work = path.join(TMP_ROOT, `restore-${Date.now()}`);
  const zip = path.join(work, 'backup.zip');
  const extract = path.join(work, 'extract');
  fs.mkdirSync(extract, { recursive: true });
  try {
    fs.writeFileSync(zip, buffer);
    await execFileP('unzip', ['-t', zip], { maxBuffer: 2 * 1024 * 1024 });
    await execFileP('unzip', ['-q', zip, '-d', extract], { maxBuffer: 2 * 1024 * 1024 });
    const manifestPath = path.join(extract, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error('Manifest backup tidak ditemukan.');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.format !== 'telegram-saas-global-backup' || Number(manifest.version) !== 1) throw new Error('Versi backup tidak kompatibel.');
    const dataFile = path.join(extract, 'data', 'saas.json');
    if (!fs.existsSync(dataFile)) throw new Error('data/saas.json tidak ditemukan.');

    // Validate that every session file declared by the backup is actually
    // present before deleting any live tenant data. This prevents a partial
    // backup from being restored as if it were complete.
    if (Number.isFinite(Number(manifest.sessionFileCount)) || Number.isFinite(Number(manifest.sellerSessionFileCount))) {
      const extractedTenants = path.join(extract, 'tenants');
      const sessionFiles = [];
      const walkSessions = dir => {
        if (!fs.existsSync(dir)) return;
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, ent.name);
          if (ent.isDirectory()) walkSessions(p);
          else if (ent.isFile() && ent.name.endsWith('.session')) sessionFiles.push(p);
        }
      };
      walkSessions(extractedTenants);
      const expected = Number(manifest.sessionFileCount || 0) + Number(manifest.sellerSessionFileCount || 0);
      if (sessionFiles.length < expected) {
        throw new Error(`Backup session tidak lengkap: expected=${expected}, found=${sessionFiles.length}`);
      }
    }

    // Stop tenant children before replacing runtime state.
    for (const rec of db.listTenants()) { try { tenant.stop(rec.type, rec.ownerId); } catch {} }

    const liveRoot = path.resolve(__dirname, '..');
    const liveDataDir = path.resolve(process.env.DATA_DIR || path.join(liveRoot, 'data'));
    fs.mkdirSync(liveDataDir, { recursive: true });
    const liveDataFile = path.join(liveDataDir, 'saas.json');
    const tmpData = `${liveDataFile}.restore-${process.pid}`;
    fs.copyFileSync(dataFile, tmpData);
    fs.renameSync(tmpData, liveDataFile);

    const envSrc = path.join(extract, '.env');
    if (fs.existsSync(envSrc) && !process.env.SAAS_RESTORE_KEEP_ENV) {
      const liveEnv = path.join(liveRoot, '.env');
      const tmpEnv = `${liveEnv}.restore-${process.pid}`;
      fs.copyFileSync(envSrc, tmpEnv);
      fs.renameSync(tmpEnv, liveEnv);
    }

    const extractedTenants = path.join(extract, 'tenants');
    const liveTenants = path.resolve(process.env.TENANTS_DIR || path.join(liveRoot, 'tenants'));
    if (fs.existsSync(liveTenants)) fs.rmSync(liveTenants, { recursive: true, force: true });
    fs.mkdirSync(liveTenants, { recursive: true });
    if (fs.existsSync(extractedTenants)) fs.cpSync(extractedTenants, liveTenants, { recursive: true, force: true });

    for (const dirName of ['catalog','emoji']) {
      const srcDir = path.join(extract, dirName);
      const dstDir = path.join(liveRoot, dirName);
      if (fs.existsSync(srcDir)) {
        if (fs.existsSync(dstDir)) fs.rmSync(dstDir, { recursive: true, force: true });
        fs.cpSync(srcDir, dstDir, { recursive: true, force: true });
      }
    }

    return { manifest, needsRestart: true };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function restoreFromTelegram(fileId) {
  const buffer = await downloadTelegramDocument(fileId);
  return restoreFromBuffer(buffer);
}

module.exports = { init, markReady, queue, flush, forceBackup, resendLast, restoreFromTelegram, restoreFromBuffer, getLast: () => lastBackup, configureBackupDestination, backupDestinationInfo, validateBackupBot, testBackupDestination };
