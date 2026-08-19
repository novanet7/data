'use strict';

const { Repository } = require('../database/repository');

const repo = new Repository('audit_logs', {
  storeId: null,
  actorType: 'system',
  entityId: null,
  details: {},
  ip: null,
  userAgent: null,
  result: 'success',
  errorMessage: null,
});

const AuditLog = {
  async create(data) {
    return repo.create(data);
  },
  find(filter) { return repo.find(filter); },
  async findOne(filter) { return repo.findOne(filter); },
  async countDocuments(filter) { return repo.countDocuments(filter); },

  async log({
    storeId = null,
    actorId,
    actorType = 'system',
    action,
    entity,
    entityId = null,
    details = {},
    result = 'success',
    errorMessage = null,
  } = {}) {
    try {
      // Auto-purge logs older than 90 days to keep file size manageable
      const { readCollection, writeCollection } = require('../database/repository');
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const all = readCollection('audit_logs');
      const fresh = all.filter(d => d.createdAt >= cutoff);
      if (fresh.length < all.length) writeCollection('audit_logs', fresh);

      await repo.create({
        storeId,
        actorId: String(actorId),
        actorType,
        action,
        entity,
        entityId: entityId ? String(entityId) : null,
        details,
        result,
        errorMessage,
      });
    } catch (err) {
      console.error('[AuditLog] Write error:', err.message);
    }
  },
};

module.exports = AuditLog;
