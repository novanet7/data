const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (user_id INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assistants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT,
  phone TEXT,
  telegram_id INTEGER,
  session_string TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS targets (
  link TEXT PRIMARY KEY,
  chat_id INTEGER,
  title TEXT,
  username TEXT,
  last_sync_at INTEGER DEFAULT 0,
  last_sync_count INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS group_member_cache (
  group_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY(group_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_group ON group_member_cache(group_id,is_deleted,is_bot);
CREATE TABLE IF NOT EXISTS partners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE NOT NULL,
  name TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tag_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL,
  target_chat_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  duration_minutes INTEGER,
  stop_requested INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_queue_status ON tag_queue(status,created_at);
CREATE TABLE IF NOT EXISTS group_settings (
  group_id INTEGER PRIMARY KEY,
  welcome_enabled INTEGER NOT NULL DEFAULT 0,
  welcome_message TEXT NOT NULL DEFAULT 'Halo {mention}\\n\\nSelamat datang di {group}.',
  welcome_banner_file_id TEXT NOT NULL DEFAULT '',
  welcome_banner_type TEXT NOT NULL DEFAULT 'photo',
  welcome_buttons_json TEXT NOT NULL DEFAULT '[]',
  welcome_autodelete INTEGER NOT NULL DEFAULT 0,
  goodbye_enabled INTEGER NOT NULL DEFAULT 0,
  goodbye_message TEXT NOT NULL DEFAULT 'Selamat jalan {fullname} dari {group}.',
  goodbye_banner_file_id TEXT NOT NULL DEFAULT '',
  goodbye_banner_type TEXT NOT NULL DEFAULT 'photo',
  goodbye_buttons_json TEXT NOT NULL DEFAULT '[]',
  goodbye_autodelete INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
`);

function now() { return Math.floor(Date.now() / 1000); }
function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(String(key));
  return row ? String(row.value) : fallback;
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(key), String(value));
}
function log(actorId, action, detail='') { db.prepare('INSERT INTO logs(actor_id,action,detail,created_at) VALUES(?,?,?,?)').run(actorId || null, action, String(detail), now()); }
function addAdmin(userId) { db.prepare('INSERT OR IGNORE INTO admins(user_id) VALUES(?)').run(Number(userId)); }
function isAdmin(userId) {
  return !!db.prepare('SELECT 1 FROM admins WHERE user_id=?').get(Number(userId));
}
function assistant() { return db.prepare('SELECT * FROM assistants WHERE active=1 ORDER BY id DESC LIMIT 1').get(); }
function upsertTarget(link, chatId, title='', username='') {
  db.prepare(`INSERT INTO targets(link,chat_id,title,username) VALUES(?,?,?,?) ON CONFLICT(link) DO UPDATE SET chat_id=excluded.chat_id,title=excluded.title,username=excluded.username`).run(String(link), Number(chatId), String(title), String(username));
}
function targetForLink(link) { return db.prepare('SELECT * FROM targets WHERE link=?').get(String(link)); }
function targets() { return db.prepare('SELECT * FROM targets ORDER BY link').all(); }
function saveGroupSettings(groupId, values) {
  const current = groupSettings(groupId);
  const v = { ...current, ...values, group_id: Number(groupId), updated_at: now() };
  db.prepare(`
    INSERT INTO group_settings(group_id,welcome_enabled,welcome_message,welcome_banner_file_id,welcome_banner_type,welcome_buttons_json,welcome_autodelete,goodbye_enabled,goodbye_message,goodbye_banner_file_id,goodbye_banner_type,goodbye_buttons_json,goodbye_autodelete,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(group_id) DO UPDATE SET
      welcome_enabled=excluded.welcome_enabled,
      welcome_message=excluded.welcome_message,
      welcome_banner_file_id=excluded.welcome_banner_file_id,
      welcome_banner_type=excluded.welcome_banner_type,
      welcome_buttons_json=excluded.welcome_buttons_json,
      welcome_autodelete=excluded.welcome_autodelete,
      goodbye_enabled=excluded.goodbye_enabled,
      goodbye_message=excluded.goodbye_message,
      goodbye_banner_file_id=excluded.goodbye_banner_file_id,
      goodbye_banner_type=excluded.goodbye_banner_type,
      goodbye_buttons_json=excluded.goodbye_buttons_json,
      goodbye_autodelete=excluded.goodbye_autodelete,
      updated_at=excluded.updated_at
  `).run(v.group_id,v.welcome_enabled,v.welcome_message,v.welcome_banner_file_id,v.welcome_banner_type,v.welcome_buttons_json,v.welcome_autodelete,v.goodbye_enabled,v.goodbye_message,v.goodbye_banner_file_id,v.goodbye_banner_type,v.goodbye_buttons_json,v.goodbye_autodelete,v.updated_at);
}
function groupSettings(groupId) {
  const row = db.prepare('SELECT * FROM group_settings WHERE group_id=?').get(Number(groupId));
  return row || {
    group_id:Number(groupId), welcome_enabled:0, welcome_message:'Halo {mention}\n\nSelamat datang di {group}.', welcome_banner_file_id:'', welcome_banner_type:'photo', welcome_buttons_json:'[]', welcome_autodelete:0,
    goodbye_enabled:0, goodbye_message:'Selamat jalan {fullname} dari {group}.', goodbye_banner_file_id:'', goodbye_banner_type:'photo', goodbye_buttons_json:'[]', goodbye_autodelete:0, updated_at:0
  };
}
function members(groupId) { return db.prepare('SELECT * FROM group_member_cache WHERE group_id=? AND is_deleted=0 AND is_bot=0 ORDER BY rowid').all(Number(groupId)); }
function memberCount(groupId) { return Number(db.prepare('SELECT COUNT(*) AS c FROM group_member_cache WHERE group_id=? AND is_deleted=0 AND is_bot=0').get(Number(groupId)).c); }
function setMembers(groupId, rows) {
  const tx = db.transaction(() => {
    const up = db.prepare(`INSERT INTO group_member_cache(group_id,user_id,username,first_name,last_name,is_bot,is_deleted,synced_at) VALUES(?,?,?,?,?,?,0,?) ON CONFLICT(group_id,user_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,is_bot=excluded.is_bot,is_deleted=0,synced_at=excluded.synced_at`);
    for (const r of rows) up.run(Number(groupId), Number(r.user_id), r.username || '', r.first_name || '', r.last_name || '', r.is_bot ? 1 : 0, now());
  });
  tx();
}
function markMissingDeleted(groupId, seenIds) {
  if (!seenIds.length) return;
  const placeholders = seenIds.map(()=>'?').join(',');
  db.prepare(`UPDATE group_member_cache SET is_deleted=1 WHERE group_id=? AND user_id NOT IN (${placeholders})`).run(Number(groupId), ...seenIds.map(Number));
}
function addQueue(requesterId, targetChatId, text, durationMinutes) {
  return Number(db.prepare('INSERT INTO tag_queue(requester_id,target_chat_id,text,status,created_at,duration_minutes) VALUES(?,?,?,?,?,?)').run(Number(requesterId), Number(targetChatId), String(text), 'pending', now(), Number(durationMinutes)).lastInsertRowid);
}
function nextQueue() { return db.prepare(`SELECT * FROM tag_queue WHERE status='pending' ORDER BY created_at LIMIT 1`).get(); }
function updateQueue(id, values) { const cols=Object.keys(values); if(!cols.length) return; db.prepare(`UPDATE tag_queue SET ${cols.map(k=>`${k}=?`).join(',')} WHERE id=?`).run(...cols.map(k=>values[k]), Number(id)); }
function listQueue(limit=20) { return db.prepare('SELECT * FROM tag_queue ORDER BY id DESC LIMIT ?').all(Number(limit)); }
function exportAll() {
  const tables = ['admins','settings','assistants','targets','group_member_cache','partners','tag_queue','group_settings','logs'];
  const out={version:2,exported_at:new Date().toISOString(),tables:{}};
  for (const t of tables) out.tables[t]=db.prepare(`SELECT * FROM ${t}`).all();
  return out;
}
function importAll(payload) {
  const allowed = ['admins','settings','assistants','targets','group_member_cache','partners','tag_queue','group_settings','logs'];
  if (!payload || payload.version < 1 || !payload.tables) throw new Error('Format JSON backup tidak valid');
  const tx = db.transaction(() => {
    for (const t of allowed) {
      db.exec(`DELETE FROM ${t}`);
      const rows = Array.isArray(payload.tables[t]) ? payload.tables[t] : [];
      if (!rows.length) continue;
      const keys = Object.keys(rows[0]);
      const placeholders = keys.map(()=>'?').join(',');
      const stmt = db.prepare(`INSERT OR REPLACE INTO ${t}(${keys.join(',')}) VALUES(${placeholders})`);
      for (const row of rows) stmt.run(...keys.map(k=>row[k]));
    }
  });
  tx();
}

module.exports = { db, now, getSetting, setSetting, log, addAdmin, isAdmin, assistant, upsertTarget, targetForLink, targets, saveGroupSettings, groupSettings, members, memberCount, setMembers, markMissingDeleted, addQueue, nextQueue, updateQueue, listQueue, exportAll, importAll };
