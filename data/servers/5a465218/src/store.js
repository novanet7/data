const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'config.json');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

const DEFAULTS = {
  keywords: [],
  targets: [],
  ignoredChats: [],
  accounts: [],
  running: true,
};

function ensure() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify(DEFAULTS, null, 2));
}

function load() {
  ensure();
  let data = {};
  try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  return { ...DEFAULTS, ...data };
}

let state = load();
function save() {
  ensure();
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
}
function get() { return state; }
function mutate(fn) { fn(state); save(); return state; }
function sessionPath(sessionId) { return path.join(SESSIONS_DIR, `${sessionId}.session`); }

module.exports = { get, save, mutate, sessionPath, ensure };
