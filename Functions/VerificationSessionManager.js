const crypto = require('crypto');
const { MISC: miscConfig } = require('../Config/constants');

const verificationConfig = miscConfig?.verification || {};
const failurePolicyConfig = verificationConfig.failurePolicy || {};

const SESSION_TTL_MS = Math.max(60 * 1000, Number(verificationConfig.challengeTimeoutMs || 10 * 60 * 1000));
const COOLDOWN_TIERS_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000, 30 * 60 * 1000];
const STREAK_RESET_MS = 24 * 60 * 60 * 1000;
const SESSION_HISTORY_LIMIT = 25;
const DIAGNOSTIC_LIMIT = 20;
const FAILURE_MULTIPLIERS = {
    captcha_timeout: 1,
    challenge_timeout: 1.15,
    captcha_max_attempts: 1.35,
    challenge_max_attempts: 1.5,
    risk_auto_fail: 1.75,
    anti_raid_lockdown_auto_fail: 1.8,
    dm_closed_and_no_verify_channel: 0,
    verified_role_missing: 0,
    role_assignment_blocked: 0,
    unexpected_error: 0,
    system_unavailable: 0,
    session_creation_failed: 0.5
};

const activeSessions = new Map();
const penaltyState = new Map();

function nowMs() {
    return Date.now();
}

function createSessionId() {
    return crypto.randomBytes(16).toString('hex');
}

function sanitizeHistory(entries) {
    return Array.isArray(entries) ? entries.slice(-SESSION_HISTORY_LIMIT) : [];
}

function sanitizeDiagnostics(entries) {
    return Array.isArray(entries) ? entries.slice(-DIAGNOSTIC_LIMIT) : [];
}

function createBaseSessionState({
    userId,
    guildId,
    source = 'unknown',
    ttlMs = SESSION_TTL_MS,
    totalSteps = 0,
    tier = 1,
    tierLabel = 'Standard',
    mode = 'dm',
    riskScore = 0,
    riskFlags = [],
    antiRaid = null,
    metadata = null
} = {}) {
    const now = nowMs();
    const safeTtl = Math.max(30 * 1000, Math.min(60 * 60 * 1000, Number(ttlMs) || SESSION_TTL_MS));
    return {
        sessionId: createSessionId(),
        userId: String(userId || '').trim(),
        guildId: guildId ? String(guildId) : null,
        source: String(source || 'unknown'),
        createdAt: now,
        updatedAt: now,
        expiresAt: now + safeTtl,
        totalSteps: Math.max(0, Number(totalSteps) || 0),
        currentStep: 0,
        currentStepLabel: null,
        currentChallengeType: null,
        tier: Math.max(1, Number(tier) || 1),
        tierLabel: String(tierLabel || 'Standard'),
        mode: String(mode || 'dm'),
        riskScore: Number.isFinite(Number(riskScore)) ? Number(riskScore) : 0,
        riskFlags: Array.isArray(riskFlags) ? [...riskFlags] : [],
        antiRaid: antiRaid && typeof antiRaid === 'object' ? { ...antiRaid } : null,
        attemptsByStep: {},
        stepResults: {},
        history: [],
        diagnostics: [],
        metadata: metadata && typeof metadata === 'object' ? { ...metadata } : {}
    };
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
    if (!key) {
        return { streak: 0, cooldownUntil: 0, lastFailureAt: 0, lastReason: null, multiplier: 1 };
    }

    return penaltyState.get(key) || { streak: 0, cooldownUntil: 0, lastFailureAt: 0, lastReason: null, multiplier: 1 };
}

function canStartVerification(userId) {
    const state = getPenaltyState(userId);
    const now = nowMs();
    const remainingMs = Math.max(0, Number(state.cooldownUntil || 0) - now);

    return {
        allowed: remainingMs <= 0,
        remainingMs,
        streak: Number(state.streak || 0),
        lastReason: state.lastReason || null
    };
}

function createVerificationSession(options = {}) {
    cleanupExpiredState();

    const key = String(options.userId || '').trim();
    if (!key) {
        return null;
    }

    const session = createBaseSessionState({ ...options, userId: key });
    activeSessions.set(key, session);
    return session;
}

function getVerificationSession(userId) {
    cleanupExpiredState();
    const key = String(userId || '').trim();
    if (!key) return null;
    return activeSessions.get(key) || null;
}

