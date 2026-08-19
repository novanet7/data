'use strict';

// In-memory session store (use Redis for production scaling)
const sessions = new Map();

const SESSION_TTL = parseInt(process.env.SESSION_TIMEOUT) || 300000; // 5 minutes

function sessionMiddleware(ctx, next) {
  const userId = ctx.from?.id;
  if (!userId) return next();

  const key = `${ctx.storeId || 'platform'}:${userId}`;

  // Get or create session
  if (!sessions.has(key)) {
    sessions.set(key, { data: {}, updatedAt: Date.now() });
  }

  const session = sessions.get(key);

  // Expire stale sessions
  if (Date.now() - session.updatedAt > SESSION_TTL) {
    sessions.set(key, { data: {}, updatedAt: Date.now() });
  }

  ctx.session = session.data;
  ctx.saveSession = () => {
    session.updatedAt = Date.now();
  };

  return next();
}

// Periodic cleanup of expired sessions
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of sessions.entries()) {
    if (now - session.updatedAt > SESSION_TTL * 2) {
      sessions.delete(key);
    }
  }
}, 60000);

function clearSession(storeId, userId) {
  const key = `${storeId}:${userId}`;
  sessions.delete(key);
}

module.exports = { sessionMiddleware, clearSession };
