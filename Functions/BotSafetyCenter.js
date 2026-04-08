const fs = require('fs');
const path = require('path');
const MySQLDatabaseManager = require('./MySQLDatabaseManager');

const MISC_CONFIG_PATH = path.join(__dirname, '..', 'Config', 'constants', 'misc.json');
const MAX_RECENT_ALERTS = 150;
let storageReadyPromise = null;

const DEFAULTS = Object.freeze({
    enabled: true,
    recentAlertLimit: 50,
    emojiBurstThreshold: 5,
    stickerBurstThreshold: 4,
    assetAuditWindowMs: 2 * 60 * 1000,
    assetAuditCooldownMs: 5 * 60 * 1000,
    inviteWindowMs: 15 * 60 * 1000,
    inviteMutationThreshold: 6,
    inviteJoinSpikeThreshold: 4,
    inviterJoinSpikeThreshold: 6,
    inviteAlertCooldownMs: 10 * 60 * 1000,
    nicknameAlertCooldownMs: 20 * 60 * 1000,
    attachmentCountThreshold: 6,
    attachmentTotalSizeMbThreshold: 25,
    moderationEscalationCooldownMs: 60 * 60 * 1000,
    moderationEscalationLastHourThreshold: 3,
    moderationEscalationLastDayThreshold: 6,
    moderationEscalationTimeoutThreshold: 2,
    moderationEscalationHighRiskThreshold: 3
});

const recentAlerts = [];

async function ensureStorageReady() {
    if (!storageReadyPromise) {
        storageReadyPromise = MySQLDatabaseManager.connection.pool.execute(`
            CREATE TABLE IF NOT EXISTS bot_safety_alerts (
                id VARCHAR(64) PRIMARY KEY,
                alert_type VARCHAR(80) NOT NULL,
                severity VARCHAR(32) NOT NULL,
                title VARCHAR(255) NOT NULL,
                message TEXT NOT NULL,
                guild_id VARCHAR(32) NULL,
                guild_name VARCHAR(255) NULL,
                metadata_json LONGTEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_bot_safety_alerts_created_at (created_at),
                INDEX idx_bot_safety_alerts_type (alert_type)
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
        `).catch((error) => {
            storageReadyPromise = null;
            throw error;
        });
    }

    return storageReadyPromise;
}

function readJsonSafe(filePath, fallbackValue) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallbackValue;
    }
}

function clampNumber(value, fallbackValue, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallbackValue;
    return Math.min(max, Math.max(min, parsed));
}

function normalizeConfig(raw = {}) {
    return {
        enabled: raw.enabled !== false,
        recentAlertLimit: clampNumber(raw.recentAlertLimit, DEFAULTS.recentAlertLimit, { min: 10, max: 100 }),
        emojiBurstThreshold: clampNumber(raw.emojiBurstThreshold, DEFAULTS.emojiBurstThreshold, { min: 2, max: 20 }),
        stickerBurstThreshold: clampNumber(raw.stickerBurstThreshold, DEFAULTS.stickerBurstThreshold, { min: 2, max: 20 }),
        assetAuditWindowMs: clampNumber(raw.assetAuditWindowMs, DEFAULTS.assetAuditWindowMs, { min: 15_000, max: 30 * 60 * 1000 }),
        assetAuditCooldownMs: clampNumber(raw.assetAuditCooldownMs, DEFAULTS.assetAuditCooldownMs, { min: 30_000, max: 60 * 60 * 1000 }),
        inviteWindowMs: clampNumber(raw.inviteWindowMs, DEFAULTS.inviteWindowMs, { min: 60_000, max: 24 * 60 * 60 * 1000 }),
        inviteMutationThreshold: clampNumber(raw.inviteMutationThreshold, DEFAULTS.inviteMutationThreshold, { min: 2, max: 50 }),
        inviteJoinSpikeThreshold: clampNumber(raw.inviteJoinSpikeThreshold, DEFAULTS.inviteJoinSpikeThreshold, { min: 2, max: 50 }),
        inviterJoinSpikeThreshold: clampNumber(raw.inviterJoinSpikeThreshold, DEFAULTS.inviterJoinSpikeThreshold, { min: 2, max: 50 }),
        inviteAlertCooldownMs: clampNumber(raw.inviteAlertCooldownMs, DEFAULTS.inviteAlertCooldownMs, { min: 30_000, max: 24 * 60 * 60 * 1000 }),
        nicknameAlertCooldownMs: clampNumber(raw.nicknameAlertCooldownMs, DEFAULTS.nicknameAlertCooldownMs, { min: 60_000, max: 24 * 60 * 60 * 1000 }),
        attachmentCountThreshold: clampNumber(raw.attachmentCountThreshold, DEFAULTS.attachmentCountThreshold, { min: 2, max: 20 }),
        attachmentTotalSizeMbThreshold: clampNumber(raw.attachmentTotalSizeMbThreshold, DEFAULTS.attachmentTotalSizeMbThreshold, { min: 1, max: 250 }),
        moderationEscalationCooldownMs: clampNumber(raw.moderationEscalationCooldownMs, DEFAULTS.moderationEscalationCooldownMs, { min: 60_000, max: 24 * 60 * 60 * 1000 }),
        moderationEscalationLastHourThreshold: clampNumber(raw.moderationEscalationLastHourThreshold, DEFAULTS.moderationEscalationLastHourThreshold, { min: 2, max: 20 }),
        moderationEscalationLastDayThreshold: clampNumber(raw.moderationEscalationLastDayThreshold, DEFAULTS.moderationEscalationLastDayThreshold, { min: 2, max: 50 }),
        moderationEscalationTimeoutThreshold: clampNumber(raw.moderationEscalationTimeoutThreshold, DEFAULTS.moderationEscalationTimeoutThreshold, { min: 1, max: 20 }),
        moderationEscalationHighRiskThreshold: clampNumber(raw.moderationEscalationHighRiskThreshold, DEFAULTS.moderationEscalationHighRiskThreshold, { min: 1, max: 20 })
    };
}

