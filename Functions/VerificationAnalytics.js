const MySQLDatabaseManager = require('./MySQLDatabaseManager');

const VERIFICATION_ANALYTICS_TOTALS_TABLE = 'verification_analytics_totals';
const VERIFICATION_ANALYTICS_EVENTS_TABLE = 'verification_analytics_events';

let verificationAnalyticsDbInitPromise = null;

function getDefaultAnalytics() {
    return {
        totals: {
            sessionsStarted: 0,
            successes: 0,
            failures: 0,
            timeouts: 0,
            fallbackUsed: 0,
            roleAssignmentFailures: 0,
            penaltiesApplied: 0,
            staffOverrides: 0,
            multiStepChallenges: 0,
            captchaStepPassed: 0,
            challengeStepPassed: 0,
            riskAssessed: 0,
            systemUnavailable: 0,
            antiRaidBlocks: 0,
            manualReviewBlocks: 0,
            standardTierSessions: 0,
            elevatedTierSessions: 0,
            advancedTierSessions: 0
        },
        breakdown: {
            challengeTypes: {
                math: 0,
                reverse: 0,
                token: 0,
                word_pair: 0,
                sequence: 0,
                largest_number: 0,
                vowel_count: 0,
                odd_one_out: 0,
                sort_letters: 0,
                captcha: 0
            },
            verificationModes: {
                dm: 0,
                channel_fallback: 0
            },
            tierUsage: {
                standard: 0,
                elevated: 0,
                advanced: 0
            },
            failureReasons: {
                captcha_timeout: 0,
                challenge_timeout: 0,
                captcha_max_attempts: 0,
                challenge_max_attempts: 0,
                risk_auto_fail: 0,
                anti_raid_lockdown_auto_fail: 0,
                verified_role_missing: 0,
                role_assignment_blocked: 0,
                system_unavailable: 0
            }
        },
        signals: {
            antiRaidLinkedSessions: 0,
            riskScoreBands: {
                low: 0,
                medium: 0,
                high: 0
            }
        },
        recent: [],
        updatedAt: null
    };
}

function extractReasonLabel(reason) {
    const raw = String(reason || '').trim();
    if (!raw) return null;

    const pipePart = raw.split('|')[0].trim();
    const colonPart = pipePart.split(':')[0].trim();
    return colonPart || null;
}

function extractTierLabel(reason) {
    const match = String(reason || '').match(/tier=(\d+|standard|elevated|advanced)/i);
    if (!match) return null;

    const value = String(match[1] || '').toLowerCase();
    if (value === '1') return 'standard';
    if (value === '2') return 'elevated';
    if (value === '3') return 'advanced';
    return value || null;
}

function extractRiskScore(reason) {
    const match = String(reason || '').match(/score=(\d+(?:\.\d+)?)/i);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
}

function isAntiRaidLinked(reason) {
    return /antiRaid=true|antiRaidLinked=true|anti_raid/i.test(String(reason || ''));
}

function normalizeAnalyticsEvent(event = {}) {
    const eventType = String(event.type || '').trim() || 'unknown';
    const mode = String(event.mode || '').trim() || null;
    const challengeType = String(event.challengeType || '').trim() || null;
    const timestampRaw = event.timestamp ? new Date(event.timestamp) : new Date();
    const timestamp = Number.isFinite(timestampRaw.getTime()) ? timestampRaw : new Date();

    return {
        timestamp,
        type: eventType,
        userId: event.userId || null,
        username: event.username || null,
        guildId: event.guildId || null,
        guildName: event.guildName || null,
        mode,
        challengeType,
        durationMs: Number.isFinite(Number(event.durationMs)) ? Number(event.durationMs) : null,
        reason: event.reason || null
    };
}

