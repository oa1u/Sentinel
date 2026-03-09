const fs = require('fs');
const path = require('path');
const MySQLDatabaseManager = require('./MySQLDatabaseManager');

const ANALYTICS_FILE = path.join(__dirname, '..', 'Config', 'verificationAnalytics.json');
const MAX_RECENT_EVENTS = 300;
const VERIFICATION_ANALYTICS_TOTALS_TABLE = 'verification_analytics_totals';
const VERIFICATION_ANALYTICS_EVENTS_TABLE = 'verification_analytics_events';

let verificationAnalyticsDbInitPromise = null;
let verificationAnalyticsDbBackfillPromise = null;
let verificationAnalyticsDbUnavailableLogged = false;

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
            challengeStepPassed: 0
        },
        breakdown: {
            challengeTypes: {
                math: 0,
                reverse: 0,
                phrase: 0
            },
            verificationModes: {
                dm: 0,
                channel_fallback: 0
            }
        },
        recent: [],
        updatedAt: null
    };
}

async function ensureAnalyticsFile() {
    try {
        await fs.promises.access(ANALYTICS_FILE);
    } catch {
        await fs.promises.mkdir(path.dirname(ANALYTICS_FILE), { recursive: true });
        await fs.promises.writeFile(ANALYTICS_FILE, JSON.stringify(getDefaultAnalytics(), null, 2), 'utf8');
    }
}

