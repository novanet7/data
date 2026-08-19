'use strict';

/**
 * Onboarding Manager
 *
 * Provides secure credential onboarding for seller-managed accounts.
 * ALL operations require explicit owner authorization.
 *
 * Security requirements enforced:
 * - Owner must explicitly initiate and authorize all sessions
 * - All session data is AES-256-CBC encrypted at rest
 * - Sessions auto-expire via MongoDB TTL index
 * - Full audit logging for every operation
 * - No unauthorized access, bypass, or hidden monitoring
 */

const OnboardingSession = require('../models/OnboardingSession');
const Encryption = require('../utils/encryption');
const AuditLog = require('../models/AuditLog');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

const OTP_TIMEOUT = parseInt(process.env.OTP_TIMEOUT) || 120000;

class OnboardingManager {
  /**
   * Initiate a new onboarding session (owner-authorized)
   */
  static async initiateSession(storeId, ownerId, type = 'custom', metadata = {}) {
    // Revoke any active sessions to prevent duplicates
    await OnboardingSession.updateMany(
      { storeId, ownerId, status: { $in: ['initiated', 'otp_sent', 'otp_verified', 'active'] } },
      { $set: { status: 'revoked', revokedReason: 'Superseded by new session', revokedAt: new Date() } }
    );

    const sessionId = uuidv4();
    const session = await OnboardingSession.create({
      sessionId,
      storeId,
      ownerId: String(ownerId),
      type,
      status: 'initiated',
      expiresAt: new Date(Date.now() + OTP_TIMEOUT * 5),
      metadata,
    });

    await AuditLog.log({
      storeId,
      actorId: ownerId,
      actorType: 'owner',
      action: 'ONBOARDING_INITIATED',
      entity: 'OnboardingSession',
      entityId: sessionId,
      details: { type },
      result: 'success',
    });

    logger.info(`Onboarding session initiated: ${sessionId} for store ${storeId}`);
    return session;
  }

  /**
   * Store encrypted credentials for the session (owner-only)
   */
  static async storeCredentials(sessionId, ownerId, credentialData) {
    const session = await OnboardingSession.findOne({
      sessionId,
      ownerId: String(ownerId),
      status: { $in: ['initiated', 'otp_verified'] },
    });

    if (!session) throw new Error('Session not found or expired');
    if (session.isExpired) throw new Error('Session expired');

    const dataStr = JSON.stringify(credentialData);
    session.encryptedSessionData = dataStr; // Auto-encrypted via Mongoose setter
    session.status = 'active';
    session.activatedAt = new Date();
    await session.save();

    await AuditLog.log({
      storeId: session.storeId,
      actorId: ownerId,
      actorType: 'owner',
      action: 'ONBOARDING_CREDENTIALS_STORED',
      entity: 'OnboardingSession',
      entityId: sessionId,
      result: 'success',
    });

    return { success: true, sessionId };
  }

  /**
   * Retrieve session credentials (owner-only)
   */
  static async getCredentials(sessionId, ownerId) {
    const session = await OnboardingSession.findOne({
      sessionId,
      ownerId: String(ownerId),
      status: 'active',
    });

    if (!session) throw new Error('Active session not found');
    if (session.isExpired) throw new Error('Session expired');

    const data = JSON.parse(session.encryptedSessionData || '{}');

    await AuditLog.log({
      storeId: session.storeId,
      actorId: ownerId,
      actorType: 'owner',
      action: 'ONBOARDING_CREDENTIALS_ACCESSED',
      entity: 'OnboardingSession',
      entityId: sessionId,
      result: 'success',
    });

    return { data, session };
  }

  /**
   * Revoke a session (owner-authorized)
   */
  static async revokeSession(sessionId, ownerId, reason = 'Owner revocation') {
    const session = await OnboardingSession.findOne({ sessionId, ownerId: String(ownerId) });
    if (!session) throw new Error('Session not found');

    await session.revoke(reason);

    await AuditLog.log({
      storeId: session.storeId,
      actorId: ownerId,
      actorType: 'owner',
      action: 'ONBOARDING_SESSION_REVOKED',
      entity: 'OnboardingSession',
      entityId: sessionId,
      details: { reason },
      result: 'success',
    });

    logger.info(`Onboarding session revoked: ${sessionId} by owner ${ownerId}`);
    return { success: true };
  }

  /**
   * List active sessions for a store
   */
  static async listSessions(storeId, ownerId) {
    return OnboardingSession.find({
      storeId,
      ownerId: String(ownerId),
      status: { $in: ['initiated', 'active'] },
    })
    .select('sessionId type status activatedAt expiresAt metadata')
    .lean();
  }

  /**
   * Cleanup expired sessions (cron)
   */
  static async cleanupExpired() {
    const result = await OnboardingSession.updateMany(
      { expiresAt: { $lt: new Date() }, status: { $in: ['initiated', 'otp_sent'] } },
      { $set: { status: 'expired' } }
    );
    if (result.modifiedCount > 0) {
      logger.info(`Cleaned up ${result.modifiedCount} expired onboarding sessions`);
    }
    return result.modifiedCount;
  }
}

module.exports = OnboardingManager;
