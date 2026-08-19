const path = require('node:path');
const fs = require('node:fs');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(process.cwd(), '.env') });

const BASE = process.cwd();
const DATA_DIR = path.join(BASE, 'data');
const LOG_DIR = path.join(BASE, 'logs');
const SESSION_DIR = path.join(BASE, 'sessions');
for (const dir of [DATA_DIR, LOG_DIR, SESSION_DIR]) fs.mkdirSync(dir, { recursive: true });

function listEnv(name, fallback = '') {
  const value = String(process.env[name] ?? fallback).trim();
  return value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
}

const config = {
  base: BASE,
  dataDir: DATA_DIR,
  logDir: LOG_DIR,
  sessionDir: SESSION_DIR,
  dbPath: path.join(DATA_DIR, 'bot.sqlite3'),
  botToken: String(process.env.BOT_TOKEN || '').trim(),
  botUsername: String(process.env.BOT_USERNAME || '').trim().replace(/^@/, ''),
  ownerId: Number(process.env.OWNER_ID || 0),
  apiId: Number(process.env.API_ID || 0),
  apiHash: String(process.env.API_HASH || '').trim(),
  targetLinks: listEnv('TARGET_GROUP_LINKS'),
  legacyTarget: String(process.env.TARGET_GROUP_LINK || '').trim(),
  delaySeconds: Math.max(1, Number(process.env.TAGALL_DELAY_SECONDS || 2)),
  partnerTimerMinutes: Math.min(30, Math.max(1, Number(process.env.PARTNER_TAGALL_TIMER_MINUTES || 3))),
  queueCooldownSeconds: 300,
  syncIntervalHours: Math.max(1, Number(process.env.SYNC_INTERVAL_HOURS || 6)),
  adminIds: listEnv('ADMIN_IDS').map(Number).filter(Number.isFinite)
};
if (!config.targetLinks.length && config.legacyTarget) config.targetLinks = [config.legacyTarget];
if (!config.botToken) throw new Error('BOT_TOKEN belum diisi di .env');

module.exports = config;
