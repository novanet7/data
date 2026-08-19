'use strict';


const BOT_USERNAME = String(process.env.SANGMATA_BOT_USERNAME || 'SangMata_BOT').replace(/^@/, '');
const TIMEOUT_MS = Math.max(5000, Number(process.env.SANGMATA_DETECT_TIMEOUT_MS || 20000));
const POLL_MS = Math.max(250, Number(process.env.SANGMATA_DETECT_POLL_MS || 750));
const START_WAIT_MS = Math.max(100, Number(process.env.SANGMATA_DETECT_START_WAIT_MS || 900));

function normalizeText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .trim();
}

function detectStatusFromReply(text, telegramId) {
  const raw = normalizeText(text);
  if (!raw) return null;

  const id = String(telegramId || '').trim();
  const noData = new RegExp(`(?:Tidak\\s+ada\\s+data[^\\n]*\\b${escapeRegExp(id)}\\b|No\\s+data\\s+(?:available|found)[^\\n]*\\b${escapeRegExp(id)}\\b)`, 'i');
  if (noData.test(raw)) return { status: 'fs', reason: 'no_history' };

  const hasHistoryHeader = /(?:history\s+for|riwayat\s+untuk)\s+\d+/i.test(raw);
  const hasNamesOrUsernames = /\b(?:Names|Usernames|Nama|Username)\b/i.test(raw);
  const hasHistoryItem = /(?:\bNames\b|\bUsernames\b)[\s\S]*?(?:\d+\.\s*\[|@)/i.test(raw);

  if (hasHistoryHeader || hasHistoryItem || hasNamesOrUsernames && /\b(?:\d+\.\s*\[|@\w+)/.test(raw)) {
    return { status: 'nfs', reason: 'history_found' };
  }

  return null;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getApiConfig() {
  const apiId = Number(process.env.TG_API_ID || 0);
  const apiHash = String(process.env.TG_API_HASH || '');
  if (!apiId || !apiHash) throw new Error('TG_API_ID/TG_API_HASH belum diset.');
  return { apiId, apiHash };
}

async function waitForBotReply(client, entity, afterMessageId, telegramId) {
  const logger = require('../utils/logger');
  const started = Date.now();
  while (Date.now() - started < TIMEOUT_MS) {
    try {
      const messages = await client.getMessages(entity, { limit: 20 });
      const ordered = [...messages].sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
      for (const msg of ordered) {
        if (!msg || msg.out) continue;
        if (Number(msg.id || 0) <= Number(afterMessageId || 0)) continue;
        const text = typeof msg.message === 'string' ? msg.message : '';
        const parsed = detectStatusFromReply(text, telegramId);
        if (parsed) return { ...parsed, messageId: msg.id, text };
      }
    } catch (err) {
      logger.warn(`[SangMata] polling reply failed: ${err.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`Timeout menunggu balasan @${BOT_USERNAME}.`);
}

async function detectNokosStatus(sessionString, telegramId) {
  const id = String(telegramId || '').trim();
  if (!/^\d{6,20}$/.test(id)) throw new Error('Telegram ID tidak valid untuk deteksi FS/NFS.');
  if (!sessionString) throw new Error('Session string kosong.');

  const logger = require('../utils/logger');
  const { TelegramClient } = require('telegram');
  const { StringSession } = require('telegram/sessions');
  const { apiId, apiHash } = getApiConfig();
  const client = new TelegramClient(new StringSession(String(sessionString)), apiId, apiHash, {
    connectionRetries: 3,
    autoReconnect: true,
    useWSS: true,
  });

  try {
    await client.connect();
    const me = await client.getMe();
    if (String(me?.id || '') !== id) {
      throw new Error(`Session Telegram ID tidak cocok (expected=${id}, actual=${String(me?.id || '')}).`);
    }

    const entity = await client.getEntity(BOT_USERNAME);
    await client.sendMessage(entity, { message: '/start' });
    await new Promise(resolve => setTimeout(resolve, START_WAIT_MS));

    const sent = await client.sendMessage(entity, { message: id });
    const result = await waitForBotReply(client, entity, sent?.id || 0, id);
    logger.info(`[SangMata] telegramId=${id} status=${result.status} reason=${result.reason}`);
    return {
      status: result.status,
      reason: result.reason,
      detectedAt: new Date().toISOString(),
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

module.exports = {
  detectNokosStatus,
  detectStatusFromReply,
  BOT_USERNAME,
};
