'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(process.cwd(), 'data', 'custom_emojis.json');

function ensureFile() {
  const dir = path.dirname(FILE);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '{}\n', 'utf8');
}

function readAll() {
  ensureFile();
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Format data harus berupa object JSON.');
    }
    return parsed;
  } catch (err) {
    throw new Error(`Gagal membaca custom_emojis.json: ${err.message}`);
  }
}

function writeAll(data) {
  ensureFile();
  const dir = path.dirname(FILE);
  const tmp = path.join(dir, `.custom_emojis.${process.pid}.${Date.now()}.tmp`);
  const payload = JSON.stringify(data, null, 2) + '\n';

  try {
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, FILE);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw new Error(`Gagal menyimpan custom_emojis.json: ${err.message}`);
  }
}

function get(emoji) {
  return readAll()[emoji] || null;
}

function set(emoji, customEmojiId) {
  const key = String(emoji || '').trim();
  const id = String(customEmojiId || '').trim();

  if (!key || !id) throw new Error('Emoji dan Custom Emoji ID wajib diisi.');
  if (!/^\d+$/.test(id)) throw new Error('Custom Emoji ID tidak valid.');

  const data = readAll();
  data[key] = {
    fallback: key,
    customEmojiId: id,
    updatedAt: new Date().toISOString()
  };

  writeAll(data);
  return data[key];
}

function remove(emoji) {
  const data = readAll();
  delete data[emoji];
  writeAll(data);
}

function all() {
  return readAll();
}

module.exports = { get, set, remove, all };