async function readAnalytics() {
    await ensureAnalyticsFile();
    try {
        const raw = await fs.promises.readFile(ANALYTICS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return {
            ...getDefaultAnalytics(),
            ...parsed,
            totals: {
                ...getDefaultAnalytics().totals,
                ...(parsed?.totals || {})
            },
            breakdown: {
                ...getDefaultAnalytics().breakdown,
                ...(parsed?.breakdown || {}),
                challengeTypes: {
                    ...getDefaultAnalytics().breakdown.challengeTypes,
                    ...(parsed?.breakdown?.challengeTypes || {})
                },
                verificationModes: {
                    ...getDefaultAnalytics().breakdown.verificationModes,
                    ...(parsed?.breakdown?.verificationModes || {})
                }
            },
            recent: Array.isArray(parsed?.recent) ? parsed.recent : []
        };
    } catch {
        return getDefaultAnalytics();
    }
}

async function writeAnalytics(data) {
    const payload = {
        ...getDefaultAnalytics(),
        ...data,
        updatedAt: new Date().toISOString()
    };
    await fs.promises.writeFile(ANALYTICS_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

function incrementIfExists(container, key) {
    if (!container || !Object.prototype.hasOwnProperty.call(container, key)) return;
    container[key] += 1;
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
        challenge_step_passed: eventType === 'step_challenge_passed' ? 1 : 0
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
        challengeStepPassed: toSafeNumber(row.challenge_step_passed)
    };
}

function logVerificationAnalyticsDbFallback(error) {
    if (verificationAnalyticsDbUnavailableLogged) return;
    verificationAnalyticsDbUnavailableLogged = true;
    console.warn('[VerificationAnalytics] Falling back to file storage:', error?.message || error);
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
                updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

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

async function maybeBackfillVerificationAnalyticsFromFile() {
    if (verificationAnalyticsDbBackfillPromise) {
        return verificationAnalyticsDbBackfillPromise;
    }

    verificationAnalyticsDbBackfillPromise = (async () => {
        const [totalsRow] = await MySQLDatabaseManager.connection.query(
            `SELECT sessions_started, successes, failures, timeouts, fallback_used,
                    role_assignment_failures, penalties_applied, staff_overrides,
                    multi_step_challenges, captcha_step_passed, challenge_step_passed
             FROM ${VERIFICATION_ANALYTICS_TOTALS_TABLE}
             WHERE id = 1
             LIMIT 1`
        );

        const [eventCountRow] = await MySQLDatabaseManager.connection.query(
            `SELECT COUNT(*) AS totalCount FROM ${VERIFICATION_ANALYTICS_EVENTS_TABLE}`
        );

        const totalCount = Number(eventCountRow?.totalCount || 0);
        const totalsSnapshot = mapTotalsRowToSummary(totalsRow || {});
        const totalsSum = Object.values(totalsSnapshot).reduce((sum, value) => sum + Number(value || 0), 0);

        if (totalsSum > 0 || totalCount > 0) {
            return;
        }

        const fileAnalytics = await readAnalytics();
        const fileTotals = fileAnalytics?.totals || {};
        const updatedAt = fileAnalytics?.updatedAt ? new Date(fileAnalytics.updatedAt) : null;
        const safeUpdatedAt = updatedAt && Number.isFinite(updatedAt.getTime()) ? updatedAt : null;

        await MySQLDatabaseManager.connection.query(
            `UPDATE ${VERIFICATION_ANALYTICS_TOTALS_TABLE}
             SET sessions_started = ?,
                 successes = ?,
                 failures = ?,
                 timeouts = ?,
                 fallback_used = ?,
                 role_assignment_failures = ?,
                 penalties_applied = ?,
                 staff_overrides = ?,
                 multi_step_challenges = ?,
                 captcha_step_passed = ?,
                 challenge_step_passed = ?,
                 updated_at = COALESCE(?, CURRENT_TIMESTAMP)
             WHERE id = 1`,
            [
                toSafeNumber(fileTotals.sessionsStarted),
                toSafeNumber(fileTotals.successes),
                toSafeNumber(fileTotals.failures),
                toSafeNumber(fileTotals.timeouts),
                toSafeNumber(fileTotals.fallbackUsed),
                toSafeNumber(fileTotals.roleAssignmentFailures),
                toSafeNumber(fileTotals.penaltiesApplied),
                toSafeNumber(fileTotals.staffOverrides),
                toSafeNumber(fileTotals.multiStepChallenges),
                toSafeNumber(fileTotals.captchaStepPassed),
                toSafeNumber(fileTotals.challengeStepPassed),
                safeUpdatedAt
            ]
        );

        const recentEvents = Array.isArray(fileAnalytics?.recent) ? fileAnalytics.recent.slice(0, MAX_RECENT_EVENTS) : [];
        for (const row of recentEvents) {
            const event = normalizeAnalyticsEvent(row);
            await MySQLDatabaseManager.connection.query(
                `INSERT INTO ${VERIFICATION_ANALYTICS_EVENTS_TABLE}
                    (event_timestamp, event_type, user_id, username, guild_id, guild_name, mode, challenge_type, duration_ms, reason)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    event.timestamp,
                    event.type,
                    event.userId,
                    event.username,
                    event.guildId,
                    event.guildName,
                    event.mode,
                    event.challengeType,
                    event.durationMs,
                    event.reason
                ]
            );
        }
    })();

    try {
        await verificationAnalyticsDbBackfillPromise;
        return true;
    } catch (error) {
        verificationAnalyticsDbBackfillPromise = null;
        throw error;
    }
}

async function recordVerificationEventToDatabase(event = {}) {
    await ensureVerificationAnalyticsDbReady();
    await maybeBackfillVerificationAnalyticsFromFile();

    const normalized = normalizeAnalyticsEvent(event);
    const increments = getEventIncrementMap(normalized.type);

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
            increments.challenge_step_passed
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
    await maybeBackfillVerificationAnalyticsFromFile();

    const safeDays = Math.max(1, Math.min(365, Number(days) || 30));
    const cutoffDate = new Date(Date.now() - (safeDays * 24 * 60 * 60 * 1000));

    const [totalsRow] = await MySQLDatabaseManager.connection.query(
        `SELECT sessions_started, successes, failures, timeouts, fallback_used,
                role_assignment_failures, penalties_applied, staff_overrides,
                multi_step_challenges, captcha_step_passed, challenge_step_passed,
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
        }
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
        recent,
        updatedAt: totalsRow?.updated_at ? new Date(totalsRow.updated_at).toISOString() : null
    };
}

async function recordVerificationEvent(event = {}) {
    try {
        await recordVerificationEventToDatabase(event);
        return;
    } catch (error) {
        logVerificationAnalyticsDbFallback(error);
    }

    const analytics = await readAnalytics();
    const nowIso = new Date().toISOString();

    const eventType = String(event.type || '').trim();
    const mode = String(event.mode || '').trim();
    const challengeType = String(event.challengeType || '').trim();

    if (eventType === 'session_started') analytics.totals.sessionsStarted += 1;
    if (eventType === 'success') analytics.totals.successes += 1;
    if (eventType === 'failure') analytics.totals.failures += 1;
    if (eventType === 'timeout') analytics.totals.timeouts += 1;
    if (eventType === 'fallback_used') analytics.totals.fallbackUsed += 1;
    if (eventType === 'role_assignment_failed') analytics.totals.roleAssignmentFailures += 1;
    if (eventType === 'penalty_applied') analytics.totals.penaltiesApplied += 1;
    if (eventType === 'staff_override') analytics.totals.staffOverrides += 1;
    if (eventType === 'step_captcha_passed') analytics.totals.captchaStepPassed += 1;
    if (eventType === 'step_challenge_passed') analytics.totals.challengeStepPassed += 1;
    if (eventType === 'multi_step_issued') analytics.totals.multiStepChallenges += 1;

    incrementIfExists(analytics.breakdown.verificationModes, mode);
    incrementIfExists(analytics.breakdown.challengeTypes, challengeType);

    analytics.recent.unshift({
        timestamp: nowIso,
        type: eventType || 'unknown',
        userId: event.userId || null,
        username: event.username || null,
        guildId: event.guildId || null,
        guildName: event.guildName || null,
        mode: mode || null,
        challengeType: challengeType || null,
        durationMs: Number.isFinite(Number(event.durationMs)) ? Number(event.durationMs) : null,
        reason: event.reason || null
    });

    if (analytics.recent.length > MAX_RECENT_EVENTS) {
        analytics.recent.length = MAX_RECENT_EVENTS;
    }

    await writeAnalytics(analytics);
}

function toSafeNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

async function getVerificationAnalytics({ days = 30 } = {}) {
    try {
        return await getVerificationAnalyticsFromDatabase({ days });
    } catch (error) {
        logVerificationAnalyticsDbFallback(error);
    }

    const analytics = await readAnalytics();
    const safeDays = Math.max(1, Math.min(365, Number(days) || 30));
    const cutoff = Date.now() - (safeDays * 24 * 60 * 60 * 1000);

    const recentWindow = analytics.recent.filter((item) => {
        const ts = new Date(item.timestamp).getTime();
        return Number.isFinite(ts) && ts >= cutoff;
    });

    const summary = {
        sessionsStarted: toSafeNumber(analytics.totals.sessionsStarted),
        successes: toSafeNumber(analytics.totals.successes),
        failures: toSafeNumber(analytics.totals.failures),
        timeouts: toSafeNumber(analytics.totals.timeouts),
        fallbackUsed: toSafeNumber(analytics.totals.fallbackUsed),
        roleAssignmentFailures: toSafeNumber(analytics.totals.roleAssignmentFailures),
        penaltiesApplied: toSafeNumber(analytics.totals.penaltiesApplied),
        staffOverrides: toSafeNumber(analytics.totals.staffOverrides),
        multiStepChallenges: toSafeNumber(analytics.totals.multiStepChallenges),
        captchaStepPassed: toSafeNumber(analytics.totals.captchaStepPassed),
        challengeStepPassed: toSafeNumber(analytics.totals.challengeStepPassed)
    };

    const successRate = summary.sessionsStarted > 0
        ? Number(((summary.successes / summary.sessionsStarted) * 100).toFixed(1))
        : 0;

    const windowStats = {
        totalEvents: recentWindow.length,
        successes: recentWindow.filter((row) => row.type === 'success').length,
        failures: recentWindow.filter((row) => row.type === 'failure').length,
        timeouts: recentWindow.filter((row) => row.type === 'timeout').length,
        fallbackUsed: recentWindow.filter((row) => row.type === 'fallback_used').length
    };

    return {
        success: true,
        days: safeDays,
        summary: {
            ...summary,
            successRate
        },
        window: windowStats,
        breakdown: {
            challengeTypes: analytics.breakdown.challengeTypes,
            verificationModes: analytics.breakdown.verificationModes
        },
        recent: analytics.recent.slice(0, 60),
        updatedAt: analytics.updatedAt
    };
}

module.exports = {
    recordVerificationEvent,
    getVerificationAnalytics
};