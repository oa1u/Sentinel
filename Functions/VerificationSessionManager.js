const crypto = require('crypto');

const SESSION_TTL_MS = 10 * 60 * 1000;
const COOLDOWN_TIERS_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000, 30 * 60 * 1000];
const STREAK_RESET_MS = 24 * 60 * 60 * 1000;

const activeSessions = new Map();
const penaltyState = new Map();

function nowMs() {
    return Date.now();
}

function createSessionId() {
    return crypto.randomBytes(16).toString('hex');
}

function cleanupExpiredState() {
    const now = nowMs();

    for (const [userId, session] of activeSessions.entries()) {
        if (!session || now >= Number(session.expiresAt || 0)) {
            activeSessions.delete(userId);
        }
    }

    for (const [userId, state] of penaltyState.entries()) {
        if (!state) {
            penaltyState.delete(userId);
            continue;
        }

        const cooldownUntil = Number(state.cooldownUntil || 0);
        const lastFailureAt = Number(state.lastFailureAt || 0);
        const streak = Number(state.streak || 0);

        const cooldownExpired = !cooldownUntil || now >= cooldownUntil;
        const staleFailure = !lastFailureAt || (now - lastFailureAt > STREAK_RESET_MS);

        if ((cooldownExpired && streak <= 0) || (cooldownExpired && staleFailure)) {
            penaltyState.delete(userId);
        }
    }
}

function getPenaltyState(userId) {
    cleanupExpiredState();
    const key = String(userId || '').trim();
    if (!key) return { streak: 0, cooldownUntil: 0, lastFailureAt: 0 };

    return penaltyState.get(key) || { streak: 0, cooldownUntil: 0, lastFailureAt: 0 };
}

function canStartVerification(userId) {
    const state = getPenaltyState(userId);
    const now = nowMs();
    const remainingMs = Math.max(0, Number(state.cooldownUntil || 0) - now);

    return {
        allowed: remainingMs <= 0,
        remainingMs,
        streak: Number(state.streak || 0)
    };
}

function createVerificationSession({ userId, guildId, source = 'unknown', ttlMs = SESSION_TTL_MS } = {}) {
    cleanupExpiredState();

    const key = String(userId || '').trim();
    if (!key) {
        return null;
    }

    const now = nowMs();
    const safeTtl = Math.max(30 * 1000, Math.min(60 * 60 * 1000, Number(ttlMs) || SESSION_TTL_MS));

    const session = {
        sessionId: createSessionId(),
        userId: key,
        guildId: guildId ? String(guildId) : null,
        source: String(source || 'unknown'),
        createdAt: now,
        expiresAt: now + safeTtl
    };

    activeSessions.set(key, session);
    return session;
}

function invalidateVerificationSession(userId) {
    const key = String(userId || '').trim();
    if (!key) return;
    activeSessions.delete(key);
}

function isVerificationSessionActive(userId, sessionId) {
    cleanupExpiredState();

    const key = String(userId || '').trim();
    if (!key || !sessionId) {
        return { valid: false, reason: 'missing_context' };
    }

    const current = activeSessions.get(key);
    if (!current) {
        return { valid: false, reason: 'session_missing' };
    }

    if (String(current.sessionId) !== String(sessionId)) {
        return { valid: false, reason: 'session_replaced' };
    }

    if (nowMs() >= Number(current.expiresAt || 0)) {
        activeSessions.delete(key);
        return { valid: false, reason: 'session_expired' };
    }

    return { valid: true, reason: null };
}

function registerVerificationFailure(userId) {
    const key = String(userId || '').trim();
    if (!key) return { streak: 0, cooldownMs: 0, cooldownUntil: 0 };

    const now = nowMs();
    const existing = penaltyState.get(key) || { streak: 0, cooldownUntil: 0, lastFailureAt: 0 };
    const elapsed = existing.lastFailureAt ? now - Number(existing.lastFailureAt) : Infinity;
    const nextStreak = elapsed > STREAK_RESET_MS ? 1 : Number(existing.streak || 0) + 1;

    const tierIndex = Math.min(COOLDOWN_TIERS_MS.length - 1, Math.max(0, nextStreak - 1));
    const cooldownMs = COOLDOWN_TIERS_MS[tierIndex];
    const cooldownUntil = now + cooldownMs;

    penaltyState.set(key, {
        streak: nextStreak,
        cooldownUntil,
        lastFailureAt: now
    });

    invalidateVerificationSession(key);

    return { streak: nextStreak, cooldownMs, cooldownUntil };
}

function registerVerificationSuccess(userId) {
    const key = String(userId || '').trim();
    if (!key) return;

    penaltyState.delete(key);
    invalidateVerificationSession(key);
}

module.exports = {
    SESSION_TTL_MS,
    canStartVerification,
    createVerificationSession,
    invalidateVerificationSession,
    isVerificationSessionActive,
    registerVerificationFailure,
    registerVerificationSuccess
};