'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const logger = require('../utils/logger');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const SELLER_SESSIONS_DIR = path.join(DATA_DIR, 'seller_sessions');

function collectFiles(dir, baseDir, extensions) {
  const result = [];

  if (!fs.existsSync(dir)) return result;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      result.push(...collectFiles(fullPath, baseDir, extensions));
      continue;
    }

    if (!entry.isFile()) continue;
    if (!extensions.some(ext => entry.name.endsWith(ext))) continue;

    result.push({
      path: path.relative(baseDir, fullPath).replace(/\\/g, '/'),
      content: fs.readFileSync(fullPath, 'utf8'),
    });
  }

  return result;
}

function collectSessions(dir, baseDir) {
  return collectFiles(dir, baseDir, ['.session']);
}

async function createSnapshot(reason = 'automatic') {
  return Buffer.from(
    JSON.stringify({
      format: 'telegram-store-snapshot',
      version: 1,
      createdAt: new Date().toISOString(),
      reason,

      jsonFiles: collectFiles(
        DATA_DIR,
        DATA_DIR,
        ['.json']
      ),

      sessions: collectSessions(
        SESSIONS_DIR,
        SESSIONS_DIR
      ),

      sellerSessions: collectSessions(
        SELLER_SESSIONS_DIR,
        SELLER_SESSIONS_DIR
      ),
    }, null, 2),
    'utf8'
  );
}

function sendDocumentIPv4(token, chatId, filename, buffer, caption = '') {
  return new Promise((resolve, reject) => {
    const curl = spawn('curl', [
      '-4',
      '-sS',
      '--max-time', '90',
      '-X', 'POST',
      `https://api.telegram.org/bot${token}/sendDocument`,
      '-F', `chat_id=${chatId}`,
      '-F', `document=@-;filename=${filename};type=application/json`,
      '-F', `caption=${caption}`,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout = [];
    const stderr = [];

    curl.stdout.on('data', chunk => stdout.push(chunk));
    curl.stderr.on('data', chunk => stderr.push(chunk));

    curl.on('error', reject);

    curl.on('close', code => {
      const output = Buffer.concat(stdout).toString('utf8');

      if (code !== 0) {
        return reject(new Error(
          `curl exit ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`
        ));
      }

      let result;

      try {
        result = JSON.parse(output);
      } catch {
        return reject(new Error(`Telegram response tidak valid: ${output}`));
      }

      if (!result.ok) {
        return reject(new Error(
          `Telegram sendDocument gagal: ${result.description || 'unknown error'}`
        ));
      }

      resolve(result);
    });

    curl.stdin.end(buffer);
  });
}

async function sendToOwner(reason = 'automatic') {
  const token = String(process.env.PLATFORM_BOT_TOKEN || '').trim();
  const ownerId = String(process.env.PLATFORM_OWNER_ID || '').trim();

  if (!token) throw new Error('PLATFORM_BOT_TOKEN kosong');
  if (!ownerId) throw new Error('PLATFORM_OWNER_ID kosong');

  const snapshot = await createSnapshot(reason);

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-');

  const filename = `telegram-store-backup-${stamp}.json`;

  const result = await sendDocumentIPv4(
    token,
    ownerId,
    filename,
    snapshot,
    `💾 Backup otomatis\n📌 Event: ${reason}`
  );

  return {
    ok: true,
    filename,
    size: snapshot.length,
    result,
  };
}

function safeRelativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/');

  if (!normalized || normalized.startsWith('/')) {
    throw new Error('Path snapshot tidak valid.');
  }

  const parts = normalized.split('/');

  if (parts.includes('..') || parts.includes('.')) {
    throw new Error(`Path snapshot berbahaya: ${normalized}`);
  }

  return normalized;
}

function writeSnapshotFiles(baseDir, files, allowedExtension) {
  let count = 0;

  for (const item of files || []) {
    if (!item || typeof item.path !== 'string') {
      throw new Error('Format file snapshot tidak valid.');
    }

    const rel = safeRelativePath(item.path);

    if (!rel.endsWith(allowedExtension)) {
      throw new Error(`Extension snapshot tidak valid: ${rel}`);
    }

    if (typeof item.content !== 'string') {
      throw new Error(`Content snapshot tidak valid: ${rel}`);
    }

    const destination = path.join(baseDir, rel);

    fs.mkdirSync(path.dirname(destination), { recursive: true });

    const tmp = `${destination}.${process.pid}.${Date.now()}.tmp`;

    fs.writeFileSync(tmp, item.content, 'utf8');
    fs.renameSync(tmp, destination);

    try {
      fs.chmodSync(destination, 0o600);
    } catch {}

    count++;
  }

  return count;
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('Snapshot bukan object JSON.');
  }

  if (snapshot.format !== 'telegram-store-snapshot') {
    throw new Error('Format snapshot tidak dikenali.');
  }

  if (Number(snapshot.version) !== 1) {
    throw new Error(`Versi snapshot tidak didukung: ${snapshot.version}`);
  }

  if (!Array.isArray(snapshot.jsonFiles)) {
    throw new Error('jsonFiles snapshot tidak valid.');
  }

  if (!Array.isArray(snapshot.sessions)) {
    throw new Error('sessions snapshot tidak valid.');
  }

  if (!Array.isArray(snapshot.sellerSessions)) {
    throw new Error('sellerSessions snapshot tidak valid.');
  }
}