function updateVerificationSession(userId, patch = {}) {
    const key = String(userId || '').trim();
    if (!key) return null;

    const current = activeSessions.get(key);
    if (!current) return null;

    const next = {
        ...current,
        ...patch,
        updatedAt: nowMs()
    };

    if (patch.attemptsByStep && typeof patch.attemptsByStep === 'object') {
        next.attemptsByStep = {
            ...current.attemptsByStep,
            ...patch.attemptsByStep
        };
    }

    if (patch.stepResults && typeof patch.stepResults === 'object') {
        next.stepResults = {
            ...current.stepResults,
            ...patch.stepResults
        };
    }

    if (patch.metadata && typeof patch.metadata === 'object') {
        next.metadata = {
            ...current.metadata,
            ...patch.metadata
        };
    }

    next.history = Array.isArray(patch.history) ? sanitizeHistory(patch.history) : sanitizeHistory(current.history);
    next.diagnostics = Array.isArray(patch.diagnostics) ? sanitizeDiagnostics(patch.diagnostics) : sanitizeDiagnostics(current.diagnostics);

    activeSessions.set(key, next);
    return next;
}

function appendVerificationHistory(userId, entry = {}) {
    const session = getVerificationSession(userId);
    if (!session) return null;
    return updateVerificationSession(userId, {
        history: sanitizeHistory([
            ...session.history,
            {
                at: nowMs(),
                ...entry
            }
        ])
    });
}

function appendVerificationDiagnostic(userId, diagnostic) {
    const session = getVerificationSession(userId);
    if (!session) return null;
    return updateVerificationSession(userId, {
        diagnostics: sanitizeDiagnostics([
            ...session.diagnostics,
            {
                at: nowMs(),
                value: diagnostic
            }
        ])
    });
}

function markVerificationStepResult(userId, stepId, result = {}) {
    const session = getVerificationSession(userId);
    if (!session) return null;

    const safeStepId = String(stepId || '').trim() || `step_${session.currentStep || 0}`;
    const attempts = Number.isFinite(Number(result.attempts)) ? Number(result.attempts) : undefined;
    const attemptsByStep = attempts === undefined
        ? session.attemptsByStep
        : { ...session.attemptsByStep, [safeStepId]: attempts };
    const stepResults = {
        ...session.stepResults,
        [safeStepId]: {
            status: result.status || 'unknown',
            attempts: attempts === undefined ? (session.attemptsByStep[safeStepId] || 0) : attempts,
            challengeType: result.challengeType || session.currentChallengeType || null,
            completedAt: nowMs()
        }
    };

    return updateVerificationSession(userId, {
        attemptsByStep,
        stepResults
    });
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

    return { valid: true, reason: null, session: current };
}

function getFailureMultiplier(reason) {
    const configured = failurePolicyConfig.multipliers && typeof failurePolicyConfig.multipliers === 'object'
        ? Number(failurePolicyConfig.multipliers[reason])
        : NaN;
    if (Number.isFinite(configured)) {
        return Math.max(0, configured);
    }
    return Math.max(0, Number(FAILURE_MULTIPLIERS[reason] ?? 1));
}

function registerVerificationFailure(userId, options = {}) {
    const key = String(userId || '').trim();
    if (!key) {
        return { streak: 0, cooldownMs: 0, cooldownUntil: 0, multiplier: 1, reason: null };
    }

    const reason = String(options.reason || '').trim() || 'unknown_failure';
    const now = nowMs();
    const existing = penaltyState.get(key) || { streak: 0, cooldownUntil: 0, lastFailureAt: 0, lastReason: null, multiplier: 1 };
    const elapsed = existing.lastFailureAt ? now - Number(existing.lastFailureAt) : Infinity;
    const nextStreak = elapsed > STREAK_RESET_MS ? 1 : Number(existing.streak || 0) + 1;
    const tierIndex = Math.min(COOLDOWN_TIERS_MS.length - 1, Math.max(0, nextStreak - 1));
    const baseCooldownMs = COOLDOWN_TIERS_MS[tierIndex];
    const multiplier = Number.isFinite(Number(options.multiplier))
        ? Math.max(0, Number(options.multiplier))
        : getFailureMultiplier(reason);
    const cooldownMs = Math.max(0, Math.round(baseCooldownMs * multiplier));
    const cooldownUntil = cooldownMs > 0 ? now + cooldownMs : 0;

    penaltyState.set(key, {
        streak: nextStreak,
        cooldownUntil,
        lastFailureAt: now,
        lastReason: reason,
        multiplier
    });

    if (options.skipSessionInvalidate !== true) {
        invalidateVerificationSession(key);
    }

    return { streak: nextStreak, cooldownMs, cooldownUntil, multiplier, reason };
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
    getPenaltyState,
    createVerificationSession,
    getVerificationSession,
    updateVerificationSession,
    appendVerificationHistory,
    appendVerificationDiagnostic,
    markVerificationStepResult,
    invalidateVerificationSession,
    isVerificationSessionActive,
    registerVerificationFailure,
    registerVerificationSuccess
};