function getEventIncrementMap(eventType) {
    return {
        sessions_started: eventType === 'session_started' ? 1 : 0,
        successes: eventType === 'success' ? 1 : 0,
        failures: eventType === 'failure' ? 1 : 0,
        timeouts: eventType === 'timeout' ? 1 : 0,
        fallback_used: eventType === 'fallback_used' ? 1 : 0,
        role_assignment_failures: eventType === 'role_assignment_failed' ? 1 : 0,
        penalties_applied: eventType === 'penalty_applied' ? 1 : 0,
        staff_overrides: eventType === 'staff_override' ? 1 : 0,
        multi_step_challenges: eventType === 'multi_step_issued' ? 1 : 0,
        captcha_step_passed: eventType === 'step_captcha_passed' ? 1 : 0,
        challenge_step_passed: eventType === 'step_challenge_passed' ? 1 : 0,
        risk_assessed: eventType === 'risk_assessed' ? 1 : 0,
        system_unavailable: eventType === 'failure' ? 0 : 0,
        anti_raid_blocks: eventType === 'failure' ? 0 : 0,
        manual_review_blocks: eventType === 'failure' ? 0 : 0,
        standard_tier_sessions: 0,
        elevated_tier_sessions: 0,
        advanced_tier_sessions: 0
    };
}

function mapTotalsRowToSummary(row = {}) {
    return {
        sessionsStarted: toSafeNumber(row.sessions_started),
        successes: toSafeNumber(row.successes),
        failures: toSafeNumber(row.failures),
        timeouts: toSafeNumber(row.timeouts),
        fallbackUsed: toSafeNumber(row.fallback_used),
        roleAssignmentFailures: toSafeNumber(row.role_assignment_failures),
        penaltiesApplied: toSafeNumber(row.penalties_applied),
        staffOverrides: toSafeNumber(row.staff_overrides),
        multiStepChallenges: toSafeNumber(row.multi_step_challenges),
        captchaStepPassed: toSafeNumber(row.captcha_step_passed),
        challengeStepPassed: toSafeNumber(row.challenge_step_passed),
        riskAssessed: toSafeNumber(row.risk_assessed),
        systemUnavailable: toSafeNumber(row.system_unavailable),
        antiRaidBlocks: toSafeNumber(row.anti_raid_blocks),
        manualReviewBlocks: toSafeNumber(row.manual_review_blocks),
        standardTierSessions: toSafeNumber(row.standard_tier_sessions),
        elevatedTierSessions: toSafeNumber(row.elevated_tier_sessions),
        advancedTierSessions: toSafeNumber(row.advanced_tier_sessions)
    };
}

