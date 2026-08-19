'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeReadJson(file, fallback = []) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed;
  } catch {
    return fallback;
  }
}

/*
 * Backup database JSON.
 *
 * Wallet sengaja difilter:
 * - buyer_wallets: hanya balance > 0
 * - seller_wallets: hanya balance > 0
 *
 * Collection lain dibackup utuh.
 */
function copyDatabaseFiles(src, dest) {
  ensureDir(dest);

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (['backups', 'sessions', 'seller_sessions'].includes(entry.name)) continue;
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);

    if (entry.name === 'buyer_wallets.json') {
      const rows = safeReadJson(from, []);
      const positive = Array.isArray(rows)
        ? rows.filter(row => Number(row?.balance || 0) > 0)
        : [];

      fs.writeFileSync(to, JSON.stringify(positive, null, 2), 'utf8');
      continue;
    }

    if (entry.name === 'seller_wallets.json') {
      const rows = safeReadJson(from, []);
      const positive = Array.isArray(rows)
        ? rows.filter(row => Number(row?.balance || 0) > 0)
        : [];

      fs.writeFileSync(to, JSON.stringify(positive, null, 2), 'utf8');
      continue;
    }

    fs.copyFileSync(from, to);
  }
}

/*
 * Backup Telegram account sessions.
 * Session files bukan JSON, jadi harus dicopy secara recursive.
 */
function copySessionTree(src, dest) {
  if (!fs.existsSync(src)) return;

  ensureDir(dest);

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copySessionTree(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}


async function zipBackupDir(dir) {
  const { execFile } = require('child_process');

  const zipPath = `${dir}.zip`;

  await new Promise((resolve, reject) => {
    execFile(
      'zip',
      ['-qr', zipPath, '.'],
      { cwd: dir },
      (error) => error ? reject(error) : resolve()
    );
  });

  return zipPath;
}

async function createBackup(reason = 'manual') {
  ensureDir(DATA_DIR);
  ensureDir(BACKUP_DIR);

  const dir = path.join(
    BACKUP_DIR,
    `${stamp()}_${String(reason).replace(/[^a-z0-9_-]/gi, '_')}`
  );

  ensureDir(dir);

  // Database.
  copyDatabaseFiles(DATA_DIR, dir);

  // Telegram buyer/store sessions.
  const sessionsDir = path.join(DATA_DIR, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    copySessionTree(
      sessionsDir,
      path.join(dir, 'sessions')
    );
  }

  // Seller sessions.
  const sellerSessionsDir = path.join(DATA_DIR, 'seller_sessions');
  if (fs.existsSync(sellerSessionsDir)) {
    copySessionTree(
      sellerSessionsDir,
      path.join(dir, 'seller_sessions')
    );
  }

  const buyerWallets = safeReadJson(
    path.join(DATA_DIR, 'buyer_wallets.json'),
    []
  );

  const sellerWallets = safeReadJson(
    path.join(DATA_DIR, 'seller_wallets.json'),
    []
  );

  const buyerPositive = Array.isArray(buyerWallets)
    ? buyerWallets.filter(w => Number(w?.balance || 0) > 0)
    : [];

  const sellerPositive = Array.isArray(sellerWallets)
    ? sellerWallets.filter(w => Number(w?.balance || 0) > 0)
    : [];

  fs.writeFileSync(
    path.join(dir, 'backup-meta.json'),
    JSON.stringify({
      createdAt: new Date().toISOString(),
      reason,
      version: 2,
      contents: {
        database: true,
        telegramSessions: fs.existsSync(sessionsDir),
        sellerSessions: fs.existsSync(sellerSessionsDir),
        buyerWalletsWithBalance: buyerPositive.length,
        sellerWalletsWithBalance: sellerPositive.length,
        buyerBalanceTotal: buyerPositive.reduce(
          (sum, w) => sum + Number(w?.balance || 0),
          0
        ),
        sellerBalanceTotal: sellerPositive.reduce(
          (sum, w) => sum + Number(w?.balance || 0),
          0
        ),
      },
    }, null, 2)
  );

  // Buat ZIP setelah seluruh isi backup selesai ditulis.
  const zipPath = await zipBackupDir(dir);

  logger.info(
    `[Backup] created ${dir} | zip=${zipPath} | buyer wallets=${buyerPositive.length} | seller wallets=${sellerPositive.length}`
  );

  return {
    dir,
    zipPath,
    name: path.basename(dir),
  };
}

function listBackups() {
  ensureDir(BACKUP_DIR);

  return fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const dir = path.join(BACKUP_DIR, e.name);

      let meta = {};
      try {
        meta = JSON.parse(
          fs.readFileSync(
            path.join(dir, 'backup-meta.json'),
            'utf8'
          )
        );
      } catch {}

      return {
        name: e.name,
        dir,
        createdAt: meta.createdAt || null,
        reason: meta.reason || 'unknown',
        version: meta.version || 1,
        contents: meta.contents || null,
      };
    })
    .sort((a, b) =>
      String(b.createdAt || b.name)
        .localeCompare(String(a.createdAt || a.name))
    );
}

async function pruneBackups() {
  const keep = 5;

  const rows = listBackups();

  for (const row of rows.slice(keep)) {
    fs.rmSync(row.dir, {
      recursive: true,
      force: true,
    });
  }
}

function restoreTree(src, dest) {
  if (!fs.existsSync(src)) return;

  ensureDir(dest);

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'backup-meta.json') continue;

    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      restoreTree(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

async function restoreBackup(name) {
  const safe = path.basename(String(name || ''));
  const dir = path.join(BACKUP_DIR, safe);

  if (
    !fs.existsSync(dir) ||
    !fs.statSync(dir).isDirectory()
  ) {
    throw new Error('Backup tidak ditemukan.');
  }

  // Backup pengaman sebelum restore.
  await createBackup('before_restore');

  ensureDir(DATA_DIR);

  /*
   * Hapus database JSON saat ini.
   * Session juga dihapus karena snapshot sekarang memang
   * menyimpan session dan harus benar-benar kembali ke kondisi snapshot.
   */
  for (const entry of fs.readdirSync(DATA_DIR, {
    withFileTypes: true,
  })) {
    if (
      entry.isFile() &&
      entry.name.endsWith('.json')
    ) {
      fs.rmSync(
        path.join(DATA_DIR, entry.name),
        { force: true }
      );
    }

    if (
      entry.isDirectory() &&
      ['sessions', 'seller_sessions'].includes(entry.name)
    ) {
      fs.rmSync(
        path.join(DATA_DIR, entry.name),
        {
          recursive: true,
          force: true,
        }
      );
    }
  }

  // Restore seluruh isi snapshot.
  restoreTree(dir, DATA_DIR);

  logger.warn(`[Backup] restored ${safe}`);

  return dir;
}

let interval = null;

function startSchedule() {
  if (interval) return;

  const hours = Math.max(
    1,
    Number(process.env.BACKUP_INTERVAL_HOURS || 6)
  );

  interval = setInterval(
    () => {
      createBackup('scheduled').catch(err =>
        logger.error(
          '[Backup] scheduled failed:',
          err.message
        )
      );
    },
    hours * 60 * 60 * 1000
  );

  interval.unref?.();

  createBackup('startup').catch(err =>
    logger.error(
      '[Backup] startup failed:',
      err.message
    )
  );
}

module.exports = {
  createBackup,
  listBackups,
  restoreBackup,
  startSchedule,
  BACKUP_DIR,
};