async function restoreSnapshot(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('Data snapshot harus berupa Buffer.');
  }

  if (buffer.length < 20) {
    throw new Error('File snapshot terlalu kecil.');
  }

  let snapshot;

  try {
    snapshot = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error('File bukan JSON yang valid.');
  }

  validateSnapshot(snapshot);

  // Pastikan JSON di dalam snapshot benar-benar JSON valid
  // sebelum menulis apa pun ke server.
  for (const item of snapshot.jsonFiles) {
    safeRelativePath(item.path);

    if (!item.path.endsWith('.json')) {
      throw new Error(`File database tidak valid: ${item.path}`);
    }

    const parsedContent = JSON.parse(item.content);

    // Proteksi custom emoji:
    // Jangan pernah menghapus emoji aktif jika snapshot membawa
    // custom_emojis.json kosong.
    if (item.path === 'custom_emojis.json') {
      if (
        !parsedContent ||
        typeof parsedContent !== 'object' ||
        Array.isArray(parsedContent) ||
        Object.keys(parsedContent).length === 0
      ) {
        throw new Error(
          'Snapshot ditolak: custom_emojis.json kosong. ' +
          'Import dibatalkan agar custom emoji aktif tidak hilang.'
        );
      }

      const emojiCount = Object.keys(parsedContent).length;
      const customEmojiCount = Object.values(parsedContent)
        .filter(v => v && typeof v === 'object' && v.customEmojiId)
        .length;

      if (customEmojiCount === 0) {
        throw new Error(
          'Snapshot ditolak: custom_emojis.json tidak memiliki customEmojiId.'
        );
      }

      logger.info(`[SnapshotService] custom_emojis.json valid: ${emojiCount} emoji, ${customEmojiCount} customEmojiId`);
    }
  }

  // Portable restore = kondisi tujuan harus mengikuti snapshot sepenuhnya.
  // Hapus database JSON lama terlebih dahulu.
  if (fs.existsSync(DATA_DIR)) {
    for (const entry of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        fs.rmSync(path.join(DATA_DIR, entry.name), { force: true });
      }
    }
  }

  // Hapus seluruh session lama.
  clearAllSessionFiles();

  // Tulis database JSON.
  const jsonCount = writeSnapshotFiles(
    DATA_DIR,
    snapshot.jsonFiles,
    '.json'
  );

  // Restore session utama.
  const sessionCount = writeSnapshotFiles(
    SESSIONS_DIR,
    snapshot.sessions,
    '.session'
  );

  // Restore session seller.
  const sellerSessionCount = writeSnapshotFiles(
    SELLER_SESSIONS_DIR,
    snapshot.sellerSessions,
    '.session'
  );

  return {
    createdAt: snapshot.createdAt || null,
    reason: snapshot.reason || null,
    jsonCount,
    sessionCount,
    sellerSessionCount,
  };
}

function removeSessionFiles(dir) {
  let removed = 0;

  if (!fs.existsSync(dir)) {
    return 0;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      removed += removeSessionFiles(fullPath);

      try {
        if (fs.readdirSync(fullPath).length === 0) {
          fs.rmdirSync(fullPath);
        }
      } catch {}

      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.session')) continue;

    try {
      fs.unlinkSync(fullPath);
      removed++;
    } catch {}
  }

  return removed;
}

async function clearAllSessionFiles() {
  // __admin_restock__ sengaja juga dibersihkan di sini karena
  // fitur ini memang "hapus semua sesi".
  const mainRemoved = removeSessionFiles(SESSIONS_DIR);
  const sellerRemoved = removeSessionFiles(SELLER_SESSIONS_DIR);

  return {
    mainRemoved,
    sellerRemoved,
    totalRemoved: mainRemoved + sellerRemoved,
  };
}

module.exports = {
  createSnapshot,
  sendToOwner,
  restoreSnapshot,
  clearAllSessionFiles,
};