async function ensureVerificationAnalyticsDbReady() {
    if (verificationAnalyticsDbInitPromise) {
        return verificationAnalyticsDbInitPromise;
    }

    verificationAnalyticsDbInitPromise = (async () => {
        const query = MySQLDatabaseManager?.connection?.query;
        if (typeof query !== 'function') {
            throw new Error('MySQL connection query helper is not available');
        }

        await MySQLDatabaseManager.connection.query(`
            CREATE TABLE IF NOT EXISTS ${VERIFICATION_ANALYTICS_TOTALS_TABLE} (
                id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
                sessions_started BIGINT UNSIGNED NOT NULL DEFAULT 0,
                successes BIGINT UNSIGNED NOT NULL DEFAULT 0,
                failures BIGINT UNSIGNED NOT NULL DEFAULT 0,
                timeouts BIGINT UNSIGNED NOT NULL DEFAULT 0,
                fallback_used BIGINT UNSIGNED NOT NULL DEFAULT 0,
                role_assignment_failures BIGINT UNSIGNED NOT NULL DEFAULT 0,
                penalties_applied BIGINT UNSIGNED NOT NULL DEFAULT 0,
                staff_overrides BIGINT UNSIGNED NOT NULL DEFAULT 0,
                multi_step_challenges BIGINT UNSIGNED NOT NULL DEFAULT 0,
                captcha_step_passed BIGINT UNSIGNED NOT NULL DEFAULT 0,
                challenge_step_passed BIGINT UNSIGNED NOT NULL DEFAULT 0,
                risk_assessed BIGINT UNSIGNED NOT NULL DEFAULT 0,
                system_unavailable BIGINT UNSIGNED NOT NULL DEFAULT 0,
                anti_raid_blocks BIGINT UNSIGNED NOT NULL DEFAULT 0,
                manual_review_blocks BIGINT UNSIGNED NOT NULL DEFAULT 0,
                standard_tier_sessions BIGINT UNSIGNED NOT NULL DEFAULT 0,
                elevated_tier_sessions BIGINT UNSIGNED NOT NULL DEFAULT 0,
                advanced_tier_sessions BIGINT UNSIGNED NOT NULL DEFAULT 0,
                updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await MySQLDatabaseManager.connection.query(`
            ALTER TABLE ${VERIFICATION_ANALYTICS_TOTALS_TABLE}
                ADD COLUMN IF NOT EXISTS risk_assessed BIGINT UNSIGNED NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS system_unavailable BIGINT UNSIGNED NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS anti_raid_blocks BIGINT UNSIGNED NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS manual_review_blocks BIGINT UNSIGNED NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS standard_tier_sessions BIGINT UNSIGNED NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS elevated_tier_sessions BIGINT UNSIGNED NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS advanced_tier_sessions BIGINT UNSIGNED NOT NULL DEFAULT 0
        `).catch(() => {});

        await MySQLDatabaseManager.connection.query(`
            CREATE TABLE IF NOT EXISTS ${VERIFICATION_ANALYTICS_EVENTS_TABLE} (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                event_timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                event_type VARCHAR(64) NOT NULL,
                user_id VARCHAR(20) DEFAULT NULL,
                username VARCHAR(100) DEFAULT NULL,
                guild_id VARCHAR(20) DEFAULT NULL,
                guild_name VARCHAR(150) DEFAULT NULL,
                mode VARCHAR(50) DEFAULT NULL,
                challenge_type VARCHAR(50) DEFAULT NULL,
                duration_ms INT DEFAULT NULL,
                reason TEXT DEFAULT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_verification_event_timestamp (event_timestamp),
                INDEX idx_verification_event_type (event_type),
                INDEX idx_verification_event_mode (mode),
                INDEX idx_verification_event_challenge_type (challenge_type),
                INDEX idx_verification_event_guild (guild_id),
                INDEX idx_verification_event_user (user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await MySQLDatabaseManager.connection.query(
            `INSERT IGNORE INTO ${VERIFICATION_ANALYTICS_TOTALS_TABLE} (id) VALUES (1)`
        );
    })();

    try {
        await verificationAnalyticsDbInitPromise;
        return true;
    } catch (error) {
        verificationAnalyticsDbInitPromise = null;
        throw error;
    }
}

async function recordVerificationEventToDatabase(event = {}) {
    await ensureVerificationAnalyticsDbReady();

    const normalized = normalizeAnalyticsEvent(event);
    const increments = getEventIncrementMap(normalized.type);
    const reasonLabel = extractReasonLabel(normalized.reason);
    const tierLabel = extractTierLabel(normalized.reason);
    const systemUnavailableIncrement = reasonLabel === 'system_unavailable' ? 1 : 0;
    const antiRaidBlockIncrement = reasonLabel === 'anti_raid_lockdown_auto_fail' ? 1 : 0;
    const manualReviewBlockIncrement = reasonLabel === 'risk_auto_fail' ? 1 : 0;
    const standardTierIncrement = tierLabel === 'standard' ? 1 : 0;
    const elevatedTierIncrement = tierLabel === 'elevated' ? 1 : 0;
    const advancedTierIncrement = tierLabel === 'advanced' ? 1 : 0;

    await MySQLDatabaseManager.connection.query(
        `UPDATE ${VERIFICATION_ANALYTICS_TOTALS_TABLE}
         SET sessions_started = sessions_started + ?,
             successes = successes + ?,
             failures = failures + ?,
             timeouts = timeouts + ?,
             fallback_used = fallback_used + ?,
             role_assignment_failures = role_assignment_failures + ?,
             penalties_applied = penalties_applied + ?,
             staff_overrides = staff_overrides + ?,
             multi_step_challenges = multi_step_challenges + ?,
             captcha_step_passed = captcha_step_passed + ?,
             challenge_step_passed = challenge_step_passed + ?,
             risk_assessed = risk_assessed + ?,
             system_unavailable = system_unavailable + ?,
             anti_raid_blocks = anti_raid_blocks + ?,
             manual_review_blocks = manual_review_blocks + ?,
             standard_tier_sessions = standard_tier_sessions + ?,
             elevated_tier_sessions = elevated_tier_sessions + ?,
             advanced_tier_sessions = advanced_tier_sessions + ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = 1`,
        [
            increments.sessions_started,
            increments.successes,
            increments.failures,
            increments.timeouts,
            increments.fallback_used,
            increments.role_assignment_failures,
            increments.penalties_applied,
            increments.staff_overrides,
            increments.multi_step_challenges,
            increments.captcha_step_passed,
            increments.challenge_step_passed,
            increments.risk_assessed,
            systemUnavailableIncrement,
            antiRaidBlockIncrement,
            manualReviewBlockIncrement,
            standardTierIncrement,
            elevatedTierIncrement,
            advancedTierIncrement
        ]
    );

    await MySQLDatabaseManager.connection.query(
        `INSERT INTO ${VERIFICATION_ANALYTICS_EVENTS_TABLE}
            (event_timestamp, event_type, user_id, username, guild_id, guild_name, mode, challenge_type, duration_ms, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            normalized.timestamp,
            normalized.type,
            normalized.userId,
            normalized.username,
            normalized.guildId,
            normalized.guildName,
            normalized.mode,
            normalized.challengeType,
            normalized.durationMs,
            normalized.reason
        ]
    );
}

async function getVerificationAnalyticsFromDatabase({ days = 30 } = {}) {
    await ensureVerificationAnalyticsDbReady();

    const safeDays = Math.max(1, Math.min(365, Number(days) || 30));
    const cutoffDate = new Date(Date.now() - (safeDays * 24 * 60 * 60 * 1000));

    const [totalsRow] = await MySQLDatabaseManager.connection.query(
        `SELECT sessions_started, successes, failures, timeouts, fallback_used,
                role_assignment_failures, penalties_applied, staff_overrides,
                multi_step_challenges, captcha_step_passed, challenge_step_passed,
                risk_assessed, system_unavailable, anti_raid_blocks, manual_review_blocks,
                standard_tier_sessions, elevated_tier_sessions, advanced_tier_sessions,
                updated_at
         FROM ${VERIFICATION_ANALYTICS_TOTALS_TABLE}
         WHERE id = 1
         LIMIT 1`
    );

    const summary = mapTotalsRowToSummary(totalsRow || {});
    const successRate = summary.sessionsStarted > 0
        ? Number(((summary.successes / summary.sessionsStarted) * 100).toFixed(1))
        : 0;

    const [windowRow] = await MySQLDatabaseManager.connection.query(
        `SELECT
            COUNT(*) AS totalEvents,
            COALESCE(SUM(CASE WHEN event_type = 'success' THEN 1 ELSE 0 END), 0) AS successes,
            COALESCE(SUM(CASE WHEN event_type = 'failure' THEN 1 ELSE 0 END), 0) AS failures,
            COALESCE(SUM(CASE WHEN event_type = 'timeout' THEN 1 ELSE 0 END), 0) AS timeouts,
            COALESCE(SUM(CASE WHEN event_type = 'fallback_used' THEN 1 ELSE 0 END), 0) AS fallbackUsed
         FROM ${VERIFICATION_ANALYTICS_EVENTS_TABLE}
         WHERE event_timestamp >= ?`,
        [cutoffDate]
    );

    const challengeRows = await MySQLDatabaseManager.connection.query(
        `SELECT challenge_type, COUNT(*) AS count
         FROM ${VERIFICATION_ANALYTICS_EVENTS_TABLE}
         WHERE challenge_type IS NOT NULL AND challenge_type <> ''
         GROUP BY challenge_type`
    );

    const modeRows = await MySQLDatabaseManager.connection.query(
        `SELECT mode, COUNT(*) AS count
         FROM ${VERIFICATION_ANALYTICS_EVENTS_TABLE}
         WHERE mode IS NOT NULL AND mode <> ''
         GROUP BY mode`
    );

    const reasonRows = await MySQLDatabaseManager.connection.query(
        `SELECT reason, COUNT(*) AS count
         FROM ${VERIFICATION_ANALYTICS_EVENTS_TABLE}
         WHERE reason IS NOT NULL AND reason <> ''
         GROUP BY reason`
    );

    const recentRows = await MySQLDatabaseManager.connection.query(
        `SELECT event_timestamp, event_type, user_id, username, guild_id, guild_name, mode, challenge_type, duration_ms, reason
         FROM ${VERIFICATION_ANALYTICS_EVENTS_TABLE}
         ORDER BY event_timestamp DESC
         LIMIT 60`
    );

    const breakdown = {
        challengeTypes: {
            ...getDefaultAnalytics().breakdown.challengeTypes
        },
        verificationModes: {
            ...getDefaultAnalytics().breakdown.verificationModes
        },
        tierUsage: {
            ...getDefaultAnalytics().breakdown.tierUsage
        },
        failureReasons: {
            ...getDefaultAnalytics().breakdown.failureReasons
        }
    };

    const signals = {
        ...getDefaultAnalytics().signals
    };

    for (const row of challengeRows || []) {
        const key = String(row?.challenge_type || '').trim();
        if (!key) continue;
        if (!Object.prototype.hasOwnProperty.call(breakdown.challengeTypes, key)) {
            breakdown.challengeTypes[key] = 0;
        }
        breakdown.challengeTypes[key] = Number(row?.count || 0);
    }

    for (const row of modeRows || []) {
        const key = String(row?.mode || '').trim();
        if (!key) continue;
        if (!Object.prototype.hasOwnProperty.call(breakdown.verificationModes, key)) {
            breakdown.verificationModes[key] = 0;
        }
        breakdown.verificationModes[key] = Number(row?.count || 0);
    }

    for (const row of reasonRows || []) {
        const reasonLabel = extractReasonLabel(row?.reason);
        if (!reasonLabel) continue;

        if (Object.prototype.hasOwnProperty.call(breakdown.tierUsage, reasonLabel)) {
            breakdown.tierUsage[reasonLabel] += Number(row?.count || 0);
        }

        if (!Object.prototype.hasOwnProperty.call(breakdown.failureReasons, reasonLabel)) {
            breakdown.failureReasons[reasonLabel] = 0;
        }
        breakdown.failureReasons[reasonLabel] += Number(row?.count || 0);

        if (isAntiRaidLinked(row?.reason)) {
            signals.antiRaidLinkedSessions += Number(row?.count || 0);
        }

        const riskScore = extractRiskScore(row?.reason);
        if (riskScore !== null) {
            if (riskScore >= 60) {
                signals.riskScoreBands.high += Number(row?.count || 0);
            } else if (riskScore >= 30) {
                signals.riskScoreBands.medium += Number(row?.count || 0);
            } else {
                signals.riskScoreBands.low += Number(row?.count || 0);
            }
        }
    }

    breakdown.tierUsage.standard = summary.standardTierSessions;
    breakdown.tierUsage.elevated = summary.elevatedTierSessions;
    breakdown.tierUsage.advanced = summary.advancedTierSessions;

    const recent = (recentRows || []).map((row) => ({
        timestamp: row?.event_timestamp ? new Date(row.event_timestamp).toISOString() : new Date().toISOString(),
        type: row?.event_type || 'unknown',
        userId: row?.user_id || null,
        username: row?.username || null,
        guildId: row?.guild_id || null,
        guildName: row?.guild_name || null,
        mode: row?.mode || null,
        challengeType: row?.challenge_type || null,
        durationMs: Number.isFinite(Number(row?.duration_ms)) ? Number(row.duration_ms) : null,
        reason: row?.reason || null
    }));

    return {
        success: true,
        days: safeDays,
        summary: {
            ...summary,
            successRate
        },
        window: {
            totalEvents: Number(windowRow?.totalEvents || 0),
            successes: Number(windowRow?.successes || 0),
            failures: Number(windowRow?.failures || 0),
            timeouts: Number(windowRow?.timeouts || 0),
            fallbackUsed: Number(windowRow?.fallbackUsed || 0)
        },
        breakdown,
        signals,
        recent,
        updatedAt: totalsRow?.updated_at ? new Date(totalsRow.updated_at).toISOString() : null
    };
}

async function recordVerificationEvent(event = {}) {
    await recordVerificationEventToDatabase(event);
}

function toSafeNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

async function getVerificationAnalytics({ days = 30 } = {}) {
    return getVerificationAnalyticsFromDatabase({ days });
}

module.exports = {
    recordVerificationEvent,
    getVerificationAnalytics
};