function saveConfig(nextConfig) {
    const current = readJsonSafe(MISC_CONFIG_PATH, {});
    if (!current.alerts || typeof current.alerts !== 'object') {
        current.alerts = {};
    }
    current.alerts.botSafety = normalizeConfig({ ...(current.alerts.botSafety || {}), ...nextConfig });
    fs.writeFileSync(MISC_CONFIG_PATH, `${JSON.stringify(current, null, '\t')}\n`, 'utf8');
    return getConfig();
}

async function persistAlert(entry) {
    await ensureStorageReady();
    let metadataJson = null;
    try {
        metadataJson = JSON.stringify(entry.meta || {});
    } catch {
        metadataJson = null;
    }

    await MySQLDatabaseManager.connection.pool.execute(
        `INSERT INTO bot_safety_alerts (id, alert_type, severity, title, message, guild_id, guild_name, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [entry.id, entry.type, entry.severity, entry.title, entry.message, entry.guildId, entry.guildName, metadataJson]
    );
}

function getConfig() {
    const miscConfig = readJsonSafe(MISC_CONFIG_PATH, {});
    const raw = miscConfig?.alerts?.botSafety || {};

    return normalizeConfig(raw);
}

function recordAlert(alert) {
    const config = getConfig();
    if (!config.enabled) return null;

    const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        type: String(alert?.type || 'unknown'),
        severity: String(alert?.severity || 'warning'),
        title: String(alert?.title || 'Bot Safety Alert'),
        message: String(alert?.message || ''),
        guildId: alert?.guildId ? String(alert.guildId) : null,
        guildName: alert?.guildName ? String(alert.guildName) : null,
        meta: alert?.meta && typeof alert.meta === 'object' ? alert.meta : {},
        createdAt: new Date().toISOString()
    };

    recentAlerts.unshift(entry);
    if (recentAlerts.length > MAX_RECENT_ALERTS) {
        recentAlerts.length = MAX_RECENT_ALERTS;
    }

    persistAlert(entry).catch((error) => {
        console.warn(`[BotSafetyCenter] Failed to persist alert: ${error.message}`);
    });

    return entry;
}

async function getRecentAlerts(limit = null) {
    const config = getConfig();
    const safeLimit = clampNumber(limit, config.recentAlertLimit, { min: 1, max: 100 });
    try {
        await ensureStorageReady();
        const [rows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT id, alert_type, severity, title, message, guild_id, guild_name, metadata_json, created_at
             FROM bot_safety_alerts
             ORDER BY created_at DESC
             LIMIT ?`,
            [safeLimit]
        );

        return (Array.isArray(rows) ? rows : []).map((row) => ({
            id: row.id,
            type: row.alert_type,
            severity: row.severity,
            title: row.title,
            message: row.message,
            guildId: row.guild_id,
            guildName: row.guild_name,
            meta: (() => {
                try {
                    return row.metadata_json ? JSON.parse(row.metadata_json) : {};
                } catch {
                    return {};
                }
            })(),
            createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString()
        }));
    } catch (error) {
        console.warn(`[BotSafetyCenter] Falling back to in-memory alerts: ${error.message}`);
        return recentAlerts.slice(0, safeLimit);
    }
}

async function getDashboardSnapshot(limit = null) {
    const alerts = await getRecentAlerts(limit);
    const summary = alerts.reduce((accumulator, alert) => {
        accumulator.total += 1;
        if (alert.severity === 'critical') accumulator.critical += 1;
        if (alert.severity === 'warning') accumulator.warning += 1;
        accumulator.byType[alert.type] = (accumulator.byType[alert.type] || 0) + 1;
        return accumulator;
    }, { total: 0, critical: 0, warning: 0, byType: {} });

    return {
        config: getConfig(),
        alerts,
        summary
    };
}

module.exports = {
    getConfig,
    saveConfig,
    recordAlert,
    getRecentAlerts,
    getDashboardSnapshot,
    ensureStorageReady
};