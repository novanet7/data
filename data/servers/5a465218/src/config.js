require('dotenv').config();

function intEnv(name, fallback = 0) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const config = {
  botToken: process.env.BOT_TOKEN || '',
  ownerId: String(process.env.OWNER_ID || ''),
  apiId: intEnv('API_ID'),
  apiHash: process.env.API_HASH || '',
};

function validate() {
  const missing = [];
  if (!config.botToken) missing.push('BOT_TOKEN');
  if (!config.ownerId) missing.push('OWNER_ID');
  if (!config.apiId) missing.push('API_ID');
  if (!config.apiHash) missing.push('API_HASH');
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);
}

module.exports = { config, validate };
