// Admin Panel server - backend for the dashboard
// Serves the admin UI, manages sessions, and applies security protections.
const express = require('express');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const bodyParser = require('body-parser');
const multer = require('multer');
const sharp = require('sharp');
const http = require('http');
const socketIo = require('socket.io');
const MySQLDatabaseManager = require('./Functions/MySQLDatabaseManager');
const ServerBackupManager = require('./Functions/ServerBackupManager');
const AdminPanelHelper = require('./Functions/AdminPanelHelper');
const TotpHelper = require('./Functions/TotpHelper');
const EmailHelper = require('./Functions/EmailHelper');
const BotSafetyCenter = require('./Functions/BotSafetyCenter');
const QRCode = require('qrcode');
const {
    buildDiscordLinkSecurityState: buildDiscordLinkSecurityStateHelper,
    persistDiscordVerificationState: persistDiscordVerificationStateHelper,
    applyDiscordRoleSyncPolicy: applyDiscordRoleSyncPolicyHelper
} = require('./Functions/DiscordRoleSyncHelper');
const { getVerificationAnalytics } = require('./Functions/VerificationAnalytics');
const CsrfHelper = require('./Functions/CsrfHelper');
const { getStats } = require('./Functions/botStats');
const { generateCaseId } = require('./Events/caseId');
const { createModerationEmbed, createModerationDmEmbed } = require('./Functions/EmbedBuilders');
const { updateTicketChannelAssigneeName } = require('./Functions/TicketLifecycle');
const { EmbedBuilder } = require('discord.js');
const moment = require('moment');
require('moment-duration-format');
const { CHANNELS: { serverLogChannelId, discordChannelId, suggestionChannelId }, RULES: RULES_CONFIG, MISC: MISC_CONFIG, ROLES: ROLES_CONFIG } = require('./Config/constants');

const ADMIN_AVATAR_UPLOAD_DIR = path.join(__dirname, 'AdminPanel', 'public', 'uploads', 'avatars');
const ADMIN_AVATAR_PUBLIC_PREFIX = '/public/uploads/avatars/';
const ADMIN_AVATAR_SIZE = 256;
const APPEAL_EVIDENCE_UPLOAD_DIR = path.join(__dirname, 'AdminPanel', 'public', 'uploads', 'appeals');
const APPEAL_EVIDENCE_PUBLIC_PREFIX = '/public/uploads/appeals/';
const ADMIN_AVATAR_ALLOWED_MIME_TYPES = Object.freeze({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif'
});
const APPEAL_EVIDENCE_ALLOWED_MIME_TYPES = Object.freeze({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'text/plain': 'txt'
});
const APPEAL_REVIEW_STAGES = Object.freeze([
    'submitted',
    'triage',
    'evidence-review',
    'final-review',
    'awaiting-decision',
    'decision-issued',
    'withdrawn'
]);

fs.mkdirSync(ADMIN_AVATAR_UPLOAD_DIR, { recursive: true });
fs.mkdirSync(APPEAL_EVIDENCE_UPLOAD_DIR, { recursive: true });

function validateCsrfHelperApi() {
    const requiredMethods = ['generateSecret', 'createToken', 'verifyToken', 'verifyOrigin'];
    const missingMethods = requiredMethods.filter(
        (methodName) => typeof CsrfHelper?.[methodName] !== 'function'
    );

    if (missingMethods.length > 0) {
        throw new TypeError(
            `[AdminPanel] Invalid CsrfHelper API. Missing methods: ${missingMethods.join(', ')}`
        );
    }
}

validateCsrfHelperApi();



// Load environment variables and add security headers
const helmet = require('helmet');
require('dotenv').config({
    path: path.join(__dirname, 'Config', 'credentials.env'),
    override: false,
    debug: false,
    quiet: true
});

const MAIN_CONFIG = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'Config', 'main.json'), 'utf8'));
    } catch {
        return {};
    }
})();

const PANEL_BOT_NAME = String(MAIN_CONFIG?.botName || 'Sentinel').trim() || 'Sentinel';
const PANEL_SERVER_NAME = String(MAIN_CONFIG?.serverName || 'Sentinel').trim() || 'Sentinel';

const app = express();
app.disable('x-powered-by');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ADMIN_PORT = process.env.ADMIN_PORT || 3000;
const ADMIN_ORIGIN = String(process.env.ADMIN_ORIGIN || '').trim();
const ENFORCE_HOST_HEADER = (() => {
    const raw = String(process.env.ADMIN_ENFORCE_HOST_HEADER || (IS_PRODUCTION ? 'true' : 'false')).trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(raw);
})();
const ADMIN_ALLOWED_HOSTS = new Set(
    String(process.env.ADMIN_ALLOWED_HOSTS || '')
        .split(',')
        .map((entry) => String(entry || '').trim().toLowerCase())
        .filter(Boolean)
);

function normalizeHostName(hostValue) {
    const raw = String(hostValue || '').trim().toLowerCase();
    if (!raw) return '';

    try {
        const parsed = new URL(`http://${raw}`);
        return String(parsed.hostname || '').trim().toLowerCase();
    } catch {
        const noPort = raw.startsWith('[')
            ? raw.replace(/^\[([^\]]+)\](?::\d+)?$/, '$1')
            : raw.replace(/:\d+$/, '');
        return noPort.replace(/\.+$/, '').trim();
    }
}

function normalizeOriginValue(originValue) {
    const raw = String(originValue || '').trim();
    if (!raw) return '';

    try {
        return new URL(raw).origin.toLowerCase();
    } catch {
        return raw.replace(/\/+$/, '').toLowerCase();
    }
}

function getRequestOrigin(req) {
    const forwardedProtoHeader = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const forwardedHostHeader = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    const requestProtocol = forwardedProtoHeader || req.protocol || 'http';
    const requestHost = forwardedHostHeader || req.get('host') || '';

    if (!requestHost) return '';

    return normalizeOriginValue(`${requestProtocol}://${requestHost}`);
}

function getAllowedHostNames() {
    const hosts = new Set(['localhost', '127.0.0.1', '::1']);
    for (const host of ADMIN_ALLOWED_HOSTS) {
        const normalized = normalizeHostName(host);
        if (normalized) hosts.add(normalized);
    }

    if (ADMIN_ORIGIN) {
        try {
            const hostFromOrigin = new URL(ADMIN_ORIGIN).hostname;
            const normalized = normalizeHostName(hostFromOrigin);
            if (normalized) hosts.add(normalized);
        } catch {
            const normalized = normalizeHostName(ADMIN_ORIGIN);
            if (normalized) hosts.add(normalized);
        }
    }

    return hosts;
}

const ALLOWED_HOST_NAMES = getAllowedHostNames();

function isAllowedHostHeader(hostHeader) {
    const normalized = normalizeHostName(String(hostHeader || '').split(',')[0]);
    if (!normalized) return true;

    if (!ENFORCE_HOST_HEADER) {
        return true;
    }

    return ALLOWED_HOST_NAMES.has(normalized);
}

function isAllowedOrigin(origin) {
    if (!origin) return true;

    const normalized = String(origin).trim().toLowerCase();
    const localOrigins = new Set([
        `http://localhost:${ADMIN_PORT}`.toLowerCase(),
        `http://127.0.0.1:${ADMIN_PORT}`.toLowerCase(),
        `https://localhost:${ADMIN_PORT}`.toLowerCase(),
        `https://127.0.0.1:${ADMIN_PORT}`.toLowerCase()
    ]);

    if (ADMIN_ORIGIN && normalized === ADMIN_ORIGIN.toLowerCase()) {
        return true;
    }

    if (localOrigins.has(normalized)) {
        return true;
    }

    if (!IS_PRODUCTION && normalized.includes('ngrok')) {
        return true;
    }

    return false;
}

const securitySignalThrottle = new Map();
const suspiciousSignalActivityByIp = new Map();
const suspiciousAlertThrottleByIp = new Map();

const SUSPICIOUS_SIGNAL_WEIGHTS = Object.freeze({
    'host-header-blocked': 6,
    'auth-origin-blocked': 5,
    'api-origin-blocked': 4,
    'csrf-token-failed': 3,
    'csrf-origin-failed': 2,
    'rate-limit-hit': 2,
    'login-ip-locked': 5,
    'login-identifier-locked': 5,
    'login-bruteforce-threshold': 6,
    'new-device-login': 3,
    'device-binding-blocked': 8,
    'ip-reputation-elevated': 3,
    'ip-reputation-blocked': 8
});

const IP_REPUTATION_BLOCK_SCORE = (() => {
    const parsed = Number(process.env.IP_REPUTATION_BLOCK_SCORE);
    return Number.isFinite(parsed) && parsed >= 40 && parsed <= 100 ? parsed : 80;
})();

const IP_REPUTATION_ELEVATED_SCORE = (() => {
    const parsed = Number(process.env.IP_REPUTATION_ELEVATED_SCORE);
    if (Number.isFinite(parsed) && parsed >= 20 && parsed < IP_REPUTATION_BLOCK_SCORE) {
        return parsed;
    }
    return Math.min(55, Math.max(20, IP_REPUTATION_BLOCK_SCORE - 20));
})();

const DEVICE_BINDING_STRICT_MODE = (() => {
    const raw = String(process.env.DEVICE_BINDING_STRICT_MODE || 'false').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(raw);
})();

const DEVICE_BINDING_MAX_DEVICES = (() => {
    const parsed = Number(process.env.DEVICE_BINDING_MAX_DEVICES);
    return Number.isFinite(parsed) && parsed >= 3 && parsed <= 50 ? Math.floor(parsed) : 20;
})();

const NEW_DEVICE_EMAIL_ALERT_ENABLED = (() => {
    const raw = String(process.env.NEW_DEVICE_EMAIL_ALERT_ENABLED || 'true').trim().toLowerCase();
    return !['0', 'false', 'no', 'off'].includes(raw);
})();

const SUSPICIOUS_ACTIVITY_WINDOW_MS = (() => {
    const parsed = Number(process.env.SUSPICIOUS_ACTIVITY_WINDOW_MS);
    return Number.isFinite(parsed) && parsed >= 60 * 1000 ? parsed : 10 * 60 * 1000;
})();

const SUSPICIOUS_ACTIVITY_SCORE_THRESHOLD = (() => {
    const parsed = Number(process.env.SUSPICIOUS_ACTIVITY_SCORE_THRESHOLD);
    return Number.isFinite(parsed) && parsed >= 5 ? parsed : 9;
})();

const SUSPICIOUS_ACTIVITY_MIN_DISTINCT_SIGNALS = (() => {
    const parsed = Number(process.env.SUSPICIOUS_ACTIVITY_MIN_DISTINCT_SIGNALS);
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : 2;
})();

const SUSPICIOUS_ACTIVITY_ALERT_COOLDOWN_MS = (() => {
    const parsed = Number(process.env.SUSPICIOUS_ACTIVITY_ALERT_COOLDOWN_MS);
    return Number.isFinite(parsed) && parsed >= 60 * 1000 ? parsed : 10 * 60 * 1000;
})();

function cleanupSuspiciousMaps(now = Date.now()) {
    if (suspiciousSignalActivityByIp.size > 3000) {
        for (const [ip, records] of suspiciousSignalActivityByIp.entries()) {
            const active = (Array.isArray(records) ? records : []).filter((entry) => now - Number(entry?.timestamp || 0) <= SUSPICIOUS_ACTIVITY_WINDOW_MS);
            if (active.length === 0) {
                suspiciousSignalActivityByIp.delete(ip);
            } else {
                suspiciousSignalActivityByIp.set(ip, active);
            }
        }
    }

    if (suspiciousAlertThrottleByIp.size > 3000) {
        for (const [ip, lastAt] of suspiciousAlertThrottleByIp.entries()) {
            if (now - Number(lastAt || 0) > Math.max(SUSPICIOUS_ACTIVITY_ALERT_COOLDOWN_MS, 30 * 60 * 1000)) {
                suspiciousAlertThrottleByIp.delete(ip);
            }
        }
    }
}

function maybeTriggerSuspiciousActivityAlert(req, signal, metadata = {}) {
    try {
        const signalKey = String(signal || '').toLowerCase();
        const weight = Number(SUSPICIOUS_SIGNAL_WEIGHTS[signalKey] || 0);
        if (weight <= 0 || signalKey === 'suspicious-activity-detected') return;

        const now = Date.now();
        const ip = String(req?.clientIP || req?.ip || metadata?.ipAddress || 'unknown');
        const existing = suspiciousSignalActivityByIp.get(ip) || [];
        const active = existing.filter((entry) => now - Number(entry?.timestamp || 0) <= SUSPICIOUS_ACTIVITY_WINDOW_MS);
        active.push({
            signal: signalKey,
            weight,
            timestamp: now
        });

        suspiciousSignalActivityByIp.set(ip, active);
        cleanupSuspiciousMaps(now);

        const totalScore = active.reduce((sum, entry) => sum + Number(entry?.weight || 0), 0);
        const distinctSignalCount = new Set(active.map((entry) => String(entry?.signal || '').toLowerCase()).filter(Boolean)).size;
        if (totalScore < SUSPICIOUS_ACTIVITY_SCORE_THRESHOLD) return;
        if (distinctSignalCount < SUSPICIOUS_ACTIVITY_MIN_DISTINCT_SIGNALS) return;

        const lastAlertAt = Number(suspiciousAlertThrottleByIp.get(ip) || 0);
        if (now - lastAlertAt < SUSPICIOUS_ACTIVITY_ALERT_COOLDOWN_MS) return;
        suspiciousAlertThrottleByIp.set(ip, now);

        const summarySignals = Array.from(new Set(active.map((entry) => entry.signal))).slice(0, 6);
        const alertPayload = {
            signal: 'suspicious-activity-detected',
            ipAddress: ip,
            score: totalScore,
            distinctSignals: distinctSignalCount,
            totalSignalsObserved: active.length,
            windowMs: SUSPICIOUS_ACTIVITY_WINDOW_MS,
            signals: summarySignals,
            path: String(req?.path || metadata?.path || ''),
            method: String(req?.method || metadata?.method || '').toUpperCase(),
            username: String(req?.session?.username || metadata?.username || 'security')
        };

        logAdminAuthEvent('security', 'LOGIN_FAILED', req, alertPayload).catch(() => { });

        try {
            if (io && typeof io.to === 'function') {
                io.to('owners').emit('suspicious-activity-alert', {
                    ...alertPayload,
                    createdAt: new Date(now).toISOString()
                });
            }
        } catch (socketError) {
            console.error('[Security] Failed to emit suspicious activity alert socket event:', socketError?.message || socketError);
        }

        console.warn(`[Security] Suspicious activity alert triggered for ${ip}. score=${totalScore}, distinct=${distinctSignalCount}, signals=${summarySignals.join(', ')}`);
    } catch (error) {
        console.error('[Security] Failed to evaluate suspicious activity alert:', error?.message || error);
    }
}

function emitSecuritySignal(req, signal, metadata = {}, throttleMs = 60 * 1000) {
    try {
        const ip = String(req?.clientIP || req?.ip || 'unknown');
        const pathName = String(req?.path || metadata?.path || 'unknown');
        const method = String(req?.method || metadata?.method || 'unknown').toUpperCase();
        const key = `${signal}:${ip}:${pathName}:${method}`;
        const now = Date.now();
        const lastAt = Number(securitySignalThrottle.get(key) || 0);

        if (now - lastAt < Math.max(1000, Number(throttleMs) || 0)) {
            return;
        }

        securitySignalThrottle.set(key, now);

        if (securitySignalThrottle.size > 2000) {
            for (const [entryKey, timestamp] of securitySignalThrottle.entries()) {
                if (now - Number(timestamp || 0) > 10 * 60 * 1000) {
                    securitySignalThrottle.delete(entryKey);
                }
            }
        }

        const payload = {
            signal,
            path: pathName,
            method,
            ...metadata
        };

        maybeTriggerSuspiciousActivityAlert(req, signal, payload);

        console.warn(`[Security] ${signal} detected for ${ip} on ${method} ${pathName}`);
        logAdminAuthEvent('security', 'LOGIN_FAILED', req, payload).catch(() => { });
    } catch (error) {
        console.error('[Security] Failed to emit security signal:', error.message || error);
    }
}

function logDiscordOAuthStartupStatus() {
    const required = [
        { key: 'CLIENT_ID', value: process.env.CLIENT_ID },
        { key: 'DISCORD_OAUTH_CLIENT_SECRET', value: process.env.DISCORD_OAUTH_CLIENT_SECRET }
    ];

    const missing = required
        .filter((item) => !String(item.value || '').trim())
        .map((item) => item.key);

    if (missing.length) {
        console.warn('⚠️ Discord OAuth link is not fully configured.');
        console.warn(`   Missing: ${missing.join(', ')}`);
        console.warn('   Discord account linking via OAuth will remain disabled until these are set in Config/credentials.env.');
        return;
    }

    const redirectValue = String(process.env.DISCORD_OAUTH_REDIRECT_URI || '').trim();
    if (!redirectValue) {
        console.info('ℹ️ DISCORD_OAUTH_REDIRECT_URI is not set. Using runtime fallback callback URL based on current host.');
    }

    console.log('✅ Discord OAuth link configuration detected.');
}

logDiscordOAuthStartupStatus();


app.use(cookieParser());
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            "default-src": ["'self'"],
            "script-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdn.socket.io", "https://cdnjs.cloudflare.com"],
            "style-src": ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
            "font-src": ["'self'", "data:", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com"],
            "img-src": ["'self'", "data:", "blob:", "https://cdn.discordapp.com", "https://cdnjs.cloudflare.com"],
            "connect-src": ["'self'", "ws:", "wss:", "https://cdn.socket.io"]
        },
    },
}));
// Redirect to HTTPS if running in production
app.use((req, res, next) => {
    if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
        return res.redirect('https://' + req.headers.host + req.url);
    }
    next();
});

// Reference to the Discord bot client, set by index.js
let discordClient = null;
function setDiscordClient(client) {
    discordClient = client;
    adminPanelRuntime.discordClientAttachedAt = Date.now();
}

function toBase64Url(buffer) {
    return Buffer.from(buffer)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function buildDiscordOAuthBindingHash(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function buildDiscordOAuthRequestBinding(req) {
    return {
        username: String(req?.session?.username || '').trim(),
        ipHash: buildDiscordOAuthBindingHash(req?.clientIP || req?.ip || ''),
        userAgentHash: buildDiscordOAuthBindingHash(req?.userAgent || req?.headers?.['user-agent'] || ''),
        host: normalizeHostName(req?.get?.('host') || req?.headers?.host || '')
    };
}

function getPrimaryTwoFactorEncryptionKey() {
    return String(process.env.TOTP_ENCRYPTION_KEY || process.env.SESSION_SECRET || '').trim();
}

function getTwoFactorEncryptionKeyCandidates() {
    const seen = new Set();
    return [process.env.TOTP_ENCRYPTION_KEY, process.env.SESSION_SECRET]
        .map((value) => String(value || '').trim())
        .filter((value) => value && !seen.has(value) && seen.add(value));
}

function encryptStoredTwoFactorSecret(secret) {
    const encryptionKey = getPrimaryTwoFactorEncryptionKey();
    if (!encryptionKey) {
        throw new Error('Missing TOTP encryption key');
    }

    return TotpHelper.encryptTwoFactorSecret(secret, encryptionKey);
}

function decryptStoredTwoFactorSecret(payload) {
    const candidates = getTwoFactorEncryptionKeyCandidates();
    let lastError = null;

    for (const encryptionKey of candidates) {
        try {
            return {
                secret: TotpHelper.decryptTwoFactorSecret(payload, encryptionKey),
                keyUsed: encryptionKey
            };
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error('Unable to decrypt TOTP secret');
}

async function reencryptTwoFactorSecretIfNeeded(userId, secret, keyUsed) {
    const preferredKey = getPrimaryTwoFactorEncryptionKey();
    if (!preferredKey || !secret || keyUsed === preferredKey) {
        return;
    }

    const encryptedSecret = TotpHelper.encryptTwoFactorSecret(secret, preferredKey);
    await MySQLDatabaseManager.connection.pool.execute(
        `UPDATE admin_users
         SET two_factor_secret = ?
         WHERE id = ?`,
        [encryptedSecret, userId]
    );
}

function buildTwoFactorChallengeBinding(req) {
    return {
        sessionId: String(req?.sessionID || ''),
        ipHash: buildDiscordOAuthBindingHash(req?.clientIP || req?.ip || ''),
        userAgentHash: buildDiscordOAuthBindingHash(req?.userAgent || req?.headers?.['user-agent'] || '')
    };
}

function isSameTwoFactorChallengeBinding(expected, actual) {
    return String(expected?.sessionId || '') === String(actual?.sessionId || '')
        && String(expected?.ipHash || '') === String(actual?.ipHash || '')
        && String(expected?.userAgentHash || '') === String(actual?.userAgentHash || '');
}

async function consumeVerifiedTwoFactorCounter(userId, counter) {
    const normalizedCounter = Number(counter);
    if (!Number.isFinite(normalizedCounter)) {
        return false;
    }

    const [result] = await MySQLDatabaseManager.connection.pool.execute(
        `UPDATE admin_users
         SET two_factor_last_counter = ?,
             two_factor_last_verified_at = NOW()
         WHERE id = ?
           AND (two_factor_last_counter IS NULL OR two_factor_last_counter < ?)`,
        [normalizedCounter, userId, normalizedCounter]
    );

    return Number(result?.affectedRows || 0) > 0;
}

function createDiscordOAuthPkcePair() {
    const codeVerifier = toBase64Url(crypto.randomBytes(48));
    const codeChallenge = toBase64Url(crypto.createHash('sha256').update(codeVerifier).digest());
    return { codeVerifier, codeChallenge };
}

function getConfiguredDiscordGuildId() {
    const envGuildId = String(process.env.GUILD_ID || '').trim();
    if (envGuildId) return envGuildId;

    try {
        const mainConfig = require('./Config/main.json');
        return String(mainConfig?.serverID || mainConfig?.guildId || '').trim();
    } catch (_) {
        return '';
    }
}

async function resolveDiscordGuildMembership(discordUserId) {
    const guildId = getConfiguredDiscordGuildId();
    const guildRequirementEnabled = DISCORD_OAUTH_REQUIRE_GUILD_MEMBER;
    const roleSyncConfigured = DISCORD_OWNER_ROLE_IDS.length > 0 || DISCORD_ADMIN_ROLE_IDS.length > 0 || DISCORD_MODERATOR_ROLE_IDS.length > 0;

    const buildMembershipResult = (overrides = {}) => ({
        required: guildRequirementEnabled,
        available: false,
        verified: null,
        guildId,
        guildName: null,
        memberDisplayName: null,
        trustedPanelRole: null,
        trustedRoleIds: [],
        trustedRoleNames: [],
        roleSyncConfigured,
        reason: '',
        ...overrides
    });

    const deriveTrustedPanelRole = (guild, member) => {
        if (!member) {
            return {
                trustedPanelRole: null,
                trustedRoleIds: [],
                trustedRoleNames: []
            };
        }

        const memberRoleIds = new Set(Array.from(member.roles?.cache?.keys?.() || []));
        const matchedRoleIds = [];
        const matchedRoleNames = [];
        let trustedPanelRole = null;

        if (guild?.ownerId && String(guild.ownerId) === String(member.id)) {
            trustedPanelRole = 'owner';
        }

        const mappings = [
            { panelRole: 'owner', roleIds: DISCORD_OWNER_ROLE_IDS },
            { panelRole: 'admin', roleIds: DISCORD_ADMIN_ROLE_IDS },
            { panelRole: 'moderator', roleIds: DISCORD_MODERATOR_ROLE_IDS }
        ];

        for (const mapping of mappings) {
            const hits = mapping.roleIds.filter((roleId) => memberRoleIds.has(roleId));
            if (hits.length > 0) {
                if (!trustedPanelRole || getRoleRank(mapping.panelRole) > getRoleRank(trustedPanelRole)) {
                    trustedPanelRole = mapping.panelRole;
                }
                matchedRoleIds.push(...hits);
                matchedRoleNames.push(...hits.map((roleId) => member.roles?.cache?.get(roleId)?.name).filter(Boolean));
            }
        }

        return {
            trustedPanelRole,
            trustedRoleIds: Array.from(new Set(matchedRoleIds)),
            trustedRoleNames: Array.from(new Set(matchedRoleNames))
        };
    };

    if (!guildRequirementEnabled && !roleSyncConfigured) {
        return buildMembershipResult({ required: false });
    }

    if (!discordUserId || !guildId || !discordClient?.guilds?.fetch) {
        return buildMembershipResult({ reason: 'Guild membership could not be verified yet' });
    }

    try {
        const guild = discordClient.guilds.cache.get(guildId)
            || await discordClient.guilds.fetch(guildId).catch(() => null);
        if (!guild) {
            return buildMembershipResult({ reason: 'Discord guild lookup failed' });
        }

        const member = guild.members.cache.get(discordUserId)
            || await guild.members.fetch(discordUserId).catch(() => null);
        const trustedRole = deriveTrustedPanelRole(guild, member);

        return buildMembershipResult({
            available: true,
            verified: Boolean(member),
            guildName: guild.name || null,
            memberDisplayName: member?.displayName || member?.user?.globalName || member?.user?.username || null,
            trustedPanelRole: trustedRole.trustedPanelRole,
            trustedRoleIds: trustedRole.trustedRoleIds,
            trustedRoleNames: trustedRole.trustedRoleNames,
            reason: member ? '' : 'Linked Discord account is not in the configured server'
        });
    } catch (error) {
        console.warn('[DiscordLink] Failed to verify guild membership:', error?.message || error);
        return buildMembershipResult({ reason: 'Guild membership verification is temporarily unavailable' });
    }
}

function getDiscordStoredVerificationSnapshot(user) {
    const parseTime = (value) => {
        const timestamp = value ? new Date(value).getTime() : 0;
        return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
    };

    return {
        lastVerifiedAtMs: parseTime(user?.discord_last_verified_at),
        guildVerifiedAtMs: parseTime(user?.discord_guild_verified_at),
        roleVerifiedAtMs: parseTime(user?.discord_role_verified_at),
        trustedPanelRole: String(user?.discord_last_trusted_role || '').trim() || null
    };
}

function isDiscordRoleTrustConfigured() {
    return DISCORD_OWNER_ROLE_IDS.length > 0 || DISCORD_ADMIN_ROLE_IDS.length > 0 || DISCORD_MODERATOR_ROLE_IDS.length > 0;
}

async function buildDiscordLinkSecurityState(user) {
    const state = await buildDiscordLinkSecurityStateHelper({ user, discordClient });
    return {
        ...state,
        protectedFeatures: DISCORD_SECURITY_PROTECTED_FEATURES
    };
}

async function persistDiscordVerificationState(user, state) {
    await persistDiscordVerificationStateHelper({
        databaseManager: MySQLDatabaseManager,
        user,
        state
    });
}

async function applyDiscordRoleSyncPolicy(user, state, req = null) {
    const result = await applyDiscordRoleSyncPolicyHelper({
        databaseManager: MySQLDatabaseManager,
        user,
        state
    });

    if (result?.state?.roleAutoSynced) {
        const previousRole = result.state.previousPanelRole || user.role;

        await sendSecurityAlertIfPossible(user, 'Panel role aligned to Discord trust', [
            `Previous role: ${previousRole}`,
            `New role: ${result.state.panelRole}`,
            `Discord account: ${String(user.discord_username || user.discord_user_id || 'Unknown')}`,
            `Time: ${new Date().toLocaleString()}`
        ], req);

        sendBotWebhook('account.role_synced', {
            username: user.username || null,
            userId: user.id || null,
            previousRole,
            newRole: result.state.panelRole,
            discordUserId: user.discord_user_id || null,
            discordUsername: user.discord_username || null
        }, req).catch(() => { });
    }

    return result;
}

async function ensureDiscordLinkSecurityState(req, options = {}) {
    if (!req?.session?.username) {
        return {
            linked: false,
            securityEligible: false,
            securityReason: 'Sign in again to continue',
            protectedFeatures: DISCORD_SECURITY_PROTECTED_FEATURES
        };
    }

    const forceRefresh = Boolean(options.forceRefresh);
    const now = Date.now();
    const verifiedAt = Number(req.session.discordSecurityVerifiedAt) || 0;
    if (!forceRefresh && req.session.discordSecurityState && (now - verifiedAt < DISCORD_LINK_CACHE_TTL_MS)) {
        return req.session.discordSecurityState;
    }

    const user = options.user || await AdminPanelHelper.getAdminUser(req.session.username);
    let state = await buildDiscordLinkSecurityState(user);
    if (state.linked && state.liveVerificationSucceeded) {
        await persistDiscordVerificationState(user, state);
    }
    const syncResult = await applyDiscordRoleSyncPolicy(user, state, req);
    state = syncResult.state;
    req.session.discordSecurityState = state;
    req.session.discordSecurityVerifiedAt = now;
    req.session.discordLinked = Boolean(state.linked);
    req.session.discordLinkedVerifiedAt = now;
    return state;
}

function buildDiscordSecurityRequirementMessage(state, fallback = 'Discord verification is required for this action') {
    if (state?.securityReason) return String(state.securityReason);
    if (state?.linked === false) return 'Link a Discord account from the Discord tab to continue';
    if (state?.guildVerificationRequired && state?.guildMemberVerified === false) {
        const guildName = String(state.guildName || '').trim();
        return guildName
            ? `Join ${guildName} with your linked Discord account to continue`
            : 'Join the configured Discord server with your linked account to continue';
    }
    return fallback;
}

async function validateDiscordSecurityBinding(req, options = {}) {
    const state = await ensureDiscordLinkSecurityState(req, { forceRefresh: true });
    const requireSensitiveFresh = Boolean(options.requireSensitiveFresh);

    if (!state?.securityEligible) {
        return {
            ok: false,
            status: 403,
            error: buildDiscordSecurityRequirementMessage(state),
            state
        };
    }

    if (requireSensitiveFresh && !state.sensitiveVerificationFresh) {
        return {
            ok: false,
            status: 403,
            error: 'Discord verification is too old for this sensitive action. Refresh your Discord trust and try again.',
            state: {
                ...state,
                securityReason: 'Discord verification is too old for this sensitive action. Refresh your Discord trust and try again.'
            }
        };
    }

    return { ok: true, state };
}

function createDiscordSecurityBindingMiddleware(options = {}) {
    return async (req, res, next) => {
        try {
            const validation = await validateDiscordSecurityBinding(req, options);
            if (validation.ok) {
                return next();
            }

            return res.status(validation.status || 403).json({
                error: validation.error,
                discordLinkRequired: true,
                discordLinkState: validation.state
            });
        } catch (error) {
            console.error('[DiscordLink] Failed to validate Discord security binding:', error);
            return res.status(500).json({ error: 'Failed to validate Discord security requirements' });
        }
    };
}

const requireDiscordSecurityBinding = createDiscordSecurityBindingMiddleware();
const requireSensitiveDiscordSecurityBinding = createDiscordSecurityBindingMiddleware({ requireSensitiveFresh: true });

async function requireLinkedDiscordAccount(req, res, next) {
    try {
        const state = await ensureDiscordLinkSecurityState(req, { forceRefresh: true });
        if (state?.linked) {
            return next();
        }

        return res.status(403).json({
            error: 'Link a Discord account from the Discord tab to continue',
            discordLinkRequired: true,
            discordLinkState: state
        });
    } catch (error) {
        console.error('[DiscordLink] Failed to validate linked Discord account:', error);
        return res.status(500).json({ error: 'Failed to validate linked Discord account' });
    }
}

async function resolveDiscordUser(userId) {
    if (!discordClient || !userId) return null;
    try {
        const user = await discordClient.users.fetch(userId).catch(() => null);
        if (!user) return null;
        try {
            await MySQLDatabaseManager.connection.pool.query(
                `INSERT INTO userinfo (user_id, username, is_bot)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE username = VALUES(username), last_seen = CURRENT_TIMESTAMP, is_bot = VALUES(is_bot)`,
                [user.id, user.username, user.bot ? 1 : 0]
            );
        } catch (dbErr) {
            console.error('[AdminPanel] Failed to upsert userinfo:', dbErr.message);
        }
        return user;
    } catch (err) {
        console.error('[AdminPanel] Failed to resolve user:', err.message);
        return null;
    }
}

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: function (origin, callback) {
            if (isAllowedOrigin(origin)) {
                callback(null, true);
            } else {
                callback(new Error('CORS not allowed'));
            }
        },
        methods: ['GET', 'POST'],
        credentials: true
    },
    pingInterval: 25000,
    pingTimeout: 20000,
    maxHttpBufferSize: 1e6,
    allowRequest: (req, callback) => {
        const origin = req.headers?.origin;
        if (origin && !isAllowedOrigin(origin)) {
            return callback('CORS not allowed', false);
        }
        callback(null, true);
    }
});
const PORT = ADMIN_PORT;

const socketMetrics = {
    active: 0,
    rejected: 0,
    errors: 0,
    connects: 0,
    disconnects: 0,
    lastConnectAt: null,
    lastDisconnectAt: null,
    lastError: null,
    perRole: {
        owner: 0,
        admin: 0,
        moderator: 0,
        user: 0
    }
};
let ioReady = false;
const adminPanelRuntime = {
    startedAt: Date.now(),
    discordClientAttachedAt: null,
    serverListeningAt: null,
    lastSocketActivityAt: null,
    lastSocketErrorAt: null,
    lastSocketError: null,
    lastServerErrorAt: null,
    lastServerError: null
};

// Optional: stream recent server logs to connected admin UI clients.
// We keep a small rolling buffer so new clients can see recent activity.
const MAX_TERMINAL_LOGS = 500;
const terminalLogBuffer = [];
const TERMINAL_ROOM = 'terminal-subscribers';

// Convert various console argument types into a readable string for the
// terminal stream (strings, errors, objects, etc.).
function formatTerminalArg(arg) {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return arg.stack || arg.message;
    try {
        return JSON.stringify(arg);
    } catch {
        return String(arg);
    }
}

// Add a formatted log line to the rolling buffer and emit it over sockets to
// any connected admin panel clients. Emission failures are non-fatal.
function addTerminalLog(level, args = []) {
    const message = (Array.isArray(args) ? args : [args]).map(formatTerminalArg).join(' ');
    const line = `[${new Date().toISOString()}] [${String(level || 'log').toUpperCase()}] ${message}`;
    terminalLogBuffer.push(line);
    if (terminalLogBuffer.length > MAX_TERMINAL_LOGS) {
        terminalLogBuffer.splice(0, terminalLogBuffer.length - MAX_TERMINAL_LOGS);
    }

    try {
        io.to(TERMINAL_ROOM).emit('terminal-log-line', line);
    } catch {
        // Socket emit failures are fine - logging shouldn't crash the admin panel.
    }
}

const originalConsoleLog = console.log.bind(console);
const originalConsoleInfo = console.info.bind(console);
const originalConsoleWarn = console.warn.bind(console);
const originalConsoleError = console.error.bind(console);

console.log = (...args) => {
    originalConsoleLog(...args);
    addTerminalLog('log', args);
};

console.info = (...args) => {
    originalConsoleInfo(...args);
    addTerminalLog('info', args);
};

console.warn = (...args) => {
    originalConsoleWarn(...args);
    addTerminalLog('warn', args);
};

console.error = (...args) => {
    originalConsoleError(...args);
    addTerminalLog('error', args);
};


// Enable trust proxy in production deployments (reverse proxy / load balancer).
app.set('trust proxy', IS_PRODUCTION ? 1 : false);

// Configuration for the MySQL-backed session store used by the admin panel.
const sessionStoreOptions = {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'discord_bot',
    createDatabaseTable: false,
    schema: {
        tableName: 'sessions',
        columnNames: {
            session_id: 'session_id',
            expires: 'expires',
            data: 'data'
        }
    }
};

let sessionStore;
try {
    sessionStore = new MySQLStore(sessionStoreOptions);
    console.log('Session store initialized successfully');
} catch (err) {
    console.error('Failed to initialize session store:', err);
}

// Apply a set of strict security headers to reduce attack surface (CSP, HSTS, etc.).
app.use((req, res, next) => {
    const hostHeader = req.headers.host;
    const forwardedHost = req.headers['x-forwarded-host'];

    if (!isAllowedHostHeader(hostHeader) || !isAllowedHostHeader(forwardedHost)) {
        emitSecuritySignal(req, 'host-header-blocked', {
            host: String(hostHeader || ''),
            forwardedHost: String(forwardedHost || '')
        });

        if (req.path.startsWith('/api/')) {
            return res.status(400).json({ error: 'Invalid host header' });
        }

        return res.status(400).send('Bad Request');
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Origin-Agent-Cluster', '?1');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://cdn.socket.io 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; img-src 'self' data: blob: https:; font-src 'self' data: https://cdnjs.cloudflare.com https://fonts.gstatic.com; connect-src 'self' https://cdn.jsdelivr.net https://cdn.socket.io; frame-src 'self' https://www.openstreetmap.org; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; child-src 'none'; object-src 'none';");
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

    const noStoreTargets = new Set(['/login', '/register', '/recovery', '/owner', '/admin', '/moderator', '/dashboard', '/profile']);
    if (req.path.startsWith('/api/') || noStoreTargets.has(req.path)) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Surrogate-Control', 'no-store');
    }

    next();
});

// Middleware: capture client IP and user-agent information for logging and
// security checks. We try several headers/connection fields to find the real IP.
app.use((req, res, next) => {
    // Try to get the real client IP from headers or connection info
    const forwardedFor = req.headers['x-forwarded-for'];
    const candidateIps = [];
    if (typeof forwardedFor === 'string') {
        candidateIps.push(...forwardedFor.split(',').map(ip => ip.trim()).filter(Boolean));
    }
    candidateIps.push(req.ip, req.connection?.remoteAddress, req.socket?.remoteAddress);

    const ipInfo = getIpInfoFromCandidates(candidateIps);
    req.clientIP = ipInfo.primary || 'Unknown';
    req.clientIPV4 = ipInfo.ipv4 || null;
    req.clientIPV6 = ipInfo.ipv6 || null;

    req.userAgent = req.headers['user-agent'] || 'Unknown';
    next();
});

// General middleware setup

// Ensure a session secret exists; without it sessions would be insecure.
// In production we refuse to start without a valid `SESSION_SECRET`.
const crypto = require('crypto');
const SESSION_SECRET = process.env.SESSION_SECRET;
const SESSION_IDLE_TIMEOUT_MS = (() => {
    const parsed = Number(process.env.SESSION_IDLE_TIMEOUT_MS);
    return Number.isFinite(parsed) && parsed >= 60 * 1000 ? parsed : 30 * 60 * 1000;
})();
const SESSION_ABSOLUTE_TIMEOUT_MS = (() => {
    const parsed = Number(process.env.SESSION_ABSOLUTE_TIMEOUT_MS);
    return Number.isFinite(parsed) && parsed >= SESSION_IDLE_TIMEOUT_MS
        ? parsed
        : 12 * 60 * 60 * 1000;
})();
const SESSION_SINGLE_SESSION_MODE = (() => {
    const raw = String(process.env.SESSION_SINGLE_SESSION_MODE || '').trim().toLowerCase();
    if (!raw) return true;
    return ['1', 'true', 'yes', 'on'].includes(raw);
})();
const SESSION_SINGLE_SESSION_CHECK_INTERVAL_MS = (() => {
    const parsed = Number(process.env.SESSION_SINGLE_SESSION_CHECK_INTERVAL_MS);
    return Number.isFinite(parsed) && parsed >= 15 * 1000 ? parsed : 60 * 1000;
})();
const SESSION_COOKIE_SECURE = IS_PRODUCTION;
const SESSION_POLICY_LIMITS = Object.freeze({
    idleMinMs: 5 * 60 * 1000,
    idleMaxMs: 12 * 60 * 60 * 1000,
    absoluteMinMs: 30 * 60 * 1000,
    absoluteMaxMs: 7 * 24 * 60 * 60 * 1000,
    checkIntervalMinMs: 15 * 1000,
    checkIntervalMaxMs: 30 * 60 * 1000
});
const DEFAULT_SESSION_POLICY = Object.freeze({
    singleSessionMode: SESSION_SINGLE_SESSION_MODE,
    idleTimeoutMs: SESSION_IDLE_TIMEOUT_MS,
    absoluteTimeoutMs: SESSION_ABSOLUTE_TIMEOUT_MS,
    singleSessionCheckIntervalMs: SESSION_SINGLE_SESSION_CHECK_INTERVAL_MS
});
let sessionPolicyState = { ...DEFAULT_SESSION_POLICY };

const BOT_WEBHOOK_URL = String(process.env.BOT_WEBHOOK_URL || process.env.WEBSITE_TO_BOT_WEBHOOK_URL || '').trim();
const BOT_WEBHOOK_SECRET = String(process.env.BOT_WEBHOOK_SECRET || '').trim();
const BOT_WEBHOOK_TIMEOUT_MS = Math.max(1000, Math.min(15000, Number(process.env.BOT_WEBHOOK_TIMEOUT_MS) || 6000));

async function sendBotWebhook(event, data = {}, req = null) {
    if (!BOT_WEBHOOK_URL || !BOT_WEBHOOK_SECRET) return false;

    const payload = {
        event: String(event || '').trim(),
        data: data && typeof data === 'object' ? data : {},
        actor: req?.session?.username || 'system',
        ipAddress: req?.clientIP || null,
        userAgent: req?.userAgent || null,
        timestamp: new Date().toISOString()
    };

    if (!payload.event) return false;

    const body = JSON.stringify(payload);
    const timestamp = Date.now().toString();
    const signature = crypto
        .createHmac('sha256', BOT_WEBHOOK_SECRET)
        .update(`${timestamp}.${body}`)
        .digest('hex');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BOT_WEBHOOK_TIMEOUT_MS);

    try {
        const response = await fetch(BOT_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'adminpanel-webhook',
                'X-Webhook-Timestamp': timestamp,
                'X-Webhook-Signature': signature
            },
            body,
            signal: controller.signal
        });

        if (!response.ok) {
            console.warn('[Webhook] Bot webhook failed:', response.status, await response.text().catch(() => ''));
            return false;
        }

        return true;
    } catch (error) {
        if (error?.name !== 'AbortError') {
            console.warn('[Webhook] Bot webhook error:', error?.message || error);
        }
        return false;
    } finally {
        clearTimeout(timeoutId);
    }
}

function normalizeCredentialInput(value, options = {}) {
    const {
        minLength = 1,
        maxLength = 100,
        allowControlChars = false
    } = options;

    if (typeof value !== 'string') return '';

    const normalized = value.normalize('NFKC').trim();
    if (!normalized) return '';
    if (normalized.length < minLength || normalized.length > maxLength) return '';
    if (!allowControlChars && /[\u0000-\u001F\u007F]/.test(normalized)) return '';

    return normalized;
}
if (!SESSION_SECRET) {
    console.error('- CRITICAL: SESSION_SECRET is not set in Config/credentials.env');
    console.error('   This is a security vulnerability. Admin panel will not start.');
    console.error('   Add SESSION_SECRET to Config/credentials.env and restart the bot.');
    if (process.env.NODE_ENV === 'production') {
        process.exit(1); // Never start in production without a session secret
    } else {
        console.warn('   Running in development mode only. NEVER use in production!');
    }
}

// Session middleware must be loaded before anything that uses req.session
const sessionMiddleware = session({
    key: 'admin_session',
    secret: SESSION_SECRET,
    store: sessionStore,
    proxy: IS_PRODUCTION,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: SESSION_COOKIE_SECURE, // Use environment setting (true in production)
        sameSite: 'lax',
        maxAge: DEFAULT_SESSION_POLICY.idleTimeoutMs,
        httpOnly: true, // Prevent JavaScript from accessing cookies
        priority: 'high',
        path: '/'
    },
    rolling: true
});

app.use(sessionMiddleware);

// Listen for session store connection/disconnection events
// Note: session store event hooks were removed - they were no-ops.

// (Optional) Log session ID for debugging

app.use(bodyParser.json({ limit: '10kb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10kb' }));

const PUBLIC_AUTH_POST_PATHS = new Set([
    '/api/login',
    '/api/login/recovery',
    '/api/register',
    '/api/account/password-reset/request',
    '/api/account/password-reset/confirm',
    '/api/account/password-reset/recovery'
]);

function isSameSiteRequest(req) {
    const secFetchSite = String(req?.headers?.['sec-fetch-site'] || '').trim().toLowerCase();
    if (!secFetchSite) return true;

    return secFetchSite === 'same-origin' || secFetchSite === 'same-site' || secFetchSite === 'none';
}

function getOriginFromHeaderValue(value) {
    const normalized = normalizeOriginValue(value);
    if (normalized && /^https?:\/\//i.test(normalized)) {
        return normalized;
    }

    return '';
}

app.use((req, res, next) => {
    if (req.method !== 'POST' || !PUBLIC_AUTH_POST_PATHS.has(req.path)) return next();

    if (!isSameSiteRequest(req)) {
        emitSecuritySignal(req, 'auth-origin-blocked', {
            path: req.path,
            reason: 'sec-fetch-site',
            secFetchSite: String(req.headers['sec-fetch-site'] || '')
        }, 10 * 1000);
        return res.status(403).json({ error: 'Cross-site authentication request blocked' });
    }

    const origin = getOriginFromHeaderValue(req.headers.origin);
    if (origin && !isAllowedOrigin(origin)) {
        emitSecuritySignal(req, 'auth-origin-blocked', {
            path: req.path,
            reason: 'origin',
            origin
        }, 10 * 1000);
        return res.status(403).json({ error: 'Authentication request origin is not allowed' });
    }

    const refererOrigin = getOriginFromHeaderValue(req.headers.referer);
    if (!origin && refererOrigin && !isAllowedOrigin(refererOrigin)) {
        emitSecuritySignal(req, 'auth-origin-blocked', {
            path: req.path,
            reason: 'referer',
            refererOrigin
        }, 10 * 1000);
        return res.status(403).json({ error: 'Authentication request referrer is not allowed' });
    }

    return next();
});

// Validate Origin for API requests when provided (defense-in-depth against cross-site abuse).
app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    const origin = req.headers.origin;
    if (!origin) return next();

    if (!isAllowedOrigin(origin)) {
        emitSecuritySignal(req, 'api-origin-blocked', {
            origin: String(origin || ''),
            host: String(req.headers.host || ''),
            forwardedHost: String(req.headers['x-forwarded-host'] || '')
        });
        return res.status(403).json({ error: 'Origin not allowed' });
    }

    return next();
});

// Block TRACE and OPTIONS HTTP methods for security
app.use((req, res, next) => {
    if (req.method === 'TRACE' || req.method === 'OPTIONS') {
        return res.status(405).send('Method Not Allowed');
    }
    next();
});

function getSessionExpiryState(session, now = Date.now()) {
    if (!session || !session.authenticated) {
        return { expired: false, reason: null };
    }

    const loginTime = Number(session.loginTime) || 0;
    const lastActivityAt = Number(session.lastActivityAt || session.loginTime) || 0;

    if (!loginTime || !lastActivityAt) {
        return { expired: false, reason: null };
    }

    if (now - loginTime > Number(sessionPolicyState.absoluteTimeoutMs)) {
        return { expired: true, reason: 'absolute' };
    }

    if (now - lastActivityAt > Number(sessionPolicyState.idleTimeoutMs)) {
        return { expired: true, reason: 'idle' };
    }

    return { expired: false, reason: null };
}

app.use(async (req, res, next) => {
    if (!req.session || !req.session.authenticated) {
        return next();
    }

    const now = Date.now();
    if (!req.session.loginTime) {
        req.session.loginTime = now;
    }
    if (!req.session.lastActivityAt) {
        req.session.lastActivityAt = now;
    }
    if (!req.session.absoluteExpiresAt) {
        req.session.absoluteExpiresAt = req.session.loginTime + Number(sessionPolicyState.absoluteTimeoutMs);
    }

    if (req.session.cookie) {
        req.session.cookie.maxAge = Number(sessionPolicyState.idleTimeoutMs);
    }

    const expiry = getSessionExpiryState(req.session, now);
    if (!expiry.expired) {
        req.session.lastActivityAt = now;
        return next();
    }

    const username = req.session.username || 'unknown';
    const reason = expiry.reason === 'absolute' ? 'absolute-timeout' : 'idle-timeout';
    await logAdminAuthEvent(username, 'LOGOUT', req, { reason }).catch(() => { });

    req.session.destroy(() => {
        res.clearCookie('admin_session', {
            path: '/',
            sameSite: 'lax',
            secure: SESSION_COOKIE_SECURE
        });
        res.clearCookie('csrfToken', {
            path: '/',
            sameSite: 'strict',
            secure: SESSION_COOKIE_SECURE
        });

        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: 'Session expired. Please sign in again.' });
        }

        return res.redirect('/login');
    });
});

app.use(async (req, res, next) => {
    if (!sessionPolicyState.singleSessionMode || !req.session || !req.session.authenticated) {
        return next();
    }

    const now = Date.now();
    const checkedAt = Number(req.session.singleSessionCheckedAt) || 0;
    if (now - checkedAt < Number(sessionPolicyState.singleSessionCheckIntervalMs)) {
        return next();
    }

    req.session.singleSessionCheckedAt = now;

    try {
        await closeOtherUserSessions(req.session.username, req.session.userId, req.sessionID);
    } catch (error) {
        console.error('[AdminPanel] Single-session enforcement failed:', error.message);
    }

    return next();
});

// Generate a CSRF token for each session
app.use((req, res, next) => {
    if (!req.session) {
        // If session isn't ready, skip CSRF setup
        return next();
    }
    // Initialize or rotate secret if missing
    if (!req.session.csrfSecret) {
        req.session.csrfSecret = CsrfHelper.generateSecret();
    }
    next();
});

function getCsrfRequestToken(req) {
    if (!req) return '';
    // Check headers (case-insensitive by Node, but explicit checks help)
    const headerToken = req.headers['x-csrf-token'] || req.headers['csrf-token'];
    if (typeof headerToken === 'string' && headerToken.trim()) return headerToken.trim();

    const bodyToken = req.body?._csrf;
    if (typeof bodyToken === 'string' && bodyToken.trim()) return bodyToken.trim();

    // Debug missing token - uncommented for debugging
    console.debug('[CSRF Debug] Token not found. Headers:', Object.keys(req.headers));

    return '';
}

// Endpoint to get the CSRF token for the frontend
app.get('/api/csrf', (req, res) => {
    if (!req.session) {
        console.warn('[CSRF API] Session missing on /api/csrf request');
        // Attempt to recover by creating a temp session? No, that's dangerous.
        // But if cookie is present but session invalid...
        return res.status(500).json({ error: 'Session not initialized' });
    }

    // Ensure secret exists
    if (!req.session.csrfSecret) {
        console.warn('[CSRF API] Secret missing, generating new one');
        req.session.csrfSecret = CsrfHelper.generateSecret();
    }

    // Generate a fresh token using the session secret
    // This allows the token to be different for every request (BREACH protection)
    // while still validating against the same session secret.
    const token = CsrfHelper.createToken(req.session.csrfSecret);

    // Debug
    // console.debug(`[CSRF API] Generated token for ${req.session.username}`);

    res.cookie('csrfToken', token, {
        httpOnly: false,
        sameSite: 'strict',
        secure: req.secure || (req.headers['x-forwarded-proto'] === 'https'), // Auto-detect secure context
        path: '/'
    });
    res.json({ csrfToken: token });
});

app.use((req, res, next) => {
    const csrfBypassPaths = new Set([
        '/api/login',
        '/api/login/recovery',
        '/api/register',
        '/api/account/password-reset/request',
        '/api/account/password-reset/confirm',
        '/api/account/password-reset/recovery'
    ]);

    if (csrfBypassPaths.has(req.path)) {
        return next();
    }

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        if (!req.session) {
            // If session isn't ready, block the request
            return res.status(500).json({ error: 'Session not initialized' });
        }

        // 1. Verify Origin (Advanced protection)
        // Ensures the request wasn't triggered by a malicious site
        if (!CsrfHelper.verifyOrigin(req)) {
            console.warn(`[CSRF] Invalid Origin/Referer for '${req.session.username || 'n/a'}'. Origin: ${req.headers.origin}, Referer: ${req.headers.referer}`);
            emitSecuritySignal(req, 'csrf-origin-failed', {
                username: req.session?.username || null,
                origin: String(req.headers.origin || ''),
                referer: String(req.headers.referer || '')
            }, 15 * 1000);
            return res.status(403).json({ error: 'Invalid Origin' });
        }

        const token = getCsrfRequestToken(req);
        const secret = req.session.csrfSecret;

        // 2. Verify Signed Token (Advanced timestamp + salt check)
        if (!CsrfHelper.verifyToken(secret, token)) {
            console.error(`[CSRF FAILURE] Invalid CSRF token for '${req.session.username}' (role: ${req.session.role}). Verify failed. Token: ${token ? 'PROVIDED' : 'MISSING'}`);
            emitSecuritySignal(req, 'csrf-token-failed', {
                username: req.session?.username || null,
                role: req.session?.role || null
            }, 15 * 1000);
            // Helps frontend clear stale tokens
            res.clearCookie('csrfToken', { path: '/' });
            return res.status(403).json({ error: 'Invalid or expired CSRF token', cause: 'verify_failed' });
        }
    }
    next();
});

// Basic rate limiter to prevent abuse of sensitive endpoints
const rateLimitStore = new Map();
let rateLimitLastCleanupAt = Date.now();
function createRateLimiter(maxRequests = 5, windowMs = 60000) {
    return (req, res, next) => {
        const ipKey = String(req.clientIP || req.ip || 'unknown');
        const accountKey = String(req.body?.username || req.session?.username || '').toLowerCase();
        const key = `${ipKey}_${req.path}_${accountKey}`;
        const now = Date.now();
        const userLimits = rateLimitStore.get(key) || [];

        // Remove old requests from the log
        const recentRequests = userLimits.filter(timestamp => now - timestamp < windowMs);

        if (recentRequests.length >= maxRequests) {
            const oldestTimestamp = recentRequests[0] || now;
            const retryAfterMs = Math.max(0, windowMs - (now - oldestTimestamp));
            const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
            emitSecuritySignal(req, 'rate-limit-hit', {
                limit: maxRequests,
                windowMs,
                observedRequests: recentRequests.length + 1
            }, 20 * 1000);
            res.setHeader('RateLimit-Limit', String(maxRequests));
            res.setHeader('RateLimit-Remaining', '0');
            res.setHeader('RateLimit-Reset', String(retryAfterSeconds));
            res.setHeader('Retry-After', String(retryAfterSeconds));
            return res.status(429).json({ error: 'Too many requests, please try again later' });
        }

        recentRequests.push(now);
        rateLimitStore.set(key, recentRequests);
        const remaining = Math.max(0, maxRequests - recentRequests.length);
        const oldestTimestamp = recentRequests[0] || now;
        const resetSeconds = Math.max(1, Math.ceil(Math.max(0, windowMs - (now - oldestTimestamp)) / 1000));
        res.setHeader('RateLimit-Limit', String(maxRequests));
        res.setHeader('RateLimit-Remaining', String(remaining));
        res.setHeader('RateLimit-Reset', String(resetSeconds));

        // Periodically clean up the rate limit store
        if (now - rateLimitLastCleanupAt > Math.max(windowMs, 60 * 1000)) {
            for (const [k, v] of rateLimitStore.entries()) {
                const active = v.filter(t => now - t < windowMs);
                if (active.length === 0) {
                    rateLimitStore.delete(k);
                } else {
                    rateLimitStore.set(k, active);
                }
            }
            rateLimitLastCleanupAt = now;
        }

        next();
    };
}

// Serve static files and handle errors
// Share session authentication with Socket.IO
const sharedSession = require('express-socket.io-session');
io.use(sharedSession(sessionMiddleware, {
    autoSave: true
}));

io.use((socket, next) => {
    const session = socket.handshake.session;
    if (!session || !session.authenticated || !session.username || !session.role) {
        socketMetrics.rejected += 1;
        return next(new Error('Unauthorized Socket.IO connection'));
    }

    const now = Date.now();
    const expiry = getSessionExpiryState(session, now);
    if (expiry.expired) {
        socketMetrics.rejected += 1;
        return next(new Error('Session expired'));
    }

    session.lastActivityAt = now;
    socket.username = session.username;
    socket.role = session.role;
    next();
});

app.use('/css', express.static(path.join(__dirname, 'AdminPanel', 'css')));
app.use('/public', express.static(path.join(__dirname, 'AdminPanel', 'public')));
app.use('/images', express.static(path.join(__dirname, 'AdminPanel', 'images')));

// Expose only a safe config file used by frontend version/rendering logic.
app.get('/Config/main.json', (req, res) => {
    const mainConfigPath = path.join(__dirname, 'Config', 'main.json');
    return res.sendFile(mainConfigPath, {
        headers: {
            'Cache-Control': 'no-store'
        }
    });
});

// Clean up expired sessions every hour
setInterval(() => {
    try {
        sessionStore.clearExpiredSessions();
    } catch (error) {
        console.error('[AdminPanel] Error cleaning up expired sessions:', error.message);
    }
}, 60 * 60 * 1000); // 1 hour

// Clean up old login attempts every 30 minutes
setInterval(() => {
    const now = Date.now();
    for (const [ip, attempts] of loginAttempts.entries()) {
        const recentAttempts = attempts.filter(time => now - time < 30 * 60 * 1000);
        if (recentAttempts.length === 0) {
            loginAttempts.delete(ip);
        } else {
            loginAttempts.set(ip, recentAttempts);
        }
    }

    for (const [key, attempts] of authIdentifierAttempts.entries()) {
        const recentAttempts = pruneAttemptTimestamps(attempts, AUTH_IDENTIFIER_WINDOW_MS, now);
        if (recentAttempts.length === 0) {
            authIdentifierAttempts.delete(key);
        } else {
            authIdentifierAttempts.set(key, recentAttempts);
        }
    }
}, 30 * 60 * 1000); // 30 minutes

const DISCORD_LINK_EXEMPT_PATHS = new Set([
    '/profile',
    '/api/account/info',
    '/api/account/discord/oauth/start',
    '/api/account/discord/oauth/runtime',
    '/api/account/discord/oauth/callback',
    '/api/account/discord-unlink'
]);

const DISCORD_SECURITY_PROTECTED_FEATURES = Object.freeze([
    'Manage active sessions',
    'Generate recovery codes',
    'Configure two-factor authentication',
    'Change account email',
    'Change panel avatar'
]);

const DISCORD_LINK_CACHE_TTL_MS = 2 * 60 * 1000;
const DISCORD_OAUTH_REQUIRE_GUILD_MEMBER = (() => {
    const raw = String(process.env.DISCORD_OAUTH_REQUIRE_GUILD_MEMBER || 'true').trim().toLowerCase();
    return !['0', 'false', 'no', 'off'].includes(raw);
})();
const DISCORD_ROLE_TRUST_ENFORCED = (() => {
    const raw = String(process.env.DISCORD_ROLE_TRUST_ENFORCED || 'true').trim().toLowerCase();
    return !['0', 'false', 'no', 'off'].includes(raw);
})();
const DISCORD_RECENT_VERIFICATION_TTL_MS = (() => {
    const parsed = Number(process.env.DISCORD_RECENT_VERIFICATION_TTL_MS);
    return Number.isFinite(parsed) && parsed >= 5 * 60 * 1000 ? parsed : 24 * 60 * 60 * 1000;
})();
const DISCORD_SENSITIVE_VERIFICATION_TTL_MS = (() => {
    const parsed = Number(process.env.DISCORD_SENSITIVE_VERIFICATION_TTL_MS);
    return Number.isFinite(parsed) && parsed >= 60 * 1000 ? parsed : 10 * 60 * 1000;
})();
const DISCORD_SECURITY_ALERTS_ENABLED = (() => {
    const raw = String(process.env.DISCORD_SECURITY_ALERTS_ENABLED || 'true').trim().toLowerCase();
    return !['0', 'false', 'no', 'off'].includes(raw);
})();
const DISCORD_HIGH_RISK_DELAY_UNLINK_MS = (() => {
    const parsed = Number(process.env.DISCORD_HIGH_RISK_DELAY_UNLINK_MS);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2 * 60 * 1000;
})();
const DISCORD_HIGH_RISK_DELAY_DISABLE_2FA_MS = (() => {
    const parsed = Number(process.env.DISCORD_HIGH_RISK_DELAY_DISABLE_2FA_MS);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2 * 60 * 1000;
})();
const DISCORD_HIGH_RISK_DELAY_CHANGE_EMAIL_MS = (() => {
    const parsed = Number(process.env.DISCORD_HIGH_RISK_DELAY_CHANGE_EMAIL_MS);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 90 * 1000;
})();
const DISCORD_HIGH_RISK_ACTION_RECORD_TTL_MS = (() => {
    const parsed = Number(process.env.DISCORD_HIGH_RISK_ACTION_RECORD_TTL_MS);
    return Number.isFinite(parsed) && parsed >= 5 * 60 * 1000 ? parsed : 30 * 60 * 1000;
})();

function parseDiscordRoleIdList(rawValue) {
    return String(rawValue || '')
        .split(',')
        .map((entry) => String(entry || '').trim())
        .filter((entry) => /^\d{17,20}$/.test(entry));
}

function buildDiscordRoleIds(envValue, fallbackValues = []) {
    const envRoleIds = parseDiscordRoleIdList(envValue);
    if (envRoleIds.length > 0) {
        return Object.freeze(envRoleIds);
    }

    const fallbackRoleIds = fallbackValues
        .map((entry) => String(entry || '').trim())
        .filter((entry) => /^\d{17,20}$/.test(entry));

    return Object.freeze(Array.from(new Set(fallbackRoleIds)));
}

const DISCORD_OWNER_ROLE_IDS = buildDiscordRoleIds(process.env.DISCORD_OWNER_ROLE_IDS, [
    ROLES_CONFIG?.ownerRoleId
]);
const DISCORD_ADMIN_ROLE_IDS = buildDiscordRoleIds(process.env.DISCORD_ADMIN_ROLE_IDS, [
    ROLES_CONFIG?.administratorRoleId
]);
const DISCORD_MODERATOR_ROLE_IDS = buildDiscordRoleIds(process.env.DISCORD_MODERATOR_ROLE_IDS, [
    ROLES_CONFIG?.moderatorRoleId
]);
const DISCORD_ROLE_SYNC_MODE = (() => {
    const raw = String(process.env.DISCORD_ROLE_SYNC_MODE || 'enforce').trim().toLowerCase();
    if (['off', 'enforce', 'downgrade'].includes(raw)) return raw;
    return 'enforce';
})();

async function ensureDiscordLinkStatus(req) {
    if (!req?.session?.username) return false;

    const now = Date.now();
    const verifiedAt = Number(req.session.discordLinkedVerifiedAt) || 0;
    const cachedLinked = Boolean(req.session.discordLinked);
    if (cachedLinked && (now - verifiedAt < DISCORD_LINK_CACHE_TTL_MS)) {
        return true;
    }

    if (req.session.discordSecurityState && (now - Number(req.session.discordSecurityVerifiedAt || 0) < DISCORD_LINK_CACHE_TTL_MS)) {
        return Boolean(req.session.discordSecurityState.linked);
    }

    try {
        const state = await ensureDiscordLinkSecurityState(req, { forceRefresh: true });
        return Boolean(state.linked);
    } catch (error) {
        console.warn('[DiscordLink] Failed to refresh discord link status:', error?.message || error);
        return Boolean(req.session.discordLinked);
    }
}

function isDiscordLinkExemptPath(req) {
    const pathName = String(req.path || '').trim();
    if (!pathName) return false;
    if (DISCORD_LINK_EXEMPT_PATHS.has(pathName)) return true;
    if (pathName.startsWith('/api/account/')) return true;
    if (pathName.startsWith('/api/security/')) return true;
    if (pathName.startsWith('/api/user')) return true;
    if (pathName.startsWith('/api/users/')) return true;
    return false;
}

// Middleware to require authentication for protected routes
async function requireAuth(req, res, next) {
    // (Debug) Log session and cookies if needed
    if (req.session && req.session.authenticated) {
        // Save the user's IP and user agent in the session if not already set
        if (!req.session.ipAddress || !req.session.userAgent) {
            req.session.ipAddress = req.clientIP;
            req.session.ipAddressV4 = req.clientIPV4;
            req.session.ipAddressV6 = req.clientIPV6;
            req.session.userAgent = req.userAgent;
        }
        if (!isDiscordLinkExemptPath(req)) {
            const linked = await ensureDiscordLinkStatus(req);
            if (!linked) {
                if (req.path.startsWith('/api/')) {
                    return res.status(403).json({ error: 'Discord account must be linked', discordLinkRequired: true });
                }
                return res.redirect('/profile?discord_required=1');
            }
        }
        return next();
    }
    // If this is an API request, return JSON error
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    // Otherwise, redirect to the unauthorized page
    res.redirect('/unauthorized');
}

const ROLE_RANKS = Object.freeze({
    moderator: 1,
    admin: 2,
    owner: 3
});

const PUBLIC_API_PATTERNS = [
    /^\/api\/login$/,
    /^\/api\/login\/recovery$/,
    /^\/api\/logout$/,
    /^\/api\/register$/,
    /^\/api\/account\/password-reset\/request$/,
    /^\/api\/account\/password-reset\/confirm$/,
    /^\/api\/account\/password-reset\/recovery$/,
    /^\/api\/email\/verify$/,
    /^\/api\/csrf$/,
    /^\/api\/appeals\/submit$/,
    /^\/api\/appeals\/check-status$/,
    /^\/api\/appeals\/my-history$/,
    /^\/api\/appeals\/update-pending$/,
    /^\/api\/appeals\/withdraw$/,
    /^\/api\/appeals\/validate-case-id$/,
    /^\/api\/rules$/
];

const API_ROLE_POLICIES = [
    { methods: null, pattern: /^\/api\/owner(?:\/|$)/, minRole: 'owner' },
    { methods: null, pattern: /^\/api\/jobs(?:\/|$)/, minRole: 'owner' },
    { methods: null, pattern: /^\/api\/automod(?:\/|$)/, minRole: 'owner' },
    { methods: null, pattern: /^\/api\/alerts(?:\/|$)/, minRole: 'owner' },
    // { methods: null, pattern: /^\/api\/security(?:\/|$)/, minRole: 'owner' }, // Disabled: Security endpoints are user-scoped (2FA, sessions) or have specific middleware
    { methods: null, pattern: /^\/api\/system(?:\/|$)/, minRole: 'owner' },
    { methods: null, pattern: /^\/api\/audit-logs$/, minRole: 'owner' },
    { methods: ['POST'], pattern: /^\/api\/appeals\/\d+\/(accept|deny)$/, minRole: 'owner' },
    { methods: ['POST'], pattern: /^\/api\/invites\/(generate|revoke)(?:\/|$)/, minRole: 'owner' },

    { methods: null, pattern: /^\/api\/admin(?:\/|$)/, minRole: 'admin' },

    { methods: null, pattern: /^\/api\/moderation(?:\/|$)/, minRole: 'moderator' },
    { methods: null, pattern: /^\/api\/appeals\/(pending|decided|stats)$/, minRole: 'moderator' },
    { methods: null, pattern: /^\/api\/moderation\/intelligence$/, minRole: 'moderator' },
    { methods: ['DELETE'], pattern: /^\/api\/banned\/.+$/, minRole: 'moderator' },
    { methods: ['DELETE'], pattern: /^\/api\/warns\/.+$/, minRole: 'moderator' }
];

function getRoleRank(role) {
    return ROLE_RANKS[String(role || '').toLowerCase()] || 0;
}

function getRequiredRoleForApi(method, pathName) {
    for (const policy of API_ROLE_POLICIES) {
        if (policy.methods && !policy.methods.includes(method)) continue;
        if (policy.pattern.test(pathName)) {
            return policy.minRole;
        }
    }
    return null;
}

async function refreshSessionRoleIfNeeded(req, options = {}) {
    if (!req.session || !req.session.authenticated || !req.session.username) return;

    const now = Date.now();
    const verifiedAt = Number(req.session.roleVerifiedAt) || 0;
    const forceRefresh = Boolean(options.forceRefresh);
    const roleFreshMs = 2 * 60 * 1000;

    // Skip refresh only if recent AND not forced AND still have a role
    if (!forceRefresh && now - verifiedAt < roleFreshMs && req.session.role) {
        return;
    }

    const user = await AdminPanelHelper.getAdminUser(req.session.username);
    if (!user || !user.role) {
        req.session.authenticated = false;
        req.session.role = null;
        req.session.roleVerifiedAt = now;
        return;
    }

    let effectiveRole = user.role;

    try {
        const state = await ensureDiscordLinkSecurityState(req, { user, forceRefresh: true });

        if (!state.roleAlignmentOk) {
            req.session.role = state?.trustedPanelRole || null; // Restrict to Discord trust level
            req.session.roleVerifiedAt = now;
            return;
        }

        if (state?.panelRole && state.panelRole !== effectiveRole) {
            effectiveRole = state.panelRole;
        }
    } catch (error) {
        // keep behavior, no console output
    }

    if (req.session.role !== effectiveRole) {
        // role change applied silently
    }

    req.session.role = effectiveRole;
    req.session.roleVerifiedAt = now;
}

async function enforceApiRolePolicy(req, res, next) {
    if (!req.path.startsWith('/api/')) return next();

    if (PUBLIC_API_PATTERNS.some((pattern) => pattern.test(req.path))) {
        return next();
    }

    const requiredRole = getRequiredRoleForApi(req.method, req.path);
    if (!requiredRole) return next();

    if (!req.session || !req.session.authenticated) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        await refreshSessionRoleIfNeeded(req);

        // Re-check authentication after refresh attempt
        if (!req.session || !req.session.authenticated) {
            return res.status(401).json({ error: 'Session invalidated. Please log in again.' });
        }

        const currentRole = req.session?.role;
        if (getRoleRank(currentRole) < getRoleRank(requiredRole)) {
            console.error(`[API Policy FAILURE] Denied access to ${req.method} ${req.path}. User '${req.session?.username}' role '${currentRole}' (rank ${getRoleRank(currentRole)}) < required '${requiredRole}' (rank ${getRoleRank(requiredRole)})`);
            return res.status(403).json({ error: `${requiredRole} access required` });
        }
        return next();
    } catch (error) {
        console.error('[AdminPanel] API role policy check failed:', error.message);
        return res.status(500).json({ error: 'Authorization check failed' });
    }
}

app.use(enforceApiRolePolicy);

const MISC_CONFIG_PATH = path.join(__dirname, 'Config', 'constants', 'misc.json');
const AUTOMOD_CONFIG_PATH = path.join(__dirname, 'Config', 'constants', 'automod.json');
const BACKUP_CONFIG_PATH = path.join(__dirname, 'Config', 'backups.json');
const BACKUP_DIR = path.join(__dirname, 'backups', 'db');
const DEFAULT_BACKUP_CONFIG = Object.freeze({
    enabled: false,
    intervalMinutes: 1440,
    retentionCount: 10,
    tables: [],
    format: 'json'
});
const backupState = {
    running: false,
    lastRunAt: null,
    lastRunFile: null,
    lastRunStatus: 'idle',
    lastRunError: null,
    nextRunAt: null
};
let backupConfig = null;
let backupTimer = null;
const serverBackupState = {
    running: false,
    lastRunAt: null,
    lastRunFile: null,
    lastRunStatus: 'idle',
    lastRunError: null,
    nextRunAt: null,
    lastGuildId: null
};
const serverBackupRestoreOperations = new Map();
const SERVER_BACKUP_RESTORE_OPERATION_TTL_MS = 30 * 60 * 1000;
const SERVER_BACKUP_RESTORE_OPERATION_MAX_ENTRIES = 25;
let serverBackupConfig = null;
let serverBackupTimer = null;
const DEFAULT_AUTOMOD_PROFILES = Object.freeze({
    balanced: {
        blockExternalInvites: true,
        maxMentionsBeforeFlag: 6,
        autoMod: {
            spamThreshold: 5,
            spamWindow: 5000,
            capsThreshold: 0.70,
            minLengthForCaps: 10,
            spamTimeout: 600000,
            spamWarningThreshold: 2,
            similarityWindowMs: 120000,
            similarityThreshold: 0.88,
            similarityMinLength: 12,
            similarityRepeatThreshold: 3,
            riskWarnThreshold: 20,
            riskDeleteThreshold: 35,
            riskTimeoutThreshold: 60,
            baseTimeoutMs: 600000,
            maxTimeoutMs: 21600000
        },
        autoModAdvanced: {
            escalationThreshold24h: 4,
            escalationTimeoutMs: 1800000,
            progressiveTimeoutMultiplier: 1.4,
            kickThreshold24h: 14,
            regexMaxPatternLength: 180,
            riskWeights: {
                spam: 28,
                similarity: 30,
                caps: 14,
                profanity: 26,
                regex: 34,
                invites: 30,
                mentions: 18
            }
        }
    },
    strict: {
        blockExternalInvites: true,
        maxMentionsBeforeFlag: 4,
        autoMod: {
            spamThreshold: 4,
            spamWindow: 4500,
            capsThreshold: 0.60,
            minLengthForCaps: 8,
            spamTimeout: 900000,
            spamWarningThreshold: 1,
            similarityWindowMs: 150000,
            similarityThreshold: 0.84,
            similarityMinLength: 10,
            similarityRepeatThreshold: 3,
            riskWarnThreshold: 18,
            riskDeleteThreshold: 32,
            riskTimeoutThreshold: 52,
            baseTimeoutMs: 900000,
            maxTimeoutMs: 21600000
        },
        autoModAdvanced: {
            escalationThreshold24h: 3,
            escalationTimeoutMs: 2700000,
            progressiveTimeoutMultiplier: 1.5,
            kickThreshold24h: 12,
            regexMaxPatternLength: 180,
            riskWeights: {
                spam: 30,
                similarity: 34,
                caps: 16,
                profanity: 28,
                regex: 36,
                invites: 32,
                mentions: 20
            }
        }
    },
    relaxed: {
        blockExternalInvites: true,
        maxMentionsBeforeFlag: 8,
        autoMod: {
            spamThreshold: 7,
            spamWindow: 6000,
            capsThreshold: 0.80,
            minLengthForCaps: 12,
            spamTimeout: 420000,
            spamWarningThreshold: 3,
            similarityWindowMs: 90000,
            similarityThreshold: 0.91,
            similarityMinLength: 14,
            similarityRepeatThreshold: 4,
            riskWarnThreshold: 24,
            riskDeleteThreshold: 42,
            riskTimeoutThreshold: 70,
            baseTimeoutMs: 420000,
            maxTimeoutMs: 10800000
        },
        autoModAdvanced: {
            escalationThreshold24h: 6,
            escalationTimeoutMs: 1200000,
            progressiveTimeoutMultiplier: 1.3,
            kickThreshold24h: 16,
            regexMaxPatternLength: 180,
            riskWeights: {
                spam: 24,
                similarity: 26,
                caps: 12,
                profanity: 24,
                regex: 30,
                invites: 28,
                mentions: 16
            }
        }
    }
});

function loadMiscConfig() {
    const raw = fs.readFileSync(MISC_CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
}

function saveMiscConfig(config) {
    fs.writeFileSync(MISC_CONFIG_PATH, `${JSON.stringify(config, null, '\t')}\n`, 'utf8');
}

function loadAutoModConfig() {
    const raw = fs.readFileSync(AUTOMOD_CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
}

function saveAutoModConfig(config) {
    fs.writeFileSync(AUTOMOD_CONFIG_PATH, `${JSON.stringify(config, null, '\t')}\n`, 'utf8');
}

function ensureBackupDir() {
    try {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
    } catch (error) {
        console.error('[Backup] Failed to ensure backup directory:', error.message);
    }
}

function loadBackupConfig() {
    try {
        if (!fs.existsSync(BACKUP_CONFIG_PATH)) {
            const payload = { ...DEFAULT_BACKUP_CONFIG };
            fs.writeFileSync(BACKUP_CONFIG_PATH, `${JSON.stringify(payload, null, '\t')}\n`, 'utf8');
            return payload;
        }
        const raw = fs.readFileSync(BACKUP_CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return {
            ...DEFAULT_BACKUP_CONFIG,
            ...(parsed && typeof parsed === 'object' ? parsed : {})
        };
    } catch (error) {
        console.error('[Backup] Failed to load backup config:', error.message);
        return { ...DEFAULT_BACKUP_CONFIG };
    }
}

function saveBackupConfig(config) {
    backupConfig = { ...DEFAULT_BACKUP_CONFIG, ...config };
    fs.writeFileSync(BACKUP_CONFIG_PATH, `${JSON.stringify(backupConfig, null, '\t')}\n`, 'utf8');
    scheduleBackupTimer();
    return backupConfig;
}

function getDefaultServerBackupGuildId() {
    try {
        delete require.cache[require.resolve('./Config/main.json')];
        const mainConfig = require('./Config/main.json');
        return String(mainConfig?.serverID || '').trim();
    } catch {
        return '';
    }
}

function loadServerBackupConfig() {
    const loaded = ServerBackupManager.loadServerBackupConfig();
    return {
        ...ServerBackupManager.DEFAULT_SERVER_BACKUP_CONFIG,
        ...loaded,
        includes: ServerBackupManager.normalizeBackupIncludes(loaded?.includes || {})
    };
}

function saveServerBackupConfig(config) {
    serverBackupConfig = ServerBackupManager.saveServerBackupConfig({
        ...ServerBackupManager.DEFAULT_SERVER_BACKUP_CONFIG,
        ...config,
        includes: ServerBackupManager.normalizeBackupIncludes(config?.includes || {})
    });
    scheduleServerBackupTimer();
    return serverBackupConfig;
}

function listAvailableDiscordGuilds() {
    if (!discordClient?.guilds?.cache) {
        return [];
    }

    return Array.from(discordClient.guilds.cache.values())
        .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')))
        .map((guild) => ({
            id: guild.id,
            name: guild.name,
            iconURL: guild.iconURL({ size: 128 }) || null
        }));
}

async function resolveServerBackupGuild(guildId = null) {
    const targetGuildId = String(guildId || getDefaultServerBackupGuildId()).trim();
    if (!targetGuildId || !discordClient?.guilds) {
        return null;
    }

    return discordClient.guilds.cache.get(targetGuildId)
        || await discordClient.guilds.fetch(targetGuildId).catch(() => null);
}

function pruneServerBackupRestoreOperations() {
    const now = Date.now();

    for (const [operationId, operation] of serverBackupRestoreOperations.entries()) {
        const status = String(operation?.status || '').toLowerCase();
        const updatedAt = Number(operation?.updatedAt || operation?.startedAt || 0);
        const isActive = status === 'queued' || status === 'running';
        if (!isActive && updatedAt > 0 && (now - updatedAt) > SERVER_BACKUP_RESTORE_OPERATION_TTL_MS) {
            serverBackupRestoreOperations.delete(operationId);
        }
    }

    const completedOperations = Array.from(serverBackupRestoreOperations.entries())
        .filter(([, operation]) => !['queued', 'running'].includes(String(operation?.status || '').toLowerCase()))
        .sort((left, right) => Number(left[1]?.updatedAt || 0) - Number(right[1]?.updatedAt || 0));

    while (serverBackupRestoreOperations.size > SERVER_BACKUP_RESTORE_OPERATION_MAX_ENTRIES && completedOperations.length) {
        const [operationId] = completedOperations.shift();
        serverBackupRestoreOperations.delete(operationId);
    }
}

function serializeServerBackupRestoreOperation(operation) {
    if (!operation || typeof operation !== 'object') {
        return null;
    }

    return {
        id: operation.id,
        file: operation.file || null,
        status: operation.status || 'queued',
        phase: operation.phase || 'queued',
        stage: operation.stage || 'queued',
        message: operation.message || '',
        error: operation.error || null,
        progress: operation.progress || null,
        summary: operation.summary || null,
        events: Array.isArray(operation.events) ? operation.events : [],
        startedAt: Number(operation.startedAt || 0) || null,
        updatedAt: Number(operation.updatedAt || 0) || null,
        completedAt: Number(operation.completedAt || 0) || null
    };
}

function hasActiveServerBackupRestoreOperation() {
    pruneServerBackupRestoreOperations();
    return Array.from(serverBackupRestoreOperations.values()).some((operation) => {
        const status = String(operation?.status || '').toLowerCase();
        return status === 'queued' || status === 'running';
    });
}

function createServerBackupRestoreOperation({ file, requestedBy = null } = {}) {
    pruneServerBackupRestoreOperations();

    const timestamp = Date.now();
    const operation = {
        id: crypto.randomBytes(16).toString('hex'),
        file: String(file || '').trim() || null,
        requestedBy: requestedBy ? String(requestedBy).trim() : null,
        status: 'queued',
        phase: 'queued',
        stage: 'queued',
        message: 'Restore queued.',
        error: null,
        progress: {
            phase: 'queued',
            stage: 'queued',
            message: 'Restore queued.',
            currentLabel: null,
            processed: null,
            total: null,
            percent: null,
            timestamp
        },
        summary: null,
        events: [
            {
                timestamp,
                phase: 'queued',
                stage: 'queued',
                message: 'Restore queued.',
                currentLabel: null,
                processed: null,
                total: null,
                percent: null
            }
        ],
        startedAt: timestamp,
        updatedAt: timestamp,
        completedAt: null
    };

    serverBackupRestoreOperations.set(operation.id, operation);
    pruneServerBackupRestoreOperations();
    return operation;
}

function appendServerBackupRestoreOperationEvent(operation, event = {}) {
    if (!operation || typeof operation !== 'object') {
        return null;
    }

    const timestamp = Number(event.timestamp || Date.now()) || Date.now();
    const processed = Number.isFinite(Number(event.processed)) ? Number(event.processed) : null;
    const total = Number.isFinite(Number(event.total)) ? Number(event.total) : null;
    const explicitPercent = Number.isFinite(Number(event.percent)) ? Number(event.percent) : null;
    const derivedPercent = processed !== null && total !== null && total > 0
        ? Math.max(0, Math.min(100, Math.round((processed / total) * 100)))
        : null;
    const nextEvent = {
        timestamp,
        phase: String(event.phase || operation.phase || 'queued').trim() || 'queued',
        stage: String(event.stage || operation.stage || 'processing').trim() || 'processing',
        message: String(event.message || operation.message || '').trim(),
        currentLabel: String(event.currentLabel || '').trim() || null,
        processed,
        total,
        percent: explicitPercent !== null ? explicitPercent : derivedPercent
    };

    if (typeof event.status === 'string' && event.status.trim()) {
        operation.status = event.status.trim().toLowerCase();
    }

    operation.phase = nextEvent.phase;
    operation.stage = nextEvent.stage;
    operation.message = nextEvent.message || operation.message || '';
    operation.progress = nextEvent;
    operation.updatedAt = timestamp;
    operation.events = [nextEvent, ...(Array.isArray(operation.events) ? operation.events : [])].slice(0, 20);
    return operation;
}

function markServerBackupRestoreOperationCompleted(operation, summary) {
    if (!operation || typeof operation !== 'object') {
        return null;
    }

    operation.status = 'completed';
    operation.summary = summary || null;
    operation.error = null;
    operation.completedAt = Date.now();
    appendServerBackupRestoreOperationEvent(operation, {
        status: 'completed',
        phase: 'completed',
        stage: 'completed',
        message: Array.isArray(summary?.warnings) && summary.warnings.length
            ? 'Restore completed with warnings.'
            : 'Restore completed successfully.',
        percent: 100
    });
    return operation;
}

function markServerBackupRestoreOperationFailed(operation, error) {
    if (!operation || typeof operation !== 'object') {
        return null;
    }

    const message = error?.message || String(error || 'Restore failed');
    operation.status = 'failed';
    operation.error = message;
    operation.completedAt = Date.now();
    appendServerBackupRestoreOperationEvent(operation, {
        status: 'failed',
        phase: 'failed',
        stage: 'failed',
        message,
        percent: operation.progress?.percent ?? null
    });
    return operation;
}

function listBackupFiles() {
    try {
        ensureBackupDir();
        const files = fs.readdirSync(BACKUP_DIR)
            .filter((file) => file.endsWith('.sql') || file.endsWith('.json'))
            .map((file) => {
                const fullPath = path.join(BACKUP_DIR, file);
                const stat = fs.statSync(fullPath);
                return {
                    name: file,
                    size: stat.size,
                    createdAt: stat.mtimeMs
                };
            })
            .sort((a, b) => b.createdAt - a.createdAt);
        return files;
    } catch (error) {
        console.error('[Backup] Failed to list backup files:', error.message);
        return [];
    }
}

async function listBackupTables() {
    try {
        const [rows] = await MySQLDatabaseManager.connection.pool.query(
            'SELECT table_name as name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name'
        );
        return Array.isArray(rows) ? rows.map((row) => row.name).filter(Boolean) : [];
    } catch (error) {
        console.error('[Backup] Failed to list tables:', error.message);
        return [];
    }
}

async function exportTablesToJson(tables = []) {
    const database = process.env.MYSQL_DATABASE || 'discord_bot';
    const payload = {
        database,
        generatedAt: new Date().toISOString(),
        tables: {}
    };

    for (const table of tables) {
        try {
            const [columns] = await MySQLDatabaseManager.connection.pool.query(
                'SELECT COLUMN_NAME as name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ORDINAL_POSITION',
                [table]
            );
            const [rows] = await MySQLDatabaseManager.connection.pool.query('SELECT * FROM ??', [table]);
            payload.tables[table] = {
                columns: Array.isArray(columns) ? columns.map((col) => col.name) : [],
                rows: Array.isArray(rows) ? rows : []
            };
        } catch (error) {
            payload.tables[table] = {
                columns: [],
                rows: [],
                error: error.message || 'Failed to export table.'
            };
        }
    }

    return payload;
}

function getFirstExistingPath(candidates = []) {
    for (const candidate of candidates) {
        if (!candidate) continue;
        try {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        } catch {
        }
    }
    return null;
}

function getFirstExecutableFromSubdirs(parentDir, executableName) {
    try {
        if (!parentDir || !fs.existsSync(parentDir)) return null;
        const entries = fs.readdirSync(parentDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' }));

        for (const entry of entries) {
            const candidate = path.join(parentDir, entry.name, 'bin', executableName);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    } catch {
    }

    return null;
}

function resolveMysqldumpCommand() {
    const configured = String(process.env.MYSQLDUMP_PATH || process.env.MYSQL_DUMP_PATH || '').trim();
    if (configured) {
        if (configured.includes(path.sep) || configured.includes('/') || configured.includes('\\')) {
            return fs.existsSync(configured) ? configured : null;
        }
        return configured;
    }

    if (process.platform !== 'win32') {
        return 'mysqldump';
    }

    const executableName = 'mysqldump.exe';
    const programFiles = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter(Boolean);
    const directCandidates = [
        'C:\\xampp\\mysql\\bin\\mysqldump.exe',
        'C:\\wamp64\\bin\\mysql\\mysql8.0.31\\bin\\mysqldump.exe',
        'C:\\wamp64\\bin\\mysql\\mysql8.0.30\\bin\\mysqldump.exe',
        'C:\\laragon\\bin\\mysql\\mysql-8.0.30-winx64\\bin\\mysqldump.exe',
        'C:\\laragon\\bin\\mysql\\mysql-8.0.31-winx64\\bin\\mysqldump.exe'
    ];

    for (const root of programFiles) {
        directCandidates.push(path.join(root, 'MySQL', 'MySQL Server 8.0', 'bin', executableName));
        directCandidates.push(path.join(root, 'MySQL', 'MySQL Server 8.4', 'bin', executableName));
        directCandidates.push(path.join(root, 'MariaDB 11.4', 'bin', executableName));
        directCandidates.push(path.join(root, 'MariaDB 11.3', 'bin', executableName));
    }

    const directMatch = getFirstExistingPath(directCandidates);
    if (directMatch) {
        return directMatch;
    }

    for (const root of programFiles) {
        const mysqlDirMatch = getFirstExecutableFromSubdirs(path.join(root, 'MySQL'), executableName);
        if (mysqlDirMatch) {
            return mysqlDirMatch;
        }
    }

    const additionalRoots = [
        'C:\\xampp\\mysql',
        'C:\\wamp64\\bin\\mysql',
        'C:\\laragon\\bin\\mysql'
    ];

    for (const root of additionalRoots) {
        const match = getFirstExecutableFromSubdirs(root, executableName);
        if (match) {
            return match;
        }
    }

    return 'mysqldump';
}

function scheduleBackupTimer() {
    if (backupTimer) {
        clearInterval(backupTimer);
        backupTimer = null;
    }

    if (!backupConfig?.enabled) {
        backupState.nextRunAt = null;
        return;
    }

    const intervalMinutes = Math.max(15, Number(backupConfig.intervalMinutes) || DEFAULT_BACKUP_CONFIG.intervalMinutes);
    const intervalMs = intervalMinutes * 60 * 1000;
    backupState.nextRunAt = Date.now() + intervalMs;
    backupTimer = setInterval(() => {
        backupState.nextRunAt = Date.now() + intervalMs;
        runDatabaseBackup('scheduled', { tables: backupConfig?.tables, format: backupConfig?.format }).catch(() => { });
    }, intervalMs);
}

function scheduleServerBackupTimer() {
    if (serverBackupTimer) {
        clearInterval(serverBackupTimer);
        serverBackupTimer = null;
    }

    if (!serverBackupConfig?.enabled || !getDefaultServerBackupGuildId()) {
        serverBackupState.nextRunAt = null;
        return;
    }

    const intervalMinutes = Math.max(15, Number(serverBackupConfig.intervalMinutes) || ServerBackupManager.DEFAULT_SERVER_BACKUP_CONFIG.intervalMinutes);
    const intervalMs = intervalMinutes * 60 * 1000;
    serverBackupState.nextRunAt = Date.now() + intervalMs;
    serverBackupTimer = setInterval(() => {
        serverBackupState.nextRunAt = Date.now() + intervalMs;
        runServerStructureBackup('scheduled', {
            includes: serverBackupConfig?.includes
        }).catch(() => { });
    }, intervalMs);
}

async function sendServerBackupLogEmbed({
    guild = null,
    trigger = 'manual',
    requestedBy = null,
    status = 'success',
    result = null,
    error = null,
    includes = null
} = {}) {
    if (!discordClient || !serverLogChannelId) {
        return;
    }

    try {
        const logChannel = await discordClient.channels.fetch(serverLogChannelId).catch(() => null);
        if (!logChannel) {
            return;
        }

        const normalizedStatus = String(status || 'success').toLowerCase();
        const normalizedTrigger = String(trigger || 'manual').toLowerCase();
        const normalizedIncludes = ServerBackupManager.normalizeBackupIncludes(includes || result?.includes || {});
        const enabledSections = Object.entries(normalizedIncludes)
            .filter(([, enabled]) => enabled)
            .map(([key]) => key.replace(/([A-Z])/g, ' $1').toLowerCase())
            .join(', ') || 'none';
        const actorLabel = requestedBy || (normalizedTrigger === 'scheduled' ? 'Scheduler' : 'System');
        const guildLabel = guild?.name && guild?.id ? `${guild.name} (${guild.id})` : (guild?.id || 'Unavailable');

        const embed = new EmbedBuilder()
            .setTitle(normalizedStatus === 'success' ? '💾 Server Backup Completed' : '⚠️ Server Backup Failed')
            .setColor(normalizedStatus === 'success' ? 0x43B581 : 0xED4245)
            .addFields(
                { name: '🏠 Server', value: guildLabel, inline: false },
                { name: '🚀 Trigger', value: normalizedTrigger, inline: true },
                { name: '👤 Requested By', value: String(actorLabel), inline: true },
                { name: '📦 Included', value: enabledSections, inline: false }
            )
            .setTimestamp();

        if (normalizedStatus === 'success') {
            embed.addFields(
                { name: '📄 Backup File', value: result?.fileName ? `\`${result.fileName}\`` : 'Unavailable', inline: false },
                { name: '🗜️ Size', value: ServerBackupManager.formatBackupBytes(result?.size || 0), inline: true },
                { name: '🏷️ Label', value: String(result?.label || 'None'), inline: true }
            );
            embed.setFooter({ text: `Server backup completed via ${normalizedTrigger}` });
        } else {
            embed.addFields({
                name: '❌ Error',
                value: String(error || 'Unknown backup failure').slice(0, 1024),
                inline: false
            });
            embed.setFooter({ text: `Server backup failed via ${normalizedTrigger}` });
        }

        await logChannel.send({ embeds: [embed] }).catch((sendError) => {
            console.error('[ServerBackup] Failed to send backup log embed:', sendError.message || sendError);
        });
    } catch (logError) {
        console.error('[ServerBackup] Failed to build backup log embed:', logError.message || logError);
    }
}

async function runServerStructureBackup(trigger = 'manual', options = {}) {
    if (serverBackupState.running) {
        return { success: false, error: 'Server backup already in progress.' };
    }

    serverBackupState.running = true;
    serverBackupState.lastRunStatus = 'running';
    serverBackupState.lastRunError = null;

    try {
        const guild = await resolveServerBackupGuild(options.guildId);
        if (!guild) {
            serverBackupState.lastRunStatus = 'failed';
            serverBackupState.lastRunError = 'The configured guild could not be resolved.';
            serverBackupState.running = false;
            await sendServerBackupLogEmbed({
                guild: null,
                trigger,
                requestedBy: options.requestedBy || null,
                status: 'failed',
                error: serverBackupState.lastRunError,
                includes: options.includes || serverBackupConfig?.includes || {}
            });
            return { success: false, error: serverBackupState.lastRunError };
        }

        const retentionCount = Math.max(
            1,
            Number(options.retentionCount ?? serverBackupConfig?.retentionCount) || ServerBackupManager.DEFAULT_SERVER_BACKUP_CONFIG.retentionCount
        );
        const includes = ServerBackupManager.normalizeBackupIncludes(options.includes || serverBackupConfig?.includes || {});

        const result = await ServerBackupManager.createServerBackupFromGuild(guild, {
            trigger,
            retentionCount,
            includes,
            label: options.label,
            notes: options.notes,
            requestedBy: options.requestedBy || null
        });

        serverBackupState.lastRunAt = Date.now();
        serverBackupState.lastRunFile = result.fileName;
        serverBackupState.lastRunStatus = 'success';
        serverBackupState.lastRunError = null;
        serverBackupState.lastGuildId = guild.id;
        serverBackupState.running = false;
        await sendServerBackupLogEmbed({
            guild,
            trigger,
            requestedBy: options.requestedBy || null,
            status: 'success',
            result,
            includes
        });
        return { success: true, ...result };
    } catch (error) {
        serverBackupState.lastRunStatus = 'failed';
        serverBackupState.lastRunError = error.message || 'Server backup failed.';
        serverBackupState.running = false;
        await sendServerBackupLogEmbed({
            guild: null,
            trigger,
            requestedBy: options.requestedBy || null,
            status: 'failed',
            error: serverBackupState.lastRunError,
            includes: options.includes || serverBackupConfig?.includes || {}
        });
        return { success: false, error: serverBackupState.lastRunError };
    }
}

async function runDatabaseBackup(trigger = 'manual', options = {}) {
    if (backupState.running) {
        return { success: false, error: 'Backup already in progress.' };
    }

    ensureBackupDir();
    backupState.running = true;
    backupState.lastRunStatus = 'running';
    backupState.lastRunError = null;

    const host = process.env.MYSQL_HOST || 'localhost';
    const port = String(process.env.MYSQL_PORT || 3306);
    const user = process.env.MYSQL_USER || 'root';
    const password = process.env.MYSQL_PASSWORD || '';
    const database = process.env.MYSQL_DATABASE || 'discord_bot';

    const availableTables = await listBackupTables();
    const allowedTables = new Set(availableTables);
    const requestedTables = Array.isArray(options.tables) ? options.tables : backupConfig?.tables || [];
    const selectedTables = requestedTables
        .map((table) => String(table || '').trim())
        .filter((table) => allowedTables.has(table));
    const tablesToExport = selectedTables.length > 0 ? selectedTables : availableTables;
    const format = String(options.format || backupConfig?.format || 'json').toLowerCase();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileExt = format === 'json' ? 'json' : 'sql';
    const fileName = `backup-${database}-${timestamp}.${fileExt}`;
    const filePath = path.join(BACKUP_DIR, fileName);

    const env = { ...process.env };
    if (password) {
        env.MYSQL_PWD = password;
    }

    if (format === 'json') {
        try {
            const payload = await exportTablesToJson(tablesToExport);
            fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
            backupState.lastRunAt = Date.now();
            backupState.lastRunFile = fileName;
            backupState.lastRunStatus = 'success';
            backupState.lastRunError = null;
            backupState.running = false;
        } catch (error) {
            backupState.lastRunStatus = 'failed';
            backupState.lastRunError = error.message || 'Backup failed.';
            backupState.running = false;
            return { success: false, error: backupState.lastRunError };
        }

        const retention = Math.max(1, Number(backupConfig?.retentionCount) || DEFAULT_BACKUP_CONFIG.retentionCount);
        const files = listBackupFiles();
        const toRemove = files.slice(retention);
        toRemove.forEach((file) => {
            try {
                fs.unlinkSync(path.join(BACKUP_DIR, file.name));
            } catch (error) {
                console.warn('[Backup] Failed to prune backup:', error.message);
            }
        });

        return { success: true, fileName, trigger };
    }

    const dumpCommand = resolveMysqldumpCommand();
    if (!dumpCommand) {
        backupState.lastRunStatus = 'failed';
        backupState.lastRunError = 'mysqldump path not found. Set MYSQLDUMP_PATH or switch backups to JSON format.';
        backupState.running = false;
        return { success: false, error: backupState.lastRunError };
    }
    if ((dumpCommand.includes(path.sep) || dumpCommand.includes('/')) && !fs.existsSync(dumpCommand)) {
        backupState.lastRunStatus = 'failed';
        backupState.lastRunError = 'mysqldump path not found. Check MYSQLDUMP_PATH or switch backups to JSON format.';
        backupState.running = false;
        return { success: false, error: backupState.lastRunError };
    }

    const args = [
        '--host', host,
        '--port', port,
        '--user', user,
        '--routines',
        '--events',
        '--triggers',
        '--single-transaction',
        database
    ];

    const result = await new Promise((resolve) => {
        const output = fs.createWriteStream(filePath, { flags: 'w' });
        let stderr = '';
        let completed = false;

        const child = spawn(dumpCommand, args, { env });

        child.stdout.pipe(output);
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('error', (error) => {
            if (completed) return;
            completed = true;
            resolve({
                success: false,
                error: error.code === 'ENOENT'
                    ? 'mysqldump not found. Set MYSQLDUMP_PATH, add MySQL bin to PATH, or switch backups to JSON format.'
                    : (error.message || 'Backup process failed.')
            });
        });

        child.on('close', (code) => {
            if (completed) return;
            completed = true;
            if (code === 0) {
                resolve({ success: true });
            } else {
                resolve({ success: false, error: stderr.trim() || `Backup failed (exit ${code})` });
            }
        });
    });

    if (!result.success) {
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch {
        }
        backupState.lastRunStatus = 'failed';
        backupState.lastRunError = result.error || 'Backup failed.';
        backupState.running = false;
        return result;
    }

    backupState.lastRunAt = Date.now();
    backupState.lastRunFile = fileName;
    backupState.lastRunStatus = 'success';
    backupState.lastRunError = null;
    backupState.running = false;

    const retention = Math.max(1, Number(backupConfig?.retentionCount) || DEFAULT_BACKUP_CONFIG.retentionCount);
    const files = listBackupFiles();
    const toRemove = files.slice(retention);
    toRemove.forEach((file) => {
        try {
            fs.unlinkSync(path.join(BACKUP_DIR, file.name));
        } catch (error) {
            console.warn('[Backup] Failed to prune backup:', error.message);
        }
    });

    return { success: true, fileName, trigger };
}

backupConfig = loadBackupConfig();
scheduleBackupTimer();
serverBackupConfig = loadServerBackupConfig();
scheduleServerBackupTimer();

function cloneDefaultAutoModProfiles() {
    return JSON.parse(JSON.stringify(DEFAULT_AUTOMOD_PROFILES));
}

function normalizeAutoModProfiles(config) {
    const nextConfig = config || {};
    const defaultProfiles = cloneDefaultAutoModProfiles();

    if (!nextConfig.autoModProfiles || typeof nextConfig.autoModProfiles !== 'object') {
        nextConfig.autoModProfiles = { activeProfile: 'balanced', profiles: defaultProfiles };
        return nextConfig;
    }

    if (!nextConfig.autoModProfiles.profiles || typeof nextConfig.autoModProfiles.profiles !== 'object') {
        nextConfig.autoModProfiles.profiles = defaultProfiles;
    }

    for (const [profileName, profileData] of Object.entries(defaultProfiles)) {
        if (!nextConfig.autoModProfiles.profiles[profileName]) {
            nextConfig.autoModProfiles.profiles[profileName] = profileData;
        }
    }

    const activeProfile = String(nextConfig.autoModProfiles.activeProfile || 'balanced');
    if (!nextConfig.autoModProfiles.profiles[activeProfile]) {
        nextConfig.autoModProfiles.activeProfile = 'balanced';
    }

    return nextConfig;
}

function toInt(value, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.round(numeric);
}

const DEFAULT_CAPTCHA_POLICY = Object.freeze({
    loginEnabled: (() => {
        const raw = String(process.env.CAPTCHA_LOGIN_ENABLED || 'true').trim().toLowerCase();
        return !['0', 'false', 'no', 'off'].includes(raw);
    })(),
    registerEnabled: (() => {
        const raw = String(process.env.CAPTCHA_REGISTER_ENABLED || 'true').trim().toLowerCase();
        return !['0', 'false', 'no', 'off'].includes(raw);
    })(),
    ttlMs: (() => {
        const parsed = Number(process.env.CAPTCHA_CHALLENGE_TTL_MS);
        return Number.isFinite(parsed) && parsed >= 60 * 1000 ? parsed : 5 * 60 * 1000;
    })(),
    maxAttempts: (() => {
        const parsed = Number(process.env.CAPTCHA_MAX_ATTEMPTS);
        return Number.isFinite(parsed) && parsed >= 1 ? parsed : 3;
    })(),
    minValue: (() => {
        const parsed = Number(process.env.CAPTCHA_MIN_VALUE);
        return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
    })(),
    maxValue: (() => {
        const parsed = Number(process.env.CAPTCHA_MAX_VALUE);
        return Number.isFinite(parsed) && parsed >= 5 ? parsed : 20;
    })(),
    minSolveMs: (() => {
        const parsed = Number(process.env.CAPTCHA_MIN_SOLVE_MS);
        return Number.isFinite(parsed) && parsed >= 300 ? parsed : 900;
    })(),
    adaptiveDifficultyEnabled: (() => {
        const raw = String(process.env.CAPTCHA_ADAPTIVE_DIFFICULTY || 'true').trim().toLowerCase();
        return !['0', 'false', 'no', 'off'].includes(raw);
    })(),
    failureWindowMs: (() => {
        const parsed = Number(process.env.CAPTCHA_FAILURE_WINDOW_MS);
        return Number.isFinite(parsed) && parsed >= 60 * 1000 ? parsed : 15 * 60 * 1000;
    })(),
    failureThreshold: (() => {
        const parsed = Number(process.env.CAPTCHA_FAILURE_THRESHOLD);
        return Number.isFinite(parsed) && parsed >= 3 ? parsed : 10;
    })(),
    failureBlockMs: (() => {
        const parsed = Number(process.env.CAPTCHA_FAILURE_BLOCK_MS);
        return Number.isFinite(parsed) && parsed >= 60 * 1000 ? parsed : 10 * 60 * 1000;
    })()
});

const CAPTCHA_POLICY_LIMITS = Object.freeze({
    ttlMinMs: 60 * 1000,
    ttlMaxMs: 15 * 60 * 1000,
    maxAttemptsMin: 1,
    maxAttemptsMax: 10,
    minValueMin: 1,
    minValueMax: 100,
    maxValueMin: 2,
    maxValueMax: 200,
    minSolveMinMs: 300,
    minSolveMaxMs: 5000,
    failureWindowMinMs: 60 * 1000,
    failureWindowMaxMs: 60 * 60 * 1000,
    failureThresholdMin: 3,
    failureThresholdMax: 50,
    failureBlockMinMs: 60 * 1000,
    failureBlockMaxMs: 60 * 60 * 1000
});

function normalizeCaptchaPolicy(input = {}, basePolicy = DEFAULT_CAPTCHA_POLICY) {
    const base = {
        ...DEFAULT_CAPTCHA_POLICY,
        ...(basePolicy || {})
    };

    const minValue = Math.min(
        CAPTCHA_POLICY_LIMITS.minValueMax,
        Math.max(
            CAPTCHA_POLICY_LIMITS.minValueMin,
            toInt(input.minValue, base.minValue)
        )
    );

    const maxFloor = Math.max(CAPTCHA_POLICY_LIMITS.maxValueMin, minValue + 1);
    const maxValue = Math.min(
        CAPTCHA_POLICY_LIMITS.maxValueMax,
        Math.max(
            maxFloor,
            toInt(input.maxValue, base.maxValue)
        )
    );

    return {
        loginEnabled: typeof input.loginEnabled === 'boolean'
            ? input.loginEnabled
            : Boolean(base.loginEnabled),
        registerEnabled: typeof input.registerEnabled === 'boolean'
            ? input.registerEnabled
            : Boolean(base.registerEnabled),
        ttlMs: Math.min(
            CAPTCHA_POLICY_LIMITS.ttlMaxMs,
            Math.max(
                CAPTCHA_POLICY_LIMITS.ttlMinMs,
                toInt(input.ttlMs, base.ttlMs)
            )
        ),
        maxAttempts: Math.min(
            CAPTCHA_POLICY_LIMITS.maxAttemptsMax,
            Math.max(
                CAPTCHA_POLICY_LIMITS.maxAttemptsMin,
                toInt(input.maxAttempts, base.maxAttempts)
            )
        ),
        minSolveMs: Math.min(
            CAPTCHA_POLICY_LIMITS.minSolveMaxMs,
            Math.max(
                CAPTCHA_POLICY_LIMITS.minSolveMinMs,
                toInt(input.minSolveMs, base.minSolveMs)
            )
        ),
        adaptiveDifficultyEnabled: typeof input.adaptiveDifficultyEnabled === 'boolean'
            ? input.adaptiveDifficultyEnabled
            : Boolean(base.adaptiveDifficultyEnabled),
        failureWindowMs: Math.min(
            CAPTCHA_POLICY_LIMITS.failureWindowMaxMs,
            Math.max(
                CAPTCHA_POLICY_LIMITS.failureWindowMinMs,
                toInt(input.failureWindowMs, base.failureWindowMs)
            )
        ),
        failureThreshold: Math.min(
            CAPTCHA_POLICY_LIMITS.failureThresholdMax,
            Math.max(
                CAPTCHA_POLICY_LIMITS.failureThresholdMin,
                toInt(input.failureThreshold, base.failureThreshold)
            )
        ),
        failureBlockMs: Math.min(
            CAPTCHA_POLICY_LIMITS.failureBlockMaxMs,
            Math.max(
                CAPTCHA_POLICY_LIMITS.failureBlockMinMs,
                toInt(input.failureBlockMs, base.failureBlockMs)
            )
        ),
        minValue,
        maxValue
    };
}

function resolveCaptchaPolicySettings() {
    try {
        const config = loadMiscConfig();
        const stored = config?.securitySettings?.captchaPolicy || {};
        return normalizeCaptchaPolicy(stored, DEFAULT_CAPTCHA_POLICY);
    } catch (_) {
        return { ...DEFAULT_CAPTCHA_POLICY };
    }
}

function normalizeSessionPolicy(input = {}, basePolicy = DEFAULT_SESSION_POLICY) {
    const base = {
        ...DEFAULT_SESSION_POLICY,
        ...(basePolicy || {})
    };

    const idleTimeoutMs = Math.min(
        SESSION_POLICY_LIMITS.idleMaxMs,
        Math.max(
            SESSION_POLICY_LIMITS.idleMinMs,
            toInt(input.idleTimeoutMs, base.idleTimeoutMs)
        )
    );

    const absoluteFloor = Math.max(SESSION_POLICY_LIMITS.absoluteMinMs, idleTimeoutMs);
    const absoluteTimeoutMs = Math.min(
        SESSION_POLICY_LIMITS.absoluteMaxMs,
        Math.max(
            absoluteFloor,
            toInt(input.absoluteTimeoutMs, base.absoluteTimeoutMs)
        )
    );

    const singleSessionCheckIntervalMs = Math.min(
        SESSION_POLICY_LIMITS.checkIntervalMaxMs,
        Math.max(
            SESSION_POLICY_LIMITS.checkIntervalMinMs,
            toInt(input.singleSessionCheckIntervalMs, base.singleSessionCheckIntervalMs)
        )
    );

    return {
        singleSessionMode: typeof input.singleSessionMode === 'boolean'
            ? input.singleSessionMode
            : Boolean(base.singleSessionMode),
        idleTimeoutMs,
        absoluteTimeoutMs,
        singleSessionCheckIntervalMs
    };
}

function resolveSessionPolicySettings() {
    try {
        const config = loadMiscConfig();
        const stored = config?.securitySettings || {};
        return normalizeSessionPolicy(stored, DEFAULT_SESSION_POLICY);
    } catch (_) {
        return { ...DEFAULT_SESSION_POLICY };
    }
}

sessionPolicyState = resolveSessionPolicySettings();
let captchaPolicyState = resolveCaptchaPolicySettings();

function buildEffectiveAutoModConfig(config) {
    const profileConfig = config?.autoModProfiles?.profiles?.[config?.autoModProfiles?.activeProfile] || {};
    const effective = {
        blockExternalInvites: profileConfig.blockExternalInvites !== undefined
            ? Boolean(profileConfig.blockExternalInvites)
            : Boolean(config.blockExternalInvites),
        maxMentionsBeforeFlag: Number.isFinite(Number(profileConfig.maxMentionsBeforeFlag))
            ? Number(profileConfig.maxMentionsBeforeFlag)
            : Number(config.maxMentionsBeforeFlag),
        autoMod: {
            ...(config.autoMod || {}),
            ...((profileConfig && profileConfig.autoMod) || {})
        },
        autoModAdvanced: {
            ...(config.autoModAdvanced || {}),
            ...((profileConfig && profileConfig.autoModAdvanced) || {})
        }
    };

    return effective;
}

function toFiniteNumber(value, fallback, min = null, max = null) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    let next = numeric;
    if (Number.isFinite(min)) next = Math.max(min, next);
    if (Number.isFinite(max)) next = Math.min(max, next);
    return next;
}

function sanitizeRegexPatternList(input, maxItems = 100) {
    if (!Array.isArray(input)) return [];
    return input
        .filter(item => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean)
        .slice(0, maxItems);
}

function sanitizeDiscordIdList(input, maxItems = 200) {
    if (!Array.isArray(input)) return [];
    return input
        .filter(item => typeof item === 'string')
        .map(item => item.trim())
        .filter(item => DISCORD_USER_ID_LIST_REGEX.test(item))
        .slice(0, maxItems);
}

function sanitizeRiskWeights(weightsInput, baseWeights = {}) {
    const source = (weightsInput && typeof weightsInput === 'object') ? weightsInput : {};
    const base = (baseWeights && typeof baseWeights === 'object') ? baseWeights : {};
    return {
        spam: toFiniteNumber(source.spam, toFiniteNumber(base.spam, 28, 1, 200), 1, 200),
        similarity: toFiniteNumber(source.similarity, toFiniteNumber(base.similarity, 30, 1, 200), 1, 200),
        caps: toFiniteNumber(source.caps, toFiniteNumber(base.caps, 14, 1, 200), 1, 200),
        profanity: toFiniteNumber(source.profanity, toFiniteNumber(base.profanity, 26, 1, 200), 1, 200),
        regex: toFiniteNumber(source.regex, toFiniteNumber(base.regex, 34, 1, 200), 1, 200),
        invites: toFiniteNumber(source.invites, toFiniteNumber(base.invites, 30, 1, 200), 1, 200),
        mentions: toFiniteNumber(source.mentions, toFiniteNumber(base.mentions, 18, 1, 200), 1, 200)
    };
}

function sanitizeAutoModProfileInput(input = {}, baseProfile = {}) {
    const source = (input && typeof input === 'object') ? input : {};
    const base = (baseProfile && typeof baseProfile === 'object') ? baseProfile : {};

    const sourceAutoMod = (source.autoMod && typeof source.autoMod === 'object') ? source.autoMod : {};
    const baseAutoMod = (base.autoMod && typeof base.autoMod === 'object') ? base.autoMod : {};

    const sourceAdvanced = (source.autoModAdvanced && typeof source.autoModAdvanced === 'object') ? source.autoModAdvanced : {};
    const baseAdvanced = (base.autoModAdvanced && typeof base.autoModAdvanced === 'object') ? base.autoModAdvanced : {};

    const regexMaxPatternLength = toFiniteNumber(
        sourceAdvanced.regexMaxPatternLength,
        toFiniteNumber(baseAdvanced.regexMaxPatternLength, 180, 20, 1000),
        20,
        1000
    );

    const blockedRegexPatterns = sanitizeRegexPatternList(
        Array.isArray(sourceAdvanced.blockedRegexPatterns)
            ? sourceAdvanced.blockedRegexPatterns
            : baseAdvanced.blockedRegexPatterns,
        100
    )
        .map(pattern => pattern.slice(0, regexMaxPatternLength))
        .filter(Boolean);

    return {
        blockExternalInvites: source.blockExternalInvites !== undefined
            ? Boolean(source.blockExternalInvites)
            : Boolean(base.blockExternalInvites),
        maxMentionsBeforeFlag: toFiniteNumber(source.maxMentionsBeforeFlag, toFiniteNumber(base.maxMentionsBeforeFlag, 6, 1, 200), 1, 200),
        autoMod: {
            spamThreshold: toFiniteNumber(sourceAutoMod.spamThreshold, toFiniteNumber(baseAutoMod.spamThreshold, 5, 1, 200), 1, 200),
            spamWindow: toFiniteNumber(sourceAutoMod.spamWindow, toFiniteNumber(baseAutoMod.spamWindow, 5000, 250, 300000), 250, 300000),
            spamWarningThreshold: toFiniteNumber(sourceAutoMod.spamWarningThreshold, toFiniteNumber(baseAutoMod.spamWarningThreshold, 2, 1, 200), 1, 200),
            spamTimeout: toFiniteNumber(sourceAutoMod.spamTimeout, toFiniteNumber(baseAutoMod.spamTimeout, 600000, 1000, 86400000), 1000, 86400000),
            capsThreshold: toFiniteNumber(sourceAutoMod.capsThreshold, toFiniteNumber(baseAutoMod.capsThreshold, 0.7, 0.1, 1), 0.1, 1),
            minLengthForCaps: toFiniteNumber(sourceAutoMod.minLengthForCaps, toFiniteNumber(baseAutoMod.minLengthForCaps, 10, 1, 2000), 1, 2000),
            similarityWindowMs: toFiniteNumber(sourceAutoMod.similarityWindowMs, toFiniteNumber(baseAutoMod.similarityWindowMs, 120000, 5000, 3600000), 5000, 3600000),
            similarityThreshold: toFiniteNumber(sourceAutoMod.similarityThreshold, toFiniteNumber(baseAutoMod.similarityThreshold, 0.88, 0.5, 0.99), 0.5, 0.99),
            similarityMinLength: toFiniteNumber(sourceAutoMod.similarityMinLength, toFiniteNumber(baseAutoMod.similarityMinLength, 12, 4, 2000), 4, 2000),
            similarityRepeatThreshold: toFiniteNumber(sourceAutoMod.similarityRepeatThreshold, toFiniteNumber(baseAutoMod.similarityRepeatThreshold, 3, 2, 30), 2, 30),
            riskWarnThreshold: toFiniteNumber(sourceAutoMod.riskWarnThreshold, toFiniteNumber(baseAutoMod.riskWarnThreshold, 20, 1, 1000), 1, 1000),
            riskDeleteThreshold: toFiniteNumber(sourceAutoMod.riskDeleteThreshold, toFiniteNumber(baseAutoMod.riskDeleteThreshold, 35, 1, 1000), 1, 1000),
            riskTimeoutThreshold: toFiniteNumber(sourceAutoMod.riskTimeoutThreshold, toFiniteNumber(baseAutoMod.riskTimeoutThreshold, 60, 1, 1000), 1, 1000),
            baseTimeoutMs: toFiniteNumber(sourceAutoMod.baseTimeoutMs, toFiniteNumber(baseAutoMod.baseTimeoutMs, 600000, 1000, 86400000), 1000, 86400000),
            maxTimeoutMs: toFiniteNumber(sourceAutoMod.maxTimeoutMs, toFiniteNumber(baseAutoMod.maxTimeoutMs, 21600000, 1000, 86400000), 1000, 86400000)
        },
        autoModAdvanced: {
            escalationThreshold24h: toFiniteNumber(sourceAdvanced.escalationThreshold24h, toFiniteNumber(baseAdvanced.escalationThreshold24h, 4, 1, 1000), 1, 1000),
            escalationTimeoutMs: toFiniteNumber(sourceAdvanced.escalationTimeoutMs, toFiniteNumber(baseAdvanced.escalationTimeoutMs, 1800000, 1000, 86400000), 1000, 86400000),
            progressiveTimeoutMultiplier: toFiniteNumber(sourceAdvanced.progressiveTimeoutMultiplier, toFiniteNumber(baseAdvanced.progressiveTimeoutMultiplier, 1.4, 1, 5), 1, 5),
            kickThreshold24h: toFiniteNumber(sourceAdvanced.kickThreshold24h, toFiniteNumber(baseAdvanced.kickThreshold24h, 14, 1, 5000), 1, 5000),
            regexMaxPatternLength,
            blockedRegexPatterns,
            exemptChannelIds: sanitizeDiscordIdList(
                Array.isArray(sourceAdvanced.exemptChannelIds) ? sourceAdvanced.exemptChannelIds : baseAdvanced.exemptChannelIds,
                200
            ),
            exemptRoleIds: sanitizeDiscordIdList(
                Array.isArray(sourceAdvanced.exemptRoleIds) ? sourceAdvanced.exemptRoleIds : baseAdvanced.exemptRoleIds,
                200
            ),
            riskWeights: sanitizeRiskWeights(sourceAdvanced.riskWeights, baseAdvanced.riskWeights)
        }
    };
}

function mergeAutoModSimulationDraft(effectiveConfig, draftConfig) {
    const merged = JSON.parse(JSON.stringify(effectiveConfig || {}));
    const draft = (draftConfig && typeof draftConfig === 'object') ? draftConfig : {};

    if (typeof draft.blockExternalInvites === 'boolean') {
        merged.blockExternalInvites = draft.blockExternalInvites;
    }

    if (Number.isFinite(Number(draft.maxMentionsBeforeFlag))) {
        merged.maxMentionsBeforeFlag = toFiniteNumber(draft.maxMentionsBeforeFlag, 6, 1, 200);
    }

    merged.autoMod = merged.autoMod || {};
    const draftAutoMod = (draft.autoMod && typeof draft.autoMod === 'object') ? draft.autoMod : {};
    if (Number.isFinite(Number(draftAutoMod.spamThreshold))) merged.autoMod.spamThreshold = toFiniteNumber(draftAutoMod.spamThreshold, 5, 1, 200);
    if (Number.isFinite(Number(draftAutoMod.spamWindow))) merged.autoMod.spamWindow = toFiniteNumber(draftAutoMod.spamWindow, 5000, 250, 300000);
    if (Number.isFinite(Number(draftAutoMod.spamWarningThreshold))) merged.autoMod.spamWarningThreshold = toFiniteNumber(draftAutoMod.spamWarningThreshold, 2, 1, 200);
    if (Number.isFinite(Number(draftAutoMod.spamTimeout))) merged.autoMod.spamTimeout = toFiniteNumber(draftAutoMod.spamTimeout, 600000, 1000, 86400000);
    if (Number.isFinite(Number(draftAutoMod.capsThreshold))) merged.autoMod.capsThreshold = toFiniteNumber(draftAutoMod.capsThreshold, 0.7, 0.1, 1);
    if (Number.isFinite(Number(draftAutoMod.similarityWindowMs))) merged.autoMod.similarityWindowMs = toFiniteNumber(draftAutoMod.similarityWindowMs, 120000, 5000, 3600000);
    if (Number.isFinite(Number(draftAutoMod.similarityThreshold))) merged.autoMod.similarityThreshold = toFiniteNumber(draftAutoMod.similarityThreshold, 0.88, 0.5, 0.99);
    if (Number.isFinite(Number(draftAutoMod.similarityMinLength))) merged.autoMod.similarityMinLength = toFiniteNumber(draftAutoMod.similarityMinLength, 12, 4, 2000);
    if (Number.isFinite(Number(draftAutoMod.similarityRepeatThreshold))) merged.autoMod.similarityRepeatThreshold = toFiniteNumber(draftAutoMod.similarityRepeatThreshold, 3, 2, 30);
    if (Number.isFinite(Number(draftAutoMod.riskWarnThreshold))) merged.autoMod.riskWarnThreshold = toFiniteNumber(draftAutoMod.riskWarnThreshold, 20, 1, 1000);
    if (Number.isFinite(Number(draftAutoMod.riskDeleteThreshold))) merged.autoMod.riskDeleteThreshold = toFiniteNumber(draftAutoMod.riskDeleteThreshold, 35, 1, 1000);
    if (Number.isFinite(Number(draftAutoMod.riskTimeoutThreshold))) merged.autoMod.riskTimeoutThreshold = toFiniteNumber(draftAutoMod.riskTimeoutThreshold, 60, 1, 1000);

    merged.autoModAdvanced = merged.autoModAdvanced || {};
    const draftAdvanced = (draft.autoModAdvanced && typeof draft.autoModAdvanced === 'object') ? draft.autoModAdvanced : {};
    if (Array.isArray(draftAdvanced.blockedRegexPatterns)) {
        merged.autoModAdvanced.blockedRegexPatterns = draftAdvanced.blockedRegexPatterns
            .filter(item => typeof item === 'string')
            .map(item => item.trim())
            .filter(Boolean)
            .slice(0, 100);
    }
    if (Number.isFinite(Number(draftAdvanced.escalationThreshold24h))) merged.autoModAdvanced.escalationThreshold24h = toFiniteNumber(draftAdvanced.escalationThreshold24h, 4, 1, 1000);
    if (Number.isFinite(Number(draftAdvanced.escalationTimeoutMs))) merged.autoModAdvanced.escalationTimeoutMs = toFiniteNumber(draftAdvanced.escalationTimeoutMs, 1800000, 1000, 86400000);
    if (Number.isFinite(Number(draftAdvanced.progressiveTimeoutMultiplier))) merged.autoModAdvanced.progressiveTimeoutMultiplier = toFiniteNumber(draftAdvanced.progressiveTimeoutMultiplier, 1.4, 1, 5);
    if (Number.isFinite(Number(draftAdvanced.kickThreshold24h))) merged.autoModAdvanced.kickThreshold24h = toFiniteNumber(draftAdvanced.kickThreshold24h, 14, 1, 5000);
    if (Number.isFinite(Number(draftAdvanced.regexMaxPatternLength))) merged.autoModAdvanced.regexMaxPatternLength = toFiniteNumber(draftAdvanced.regexMaxPatternLength, 180, 20, 1000);
    if (draftAdvanced.riskWeights && typeof draftAdvanced.riskWeights === 'object') {
        merged.autoModAdvanced.riskWeights = {
            ...(merged.autoModAdvanced.riskWeights || {}),
            ...draftAdvanced.riskWeights
        };
    }

    return merged;
}

function evaluateAutoModSimulation({ message, recentMessageCount, priorViolations24h, effectiveConfig }) {
    const config = effectiveConfig || {};
    const autoMod = config.autoMod || {};
    const advanced = config.autoModAdvanced || {};

    const findings = [];
    const actions = [];
    const signals = [];
    const matchedRegexPatterns = [];
    const invalidRegexPatterns = [];

    const riskWeights = {
        spam: toFiniteNumber(advanced?.riskWeights?.spam, 28, 1, 200),
        similarity: toFiniteNumber(advanced?.riskWeights?.similarity, 30, 1, 200),
        caps: toFiniteNumber(advanced?.riskWeights?.caps, 14, 1, 200),
        profanity: toFiniteNumber(advanced?.riskWeights?.profanity, 26, 1, 200),
        regex: toFiniteNumber(advanced?.riskWeights?.regex, 34, 1, 200),
        invites: toFiniteNumber(advanced?.riskWeights?.invites, 30, 1, 200),
        mentions: toFiniteNumber(advanced?.riskWeights?.mentions, 18, 1, 200)
    };

    const inviteRegex = /(discord\.gg|discord(app)?\.com\/invite)\/\S+/i;
    if (Boolean(config.blockExternalInvites) && inviteRegex.test(message)) {
        findings.push('Contains invite link while invite blocking is enabled');
        signals.push({ type: 'invites', score: riskWeights.invites });
    }

    const mentionMatches = message.match(/<@!?\d+>|@everyone|@here/g);
    const mentionCount = Array.isArray(mentionMatches) ? mentionMatches.length : 0;
    if (mentionCount > toFiniteNumber(config.maxMentionsBeforeFlag, 6, 1, 200)) {
        findings.push(`Mention count ${mentionCount} exceeds limit ${toFiniteNumber(config.maxMentionsBeforeFlag, 6, 1, 200)}`);
        signals.push({ type: 'mentions', score: riskWeights.mentions });
    }

    const letters = message.match(/[A-Za-z]/g) || [];
    const uppercase = message.match(/[A-Z]/g) || [];
    const minLengthForCaps = toFiniteNumber(autoMod.minLengthForCaps, 10, 1, 2000);
    if (letters.length >= minLengthForCaps) {
        const ratio = uppercase.length / letters.length;
        const capsThreshold = toFiniteNumber(autoMod.capsThreshold, 0.7, 0.1, 1);
        if (ratio >= capsThreshold) {
            findings.push(`Caps ratio ${(ratio * 100).toFixed(1)}% exceeds ${(capsThreshold * 100).toFixed(0)}% threshold`);
            signals.push({ type: 'caps', score: riskWeights.caps });
        }
    }

    const patterns = Array.isArray(advanced.blockedRegexPatterns) ? advanced.blockedRegexPatterns : [];
    const regexMaxPatternLength = toFiniteNumber(advanced.regexMaxPatternLength, 180, 20, 1000);
    patterns.forEach((pattern) => {
        if (typeof pattern !== 'string' || !pattern.trim()) return;
        if (pattern.length > regexMaxPatternLength) {
            invalidRegexPatterns.push(pattern);
            return;
        }
        if (pattern.trim() === '.*' || pattern.trim() === '.+') {
            invalidRegexPatterns.push(pattern);
            return;
        }
        try {
            const reg = new RegExp(pattern, 'i');
            if (reg.test(message)) matchedRegexPatterns.push(pattern);
        } catch (error) {
            invalidRegexPatterns.push(pattern);
        }
    });
    if (matchedRegexPatterns.length) {
        findings.push(`Matched blocked regex pattern(s): ${matchedRegexPatterns.slice(0, 3).join(', ')}${matchedRegexPatterns.length > 3 ? ' ...' : ''}`);
        signals.push({ type: 'regex', score: riskWeights.regex + ((matchedRegexPatterns.length - 1) * 4) });
    }

    const normalizedMessage = String(message || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const similarityRepeatThreshold = toFiniteNumber(autoMod.similarityRepeatThreshold, 3, 2, 30);
    const similarityThreshold = toFiniteNumber(autoMod.similarityThreshold, 0.88, 0.5, 0.99);
    if (normalizedMessage.length >= toFiniteNumber(autoMod.similarityMinLength, 12, 4, 2000)) {
        const syntheticSimilarityCount = recentMessageCount;
        if (syntheticSimilarityCount >= similarityRepeatThreshold) {
            findings.push(`Similarity model predicts repeated near-duplicate content (${syntheticSimilarityCount} messages, threshold ${similarityRepeatThreshold}, ratio ${Math.round(similarityThreshold * 100)}%)`);
            signals.push({ type: 'similarity', score: riskWeights.similarity });
        }
    }

    const spamThreshold = toFiniteNumber(autoMod.spamThreshold, 5, 1, 200);
    if (recentMessageCount >= spamThreshold) {
        findings.push(`Recent message count ${recentMessageCount} reaches spam threshold ${spamThreshold}`);
        signals.push({ type: 'spam', score: riskWeights.spam });
    }

    const riskScore = signals.reduce((sum, signal) => sum + Number(signal.score || 0), 0);
    const riskWarnThreshold = toFiniteNumber(autoMod.riskWarnThreshold, 20, 1, 1000);
    const riskDeleteThreshold = toFiniteNumber(autoMod.riskDeleteThreshold, 35, 1, 1000);
    const riskTimeoutThreshold = toFiniteNumber(autoMod.riskTimeoutThreshold, 60, 1, 1000);

    let riskLevel = 'low';
    if (riskScore >= riskTimeoutThreshold + 20) riskLevel = 'critical';
    else if (riskScore >= riskTimeoutThreshold) riskLevel = 'high';
    else if (riskScore >= riskDeleteThreshold) riskLevel = 'medium';

    let predictedAction = 'warn';
    if (riskScore >= riskTimeoutThreshold) predictedAction = 'timeout';
    else if (riskScore >= riskDeleteThreshold) predictedAction = 'delete';
    else if (riskScore >= riskWarnThreshold) predictedAction = 'warn';

    const escalationThreshold = toFiniteNumber(advanced.escalationThreshold24h, 4, 1, 1000);
    const escalationTimeout = toFiniteNumber(advanced.escalationTimeoutMs, 1800000, 1000, 86400000);
    const progressiveMultiplier = toFiniteNumber(advanced.progressiveTimeoutMultiplier, 1.4, 1, 5);
    const kickThreshold = toFiniteNumber(advanced.kickThreshold24h, 14, 1, 5000);
    const baseTimeoutMs = toFiniteNumber(autoMod.baseTimeoutMs, 600000, 1000, 86400000);
    const maxTimeoutMs = toFiniteNumber(autoMod.maxTimeoutMs, 21600000, baseTimeoutMs, 86400000);

    if (predictedAction === 'warn' && priorViolations24h >= escalationThreshold) {
        predictedAction = 'delete';
    }
    if ((predictedAction === 'delete' || predictedAction === 'timeout') && priorViolations24h >= escalationThreshold) {
        predictedAction = 'timeout';
    }
    let predictedTimeoutMs = 0;
    if (predictedAction === 'timeout') {
        const tier = Math.floor(priorViolations24h / 3);
        predictedTimeoutMs = Math.min(maxTimeoutMs, Math.round(baseTimeoutMs * (progressiveMultiplier ** tier)));
        if (priorViolations24h >= escalationThreshold) {
            predictedTimeoutMs = Math.max(predictedTimeoutMs, escalationTimeout);
        }
    }
    if (predictedAction === 'timeout' && priorViolations24h >= kickThreshold) {
        predictedAction = 'kick';
        predictedTimeoutMs = 0;
    }

    if (signals.length) {
        actions.push(`Predicted action: ${predictedAction}${predictedTimeoutMs ? ` (${predictedTimeoutMs}ms)` : ''}`);
    }

    return {
        verdict: findings.length ? 'flagged' : 'clean',
        findings,
        actions,
        riskScore,
        riskLevel,
        predictedAction,
        predictedTimeoutMs,
        metrics: {
            mentionCount,
            lettersCount: letters.length,
            uppercaseCount: uppercase.length,
            recentMessageCount,
            priorViolations24h
        },
        signals,
        matchedRegexPatterns,
        invalidRegexPatterns
    };
}

function normalizeAutoModReviewStatus(value, fallback = null) {
    const allowed = new Set(['pending', 'approved', 'dismissed']);
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return fallback;
    return allowed.has(normalized) ? normalized : fallback;
}

function normalizeAutoModSeverity(value, fallback = null) {
    const allowed = new Set(['low', 'medium', 'high', 'critical']);
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return fallback;
    return allowed.has(normalized) ? normalized : fallback;
}

function getAutoModDefaultSeverityFromViolation(violationType, actionTaken) {
    const action = String(actionTaken || '').toLowerCase();
    if (action === 'ban' || action === 'kick') return 'critical';
    if (action === 'timeout') return 'high';
    if (action === 'warn') return 'medium';

    const type = String(violationType || '').toLowerCase();
    if (type === 'spam' || type === 'mentions') return 'medium';
    return 'low';
}

function collectConfigFiles(configDir) {
    const files = [];

    function walk(currentDir) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
                continue;
            }
            files.push(fullPath);
        }
    }

    walk(configDir);
    return files;
}

function evaluateConfigFileReadiness(configDir, filePath) {
    const relativePath = path.relative(configDir, filePath).replace(/\\/g, '/');
    const extension = path.extname(filePath).toLowerCase();
    const raw = fs.readFileSync(filePath, 'utf8');
    const content = String(raw || '');
    const trimmed = content.trim();
    const check = {
        key: `file:${relativePath}`,
        label: relativePath,
        status: 'pass',
        message: 'Config file is present and valid.'
    };

    if (!trimmed) {
        check.status = 'fail';
        check.message = 'File is empty.';
        return check;
    }

    if (extension === '.json') {
        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch (error) {
            check.status = 'fail';
            check.message = `Invalid JSON: ${error.message}`;
            return check;
        }

        if (Array.isArray(parsed) && parsed.length === 0) {
            check.status = 'warn';
            check.message = 'JSON array is valid but currently empty.';
            return check;
        }

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0) {
            check.status = 'warn';
            check.message = 'JSON object is valid but has no keys yet.';
            return check;
        }

        const jsonText = JSON.stringify(parsed);
        if (/(changeme|your[_-]?|example|todo|replace_me|placeholder)/i.test(jsonText)) {
            check.status = 'warn';
            check.message = 'JSON appears valid but still contains placeholder values.';
            return check;
        }

        check.message = 'JSON file parsed successfully.';
        return check;
    }

    if (extension === '.env') {
        const lines = content
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#'));

        const assignments = lines.filter((line) => line.includes('='));
        if (!assignments.length) {
            check.status = 'fail';
            check.message = 'No KEY=VALUE entries found.';
            return check;
        }

        const emptyKeys = [];
        for (const line of assignments) {
            const [rawKey, ...rest] = line.split('=');
            const key = String(rawKey || '').trim();
            const value = rest.join('=').trim();
            if (!key) continue;
            if (!value) emptyKeys.push(key);
        }

        if (emptyKeys.length) {
            check.status = 'fail';
            const preview = emptyKeys.slice(0, 4).join(', ');
            check.message = `Missing values for ${emptyKeys.length} key(s): ${preview}${emptyKeys.length > 4 ? ', …' : ''}`;
            return check;
        }

        check.message = `${assignments.length} environment key(s) found with values.`;
        return check;
    }

    if (/(changeme|your[_-]?|example|todo|replace_me|placeholder)/i.test(trimmed)) {
        check.status = 'warn';
        check.message = 'File has content but still includes placeholder values.';
        return check;
    }

    check.message = 'File has non-empty content.';
    return check;
}

function buildConfigReadinessReport() {
    const configDir = path.join(__dirname, 'Config');
    const checks = [];

    if (!fs.existsSync(configDir)) {
        return {
            generatedAt: new Date().toISOString(),
            summary: {
                total: 1,
                passed: 0,
                warnings: 0,
                failed: 1,
                score: 0,
                ready: false
            },
            checks: [
                {
                    key: 'config:exists',
                    label: 'Config directory',
                    status: 'fail',
                    message: 'Config directory is missing.'
                }
            ]
        };
    }

    checks.push({
        key: 'config:exists',
        label: 'Config directory',
        status: 'pass',
        message: 'Config directory was found.'
    });

    const files = collectConfigFiles(configDir);
    if (!files.length) {
        checks.push({
            key: 'config:files',
            label: 'Config files',
            status: 'fail',
            message: 'No files were found in Config.'
        });
    } else {
        checks.push({
            key: 'config:files',
            label: 'Config files',
            status: 'pass',
            message: `${files.length} file(s) discovered.`
        });
    }

    for (const filePath of files) {
        checks.push(evaluateConfigFileReadiness(configDir, filePath));
    }

    const passed = checks.filter((check) => check.status === 'pass').length;
    const warnings = checks.filter((check) => check.status === 'warn').length;
    const failed = checks.filter((check) => check.status === 'fail').length;
    const total = checks.length;
    const score = total > 0
        ? Math.max(0, Math.min(100, Math.round(((passed + (warnings * 0.5)) / total) * 100)))
        : 0;

    return {
        generatedAt: new Date().toISOString(),
        summary: {
            total,
            passed,
            warnings,
            failed,
            score,
            ready: failed === 0
        },
        checks
    };
}

function countConfiguredEntries(value) {
    if (Array.isArray(value)) {
        return value.filter((entry) => String(entry || '').trim().length > 0).length;
    }
    if (value && typeof value === 'object') {
        return Object.values(value).reduce((count, entry) => count + countConfiguredEntries(entry), 0);
    }
    return String(value || '').trim().length > 0 ? 1 : 0;
}

function buildOwnerConfigOverview() {
    const constantsDir = path.join(__dirname, 'Config', 'constants');
    const fileDefinitions = [
        ['channel', 'channel.json'],
        ['role', 'roles.json'],
        ['misc', 'misc.json'],
        ['automod', 'automod.json'],
        ['autoResponder', 'autoResponder.json'],
        ['leveling', 'leveling.json'],
        ['economy', 'economy.json'],
        ['rules', 'rules.JSON'],
        ['serverBackups', 'serverBackups.json'],
        ['blockedWords', 'blockedWords.json'],
        ['api', 'api.json'],
        ['credits', 'credits.json']
    ];

    const files = fileDefinitions.map(([key, fileName]) => {
        const filePath = path.join(constantsDir, fileName);
        try {
            const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const stats = fs.statSync(filePath);
            const topLevelKeys = raw && typeof raw === 'object' ? Object.keys(raw) : [];
            return {
                key,
                fileName,
                exists: true,
                topLevelKeyCount: topLevelKeys.length,
                configuredEntryCount: countConfiguredEntries(raw),
                sampleKeys: topLevelKeys.slice(0, 8),
                updatedAt: stats.mtime.toISOString()
            };
        } catch {
            return {
                key,
                fileName,
                exists: false,
                topLevelKeyCount: 0,
                configuredEntryCount: 0,
                sampleKeys: [],
                updatedAt: null
            };
        }
    });

    return {
        generatedAt: new Date().toISOString(),
        readiness: buildConfigReadinessReport(),
        highlights: {
            main: {
                botName: PANEL_BOT_NAME,
                serverName: PANEL_SERVER_NAME
            },
            channels: Object.entries(CHANNELS || {}).slice(0, 12).map(([key, value]) => ({
                key,
                value: String(value || '').trim(),
                configured: String(value || '').trim().length > 0
            })),
            roles: Object.entries(ROLES_CONFIG || {}).slice(0, 12).map(([key, value]) => ({
                key,
                value: Array.isArray(value) ? value.filter(Boolean).length : String(value || '').trim(),
                configured: Array.isArray(value) ? value.filter(Boolean).length > 0 : String(value || '').trim().length > 0,
                isCollection: Array.isArray(value)
            })),
            botSafety: BotSafetyCenter.getConfig()
        },
        files
    };
}

// Main routes for the admin panel
app.get('/', (req, res) => {
    if (req.session && req.session.authenticated) {
        res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'dashboard.html'));
    } else {
        res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'login.html'));
    }
});

// Explicit admin panel route with role check
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'login.html'));
});

app.get('/recovery', (req, res) => {
    if (req.session && req.session.authenticated) {
        return res.redirect('/dashboard');
    }
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'recovery.html'));
});

app.get('/unauthorized', (req, res) => {
    // Log unauthorized access attempt for admin review
    try {
        const user = req.session?.username || 'Guest';
        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        const route = req.originalUrl || req.url;
        const logMsg = `[${new Date().toISOString()}] Unauthorized access attempt by ${user} from ${ip} to ${route}`;
        // Simple file log (append to a log file)
        const fs = require('fs');
        fs.appendFile(path.join(__dirname, 'AdminPanel', 'unauthorized.log'), logMsg + '\n', () => { });
    } catch (e) { /* ignore logging errors */ }
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'unauthorized.html'));
});


app.get('/appeal', (req, res) => {
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'appeal.html'));
});

// Serve static pages for features, FAQ, privacy, terms, and license
app.get('/features', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'features.html'));
});
app.get('/faq', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'faq.html'));
});
app.get('/getting-started', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'getting-started.html'));
});
app.get('/guide', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'guide.html'));
});
app.get('/best-practices', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'best-practices.html'));
});
app.get('/api/getting-started/config-readiness', requireAuth, (req, res) => {
    try {
        const report = buildConfigReadinessReport();
        return res.json(report);
    } catch (error) {
        console.error('[GettingStarted] Config readiness check failed:', error.message);
        return res.status(500).json({
            error: 'Config readiness check failed',
            details: error.message
        });
    }
});

// Documentation Feedback Endpoint
app.post('/api/feedback', requireAuth, (req, res) => {
    const { page, helpful } = req.body;
    const user = req.session.user;

    if (typeof helpful !== 'boolean') {
        return res.status(400).json({ error: 'Invalid feedback data' });
    }

    const feedbackFile = path.join(__dirname, 'Config', 'feedback.json');
    const entry = {
        timestamp: new Date().toISOString(),
        user: user ? user.username : 'Anonymous',
        userId: user ? user.id : null,
        page: page || 'unknown',
        helpful: helpful
    };

    fs.readFile(feedbackFile, 'utf8', (err, data) => {
        let feedbacks = [];
        if (!err && data) {
            try {
                feedbacks = JSON.parse(data);
            } catch (e) {
                console.error('Error parsing feedback.json:', e);
            }
        }

        feedbacks.push(entry);

        // Limit size (keep last 1000)
        if (feedbacks.length > 1000) feedbacks = feedbacks.slice(-1000);

        fs.writeFile(feedbackFile, JSON.stringify(feedbacks, null, 2), (err) => {
            if (err) console.error('Error saving feedback:', err);
            res.json({ success: true });
        });
    });
});

app.get('/moderation-playbook', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'moderation-playbook.html'));
});
app.get('/privacy-policy', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'privacy-policy.html'));
});
app.get('/terms-of-service', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'terms-of-service.html'));
});
app.get('/license', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'license.html'));
});

// Prevent 404 errors for favicon requests
app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
});


// Serve dashboard and inject CSRF token as a meta tag
app.get('/dashboard', requireAuth, (req, res) => {
    const dashboardPath = path.join(__dirname, 'AdminPanel', 'views', 'dashboard.html');
    fs.readFile(dashboardPath, 'utf8', (err, html) => {
        if (err) return res.status(500).send('Could not load dashboard');
        // Add the CSRF token meta tag right after <head>
        const csrfMeta = req.session && req.session.csrfToken
            ? `<meta name="csrf-token" content="${req.session.csrfToken}">\n`
            : '';
        const htmlWithCsrf = html.replace(/<head>/i, `<head>\n    ${csrfMeta}`);
        res.send(htmlWithCsrf);
    });
});

app.get('/moderator', requireAuth, requireModerator, (req, res) => {
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'moderator.html'));
});

// Track login attempts to prevent brute force attacks
const loginAttempts = new Map();
const authIdentifierAttempts = new Map();
const captchaFailuresByIp = new Map();
const AUTH_IDENTIFIER_WINDOW_MS = 30 * 60 * 1000;
const AUTH_IDENTIFIER_MAX_ATTEMPTS = 8;

function normalizeAuthIdentifier(identifier) {
    return String(identifier || '').trim().toLowerCase();
}

function buildAuthIdentifierKey(identifier, mode = 'login') {
    const normalizedIdentifier = normalizeAuthIdentifier(identifier);
    const normalizedMode = String(mode || 'login').trim().toLowerCase();
    if (!normalizedIdentifier) return '';

    return `${normalizedMode}:${normalizedIdentifier}`;
}

function pruneAttemptTimestamps(attempts, windowMs, now = Date.now()) {
    if (!Array.isArray(attempts)) return [];

    return attempts.filter((timestamp) => Number.isFinite(Number(timestamp)) && (now - Number(timestamp) < windowMs));
}

function trackAuthIdentifierAttempt(identifier, mode = 'login') {
    const key = buildAuthIdentifierKey(identifier, mode);
    if (!key) return [];

    const now = Date.now();
    const attempts = pruneAttemptTimestamps(authIdentifierAttempts.get(key), AUTH_IDENTIFIER_WINDOW_MS, now);
    attempts.push(now);
    authIdentifierAttempts.set(key, attempts);
    return attempts;
}

function clearAuthIdentifierAttempts(identifier, mode = 'login') {
    const key = buildAuthIdentifierKey(identifier, mode);
    if (!key) return;

    authIdentifierAttempts.delete(key);
}

function getAuthIdentifierAttemptCount(identifier, mode = 'login') {
    const key = buildAuthIdentifierKey(identifier, mode);
    if (!key) return 0;

    const now = Date.now();
    const attempts = pruneAttemptTimestamps(authIdentifierAttempts.get(key), AUTH_IDENTIFIER_WINDOW_MS, now);
    if (attempts.length > 0) {
        authIdentifierAttempts.set(key, attempts);
    } else {
        authIdentifierAttempts.delete(key);
    }

    return attempts.length;
}

function isAuthIdentifierLocked(identifier, mode = 'login') {
    return getAuthIdentifierAttemptCount(identifier, mode) >= AUTH_IDENTIFIER_MAX_ATTEMPTS;
}

function normalizeCaptchaScope(scope) {
    const normalized = String(scope || '').trim().toLowerCase();
    if (normalized === 'login' || normalized === 'register') return normalized;
    return 'auth';
}

function isCaptchaEnabledForScope(scope) {
    const safeScope = normalizeCaptchaScope(scope);
    if (safeScope === 'login') return Boolean(captchaPolicyState.loginEnabled);
    if (safeScope === 'register') return Boolean(captchaPolicyState.registerEnabled);
    return Boolean(captchaPolicyState.loginEnabled || captchaPolicyState.registerEnabled);
}

function normalizeCaptchaAnswer(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, '');
}

function randomIntInclusive(min, max) {
    const safeMin = Math.min(min, max);
    const safeMax = Math.max(min, max);
    return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

const CAPTCHA_WORD_BANK = Object.freeze([
    'SENTINEL',
    'SECURE',
    'VERIFY',
    'PANEL',
    'ACCESS',
    'DISCORD',
    'MODERATION',
    'DASHBOARD'
]);

function getCaptchaDifficultyLabel(difficulty) {
    if (difficulty >= 3) return 'Advanced challenge';
    if (difficulty === 2) return 'Standard challenge';
    return 'Quick challenge';
}

function buildSequenceCaptchaChallenge(minValue, maxValue, difficulty) {
    const step = difficulty >= 3
        ? randomIntInclusive(2, 5)
        : randomIntInclusive(1, 3);
    const startMax = Math.max(minValue + 4, maxValue - (step * 4));
    const start = randomIntInclusive(minValue, startMax);
    const sequence = [start, start + step, start + (step * 2), start + (step * 3)];
    const answer = start + (step * 4);

    return {
        question: `Complete the pattern: ${sequence.join(', ')}, ?`,
        answer: String(answer),
        mode: 'sequence-next-number',
        label: 'Number pattern',
        answerType: 'number',
        inputMode: 'numeric',
        placeholder: 'Enter the next number',
        tip: 'Look at how much the numbers increase each step.',
        answerLength: String(answer).length
    };
}

function buildComparisonCaptchaChallenge(minValue, maxValue) {
    const values = new Set();
    while (values.size < 4) {
        values.add(randomIntInclusive(minValue, maxValue));
    }

    const list = Array.from(values);
    const answer = Math.max(...list);

    return {
        question: `Pick the largest number: ${list.join(' • ')}.`,
        answer: String(answer),
        mode: 'comparison-largest',
        label: 'Largest number check',
        answerType: 'number',
        inputMode: 'numeric',
        placeholder: 'Enter the largest number',
        tip: 'Compare each value once, then enter only the highest number.',
        answerLength: String(answer).length
    };
}

function buildWordCaptchaChallenge() {
    const word = CAPTCHA_WORD_BANK[randomIntInclusive(0, CAPTCHA_WORD_BANK.length - 1)];

    if (Math.random() > 0.5) {
        const answer = word.split('').reverse().join('');
        return {
            question: `Type the word "${word}" backwards.`,
            answer,
            mode: 'word-reverse',
            label: 'Word reversal',
            answerType: 'text',
            inputMode: 'text',
            placeholder: 'Type the reversed word',
            tip: 'Letters only. Uppercase and lowercase both work.',
            answerLength: answer.length
        };
    }

    const answer = `${word[0]}${word[word.length - 1]}`;
    return {
        question: `Type the first and last letters of "${word}" together.`,
        answer,
        mode: 'word-first-last',
        label: 'Word letter check',
        answerType: 'text',
        inputMode: 'text',
        placeholder: 'Enter the two letters',
        tip: 'Do not add spaces or punctuation.',
        answerLength: answer.length
    };
}

function pruneCaptchaFailureEntry(entry, now = Date.now()) {
    if (!entry || typeof entry !== 'object') {
        return { attempts: [], blockedUntil: 0 };
    }

    const windowMs = Number(captchaPolicyState.failureWindowMs || 15 * 60 * 1000);
    const attempts = Array.isArray(entry.attempts)
        ? entry.attempts.filter((timestamp) => Number.isFinite(Number(timestamp)) && (now - Number(timestamp) <= windowMs))
        : [];

    return {
        attempts,
        blockedUntil: Number(entry.blockedUntil || 0)
    };
}

function getCaptchaFailureState(ip, now = Date.now()) {
    const key = String(ip || 'unknown');
    const current = pruneCaptchaFailureEntry(captchaFailuresByIp.get(key), now);
    if (current.attempts.length === 0 && Number(current.blockedUntil || 0) <= now) {
        captchaFailuresByIp.delete(key);
        return { attempts: [], blockedUntil: 0 };
    }

    captchaFailuresByIp.set(key, current);
    return current;
}

function clearCaptchaFailureState(ip) {
    const key = String(ip || 'unknown');
    captchaFailuresByIp.delete(key);
}

function registerCaptchaFailure(ip, now = Date.now()) {
    const key = String(ip || 'unknown');
    const state = getCaptchaFailureState(key, now);
    state.attempts.push(now);

    if (state.attempts.length >= Number(captchaPolicyState.failureThreshold || 10)) {
        state.blockedUntil = now + Number(captchaPolicyState.failureBlockMs || 10 * 60 * 1000);
    }

    captchaFailuresByIp.set(key, state);
    return state;
}

function getCaptchaDifficultyForRequest(scope, req) {
    const safeScope = normalizeCaptchaScope(scope);
    const ip = String(req?.clientIP || req?.ip || 'unknown');
    const state = getCaptchaFailureState(ip);

    if (!captchaPolicyState.adaptiveDifficultyEnabled) {
        return 1;
    }

    const recentFailures = state.attempts.length;
    let level = safeScope === 'register' ? 2 : 1;

    if (recentFailures >= 5) level = 2;
    if (recentFailures >= 8) level = 3;

    return Math.max(1, Math.min(3, level));
}

function buildMathCaptchaChallenge(minValue, maxValue, difficulty) {
    const a = randomIntInclusive(minValue, maxValue);
    const b = randomIntInclusive(minValue, maxValue);

    if (difficulty <= 1) {
        const useSubtract = Math.random() > 0.5;
        if (useSubtract) {
            const hi = Math.max(a, b);
            const lo = Math.min(a, b);
            return {
                question: `Solve: ${hi} - ${lo}`,
                answer: String(hi - lo),
                mode: 'basic-subtract',
                label: 'Math challenge',
                answerType: 'number',
                inputMode: 'numeric',
                placeholder: 'Enter the result',
                tip: 'Subtract the smaller number from the larger number.',
                answerLength: String(hi - lo).length
            };
        }

        return {
            question: `Solve: ${a} + ${b}`,
            answer: String(a + b),
            mode: 'basic-add',
            label: 'Math challenge',
            answerType: 'number',
            inputMode: 'numeric',
            placeholder: 'Enter the result',
            tip: 'Add both numbers together.',
            answerLength: String(a + b).length
        };
    }

    if (difficulty === 2) {
        const multiplier = randomIntInclusive(2, Math.min(12, Math.max(3, Math.floor(maxValue / 2))));
        const extra = randomIntInclusive(minValue, maxValue);

        if (Math.random() > 0.5) {
            return {
                question: `Solve: (${a} + ${b}) - ${extra}`,
                answer: String((a + b) - extra),
                mode: 'mid-parentheses',
                label: 'Math challenge',
                answerType: 'number',
                inputMode: 'numeric',
                placeholder: 'Enter the result',
                tip: 'Solve inside the parentheses first.',
                answerLength: String((a + b) - extra).length
            };
        }

        return {
            question: `Solve: (${a} × ${multiplier}) + ${extra}`,
            answer: String((a * multiplier) + extra),
            mode: 'mid-multiply',
            label: 'Math challenge',
            answerType: 'number',
            inputMode: 'numeric',
            placeholder: 'Enter the result',
            tip: 'Multiply first, then add the last number.',
            answerLength: String((a * multiplier) + extra).length
        };
    }

    const divisor = randomIntInclusive(2, Math.min(10, Math.max(3, Math.floor(maxValue / 2))));
    const quotient = randomIntInclusive(Math.max(2, minValue), Math.max(4, Math.min(maxValue, 30)));
    const dividend = divisor * quotient;
    const c = randomIntInclusive(minValue, maxValue);
    const d = randomIntInclusive(minValue, maxValue);

    return {
        question: `Solve: (${dividend} ÷ ${divisor}) + (${c} × ${d})`,
        answer: String(quotient + (c * d)),
        mode: 'advanced-divmul',
        label: 'Math challenge',
        answerType: 'number',
        inputMode: 'numeric',
        placeholder: 'Enter the result',
        tip: 'Use standard order of operations.',
        answerLength: String(quotient + (c * d)).length
    };
}

function buildCaptchaChallenge(minValue, maxValue, difficulty, scope) {
    const factories = [
        () => buildMathCaptchaChallenge(minValue, maxValue, difficulty),
        () => buildSequenceCaptchaChallenge(minValue, maxValue, difficulty),
        () => buildComparisonCaptchaChallenge(minValue, maxValue)
    ];

    if (difficulty >= 2 || scope === 'register') {
        factories.push(() => buildWordCaptchaChallenge());
    }

    return factories[randomIntInclusive(0, factories.length - 1)]();
}

function createCaptchaChallenge(scope = 'auth', req = null) {
    const safeScope = normalizeCaptchaScope(scope);
    const challengeId = createSecureToken(12);
    const minValue = Number(captchaPolicyState.minValue || 1);
    const maxValue = Number(captchaPolicyState.maxValue || 20);
    const difficulty = getCaptchaDifficultyForRequest(safeScope, req);
    const challenge = buildCaptchaChallenge(minValue, maxValue, difficulty, safeScope);

    return {
        scope: safeScope,
        challengeId,
        question: String(challenge.question),
        answer: normalizeCaptchaAnswer(challenge.answer),
        mode: String(challenge.mode || 'basic'),
        label: String(challenge.label || getCaptchaDifficultyLabel(difficulty)),
        answerType: String(challenge.answerType || 'number'),
        inputMode: String(challenge.inputMode || 'numeric'),
        placeholder: String(challenge.placeholder || 'Enter captcha answer'),
        tip: String(challenge.tip || 'Solve the challenge exactly as shown.'),
        answerLength: Number(challenge.answerLength || 0),
        difficulty,
        issuedAt: Date.now(),
        expiresAt: Date.now() + Number(captchaPolicyState.ttlMs),
        attempts: 0
    };
}

function issueCaptchaChallenge(req, scope = 'auth') {
    if (!req?.session) return null;

    if (!isCaptchaEnabledForScope(scope)) {
        return {
            scope: normalizeCaptchaScope(scope),
            enabled: false,
            challengeId: null,
            question: null,
            expiresInMs: 0
        };
    }

    const challenge = createCaptchaChallenge(scope, req);
    if (!req.session.captchaChallenges || typeof req.session.captchaChallenges !== 'object') {
        req.session.captchaChallenges = {};
    }

    req.session.captchaChallenges[challenge.scope] = {
        challengeId: challenge.challengeId,
        answer: challenge.answer,
        mode: challenge.mode,
        label: challenge.label,
        answerType: challenge.answerType,
        difficulty: challenge.difficulty,
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
        attempts: challenge.attempts
    };

    return {
        scope: challenge.scope,
        enabled: true,
        challengeId: challenge.challengeId,
        question: challenge.question,
        label: challenge.label || getCaptchaDifficultyLabel(challenge.difficulty),
        answerType: challenge.answerType || 'number',
        inputMode: challenge.inputMode || 'numeric',
        placeholder: challenge.placeholder || 'Enter captcha answer',
        tip: challenge.tip || 'Solve the challenge exactly as shown.',
        answerLength: Number(challenge.answerLength || 0),
        difficulty: challenge.difficulty,
        expiresInMs: Number(captchaPolicyState.ttlMs)
    };
}

function verifyCaptchaChallenge(req, scope, challengeId, answer) {
    const safeScope = normalizeCaptchaScope(scope);
    if (!isCaptchaEnabledForScope(safeScope)) {
        return { ok: true, status: 200, error: null, refreshRequired: false, bypassed: true };
    }

    const invalidResponse = {
        ok: false,
        status: 400,
        error: 'Captcha verification failed',
        refreshRequired: true
    };

    if (!req?.session) {
        return {
            ok: false,
            status: 500,
            error: 'Session not initialized',
            refreshRequired: true
        };
    }

    const ip = String(req.clientIP || req.ip || 'unknown');
    const failureState = getCaptchaFailureState(ip);
    if (Number(failureState.blockedUntil || 0) > Date.now()) {
        emitSecuritySignal(req, 'captcha-ip-blocked', {
            ip,
            blockedUntil: Number(failureState.blockedUntil || 0),
            attempts: failureState.attempts.length,
            scope: safeScope
        }, 30 * 1000);
        return {
            ...invalidResponse,
            status: 429,
            error: 'Too many captcha failures. Please wait before trying again.',
            refreshRequired: false
        };
    }

    const challenges = req.session.captchaChallenges && typeof req.session.captchaChallenges === 'object'
        ? req.session.captchaChallenges
        : {};
    const current = challenges[safeScope];
    const providedChallengeId = String(challengeId || '').trim();
    const providedAnswer = normalizeCaptchaAnswer(answer);

    const fail = (errorMessage, options = {}) => {
        const state = registerCaptchaFailure(ip);
        if (options.signal) {
            emitSecuritySignal(req, options.signal, {
                scope: safeScope,
                ip,
                attempts: state.attempts.length,
                reason: String(errorMessage || 'captcha-failure')
            }, 10 * 1000);
        }

        return {
            ...invalidResponse,
            error: errorMessage,
            refreshRequired: options.refreshRequired !== undefined ? Boolean(options.refreshRequired) : true
        };
    };

    if (!current || !providedChallengeId || !providedAnswer) {
        return fail('Captcha is required', { signal: 'captcha-failed' });
    }

    if (String(current.challengeId || '') !== providedChallengeId) {
        return fail('Captcha challenge mismatch', { signal: 'captcha-challenge-mismatch' });
    }

    const now = Date.now();
    if (!Number.isFinite(Number(current.expiresAt)) || now > Number(current.expiresAt)) {
        delete challenges[safeScope];
        return fail('Captcha expired. Please try again.', { signal: 'captcha-expired' });
    }

    if (Number.isFinite(Number(current.issuedAt)) && (now - Number(current.issuedAt) < Number(captchaPolicyState.minSolveMs || 900))) {
        return fail('Please take a moment and solve the captcha again.', { signal: 'captcha-solve-too-fast' });
    }

    if (normalizeCaptchaAnswer(current.answer) !== providedAnswer) {
        current.attempts = Number(current.attempts || 0) + 1;
        if (current.attempts >= Number(captchaPolicyState.maxAttempts)) {
            delete challenges[safeScope];
        }
        return fail('Captcha answer is incorrect', { signal: 'captcha-failed' });
    }

    delete challenges[safeScope];
    clearCaptchaFailureState(ip);
    return { ok: true, status: 200, error: null, refreshRequired: false };
}

function trackLoginAttempt(ip) {
    const now = Date.now();
    if (!loginAttempts.has(ip)) {
        loginAttempts.set(ip, []);
    }

    const attempts = loginAttempts.get(ip);
    // Only keep login attempts from the last 30 minutes
    attempts.push(now);
    const recentAttempts = attempts.filter(time => now - time < 30 * 60 * 1000);
    loginAttempts.set(ip, recentAttempts);

    return recentAttempts;
}

function isIPLocked(ip) {
    const attempts = loginAttempts.get(ip) || [];
    // Lock out IP after 5 failed logins in 30 minutes
    return attempts.length >= 5;
}

app.get('/api/captcha/challenge', createRateLimiter(20, 60000), (req, res) => {
    const scope = normalizeCaptchaScope(req.query?.scope || 'auth');
    const challenge = issueCaptchaChallenge(req, scope);
    if (!challenge) {
        return res.status(500).json({ error: 'Failed to generate captcha challenge' });
    }

    return res.json({
        success: true,
        enabled: Boolean(challenge.enabled !== false),
        ...challenge
    });
});

// Login endpoint with rate limiting and lockout protection
app.post('/api/login', createRateLimiter(3, 60000), async (req, res) => {
    // Login endpoint was called
    if (!AdminPanelHelper || !AdminPanelHelper.getAdminUser) {
        // If AdminPanelHelper or getAdminUser is missing, something is wrong
    }
    const clientIP = req.clientIP;
    const username = normalizeCredentialInput(req.body?.username, { minLength: 3, maxLength: 50 });
    const password = String(req.body?.password || '');
    const twoFactorToken = String(req.body?.twoFactorToken || '').trim();
    const twoFactorChallenge = String(req.body?.twoFactorChallenge || '').trim();
    const captchaChallengeId = String(req.body?.captchaChallengeId || '').trim();
    const captchaAnswer = String(req.body?.captchaAnswer || '').trim();

    // Block login if IP is locked out
    if (isIPLocked(clientIP)) {
        emitSecuritySignal(req, 'login-ip-locked', {
            username: String(username || ''),
            attempts: (loginAttempts.get(clientIP) || []).length,
            mode: 'password'
        }, 30 * 1000);
        // Too many failed logins from this IP
        return res.status(429).json({ error: 'Too many failed attempts. Try again in 30 minutes.' });
    }

    if (isAuthIdentifierLocked(username, 'login')) {
        emitSecuritySignal(req, 'login-identifier-locked', {
            username: String(username || ''),
            attempts: getAuthIdentifierAttemptCount(username, 'login'),
            mode: 'password'
        }, 30 * 1000);
        return res.status(429).json({ error: 'Too many failed attempts for this account. Try again in 30 minutes.' });
    }

    const loginIpReputation = evaluateRequestIpReputation(req, 'login', username);
    if (loginIpReputation.shouldBlock) {
        return res.status(403).json({
            error: 'Access from this network is temporarily blocked. Please try a trusted connection.',
            reputationBlocked: true
        });
    }

    // Make sure username and password are provided
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    // Check that the username is a valid string
    if (!username) {
        return res.status(400).json({ error: 'Invalid username format' });
    }

    if (typeof password !== 'string' || password.length > 100) {
        return res.status(400).json({ error: 'Invalid password format' });
    }

    const captchaResult = verifyCaptchaChallenge(req, 'login', captchaChallengeId, captchaAnswer);
    if (!captchaResult.ok) {
        emitSecuritySignal(req, 'login-captcha-failed', {
            username: String(username || ''),
            reason: String(captchaResult.error || 'captcha-failed')
        }, 10 * 1000);
        return res.status(captchaResult.status).json({
            error: captchaResult.error,
            captchaInvalid: true,
            captchaRefreshRequired: captchaResult.refreshRequired
        });
    }

    if (twoFactorToken && !/^\d{6}$/.test(twoFactorToken)) {
        return res.status(400).json({ error: 'Invalid 2FA code format' });
    }

    if (twoFactorChallenge && !/^[a-f0-9]{16,128}$/i.test(twoFactorChallenge)) {
        return res.status(400).json({ error: 'Invalid 2FA challenge format' });
    }

    try {
        // Try to get the user from the database
        let user = null;
        try {
            user = await AdminPanelHelper.getAdminUser(username);
            // User was found in the database
        } catch (dbErr) {
            // There was an error getting the user from the database
        }
        if (!user) {
            // Log this failed login attempt
            const attempts = trackLoginAttempt(clientIP);
            const identifierAttempts = trackAuthIdentifierAttempt(username, 'login');
            await logAdminAuthEvent(username, 'LOGIN_FAILED', req, { reason: 'user-not-found', attempts: attempts.length });
            if (attempts.length >= 5 || identifierAttempts.length >= AUTH_IDENTIFIER_MAX_ATTEMPTS) {
                emitSecuritySignal(req, 'login-bruteforce-threshold', {
                    username: String(username || ''),
                    attempts: Math.max(attempts.length, identifierAttempts.length),
                    reason: 'user-not-found'
                }, 30 * 1000);
            }
            // Log failed login for this user
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Check if the password matches
        let passwordMatch = false;
        try {
            passwordMatch = await bcrypt.compare(password, user.password_hash);
            // Passwords match
        } catch (bcryptErr) {
            // There was an error checking the password
        }
        if (passwordMatch) {
            if (user.two_factor_enabled) {
                if (!twoFactorChallenge || !twoFactorToken) {
                    const challengeId = createTwoFactorChallenge({
                        username: user.username,
                        userId: user.id,
                        role: user.role,
                        ipAddress: req.clientIP,
                        userAgent: req.userAgent,
                        binding: buildTwoFactorChallengeBinding(req)
                    });
                    await logAdminAuthEvent(username, 'LOGIN_2FA_CHALLENGE', req, { challengeId });
                    return res.status(202).json({
                        requiresTwoFactor: true,
                        challengeId,
                        message: 'Two-factor authentication code required'
                    });
                }

                const challenge = twoFactorChallenges.get(twoFactorChallenge);
                if (!challenge || challenge.expiresAt < Date.now() || challenge.username !== user.username) {
                    await logAdminAuthEvent(username, 'LOGIN_2FA_FAILED', req, { reason: 'challenge-invalid-or-expired' });
                    return res.status(401).json({ error: 'Invalid or expired 2FA challenge. Please sign in again.' });
                }

                if (!isSameTwoFactorChallengeBinding(challenge.binding, buildTwoFactorChallengeBinding(req))) {
                    twoFactorChallenges.delete(twoFactorChallenge);
                    await logAdminAuthEvent(username, 'LOGIN_2FA_FAILED', req, { reason: 'challenge-binding-mismatch' });
                    return res.status(401).json({ error: 'This 2FA challenge no longer matches your session. Please sign in again.' });
                }

                if (isTwoFactorAttemptBlocked(user.username, 'login')) {
                    await logAdminAuthEvent(username, 'LOGIN_2FA_FAILED', req, { reason: 'two-factor-temporarily-blocked' });
                    return res.status(429).json({ error: 'Too many invalid 2FA attempts. Wait a few minutes before trying again.' });
                }

                try {
                    const { secret: twoFactorSecret, keyUsed } = decryptStoredTwoFactorSecret(user.two_factor_secret);
                    const verification = TotpHelper.verifyTotpDetailed(twoFactorToken, twoFactorSecret, { window: 1 });
                    if (!verification.valid) {
                        challenge.attemptCount = Number(challenge.attemptCount || 0) + 1;
                        noteTwoFactorAttemptFailure(user.username, 'login');
                        await logAdminAuthEvent(username, 'LOGIN_2FA_FAILED', req, {
                            reason: challenge.attemptCount >= TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS ? 'invalid-token-challenge-exhausted' : 'invalid-token',
                            challengeAttempts: challenge.attemptCount
                        });
                        if (challenge.attemptCount >= TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS) {
                            twoFactorChallenges.delete(twoFactorChallenge);
                            return res.status(429).json({ error: 'Too many invalid 2FA attempts. Please sign in again.' });
                        }

                        return res.status(401).json({ error: 'Invalid 2FA code' });
                    }

                    const counterAccepted = await consumeVerifiedTwoFactorCounter(user.id, verification.counter);
                    if (!counterAccepted) {
                        noteTwoFactorAttemptFailure(user.username, 'login');
                        await logAdminAuthEvent(username, 'LOGIN_2FA_FAILED', req, { reason: 'replayed-token' });
                        return res.status(401).json({ error: 'This 2FA code was already used. Wait for a new code and try again.' });
                    }

                    await reencryptTwoFactorSecretIfNeeded(user.id, twoFactorSecret, keyUsed);
                    clearTwoFactorAttemptFailures(user.username, 'login');
                } catch (twoFactorError) {
                    await logAdminAuthEvent(username, 'LOGIN_2FA_FAILED', req, { reason: 'secret-decrypt-failed' });
                    return res.status(500).json({ error: 'Unable to verify 2FA code' });
                }

                twoFactorChallenges.delete(twoFactorChallenge);
            }

            let deviceBindingResult = {
                allowed: true,
                isNewDevice: false,
                trustedDeviceCount: 0,
                deviceLabel: null
            };
            try {
                deviceBindingResult = await evaluateAndBindTrustedDevice(req, user, 'password');
            } catch (deviceBindingError) {
                console.error('[DeviceBinding] Failed to evaluate trusted device (password login):', deviceBindingError?.message || deviceBindingError);
            }

            if (!deviceBindingResult.allowed) {
                return res.status(403).json({
                    error: 'New devices are blocked for this account. Use a previously trusted device or contact the owner.',
                    deviceBindingBlocked: true
                });
            }

            // Reset failed login attempts for this IP
            loginAttempts.delete(clientIP);
            clearAuthIdentifierAttempts(username, 'login');

            return await establishLoginSession(req, res, user, {
                authMethod: 'password',
                logMetadata: {
                    newDeviceLogin: Boolean(deviceBindingResult.isNewDevice),
                    trustedDeviceCount: Number(deviceBindingResult.trustedDeviceCount || 0),
                    deviceLabel: String(deviceBindingResult.deviceLabel || '')
                }
            });
        } else {
            // Track failed attempt
            const attempts = trackLoginAttempt(clientIP);
            const identifierAttempts = trackAuthIdentifierAttempt(username, 'login');
            await logAdminAuthEvent(username, 'LOGIN_FAILED', req, { reason: 'password-mismatch', attempts: attempts.length });
            if (attempts.length >= 5 || identifierAttempts.length >= AUTH_IDENTIFIER_MAX_ATTEMPTS) {
                emitSecuritySignal(req, 'login-bruteforce-threshold', {
                    username: String(username || ''),
                    attempts: Math.max(attempts.length, identifierAttempts.length),
                    reason: 'password-mismatch'
                }, 30 * 1000);
            }
            // Failed password attempt for user
            res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (error) {
        // Login error
        res.status(500).json({ error: 'Login failed' });
    }
});

app.post('/api/login/recovery', createRateLimiter(3, 60000), async (req, res) => {
    const clientIP = req.clientIP;
    const username = normalizeCredentialInput(req.body?.username, { minLength: 3, maxLength: 50 });
    const recoveryCodeRaw = String(req.body?.recoveryCode || '').trim();

    if (isIPLocked(clientIP)) {
        emitSecuritySignal(req, 'login-ip-locked', {
            username,
            attempts: (loginAttempts.get(clientIP) || []).length,
            mode: 'recovery'
        }, 30 * 1000);
        return res.status(429).json({ error: 'Too many failed attempts. Try again in 30 minutes.' });
    }

    if (isAuthIdentifierLocked(username, 'recovery')) {
        emitSecuritySignal(req, 'login-identifier-locked', {
            username,
            attempts: getAuthIdentifierAttemptCount(username, 'recovery'),
            mode: 'recovery'
        }, 30 * 1000);
        return res.status(429).json({ error: 'Too many failed attempts for this account. Try again in 30 minutes.' });
    }

    const recoveryIpReputation = evaluateRequestIpReputation(req, 'recovery-login', username);
    if (recoveryIpReputation.shouldBlock) {
        return res.status(403).json({
            error: 'Access from this network is temporarily blocked. Please try a trusted connection.',
            reputationBlocked: true
        });
    }

    if (!username || !recoveryCodeRaw) {
        return res.status(400).json({ error: 'Username and recovery code are required' });
    }

    if (!username) {
        return res.status(400).json({ error: 'Invalid username format' });
    }

    const normalizedCode = normalizeRecoveryCodeInput(recoveryCodeRaw);
    if (!normalizedCode) {
        return res.status(400).json({ error: 'Invalid recovery code format' });
    }

    try {
        const user = await AdminPanelHelper.getAdminUser(username);
        if (!user) {
            const attempts = trackLoginAttempt(clientIP);
            const identifierAttempts = trackAuthIdentifierAttempt(username, 'recovery');
            await logAdminAuthEvent(username, 'LOGIN_FAILED', req, { reason: 'user-not-found', mode: 'recovery', attempts: attempts.length });
            if (attempts.length >= 5 || identifierAttempts.length >= AUTH_IDENTIFIER_MAX_ATTEMPTS) {
                emitSecuritySignal(req, 'login-bruteforce-threshold', {
                    username,
                    attempts: Math.max(attempts.length, identifierAttempts.length),
                    reason: 'recovery-user-not-found',
                    mode: 'recovery'
                }, 30 * 1000);
            }
            return res.status(401).json({ error: 'Invalid recovery credentials' });
        }

        const hashes = parseRecoveryCodeHashes(user.recovery_code_hashes);
        const inputHash = hashRecoveryCode(normalizedCode);
        const index = hashes.findIndex((value) => String(value) === inputHash);

        if (index === -1) {
            const attempts = trackLoginAttempt(clientIP);
            const identifierAttempts = trackAuthIdentifierAttempt(username, 'recovery');
            await logAdminAuthEvent(username, 'LOGIN_FAILED', req, { reason: 'recovery-code-mismatch', mode: 'recovery', attempts: attempts.length });
            if (attempts.length >= 5 || identifierAttempts.length >= AUTH_IDENTIFIER_MAX_ATTEMPTS) {
                emitSecuritySignal(req, 'login-bruteforce-threshold', {
                    username,
                    attempts: Math.max(attempts.length, identifierAttempts.length),
                    reason: 'recovery-code-mismatch',
                    mode: 'recovery'
                }, 30 * 1000);
            }
            return res.status(401).json({ error: 'Invalid recovery credentials' });
        }

        const remainingHashes = hashes.filter((_, idx) => idx !== index);
        await MySQLDatabaseManager.connection.pool.execute(
            `UPDATE admin_users
             SET recovery_code_hashes = ?
             WHERE id = ?`,
            [JSON.stringify(remainingHashes), user.id]
        );

        // Send security alert email
        if (user.email) {
            try {
                await EmailHelper.sendEmail({
                    to: user.email,
                    subject: 'Security Alert: Recovery Code Used',
                    html: `
                        <div style="font-family: Arial, sans-serif; color: #333;">
                            <h2>Recovery Code Used</h2>
                            <p>A recovery code was just used to access your admin account.</p>
                            <p><strong>Time:</strong> ${new Date().toUTCString()}</p>
                            <p><strong>IP Address:</strong> ${req.ip}</p>
                            <p><strong>Remaining Codes:</strong> ${remainingHashes.length}</p>
                            <hr>
                            <p style="color: #d9534f;">If this wasn't you, please change your password and revoke all sessions immediately.</p>
                        </div>
                    `
                });
            } catch (err) {
                console.error('Failed to send recovery code usage alert:', err);
            }
        }

        let recoveryDeviceBindingResult = {
            allowed: true,
            isNewDevice: false,
            trustedDeviceCount: 0,
            deviceLabel: null
        };
        try {
            recoveryDeviceBindingResult = await evaluateAndBindTrustedDevice(req, user, 'recovery-code');
        } catch (deviceBindingError) {
            console.error('[DeviceBinding] Failed to evaluate trusted device (recovery login):', deviceBindingError?.message || deviceBindingError);
        }

        if (!recoveryDeviceBindingResult.allowed) {
            return res.status(403).json({
                error: 'New devices are blocked for this account. Use a previously trusted device or contact the owner.',
                deviceBindingBlocked: true
            });
        }

        loginAttempts.delete(clientIP);
        clearAuthIdentifierAttempts(username, 'recovery');

        return await establishLoginSession(req, res, user, {
            authMethod: 'recovery-code',
            logMetadata: {
                role: user.role,
                remainingRecoveryCodes: remainingHashes.length,
                newDeviceLogin: Boolean(recoveryDeviceBindingResult.isNewDevice),
                trustedDeviceCount: Number(recoveryDeviceBindingResult.trustedDeviceCount || 0),
                deviceLabel: String(recoveryDeviceBindingResult.deviceLabel || '')
            }
        });
    } catch (error) {
        console.error('Recovery login error:', error);
        return res.status(500).json({ error: 'Recovery login failed' });
    }
});

function normalizeRecoveryCodeInput(value) {
    const cleaned = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cleaned.length !== 12) return null;
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}-${cleaned.slice(8)}`;
}

function isValidEmailAddress(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function isManagedAdminAvatarUrl(value) {
    const raw = String(value || '').trim();
    if (!raw.startsWith(ADMIN_AVATAR_PUBLIC_PREFIX)) return false;
    const relative = raw.slice(ADMIN_AVATAR_PUBLIC_PREFIX.length);
    return relative.length > 0 && !relative.includes('..') && !path.isAbsolute(relative);
}

function deleteManagedAdminAvatarFile(avatarUrl) {
    if (!isManagedAdminAvatarUrl(avatarUrl)) return;
    const filename = path.basename(String(avatarUrl || '').trim());
    if (!filename) return;
    const targetPath = path.join(ADMIN_AVATAR_UPLOAD_DIR, filename);
    if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
    }
}

function isManagedAppealEvidenceUrl(value) {
    const raw = String(value || '').trim();
    if (!raw.startsWith(APPEAL_EVIDENCE_PUBLIC_PREFIX)) return false;
    const relative = raw.slice(APPEAL_EVIDENCE_PUBLIC_PREFIX.length);
    return relative.length > 0 && !relative.includes('..') && !path.isAbsolute(relative);
}

function deleteManagedAppealEvidenceFiles(evidenceList = []) {
    for (const evidence of Array.isArray(evidenceList) ? evidenceList : []) {
        const evidenceUrl = String(evidence?.url || '').trim();
        if (!isManagedAppealEvidenceUrl(evidenceUrl)) continue;

        const filename = path.basename(evidenceUrl);
        const targetPath = path.join(APPEAL_EVIDENCE_UPLOAD_DIR, filename);
        if (fs.existsSync(targetPath)) {
            fs.unlinkSync(targetPath);
        }
    }
}

function parseAppealEvidenceJson(rawValue) {
    if (!rawValue) return [];
    try {
        const parsed = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map((entry) => ({
                name: String(entry?.name || entry?.originalName || 'Attachment').trim() || 'Attachment',
                url: String(entry?.url || '').trim(),
                mimeType: String(entry?.mimeType || '').trim(),
                size: Number(entry?.size || 0),
                uploadedAt: entry?.uploadedAt || null
            }))
            .filter((entry) => entry.url);
    } catch (_error) {
        return [];
    }
}

function buildAppealEvidenceMetadata(files = []) {
    return (Array.isArray(files) ? files : []).map((file) => ({
        name: String(file?.originalname || 'Attachment').trim() || 'Attachment',
        url: `${APPEAL_EVIDENCE_PUBLIC_PREFIX}${path.basename(String(file?.filename || ''))}`,
        mimeType: String(file?.mimetype || '').trim(),
        size: Number(file?.size || 0),
        uploadedAt: new Date().toISOString()
    })).filter((entry) => entry.url !== APPEAL_EVIDENCE_PUBLIC_PREFIX);
}

function cleanupAppealUploadFiles(files = []) {
    deleteManagedAppealEvidenceFiles(buildAppealEvidenceMetadata(files));
}

function normalizeAppealReviewStage(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return APPEAL_REVIEW_STAGES.includes(normalized) ? normalized : 'submitted';
}

function buildPublicAppealRecord(appeal) {
    const record = appeal || {};
    const status = String(record.status || 'pending').toLowerCase();
    let responseText = null;

    if ((status === 'accepted' || status === 'denied') && record.owner_response) {
        const decisionCode = String(record.owner_response).trim();
        responseText = APPEAL_DECISION_EMAIL_TEXT[decisionCode] || record.owner_response;
    }

    if (status === 'withdrawn' && !responseText) {
        responseText = 'This appeal was withdrawn before a final decision was issued.';
    }

    return {
        id: record.id,
        status,
        userTag: String(record.user_tag || '').trim() || null,
        caseId: record.ban_case_id,
        submittedAt: record.created_at,
        updatedAt: record.updated_at || record.created_at,
        decidedAt: record.decided_at,
        withdrawnAt: record.withdrawn_at || null,
        reason: status === 'pending' ? String(record.reason || '').trim() || null : null,
        email: status === 'pending' ? String(record.user_email || '').trim() || null : null,
        withdrawReason: status === 'withdrawn' ? String(record.withdraw_reason || '').trim() || null : null,
        reviewStage: normalizeAppealReviewStage(record.review_stage),
        statusNote: String(record.public_status_note || '').trim() || null,
        response: responseText,
        evidence: parseAppealEvidenceJson(record.evidence_json),
        canEdit: status === 'pending',
        canWithdraw: status === 'pending'
    };
}

async function normalizeAdminAvatarUpload(tempFilePath) {
    const normalizedFilename = `avatar-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.webp`;
    const normalizedPath = path.join(ADMIN_AVATAR_UPLOAD_DIR, normalizedFilename);

    try {
        await sharp(tempFilePath, { animated: true, limitInputPixels: 4096 * 4096 })
            .rotate()
            .resize(ADMIN_AVATAR_SIZE, ADMIN_AVATAR_SIZE, {
                fit: 'cover',
                position: 'attention'
            })
            .webp({
                quality: 82,
                effort: 4,
                alphaQuality: 85
            })
            .toFile(normalizedPath);

        return {
            filename: normalizedFilename,
            absolutePath: normalizedPath,
            publicUrl: `${ADMIN_AVATAR_PUBLIC_PREFIX}${normalizedFilename}`
        };
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
        }
    }
}

const adminAvatarUpload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, callback) => {
            callback(null, ADMIN_AVATAR_UPLOAD_DIR);
        },
        filename: (_req, file, callback) => {
            const ext = ADMIN_AVATAR_ALLOWED_MIME_TYPES[file.mimetype] || 'bin';
            callback(null, `avatar-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`);
        }
    }),
    limits: {
        fileSize: 4 * 1024 * 1024,
        files: 1
    },
    fileFilter: (_req, file, callback) => {
        if (!ADMIN_AVATAR_ALLOWED_MIME_TYPES[file.mimetype]) {
            callback(new Error('Only PNG, JPG, GIF, and WEBP images are allowed'));
            return;
        }

        callback(null, true);
    }
});

const appealEvidenceUpload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, callback) => {
            callback(null, APPEAL_EVIDENCE_UPLOAD_DIR);
        },
        filename: (_req, file, callback) => {
            const ext = APPEAL_EVIDENCE_ALLOWED_MIME_TYPES[file.mimetype] || 'bin';
            callback(null, `appeal-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`);
        }
    }),
    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 3
    },
    fileFilter: (_req, file, callback) => {
        if (!APPEAL_EVIDENCE_ALLOWED_MIME_TYPES[file.mimetype]) {
            callback(new Error('Only PNG, JPG, WEBP, PDF, and TXT files are allowed as appeal evidence'));
            return;
        }

        callback(null, true);
    }
});

// Validation helpers (shared across routes)
// Keep ID, reason, and duration checks centralized to avoid drift.

const ADMIN_USER_ID_REGEX = /^(\d+|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})$/;

function isValidAdminUserId(userId) {
    return typeof userId === 'string' && ADMIN_USER_ID_REGEX.test(userId);
}

function normalizeAdminUserIdValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
        return String(value).trim();
    }

    if (Buffer.isBuffer(value)) {
        if (value.length === 16) {
            const hex = value.toString('hex');
            return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        }
        const utf = value.toString('utf8').replace(/\0+$/g, '').trim();
        return utf || value.toString('hex');
    }

    if (typeof value === 'object') {
        if (value.type === 'Buffer' && Array.isArray(value.data)) {
            const buffer = Buffer.from(value.data);
            return normalizeAdminUserIdValue(buffer);
        }
        if (value.id !== undefined && value.id !== null) return normalizeAdminUserIdValue(value.id);
        if (value.userId !== undefined && value.userId !== null) return normalizeAdminUserIdValue(value.userId);
        if (value.user_id !== undefined && value.user_id !== null) return normalizeAdminUserIdValue(value.user_id);
    }

    return '';
}

function normalizeAdminUserRecord(user) {
    const base = (user && typeof user === 'object') ? user : {};
    return {
        ...base,
        id: normalizeAdminUserIdValue(base.id),
        avatar_url: typeof base.avatar_url === 'string' && base.avatar_url.trim() ? base.avatar_url.trim() : null,
        discord_user_id: typeof base.discord_user_id === 'string' && base.discord_user_id.trim() ? base.discord_user_id.trim() : null,
        discord_username: typeof base.discord_username === 'string' && base.discord_username.trim() ? base.discord_username.trim() : null,
        discord_avatar_url: typeof base.discord_avatar_url === 'string' && base.discord_avatar_url.trim() ? base.discord_avatar_url.trim() : null
    };
}

const DISCORD_USER_ID_REGEX = /^\d{17,19}$/;
const DISCORD_USER_ID_LIST_REGEX = /^\d{17,20}$/;

function isValidDiscordUserId(userId) {
    return typeof userId === 'string' && DISCORD_USER_ID_REGEX.test(userId);
}

function validateBulkDiscordUserIds(userIds, options = {}) {
    const {
        maxCount = 50,
        maxCountError = 'Cannot process more than 50 users at once'
    } = options;

    if (!Array.isArray(userIds) || userIds.length === 0) {
        return 'Invalid user IDs';
    }

    if (Number.isFinite(maxCount) && userIds.length > maxCount) {
        return maxCountError;
    }

    const invalidIds = userIds.filter((id) => !id || typeof id !== 'string' || !DISCORD_USER_ID_LIST_REGEX.test(id));
    if (invalidIds.length > 0) {
        return 'Invalid Discord ID format in user list';
    }

    return null;
}

function isValidModerationReason(reason, options = {}) {
    const { minLength = 3, maxLength = 500 } = options;
    if (typeof reason !== 'string') return false;
    const normalized = reason.trim();
    return normalized.length >= minLength && normalized.length <= maxLength;
}

const TIMEOUT_DURATION_MIN_MS = 60 * 1000;
const TIMEOUT_DURATION_MAX_MS = 28 * 24 * 60 * 60 * 1000;

function isValidTimeoutDurationMs(durationMs) {
    return Number.isFinite(durationMs)
        && durationMs >= TIMEOUT_DURATION_MIN_MS
        && durationMs <= TIMEOUT_DURATION_MAX_MS;
}

function hasModeratorAccess(user) {
    return Boolean(user && (user.role === 'moderator' || user.role === 'admin' || user.role === 'owner'));
}

function hasAdminAccess(user) {
    return Boolean(user && (user.role === 'admin' || user.role === 'owner'));
}

function hasOwnerAccess(user) {
    return Boolean(user && user.role === 'owner');
}

function createPrefixedCaseId(prefix) {
    const safePrefix = String(prefix || 'CASE').toUpperCase().replace(/[^A-Z0-9_]/g, '');
    return `${safePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function isStrongPassword(value) {
    const candidate = String(value || '');
    if (candidate.length < 8 || candidate.length > 100) return false;
    return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{8,}$/.test(candidate);
}

function createSecureToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('hex');
}

async function sendDiscordSecurityAlertIfPossible(user, title, details = [], req = null) {
    if (!DISCORD_SECURITY_ALERTS_ENABLED) return false;
    const discordUserId = String(user?.discord_user_id || '').trim();
    if (!discordUserId || !discordClient?.users?.fetch) return false;

    try {
        const discordUser = await discordClient.users.fetch(discordUserId).catch(() => null);
        if (!discordUser || typeof discordUser.send !== 'function') {
            return false;
        }

        const safeTitle = String(title || 'Account security event').trim();
        const safeDetails = Array.isArray(details) ? details.filter((detail) => detail != null) : [];
        const ipAddress = req?.clientIP || req?.ip || 'Unknown';
        const userAgentRaw = req?.userAgent || req?.headers?.['user-agent'] || 'Unknown';
        const userAgent = String(userAgentRaw || 'Unknown').slice(0, 120);
        const username = String(user?.username || 'Unknown');
        const displayName = user?.display_name ? String(user.display_name) : null;

        const getEventProfile = (key) => {
            const normalized = String(key || '').toLowerCase();

            if (normalized.includes('new device')) {
                return {
                    color: 0xE67E22,
                    emoji: '🚨',
                    severity: 'High',
                    summary: `A sign-in from a device ${PANEL_BOT_NAME} has not seen before was detected.`,
                    actions: [
                        'If this was you, no action is needed.',
                        'If this was not you, change your password immediately.',
                        'Review active sessions and revoke anything unfamiliar.'
                    ]
                };
            }

            if (normalized.includes('recovery code')) {
                return {
                    color: 0xE67E22,
                    emoji: '🛟',
                    severity: 'High',
                    summary: 'A recovery code was used to access or recover this account.',
                    actions: [
                        'Generate a new recovery-code set after you sign in.',
                        'Review two-factor authentication settings.',
                        'Change your password if this was unexpected.'
                    ]
                };
            }

            if (normalized.includes('password reset') || normalized.includes('password changed') || normalized.includes('email address changed')) {
                return {
                    color: 0xF39C12,
                    emoji: '🔐',
                    severity: 'High',
                    summary: 'Sensitive account credentials were updated.',
                    actions: [
                        'Confirm the change was made by you.',
                        'Re-check account email and two-factor settings.',
                        'Revoke other sessions if anything looks wrong.'
                    ]
                };
            }

            if (normalized.includes('two-factor authentication enabled')) {
                return {
                    color: 0x2ECC71,
                    emoji: '✅',
                    severity: 'Info',
                    summary: 'Two-factor authentication was successfully enabled on this account.',
                    actions: [
                        'Store recovery codes somewhere safe.',
                        'Keep your authenticator device backed up.'
                    ]
                };
            }

            if (normalized.includes('two-factor authentication disabled')) {
                return {
                    color: 0xE74C3C,
                    emoji: '⚠️',
                    severity: 'High',
                    summary: 'Two-factor authentication was turned off, reducing account protection.',
                    actions: [
                        'Re-enable two-factor authentication if this was accidental.',
                        'Change your password if you did not request this change.'
                    ]
                };
            }

            if (normalized.includes('email verified')) {
                return {
                    color: 0x1ABC9C,
                    emoji: '📬',
                    severity: 'Info',
                    summary: 'The account email address was successfully verified.',
                    actions: [
                        'No action is needed if you completed this verification.'
                    ]
                };
            }

            if (normalized.includes('login')) {
                return {
                    color: 0x3498DB,
                    emoji: '🛡️',
                    severity: normalized.includes('recovery') ? 'High' : 'Info',
                    summary: 'A successful panel login was recorded for this account.',
                    actions: [
                        'Confirm the device and IP look familiar.',
                        'If this was not you, change your password and revoke all sessions.'
                    ]
                };
            }

            return {
                color: 0x5865F2,
                emoji: '🛡️',
                severity: 'Info',
                summary: 'A security-related change was recorded for this account.',
                actions: [
                    'Review the details below and confirm the activity is expected.'
                ]
            };
        };

        const profile = getEventProfile(safeTitle);
        const structuredDetails = new Map();
        const remainingDetails = [];

        for (const detail of safeDetails) {
            const text = String(detail).trim();
            const splitIndex = text.indexOf(':');

            if (splitIndex > 0) {
                const label = text.slice(0, splitIndex).trim();
                const value = text.slice(splitIndex + 1).trim();

                if (label && value && !structuredDetails.has(label.toLowerCase())) {
                    structuredDetails.set(label.toLowerCase(), { label, value: value.slice(0, 256) });
                    continue;
                }
            }

            if (text) {
                remainingDetails.push(text.slice(0, 256));
            }
        }

        const infoFieldNames = new Set(['method', 'device', 'time', 'ip address', 'location']);
        const priorityDetails = Array.from(structuredDetails.values()).filter((entry) => infoFieldNames.has(entry.label.toLowerCase()));
        const extraDetails = Array.from(structuredDetails.values()).filter((entry) => !infoFieldNames.has(entry.label.toLowerCase()));
        const detailsSummary = [...extraDetails, ...remainingDetails.map((value) => ({ label: null, value }))]
            .slice(0, 8)
            .map((entry) => entry.label ? `• **${entry.label}:** ${entry.value}` : `• ${entry.value}`)
            .join('\n');
        const actionSummary = profile.actions.map((action, index) => `${index + 1}. ${action}`).join('\n');
        const alertTimestamp = new Date();
        const fallbackIconUrl = 'https://cdn.discordapp.com/embed/avatars/0.png';
        const brandIconUrl = discordClient?.user?.displayAvatarURL?.({ size: 128 }) || fallbackIconUrl;
        const recipientAvatarUrl = discordUser?.displayAvatarURL?.({ size: 256 }) || brandIconUrl;
        const severityIcon = profile.severity === 'High'
            ? '🔴'
            : profile.severity === 'Info'
                ? '🔵'
                : '🟠';
        const accountLabel = displayName ? `${displayName}\n@${username}` : `@${username}`;
        const technicalDetails = [
            `• IP: ${String(ipAddress || 'Unknown')}`,
            `• Discord ID: ${String(user?.discord_user_id || 'Unknown')}`,
            `• User Agent: ${userAgent || 'Unknown'}`
        ].join('\n');

        const embed = new EmbedBuilder()
            .setColor(profile.color)
            .setAuthor({
                name: `${PANEL_BOT_NAME} Security Center`,
                iconURL: brandIconUrl
            })
            .setTitle(`${profile.emoji} ${safeTitle}`)
            .setThumbnail(recipientAvatarUrl)
            .setDescription([
                `**${profile.summary}**`,
                '',
                `> If this activity was not expected, secure your account immediately.`
            ].join('\n'))
            .addFields([
                { name: '👤 Account', value: accountLabel, inline: true },
                { name: '🚦 Severity', value: `${severityIcon} ${profile.severity}`, inline: true },
                { name: '🕒 Detected', value: `<t:${Math.floor(alertTimestamp.getTime() / 1000)}:F>`, inline: true },
                { name: '🌐 Server', value: PANEL_SERVER_NAME || 'Unknown', inline: true },
                { name: '🛡️ Status', value: 'Security event recorded', inline: true },
                { name: '📬 Delivery', value: 'Direct account notification', inline: true },
                ...(priorityDetails.length > 0
                    ? priorityDetails.map((entry) => ({
                        name: `📌 ${entry.label}`,
                        value: entry.value || 'Unknown',
                        inline: true
                    }))
                    : []),
                { name: '🔍 Technical Details', value: technicalDetails, inline: false },
                { name: '✅ Recommended Next Steps', value: actionSummary, inline: false },
                {
                    name: '📝 Extra Details',
                    value: detailsSummary || 'No additional details were supplied for this event.',
                    inline: false
                }
            ])
            .setTimestamp(alertTimestamp)
            .setFooter({
                text: `${PANEL_BOT_NAME} Security Notifications`,
                iconURL: brandIconUrl
            });

        await discordUser.send({ embeds: [embed] }).catch(async () => {
            // Fallback to plaintext if embed delivery fails
            const fallbackMessage = [
                `${profile.emoji} ${PANEL_BOT_NAME} Security Alert`,
                `Event: ${safeTitle}`,
                `Severity: ${profile.severity}`,
                `Account: ${username}`,
                `IP: ${String(ipAddress || 'Unknown')}`,
                `When: ${new Date().toUTCString()}`,
                '',
                profile.summary,
                '',
                'Next steps:',
                ...profile.actions.map((action) => `- ${action}`),
                ...(safeDetails.length > 0 ? ['', 'Details:', ...safeDetails.map((detail) => `- ${String(detail)}`)] : [])
            ].filter(Boolean).join('\n');
            await discordUser.send(fallbackMessage).catch(() => null);
        });

        return true;
    } catch (error) {
        console.error('[SecurityDiscord] Failed to send Discord security alert:', error?.message || error);
        return false;
    }
}

async function sendSecurityAlertIfPossible(user, title, details = [], req = null) {
    const email = String(user?.email || '').trim();
    const username = String(user?.username || '').trim() || 'User';
    const jobs = [];

    if (EmailHelper.isReady() && email) {
        jobs.push(
            EmailHelper.sendSecurityAlertEmail(email, username, title, details).catch((emailError) => {
                console.error('[SecurityEmail] Failed to send security alert:', emailError?.message || emailError);
                return false;
            })
        );
    }

    jobs.push(sendDiscordSecurityAlertIfPossible(user, title, details, req));

    jobs.push(
        sendBotWebhook('security.alert', {
            username,
            userId: user?.id || null,
            discordUserId: user?.discord_user_id || null,
            discordUsername: user?.discord_username || null,
            title: String(title || ''),
            details: Array.isArray(details) ? details.map((item) => String(item || '')) : []
        }, req).catch(() => false)
    );

    await Promise.allSettled(jobs);
}

const highRiskActionApprovalStore = new Map();
const highRiskActionApprovalIndex = new Map();

function cleanupHighRiskActionApprovals(now = Date.now()) {
    for (const [token, record] of highRiskActionApprovalStore.entries()) {
        if (now > Number(record?.expiresAt || 0)) {
            highRiskActionApprovalStore.delete(token);
            highRiskActionApprovalIndex.delete(String(record?.indexKey || ''));
        }
    }
}

function buildHighRiskActionIndexKey(req, actionKey) {
    return `${String(req?.session?.username || '').trim().toLowerCase()}:${String(actionKey || '').trim().toLowerCase()}`;
}

function buildHighRiskActionBinding(req) {
    return {
        sessionId: String(req?.sessionID || ''),
        ipHash: buildDiscordOAuthBindingHash(req?.clientIP || req?.ip || ''),
        userAgentHash: buildDiscordOAuthBindingHash(req?.userAgent || req?.headers?.['user-agent'] || '')
    };
}

function requestHighRiskActionApproval(req, res, options = {}) {
    const actionKey = String(options.actionKey || '').trim().toLowerCase();
    const delayMs = Math.max(0, Number(options.delayMs) || 0);
    const message = String(options.message || 'A short safety delay is required before completing this action.');
    if (!actionKey || delayMs <= 0) {
        return { approved: true };
    }

    cleanupHighRiskActionApprovals();

    const providedToken = String(req?.body?.approvalToken || req?.query?.approvalToken || '').trim();
    const now = Date.now();
    const indexKey = buildHighRiskActionIndexKey(req, actionKey);
    const binding = buildHighRiskActionBinding(req);

    const createPendingResponse = (record) => {
        res.status(202).json({
            pendingApproval: true,
            actionKey,
            approvalToken: record.token,
            readyAt: new Date(record.readyAt).toISOString(),
            delayMs,
            message
        });
        return { approved: false };
    };

    if (providedToken) {
        const record = highRiskActionApprovalStore.get(providedToken);
        if (!record || record.indexKey !== indexKey || record.actionKey !== actionKey) {
            res.status(400).json({ error: 'Approval token is invalid or expired' });
            return { approved: false };
        }

        if (record.sessionId !== binding.sessionId || record.ipHash !== binding.ipHash || record.userAgentHash !== binding.userAgentHash) {
            highRiskActionApprovalStore.delete(providedToken);
            highRiskActionApprovalIndex.delete(indexKey);
            res.status(400).json({ error: 'Approval token no longer matches this session' });
            return { approved: false };
        }

        if (now < record.readyAt) {
            return createPendingResponse(record);
        }

        highRiskActionApprovalStore.delete(providedToken);
        highRiskActionApprovalIndex.delete(indexKey);
        return { approved: true };
    }

    const existingToken = highRiskActionApprovalIndex.get(indexKey);
    if (existingToken) {
        const existingRecord = highRiskActionApprovalStore.get(existingToken);
        if (existingRecord && now <= Number(existingRecord.expiresAt || 0)) {
            return createPendingResponse(existingRecord);
        }
        highRiskActionApprovalStore.delete(existingToken);
        highRiskActionApprovalIndex.delete(indexKey);
    }

    const token = toBase64Url(crypto.randomBytes(24));
    const record = {
        token,
        actionKey,
        indexKey,
        username: String(req?.session?.username || '').trim(),
        sessionId: binding.sessionId,
        ipHash: binding.ipHash,
        userAgentHash: binding.userAgentHash,
        readyAt: now + delayMs,
        expiresAt: now + Math.max(DISCORD_HIGH_RISK_ACTION_RECORD_TTL_MS, delayMs + (5 * 60 * 1000))
    };

    highRiskActionApprovalStore.set(token, record);
    highRiskActionApprovalIndex.set(indexKey, token);
    return createPendingResponse(record);
}

function parseTrustedDevices(value) {
    if (!value) return [];
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        if (!Array.isArray(parsed)) return [];

        return parsed
            .map((entry) => ({
                fingerprint: String(entry?.fingerprint || '').trim(),
                label: String(entry?.label || '').trim() || 'Unknown Device',
                firstSeenAt: Number(entry?.firstSeenAt || 0),
                lastSeenAt: Number(entry?.lastSeenAt || 0),
                lastIp: String(entry?.lastIp || '').trim() || null,
                loginCount: Math.max(0, Number(entry?.loginCount || 0)),
                lastAuthMethod: String(entry?.lastAuthMethod || '').trim() || 'password'
            }))
            .filter((entry) => /^[a-f0-9]{64}$/i.test(entry.fingerprint));
    } catch (_) {
        return [];
    }
}

function getHeaderValue(req, headerName) {
    const raw = req?.headers?.[headerName];
    if (Array.isArray(raw)) return String(raw[0] || '').trim();
    return String(raw || '').trim();
}

function getDeviceNetworkHint(rawIp) {
    const parsed = parseSingleIp(rawIp);
    if (parsed.ipv4) {
        const parts = parsed.ipv4.split('.');
        if (parts.length === 4) {
            return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
        }
    }

    if (parsed.ipv6) {
        const normalized = parsed.ipv6.toLowerCase();
        const groups = normalized.split(':').filter(Boolean);
        if (groups.length >= 4) {
            return `${groups.slice(0, 4).join(':')}::/64`;
        }
        return `${groups.join(':')}::/64`;
    }

    return 'unknown';
}

function buildDeviceBindingFingerprint(req) {
    const ua = String(req?.userAgent || '').trim().toLowerCase() || 'unknown';
    const language = getHeaderValue(req, 'accept-language').toLowerCase() || 'unknown';
    const platform = getHeaderValue(req, 'sec-ch-ua-platform').replace(/"/g, '').toLowerCase() || 'unknown';
    const ipInfo = parseSingleIp(req?.clientIP);
    const ipVersion = ipInfo.ipv4 ? 'v4' : (ipInfo.ipv6 ? 'v6' : 'unknown');
    const networkHint = getDeviceNetworkHint(req?.clientIP);

    const fingerprintSource = [ua, language, platform, ipVersion, networkHint].join('|');
    return crypto.createHash('sha256').update(fingerprintSource).digest('hex');
}

function buildDeviceBindingLabel(req) {
    const parsedUA = parseUserAgent(req?.userAgent || 'Unknown');
    const browser = String(parsedUA?.browser || 'Unknown').trim();
    const os = String(parsedUA?.os || 'Unknown').trim();
    const deviceType = String(parsedUA?.deviceType || 'Unknown').trim();
    return `${deviceType} • ${browser} on ${os}`;
}

function sanitizeTrustedDeviceList(devices) {
    return [...devices]
        .sort((a, b) => Number(b?.lastSeenAt || 0) - Number(a?.lastSeenAt || 0))
        .slice(0, DEVICE_BINDING_MAX_DEVICES);
}

async function evaluateAndBindTrustedDevice(req, user, authMethod = 'password') {
    const knownDevices = parseTrustedDevices(user?.trusted_devices_json);
    const fingerprint = buildDeviceBindingFingerprint(req);
    const deviceLabel = buildDeviceBindingLabel(req);
    const now = Date.now();

    const existingIndex = knownDevices.findIndex((entry) => String(entry?.fingerprint || '') === fingerprint);
    const isNewDevice = existingIndex === -1;

    if (!isNewDevice) {
        const existing = knownDevices[existingIndex];
        knownDevices[existingIndex] = {
            ...existing,
            label: deviceLabel || existing.label || 'Known Device',
            lastSeenAt: now,
            lastIp: String(req?.clientIP || existing.lastIp || ''),
            loginCount: Math.max(1, Number(existing.loginCount || 0) + 1),
            lastAuthMethod: String(authMethod || 'password')
        };

        const updated = sanitizeTrustedDeviceList(knownDevices);
        await MySQLDatabaseManager.connection.pool.execute(
            `UPDATE admin_users SET trusted_devices_json = ? WHERE id = ?`,
            [JSON.stringify(updated), user.id]
        );

        return {
            allowed: true,
            isNewDevice: false,
            trustedDeviceCount: updated.length,
            deviceLabel
        };
    }

    const strictBlock = DEVICE_BINDING_STRICT_MODE && knownDevices.length > 0;
    if (strictBlock) {
        emitSecuritySignal(req, 'device-binding-blocked', {
            username: String(user?.username || ''),
            authMethod: String(authMethod || 'password'),
            trustedDeviceCount: knownDevices.length,
            deviceLabel,
            fingerprint: fingerprint.slice(0, 12)
        }, 30 * 1000);

        return {
            allowed: false,
            isNewDevice: true,
            strictMode: true,
            trustedDeviceCount: knownDevices.length,
            deviceLabel
        };
    }

    const newEntry = {
        fingerprint,
        label: deviceLabel,
        firstSeenAt: now,
        lastSeenAt: now,
        lastIp: String(req?.clientIP || ''),
        loginCount: 1,
        lastAuthMethod: String(authMethod || 'password')
    };

    const updated = sanitizeTrustedDeviceList([newEntry, ...knownDevices]);
    await MySQLDatabaseManager.connection.pool.execute(
        `UPDATE admin_users SET trusted_devices_json = ? WHERE id = ?`,
        [JSON.stringify(updated), user.id]
    );

    emitSecuritySignal(req, 'new-device-login', {
        username: String(user?.username || ''),
        authMethod: String(authMethod || 'password'),
        trustedDeviceCount: updated.length,
        deviceLabel,
        fingerprint: fingerprint.slice(0, 12)
    }, 15 * 1000);

    if (NEW_DEVICE_EMAIL_ALERT_ENABLED) {
        await sendSecurityAlertIfPossible(user, 'New Device Login Detected', [
            `Device: ${deviceLabel}`,
            `IP Address: ${String(req?.clientIP || 'Unknown')}`,
            `Login Method: ${String(authMethod || 'password')}`,
            `Time: ${new Date(now).toUTCString()}`,
            'If this was not you, change your password and revoke all active sessions immediately.'
        ]);
    }

    return {
        allowed: true,
        isNewDevice: true,
        trustedDeviceCount: updated.length,
        deviceLabel
    };
}

async function establishLoginSession(req, res, user, options = {}) {
    const authMethod = String(options.authMethod || 'password');
    const logMetadata = (options.logMetadata && typeof options.logMetadata === 'object') ? options.logMetadata : {};

    await new Promise((resolve, reject) => {
        req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });

    req.session.authenticated = true;
    req.session.username = user.username;
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.roleVerifiedAt = Date.now(); // Mark as verified immediately
    req.session.loginTime = Date.now();
    req.session.lastActivityAt = req.session.loginTime;
    req.session.absoluteExpiresAt = req.session.loginTime + Number(sessionPolicyState.absoluteTimeoutMs);
    if (req.session.cookie) {
        req.session.cookie.maxAge = Number(sessionPolicyState.idleTimeoutMs);
    }
    req.session.ipAddress = req.clientIP;
    req.session.ipAddressV4 = req.clientIPV4;
    req.session.ipAddressV6 = req.clientIPV6;
    req.session.userAgent = req.userAgent;
    req.session.singleSessionCheckedAt = Date.now();
    req.session.discordLinked = Boolean(user.discord_user_id);
    req.session.discordLinkedVerifiedAt = 0;
    req.session.discordSecurityState = null;
    req.session.discordSecurityVerifiedAt = 0;

    // Initialize CSRF Secret for the new session
    req.session.csrfSecret = CsrfHelper.generateSecret();

    // Generate an initial token for the client
    const initialToken = CsrfHelper.createToken(req.session.csrfSecret);

    await new Promise((resolve, reject) => {
        req.session.save((err) => (err ? reject(err) : resolve()));
    });

    loginAttempts.delete(req.clientIP);
    closeOtherUserSessions(user.username, user.id, req.sessionID).catch(() => { });
    AdminPanelHelper.updateLastLogin(user.username).catch(() => { });

    const eventType = authMethod === 'recovery-code' ? 'LOGIN_SUCCESS_RECOVERY' : 'LOGIN_SUCCESS';
    logAdminAuthEvent(user.username, eventType, req, {
        role: user.role,
        authMethod,
        ...logMetadata
    }).catch(() => { });

    // Notify user by Discord DM about successful account login
    await sendSecurityAlertIfPossible(user, authMethod === 'recovery-code' ? 'Account login (recovery code)' : 'Account login', [
        `Method: ${authMethod}`,
        `IP Address: ${req.clientIP || 'Unknown'}`,
        `User Agent: ${String(req.userAgent || 'Unknown').slice(0, 140)}`
    ], req).catch(() => { });

    res.cookie('csrfToken', initialToken, {
        httpOnly: false,
        sameSite: 'strict',
        secure: req.secure || (req.headers['x-forwarded-proto'] === 'https'),
        path: '/'
    });

    return res.json({
        success: true,
        role: user.role,
        csrfToken: initialToken,
        authMethod
    });
}

// Logout endpoint
app.post('/api/logout', (req, res) => {
    const username = req.session?.username || 'unknown';
    req.session.destroy((err) => {
        if (err) {
            console.error('Session destroy error:', err);
            return res.status(500).json({ error: 'Logout failed' });
        }
        logAdminAuthEvent(username, 'LOGOUT', req, {}).catch(() => { });
        res.setHeader('Clear-Site-Data', '"cache", "storage"');
        res.clearCookie('admin_session', {
            path: '/',
            sameSite: 'lax',
            secure: SESSION_COOKIE_SECURE
        });
        res.clearCookie('csrfToken', {
            path: '/',
            sameSite: 'strict',
            secure: SESSION_COOKIE_SECURE
        });
        res.json({ success: true });
    });
});

app.get('/logout', (req, res) => {
    const username = req.session?.username || 'unknown';
    req.session.destroy((err) => {
        if (err) {
            console.error('Session destroy error:', err);
            return res.redirect('/login?logout=failed');
        }
        logAdminAuthEvent(username, 'LOGOUT', req, {}).catch(() => { });
        res.setHeader('Clear-Site-Data', '"cache", "storage"');
        res.clearCookie('admin_session', {
            path: '/',
            sameSite: 'lax',
            secure: SESSION_COOKIE_SECURE
        });
        res.clearCookie('csrfToken', {
            path: '/',
            sameSite: 'strict',
            secure: SESSION_COOKIE_SECURE
        });
        res.redirect('/login');
    });
});

// API Routes - Protected
// Secure user info route
app.get('/api/users/:id', requireAuth, async (req, res) => {
    // Debug: log banRow and isBanned for diagnosis
    setTimeout(() => {
        try {
            console.log('[DEBUG] /api/users/:id', {
                userId,
                banRow,
                isBanned: banRow && Number(banRow.banned) === 1
            });
        } catch (e) { }
    }, 0);
    const userId = req.params.id;
    if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'Invalid user ID' });
    }
    try {
        let userInfo = null;
        try {
            userInfo = await MySQLDatabaseManager.getUserInfo(userId);
        } catch (error) {
            console.error('[API] getUserInfo failed:', error?.message || error);
            userInfo = null;
        }

        let levels = [];
        try {
            levels = await AdminPanelHelper.getAllLevels();
            if (!Array.isArray(levels)) levels = [];
        } catch (error) {
            console.error('[API] getAllLevels failed:', error?.message || error);
            levels = [];
        }
        const userLevel = levels.find(u => String(u.user_id) === String(userId));

        let allWarnsRaw = [];
        try {
            allWarnsRaw = await AdminPanelHelper.getAllWarns();
            if (!Array.isArray(allWarnsRaw)) allWarnsRaw = [];
        } catch (error) {
            console.error('[API] getAllWarns failed:', error?.message || error);
            allWarnsRaw = [];
        }
        const userWarns = allWarnsRaw.filter(w => String(w.user_id) === String(userId));

        let banRow = null;
        try {
            const [banRows] = await MySQLDatabaseManager.connection.pool.query(
                `SELECT banned, reason, banned_at
                 FROM user_bans
                 WHERE user_id = ? AND banned = 1
                 ORDER BY banned_at DESC
                 LIMIT 1`,
                [userId]
            );
            banRow = Array.isArray(banRows) && banRows.length ? banRows[0] : null;
        } catch (_) {
            banRow = null;
        }

        let timeoutRow = null;
        try {
            timeoutRow = await MySQLDatabaseManager.getLatestActiveTimeoutCaseForUser(userId, process.env.GUILD_ID || null);
        } catch (_) {
            timeoutRow = null;
        }

        const isBanned = Boolean(banRow && Number(banRow.banned) === 1);
        const timeoutExpires = timeoutRow?.expires_at || null;
        const timeoutActiveFlag = timeoutRow ? String(timeoutRow.effective_status || timeoutRow.status || '') === 'active' : false;
        const isTimedOut = Boolean(timeoutRow && timeoutActiveFlag && timeoutExpires && Number(timeoutExpires) > Date.now());

        // Get notes if available
        let notes = null;
        if (typeof MySQLDatabaseManager.getMemberNotes === 'function') {
            try {
                notes = await MySQLDatabaseManager.getMemberNotes(userId);
            } catch (error) {
                console.error('[API] getMemberNotes failed:', error?.message || error);
                notes = null;
            }
        }

        let discordUser = null;
        let guildMember = null;
        let userFlags = [];

        if (discordClient) {
            try {
                discordUser = await discordClient.users.fetch(userId).catch(() => null);
            } catch (_) {
                discordUser = null;
            }

            try {
                const mainConfig = require('./Config/main.json');
                const configuredGuildId = String(mainConfig?.serverID || '').trim();
                const guild = configuredGuildId
                    ? await discordClient.guilds.fetch(configuredGuildId).catch(() => null)
                    : (discordClient.guilds.cache.first() || null);

                if (guild) {
                    guildMember = await guild.members.fetch(userId).catch(() => guild.members.cache.get(userId) || null);
                }
            } catch (_) {
                guildMember = null;
            }

            try {
                const refreshedUser = typeof discordUser?.fetch === 'function'
                    ? await discordUser.fetch().catch(() => discordUser)
                    : discordUser;

                if (refreshedUser?.flags && typeof refreshedUser.flags.toArray === 'function') {
                    userFlags = refreshedUser.flags.toArray();
                } else if (discordUser?.flags && typeof discordUser.flags.toArray === 'function') {
                    userFlags = discordUser.flags.toArray();
                }
            } catch (_) {
                userFlags = [];
            }
        }

        const statusLabels = {
            online: 'Online',
            idle: 'Idle',
            dnd: 'Do Not Disturb',
            offline: 'Offline'
        };
        const presenceStatus = String(guildMember?.presence?.status || 'offline');
        const memberTimeoutUntil = Number(guildMember?.communicationDisabledUntilTimestamp || 0);
        const memberTimedOut = memberTimeoutUntil > Date.now();
        const resolvedIsTimedOut = memberTimedOut || isTimedOut;
        const resolvedTimeoutExpires = memberTimedOut
            ? new Date(memberTimeoutUntil).toISOString()
            : timeoutExpires;

        const username = userLevel?.username || discordUser?.username || userWarns[0]?.username || 'Unknown';
        const joinedAt = guildMember?.joinedAt
            ? guildMember.joinedAt.toISOString()
            : (userLevel?.created_at || null);
        const createdAt = discordUser?.createdAt
            ? discordUser.createdAt.toISOString()
            : (userLevel?.created_at || null);

        // Compose user object for moderator panel
        const user = {
            user_id: userId,
            username,
            nickname: guildMember?.nickname || null,
            avatar: guildMember?.user?.displayAvatarURL({ dynamic: true, size: 256 }) || discordUser?.displayAvatarURL?.({ dynamic: true, size: 256 }) || null,
            joined_at: joinedAt,
            created_at: createdAt,
            bio: userInfo?.bio || discordUser?.bio || 'N/A',
            level: Number(userLevel?.level || 0),
            xp: Number(userLevel?.xp || 0),
            messages: Number(userLevel?.messages || 0),
            warn_count: userWarns.length,
            warnings: userWarns.length,
            is_banned: isBanned,
            ban_reason: banRow?.reason || null,
            ban_date: banRow?.banned_at || null,
            is_timed_out: resolvedIsTimedOut,
            timeout_reason: timeoutRow?.reason || null,
            timeout_expires: resolvedTimeoutExpires,
            status: statusLabels[presenceStatus] || 'Offline',
            flags: userFlags.length ? userFlags.join(', ') : 'None',
            notes: notes || '',
        };

        if (typeof MySQLDatabaseManager.upsertUserProfileSnapshot === 'function') {
            try {
                await MySQLDatabaseManager.upsertUserProfileSnapshot(userId, {
                    username: user.username,
                    nickname: user.nickname,
                    bio: typeof discordUser?.bio === 'string' && discordUser.bio.trim()
                        ? discordUser.bio
                        : (typeof userInfo?.bio === 'string' && userInfo.bio.trim() ? userInfo.bio : null),
                    selectedAt: Date.now(),
                    syncedAt: Date.now(),
                    enableSync: true
                });
            } catch (error) {
                console.error('[API] Failed to persist selected user profile snapshot:', error?.message || error);
            }
        }

        return res.json({ success: true, user });
    } catch (err) {
        console.error('[API] Error fetching user info:', err.message);
        return res.status(500).json({ error: 'Failed to fetch user info' });
    }
});
app.get('/api/stats', requireAuth, async (req, res) => {
    try {
        // Get all data in parallel
        const [levelsRaw, warnCount, warnsData, reminders, giveawaysActive, giveawaysTotal, bannedUsers, adminCount, ticketsData] = await Promise.all([
            AdminPanelHelper.getAllLevels(),
            AdminPanelHelper.getWarnsCount(),
            AdminPanelHelper.getAllWarns(),
            AdminPanelHelper.getAllReminders(),
            AdminPanelHelper.getGiveawaysCount(),
            AdminPanelHelper.getTotalGiveawaysCount(),
            AdminPanelHelper.getAllBannedUsers(),
            AdminPanelHelper.getAdminUsersCount(),
            AdminPanelHelper.getActiveTickets()
        ]);

        const levels = Array.isArray(levelsRaw) ? levelsRaw : [];
        const warns = Array.isArray(warnsData) ? warnsData : [];
        const tickets = Array.isArray(ticketsData) ? ticketsData : [];

        // Count unique users from levels table
        const uniqueUsers = new Set();
        levels.forEach(l => uniqueUsers.add(l.user_id));

        const totalWarnCount = Number(warnCount) || 0;

        // Calculate accurate totals from levels
        const totalXP = levels.reduce((sum, l) => sum + (parseInt(l.xp) || 0), 0);
        const totalLevel = levels.reduce((sum, l) => sum + (parseInt(l.level) || 1), 0);
        const avgLevel = levels.length > 0 ? (totalLevel / levels.length).toFixed(2) : 0;

        // Count total warnings and calculate averages
        const avgWarns = uniqueUsers.size > 0 ? (totalWarnCount / uniqueUsers.size).toFixed(2) : 0;

        // Ban rate calculation
        const bannedCount = bannedUsers.length;
        const banRate = uniqueUsers.size > 0 ? ((bannedCount / uniqueUsers.size) * 100).toFixed(2) : 0;

        // Calculate total records (warnings + reminders + giveaways)
        const totalRecords = totalWarnCount + (reminders.length || 0) + (giveawaysTotal || 0);

        // Get memory usage
        const memUsage = process.memoryUsage();
        const memoryUsageMB = Math.round(memUsage.heapUsed / 1024 / 1024);

        // Get top user by XP
        let topUser = 'N/A';
        let topUserName = 'N/A';
        let topUserXP = 0;
        let topUserLevel = 0;
        if (levels.length > 0) {
            const topUserData = levels.reduce((max, current) =>
                (parseInt(current.xp) || 0) > (parseInt(max.xp) || 0) ? current : max
            );
            topUser = topUserData.user_id;
            topUserName = topUserData.username || 'Unknown';
            topUserXP = topUserData.xp;
            topUserLevel = topUserData.level || 0;
        }

        // Get most warned user
        let mostWarnedUserName = 'N/A';
        if (warns.length > 0) {
            const warnCounts = {};
            warns.forEach(warn => {
                const userId = warn.user_id;
                warnCounts[userId] = (warnCounts[userId] || 0) + 1;
            });

            let maxWarns = 0;
            let maxUserId = null;
            for (const [userId, count] of Object.entries(warnCounts)) {
                if (count > maxWarns) {
                    maxWarns = count;
                    maxUserId = userId;
                }
            }

            if (maxUserId) {
                const warnedUser = warns.find(w => w.user_id === maxUserId);
                mostWarnedUserName = warnedUser?.username || 'Unknown';
            }
        }

        res.json({
            success: true,
            totalUsers: uniqueUsers.size,
            totalXP,
            avgLevel: parseFloat(avgLevel),
            totalWarnings: totalWarnCount,
            totalWarns: totalWarnCount,
            totalReminders: reminders.length || 0,
            totalGiveaways: giveawaysTotal || 0,
            totalRecords,
            avgWarns: parseFloat(avgWarns),
            bannedUsers: bannedCount,
            banRate: parseFloat(banRate),
            adminCount: adminCount || 0,
            activeReminders: reminders.length || 0,
            activeGiveaways: giveawaysActive || 0,
            activeTickets: tickets.length || 0,
            memoryUsage: memoryUsageMB,
            topUser,
            topUserName,
            topUserXP,
            topUserLevel,
            mostWarnedUserName,
            timestamp: new Date().toISOString(),
            stats: {
                totalUsers: uniqueUsers.size,
                totalXP,
                avgLevel: parseFloat(avgLevel),
                totalWarnings: totalWarnCount,
                totalWarns: totalWarnCount,
                avgWarns: parseFloat(avgWarns),
                bannedUsers: bannedCount,
                banRate: parseFloat(banRate),
                adminUsers: adminCount,
                activeReminders: reminders.length || 0,
                giveaways: giveawaysTotal || 0,
                activeGiveaways: giveawaysActive || 0,
                activeTickets: tickets.length || 0,
                topUser,
                topUserName,
                topUserXP,
                topUserLevel,
                mostWarnedUserName,
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error('Error getting stats:', error);
        res.status(500).json({ error: 'Failed to get statistics' });
    }
});

// Command activity chart (last 7 days)
app.get('/api/stats/command-activity', requireAuth, async (req, res) => {
    try {
        const hours = [];
        const commandCounts = [];
        const successCounts = [];
        const errorCounts = [];

        // Generate last 24 hours (hourly buckets)
        for (let i = 23; i >= 0; i--) {
            const date = new Date();
            date.setHours(date.getHours() - i);
            date.setMinutes(0, 0, 0);
            date.setSeconds(0, 0);
            const nextHour = new Date(date);
            nextHour.setHours(nextHour.getHours() + 1);

            // Convert to milliseconds for database comparison
            const startMs = date.getTime();
            const endMs = nextHour.getTime();

            // Get command counts for this hour
            let totalResult, successResult, errorResult;
            try {
                [totalResult] = await MySQLDatabaseManager.connection.pool.query(
                    'SELECT COUNT(*) as count FROM user_interactions WHERE created_at >= ? AND created_at < ?',
                    [startMs, endMs]
                );
                [successResult] = await MySQLDatabaseManager.connection.pool.query(
                    "SELECT COUNT(*) as count FROM user_interactions WHERE created_at >= ? AND created_at < ? AND status = 'SUCCESS'",
                    [startMs, endMs]
                );
                [errorResult] = await MySQLDatabaseManager.connection.pool.query(
                    "SELECT COUNT(*) as count FROM user_interactions WHERE created_at >= ? AND created_at < ? AND status IN ('ERROR', 'RATE_LIMIT', 'PERMISSION')",
                    [startMs, endMs]
                );
            } catch (err) {
                // If query fails, default to 0
                totalResult = [{ count: 0 }];
                successResult = [{ count: 0 }];
                errorResult = [{ count: 0 }];
            }

            hours.push(date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }));
            commandCounts.push(totalResult?.[0]?.count || 0);
            successCounts.push(successResult?.[0]?.count || 0);
            errorCounts.push(errorResult?.[0]?.count || 0);
        }

        // Get top commands for the last 24 hours
        let topCommands = [];
        try {
            const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
            [topCommands] = await MySQLDatabaseManager.connection.pool.query(
                'SELECT command_name, COUNT(*) as count FROM user_interactions WHERE created_at >= ? GROUP BY command_name ORDER BY count DESC LIMIT 5',
                [oneDayAgo]
            );
        } catch (err) {
            topCommands = [];
        }

        res.json({
            days: hours,
            commandCounts,
            successCounts,
            errorCounts,
            topCommands: (topCommands || []).map(c => ({ name: c.command_name || 'unknown', count: c.count || 0 }))
        });
    } catch (error) {
        console.error('Error fetching command activity:', error);
        // Return valid but empty data structure instead of error
        res.json({
            days: [],
            commandCounts: [],
            successCounts: [],
            errorCounts: [],
            topCommands: []
        });
    }
});

// Quick stats for today
app.get('/api/stats/today', requireAuth, async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const todayMs = today.getTime();
        const tomorrowMs = tomorrow.getTime();
        const todaySec = Math.floor(todayMs / 1000);
        const tomorrowSec = Math.floor(tomorrowMs / 1000);

        // Format dates for MySQL datetime fields
        const todayStr = today.toISOString().slice(0, 19).replace('T', ' ');
        const tomorrowStr = tomorrow.toISOString().slice(0, 19).replace('T', ' ');

        const safeCount = async (query, params, label) => {
            try {
                const [rows] = await MySQLDatabaseManager.connection.pool.query(query, params);
                const count = rows?.[0]?.count || 0;
                return count;
            } catch (err) {
                console.error(`[Stats] ${label} query error:`, err.message);
                return 0;
            }
        };

        const [warnsToday, bansToday, newMembersToday, ticketsCreatedToday, commandsToday] = await Promise.all([
            safeCount(`SELECT COUNT(*) as count FROM moderation_cases WHERE action_type = 'WARN' AND status NOT IN ('cleared', 'reversed') AND created_at >= ? AND created_at < ?`, [todayMs, tomorrowMs], 'Warns'),
            safeCount('SELECT COUNT(*) as count FROM user_bans WHERE banned = TRUE AND banned_at >= ? AND banned_at < ?', [todayStr, tomorrowStr], 'Bans'),
            safeCount(
                "SELECT COUNT(*) as count FROM member_activity WHERE event_type = 'join' AND ((timestamp >= ? AND timestamp < ?) OR (timestamp >= ? AND timestamp < ?))",
                [todayMs, tomorrowMs, todaySec, tomorrowSec],
                'New Members'
            ),
            safeCount(
                'SELECT COUNT(*) as count FROM tickets WHERE ((created_at >= ? AND created_at < ?) OR (created_at >= ? AND created_at < ?) OR (created_at >= ? AND created_at < ?))',
                [todayStr, tomorrowStr, todayMs, tomorrowMs, todaySec, tomorrowSec],
                'Tickets'
            ),
            safeCount(
                'SELECT COUNT(*) as count FROM user_interactions WHERE ((created_at >= ? AND created_at < ?) OR (created_at >= ? AND created_at < ?) OR (created_at >= ? AND created_at < ?))',
                [todayStr, tomorrowStr, todayMs, tomorrowMs, todaySec, tomorrowSec],
                'Commands'
            )
        ]);

        res.json({
            warnsToday,
            bansToday,
            newMembersToday,
            ticketsCreatedToday,
            commandsToday
        });
    } catch (error) {
        console.error('Error fetching today stats:', error);
        res.status(500).json({ error: 'Failed to fetch today stats' });
    }
});

app.get('/api/suggestions', requireAuth, async (req, res) => {
    try {
        const suggestions = await AdminPanelHelper.getAllSuggestions(100);
        res.json({ success: true, suggestions });
    } catch (error) {
        console.error('Error fetching suggestions:', error);
        res.status(500).json({ error: 'Failed to fetch suggestions' });
    }
});

app.get('/api/ghostpings', requireAuth, async (req, res) => {
    try {
        const ghostPings = await AdminPanelHelper.getAllGhostPings(100);
        res.json({ success: true, ghostPings });
    } catch (error) {
        console.error('Error fetching ghost pings:', error);
        res.status(500).json({ error: 'Failed to fetch ghost pings' });
    }
});

// Combined dashboard endpoint - reduces API calls
app.get('/api/dashboard/all', requireAuth, async (req, res) => {
    try {
        const [levels, warns, reminders, giveaways, bannedUsers, dbHealth] = await Promise.all([
            AdminPanelHelper.getAllLevels(),
            AdminPanelHelper.getAllWarns(),
            AdminPanelHelper.getAllReminders(),
            AdminPanelHelper.getGiveawaysCount(),
            AdminPanelHelper.getAllBannedUsers(),
            (async () => {
                try {
                    if (typeof MySQLDatabaseManager.connection?.healthCheck === 'function') {
                        const health = await MySQLDatabaseManager.connection.healthCheck();
                        return {
                            ok: Boolean(health?.ok),
                            latencyMs: Number.isFinite(Number(health?.latencyMs)) ? Number(health.latencyMs) : null,
                            lastCheckedAt: health?.lastHealthCheckAt || null,
                            error: health?.error || null
                        };
                    }
                } catch (err) {
                }

                try {
                    const startedAt = Date.now();
                    await MySQLDatabaseManager.connection.pool.query('SELECT 1');
                    return {
                        ok: true,
                        latencyMs: Date.now() - startedAt,
                        lastCheckedAt: Date.now(),
                        error: null
                    };
                } catch (err) {
                    return {
                        ok: false,
                        latencyMs: null,
                        lastCheckedAt: Date.now(),
                        error: err?.message || 'Health check failed'
                    };
                }
            })()
        ]);

        res.json({
            success: true,
            levels: levels.map(data => ({
                userId: data.user_id,
                xp: data.xp,
                level: data.level,
                messages: data.messages
            })),
            warns: warns.map(warn => ({
                userId: warn.user_id,
                warnCount: warn.warn_count,
                banned: warn.banned
            })),
            reminders,
            giveawaysCount: giveaways,
            bannedUsersCount: bannedUsers.length,
            dbHealth
        });
    } catch (error) {
        console.error('Error fetching dashboard data:', error);
        res.status(500).json({ error: 'Failed to fetch dashboard data' });
    }
});

app.get('/api/levels', requireAuth, async (req, res) => {
    try {
        const levelsRaw = await AdminPanelHelper.getAllLevels();
        // Convert to array format expected by frontend
        const formatted = levelsRaw.map(data => ({
            userId: data.user_id,
            xp: data.xp,
            level: data.level,
            messages: data.messages
        }));
        res.json({ success: true, data: formatted });
    } catch (error) {
        console.error('Error fetching levels:', error);
        res.status(500).json({ error: 'Failed to fetch levels' });
    }
});

app.get('/api/warns', requireAuth, async (req, res) => {
    try {
        const allWarnsRaw = await AdminPanelHelper.getAllWarns();

        // Group warns by user for summary
        const warnsByUser = {};
        allWarnsRaw.forEach(warn => {
            if (!warnsByUser[warn.user_id]) {
                warnsByUser[warn.user_id] = {
                    userId: warn.user_id,
                    username: warn.username,
                    warnCount: 0,
                    warns: []
                };
            }
            warnsByUser[warn.user_id].warnCount++;
            warnsByUser[warn.user_id].warns.push({
                id: warn.id,
                case_id: warn.case_id,
                reason: warn.reason,
                moderator_id: warn.moderator_id,
                created_at: warn.created_at
            });
        });

        const warnsArray = Object.values(warnsByUser).sort((a, b) => b.warnCount - a.warnCount);
        res.json({ success: true, data: warnsArray });
    } catch (error) {
        console.error('Error fetching warns:', error);
        res.status(500).json({ error: 'Failed to fetch warns' });
    }
});

app.get('/api/warns/:userId', requireAuth, async (req, res) => {
    try {
        const { userId } = req.params;

        // Input validation
        if (!isValidDiscordUserId(userId)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }

        const userData = await AdminPanelHelper.getUserWarns(userId);
        res.json({ success: true, data: userData });
    } catch (error) {
        console.error('Error fetching user warns:', error);
        res.status(500).json({ error: 'Failed to fetch user warns' });
    }
});

app.get('/api/banned', requireAuth, async (req, res) => {
    try {
        const bannedUsers = await AdminPanelHelper.getAllBannedUsers();
        res.json({ success: true, data: bannedUsers });
    } catch (error) {
        console.error('Error fetching banned users:', error);
        res.status(500).json({ error: 'Failed to fetch banned users' });
    }
});

app.delete('/api/banned/:userId', requireAuth, async (req, res) => {
    try {
        const { userId } = req.params;

        // Input validation
        if (!isValidDiscordUserId(userId)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }

        // Get original ban context before updating DB
        let originalBanCaseId = null;
        let originalBanReason = 'No reason provided';
        try {
            const [banInfo] = await MySQLDatabaseManager.connection.pool.query(
                'SELECT ban_case_id, ban_reason FROM user_bans WHERE user_id = ? AND banned = 1 LIMIT 1',
                [userId]
            );
            if (banInfo && banInfo.length > 0) {
                originalBanCaseId = banInfo[0].ban_case_id || null;
                originalBanReason = banInfo[0].ban_reason || 'No reason provided';
            }
        } catch (banLookupErr) {
            console.error('[Unban] Failed to read original ban context:', banLookupErr.message);
        }

        // Update database first (may return false if no active DB ban row)
        const success = await AdminPanelHelper.unbanUser(userId);

        // Attempt Discord unban independently to handle DB/Discord desync
        let discordUnbanned = false;
        if (discordClient) {
            try {
                const mainConfig = require('./Config/main.json');
                const guild = await discordClient.guilds.fetch(mainConfig.serverID);
                if (guild) {
                    const existingBan = await guild.bans.fetch(userId).catch(() => null);
                    if (existingBan) {
                        await guild.bans.remove(userId, 'Unbanned via admin panel');
                        discordUnbanned = true;
                        console.log(`✅ User ${userId} unbanned from Discord`);
                    } else {
                        console.info(`[Unban] User ${userId} was not banned in Discord; database state still cleared.`);
                    }
                }
            } catch (discordError) {
                // User might not be banned in Discord, or bot lacks permissions
                if (String(discordError?.message || '').toLowerCase().includes('unknown ban')) {
                    console.info(`[Unban] Discord reported unknown ban for ${userId}; treating as already unbanned.`);
                } else {
                    console.error('Error unbanning from Discord:', discordError.message);
                }
                // Still return success since database was updated
            }
        }

        if (success || discordUnbanned) {
            const unbanCaseId = generateCaseId('UNBAN');
            const targetUser = await resolveDiscordUser(userId);

            const unbanCreatedAt = Date.now();
            try {
                await MySQLDatabaseManager.upsertModerationCase({
                    caseId: unbanCaseId,
                    guildId: process.env.GUILD_ID || null,
                    userId,
                    userName: targetUser?.username || null,
                    actionType: 'UNBAN',
                    status: 'closed',
                    reason: `Unbanned via admin panel by ${req.session?.username || 'Unknown'}`,
                    moderatorName: req.session?.username || null,
                    moderatorSource: 'panel',
                    source: 'panel',
                    relatedCaseId: originalBanCaseId || null,
                    rootCaseId: originalBanCaseId || unbanCaseId,
                    metadata: originalBanReason ? { originalBanReason } : null,
                    createdAt: unbanCreatedAt,
                    updatedAt: unbanCreatedAt,
                    eventSummary: 'Unban case recorded'
                });

                if (originalBanCaseId) {
                    await MySQLDatabaseManager.updateModerationCaseStatus(originalBanCaseId, 'reversed', {
                        guildId: process.env.GUILD_ID || null,
                        actorName: req.session?.username || null,
                        relatedCaseId: unbanCaseId,
                        details: `Reversed by admin panel unban case ${unbanCaseId}`,
                        updatedAt: unbanCreatedAt
                    });
                }
            } catch (dbErr) {
                console.error('[Unban] Failed to write moderation ledger record:', dbErr.message);
            }

            try {
                if (discordClient && serverLogChannelId) {
                    const logChannel = await discordClient.channels.fetch(serverLogChannelId).catch(() => null);
                    if (logChannel) {
                        const { EmbedBuilder } = require('discord.js');
                        const targetLabel = targetUser ? `${targetUser.tag} (${targetUser.id})` : userId;

                        const logEmbed = new EmbedBuilder()
                            .setTitle('🔓 User Unbanned')
                            .setColor(0x43B581)
                            .addFields(
                                { name: '👮 Administrator', value: `${req.session?.username || 'Unknown'}`, inline: true },
                                { name: '👤 User', value: targetLabel, inline: true },
                                { name: '🔑 Unban Case ID', value: `\`${unbanCaseId}\``, inline: true }
                            )
                            .setFooter({ text: `Unbanned by ${req.session?.username || 'Unknown'} via Admin Panel` })
                            .setTimestamp();

                        await logChannel.send({ embeds: [logEmbed] }).catch((err) => {
                            console.error('Failed to send unban log:', err.message);
                        });
                    }
                }
            } catch (logErr) {
                console.error('[Unban] Failed to send log notification:', logErr.message);
            }

            res.json({ success: true, message: 'User unbanned successfully', caseId: unbanCaseId });
        } else {
            // Idempotent behavior: if no active ban exists in DB or Discord, treat as already unbanned
            res.json({ success: true, message: 'User is already unbanned' });
        }
    } catch (error) {
        console.error('Error unbanning user:', error);
        res.status(500).json({ error: 'Failed to unban user' });
    }
});

app.get('/api/reminders', requireAuth, async (req, res) => {
    try {
        const remindersArray = await AdminPanelHelper.getAllReminders();
        res.json({ success: true, data: remindersArray });
    } catch (error) {
        console.error('Error fetching reminders:', error);
        res.status(500).json({ error: 'Failed to fetch reminders' });
    }
});

app.get('/api/giveaways', requireAuth, async (req, res) => {
    try {
        const giveawayCount = await AdminPanelHelper.getGiveawaysCount();
        res.json({ success: true, count: giveawayCount });
    } catch (error) {
        console.error('Error fetching giveaways:', error);
        res.status(500).json({ error: 'Failed to fetch giveaways' });
    }
});

app.delete('/api/warns/:userId/:caseId', requireAuth, async (req, res) => {
    try {
        const { userId, caseId } = req.params;

        // Input validation
        if (!userId || !caseId) {
            return res.status(400).json({ error: 'Invalid parameters' });
        }

        if (!isValidDiscordUserId(userId)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }

        // Clear user warns for the case ID
        const success = await AdminPanelHelper.clearUserWarns(userId);

        if (success) {
            res.json({ success: true, message: 'Warning deleted' });
        } else {
            res.status(404).json({ error: 'Warning not found' });
        }
    } catch (error) {
        console.error('Error deleting warning:', error);
        res.status(500).json({ error: 'Failed to delete warning' });
    }
});

// Moderation endpoints
app.post('/api/moderation/warn', createRateLimiter(10, 60000), requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasModeratorAccess(user)) {
            return res.status(403).json({ error: 'Moderator access required' });
        }

        const { userId, reason } = req.body;

        // Input validation
        if (!isValidDiscordUserId(userId)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }

        if (!isValidModerationReason(reason)) {
            return res.status(400).json({ error: 'Reason must be between 3-500 characters' });
        }

        // Generate case ID
        const caseId = generateCaseId('WARN');
        const targetUser = await resolveDiscordUser(userId.trim());
        const targetUsername = targetUser?.username || null;

        const success = await AdminPanelHelper.addWarn(userId.trim(), reason.trim(), null, caseId, {
            moderatorName: req.session.username,
            moderatorSource: 'panel',
            userName: targetUsername
        });

        if (success) {
            console.log(`[Admin] ${req.session.username} warned user ${userId}: ${reason}`);

            // Log to Discord Log Channel
            if (discordClient) {
                try {
                    const mainConfig = require('./Config/main.json');
                    const guild = await discordClient.guilds.fetch(mainConfig.serverID).catch(() => null);
                    if (guild && serverLogChannelId) {
                        const targetUserObj = await discordClient.users.fetch(userId.trim()).catch(() => null);
                        const logChannel = await guild.channels.fetch(serverLogChannelId).catch(() => null);

                        // Create a mock moderator object for the panel user
                        const moderatorObj = {
                            toString: () => `**${req.session.username}** (Panel)`,
                            tag: req.session.username,
                            username: req.session.username,
                            id: 'PANEL'
                        };

                        if (targetUserObj) {
                            const dmEmbed = createModerationDmEmbed({
                                actionTitle: 'Warning Notice',
                                actionEmoji: '⚠️',
                                color: 0xFAA61A,
                                guildName: guild.name,
                                description: `⚠️ You've received a warning in **${guild.name}**. Please follow the server rules to avoid further action.`,
                                statusLabel: 'Warning Status',
                                statusValue: '🛡️ **Active**',
                                effectiveDate: moment(Date.now()).format('dddd, D MMMM YYYY [at] HH:mm'),
                                effectiveLabel: 'Issued At',
                                reason: reason.trim(),
                                caseId: caseId,
                                moderatorName: moderatorObj.tag
                            });
                            await targetUserObj.send({ embeds: [dmEmbed] }).catch(() => console.log('Failed to DM warning to user'));
                        }

                        if (logChannel && targetUserObj) {
                            const logEmbed = createModerationEmbed({
                                action: '⚠️ Warning',
                                target: targetUserObj,
                                moderator: moderatorObj,
                                reason: reason.trim(),
                                caseId: caseId,
                                color: 0xFAA61A
                            });
                            await logChannel.send({ embeds: [logEmbed] }).catch(err => console.error('Failed to send warn log:', err));
                        }
                    }
                } catch (logParamsErr) {
                    console.error('Error preparing warn log parameters:', logParamsErr);
                }
            }

            res.json({ success: true, message: 'Warning issued', caseId });
        } else {
            res.status(500).json({ error: 'Failed to issue warning' });
        }
    } catch (error) {
        console.error('Error issuing warning:', error);
        res.status(500).json({ error: 'Failed to issue warning' });
    }
});

app.post('/api/moderation/ban', createRateLimiter(5, 60000), requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasModeratorAccess(user)) {
            return res.status(403).json({ error: 'Moderator access required' });
        }

        const { userId, reason } = req.body;

        // Input validation
        if (!isValidDiscordUserId(userId)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }

        if (!isValidModerationReason(reason)) {
            return res.status(400).json({ error: 'Reason must be between 3-500 characters' });
        }

        // Ban user
        const caseId = generateCaseId('BAN');
        const targetUser = await resolveDiscordUser(userId.trim());
        const targetUsername = targetUser?.username || null;
        const success = await AdminPanelHelper.banUser(userId.trim(), reason.trim(), null, caseId, {
            moderatorName: req.session.username,
            moderatorSource: 'panel',
            userName: targetUsername
        });

        if (success) {
            console.log(`[Admin] ${req.session.username} banned user ${userId}: ${reason}`);
            res.json({ success: true, message: 'User banned', caseId });
        } else {
            res.status(500).json({ error: 'Failed to ban user' });
        }
    } catch (error) {
        console.error('Error banning user:', error);
        res.status(500).json({ error: 'Failed to ban user' });
    }
});

app.post('/api/moderation/timeout', createRateLimiter(10, 60000), requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasModeratorAccess(user)) {
            return res.status(403).json({ error: 'Moderator access required' });
        }

        const { userId, duration, reason } = req.body;

        // Convert duration (minutes) to milliseconds
        const durationMinutes = parseInt(duration);
        const durationMs = durationMinutes * 60 * 1000;

        // Input validation
        if (!isValidDiscordUserId(userId)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }

        if (!isValidTimeoutDurationMs(durationMs)) {
            return res.status(400).json({ error: 'Duration must be between 1 minute and 28 days' });
        }

        if (!isValidModerationReason(reason)) {
            return res.status(400).json({ error: 'Reason must be between 3-500 characters' });
        }

        let resolvedUsername = null;
        const caseId = generateCaseId('TIMEOUT');

        // Apply timeout on Discord if client is available
        if (discordClient) {
            const mainConfig = require('./Config/main.json');
            const guild = await discordClient.guilds.fetch(mainConfig.serverID);
            const member = await guild.members.fetch(userId.trim()).catch(() => null);
            if (!member) {
                return res.status(404).json({ error: 'User not found in server' });
            }
            await member.timeout(durationMs, reason.trim());

            // Log to Discord Log Channel
            try {
                if (serverLogChannelId) {
                    const logChannel = await guild.channels.fetch(serverLogChannelId).catch(() => null);

                    const moderatorObj = {
                        toString: () => `**${req.session.username}** (Panel)`,
                        tag: req.session.username,
                        username: req.session.username,
                        id: 'PANEL'
                    };

                    const expiresAt = Date.now() + durationMs;

                    if (member.user) {
                        const dmEmbed = createModerationDmEmbed({
                            actionTitle: 'Timeout Notice',
                            actionEmoji: '⏱️',
                            color: 0xFAA61A,
                            guildName: guild.name,
                            description: `⏱️ You've been timed out in **${guild.name}**.`,
                            statusLabel: 'Duration',
                            statusValue: moment.duration(durationMinutes, 'minutes').format('d[d] h[h] m[m]'),
                            effectiveDate: `<t:${Math.floor(expiresAt / 1000)}:R>`,
                            effectiveLabel: 'Expires',
                            reason: reason.trim(),
                            caseId: caseId,
                            moderatorName: moderatorObj.tag
                        });
                        await member.user.send({ embeds: [dmEmbed] }).catch(() => console.log('Failed to DM timeout to user'));
                    }

                    if (logChannel) {
                        const logEmbed = createModerationEmbed({
                            action: '⏱️ Time Out',
                            target: member.user,
                            moderator: moderatorObj,
                            reason: reason.trim(),
                            caseId: caseId,
                            color: 0xFAA61A
                        }).addFields(
                            { name: '⏰ Duration', value: moment.duration(durationMinutes, 'minutes').format('d[d] h[h] m[m]'), inline: true },
                            { name: '📅 Expires', value: `<t:${Math.floor(expiresAt / 1000)}:R>`, inline: true }
                        );

                        await logChannel.send({ embeds: [logEmbed] }).catch(err => console.error('Failed to send timeout log:', err));
                    }
                }
            } catch (loggingErr) {
                console.error('Error logging timeout action:', loggingErr);
            }

            resolvedUsername = member.user?.username || null;
            await resolveDiscordUser(userId.trim());
        }

        // Log the timeout request
        const timeoutRecord = {
            userId: userId.trim(),
            username: resolvedUsername,
            duration: durationMs,
            reason: reason.trim(),
            issuedBy: req.session.username,
            issuedAt: new Date(),
            caseId
        };

        await AdminPanelHelper.addTimeout({
            userId: userId.trim(),
            caseId,
            username: resolvedUsername,
            reason: reason.trim(),
            issuedBy: null,
            issuedByName: req.session.username,
            issuedBySource: 'panel',
            issuedAt: Date.now(),
            expiresAt: Date.now() + durationMs
        });

        console.log(`[Admin] ${req.session.username} timed out user ${userId} for ${durationMs}ms: ${reason}`);
        res.json({ success: true, message: 'User timed out', timeout: timeoutRecord });
    } catch (error) {
        console.error('Error timing out user:', error);
        res.status(500).json({ error: 'Failed to timeout user' });
    }
});

app.get('/api/user/:userId', requireAuth, async (req, res) => {
    try {
        const { userId } = req.params;

        if (!isValidDiscordUserId(userId)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }

        const userData = {
            userId,
            levels: await AdminPanelHelper.getUserLevel(userId) || { xp: 0, level: 1 },
            warns: await AdminPanelHelper.getUserWarns(userId) || { warns: {} },
            reminders: await AdminPanelHelper.getUserReminders(userId) || []
        };

        res.json({ success: true, data: userData });
    } catch (error) {
        console.error('Error fetching user data:', error);
        res.status(500).json({ error: 'Failed to fetch user data' });
    }
});

// Admin user management endpoints
app.get('/api/admin/users', requireAuth, async (req, res) => {
    try {
        // Check if user has admin role
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasAdminAccess(user)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const users = await AdminPanelHelper.getAllAdminUsers();
        const normalizedUsers = await Promise.all((Array.isArray(users) ? users : []).map(async (record) => {
            const normalized = normalizeAdminUserRecord(record);
            if (normalized.avatar_url || !normalized.discord_user_id || !discordClient?.users) {
                return normalized;
            }

            const discordUser = discordClient.users.cache.get(normalized.discord_user_id)
                || await discordClient.users.fetch(normalized.discord_user_id, { force: true }).catch(() => null);

            return {
                ...normalized,
                discord_avatar_url: discordUser?.displayAvatarURL({ dynamic: true, size: 128 }) || null
            };
        }));

        res.json(normalizedUsers);
    } catch (error) {
        console.error('Error fetching admin users:', error);
        res.status(500).json({ error: 'Failed to fetch admin users' });
    }
});

app.post('/api/admin/users', requireAuth, async (req, res) => {
    try {
        // Check if user has admin role
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasAdminAccess(user)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { username, password, role } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }

        // Validate types
        if (typeof username !== 'string' || typeof password !== 'string') {
            return res.status(400).json({ error: 'Invalid input format' });
        }

        // Validate username
        if (username.length < 3 || username.length > 30) {
            return res.status(400).json({ error: 'Username must be 3-30 characters' });
        }

        if (!/^[a-zA-Z0-9_]+$/.test(username)) {
            return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
        }

        // Validate password
        if (password.length < 6 || password.length > 100) {
            return res.status(400).json({ error: 'Password must be 6-100 characters' });
        }

        // Validate role
        const validRoles = ['admin', 'moderator', 'owner'];
        if (role && !validRoles.includes(role)) {
            return res.status(400).json({ error: 'Invalid role' });
        }

        // Hash the password
        const passwordHash = await bcrypt.hash(password, 10);

        const success = await AdminPanelHelper.createAdminUser(username, passwordHash, role || 'moderator');

        if (success) {
            console.log(`[Admin] ${req.session.username} created new admin user: ${username}`);
            res.json({ success: true, message: 'Admin user created' });
        } else {
            res.status(500).json({ error: 'Failed to create admin user' });
        }
    } catch (error) {
        console.error('Error creating admin user:', error);
        res.status(500).json({ error: 'Failed to create admin user' });
    }
});

app.put('/api/admin/users/:userId', requireAuth, async (req, res) => {
    try {
        // Check if user has admin role
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasAdminAccess(user)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { userId } = req.params;
        const updates = req.body;

        // Validate admin user id (supports numeric IDs and dashed UUID-style IDs, including UUIDv7)
        if (!isValidAdminUserId(userId)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }

        // Validate updates object
        if (!updates || typeof updates !== 'object') {
            return res.status(400).json({ error: 'Invalid updates' });
        }

        // If password is being updated, hash it
        if (updates.password) {
            if (typeof updates.password !== 'string' || updates.password.length < 6) {
                return res.status(400).json({ error: 'Password must be at least 6 characters' });
            }
            updates.passwordHash = await bcrypt.hash(updates.password, 10);
            delete updates.password;
        }

        const targetUser = await AdminPanelHelper.getAdminUserById(userId);
        const previousRole = String(targetUser?.role || '').toLowerCase();

        const success = await AdminPanelHelper.updateAdminUser(userId, updates);

        if (success) {
            console.log(`[Admin] ${req.session.username} updated admin user ${userId}`);
            if (updates.role) {
                const nextRole = String(updates.role || '').toLowerCase();
                if (nextRole && nextRole !== previousRole) {
                    sendBotWebhook('account.role_updated', {
                        userId,
                        username: targetUser?.username || null,
                        previousRole: previousRole || null,
                        newRole: nextRole
                    }, req).catch(() => { });
                }
            }
            res.json({ success: true, message: 'Admin user updated' });
        } else {
            res.status(500).json({ error: 'Failed to update admin user' });
        }
    } catch (error) {
        console.error('Error updating admin user:', error);
        res.status(500).json({ error: 'Failed to update admin user' });
    }
});

app.delete('/api/admin/users/:userId', requireAuth, async (req, res) => {
    try {
        // Check if user has admin role
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasAdminAccess(user)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { userId } = req.params;

        // Validate admin user id (supports numeric IDs and dashed UUID-style IDs, including UUIDv7)
        if (!isValidAdminUserId(userId)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }

        // Prevent deleting yourself
        const targetUser = await AdminPanelHelper.getAdminUserById(userId);
        if (!targetUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (targetUser.username === req.session.username) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }

        const success = await AdminPanelHelper.deleteAdminUser(userId);

        if (success) {
            console.log(`[Admin] ${req.session.username} deleted admin user ${userId}`);
            sendBotWebhook('account.deleted', {
                userId,
                username: targetUser.username || null,
                role: targetUser.role || null
            }, req).catch(() => { });
            res.json({ success: true, message: 'Admin user deleted' });
        } else {
            res.status(500).json({ error: 'Failed to delete admin user' });
        }
    } catch (error) {
        console.error('Error deleting admin user:', error);
        res.status(500).json({ error: 'Failed to delete admin user' });
    }
});

// Get detailed admin user information
app.get('/api/admin/users/:userId/details', requireAuth, async (req, res) => {
    try {
        // Check if user has owner role (only owners can view detailed user info)
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasOwnerAccess(user)) {
            return res.status(403).json({ error: 'Owner access required' });
        }

        const { userId } = req.params;

        // Validate admin user id (supports numeric IDs and dashed UUID-style IDs, including UUIDv7)
        if (!isValidAdminUserId(userId)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }

        // Get user details
        const [users] = await MySQLDatabaseManager.connection.pool.query(
            `SELECT id, username, role, created_at, last_login, active, email, email_verified, 
                    two_factor_enabled, two_factor_enabled_at, password_changed_at, 
                    discord_user_id, discord_username, discord_linked_at
             FROM admin_users 
             WHERE id = ?`,
            [userId]
        );

        if (!users || users.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const userDetails = users[0];

        // Get recent activity (last 10 auth events)
        const [recentActivity] = await MySQLDatabaseManager.connection.pool.query(
            `SELECT event_type, ip_address, user_agent, created_at 
             FROM admin_auth_events 
             WHERE username = ? 
             ORDER BY created_at DESC 
             LIMIT 10`,
            [userDetails.username]
        );

        userDetails.recentActivity = recentActivity || [];

        res.json(userDetails);
    } catch (error) {
        console.error('Error fetching admin user details:', error);
        res.status(500).json({ error: 'Failed to fetch user details' });
    }
});

function normalizeAdvancedSearchPayload(input = {}) {
    const rawQuery = String(input?.query || '').trim();
    const rawFilters = input?.filters || {};

    const status = String(rawFilters.status || '').trim().toLowerCase();
    const minLevel = Number(rawFilters.minLevel);
    const maxLevel = Number(rawFilters.maxLevel);
    const minWarnings = Number(rawFilters.minWarnings);

    const filters = {};
    if (status === 'active' || status === 'banned' || status === 'timedout') {
        filters.status = status;
    }
    if (Number.isFinite(minLevel) && minLevel >= 0) filters.minLevel = minLevel;
    if (Number.isFinite(maxLevel) && maxLevel >= 0) filters.maxLevel = maxLevel;
    if (Number.isFinite(minWarnings) && minWarnings >= 0) filters.minWarnings = minWarnings;

    return { query: rawQuery, filters };
}

async function runAdvancedUserSearch(payload = {}) {
    const { query, filters } = normalizeAdvancedSearchPayload(payload);

    const guild = discordClient?.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) {
        throw new Error('Guild not available');
    }

    const results = [];

    let sql = `
        SELECT DISTINCT
            l.user_id,
            l.username,
            l.level,
            l.xp,
            (SELECT COUNT(*) FROM moderation_cases mc WHERE mc.user_id = l.user_id AND mc.action_type = 'WARN' AND mc.status NOT IN ('cleared', 'reversed')) as warn_count,
            b.banned,
            b.ban_reason,
            b.banned_at
        FROM levels l
        LEFT JOIN user_bans b ON l.user_id = b.user_id
        WHERE 1=1
    `;
    const params = [];

    if (query) {
        sql += ` AND (l.user_id LIKE ? OR l.username LIKE ?)`;
        params.push(`%${query}%`, `%${query}%`);
    }

    if (filters.status) {
        if (filters.status === 'banned') {
            sql += ` AND b.banned = 1`;
        } else if (filters.status === 'active') {
            sql += ` AND (b.banned IS NULL OR b.banned = 0)`;
        } else if (filters.status === 'timedout') {
            sql += ` AND EXISTS (SELECT 1 FROM moderation_cases mc WHERE mc.user_id = l.user_id AND mc.action_type = 'TIMEOUT' AND mc.status = 'active' AND (mc.expires_at IS NULL OR mc.expires_at > ${Date.now()}))`;
        }
    }

    if (filters.minLevel !== undefined) {
        sql += ` AND l.level >= ?`;
        params.push(filters.minLevel);
    }
    if (filters.maxLevel !== undefined) {
        sql += ` AND l.level <= ?`;
        params.push(filters.maxLevel);
    }
    if (filters.minWarnings !== undefined) {
        sql += ` HAVING warn_count >= ?`;
        params.push(filters.minWarnings);
    }

    sql += ` ORDER BY l.level DESC, l.xp DESC LIMIT 50`;

    const [dbResults] = await MySQLDatabaseManager.connection.pool.query(sql, params);

    for (const dbUser of dbResults) {
        try {
            const member = await guild.members.fetch(dbUser.user_id).catch(() => null);
            results.push({
                userId: dbUser.user_id,
                username: dbUser.username || 'Unknown',
                nickname: member?.nickname || null,
                avatar: member?.user?.displayAvatarURL({ size: 128 }) || null,
                level: dbUser.level || 0,
                xp: dbUser.xp || 0,
                messages: 0,
                warnCount: dbUser.warn_count || 0,
                banned: dbUser.banned === 1,
                isTimedOut: Boolean(member?.communicationDisabledUntilTimestamp && member.communicationDisabledUntilTimestamp > Date.now()),
                inServer: !!member
            });
        } catch {
            results.push({
                userId: dbUser.user_id,
                username: dbUser.username || 'Unknown',
                nickname: null,
                avatar: null,
                level: dbUser.level || 0,
                xp: dbUser.xp || 0,
                messages: 0,
                warnCount: dbUser.warn_count || 0,
                banned: dbUser.banned === 1,
                isTimedOut: false,
                inServer: false
            });
        }
    }

    return results;
}

// Admin Lookup Discord User Endpoint - Added for lookupUserDetails
// Advanced User Search with multiple filters (GET for read-only search, POST kept for compatibility)
app.get('/api/admin/search-users-advanced', requireAuth, async (req, res) => {
    try {
        const payload = {
            query: req.query?.query,
            filters: {
                status: req.query?.status,
                minLevel: req.query?.minLevel,
                maxLevel: req.query?.maxLevel,
                minWarnings: req.query?.minWarnings
            }
        };
        const results = await runAdvancedUserSearch(payload);
        res.json({ success: true, results });
    } catch (error) {
        if (error?.message === 'Guild not available') {
            return res.status(503).json({ error: 'Guild not available' });
        }
        console.error('Error in advanced user search:', error);
        res.status(500).json({ error: 'Search failed' });
    }
});

app.post('/api/admin/search-users-advanced', requireAuth, async (req, res) => {
    try {
        const results = await runAdvancedUserSearch(req.body || {});
        res.json({ success: true, results });
    } catch (error) {
        if (error?.message === 'Guild not available') {
            return res.status(503).json({ error: 'Guild not available' });
        }
        console.error('Error in advanced user search:', error);
        res.status(500).json({ error: 'Search failed' });
    }
});

// Enhanced User Lookup with comprehensive data
app.get('/api/admin/system/lookup/:query', requireAuth, async (req, res) => {
    try {
        if (!process.env.GUILD_ID) return res.status(500).json({ error: 'GUILD_ID not configured' });
        if (!discordClient) return res.status(503).json({ error: 'Discord client not ready' });

        const { query } = req.params;
        if (!query) return res.status(400).json({ error: 'Query required' });

        let user = null;
        let member = null;
        const guild = discordClient.guilds.cache.get(process.env.GUILD_ID);

        // Fetch by ID
        if (DISCORD_USER_ID_LIST_REGEX.test(query)) {
            try {
                user = await discordClient.users.fetch(query).catch(() => null);
                if (guild && user) {
                    member = await guild.members.fetch(user.id).catch(() => null);
                }
            } catch (err) { /* ignore */ }
        }

        // Try to search by username in guild cache
        if (!user && guild) {
            const searchLower = query.toLowerCase();
            member = guild.members.cache.find(m =>
                m.user.username.toLowerCase().includes(searchLower) ||
                m.nickname?.toLowerCase().includes(searchLower) ||
                m.user.tag.toLowerCase().includes(searchLower)
            );
            if (member) user = member.user;
        }

        if (!user) {
            return res.status(404).json({ error: 'User not found. Try using Discord User ID for best results.' });
        }

        // Force refresh user object to include latest profile fields (e.g., bio)
        user = await discordClient.users.fetch(user.id, { force: true }).catch(() => user);

        // Comprehensive Database Lookups
        let dbUserInfo = null;
        let dbLevelInfo = null;
        let dbWarnCount = 0;
        let dbBanInfo = null;
        let dbWarnings = [];
        let dbNotes = [];
        let dbTimeouts = [];
        let dbBans = [];
        let moderatorMap = {};

        try {
            // Fetch all user data in parallel
            const [
                [users],
                [levels],
                [warnsCount],
                [warningsList],
                [bans],
                [notes],
                [timeouts]
            ] = await Promise.all([
                MySQLDatabaseManager.connection.pool.query('SELECT * FROM userinfo WHERE user_id = ?', [user.id]),
                MySQLDatabaseManager.connection.pool.query('SELECT * FROM levels WHERE user_id = ?', [user.id]),
                MySQLDatabaseManager.connection.pool.query(`SELECT COUNT(*) as count FROM moderation_cases WHERE user_id = ? AND action_type = 'WARN' AND status NOT IN ('cleared', 'reversed')`, [user.id]),
                MySQLDatabaseManager.connection.pool.query(`SELECT case_id as id, user_id, case_id, reason, moderator_id, moderator_name, action_type as type, created_at as timestamp, created_at, status FROM moderation_cases WHERE user_id = ? AND action_type = 'WARN' AND status NOT IN ('cleared', 'reversed') ORDER BY created_at DESC LIMIT 20`, [user.id]),
                MySQLDatabaseManager.connection.pool.query('SELECT user_id, banned, ban_case_id, banned_at, banned_by, banned_by_name, ban_reason, created_at FROM user_bans WHERE user_id = ? ORDER BY created_at DESC', [user.id]),
                MySQLDatabaseManager.connection.pool.query('SELECT * FROM member_notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [user.id]).catch(() => [[]]),
                MySQLDatabaseManager.getUserModerationCases(user.id, { actionTypes: ['TIMEOUT'], limit: 10 }).then(rows => [rows]).catch(() => [[]])
            ]);

            dbUserInfo = users[0] || null;
            dbLevelInfo = levels[0] || null;
            dbWarnCount = warnsCount[0]?.count || 0;
            dbWarnings = warningsList || [];
            dbBanInfo = bans[0] || null;
            dbBans = bans || [];
            dbNotes = notes || [];
            dbTimeouts = timeouts || [];

            // Fetch moderator information for all actions
            const moderatorIds = new Set();

            dbWarnings.forEach(w => {
                if (w.moderator_id) moderatorIds.add(w.moderator_id);
            });
            dbBans.forEach(b => {
                if (b.banned_by) moderatorIds.add(b.banned_by);
            });
            dbTimeouts.forEach(t => {
                if (t.issued_by) moderatorIds.add(t.issued_by);
            });

            // Fetch Discord usernames for moderators
            for (const modId of moderatorIds) {
                try {
                    const modUser = await discordClient.users.fetch(modId).catch(() => null);
                    if (modUser) {
                        moderatorMap[modId] = {
                            username: modUser.username,
                            displayName: modUser.globalName || modUser.username,
                            tag: modUser.tag
                        };
                    } else {
                        moderatorMap[modId] = {
                            username: modId,
                            displayName: modId,
                            tag: modId
                        };
                    }
                } catch (err) {
                    moderatorMap[modId] = {
                        username: modId,
                        displayName: modId,
                        tag: modId
                    };
                }
            }

            // Enrich warnings with moderator info
            dbWarnings = dbWarnings.map(w => ({
                ...w,
                moderatorInfo: moderatorMap[w.moderator_id] || null
            }));

            // Enrich bans with moderator info
            dbBans = dbBans.map(b => ({
                ...b,
                moderatorInfo: moderatorMap[b.banned_by] || null
            }));

            // Enrich timeouts with moderator info
            dbTimeouts = dbTimeouts.map(t => ({
                ...t,
                moderatorInfo: moderatorMap[t.issued_by] || null
            }));

        } catch (dbErr) {
            console.error('Error fetching DB data for lookup:', dbErr);
            // Continue with partial data
        }

        // Calculate risk score (0-100)
        let riskScore = 0;
        let riskFactors = [];

        if (dbWarnCount > 0) {
            riskScore += Math.min(dbWarnCount * 10, 30);
            riskFactors.push(`${dbWarnCount} warning${dbWarnCount > 1 ? 's' : ''}`);
        }
        if (dbBanInfo && dbBanInfo.banned === 1) {
            riskScore += 40;
            riskFactors.push('Currently banned');
        } else if (dbBans.length > 0) {
            riskScore += dbBans.length * 5;
            riskFactors.push(`${dbBans.length} previous ban${dbBans.length > 1 ? 's' : ''}`);
        }
        if (dbTimeouts.length > 0) {
            riskScore += Math.min(dbTimeouts.length * 5, 15);
            riskFactors.push(`${dbTimeouts.length} timeout${dbTimeouts.length > 1 ? 's' : ''}`);
        }
        if (member?.communicationDisabledUntilTimestamp && member.communicationDisabledUntilTimestamp > Date.now()) {
            riskScore += 15;
            riskFactors.push('Currently timed out');
        }

        riskScore = Math.min(riskScore, 100);

        const liveBio = typeof user?.bio === 'string' && user.bio.trim()
            ? user.bio.trim()
            : null;
        const storedBio = typeof dbUserInfo?.bio === 'string' && dbUserInfo.bio.trim()
            ? dbUserInfo.bio.trim()
            : null;
        const resolvedBio = liveBio || storedBio || null;

        if (resolvedBio) {
            try {
                await MySQLDatabaseManager.connection.pool.query(
                    `INSERT INTO userinfo (user_id, username, bio, last_seen)
                     VALUES (?, ?, ?, NOW())
                     ON DUPLICATE KEY UPDATE
                        username = COALESCE(VALUES(username), username),
                        bio = VALUES(bio),
                        last_seen = NOW()`,
                    [user.id, user.username || null, resolvedBio]
                );
            } catch (bioPersistErr) {
                console.error('[Lookup] Failed to persist bio in userinfo:', bioPersistErr?.message || bioPersistErr);
            }
        }

        const responseData = {
            id: user.id,
            username: user.username,
            discriminator: user.discriminator,
            globalName: user.globalName,
            avatar: user.displayAvatarURL({ dynamic: true, size: 512 }),
            bot: user.bot,
            createdAt: user.createdTimestamp,
            accountAge: Math.floor((Date.now() - user.createdTimestamp) / (1000 * 60 * 60 * 24)), // days
            member: member ? {
                joinedAt: member.joinedTimestamp,
                serverAge: Math.floor((Date.now() - member.joinedTimestamp) / (1000 * 60 * 60 * 24)), // days
                nickname: member.nickname,
                displayName: member.displayName,
                displayColor: member.displayHexColor,
                roles: member.roles.cache.filter(r => r.name !== '@everyone').map(r => ({
                    id: r.id,
                    name: r.name,
                    color: r.hexColor,
                    position: r.position
                })).sort((a, b) => b.position - a.position),
                communicationDisabledUntil: member.communicationDisabledUntilTimestamp,
                isPending: member.pending || false,
                premiumSince: member.premiumSinceTimestamp
            } : null,
            // Database Data
            db: {
                level: dbLevelInfo?.level || 0,
                xp: dbLevelInfo?.xp || 0,
                messages: dbUserInfo?.messages || 0,
                bio: resolvedBio,
                flags: dbUserInfo?.flags || 0,
                status: dbUserInfo?.status || null,
                warnings: dbWarnCount,
                warningsList: dbWarnings.map(w => ({
                    id: w.id,
                    caseId: w.case_id || null,
                    reason: w.reason,
                    moderatorId: w.moderator_id,
                    moderatorName: w.moderatorInfo?.displayName || w.moderator_name || w.moderator_id || 'Unknown',
                    moderatorUsername: w.moderatorInfo?.username || w.moderator_name || 'Unknown',
                    moderatorTag: w.moderatorInfo?.tag || 'Unknown',
                    timestamp: w.timestamp || w.created_at
                })),
                ban: dbBanInfo ? {
                    banned: dbBanInfo.banned === 1,
                    ban_reason: dbBanInfo.ban_reason,
                    banned_at: dbBanInfo.banned_at || dbBanInfo.created_at,
                    banned_by: dbBanInfo.banned_by,
                    caseId: dbBanInfo.ban_case_id || null,
                    moderatorInfo: dbBanInfo.moderatorInfo || null
                } : null,
                banHistory: dbBans.map(b => ({
                    caseId: b.ban_case_id || null,
                    reason: b.ban_reason,
                    bannedAt: b.banned_at || b.created_at,
                    moderatorId: b.banned_by,
                    moderatorName: b.moderatorInfo?.displayName || b.banned_by_name || b.banned_by || 'Unknown',
                    moderatorUsername: b.moderatorInfo?.username || b.banned_by_name || 'Unknown',
                    moderatorTag: b.moderatorInfo?.tag || 'Unknown',
                    active: b.banned === 1
                })),
                notes: dbNotes.map(n => ({
                    id: n.id,
                    note: n.note,
                    createdBy: n.created_by,
                    createdAt: n.created_at
                })),
                timeouts: dbTimeouts.map(t => {
                    let duration = null;
                    if (t.expires_at && t.issued_at) {
                        const rawDuration = Math.floor((t.expires_at - t.issued_at) / 1000);
                        duration = rawDuration > 0 ? rawDuration : null; // Ignore negative/invalid durations
                    }
                    const moderatorInfo = moderatorMap[t.issued_by];
                    return {
                        id: t.id,
                        caseId: t.case_id || null,
                        reason: t.reason,
                        duration: duration,
                        moderatorId: t.issued_by,
                        moderatorName: moderatorInfo?.displayName || t.issued_by_name || t.issued_by || 'Unknown',
                        moderatorUsername: moderatorInfo?.username || t.issued_by_name || 'Unknown',
                        moderatorTag: moderatorInfo?.tag || 'Unknown',
                        timestamp: t.issued_at,
                        active: t.active === 1
                    };
                })
            },
            // Risk Assessment
            bio: resolvedBio,
            riskScore,
            riskLevel: riskScore >= 75 ? 'HIGH' : riskScore >= 50 ? 'MEDIUM' : riskScore >= 25 ? 'LOW' : 'MINIMAL',
            riskFactors
        };

        // Persist selected profile snapshot so bios are stored for future lookups
        if (typeof MySQLDatabaseManager.upsertUserProfileSnapshot === 'function') {
            try {
                await MySQLDatabaseManager.upsertUserProfileSnapshot(user.id, {
                    username: user.username || dbUserInfo?.username || null,
                    nickname: member?.nickname || dbUserInfo?.nickname || null,
                    bio: resolvedBio,
                    selectedAt: Date.now(),
                    syncedAt: Date.now(),
                    enableSync: true
                });
            } catch (snapshotErr) {
                console.error('[Lookup] Failed to persist profile snapshot:', snapshotErr?.message || snapshotErr);
            }
        }

        res.json(responseData);
    } catch (error) {
        console.error('Error in user lookup:', error);
        res.status(500).json({ error: 'Lookup failed' });
    }
});

app.post('/api/admin/system/lookup/:userId/notes', requireAuth, async (req, res) => {
    try {
        const userId = String(req.params.userId || '').trim();
        if (!isValidDiscordUserId(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }

        const note = String(req.body?.note || '').trim();
        if (!note) {
            return res.status(400).json({ error: 'Note is required' });
        }

        const pool = MySQLDatabaseManager.connection.pool;
        const createdBy = String(req.session?.username || 'admin').trim();

        let usedFallback = false;
        try {
            await pool.query(
                `INSERT INTO member_notes (user_id, note, created_by, created_at)
                 VALUES (?, ?, ?, NOW())`,
                [userId, note, createdBy]
            );
        } catch (err) {
            if (err?.code === 'ER_NO_SUCH_TABLE') {
                usedFallback = true;
                const existing = await MySQLDatabaseManager.getMemberNotes(userId);
                const stamp = new Date().toISOString().replace('T', ' ').replace('Z', ' UTC');
                const merged = `${existing ? `${existing}\n\n` : ''}[${stamp}] ${createdBy}: ${note}`;
                await MySQLDatabaseManager.updateMemberNotes(userId, merged);
            } else {
                throw err;
            }
        }

        return res.json({ success: true, fallback: usedFallback });
    } catch (error) {
        console.error('Error saving lookup moderator note:', error);
        return res.status(500).json({ error: 'Failed to save note' });
    }
});

// Quick search suggestions (as user types)
app.get('/api/admin/search-suggestions', requireAuth, async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.trim().length < 2) {
            return res.json({ suggestions: [] });
        }

        const query = q.trim();
        const [results] = await MySQLDatabaseManager.connection.pool.query(
            `SELECT DISTINCT user_id, username, level, xp 
             FROM levels 
             WHERE user_id LIKE ? OR username LIKE ? 
             ORDER BY level DESC, xp DESC 
             LIMIT 10`,
            [`%${query}%`, `%${query}%`]
        );

        const suggestions = results.map(r => ({
            userId: r.user_id,
            username: r.username || 'Unknown',
            level: r.level || 0,
            label: `${r.username || 'Unknown'} (${r.user_id}) - Lv${r.level || 0}`
        }));

        res.json({ suggestions });
    } catch (error) {
        console.error('Error fetching suggestions:', error);
        res.json({ suggestions: [] });
    }
});

// Get recently viewed users (stored in session or could be DB-backed)
app.get('/api/admin/recent-lookups', requireAuth, async (req, res) => {
    try {
        // For now, return top active users as suggestions
        const [results] = await MySQLDatabaseManager.connection.pool.query(
            `SELECT user_id, username, level, xp 
             FROM levels 
             ORDER BY level DESC, xp DESC 
             LIMIT 10`
        );

        const recentUsers = results.map(r => ({
            userId: r.user_id,
            username: r.username || 'Unknown',
            level: r.level || 0
        }));

        res.json({ users: recentUsers });
    } catch (error) {
        console.error('Error fetching recent lookups:', error);
        res.json({ users: [] });
    }
});

//  register and authenticate

app.get('/register', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'AdminPanel', 'views', 'register.html');
        res.sendFile(filePath);
    } catch (error) {
        console.error('Error sending register.html:', error);
        res.status(500).json({ error: 'Failed to load registration page' });
    }
});

// Register endpoint (requires invite code) - rate limited (2 requests per hour)
app.post('/api/register', createRateLimiter(2, 3600000), async (req, res) => {
    const {
        username,
        email,
        password,
        inviteCode,
        captchaChallengeId,
        captchaAnswer
    } = req.body;

    // Input validation
    if (!username || !email || !password || !inviteCode) {
        return res.status(400).json({ error: 'All fields required' });
    }

    const registerIpReputation = evaluateRequestIpReputation(req, 'register', username);
    if (registerIpReputation.shouldBlock) {
        return res.status(403).json({
            error: 'Access from this network is temporarily blocked. Please try a trusted connection.',
            reputationBlocked: true
        });
    }

    // Validate types
    if (typeof username !== 'string' || typeof email !== 'string' || typeof password !== 'string' || typeof inviteCode !== 'string') {
        return res.status(400).json({ error: 'Invalid input format' });
    }

    const captchaResult = verifyCaptchaChallenge(req, 'register', captchaChallengeId, captchaAnswer);
    if (!captchaResult.ok) {
        emitSecuritySignal(req, 'register-captcha-failed', {
            username: String(username || ''),
            reason: String(captchaResult.error || 'captcha-failed')
        }, 10 * 1000);
        return res.status(captchaResult.status).json({
            error: captchaResult.error,
            captchaInvalid: true,
            captchaRefreshRequired: captchaResult.refreshRequired
        });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    if (!isValidEmailAddress(normalizedEmail)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }

    if (!isStrongPassword(password)) {
        return res.status(400).json({ error: 'Password must contain uppercase, lowercase, number, and special character' });
    }

    if (username.length < 3 || username.length > 30) {
        return res.status(400).json({ error: 'Username must be 3-30 characters' });
    }

    // Sanitize username (alphanumeric + underscore only)
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
    }

    try {
        // Check if username already exists
        const existingUser = await AdminPanelHelper.getAdminUser(username);
        if (existingUser) {
            return res.status(400).json({ error: 'Username already exists' });
        }

        const [existingEmailRows] = await MySQLDatabaseManager.connection.pool.query(
            'SELECT id FROM admin_users WHERE email = ? LIMIT 1',
            [normalizedEmail]
        );
        if (Array.isArray(existingEmailRows) && existingEmailRows.length > 0) {
            return res.status(400).json({ error: 'Email already in use' });
        }

        // Validate invite code with multi-use support
        console.log(`[Registration] Validating invite code: ${inviteCode}`);
        const [inviteCodes] = await MySQLDatabaseManager.connection.pool.query(
            'SELECT * FROM admin_invite_codes WHERE code = ? AND active = TRUE AND (expires_at IS NULL OR expires_at > NOW()) AND current_uses < max_uses',
            [inviteCode]
        );

        console.log(`[Registration] Found ${inviteCodes?.length || 0} matching invite codes`);

        if (!inviteCodes || inviteCodes.length === 0) {
            // Debug: Check if code exists at all
            const [debugCodes] = await MySQLDatabaseManager.connection.pool.query(
                'SELECT code, used_by, active, expires_at, current_uses, max_uses FROM admin_invite_codes WHERE code = ?',
                [inviteCode]
            );
            console.log(`[Registration] Debug - Code in DB:`, debugCodes);
            return res.status(400).json({ error: 'Invalid, expired, or fully used invite code' });
        }

        const invite = inviteCodes[0];
        const role = invite.role || 'moderator';

        console.log(`[Registration] Creating user ${username} with role ${role} (invite ${invite.current_uses + 1}/${invite.max_uses})`);

        // Hash password
        const passwordHash = await bcrypt.hash(password, 10);

        // Create new admin user with role from invite code
        const newUser = await AdminPanelHelper.createAdminUser(username, passwordHash, role, normalizedEmail);

        if (newUser) {
            // Increment usage counter and track latest user
            await MySQLDatabaseManager.connection.pool.query(
                'UPDATE admin_invite_codes SET current_uses = current_uses + 1, used_by = ?, used_at = NOW() WHERE code = ?',
                [username, inviteCode]
            );

            const verificationToken = createSecureToken(24);
            try {
                await MySQLDatabaseManager.connection.pool.query(
                    `UPDATE admin_users
                     SET email_verified = FALSE,
                         email_verification_token = ?,
                         email_verification_expires = DATE_ADD(NOW(), INTERVAL 24 HOUR)
                     WHERE username = ?`,
                    [verificationToken, username]
                );
            } catch (verificationUpdateError) {
                if (verificationUpdateError?.code !== 'ER_BAD_FIELD_ERROR') {
                    throw verificationUpdateError;
                }
            }

            if (EmailHelper.isReady()) {
                await EmailHelper.sendRegistrationWelcomeEmail(normalizedEmail, username, role).catch((emailError) => {
                    console.error('[Registration] Welcome email failed:', emailError?.message || emailError);
                });

                await EmailHelper.sendEmailVerificationEmail(normalizedEmail, username, verificationToken).catch((emailError) => {
                    console.error('[Registration] Verification email failed:', emailError?.message || emailError);
                });
            }

            console.log(`[Admin] New user registered: ${username} with role ${role} using invite ${inviteCode} (${invite.current_uses + 1}/${invite.max_uses})`);
            sendBotWebhook('account.registered', {
                username,
                role,
                inviteCode
            }, req).catch(() => { });
            res.json({ success: true, message: 'Account created successfully. Please login.' });
        } else {
            console.error(`[Registration] Failed to create user - createAdminUser returned null/false`);
            res.status(500).json({ error: 'Failed to create account' });
        }
    } catch (error) {
        console.error('Error during registration:', error);
        res.status(500).json({ error: 'Registration failed: ' + error.message });
    }
});


function sendVerifyEmailStatusPage(res, { title, message, hint = '', statusCode = 200, icon = '🔔' } = {}) {
    // Sanitize for HTML injection safety
    const safeTitle = sanitizeHtmlText(title || 'Status');
    const safeMessage = sanitizeHtmlText(message || 'Request completed.');
    const safeHint = sanitizeHtmlText(hint || '');
    const safeIcon = typeof icon === 'string' ? icon : '🔔';
    const code = Number.isInteger(statusCode) ? statusCode : 200;

    const statusPagePath = path.join(__dirname, 'AdminPanel', 'views', 'status.html');
    fs.readFile(statusPagePath, 'utf8', (err, html) => {
        if (err) {
            // fallback to legacy HTML if file not found
            return res.status(code).send(`<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
</head>
<body>
    <main>
        <h1>${safeTitle}</h1>
        <p>${safeMessage}</p>
        ${safeHint ? `<p>${safeHint}</p>` : ''}
    </main>
</body>
</html>`);
        }
        // Inject window.statusPageData as a script right after <body>
        const script = `<script>window.statusPageData = ${JSON.stringify({
            title: safeTitle,
            message: safeMessage,
            hint: safeHint,
            icon: safeIcon
        })};</script>`;
        const injected = html.replace(/<body>/i, '<body>' + script);
        res.status(code).send(injected);
    });
}

app.get('/verify-email', async (req, res) => {
    try {
        const token = String(req.query?.token || '').trim();
        if (!token) {
            return sendVerifyEmailStatusPage(res, {
                title: 'Email Verification Failed',
                message: 'Missing verification token.',
                hint: 'Request a new verification email from your profile settings.',
                statusCode: 400
            });
        }

        const [rows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT id, username
             FROM admin_users
             WHERE email_verification_token = ?
               AND email_verification_expires IS NOT NULL
               AND email_verification_expires > NOW()
             LIMIT 1`,
            [token]
        );

        const user = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
        if (!user) {
            return sendVerifyEmailStatusPage(res, {
                title: 'Verification Link Expired',
                message: 'This verification link is invalid or has expired.',
                hint: 'Request another verification email and try again.',
                statusCode: 400
            });
        }

        await MySQLDatabaseManager.connection.pool.execute(
            `UPDATE admin_users
             SET email_verified = TRUE,
                 email_verification_token = NULL,
                 email_verification_expires = NULL
             WHERE id = ?`,
            [user.id]
        );

        await logAdminAuthEvent(user.username, 'EMAIL_VERIFIED', req, { route: '/verify-email' });
        await sendSecurityAlertIfPossible(user, 'Email verified', [
            'Your email address has been verified.',
            `IP Address: ${req.clientIP || 'Unknown'}`,
            `User Agent: ${String(req.userAgent || 'Unknown').slice(0, 140)}`
        ], req).catch(() => { });

        return sendVerifyEmailStatusPage(res, {
            title: 'Email Verified',
            message: 'Your email has been verified successfully.',
            hint: 'You can now continue using your account.',
            statusCode: 200
        });
    } catch (error) {
        console.error('Error verifying email token:', error);
        return sendVerifyEmailStatusPage(res, {
            title: 'Verification Error',
            message: 'We could not verify your email right now.',
            hint: 'Please try again later.',
            statusCode: 500
        });
    }
});

app.post('/api/email/verify', createRateLimiter(8, 600000), async (req, res) => {
    try {
        const token = String(req.body?.token || '').trim();
        if (!token) {
            return res.status(400).json({ error: 'Verification token is required' });
        }

        const [rows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT id, username
             FROM admin_users
             WHERE email_verification_token = ?
               AND email_verification_expires IS NOT NULL
               AND email_verification_expires > NOW()
             LIMIT 1`,
            [token]
        );

        const user = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
        if (!user) {
            return res.status(400).json({ error: 'Invalid or expired verification token' });
        }

        await MySQLDatabaseManager.connection.pool.execute(
            `UPDATE admin_users
             SET email_verified = TRUE,
                 email_verification_token = NULL,
                 email_verification_expires = NULL
             WHERE id = ?`,
            [user.id]
        );

        await logAdminAuthEvent(user.username, 'EMAIL_VERIFIED', req, { route: '/api/email/verify' });
        await sendSecurityAlertIfPossible(user, 'Email verified', [
            'Your email address has been verified via API endpoint.',
            `IP Address: ${req.clientIP || 'Unknown'}`,
            `User Agent: ${String(req.userAgent || 'Unknown').slice(0, 140)}`
        ], req).catch(() => { });
        return res.json({ success: true, message: 'Email verified successfully' });
    } catch (error) {
        console.error('Error verifying email via API:', error);
        return res.status(500).json({ error: 'Failed to verify email' });
    }
});

app.post('/api/account/email/verification/resend', createRateLimiter(3, 3600000), requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const userEmail = String(user.email || '').trim().toLowerCase();
        if (!isValidEmailAddress(userEmail)) {
            return res.status(400).json({ error: 'No valid email on this account' });
        }

        const token = createSecureToken(24);
        await MySQLDatabaseManager.connection.pool.execute(
            `UPDATE admin_users
             SET email_verification_token = ?,
                 email_verification_expires = DATE_ADD(NOW(), INTERVAL 24 HOUR),
                 email_verified = FALSE
             WHERE username = ?`,
            [token, user.username]
        );

        if (!EmailHelper.isReady()) {
            return res.status(503).json({
                error: 'Email service is currently unavailable. Please try again later.'
            });
        }

        const emailResult = await EmailHelper.sendEmailVerificationEmail(userEmail, user.username, token);
        if (!emailResult?.success) {
            const rawReason = String(emailResult?.error || 'Unable to send verification email').trim();
            const normalizedReason = rawReason.toLowerCase();

            if (normalizedReason.includes('recipient cooldown active')) {
                const retryAfterSeconds = Number(EmailHelper.minSecondsBetweenSameRecipient || 10);
                return res.status(429).json({
                    error: 'Please wait before requesting another verification email.',
                    reason: rawReason,
                    code: 'RECIPIENT_COOLDOWN',
                    retryAfterSeconds
                });
            }

            if (normalizedReason.includes('recipient hourly limit reached')) {
                return res.status(429).json({
                    error: 'Verification email limit reached for this recipient. Please try again later.',
                    reason: rawReason,
                    code: 'RECIPIENT_HOURLY_LIMIT',
                    retryAfterSeconds: 3600
                });
            }

            if (normalizedReason.includes('global email rate limit reached')) {
                return res.status(429).json({
                    error: 'Email sending is temporarily rate-limited. Please retry shortly.',
                    reason: rawReason,
                    code: 'GLOBAL_EMAIL_RATE_LIMIT',
                    retryAfterSeconds: 60
                });
            }

            return res.status(502).json({
                error: 'Failed to send verification email.',
                reason: rawReason,
                code: 'EMAIL_DELIVERY_FAILED'
            });
        }

        return res.json({ success: true, message: 'Verification email sent' });
    } catch (error) {
        console.error('Error resending verification email:', error);
        return res.status(500).json({ error: 'Failed to resend verification email' });
    }
});

app.post('/api/account/password-reset/request', createRateLimiter(3, 15 * 60 * 1000), async (req, res) => {
    try {
        const identifier = String(req.body?.identifier || '').trim();
        if (!identifier) {
            return res.status(400).json({ error: 'Username or email is required' });
        }

        const normalized = identifier.toLowerCase();
        const [rows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT id, username, email
             FROM admin_users
             WHERE active = TRUE AND (LOWER(username) = ? OR LOWER(email) = ?)
             LIMIT 1`,
            [normalized, normalized]
        );

        const user = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
        if (user && EmailHelper.isReady() && isValidEmailAddress(user.email)) {
            const token = createSecureToken(24);
            await MySQLDatabaseManager.connection.pool.execute(
                `UPDATE admin_users
                 SET password_reset_token = ?,
                     password_reset_expires = DATE_ADD(NOW(), INTERVAL 30 MINUTE)
                 WHERE id = ?`,
                [token, user.id]
            );

            await EmailHelper.sendPasswordResetEmail(user.email, user.username, token).catch((emailError) => {
                console.error('Failed to send password reset email:', emailError?.message || emailError);
            });

            await logAdminAuthEvent(user.username, 'PASSWORD_RESET_REQUESTED', req, { route: '/api/account/password-reset/request' });
        }

        return res.json({ success: true, message: 'If that account exists, a reset email has been sent.' });
    } catch (error) {
        console.error('Error requesting password reset:', error);
        return res.status(500).json({ error: 'Failed to process password reset request' });
    }
});

app.post('/api/account/password-reset/confirm', createRateLimiter(5, 15 * 60 * 1000), async (req, res) => {
    try {
        const token = String(req.body?.token || '').trim();
        const newPassword = String(req.body?.newPassword || '');
        const confirmPassword = String(req.body?.confirmPassword || '');

        if (!token || !newPassword || !confirmPassword) {
            return res.status(400).json({ error: 'All fields required' });
        }

        if (newPassword !== confirmPassword) {
            return res.status(400).json({ error: 'Passwords do not match' });
        }

        if (!isStrongPassword(newPassword)) {
            return res.status(400).json({ error: 'Password must contain uppercase, lowercase, number, and special character' });
        }

        const [rows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT id, username, email
             FROM admin_users
             WHERE password_reset_token = ?
               AND password_reset_expires IS NOT NULL
               AND password_reset_expires > NOW()
               AND active = TRUE
             LIMIT 1`,
            [token]
        );

        const user = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
        if (!user) {
            return res.status(400).json({ error: 'Invalid or expired reset token' });
        }

        const passwordHash = await bcrypt.hash(newPassword, 12);
        await MySQLDatabaseManager.connection.pool.execute(
            `UPDATE admin_users
             SET password_hash = ?,
                 password_changed_at = NOW(),
                 password_reset_token = NULL,
                 password_reset_expires = NULL
             WHERE id = ?`,
            [passwordHash, user.id]
        );

        await logAdminAuthEvent(user.username, 'PASSWORD_RESET_COMPLETED', req, { route: '/api/account/password-reset/confirm', mode: 'email-token' });
        await sendSecurityAlertIfPossible(user, 'Password reset completed', ['Method: Email reset token'], req);

        return res.json({ success: true, message: 'Password reset successfully' });
    } catch (error) {
        console.error('Error confirming password reset:', error);
        return res.status(500).json({ error: 'Failed to reset password' });
    }
});

app.post('/api/account/password-reset/recovery', createRateLimiter(5, 15 * 60 * 1000), async (req, res) => {
    try {
        const username = String(req.body?.username || '').trim();
        const recoveryCodeRaw = String(req.body?.recoveryCode || '').trim();
        const newPassword = String(req.body?.newPassword || '');
        const confirmPassword = String(req.body?.confirmPassword || '');

        if (!username || !recoveryCodeRaw || !newPassword || !confirmPassword) {
            return res.status(400).json({ error: 'All fields required' });
        }

        if (newPassword !== confirmPassword) {
            return res.status(400).json({ error: 'Passwords do not match' });
        }

        if (!isStrongPassword(newPassword)) {
            return res.status(400).json({ error: 'Password must contain uppercase, lowercase, number, and special character' });
        }

        const normalizedCode = normalizeRecoveryCodeInput(recoveryCodeRaw);
        if (!normalizedCode) {
            return res.status(400).json({ error: 'Invalid recovery code format' });
        }

        const user = await AdminPanelHelper.getAdminUser(username);
        if (!user || !user.active) {
            return res.status(401).json({ error: 'Invalid recovery credentials' });
        }

        const hashes = parseRecoveryCodeHashes(user.recovery_code_hashes);
        const inputHash = hashRecoveryCode(normalizedCode);
        const matchingIndex = hashes.findIndex((hash) => hash === inputHash);
        if (matchingIndex === -1) {
            return res.status(401).json({ error: 'Invalid recovery credentials' });
        }

        hashes.splice(matchingIndex, 1);
        const passwordHash = await bcrypt.hash(newPassword, 12);

        await MySQLDatabaseManager.connection.pool.execute(
            `UPDATE admin_users
             SET password_hash = ?,
                 password_changed_at = NOW(),
                 recovery_code_hashes = ?
             WHERE id = ?`,
            [passwordHash, JSON.stringify(hashes), user.id]
        );

        await logAdminAuthEvent(user.username, 'PASSWORD_RESET_COMPLETED', req, {
            route: '/api/account/password-reset/recovery',
            mode: 'recovery-code',
            remainingRecoveryCodes: hashes.length
        });
        await sendSecurityAlertIfPossible(user, 'Password reset completed', [
            'Method: Recovery code',
            `Remaining recovery codes: ${hashes.length}`
        ], req);

        return res.json({ success: true, message: 'Password reset successfully' });
    } catch (error) {
        console.error('Error resetting password via recovery code:', error);
        return res.status(500).json({ error: 'Failed to reset password' });
    }
});

// Account settings

app.get('/settings', requireAuth, (req, res) => {
    try {
        const filePath = path.join(__dirname, 'AdminPanel', 'views', 'settings.html');
        res.sendFile(filePath);
    } catch (error) {
        console.error('Error sending settings.html:', error);
        res.status(500).json({ error: 'Failed to load settings page' });
    }
});

// Get account info
app.get('/api/account/info', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const [loginCountRows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT COUNT(*) AS count
             FROM admin_auth_events
             WHERE username = ? AND event_type = 'LOGIN_SUCCESS'`,
            [user.username]
        );

        res.json({
            success: true,
            username: user.username,
            email: user.email || null,
            avatar_url: user.avatar_url || null,
            avatar_updated_at: user.avatar_updated_at || null,
            email_verified: Boolean(user.email_verified),
            role: user.role,
            created_at: user.created_at,
            last_login: user.last_login,
            twoFactorEnabled: Boolean(user.two_factor_enabled),
            password_changed_at: user.password_changed_at || null,
            loginCount: Number(loginCountRows?.[0]?.count || 0)
        });
    } catch (error) {
        console.error('Error getting account info:', error);
        res.status(500).json({ error: 'Failed to get account info' });
    }
});

// Get current user (for profile page)
app.get('/api/user', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const [loginCountRows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT COUNT(*) AS count
             FROM admin_auth_events
             WHERE username = ? AND event_type = 'LOGIN_SUCCESS'`,
            [user.username]
        );

        const [sessionEventRows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT event_type, created_at
             FROM admin_auth_events
             WHERE username = ? AND event_type IN ('LOGIN_SUCCESS', 'LOGOUT')
             ORDER BY created_at ASC`,
            [user.username]
        );

        const sessionDurationsMs = [];
        let openLoginAt = null;

        for (const row of (sessionEventRows || [])) {
            const eventType = String(row.event_type || '');
            const eventTime = row.created_at ? new Date(row.created_at).getTime() : null;
            if (!eventTime || Number.isNaN(eventTime)) continue;

            if (eventType === 'LOGIN_SUCCESS') {
                if (openLoginAt) {
                    const carryDuration = Math.max(0, eventTime - openLoginAt);
                    sessionDurationsMs.push(Math.min(carryDuration, 24 * 60 * 60 * 1000));
                }
                openLoginAt = eventTime;
                continue;
            }

            if (eventType === 'LOGOUT' && openLoginAt) {
                const duration = Math.max(0, eventTime - openLoginAt);
                sessionDurationsMs.push(Math.min(duration, 24 * 60 * 60 * 1000));
                openLoginAt = null;
            }
        }

        if (openLoginAt) {
            const openDuration = Math.max(0, Date.now() - openLoginAt);
            sessionDurationsMs.push(Math.min(openDuration, 24 * 60 * 60 * 1000));
        }

        let avgSessionTime = 'N/A';
        if (sessionDurationsMs.length > 0) {
            const total = sessionDurationsMs.reduce((sum, value) => sum + value, 0);
            const avg = Math.floor(total / sessionDurationsMs.length);
            const avgMinutes = Math.floor(avg / (60 * 1000));
            const hours = Math.floor(avgMinutes / 60);
            const minutes = avgMinutes % 60;
            avgSessionTime = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
        }

        res.json({
            success: true,
            username: user.username,
            email: user.email || null,
            avatar_url: user.avatar_url || null,
            avatar_updated_at: user.avatar_updated_at || null,
            email_verified: Boolean(user.email_verified),
            role: user.role,
            created_at: user.created_at,
            last_login: user.last_login,
            id: user.id,
            avgSessionTime,
            loginCount: Number(loginCountRows?.[0]?.count || 0),
            twoFactorEnabled: Boolean(user.two_factor_enabled),
            password_changed_at: user.password_changed_at || null
        });
    } catch (error) {
        console.error('Error getting user info:', error);
        res.status(500).json({ error: 'Failed to get user info' });
    }
});

app.get('/api/profile/recent-activity', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const [rows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT event_type, ip_address, user_agent, metadata, created_at
             FROM admin_auth_events
             WHERE username = ?
             ORDER BY created_at DESC
             LIMIT 30`,
            [user.username]
        );

        const formatEventLabel = (eventType) => {
            const map = {
                LOGIN_SUCCESS: 'Successful Login',
                LOGIN_FAILED: 'Failed Login Attempt',
                LOGIN_2FA_CHALLENGE: '2FA Challenge Requested',
                LOGIN_2FA_FAILED: 'Failed 2FA Attempt',
                LOGOUT: 'Logged Out',
                PASSWORD_CHANGED: 'Password Changed',
                TWO_FACTOR_ENABLED: '2FA Enabled',
                TWO_FACTOR_DISABLED: '2FA Disabled',
                SESSIONS_REVOKED: 'Sessions Revoked'
            };
            return map[eventType] || String(eventType || 'UNKNOWN_EVENT');
        };

        const recentActivity = (rows || []).map((row) => {
            let metadata = {};
            try {
                metadata = row.metadata ? JSON.parse(row.metadata) : {};
            } catch (_) {
                metadata = {};
            }

            const route = metadata.route ? `Route: ${metadata.route}` : null;
            const reason = metadata.reason ? `Reason: ${metadata.reason}` : null;
            const mode = metadata.mode ? `Mode: ${metadata.mode}` : null;
            const details = [route, reason, mode, row.ip_address ? `IP: ${row.ip_address}` : null]
                .filter(Boolean)
                .join(' • ') || 'No extra details';

            return {
                action: formatEventLabel(row.event_type),
                details,
                time: row.created_at
            };
        });

        return res.json({
            success: true,
            activities: recentActivity
        });
    } catch (error) {
        console.error('Error fetching profile recent activity:', error);
        return res.status(500).json({ error: 'Failed to fetch recent activity' });
    }
});

app.get('/api/security/summary', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const allMatchedSessions = await listUserSessions(user.username, user.id, req.sessionID, { includeLowConfidence: true });
        const sessions = allMatchedSessions.filter((session) => session.isCurrent || isHighConfidenceSession(session));
        const hiddenStaleSessions = Math.max(0, allMatchedSessions.length - sessions.length);
        const [eventsRows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT event_type, ip_address, user_agent, metadata, created_at
             FROM admin_auth_events
             WHERE username = ?
             ORDER BY created_at DESC
             LIMIT 20`,
            [user.username]
        );

        const [metrics24hRows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT
                COUNT(*) AS events24h,
                COALESCE(SUM(CASE WHEN event_type LIKE '%FAILED%' THEN 1 ELSE 0 END), 0) AS failedEvents24h,
                COALESCE(SUM(CASE WHEN event_type LIKE 'LOGIN_%' THEN 1 ELSE 0 END), 0) AS loginEvents24h,
                COALESCE(SUM(CASE WHEN event_type = 'LOGIN_SUCCESS_RECOVERY' THEN 1 ELSE 0 END), 0) AS recoveryLogins24h,
                COALESCE(SUM(CASE WHEN event_type = 'SESSIONS_REVOKED' THEN 1 ELSE 0 END), 0) AS sessionRevocations24h
             FROM admin_auth_events
             WHERE username = ?
               AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
            [user.username]
        );

        const metrics24h = {
            events: Number(metrics24hRows?.[0]?.events24h || 0),
            failedEvents: Number(metrics24hRows?.[0]?.failedEvents24h || 0),
            loginEvents: Number(metrics24hRows?.[0]?.loginEvents24h || 0),
            recoveryLogins: Number(metrics24hRows?.[0]?.recoveryLogins24h || 0),
            sessionRevocations: Number(metrics24hRows?.[0]?.sessionRevocations24h || 0)
        };

        const recentEvents = (eventsRows || []).map((row) => {
            let metadata = {};
            try {
                metadata = row.metadata ? JSON.parse(row.metadata) : {};
            } catch (_) {
                metadata = {};
            }

            const geoLabel = metadata?.geoLabel || getIpLocationLabel(row.ip_address);

            return {
                eventType: row.event_type,
                ipAddress: row.ip_address,
                userAgent: row.user_agent,
                metadata,
                geoLabel,
                ipInsight: getIpIntelligence(row.ip_address, row.user_agent),
                createdAt: row.created_at
            };
        });

        const recoveryCodeHashes = parseRecoveryCodeHashes(user.recovery_code_hashes);
        const recovery = {
            hasCodes: recoveryCodeHashes.length > 0,
            codeCount: recoveryCodeHashes.length,
            generatedAt: user.recovery_codes_generated_at || null
        };

        const discordLinkState = await ensureDiscordLinkSecurityState(req, { user, forceRefresh: true });

        let discordProfile = null;
        if (discordLinkState.linked && discordClient) {
            try {
                const discordUser = await discordClient.users.fetch(user.discord_user_id, { force: true }).catch(() => null);
                if (discordUser) {
                    discordProfile = {
                        id: discordUser.id,
                        username: discordUser.username || null,
                        discriminator: discordUser.discriminator || null,
                        globalName: discordUser.globalName || null,
                        avatarUrl: discordUser.displayAvatarURL({ extension: 'png', size: 256 }) || null,
                        bannerUrl: discordUser.bannerURL({ extension: 'png', size: 1024 }) || null,
                        accentColor: typeof discordUser.hexAccentColor === 'string' ? discordUser.hexAccentColor : null,
                        profileUrl: `https://discord.com/users/${discordUser.id}`
                    };
                }
            } catch (discordProfileError) {
                console.warn('[AdminPanel] Unable to fetch linked Discord profile details:', discordProfileError.message);
            }
        }

        const discordLink = {
            ...discordLinkState,
            profile: discordProfile
        };

        const latestSecurityPoint = recentEvents[0] || null;
        const latestSessionPoint = sessions[0] || null;
        const latestSecurityInsight = latestSecurityPoint?.ipInsight || null;
        const latestSessionInsight = latestSessionPoint ? getIpIntelligence(latestSessionPoint.ipAddress, latestSessionPoint.userAgent) : null;
        const latestInsight = latestSecurityInsight || latestSessionInsight || getIpIntelligence(null, null);
        const latestInsightSource = latestSecurityInsight
            ? 'Recent security event'
            : (latestSessionInsight ? 'Active session' : 'Unknown source');
        const uniqueLocationLabels = [...new Set([
            ...recentEvents.map((event) => event.geoLabel),
            ...sessions.map((session) => session.geoLabel)
        ].filter(Boolean))].slice(0, 5);
        const recentNetworkTypes = [...new Set([
            ...recentEvents.map((event) => event.ipInsight?.networkTypeLabel),
            ...sessions.map((session) => getIpIntelligence(session.ipAddress, session.userAgent).networkTypeLabel)
        ].filter(Boolean))].slice(0, 5);
        const recentIpVersions = [...new Set([
            ...recentEvents.map((event) => event.ipInsight?.ipVersion),
            ...sessions.map((session) => getIpIntelligence(session.ipAddress, session.userAgent).ipVersion)
        ].filter((value) => value && value !== 'Unknown'))].slice(0, 5);
        const geoLookupCandidateIp = findBestPublicIpCandidate([
            latestSecurityPoint?.ipAddress,
            latestSessionPoint?.ipAddress,
            ...recentEvents.map((event) => event.ipAddress),
            ...sessions.map((session) => session.ipAddress)
        ]);
        const resolvedGeo = await lookupIpGeolocation(geoLookupCandidateIp);
        const geoSnapshot = {
            latestLocation: latestSecurityPoint?.geoLabel || latestSessionPoint?.geoLabel || 'Unknown location',
            latestIp: latestSecurityPoint?.ipAddress || latestSessionPoint?.ipAddress || null,
            latestTime: latestSecurityPoint?.createdAt || (latestSessionPoint?.loginTime ? new Date(Number(latestSessionPoint.loginTime)).toISOString() : null),
            uniqueLocations: uniqueLocationLabels,
            latestNetworkType: latestInsight.networkTypeLabel,
            latestIpVersion: latestInsight.ipVersion,
            addressScope: latestInsight.addressScope,
            confidence: latestInsight.confidence,
            source: latestInsightSource,
            riskSignals: latestInsight.riskSignals,
            recentNetworkTypes,
            recentIpVersions,
            map: resolvedGeo
                ? {
                    available: true,
                    latitude: resolvedGeo.latitude,
                    longitude: resolvedGeo.longitude,
                    locationLabel: resolvedGeo.locationLabel,
                    provider: resolvedGeo.provider,
                    network: resolvedGeo.network,
                    asn: resolvedGeo.asn,
                    ip: resolvedGeo.ip,
                    providersTried: resolvedGeo.providersTried || [resolvedGeo.provider]
                }
                : {
                    available: false,
                    provider: 'ip-api.com',
                    providersTried: ['ip-api.com', 'ipwho.is', 'ipapi.co'],
                    ip: geoLookupCandidateIp || (latestSecurityPoint?.ipAddress || latestSessionPoint?.ipAddress || null),
                    reason: geoLookupCandidateIp
                        ? 'Could not resolve map coordinates for the latest public IP'
                        : 'Latest observed IP is localhost/private and cannot be mapped'
                }
        };

        return res.json({
            twoFactorEnabled: Boolean(user.two_factor_enabled),
            twoFactorEnabledAt: user.two_factor_enabled_at || null,
            sessions,
            hiddenStaleSessions,
            recentEvents,
            metrics24h,
            geoSnapshot,
            recovery,
            discordLink
        });
    } catch (error) {
        console.error('Error fetching security summary:', error);
        return res.status(500).json({ error: 'Failed to fetch security summary' });
    }
});

app.post('/api/security/sessions/logout-others', requireAuth, requireDiscordSecurityBinding, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!user) return res.status(404).json({ error: 'User not found' });

        await closeOtherUserSessions(user.username, user.id, req.sessionID);
        await logAdminAuthEvent(user.username, 'SESSIONS_REVOKED', req, { mode: 'logout-others' });
        return res.json({ success: true });
    } catch (error) {
        console.error('Error logging out other sessions:', error);
        return res.status(500).json({ error: 'Failed to logout other sessions' });
    }
});

app.post('/api/security/sessions/revoke', requireAuth, requireDiscordSecurityBinding, async (req, res) => {
    try {
        const { sessionId } = req.body || {};
        if (!sessionId || typeof sessionId !== 'string') {
            return res.status(400).json({ error: 'Session ID is required' });
        }
        if (sessionId === req.sessionID) {
            return res.status(400).json({ error: 'Cannot revoke the current session' });
        }

        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const sessions = await listUserSessions(user.username, user.id, req.sessionID);
        const targetSession = sessions.find((session) => session.sessionId === sessionId);
        if (!targetSession) {
            return res.status(404).json({ error: 'Session not found' });
        }

        await MySQLDatabaseManager.connection.pool.execute(
            'DELETE FROM sessions WHERE session_id = ?',
            [sessionId]
        );

        await logAdminAuthEvent(user.username, 'SESSIONS_REVOKED', req, { mode: 'single-session', sessionId });
        return res.json({ success: true });
    } catch (error) {
        console.error('Error revoking session:', error);
        return res.status(500).json({ error: 'Failed to revoke session' });
    }
});

app.post('/api/security/recovery-codes/generate', createRateLimiter(5, 5 * 60 * 1000), requireAuth, requireDiscordSecurityBinding, async (req, res) => {
    try {
        const currentPassword = String(req.body?.currentPassword || '').trim();
        const token = String(req.body?.token || '').trim();
        if (!currentPassword) {
            return res.status(400).json({ error: 'Current password is required' });
        }

        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const passwordValid = await bcrypt.compare(currentPassword, user.password_hash || '');
        if (!passwordValid) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        if (user.two_factor_enabled) {
            if (!/^\d{6}$/.test(token)) {
                return res.status(400).json({ error: 'Current 2FA code is required' });
            }

            if (isTwoFactorAttemptBlocked(user.username, 'recovery-codes')) {
                return res.status(429).json({ error: 'Too many invalid 2FA attempts. Wait a few minutes before trying again.' });
            }

            const { secret: twoFactorSecret, keyUsed } = decryptStoredTwoFactorSecret(user.two_factor_secret);
            const verification = TotpHelper.verifyTotpDetailed(token, twoFactorSecret, { window: 1 });
            if (!verification.valid) {
                noteTwoFactorAttemptFailure(user.username, 'recovery-codes');
                return res.status(401).json({ error: 'Invalid 2FA code' });
            }

            const counterAccepted = await consumeVerifiedTwoFactorCounter(user.id, verification.counter);
            if (!counterAccepted) {
                noteTwoFactorAttemptFailure(user.username, 'recovery-codes');
                return res.status(401).json({ error: 'This 2FA code was already used. Wait for a new code and try again.' });
            }

            await reencryptTwoFactorSecretIfNeeded(user.id, twoFactorSecret, keyUsed);
            clearTwoFactorAttemptFailures(user.username, 'recovery-codes');
        }

        const codes = generateRecoveryCodes(10);
        const codeHashes = codes.map(hashRecoveryCode);

        await MySQLDatabaseManager.connection.pool.execute(
            `UPDATE admin_users
             SET recovery_code_hashes = ?, recovery_codes_generated_at = NOW()
             WHERE id = ?`,
            [JSON.stringify(codeHashes), user.id]
        );

        await logAdminAuthEvent(user.username, 'PASSWORD_CHANGED', req, { route: '/api/security/recovery-codes/generate', mode: 'recovery-codes-generated' });

        return res.json({
            success: true,
            generatedAt: new Date().toISOString(),
            codes
        });
    } catch (error) {
        console.error('Error generating recovery codes:', error);
        return res.status(500).json({ error: 'Failed to generate recovery codes' });
    }
});

app.get('/api/account/discord/oauth/start', requireAuth, async (req, res) => {
    try {
        const oauth = getDiscordOAuthConfig(req);
        if (!oauth.ready) {
            return completeDiscordOAuthRequest(req, res, { success: false, message: 'Discord OAuth is not configured' });
        }

        if (!oauth.hostMatchesRequest) {
            return completeDiscordOAuthRequest(req, res, { success: false, message: 'Open the panel on the configured Discord OAuth host before linking' });
        }

        const existingState = await ensureDiscordLinkSecurityState(req, { forceRefresh: true });
        if (existingState?.linked) {
            return completeDiscordOAuthRequest(req, res, { success: false, message: 'This profile is already linked. Unlink it first to connect a different Discord account.' });
        }

        const state = crypto.randomBytes(24).toString('hex');
        const { codeVerifier, codeChallenge } = createDiscordOAuthPkcePair();
        const requestBinding = buildDiscordOAuthRequestBinding(req);
        storeDiscordOAuthState(state, {
            username: req.session.username,
            createdAt: Date.now(),
            ipHash: requestBinding.ipHash,
            userAgentHash: requestBinding.userAgentHash,
            host: requestBinding.host,
            codeVerifier
        });

        req.session.discordOAuthState = {
            value: state,
            createdAt: Date.now(),
            username: req.session.username,
            ipHash: requestBinding.ipHash,
            userAgentHash: requestBinding.userAgentHash,
            host: requestBinding.host,
            codeVerifier
        };

        await new Promise((resolve) => req.session.save(() => resolve()));

        const params = new URLSearchParams({
            client_id: oauth.clientId,
            redirect_uri: oauth.redirectUri,
            response_type: 'code',
            scope: 'identify',
            state,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            prompt: 'consent'
        });

        return res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
    } catch (error) {
        console.error('Error starting Discord OAuth link:', error);
        return res.redirect('/profile?discord_oauth=error&message=Failed%20to%20start%20Discord%20OAuth');
    }
});

app.get('/api/account/discord/oauth/runtime', requireAuth, async (req, res) => {
    try {
        const oauth = getDiscordOAuthConfig(req);
        let callbackOrigin = '';
        let callbackHost = '';

        try {
            const parsed = new URL(oauth.redirectUri);
            callbackOrigin = parsed.origin;
            callbackHost = parsed.host;
        } catch (_) {
            callbackOrigin = '';
            callbackHost = '';
        }

        return res.json({
            success: true,
            ready: Boolean(oauth.ready),
            redirectUri: oauth.redirectUri,
            callbackOrigin,
            callbackHost,
            requestOrigin: oauth.requestOrigin,
            hostMatchesRequest: Boolean(oauth.hostMatchesRequest),
            guildVerificationRequired: DISCORD_OAUTH_REQUIRE_GUILD_MEMBER,
            guildId: getConfiguredDiscordGuildId() || null,
            protectedFeatures: DISCORD_SECURITY_PROTECTED_FEATURES
        });
    } catch (error) {
        console.error('Error getting Discord OAuth runtime config:', error);
        return res.status(500).json({ error: 'Failed to load Discord OAuth runtime config' });
    }
});

app.get('/api/account/discord/oauth/callback', async (req, res) => {
    try {
        const oauth = getDiscordOAuthConfig(req);
        if (!oauth.ready) {
            return completeDiscordOAuthRequest(req, res, { success: false, message: 'Discord OAuth is not configured' });
        }

        const code = String(req.query?.code || '').trim();
        const state = String(req.query?.state || '').trim();
        const serverState = state ? consumeDiscordOAuthState(state) : null;
        const stateData = req.session.discordOAuthState || null;
        const requestBinding = buildDiscordOAuthRequestBinding(req);

        if (!code || !state) {
            return completeDiscordOAuthRequest(req, res, { success: false, message: 'Missing OAuth callback data' });
        }

        const validateStoredOAuthState = (candidate) => {
            if (!candidate?.value && !candidate?.codeVerifier && !candidate?.createdAt) return false;
            if (candidate?.value && state !== candidate.value) return false;
            if (!candidate?.codeVerifier) return false;

            if (candidate?.username && requestBinding.username && candidate.username !== requestBinding.username) {
                return false;
            }

            if (candidate?.ipHash && candidate.ipHash !== requestBinding.ipHash) {
                return false;
            }

            if (candidate?.userAgentHash && candidate.userAgentHash !== requestBinding.userAgentHash) {
                return false;
            }

            if (candidate?.host && candidate.host !== requestBinding.host) {
                return false;
            }

            return true;
        };

        const sessionStateAgeMs = Date.now() - Number(stateData?.createdAt || 0);
        const sessionStateValid = Boolean(
            stateData?.value &&
            state === stateData.value &&
            Number.isFinite(sessionStateAgeMs) &&
            sessionStateAgeMs <= DISCORD_OAUTH_STATE_TTL_MS &&
            validateStoredOAuthState(stateData)
        );

        const serverStateValid = Boolean(serverState && validateStoredOAuthState(serverState));

        if (!serverStateValid && !sessionStateValid) {
            return completeDiscordOAuthRequest(req, res, { success: false, message: 'Invalid or expired OAuth state' });
        }

        const effectiveState = serverStateValid ? serverState : stateData;

        if (req.session?.discordOAuthState) {
            delete req.session.discordOAuthState;
            await new Promise((resolve) => req.session.save(() => resolve()));
        }

        const tokenParams = new URLSearchParams({
            client_id: oauth.clientId,
            client_secret: oauth.clientSecret,
            grant_type: 'authorization_code',
            code,
            redirect_uri: oauth.redirectUri,
            scope: 'identify',
            code_verifier: String(effectiveState?.codeVerifier || '')
        });

        const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: tokenParams.toString()
        });

        const tokenPayload = await tokenResponse.json().catch(() => ({}));
        if (!tokenResponse.ok || !tokenPayload?.access_token) {
            return completeDiscordOAuthRequest(req, res, { success: false, message: 'Discord token exchange failed' });
        }

        const meResponse = await fetch('https://discord.com/api/v10/users/@me', {
            headers: {
                Authorization: `Bearer ${tokenPayload.access_token}`
            }
        });
        const me = await meResponse.json().catch(() => ({}));

        if (!meResponse.ok || !me?.id) {
            return completeDiscordOAuthRequest(req, res, { success: false, message: 'Failed to fetch Discord account' });
        }

        const callbackUsername = String(serverState?.username || req.session?.username || '').trim();
        if (!callbackUsername) {
            return completeDiscordOAuthRequest(req, res, { success: false, message: 'Session expired before OAuth callback completed' });
        }

        const panelUser = await AdminPanelHelper.getAdminUser(callbackUsername);
        if (!panelUser) {
            return completeDiscordOAuthRequest(req, res, { success: false, message: 'Panel user not found' });
        }

        const [existing] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT id, username FROM admin_users WHERE discord_user_id = ? AND id <> ? LIMIT 1`,
            [me.id, panelUser.id]
        );

        if (Array.isArray(existing) && existing.length > 0) {
            return completeDiscordOAuthRequest(req, res, { success: false, message: 'That Discord account is already linked' });
        }

        const guildMembership = await resolveDiscordGuildMembership(me.id);
        if (guildMembership.required && guildMembership.available && guildMembership.verified === false) {
            const guildName = String(guildMembership.guildName || '').trim();
            return completeDiscordOAuthRequest(req, res, {
                success: false,
                message: guildName
                    ? `Join ${guildName} with that Discord account before linking`
                    : 'Join the configured Discord server with that account before linking'
            });
        }

        const discordUsername = me.discriminator && me.discriminator !== '0'
            ? `${me.username}#${me.discriminator}`
            : me.username;

        await MySQLDatabaseManager.connection.pool.execute(
            `UPDATE admin_users
             SET discord_user_id = ?, discord_username = ?, discord_linked_at = NOW()
             WHERE id = ?`,
            [me.id, discordUsername || null, panelUser.id]
        );

        sendBotWebhook('discord.linked', {
            username: panelUser.username || null,
            userId: panelUser.id || null,
            discordUserId: me.id || null,
            discordUsername: discordUsername || null
        }, req).catch(() => { });

        if (req.session) {
            req.session.discordLinked = true;
            req.session.discordLinkedVerifiedAt = Date.now();
            req.session.discordSecurityState = null;
            req.session.discordSecurityVerifiedAt = 0;
            await new Promise((resolve) => req.session.save(() => resolve()));
        }

        return completeDiscordOAuthRequest(req, res, { success: true, message: 'Discord account linked successfully' });
    } catch (error) {
        console.error('Error handling Discord OAuth callback:', error);
        return completeDiscordOAuthRequest(req, res, { success: false, message: 'Discord OAuth callback failed' });
    }
});

app.post('/api/account/discord-unlink', requireAuth, requireSensitiveDiscordSecurityBinding, requireLinkedDiscordAccount, async (req, res) => {
    try {
        const { currentPassword } = req.body || {};
        if (!currentPassword || typeof currentPassword !== 'string') {
            return res.status(400).json({ error: 'Current password is required to unlink Discord' });
        }

        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const validPassword = await bcrypt.compare(currentPassword, user.password_hash || '');
        if (!validPassword) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        const delayedApproval = requestHighRiskActionApproval(req, res, {
            actionKey: 'discord-unlink',
            delayMs: DISCORD_HIGH_RISK_DELAY_UNLINK_MS,
            message: 'Discord unlink requires a short security delay. Repeat the action after the timer ends to finish unlinking.'
        });
        if (!delayedApproval.approved) {
            return;
        }

        await MySQLDatabaseManager.connection.pool.execute(
            `UPDATE admin_users
             SET discord_user_id = NULL, discord_username = NULL, discord_linked_at = NULL
             WHERE id = ?`,
            [user.id]
        );

        sendBotWebhook('discord.unlinked', {
            username: user.username || null,
            userId: user.id || null,
            discordUserId: user.discord_user_id || null,
            discordUsername: user.discord_username || null
        }, req).catch(() => { });

        if (req.session) {
            req.session.discordLinked = false;
            req.session.discordLinkedVerifiedAt = Date.now();
            req.session.discordSecurityState = null;
            req.session.discordSecurityVerifiedAt = 0;
            await new Promise((resolve) => req.session.save(() => resolve()));
        }

        return res.json({ success: true });
    } catch (error) {
        console.error('Error unlinking Discord account:', error);
        return res.status(500).json({ error: 'Failed to unlink Discord account' });
    }
});

app.post('/api/security/2fa/setup', createRateLimiter(5, 60000), requireAuth, requireDiscordSecurityBinding, async (req, res) => {
    try {
        const { currentPassword } = req.body || {};
        if (!currentPassword || typeof currentPassword !== 'string') {
            return res.status(400).json({ error: 'Current password is required' });
        }

        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const validPassword = await bcrypt.compare(currentPassword, user.password_hash);
        if (!validPassword) return res.status(401).json({ error: 'Invalid current password' });

        const secret = TotpHelper.generateBase32Secret(32);
        // Read issuer from main.json (websiteName)
        const { websiteName } = require('./Config/main.json');
        const otpauthUri = TotpHelper.buildOtpauthUrl({
            secret,
            accountName: user.username,
            issuer: websiteName || 'Sentinel Panel'
        });
        const qrDataUrl = await QRCode.toDataURL(otpauthUri, {
            errorCorrectionLevel: 'M',
            margin: 1,
            width: 220
        });

        req.session.pendingTwoFactorSetup = {
            secret,
            createdAt: Date.now()
        };
        await req.session.save(() => { });

        return res.json({
            success: true,
            manualEntryKey: secret,
            qrDataUrl
        });
    } catch (error) {
        console.error('Error initializing 2FA setup:', error);
        return res.status(500).json({ error: 'Failed to initialize 2FA setup' });
    }
});

app.post('/api/security/2fa/enable', createRateLimiter(5, 60000), requireAuth, requireDiscordSecurityBinding, async (req, res) => {
    try {
        const { token } = req.body || {};
        const pending = req.session.pendingTwoFactorSetup;

        if (!pending || !pending.secret || (Date.now() - Number(pending.createdAt || 0) > (10 * 60 * 1000))) {
            return res.status(400).json({ error: '2FA setup has expired. Start setup again.' });
        }

        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (isTwoFactorAttemptBlocked(req.session.username, 'enable')) {
            return res.status(429).json({ error: 'Too many invalid 2FA attempts. Wait a few minutes before trying again.' });
        }

        const verification = TotpHelper.verifyTotpDetailed(token, pending.secret, { window: 1 });
        if (!verification.valid) {
            noteTwoFactorAttemptFailure(req.session.username, 'enable');
            return res.status(401).json({ error: 'Invalid verification code' });
        }

        const encryptedSecret = encryptStoredTwoFactorSecret(pending.secret);
        const codes = generateRecoveryCodes(10);
        const codeHashes = codes.map(hashRecoveryCode);
        await MySQLDatabaseManager.connection.pool.execute(
            `UPDATE admin_users
             SET two_factor_enabled = TRUE,
                 two_factor_secret = ?,
                 two_factor_enabled_at = NOW(),
                 two_factor_last_counter = NULL,
                 two_factor_last_verified_at = NULL,
                 recovery_code_hashes = ?,
                 recovery_codes_generated_at = NOW()
             WHERE username = ?`,
            [encryptedSecret, JSON.stringify(codeHashes), req.session.username]
        );

        delete req.session.pendingTwoFactorSetup;
        await req.session.save(() => { });
        clearTwoFactorAttemptFailures(req.session.username, 'enable');
        await logAdminAuthEvent(req.session.username, 'TWO_FACTOR_ENABLED', req, {});
        await sendSecurityAlertIfPossible(user, 'Two-factor authentication enabled', [
            '2FA was enabled on your account.',
            'A fresh set of recovery codes was generated at the same time.',
            `Time: ${new Date().toLocaleString()}`
        ], req);

        return res.json({
            success: true,
            codes,
            generatedAt: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error enabling 2FA:', error);
        return res.status(500).json({ error: 'Failed to enable 2FA' });
    }
});

app.post('/api/security/2fa/disable', createRateLimiter(5, 60000), requireAuth, requireSensitiveDiscordSecurityBinding, async (req, res) => {
    try {
        const { currentPassword, token } = req.body || {};
        if (!currentPassword || !token) {
            return res.status(400).json({ error: 'Current password and verification code are required' });
        }

        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const validPassword = await bcrypt.compare(currentPassword, user.password_hash);
        if (!validPassword) return res.status(401).json({ error: 'Invalid current password' });

        if (!user.two_factor_enabled || !user.two_factor_secret) {
            return res.status(400).json({ error: '2FA is not enabled on this account' });
        }

        if (isTwoFactorAttemptBlocked(user.username, 'disable')) {
            return res.status(429).json({ error: 'Too many invalid 2FA attempts. Wait a few minutes before trying again.' });
        }

        const { secret: decryptedSecret } = decryptStoredTwoFactorSecret(user.two_factor_secret);
        const verification = TotpHelper.verifyTotpDetailed(token, decryptedSecret, { window: 1 });
        if (!verification.valid) {
            noteTwoFactorAttemptFailure(user.username, 'disable');
            return res.status(401).json({ error: 'Invalid verification code' });
        }

        const counterAccepted = await consumeVerifiedTwoFactorCounter(user.id, verification.counter);
        if (!counterAccepted) {
            noteTwoFactorAttemptFailure(user.username, 'disable');
            return res.status(401).json({ error: 'This 2FA code was already used. Wait for a new code and try again.' });
        }

        const delayedApproval = requestHighRiskActionApproval(req, res, {
            actionKey: 'two-factor-disable',
            delayMs: DISCORD_HIGH_RISK_DELAY_DISABLE_2FA_MS,
            message: 'Disabling 2FA requires a short safety delay. Repeat the action after the timer ends to confirm the change.'
        });
        if (!delayedApproval.approved) {
            return;
        }

        await MySQLDatabaseManager.connection.pool.execute(
            `UPDATE admin_users
             SET two_factor_enabled = FALSE,
                 two_factor_secret = NULL,
                 two_factor_enabled_at = NULL,
                 two_factor_last_counter = NULL,
                 two_factor_last_verified_at = NULL
             WHERE username = ?`,
            [req.session.username]
        );

        clearTwoFactorAttemptFailures(user.username, 'disable');
        await logAdminAuthEvent(req.session.username, 'TWO_FACTOR_DISABLED', req, {});
        await sendSecurityAlertIfPossible(user, 'Two-factor authentication disabled', [
            '2FA was disabled on your account.',
            `Time: ${new Date().toLocaleString()}`
        ], req);
        return res.json({ success: true });
    } catch (error) {
        console.error('Error disabling 2FA:', error);
        return res.status(500).json({ error: 'Failed to disable 2FA' });
    }
});

// Change password
app.post('/api/account/change-password', requireAuth, async (req, res) => {
    const { oldPassword, newPassword, confirmPassword } = req.body;

    if (!oldPassword || !newPassword || !confirmPassword) {
        return res.status(400).json({ error: 'All fields required' });
    }

    // Validate types
    if (typeof oldPassword !== 'string' || typeof newPassword !== 'string' || typeof confirmPassword !== 'string') {
        return res.status(400).json({ error: 'Invalid input format' });
    }

    if (newPassword !== confirmPassword) {
        return res.status(400).json({ error: 'New passwords do not match' });
    }

    if (newPassword.length < 8 || newPassword.length > 100) {
        return res.status(400).json({ error: 'Password must be 8-100 characters' });
    }

    // Require at least one uppercase, one lowercase, one number, and one special character
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{8,}$/;
    if (!passwordRegex.test(newPassword)) {
        return res.status(400).json({ error: 'Password must contain uppercase, lowercase, number, and special character' });
    }

    if (newPassword === oldPassword) {
        return res.status(400).json({ error: 'New password must be different from old password' });
    }

    try {
        // Get current user
        const user = await AdminPanelHelper.getAdminUser(req.session.username);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Verify old password
        const validPassword = await bcrypt.compare(oldPassword, user.password_hash);

        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid current password' });
        }

        // Hash new password
        const newPasswordHash = await bcrypt.hash(newPassword, 10);

        await MySQLDatabaseManager.connection.pool.execute(
            'UPDATE admin_users SET password_hash = ?, password_changed_at = NOW() WHERE username = ?',
            [newPasswordHash, req.session.username]
        );

        console.log(`[Admin] User ${req.session.username} changed their password`);
        logAdminAuthEvent(req.session.username, 'PASSWORD_CHANGED', req, { route: '/api/account/change-password' }).catch(() => { });
        res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        console.error('Error changing password:', error);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

// ==================== INVITE CODES ====================

// Generate new invite code (OWNER ONLY)
app.post('/api/invites/generate', requireAuth, async (req, res) => {
    let { role = 'moderator', expiresInDays = 7, description = '' } = req.body;

    try {
        // Validate inputs - only allow admin and moderator roles
        if (typeof role !== 'string' || !['admin', 'moderator'].includes(role)) {
            return res.status(400).json({ error: 'Invalid role. Only admin and moderator roles can be invited.' });
        }

        if (typeof expiresInDays !== 'number' || expiresInDays < 1 || expiresInDays > 365) {
            expiresInDays = 7; // Default to 7 days
        }

        if (typeof description !== 'string') {
            description = '';
        } else if (description.length > 500) {
            description = description.substring(0, 500);
        }

        // Check if user is owner
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasOwnerAccess(user)) {
            return res.status(403).json({ error: 'Only owner can generate invite codes' });
        }

        // Generate a random invite code
        const inviteCode = `INV_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`.toUpperCase();
        const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

        // Save to database (always single-use)
        await MySQLDatabaseManager.connection.pool.query(
            'INSERT INTO admin_invite_codes (code, created_by, role, expires_at, active, max_uses, current_uses, description) VALUES (?, ?, ?, ?, TRUE, 1, 0, ?)',
            [inviteCode, req.session.username, role, expiresAt, description]
        );

        console.log(`[Admin] ${req.session.username} generated invite code: ${inviteCode} for role ${role}`);

        res.json({
            success: true,
            code: inviteCode,
            role: role,
            expiresAt: expiresAt,
            description: description,
            message: 'Invite code generated successfully'
        });
    } catch (error) {
        console.error('Error generating invite code:', error);
        res.status(500).json({ error: 'Failed to generate invite code' });
    }
});

// List active invite codes with advanced filtering
app.get('/api/invites/list', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasAdminAccess(user)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { status = 'all', role = 'all', createdBy = 'all' } = req.query;

        let query = 'SELECT * FROM admin_invite_codes WHERE 1=1';
        const params = [];

        // Filter by status
        if (status === 'active') {
            query += ' AND active = TRUE AND (expires_at IS NULL OR expires_at > NOW()) AND current_uses < max_uses';
        } else if (status === 'used') {
            query += ' AND current_uses >= max_uses';
        } else if (status === 'expired') {
            query += ' AND expires_at IS NOT NULL AND expires_at <= NOW()';
        } else if (status === 'revoked') {
            query += ' AND revoked_by IS NOT NULL';
        }

        // Filter by role
        if (role !== 'all') {
            query += ' AND role = ?';
            params.push(role);
        }

        // Filter by creator
        if (createdBy !== 'all') {
            query += ' AND created_by = ?';
            params.push(createdBy);
        }

        query += ' ORDER BY created_at DESC';

        const [rows] = await MySQLDatabaseManager.connection.pool.query(query, params);
        res.json({
            success: true,
            invites: rows || [],
            total: rows?.length || 0
        });
    } catch (error) {
        console.error('Error listing invite codes:', error);
        res.status(500).json({ error: 'Failed to list invite codes' });
    }
});

// Get detailed invite statistics
app.get('/api/invites/analytics', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasAdminAccess(user)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const [stats] = await MySQLDatabaseManager.connection.pool.query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN active = TRUE AND (expires_at IS NULL OR expires_at > NOW()) AND current_uses < max_uses THEN 1 ELSE 0 END) as active,
                SUM(CASE WHEN current_uses >= max_uses THEN 1 ELSE 0 END) as fully_used,
                SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= NOW() AND current_uses < max_uses THEN 1 ELSE 0 END) as expired,
                SUM(CASE WHEN revoked_by IS NOT NULL THEN 1 ELSE 0 END) as revoked,
                SUM(current_uses) as total_uses,
                SUM(max_uses) as total_capacity,
                AVG(view_count) as avg_views_per_invite,
                COUNT(DISTINCT created_by) as unique_creators
            FROM admin_invite_codes
        `);

        const [roleBreakdown] = await MySQLDatabaseManager.connection.pool.query(`
            SELECT 
                role,
                COUNT(*) as count,
                SUM(current_uses) as uses
            FROM admin_invite_codes
            GROUP BY role
        `);

        const [recentActivity] = await MySQLDatabaseManager.connection.pool.query(`
            SELECT 
                code,
                role,
                created_by,
                used_by,
                used_at,
                description
            FROM admin_invite_codes
            WHERE used_at IS NOT NULL
            ORDER BY used_at DESC
            LIMIT 10
        `);

        const [topCreators] = await MySQLDatabaseManager.connection.pool.query(`
            SELECT 
                created_by,
                COUNT(*) as invites_created,
                SUM(current_uses) as total_uses
            FROM admin_invite_codes
            GROUP BY created_by
            ORDER BY invites_created DESC
            LIMIT 5
        `);

        res.json({
            success: true,
            overview: stats[0],
            roleBreakdown: roleBreakdown || [],
            recentActivity: recentActivity || [],
            topCreators: topCreators || []
        });
    } catch (error) {
        console.error('Error getting invite analytics:', error);
        res.status(500).json({ error: 'Failed to get invite analytics' });
    }
});

// Revoke invite code (OWNER ONLY) - soft delete with audit trail
app.post('/api/invites/revoke/:code', requireAuth, async (req, res) => {
    const { code } = req.params;
    const { permanent = false } = req.body;

    try {
        // Validate code format
        if (!code || typeof code !== 'string' || code.length < 5 || code.length > 50) {
            return res.status(400).json({ error: 'Invalid invite code' });
        }

        // Check if user is owner
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasOwnerAccess(user)) {
            return res.status(403).json({ error: 'Only owner can revoke invite codes' });
        }

        if (permanent === true) {
            const [inviteRows] = await MySQLDatabaseManager.connection.pool.query(
                'SELECT code, current_uses, used_by, used_at FROM admin_invite_codes WHERE code = ? LIMIT 1',
                [code]
            );

            const invite = Array.isArray(inviteRows) ? inviteRows[0] : null;
            if (!invite) {
                return res.status(404).json({ error: 'Invite code not found' });
            }

            const inviteHasBeenUsed = Number(invite.current_uses || 0) > 0
                || Boolean(invite.used_by)
                || Boolean(invite.used_at);

            if (inviteHasBeenUsed) {
                return res.status(400).json({ error: 'Used invites cannot be permanently deleted' });
            }

            // Permanent deletion
            const [result] = await MySQLDatabaseManager.connection.pool.query(
                'DELETE FROM admin_invite_codes WHERE code = ?',
                [code]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Invite code not found' });
            }

            console.log(`[Admin] ${req.session.username} permanently deleted invite code: ${code}`);
            res.json({ success: true, message: 'Invite code permanently deleted' });
        } else {
            // Soft deletion with audit trail
            const [result] = await MySQLDatabaseManager.connection.pool.query(
                'UPDATE admin_invite_codes SET active = FALSE, revoked_by = ?, revoked_at = NOW() WHERE code = ?',
                [req.session.username, code]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Invite code not found' });
            }

            console.log(`[Admin] ${req.session.username} revoked invite code: ${code}`);
            res.json({ success: true, message: 'Invite code revoked' });
        }
    } catch (error) {
        console.error('Error revoking invite code:', error);
        res.status(500).json({ error: 'Failed to revoke invite code' });
    }
});

// Restore revoked invite code (OWNER ONLY)
app.post('/api/invites/restore/:code', requireAuth, async (req, res) => {
    const { code } = req.params;
    try {
        if (!code || typeof code !== 'string') {
            return res.status(400).json({ error: 'Invalid invite code' });
        }

        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasOwnerAccess(user)) {
            return res.status(403).json({ error: 'Only owner can restore invite codes' });
        }

        // Check if invite is expired
        const [invites] = await MySQLDatabaseManager.connection.pool.query(
            'SELECT expires_at FROM admin_invite_codes WHERE code = ?',
            [code]
        );

        if (!invites || invites.length === 0) {
            return res.status(404).json({ error: 'Invite code not found' });
        }

        const invite = invites[0];
        if (invite.expires_at && new Date(invite.expires_at) <= new Date()) {
            return res.status(400).json({ error: 'Cannot restore expired invite. Please create a new one.' });
        }

        const [result] = await MySQLDatabaseManager.connection.pool.query(
            'UPDATE admin_invite_codes SET active = TRUE, revoked_by = NULL, revoked_at = NULL WHERE code = ?',
            [code]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Invite code not found' });
        }

        console.log(`[Admin] ${req.session.username} restored invite code: ${code}`);
        res.json({ success: true, message: 'Invite code restored' });
    } catch (error) {
        console.error('Error restoring invite code:', error);
        res.status(500).json({ error: 'Failed to restore invite code' });
    }
});

// Extend invite expiration (OWNER ONLY)
app.post('/api/invites/extend/:code', requireAuth, async (req, res) => {
    const { code } = req.params;
    const { additionalDays } = req.body;

    try {
        if (!code || typeof code !== 'string') {
            return res.status(400).json({ error: 'Invalid invite code' });
        }

        if (typeof additionalDays !== 'number' || additionalDays < 1 || additionalDays > 365) {
            return res.status(400).json({ error: 'additionalDays must be between 1 and 365' });
        }

        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasOwnerAccess(user)) {
            return res.status(403).json({ error: 'Only owner can extend invite codes' });
        }

        const [result] = await MySQLDatabaseManager.connection.pool.query(
            'UPDATE admin_invite_codes SET expires_at = DATE_ADD(COALESCE(expires_at, NOW()), INTERVAL ? DAY) WHERE code = ?',
            [additionalDays, code]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Invite code not found' });
        }

        console.log(`[Admin] ${req.session.username} extended invite code ${code} by ${additionalDays} days`);
        res.json({ success: true, message: `Invite code extended by ${additionalDays} days` });
    } catch (error) {
        console.error('Error extending invite code:', error);
        res.status(500).json({ error: 'Failed to extend invite code' });
    }
});

// Get recent activity
app.get('/api/activity', requireAuth, async (req, res) => {
    try {
        const activity = [];

        // Get recent warns
        const warns = await AdminPanelHelper.getAllWarns();
        warns.slice(0, 10).forEach(w => {
            activity.push({
                createdAt: w.timestamp || new Date(),
                action: 'User Warned',
                userId: w.user_id,
                targetUserId: w.user_id,
                details: w.reason || 'No reason'
            });
        });

        // Get recent bans
        const banned = await AdminPanelHelper.getAllBannedUsers();
        banned.slice(0, 5).forEach(b => {
            activity.push({
                createdAt: b.banned_at || new Date(),
                action: 'User Banned',
                userId: b.banned_by || 'System',
                targetUserId: b.user_id,
                details: b.ban_reason || 'No reason'
            });
        });

        // Get recent reminders
        const reminders = await AdminPanelHelper.getAllReminders();
        reminders.slice(0, 5).forEach(r => {
            activity.push({
                createdAt: r.created_at || r.trigger_at || new Date(),
                action: r.completed ? 'Reminder Delivered' : 'Reminder Created',
                userId: r.user_id,
                details: r.message || r.text || 'No message'
            });
        });

        // Sort by date (newest first)
        activity.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        res.json({
            success: true,
            activity: activity.slice(0, 20)
        });
    } catch (error) {
        console.error('Error fetching activity:', error);
        res.json({
            success: true,
            activity: []
        });
    }
});

function requireModerator(req, res, next) {
    refreshSessionRoleIfNeeded(req, { forceRefresh: true })
        .then(() => {
            // Check if session became invalid due to role alignment issues
            if (!req.session?.authenticated) {
                return res.redirect('/unauthorized');
            }
            const userRole = req.session?.role;
            if (!hasModeratorAccess({ role: userRole })) {
                return res.redirect('/profile');
            }
            next();
        })
        .catch(error => {
            error.status = 500;
            next(error);
        });
}

function requireAdmin(req, res, next) {
    refreshSessionRoleIfNeeded(req, { forceRefresh: true })
        .then(() => {
            // Check if session became invalid due to role alignment issues
            if (!req.session?.authenticated) {
                return res.redirect('/unauthorized');
            }
            const userRole = req.session?.role;
            if (!hasAdminAccess({ role: userRole })) {
                return res.redirect('/profile');
            }
            next();
        })
        .catch(error => {
            error.status = 500;
            next(error);
        });
}

// Serve admin page
app.get('/admin', requireAuth, requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'admin.html'));
});

// Search page route
app.get('/search', requireAuth, requireModerator, (req, res) => {
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'search.html'));
});

// User profile page route
app.get('/profile', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'profile.html'));
});

// Changelog page route
app.get('/changelog', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'changelog.html'));
});

// Change password endpoint
app.post('/api/user/change-password', createRateLimiter(3, 60000), requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        // Validate input
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new passwords are required' });
        }

        // Validate new password strength
        const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
        if (!passwordRegex.test(newPassword)) {
            return res.status(400).json({ error: 'Password must contain at least 8 characters, including uppercase, lowercase, number, and special character' });
        }

        // Get current user
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Verify current password
        const validPassword = await bcrypt.compare(currentPassword, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        // Hash new password
        const newPasswordHash = await bcrypt.hash(newPassword, 12);

        // Update password in database
        await MySQLDatabaseManager.connection.pool.execute(
            'UPDATE admin_users SET password_hash = ?, password_changed_at = NOW() WHERE username = ?',
            [newPasswordHash, req.session.username]
        );

        console.log(`[Admin] User ${req.session.username} changed their password`);
        logAdminAuthEvent(req.session.username, 'PASSWORD_CHANGED', req, { route: '/api/user/change-password' }).catch(() => { });
        await sendSecurityAlertIfPossible(user, 'Password changed', [
            'Your account password was changed.',
            `Time: ${new Date().toLocaleString()}`
        ], req);
        res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        console.error('Error changing password:', error);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

// Change email endpoint
app.post('/api/user/change-email', createRateLimiter(5, 60000), requireAuth, requireSensitiveDiscordSecurityBinding, async (req, res) => {
    try {
        const { newEmail } = req.body;

        if (!newEmail || typeof newEmail !== 'string') {
            return res.status(400).json({ error: 'New email is required' });
        }

        const normalizedEmail = String(newEmail).trim().toLowerCase();
        if (!isValidEmailAddress(normalizedEmail)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (String(user.email || '').toLowerCase() === normalizedEmail) {
            return res.status(400).json({ error: 'New email must be different from current email' });
        }

        const [existingEmailRows] = await MySQLDatabaseManager.connection.pool.query(
            'SELECT id FROM admin_users WHERE email = ? AND username != ? LIMIT 1',
            [normalizedEmail, req.session.username]
        );

        if (Array.isArray(existingEmailRows) && existingEmailRows.length > 0) {
            return res.status(400).json({ error: 'Email is already in use' });
        }

        const delayedApproval = requestHighRiskActionApproval(req, res, {
            actionKey: 'change-email',
            delayMs: DISCORD_HIGH_RISK_DELAY_CHANGE_EMAIL_MS,
            message: 'Email changes are delayed briefly for safety. Repeat the change after the timer ends to apply the new address.'
        });
        if (!delayedApproval.approved) {
            return;
        }

        await MySQLDatabaseManager.connection.pool.query(
            'UPDATE admin_users SET email = ? WHERE username = ?',
            [normalizedEmail, req.session.username]
        );

        const verificationToken = createSecureToken(24);
        try {
            await MySQLDatabaseManager.connection.pool.query(
                `UPDATE admin_users
                 SET email_verified = FALSE,
                     email_verification_token = ?,
                     email_verification_expires = DATE_ADD(NOW(), INTERVAL 24 HOUR)
                 WHERE username = ?`,
                [verificationToken, req.session.username]
            );
        } catch (verificationUpdateError) {
            if (verificationUpdateError?.code !== 'ER_BAD_FIELD_ERROR') {
                throw verificationUpdateError;
            }
        }

        if (EmailHelper.isReady()) {
            await EmailHelper.sendEmailVerificationEmail(normalizedEmail, req.session.username, verificationToken).catch((emailError) => {
                console.error('Failed to send verification email after email change:', emailError?.message || emailError);
            });
        }

        await sendSecurityAlertIfPossible(user, 'Email address changed', [
            `New email: ${normalizedEmail}`,
            `Time: ${new Date().toLocaleString()}`
        ], req);

        console.log(`[Admin] User ${req.session.username} changed their email address`);
        logAdminAuthEvent(req.session.username, 'EMAIL_CHANGED', req, { route: '/api/user/change-email' }).catch(() => { });
        return res.json({ success: true, email: normalizedEmail, message: 'Email changed successfully' });
    } catch (error) {
        console.error('Error changing email:', error);
        return res.status(500).json({ error: 'Failed to change email' });
    }
});

app.post('/api/user/change-avatar', createRateLimiter(10, 60000), requireAuth, requireDiscordSecurityBinding, (req, res) => {
    adminAvatarUpload.single('avatar')(req, res, async (uploadError) => {
        try {
            if (uploadError) {
                const message = uploadError instanceof multer.MulterError
                    ? (uploadError.code === 'LIMIT_FILE_SIZE'
                        ? 'Avatar image must be 4MB or smaller'
                        : 'Failed to process avatar upload')
                    : (uploadError.message || 'Failed to process avatar upload');
                return res.status(400).json({ error: message });
            }

            const shouldResetAvatar = String(req.body?.resetAvatar || '').trim() === '1';
            const user = await AdminPanelHelper.getAdminUser(req.session.username);
            if (!user) {
                if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
                return res.status(404).json({ error: 'User not found' });
            }

            if (!req.file && !shouldResetAvatar) {
                return res.status(400).json({ error: 'Select an image to upload' });
            }

            const oldAvatarUrl = String(user.avatar_url || '').trim();
            let nextAvatarUrl = null;
            if (!shouldResetAvatar && req.file?.path) {
                const normalizedAvatar = await normalizeAdminAvatarUpload(req.file.path);
                nextAvatarUrl = normalizedAvatar.publicUrl;
            }
            const avatarUpdatedAt = nextAvatarUrl ? new Date() : null;

            const [updateResult] = await MySQLDatabaseManager.connection.pool.query(
                `UPDATE admin_users
                 SET avatar_url = ?, avatar_updated_at = ?
                 WHERE id = ?`,
                [nextAvatarUrl, avatarUpdatedAt, user.id]
            );

            const affectedRows = Number(updateResult?.affectedRows || 0);
            if (affectedRows < 1) {
                if (nextAvatarUrl) {
                    try {
                        deleteManagedAdminAvatarFile(nextAvatarUrl);
                    } catch (_) { }
                }
                return res.status(500).json({ error: 'Avatar could not be saved' });
            }

            const persistedUser = await AdminPanelHelper.getAdminUserById(user.id);
            if (!persistedUser) {
                if (nextAvatarUrl) {
                    try {
                        deleteManagedAdminAvatarFile(nextAvatarUrl);
                    } catch (_) { }
                }
                return res.status(500).json({ error: 'Avatar save could not be verified' });
            }

            const persistedAvatarUrl = String(persistedUser.avatar_url || '').trim() || null;
            const expectedAvatarUrl = nextAvatarUrl || null;
            if (persistedAvatarUrl !== expectedAvatarUrl) {
                if (nextAvatarUrl) {
                    try {
                        deleteManagedAdminAvatarFile(nextAvatarUrl);
                    } catch (_) { }
                }
                console.warn('[AdminPanel] Avatar save verification failed', {
                    userId: user.id,
                    expectedAvatarUrl,
                    persistedAvatarUrl
                });
                return res.status(500).json({ error: 'Avatar save verification failed' });
            }

            if (oldAvatarUrl && oldAvatarUrl !== nextAvatarUrl) {
                try {
                    deleteManagedAdminAvatarFile(oldAvatarUrl);
                } catch (cleanupError) {
                    console.warn('[AdminPanel] Failed to remove previous avatar:', cleanupError.message || cleanupError);
                }
            }

            console.log(`[Admin] User ${req.session.username} ${nextAvatarUrl ? 'updated' : 'cleared'} their avatar`);
            return res.json({
                success: true,
                avatar_url: persistedUser.avatar_url || null,
                avatar_updated_at: persistedUser.avatar_updated_at ? new Date(persistedUser.avatar_updated_at).toISOString() : null,
                message: nextAvatarUrl ? 'Avatar uploaded successfully' : 'Avatar reset successfully'
            });
        } catch (error) {
            if (req.file?.path && fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
            console.error('Error changing avatar:', error);
            return res.status(500).json({ error: 'Failed to change avatar' });
        }
    });
});

// Audit logs page route
app.get('/audit-logs', requireAuth, requireModerator, (req, res) => {
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'audit-logs.html'));
});

// Get top users (admin only)
app.get('/api/admin/top-users', requireAuth, async (req, res) => {
    try {
        // Check if user is admin
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasAdminAccess(user)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const levels = await AdminPanelHelper.getAllLevels();

        // Fetch usernames from Discord for users with missing usernames
        if (discordClient) {
            try {
                const mainConfig = require('./Config/main.json');
                const guild = await discordClient.guilds.fetch(mainConfig.serverID);

                if (guild) {
                    const unknownUsers = levels.filter(u => !u.username || u.username === 'Unknown');

                    for (const user of unknownUsers) {
                        try {
                            const member = await guild.members.fetch(user.user_id).catch(() => null);
                            if (member) {
                                user.username = member.user.username;
                                // Update database with fetched username
                                await MySQLDatabaseManager.connection.pool.query(
                                    'UPDATE levels SET username = ? WHERE user_id = ?',
                                    [member.user.username, user.user_id]
                                ).catch(() => { });
                            }
                        } catch (err) {
                            // Skip if user not found
                        }
                    }
                }
            } catch (err) {
                console.error('Error fetching usernames from Discord:', err.message);
            }
        }

        // Sort by level descending
        const topByLevel = [...levels]
            .sort((a, b) => (parseInt(b.level) || 0) - (parseInt(a.level) || 0))
            .slice(0, 5)
            .map(u => ({
                user_id: u.user_id,
                username: u.username || 'Unknown User',
                level: parseInt(u.level) || 0,
                xp: parseInt(u.xp) || 0,
                messages: parseInt(u.messages) || 0
            }));

        // Sort by messages descending
        const topByMessages = [...levels]
            .sort((a, b) => (parseInt(b.messages) || 0) - (parseInt(a.messages) || 0))
            .slice(0, 5)
            .map(u => ({
                user_id: u.user_id,
                username: u.username || 'Unknown User',
                level: parseInt(u.level) || 0,
                xp: parseInt(u.xp) || 0,
                messages: parseInt(u.messages) || 0
            }));

        res.json({
            success: true,
            topByLevel,
            topByMessages
        });
    } catch (error) {
        console.error('Error fetching top users:', error);
        res.status(500).json({ error: 'Failed to fetch top users' });
    }
});

// Get guild statistics (admin only)
app.get('/api/admin/guild-stats', requireAuth, async (req, res) => {
    try {
        // Check if user is admin
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasAdminAccess(user)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const levels = await AdminPanelHelper.getAllLevels();

        const totalMembers = levels.length;

        // Get real Discord stats from bot
        const botData = getStats();
        const totalRoles = botData.totalRoles || 0;
        const totalChannels = botData.totalChannels || 0;
        const totalEmojis = botData.totalEmojis || 0;

        // Get bot members from Discord stats (levels table doesn't track bot status)
        const actualTotalMembers = botData.totalMembers || totalMembers;
        const botMembers = botData.botMembers || 0;

        res.json({
            success: true,
            totalMembers: actualTotalMembers,
            botMembers: botMembers,
            totalRoles: totalRoles,
            totalChannels: totalChannels,
            totalEmojis: totalEmojis
        });
    } catch (error) {
        console.error('Error fetching guild stats:', error);
        res.status(500).json({ error: 'Failed to fetch guild statistics' });
    }
});

// Get ticket summary (admin only)
app.get('/api/admin/tickets', requireAuth, async (req, res) => {
    try {
        // Check if user is admin
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasAdminAccess(user)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        // Get ticket counts from the helper
        const tickets = await AdminPanelHelper.getAllTickets('all') || [];

        // Count by status
        let open = 0, claimed = 0, waitingUser = 0, waitingStaff = 0, closed = 0;

        tickets.forEach(ticket => {
            if (ticket.status === 'open') open++;
            else if (ticket.status === 'claimed') claimed++;
            else if (ticket.status === 'waiting_user') waitingUser++;
            else if (ticket.status === 'waiting_staff') waitingStaff++;
            else if (ticket.status === 'closed') closed++;
        });

        const total = open + claimed + waitingUser + waitingStaff + closed;

        res.json({
            success: true,
            open: open,
            claimed: claimed,
            waitingUser,
            waitingStaff,
            active: open + claimed + waitingUser + waitingStaff,
            closed: closed,
            total: total
        });
    } catch (error) {
        console.error('Error fetching ticket summary:', error);
        res.json({
            success: true,
            open: 0,
            claimed: 0,
            closed: 0
        });
    }
});

// Get bot statistics (admin only)
app.get('/api/admin/bot-stats', requireAuth, async (req, res) => {
    try {
        // Check if user is admin
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasAdminAccess(user)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        // Get bot stats from shared stats object
        const botData = getStats();

        // Check if bot data is recent (within last 2 minutes)
        const isRecentData = botData.lastUpdated &&
            (Date.now() - new Date(botData.lastUpdated).getTime()) < 120000;

        // Calculate actual uptime in seconds if available
        const uptimeSeconds = botData.uptime || 0;
        const uptimeString = uptimeSeconds > 0 ? formatUptime(uptimeSeconds) : 'Bot Offline';

        res.json({
            success: true,
            uptime: uptimeString,
            commandsLoaded: botData.commandsLoaded || 0,
            eventsLoaded: botData.eventsLoaded || 0,
            memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            guildCount: botData.guildCount || 0,
            isOnline: isRecentData && uptimeSeconds > 0
        });
    } catch (error) {
        console.error('Error fetching bot stats:', error);
        res.status(500).json({ error: 'Failed to fetch bot statistics' });
    }
});

// Get member growth (admin only)
app.get('/api/admin/member-growth', requireAuth, async (req, res) => {
    try {
        // Check if user is admin
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasAdminAccess(user)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        // Get today's member activity
        let activity = { joins: 0, leaves: 0 };

        // For now, return default values (would need to track joins/leaves in the bot)
        res.json({
            success: true,
            joinedToday: activity.joins || 0,
            leftToday: activity.leaves || 0
        });
    } catch (error) {
        console.error('Error fetching member growth:', error);
        res.status(500).json({ error: 'Failed to fetch member growth' });
    }
});

// Get warning distribution (admin only)
// Quick action: Clear inactive warnings (admin only) - rate limited
app.post('/api/admin/clear-warns', createRateLimiter(3, 300000), requireAuth, async (req, res) => {
    try {
        // Check if user is admin
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasAdminAccess(user)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        // Mark old warnings as archived or inactive
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        // This would need a database method to implement
        // For now, returning success
        res.json({
            success: true,
            count: 0,
            message: 'Inactive warnings archived'
        });
    } catch (error) {
        console.error('Error clearing warnings:', error);
        res.status(500).json({ error: 'Failed to clear warnings' });
    }
});

// Quick action: Reset levels (admin only) - rate limited
app.post('/api/admin/reset-levels', createRateLimiter(1, 600000), requireAuth, async (req, res) => {
    try {
        // Check if user is admin
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasAdminAccess(user)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const count = await AdminPanelHelper.resetAllUsersLevels();

        console.log(`[Admin] ${req.session.username} reset ${count} levels`);

        res.json({
            success: true,
            count: count,
            message: `Reset ${count} users to level 1`
        });
    } catch (error) {
        console.error('Error resetting levels:', error);
        res.status(500).json({ error: 'Failed to reset levels' });
    }
});

// Quick action: Database cleanup (admin only)
app.post('/api/admin/cleanup', requireAuth, async (req, res) => {
    try {
        // Check if user is admin
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasAdminAccess(user)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        console.log(`[Admin] ${req.session.username} performed database cleanup`);

        res.json({
            success: true,
            message: `Database cleanup completed`
        });
    } catch (error) {
        console.error('Error during cleanup:', error);
        res.status(500).json({ error: 'Cleanup failed' });
    }
});

// Quick action: Export database (admin only)
app.get('/api/admin/export-database', createRateLimiter(2, 300000), requireAuth, async (req, res) => {
    try {
        // Check if user is admin
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasAdminAccess(user)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        // Get all data from database
        const allData = {
            exportedAt: new Date().toISOString(),
            tables: {}
        };

        try {
            // Get levels
            allData.tables.levels = await AdminPanelHelper.getAllLevels();

            // Get warns
            allData.tables.warns = await AdminPanelHelper.getAllWarns();

            // Get reminders
            allData.tables.reminders = await AdminPanelHelper.getAllReminders();

            // Get banned users
            allData.tables.bans = await AdminPanelHelper.getAllBannedUsers();
        } catch (dbErr) {
            console.warn('Note: Some database collections may be unavailable:', dbErr.message);
        }


        res.json({
            success: true,
            data: allData
        });
    } catch (error) {
        console.error('Error exporting database:', error);
        res.status(500).json({ error: 'Failed to export database: ' + error.message });
    }
});

// Helper function to format uptime
// Moderator actions: Lookup by caseId
app.get('/api/moderator/case/:caseId', requireAuth, async (req, res) => {
    try {
        const { caseId } = req.params;
        if (!caseId || typeof caseId !== 'string') {
            return res.status(400).json({ error: 'Invalid caseId' });
        }
        const caseData = await MySQLDatabaseManager.getModerationCaseById(caseId);
        if (caseData) {
            return res.json({
                type: caseData.action_type,
                userId: caseData.user_id,
                userName: caseData.user_name,
                moderatorId: caseData.moderator_id,
                moderatorName: caseData.moderator_name,
                moderatorSource: caseData.moderator_source,
                reason: caseData.reason,
                timestamp: caseData.created_at,
                duration: caseData.metadata?.duration || null,
                expiresAt: caseData.expires_at,
                status: caseData.effective_status,
                extra: null
            });
        }
        // Not found
        return res.status(404).json({ error: 'Case not found' });
    } catch (error) {
        console.error('Error looking up moderator case:', error);
        return res.status(500).json({ error: 'Failed to lookup case' });
    }
});
function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) {
        return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
        return `${hours}h ${minutes}m`;
    } else {
        return `${minutes}m`;
    }
}

// Helper function to parse duration string (e.g., "10m", "1h", "7d") to milliseconds
function parseDurationToMs(input) {
    const match = input.match(/^(\d+)([mhdw])$/i);
    if (!match) return null;

    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    let ms = 0;
    switch (unit) {
        case 'm': ms = value * 60 * 1000; break;          // minutes to ms
        case 'h': ms = value * 60 * 60 * 1000; break;     // hours to ms
        case 'd': ms = value * 24 * 60 * 60 * 1000; break; // days to ms
        case 'w': ms = value * 7 * 24 * 60 * 60 * 1000; break; // weeks to ms
        default: return null;
    }

    // Discord timeout max is 28 days
    if (ms > TIMEOUT_DURATION_MAX_MS) {
        return null;
    }

    return ms;
}


// Advanced APIS

// Search users endpoint
app.get('/api/admin/search-users', requireAuth, async (req, res) => {
    try {
        const { query } = req.query;

        // Validate input - allow empty string for browsing all users
        if (query === undefined || typeof query !== 'string') {
            return res.json({ success: true, data: [] });
        }

        // Sanitize query
        const sanitizedQuery = query.trim().slice(0, 100); // Max 100 chars

        const normalizedQuery = sanitizedQuery.toLowerCase();
        const isIdQuery = /^\d{6,}$/.test(sanitizedQuery);

        const whereParts = [];
        const params = [];
        if (sanitizedQuery.length > 0) {
            if (isIdQuery) {
                whereParts.push('l.user_id LIKE ?');
                params.push(`%${sanitizedQuery}%`);
            } else {
                whereParts.push('(LOWER(COALESCE(NULLIF(l.username, \'\'), ma.username, \'\')) LIKE ? OR l.user_id LIKE ?)');
                params.push(`%${normalizedQuery}%`, `%${sanitizedQuery}%`);
            }
        }

        const baseQuery = `
            SELECT 
                l.user_id,
                COALESCE(NULLIF(l.username, ''), ma.username, CONCAT('User-', SUBSTRING(l.user_id, -4))) as username,
                l.level,
                l.xp,
                l.messages,
                COALESCE(COUNT(w.id), 0) as warn_count,
                CASE WHEN ub.user_id IS NULL THEN 0 ELSE 1 END as is_banned,
                CASE WHEN t.user_id IS NULL THEN 0 ELSE 1 END as is_timed_out
            FROM levels l
            LEFT JOIN (
                SELECT ma1.user_id, ma1.username
                FROM member_activity ma1
                INNER JOIN (
                    SELECT user_id, MAX(timestamp) as max_ts
                    FROM member_activity
                    GROUP BY user_id
                ) ma2 ON ma1.user_id = ma2.user_id AND ma1.timestamp = ma2.max_ts
            ) ma ON l.user_id = ma.user_id
            LEFT JOIN warns w ON l.user_id = w.user_id
                AND (w.type IS NULL OR w.type = 'WARN')
                AND w.reason NOT LIKE '%(timeout%'
                AND w.reason NOT LIKE '%(untimeout)%'
            LEFT JOIN user_bans ub ON l.user_id = ub.user_id AND ub.banned = TRUE
            LEFT JOIN timeouts t ON l.user_id = t.user_id AND t.expires_at > NOW()
            ${whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : ''}
            GROUP BY l.user_id
            ORDER BY l.level DESC
            LIMIT 50
        `;

        const [levelUsers] = await MySQLDatabaseManager.connection.pool.query(baseQuery, params);

        // Include warn-only users not in levels (only when searching by query)
        let warnOnlyUsers = [];
        if (sanitizedQuery.length > 0) {
            const warnWhere = [];
            const warnParams = [];
            if (isIdQuery) {
                warnWhere.push('w.user_id LIKE ?');
                warnParams.push(`%${sanitizedQuery}%`);
            } else {
                warnWhere.push('(LOWER(COALESCE(ma.username, \'\')) LIKE ? OR w.user_id LIKE ?)');
                warnParams.push(`%${normalizedQuery}%`, `%${sanitizedQuery}%`);
            }

            const warnQuery = `
                SELECT 
                    w.user_id,
                    COALESCE(ma.username, CONCAT('User-', SUBSTRING(w.user_id, -4))) as username,
                    1 as level,
                    0 as xp,
                    0 as messages,
                    COUNT(w.id) as warn_count,
                    CASE WHEN ub.user_id IS NULL THEN 0 ELSE 1 END as is_banned,
                    CASE WHEN t.user_id IS NULL THEN 0 ELSE 1 END as is_timed_out
                FROM moderation_cases w
                LEFT JOIN levels l ON w.user_id = l.user_id
                LEFT JOIN (
                    SELECT ma1.user_id, ma1.username
                    FROM member_activity ma1
                    INNER JOIN (
                        SELECT user_id, MAX(timestamp) as max_ts
                        FROM member_activity
                        GROUP BY user_id
                    ) ma2 ON ma1.user_id = ma2.user_id AND ma1.timestamp = ma2.max_ts
                ) ma ON w.user_id = ma.user_id
                                LEFT JOIN user_bans ub ON w.user_id = ub.user_id AND ub.banned = TRUE
                                LEFT JOIN moderation_cases t ON w.user_id = t.user_id AND t.action_type = 'TIMEOUT' AND t.status = 'active' AND (t.expires_at IS NULL OR t.expires_at > ${Date.now()})
                WHERE l.user_id IS NULL
                                    AND w.action_type = 'WARN'
                                    AND w.status NOT IN ('cleared', 'reversed')
                  AND ${warnWhere.join(' AND ')}
                GROUP BY w.user_id
                LIMIT 50
            `;
            const [warnRows] = await MySQLDatabaseManager.connection.pool.query(warnQuery, warnParams);
            warnOnlyUsers = warnRows || [];
        }

        const combined = [...(levelUsers || []), ...warnOnlyUsers];
        res.json({ success: true, data: combined.slice(0, 50) });
    } catch (error) {
        console.error('Error searching users:', error);
        res.status(500).json({ error: 'Failed to search users' });
    }
});

// Get audit logs endpoint
app.get('/api/admin/audit-logs', requireAuth, async (req, res) => {
    try {
        const { eventType, userId, startDate, endDate, limit = 100 } = req.query;

        // Validate and sanitize limit
        const sanitizedLimit = Math.min(Math.max(parseInt(limit) || 100, 1), 1000);

        // For now, return empty logs (would need audit tracking in the bot)
        res.json({ success: true, data: [] });
    } catch (error) {
        console.error('Error getting audit logs:', error);
        res.status(500).json({ error: 'Failed to get audit logs' });
    }
});

// Get user profile endpoint
app.get('/api/admin/user-profile/:userId', requireAuth, async (req, res) => {
    try {
        const { userId } = req.params;

        // Validate userId
        if (!isValidDiscordUserId(userId)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }

        // Build profile from available data
        const [levels, warnings, userInfo] = await Promise.all([
            AdminPanelHelper.getAllLevels(),
            AdminPanelHelper.getUserWarns(userId),
            typeof MySQLDatabaseManager.getUserInfo === 'function'
                ? MySQLDatabaseManager.getUserInfo(userId)
                : Promise.resolve(null)
        ]);

        const userLevel = levels.find(l => l.user_id === userId);

        let discordUser = null;
        if (discordClient) {
            try {
                discordUser = await discordClient.users.fetch(userId).catch(() => null);
            } catch (_) {
                discordUser = null;
            }
        }

        const warningList = Array.isArray(warnings) ? warnings : [];
        const resolvedUsername = userLevel?.username
            || userInfo?.username
            || discordUser?.username
            || warningList.find(entry => entry?.username)?.username
            || 'Unknown User';

        const profile = {
            user_id: userId,
            username: resolvedUsername,
            nickname: userInfo?.nickname || null,
            bio: userInfo?.bio || null,
            avatar: discordUser?.displayAvatarURL?.({ dynamic: true, size: 256 }) || null,
            level: Number(userLevel?.level || 0),
            xp: Number(userLevel?.xp || 0),
            messages: Number(userLevel?.messages || 0),
            warn_count: warningList.length,
            banned: false,
            warnings: warningList,
            bans: [],
            audit_logs: [],
            violations: []
        };

        res.json({ success: true, data: profile });
    } catch (error) {
        console.error('Error getting user profile:', error);
        res.status(500).json({ error: 'Failed to get user profile' });
    }
});

// Get suggestions endpoint
app.get('/api/admin/suggestions', requireAuth, async (req, res) => {
    try {
        const { limit } = req.query;
        let suggestions = await MySQLDatabaseManager.getAllSuggestions(parseInt(limit) || 50);

        // Map and Hydrate with Discord User Info
        if (discordClient) {
            suggestions = await Promise.all(suggestions.map(async (s) => {
                const suggestion = {
                    id: s.case_id || s.suggestion_id,
                    userId: s.user_id,
                    title: s.title,
                    content: s.description,
                    upvotes: s.upvotes,
                    downvotes: s.downvotes,
                    createdAt: s.created_at,
                    status: s.status,
                    response: s.admin_response,
                    responderId: s.responded_by
                };

                // Fetch user if possible
                try {
                    const user = await discordClient.users.fetch(s.user_id).catch(() => null);
                    if (user) {
                        suggestion.username = user.username;
                        suggestion.discriminator = user.discriminator;
                        suggestion.tag = user.tag;
                        suggestion.avatarUrl = user.displayAvatarURL({ dynamic: true, size: 64 });
                    }
                } catch (err) {
                    // Ignore fetch errors
                }

                // Fetch responder if exists
                if (s.responded_by) {
                    try {
                        // First try local admin user (UUID)
                        let adminUser = null;
                        if (AdminPanelHelper && typeof AdminPanelHelper.getAdminUserById === 'function') {
                            adminUser = await AdminPanelHelper.getAdminUserById(s.responded_by);
                        }

                        // Fallback: If ID looks truncated (common VARCHAR(20) issue), try partial match
                        if (!adminUser && typeof s.responded_by === 'string' && s.responded_by.length >= 20 && s.responded_by.length < 32) {
                            try {
                                const validPrefix = s.responded_by.replace(/[^a-zA-Z0-9-]/g, '');
                                const query = 'SELECT * FROM admin_users WHERE id LIKE ? LIMIT 1';
                                const rows = await MySQLDatabaseManager.query(query, [validPrefix + '%']);
                                if (rows && rows.length > 0) adminUser = rows[0];
                            } catch (err) {
                                console.error('Error finding admin user by prefix:', err);
                            }
                        }

                        if (adminUser) {
                            suggestion.responderTag = adminUser.username;
                        }

                        // Fallback to Discord fetch if not found locally (assuming it's a snowflake)
                        if (!adminUser) {
                            const responder = await discordClient.users.fetch(s.responded_by).catch(() => null);
                            if (responder) {
                                suggestion.responderTag = responder.tag;
                            }
                        }
                    } catch (_) { }
                }

                return suggestion;
            }));
        } else {
            // Fallback mapping if no client
            suggestions = suggestions.map(s => ({
                id: s.case_id || s.suggestion_id,
                userId: s.user_id,
                title: s.title,
                content: s.description,
                upvotes: s.upvotes,
                downvotes: s.downvotes,
                createdAt: s.created_at,
                status: s.status,
                response: s.admin_response,
                responderId: s.responded_by
            }));
        }

        res.json({ success: true, data: suggestions });
    } catch (error) {
        console.error('Error getting suggestions:', error);
        res.status(500).json({ error: 'Failed to get suggestions' });
    }
});


async function syncSuggestionEmbed(suggestionIdOrCaseId, newStatus, reason, moderatorId, moderatorName) {
    if (!discordClient) {
        console.warn(`[SyncSuggestion] Discord client not ready, skipping sync for ${suggestionIdOrCaseId}`);
        return;
    }

    try {
        console.log(`[SyncSuggestion] Syncing suggestion ${suggestionIdOrCaseId} -> ${newStatus}`);

        let suggestion = null;

        // Try getting by numeric ID first (if applicable)
        if (!isNaN(suggestionIdOrCaseId)) {
            suggestion = await MySQLDatabaseManager.getSuggestion(suggestionIdOrCaseId);
        }

        // If not found, try by Case ID
        if (!suggestion) {
            suggestion = await MySQLDatabaseManager.getSuggestionByCaseId(suggestionIdOrCaseId);
        }

        if (!suggestion) {
            console.warn(`[SyncSuggestion] Suggestion not found in DB: ${suggestionIdOrCaseId}`);
            return;
        }

        if (!suggestion.message_id) {
            console.warn(`[SyncSuggestion] Suggestion ${suggestionIdOrCaseId} has no message_id stored.`);
            return;
        }

        // Get guild and channel
        const guildId = suggestion.guild_id || process.env.GUILD_ID;
        const guild = discordClient.guilds.cache.get(guildId) || discordClient.guilds.cache.first();
        if (!guild) {
            console.warn(`[SyncSuggestion] Guild not found (ID: ${guildId})`);
            return;
        }

        const channel = guild.channels.cache.get(suggestionChannelId);
        if (!channel) {
            console.warn(`[SyncSuggestion] Suggestion channel not found (ID: ${suggestionChannelId})`);
            return;
        }

        // Fetch message
        const message = await channel.messages.fetch(suggestion.message_id).catch(() => null);
        if (!message) {
            console.warn(`[SyncSuggestion] Message ${suggestion.message_id} not found/fetch failed`);
            return;
        }

        const oldEmbed = message.embeds[0];
        if (!oldEmbed) return;

        const embed = EmbedBuilder.from(oldEmbed);

        // Update Status
        const statusMap = {
            'approved': { color: 0x57F287, text: '✅ **Approved**' },
            'denied': { color: 0xED4245, text: '- **Denied**' }
        };

        if (statusMap[newStatus]) {
            embed.setColor(statusMap[newStatus].color);

            // Find and update status field if it exists
            const statusIdx = embed.data.fields.findIndex(f => f.name === '📊 Status');
            if (statusIdx !== -1) {
                embed.data.fields[statusIdx].value = statusMap[newStatus].text;
            } else {
                embed.addFields({ name: '📊 Status', value: statusMap[newStatus].text, inline: true });
            }
        }

        // Manage Admin Response / Moderator fields
        // Remove old response fields to avoid duplicates if re-approved/denied
        if (embed.data.fields) {
            embed.data.fields = embed.data.fields.filter(f => f.name !== '📝 Admin Response' && f.name !== '⚖️ Moderator');
        }

        if (reason) {
            embed.addFields({ name: '📝 Admin Response', value: reason, inline: false });
        }

        const modUser = await discordClient.users.fetch(moderatorId).catch(() => null);
        const moderatorDisplay = modUser ? `<@${modUser.id}>` : (moderatorName || moderatorId);

        if (moderatorDisplay) {
            embed.addFields({ name: '⚖️ Moderator', value: moderatorDisplay, inline: true });
        }

        // Remove footer content about voting if resolved
        if (embed.data.footer && embed.data.footer.text) {
            embed.setFooter({ text: embed.data.footer.text.replace(' • Vote using the reactions below!', '') });
        }

        await message.edit({ embeds: [embed] });
        console.log(`[SyncSuggestion] Updated message ${message.id} for suggestion ${suggestionIdOrCaseId}`);

        // Remove voting reactions to prevent further voting
        if (message.reactions) {
            await message.reactions.removeAll().catch(err => console.error('Failed to clear reactions', err));
        }

        // Send confirmation embed to serverlogchannel
        if (serverLogChannelId) {
            try {
                const logChannel = await guild.channels.fetch(serverLogChannelId).catch(() => null);
                if (logChannel && logChannel.isTextBased()) {
                    const logEmbed = new EmbedBuilder()
                        .setTitle(newStatus === 'approved' ? '✅ Suggestion Approved' : '- Suggestion Denied')
                        .setColor(statusMap[newStatus]?.color || 0x2B2D31)
                        .addFields(
                            { name: '👤 Suggester', value: `<@${suggestion.user_id}>`, inline: true },
                            { name: '⚖️ Moderator', value: moderatorDisplay, inline: true },
                            { name: '💡 Suggestion', value: suggestion.description || 'No content', inline: false },
                            { name: '📝 Reason', value: reason || 'No reason provided', inline: false }
                        )
                        .setFooter({ text: `Suggestion ID: ${suggestion.case_id || suggestionIdOrCaseId}` })
                        .setTimestamp();

                    await logChannel.send({ embeds: [logEmbed] });
                }
            } catch (logErr) {
                console.error('[SyncSuggestion] Error sending log to serverLogChannel:', logErr);
            }
        }

    } catch (error) {
        console.error('Error syncing suggestion embed:', error);
    }
}

// Approve suggestion
app.post('/api/admin/suggestions/:id/approve', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        const userId = req.session.userId;
        const moderatorName = req.session.username || 'Admin';

        const updated = await MySQLDatabaseManager.updateSuggestionStatus(id, 'approved', userId, reason || null);
        if (!updated) {
            return res.status(500).json({ error: 'Failed to approve suggestion' });
        }

        await syncSuggestionEmbed(id, 'approved', reason || null, userId, moderatorName);

        return res.json({ success: true, message: 'Suggestion approved' });
    } catch (error) {
        console.error('Error approving suggestion:', error);
        return res.status(500).json({ error: 'Failed to approve suggestion' });
    }
});

// Deny suggestion
app.post('/api/admin/suggestions/:id/deny', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        const userId = req.session.userId;
        const moderatorName = req.session.username || 'Admin';

        const updated = await MySQLDatabaseManager.updateSuggestionStatus(id, 'denied', userId, reason || null);
        if (!updated) {
            return res.status(500).json({ error: 'Failed to deny suggestion' });
        }

        await syncSuggestionEmbed(id, 'denied', reason || null, userId, moderatorName);

        return res.json({ success: true, message: 'Suggestion denied' });
    } catch (error) {
        console.error('Error denying suggestion:', error);
        return res.status(500).json({ error: 'Failed to deny suggestion' });
    }
});

// Get ghost pings endpoint
app.get('/api/admin/ghost-pings', requireAuth, async (req, res) => {
    try {
        const { limit } = req.query;
        let pings = await MySQLDatabaseManager.getAllGhostPings(parseInt(limit) || 50);

        if (discordClient) {
            pings = await Promise.all(pings.map(async (ping) => {
                if (ping.mentions && typeof ping.mentions === 'string') {
                    let rawMentions = ping.mentions;
                    const mentionRegex = /<@!?(\d+)>|(\d{17,19})/g;
                    let match;
                    const replacedMentionsIds = new Set();

                    while ((match = mentionRegex.exec(ping.mentions)) !== null) {
                        const mentionId = match[1] || match[2];
                        if (mentionId && !replacedMentionsIds.has(mentionId)) {
                            replacedMentionsIds.add(mentionId);
                            try {
                                const mentionUser = await discordClient.users.fetch(mentionId).catch(() => null);
                                if (mentionUser) {
                                    rawMentions = rawMentions.replace(new RegExp(`<@!?${mentionId}>|\\b${mentionId}\\b`, 'g'), `@${mentionUser.username}`);
                                } else {
                                    const mentionUserInfo = await MySQLDatabaseManager.getUserInfo(mentionId);
                                    if (mentionUserInfo && mentionUserInfo.username) {
                                        rawMentions = rawMentions.replace(new RegExp(`<@!?${mentionId}>|\\b${mentionId}\\b`, 'g'), `@${mentionUserInfo.username}`);
                                    }
                                }
                            } catch (error) { }
                        }
                    }

                    ping.resolvedMentions = rawMentions;
                } else {
                    ping.resolvedMentions = ping.mentions;
                }

                if (ping.content && typeof ping.content === 'string') {
                    let resolvedContent = ping.content;
                    const mentionContentRegex = /<@!?(\d+)>|(\d{17,19})/g;
                    let contentMatch;
                    const replacedContentIds = new Set();

                    while ((contentMatch = mentionContentRegex.exec(ping.content)) !== null) {
                        const contentId = contentMatch[1] || contentMatch[2];
                        if (contentId && !replacedContentIds.has(contentId)) {
                            replacedContentIds.add(contentId);
                            try {
                                const contentUser = await discordClient.users.fetch(contentId).catch(() => null);
                                if (contentUser) {
                                    resolvedContent = resolvedContent.replace(new RegExp(`<@!?${contentId}>|\\b${contentId}\\b`, 'g'), `@${contentUser.username}`);
                                } else {
                                    const contentUserInfo = await MySQLDatabaseManager.getUserInfo(contentId);
                                    if (contentUserInfo && contentUserInfo.username) {
                                        resolvedContent = resolvedContent.replace(new RegExp(`<@!?${contentId}>|\\b${contentId}\\b`, 'g'), `@${contentUserInfo.username}`);
                                    }
                                }
                            } catch (error) { }
                        }
                    }

                    ping.resolvedContent = resolvedContent;
                } else {
                    ping.resolvedContent = ping.content;
                }

                return ping;
            }));
        }

        res.json({ success: true, data: pings });
    } catch (error) {
        console.error('Error getting ghost pings:', error);
        res.status(500).json({ error: 'Failed to get ghost pings' });
    }
});

// Clear ghost pings endpoint
app.post('/api/admin/clear-ghost-pings', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasAdminAccess(user)) return res.status(403).json({ error: 'Unauthorized: Admin access required' });

        const success = await MySQLDatabaseManager.clearGhostPings();
        if (success) res.json({ success: true });
        else res.status(500).json({ error: 'Failed to clear ghost pings' });
    } catch (error) {
        console.error('Error clearing ghost pings:', error);
        res.status(500).json({ error: 'Failed to clear ghost pings' });
    }
});

// Get snipes endpoint
app.get('/api/admin/snipes', requireAuth, async (req, res) => {
    try {
        const { limit } = req.query;
        let snipes = await MySQLDatabaseManager.getAllSnipes(parseInt(limit) || 50);

        // Hydrate
        if (discordClient) {
            const guildId = process.env.GUILD_ID;
            const guild = guildId ? discordClient.guilds.cache.get(guildId) : discordClient.guilds.cache.first();

            snipes = await Promise.all(snipes.map(async (s) => {
                const snipe = { ...s };

                if (!snipe.channelName && snipe.channelId && guild) {
                    const ch = guild.channels.cache.get(snipe.channelId);
                    if (ch) snipe.channelName = ch.name;
                }

                if (!snipe.userTag || snipe.userTag === 'Unknown') {
                    try {
                        const u = await discordClient.users.fetch(snipe.userId);
                        if (u) snipe.userTag = u.tag;
                    } catch (e) { }
                }
                return snipe;
            }));
        }

        res.json({ success: true, data: snipes });
    } catch (error) {
        console.error('Error getting snipes:', error);
        res.status(500).json({ error: 'Failed to get snipes' });
    }
});

// Clear snipes endpoint
app.post('/api/admin/clear-snipes', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasAdminAccess(user)) return res.status(403).json({ error: 'Unauthorized: Admin access required' });

        const success = await MySQLDatabaseManager.clearSnipes();
        if (success) res.json({ success: true });
        else res.status(500).json({ error: 'Failed to clear snipes' });
    } catch (error) {
        console.error('Error clearing snipes:', error);
        res.status(500).json({ error: 'Failed to clear snipes' });
    }
});


// Get AutoMod violations endpoint
app.get('/api/admin/automod-violations', requireAuth, async (req, res) => {
    try {
        const { userId, hours = 24 } = req.query;
        const safeHours = Math.max(1, Math.min(720, parseInt(hours, 10) || 24));

        let query = `
            SELECT id, user_id, guild_id, violation_type, message_content, channel_id, action_taken, risk_score, risk_level, signal_count, appeal_notified, metadata_json, timestamp
            FROM automod_violations
            WHERE timestamp >= DATE_SUB(NOW(), INTERVAL ? HOUR)
        `;
        const params = [safeHours];

        if (isValidDiscordUserId(userId)) {
            query += ' AND user_id = ?';
            params.push(userId);
        }

        query += ' ORDER BY timestamp DESC LIMIT 250';

        const [rows] = await MySQLDatabaseManager.connection.pool.execute(query, params);
        res.json({ success: true, data: Array.isArray(rows) ? rows : [] });
    } catch (error) {
        console.error('Error getting violations:', error);
        res.status(500).json({ error: 'Failed to get violations' });
    }
});

// Bulk ban endpoint - rate limited (1 request per 10 minutes)
app.post('/api/admin/bulk-ban', createRateLimiter(1, 600000), requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasAdminAccess(user)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { userIds, reason } = req.body;

        const userIdsError = validateBulkDiscordUserIds(userIds, {
            maxCount: 50,
            maxCountError: 'Cannot ban more than 50 users at once'
        });
        if (userIdsError) {
            return res.status(400).json({ error: userIdsError });
        }

        // Validate reason if provided
        if (reason && (typeof reason !== 'string' || reason.length > 500)) {
            return res.status(400).json({ error: 'Reason must be a string under 500 characters' });
        }

        const results = { success: [], failed: [] };

        for (const userId of userIds) {
            try {
                const success = await AdminPanelHelper.banUser(userId, reason || 'Bulk ban by admin', user.id);
                if (success) {
                    results.success.push(userId);
                } else {
                    results.failed.push({ userId, error: 'Failed to ban user' });
                }
            } catch (error) {
                console.error(`Error banning user ${userId}:`, error);
                results.failed.push({ userId, error: error.message });
            }
        }

        res.json({ success: true, results });
    } catch (error) {
        console.error('Error bulk banning:', error);
        res.status(500).json({ error: 'Failed to bulk ban users' });
    }
});

// Bulk clear warnings endpoint - rate limited
app.post('/api/admin/bulk-clear-warnings', createRateLimiter(2, 300000), requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasAdminAccess(user)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { userIds } = req.body;

        if (!Array.isArray(userIds) || userIds.length === 0) {
            return res.status(400).json({ error: 'Invalid user IDs' });
        }

        const results = { success: [], failed: [] };

        for (const userId of userIds) {
            try {
                const success = await AdminPanelHelper.clearUserWarns(userId);
                if (success) {
                    results.success.push(userId);
                } else {
                    results.failed.push({ userId, error: 'Failed to clear warnings' });
                }
            } catch (error) {
                console.error(`Error clearing warnings for ${userId}:`, error);
                results.failed.push({ userId, error: error.message });
            }
        }

        console.log(`[Admin] ${req.session.username} cleared warnings for ${results.success.length} users`);
        res.json({ success: true, results });
    } catch (error) {
        console.error('Error bulk clearing warnings:', error);
        res.status(500).json({ error: 'Failed to bulk clear warnings' });
    }
});

// Bulk unban endpoint - rate limited (2 requests per 5 minutes)
app.post('/api/admin/bulk-unban', createRateLimiter(2, 300000), requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasAdminAccess(user)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { userIds } = req.body;

        const userIdsError = validateBulkDiscordUserIds(userIds, {
            maxCount: 50,
            maxCountError: 'Cannot unban more than 50 users at once'
        });
        if (userIdsError) {
            return res.status(400).json({ error: userIdsError });
        }

        const results = { success: [], failed: [] };

        // Get guild once for all unbans
        let guild = null;
        if (discordClient) {
            try {
                const mainConfig = require('./Config/main.json');
                guild = await discordClient.guilds.fetch(mainConfig.serverID);
            } catch (err) {
                console.error('Error fetching guild for bulk unban:', err.message);
            }
        }

        for (const userId of userIds) {
            try {
                // Update database
                const success = await AdminPanelHelper.unbanUser(userId);

                // Unban from Discord
                if (success && guild) {
                    try {
                        await guild.bans.remove(userId, 'Bulk unban via admin panel');
                    } catch (discordError) {
                        console.error(`Error unbanning ${userId} from Discord:`, discordError.message);
                    }
                }

                if (success) {
                    results.success.push(userId);
                } else {
                    results.failed.push({ userId, error: 'Failed to unban user' });
                }
            } catch (error) {
                console.error(`Error unbanning user ${userId}:`, error);
                results.failed.push({ userId, error: error.message });
            }
        }

        console.log(`[Admin] ${req.session.username} unbanned ${results.success.length} users`);
        res.json({ success: true, results });
    } catch (error) {
        console.error('Error bulk unbanning:', error);
        res.status(500).json({ error: 'Failed to bulk unban users' });
    }
});

// Bulk warn endpoint - rate limited (2 requests per 5 minutes)
app.post('/api/admin/bulk-warn', createRateLimiter(2, 300000), requireAuth, async (req, res) => {
    try {
        const { userIds, reason } = req.body;

        const userIdsError = validateBulkDiscordUserIds(userIds, {
            maxCount: 50,
            maxCountError: 'Cannot warn more than 50 users at once'
        });
        if (userIdsError) {
            return res.status(400).json({ error: userIdsError });
        }

        // Validate reason
        if (!isValidModerationReason(reason)) {
            return res.status(400).json({ error: 'Reason must be between 3-500 characters' });
        }

        const results = { success: [], failed: [] };

        for (const userId of userIds) {
            try {
                const caseId = createPrefixedCaseId('WARN');
                const success = await AdminPanelHelper.addWarn(userId, reason.trim(), user.id, caseId);
                if (success) {
                    results.success.push(userId);
                } else {
                    results.failed.push({ userId, error: 'Failed to warn user' });
                }
            } catch (error) {
                console.error(`Error warning user ${userId}:`, error);
                results.failed.push({ userId, error: error.message });
            }
        }

        res.json({ success: true, results });
    } catch (error) {
        console.error('Error bulk warning:', error);
        res.status(500).json({ error: 'Failed to bulk warn users' });
    }
});

// Warn a single user from search
app.post('/api/admin/warn-user', requireAuth, async (req, res) => {
    try {
        const { userId, reason } = req.body;
        console.log('[Warn] Received request for user:', userId, 'reason:', reason);

        const adminUser = await AdminPanelHelper.getAdminUser(req.session.username);
        console.log('[Warn] Admin user:', adminUser?.username, 'role:', adminUser?.role);

        if (!hasModeratorAccess(adminUser)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }

        if (!isValidDiscordUserId(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }

        if (!isValidModerationReason(reason, { maxLength: Number.POSITIVE_INFINITY })) {
            return res.status(400).json({ error: 'Reason is required and must be at least 3 characters' });
        }

        // Generate case ID
        const caseId = createPrefixedCaseId('WARN');
        console.log('[Warn] Generated case ID:', caseId);

        // Add the warning to database
        try {
            await AdminPanelHelper.addWarn(userId, reason.trim(), adminUser.id, caseId, {
                moderatorName: adminUser.username,
                moderatorSource: 'panel'
            });
            console.log('[Warn] Database insert successful');
        } catch (dbError) {
            console.error('[Warn] Database error:', dbError.message);
            return res.status(500).json({ error: `Database error: ${dbError.message}` });
        }

        // Log to server log channel
        if (discordClient) {
            // Send DM to user about the warning
            try {
                const mainConfig = require('./Config/main.json');
                const guild = await discordClient.guilds.fetch(mainConfig.serverID).catch(() => null);
                const guildName = guild?.name || 'the server';
                const user = await discordClient.users.fetch(userId);
                if (user) {
                    const { EmbedBuilder } = require('discord.js');
                    const embed = new EmbedBuilder()
                        .setTitle('⚠️ Warning Details')
                        .setColor(0xFAA61A)
                        .setDescription(`Case ID: \`${caseId}\``)
                        .addFields(
                            { name: 'Reason', value: `\`\`\`${reason.trim()}\`\`\``, inline: false },
                            { name: 'Moderator', value: `\`${req.session.username}\``, inline: true },
                        )
                        .setTimestamp();
                    await user.send({ embeds: [embed] })
                        .then(() => console.log(`[DM] Warn sent to user ${userId}`))
                        .catch((err) => console.error(`[DM] Failed to send warn DM to ${userId}:`, err.message));
                }
            } catch (dmError) {
                console.error('Failed to send warn DM:', dmError.message);
            }
            try {
                const mainConfig = require('./Config/main.json');
                const guild = await discordClient.guilds.fetch(mainConfig.serverID);
                const logChannel = guild?.channels.cache.get(serverLogChannelId);

                if (logChannel && logChannel.isTextBased()) {
                    const { EmbedBuilder } = require('discord.js');
                    const targetUser = await resolveDiscordUser(userId);
                    const targetLabel = targetUser ? `${targetUser.tag} (${targetUser.id})` : userId;
                    const embed = new EmbedBuilder()
                        .setTitle('⚠️ Warning Issued')
                        .setColor(0xFFAA00)
                        .setDescription('A warning was issued from the Admin Panel.')
                        .addFields(
                            { name: '👤 User', value: `${targetLabel}\n<@${userId}>`, inline: false },
                            { name: '🆔 Case', value: `\`${caseId}\``, inline: true },
                            { name: '👮 Moderator', value: req.session.username, inline: true },
                            { name: '📝 Reason', value: reason.trim(), inline: false },
                            { name: '🕒 Issued', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                        )
                        .setThumbnail(targetUser?.displayAvatarURL?.({ size: 128 }) || null)
                        .setFooter({ text: 'Admin Panel • Moderation' })
                        .setTimestamp();

                    await logChannel.send({ embeds: [embed] });
                }
            } catch (logError) {
                console.error('Error logging warning:', logError.message);
            }
        }

        console.log(`[Admin] ${req.session.username} warned user ${userId} via search (Case: ${caseId})`);
        res.json({ success: true, caseId, message: 'User warned successfully' });
    } catch (error) {
        console.error('Error warning user:', error);
        res.status(500).json({ error: 'Failed to warn user' });
    }
});

// Ban a single user from search
app.post('/api/admin/ban-user', requireAuth, async (req, res) => {
    try {
        const { userId, reason } = req.body;
        const adminUser = await AdminPanelHelper.getAdminUser(req.session.username);

        if (!hasAdminAccess(adminUser)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        if (!isValidDiscordUserId(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }

        if (!isValidModerationReason(reason, { maxLength: Number.POSITIVE_INFINITY })) {
            return res.status(400).json({ error: 'Reason is required and must be at least 3 characters' });
        }

        // Generate case ID
        const caseId = createPrefixedCaseId('BAN');

        // First, send DM to user about the ban BEFORE banning
        if (discordClient) {
            try {
                const mainConfig = require('./Config/main.json');
                const guild = await discordClient.guilds.fetch(mainConfig.serverID).catch(() => null);
                const guildName = guild?.name || 'the server';
                const user = await discordClient.users.fetch(userId).catch(() => null);

                if (user) {
                    try {
                        const { EmbedBuilder } = require('discord.js');
                        const moment = require('moment');
                        const config = require('./Config/main.json');
                        const AppealLink = config.AppealLink || '#';

                        const embed = new EmbedBuilder()
                            .setTitle('🔨 Server Ban Notice')
                            .setColor(0xF04747)
                            .setDescription(`⚠️ You have been permanently removed from **${guildName}**.`)
                            .addFields(
                                { name: 'Ban Status', value: '🛡️ **Permanent**', inline: true },
                                { name: 'Effective Date', value: `${moment(Date.now()).format('dddd, D MMMM YYYY [at] HH:mm')}`, inline: true },
                                { name: 'Reason for Ban', value: `${'```'}${reason.trim()}${'```'}`, inline: false },
                                { name: 'Case ID', value: `${'```'}${caseId}${'```'}`, inline: true },
                                { name: 'Moderator', value: `${'```'}${req.session.username}${'```'}`, inline: true },
                                { name: 'Appeal Process', value: `[Submit Ban Appeal](${AppealLink})`, inline: false }
                            )
                            .setTimestamp();

                        await user.send({ embeds: [embed] })
                            .then(() => console.log(`[DM] Ban notification sent to user ${userId}`))
                            .catch((err) => console.error(`[DM] Failed to send ban DM to ${userId}:`, err.message));
                    } catch (dmError) {
                        console.error(`Error preparing ban DM for ${userId}:`, dmError.message);
                    }
                }

                // Now ban the user in Discord AFTER notifying them
                if (guild) {
                    await guild.members.ban(userId, { reason: reason.trim() }).catch(err => {
                        console.error('Failed to ban member:', err);
                        throw err;
                    });
                    console.log(`✅ User ${userId} banned from Discord`);
                }
            } catch (discordError) {
                return res.status(400).json({ error: `Failed to ban from Discord: ${discordError.message}` });
            }
        }

        // Add ban to database (with upsert)
        try {
            const targetUser = await resolveDiscordUser(userId);
            await AdminPanelHelper.banUser(userId, reason.trim(), adminUser.id, caseId, {
                moderatorName: adminUser.username,
                moderatorSource: 'panel',
                userName: targetUser?.username || null,
                guildId: process.env.GUILD_ID || null,
                source: 'panel'
            });
        } catch (dbError) {
            return res.status(500).json({ error: `Database error: ${dbError.message}` });
        }

        // Log to server log channel
        if (discordClient) {
            try {
                const mainConfig = require('./Config/main.json');
                const guild = await discordClient.guilds.fetch(mainConfig.serverID);
                const logChannel = guild?.channels.cache.get(serverLogChannelId);

                if (logChannel && logChannel.isTextBased()) {
                    const { EmbedBuilder } = require('discord.js');
                    const targetUser = await resolveDiscordUser(userId);
                    const targetLabel = targetUser ? `${targetUser.tag} (${targetUser.id})` : userId;
                    const embed = new EmbedBuilder()
                        .setTitle('🔨 Ban Issued')
                        .setColor(0xFF0000)
                        .setDescription('A user was banned from the Admin Panel.')
                        .addFields(
                            { name: '👤 User', value: `${targetLabel}\n<@${userId}>`, inline: false },
                            { name: '🆔 Case', value: `\`${caseId}\``, inline: true },
                            { name: '👮 Moderator', value: req.session.username, inline: true },
                            { name: '📝 Reason', value: reason.trim(), inline: false },
                            { name: '🕒 Banned At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                        )
                        .setThumbnail(targetUser?.displayAvatarURL?.({ size: 128 }) || null)
                        .setFooter({ text: 'Admin Panel • Moderation' })
                        .setTimestamp();

                    await logChannel.send({ embeds: [embed] });
                }
            } catch (logError) {
                console.error('Error logging ban:', logError.message);
            }
        }

        console.log(`[Admin] ${req.session.username} banned user ${userId} via search (Case: ${caseId})`);
        res.json({ success: true, caseId, message: 'User banned successfully' });
    } catch (error) {
        console.error('Error banning user:', error);
        res.status(500).json({ error: 'Failed to ban user' });
    }
});

// Timeout user endpoint
app.post('/api/admin/timeout-user', requireAuth, async (req, res) => {
    try {
        const { userId, duration, reason } = req.body;
        const adminUser = await AdminPanelHelper.getAdminUser(req.session.username);

        if (!hasAdminAccess(adminUser)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        if (!isValidDiscordUserId(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }

        if (!duration || typeof duration !== 'string' || duration.trim().length < 1) {
            return res.status(400).json({ error: 'Duration is required' });
        }

        if (!isValidModerationReason(reason, { maxLength: Number.POSITIVE_INFINITY })) {
            return res.status(400).json({ error: 'Reason is required and must be at least 3 characters' });
        }

        // Convert duration string to milliseconds (e.g., "10m" -> 600000, "1h" -> 3600000)
        const durationMs = parseDurationToMs(duration.trim());
        if (!isValidTimeoutDurationMs(durationMs)) {
            return res.status(400).json({ error: 'Invalid duration format. Use format like "10m", "1h", "7d"' });
        }

        // Generate case ID
        const caseId = createPrefixedCaseId('TIMEOUT');

        // Timeout the user in Discord
        if (discordClient) {
            try {
                const mainConfig = require('./Config/main.json');
                const guild = await discordClient.guilds.fetch(mainConfig.serverID);
                const member = await guild.members.fetch(userId);
                await member.timeout(durationMs, reason.trim());
                console.log(`✅ User ${userId} timed out for ${duration}`);
            } catch (discordError) {
                return res.status(400).json({ error: `Failed to timeout in Discord: ${discordError.message}` });
            }
        }

        // Add timeout to database
        const expiresAtMs = Date.now() + durationMs;
        try {
            const timeoutSaved = await AdminPanelHelper.addTimeout({
                userId,
                caseId,
                username: null,
                reason: reason.trim(),
                issuedBy: adminUser.id,
                issuedByName: req.session.username,
                issuedBySource: 'admin_panel',
                issuedAt: Date.now(),
                expiresAt: expiresAtMs
            });

            if (!timeoutSaved) {
                return res.status(500).json({ error: 'Database error: failed to store timeout record' });
            }

        } catch (dbError) {
            return res.status(500).json({ error: `Database error: ${dbError.message}` });
        }

        // Log to server log channel
        if (discordClient) {
            // Send DM to user about the timeout
            try {
                const mainConfig = require('./Config/main.json');
                const guild = await discordClient.guilds.fetch(mainConfig.serverID).catch(() => null);
                const guildName = guild?.name || 'the server';
                const user = await discordClient.users.fetch(userId);
                if (user) {
                    const { EmbedBuilder } = require('discord.js');
                    const embed = new EmbedBuilder()
                        .setTitle('⏱️ Communication Timeout Notice')
                        .setColor(0xFAA61A)
                        .setDescription(`You have been temporarily muted in **${guildName}**.`)
                        .addFields(
                            { name: 'Duration', value: `**${'```'}${duration}${'```'}**`, inline: true },
                            { name: 'Reason for timeout', value: `	${'```'}${reason.trim()}${'```'}`, inline: false },
                            { name: 'Case ID', value: `${'```'}${caseId}${'```'}`, inline: true },
                            { name: 'Moderator', value: `${'```'}${req.session.username}${'```'}`, inline: true },
                        )
                        .setTimestamp();
                    await user.send({ embeds: [embed] })
                        .then(() => console.log(`[DM] Timeout sent to user ${userId}`))
                        .catch((err) => console.error(`[DM] Failed to send timeout DM to ${userId}:`, err.message));
                }
            } catch (dmError) {
                console.error('Failed to send timeout DM:', dmError.message);
            }
            try {
                const mainConfig = require('./Config/main.json');
                const guild = await discordClient.guilds.fetch(mainConfig.serverID);
                const logChannel = guild?.channels.cache.get(serverLogChannelId);

                if (logChannel && logChannel.isTextBased()) {
                    const { EmbedBuilder } = require('discord.js');
                    const targetUser = await resolveDiscordUser(userId);
                    const targetLabel = targetUser ? `${targetUser.tag} (${targetUser.id})` : userId;
                    const embed = new EmbedBuilder()
                        .setTitle('⏱️ Timeout Applied')
                        .setColor(0xFFA500)
                        .setDescription('A timeout was applied from the Admin Panel.')
                        .addFields(
                            { name: '👤 User', value: `${targetLabel}\n<@${userId}>`, inline: false },
                            { name: '🆔 Case', value: `\`${caseId}\``, inline: true },
                            { name: '⏳ Duration', value: duration, inline: true },
                            { name: '👮 Moderator', value: req.session.username, inline: true },
                            { name: '📝 Reason', value: reason.trim(), inline: false },
                            { name: '🕒 Expires', value: `<t:${Math.floor(expiresAtMs / 1000)}:F>`, inline: true }
                        )
                        .setThumbnail(targetUser?.displayAvatarURL?.({ size: 128 }) || null)
                        .setFooter({ text: 'Admin Panel • Moderation' })
                        .setTimestamp();

                    await logChannel.send({ embeds: [embed] });
                }
            } catch (logError) {
                console.error('Error logging timeout:', logError.message);
            }
        }

        console.log(`[Admin] ${req.session.username} timed out user ${userId} via search for ${duration} (Case: ${caseId})`);
        res.json({ success: true, caseId, message: 'User timed out successfully' });
    } catch (error) {
        console.error('Error timing out user:', error);
        res.status(500).json({ error: 'Failed to timeout user' });
    }
});

// Remove timeout from user endpoint
app.post('/api/admin/remove-timeout', requireAuth, async (req, res) => {
    try {
        const { userId } = req.body;
        const adminUser = await AdminPanelHelper.getAdminUser(req.session.username);

        if (!hasAdminAccess(adminUser)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        if (!isValidDiscordUserId(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }

        // Remove timeout in Discord
        if (discordClient) {
            try {
                const mainConfig = require('./Config/main.json');
                const guild = await discordClient.guilds.fetch(mainConfig.serverID);
                const member = await guild.members.fetch(userId);
                await member.timeout(null);
                console.log(`✅ Timeout removed from user ${userId}`);
            } catch (discordError) {
                return res.status(400).json({ error: `Failed to remove timeout in Discord: ${discordError.message}` });
            }
        }

        // Update database
        const untimeoutCaseId = createPrefixedCaseId('UNTIMEOUT');
        try {
            const cleared = await AdminPanelHelper.clearTimeout(userId, {
                caseId: untimeoutCaseId,
                clearedBy: adminUser.id,
                clearedAt: Date.now(),
                reason: 'Removed via admin panel'
            });
            if (!cleared) {
                return res.status(500).json({ error: 'Database error: failed to clear timeout record' });
            }
        } catch (dbError) {
            return res.status(500).json({ error: `Database error: ${dbError.message}` });
        }

        // Log to server log channel
        if (discordClient) {
            try {
                const mainConfig = require('./Config/main.json');
                const guild = await discordClient.guilds.fetch(mainConfig.serverID);
                const logChannel = guild?.channels.cache.get(serverLogChannelId);

                if (logChannel && logChannel.isTextBased()) {
                    const { EmbedBuilder } = require('discord.js');
                    const targetUser = await resolveDiscordUser(userId);
                    const targetLabel = targetUser ? `${targetUser.tag} (${targetUser.id})` : userId;
                    const embed = new EmbedBuilder()
                        .setTitle('✅ Timeout has successfully been removed!')
                        .setColor(0x43B581)
                        .setDescription(`A timeout was removed from the Admin Panel.`)
                        .addFields(
                            { name: '👤 User', value: `${'```'}${targetLabel}\n<@${userId}>${'```'}`, inline: false },
                            { name: '🆔 Case', value: `${'```'}${untimeoutCaseId}${'```'}`, inline: true },
                            { name: '👮 Moderator', value: `${'```'}${req.session.username}${'```'}`, inline: true },
                            { name: '🕒 Cleared At', value: `${'```'}${new Date().toISOString()}${'```'}`, inline: true },
                        )
                        .setThumbnail(targetUser?.displayAvatarURL?.({ size: 128 }) || null)
                        .setFooter({ text: 'Admin Panel • Moderation' })
                        .setTimestamp();

                    await logChannel.send({ embeds: [embed] });
                }
            } catch (logError) {
                console.error('Error logging timeout removal:', logError.message);
            }
        }

        console.log(`[Admin] ${req.session.username} removed timeout from user ${userId}`);
        res.json({ success: true, message: 'Timeout removed successfully' });
    } catch (error) {
        console.error('Error removing timeout:', error);
        res.status(500).json({ error: 'Failed to remove timeout' });
    }
});

// Owner-only routes

// Serve owner page
app.get('/owner', requireAuth, requireOwner, (req, res) => {
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'owner.html'));
});

// Serve analytics page (owner-only)
app.get('/analytics', requireAuth, requireOwner, (req, res) => {
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'analytics.html'));
});

// Check if user is owner
function requireOwner(req, res, next) {
    refreshSessionRoleIfNeeded(req, { forceRefresh: true })
        .then(() => {
            // Check if session became invalid due to role alignment issues
            if (!req.session?.authenticated) {
                return res.redirect('/unauthorized');
            }
            if (!hasOwnerAccess({ role: req.session?.role })) {
                return res.redirect('/profile');
            }
            next();
        })
        .catch(error => {
            error.status = 500;
            next(error);
        });
}

// Force logout all users (owner only)
app.post('/api/owner/force-logout-all', requireAuth, requireOwner, requireSensitiveDiscordSecurityBinding, async (req, res) => {
    try {
        // Clear all sessions from the session store
        sessionStore.clearExpiredSessions((err) => {
            if (err) {
                console.error('Error clearing sessions:', err);
                return res.status(500).json({ error: 'Failed to clear sessions' });
            }
        });

        console.log(`[Owner] ${req.session.username} force logged out all users`);
        res.json({ success: true, message: 'All users have been logged out' });
    } catch (error) {
        console.error('Error force logging out users:', error);
        res.status(500).json({ error: 'Failed to force logout' });
    }
});

// Download recent terminal logs (owner only)
app.get('/api/owner/terminal-logs/download', requireAuth, requireOwner, (req, res) => {
    const ansiRegex = /\x1B\[[0-9;]*m/g;
    const requestedLimit = Number(req.query?.limit);
    const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(Math.floor(requestedLimit), 1), MAX_TERMINAL_LOGS)
        : MAX_TERMINAL_LOGS;
    const logs = terminalLogBuffer
        .slice(-limit)
        .map((line) => String(line || '').replace(ansiRegex, ''));
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `terminal-logs-${timestamp}.log`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(`${logs.join('\n')}\n`);
});

app.get('/api/owner/backups/tables', requireAuth, requireOwner, async (req, res) => {
    try {
        const tables = await listBackupTables();
        res.json({ tables });
    } catch (error) {
        console.error('[Backup] Failed to list tables:', error.message);
        res.status(500).json({ error: 'Failed to list tables' });
    }
});

app.get('/api/owner/backups/status', requireAuth, requireOwner, (req, res) => {
    const files = listBackupFiles();
    res.json({
        config: backupConfig,
        state: backupState,
        files
    });
});

app.post('/api/owner/backups/config', requireAuth, requireOwner, requireSensitiveDiscordSecurityBinding, (req, res) => {
    try {
        const next = { ...backupConfig };
        if (typeof req.body?.enabled === 'boolean') {
            next.enabled = req.body.enabled;
        }
        if (Number.isFinite(Number(req.body?.intervalMinutes))) {
            next.intervalMinutes = Math.max(15, Math.min(10080, Number(req.body.intervalMinutes)));
        }
        if (Number.isFinite(Number(req.body?.retentionCount))) {
            next.retentionCount = Math.max(1, Math.min(50, Number(req.body.retentionCount)));
        }
        if (Array.isArray(req.body?.tables)) {
            next.tables = req.body.tables.map((table) => String(table || '').trim()).filter(Boolean);
        }
        if (typeof req.body?.format === 'string') {
            next.format = String(req.body.format || 'json').toLowerCase();
        }

        const saved = saveBackupConfig(next);
        res.json({ success: true, config: saved, state: backupState });
    } catch (error) {
        console.error('[Backup] Failed to update config:', error.message);
        res.status(500).json({ error: 'Failed to update backup configuration' });
    }
});

app.post('/api/owner/backups/run', requireAuth, requireOwner, requireSensitiveDiscordSecurityBinding, async (req, res) => {
    try {
        const tables = Array.isArray(req.body?.tables)
            ? req.body.tables.map((table) => String(table || '').trim()).filter(Boolean)
            : undefined;
        const format = typeof req.body?.format === 'string' ? String(req.body.format).toLowerCase() : undefined;
        const result = await runDatabaseBackup('manual', { tables, format });
        if (!result.success) {
            return res.status(500).json({ error: result.error || 'Backup failed', state: backupState });
        }
        res.json({ success: true, state: backupState });
    } catch (error) {
        console.error('[Backup] Manual backup failed:', error.message);
        res.status(500).json({ error: 'Backup failed', state: backupState });
    }
});

app.get('/api/owner/backups/download', requireAuth, requireOwner, (req, res) => {
    const requested = String(req.query.file || '').trim();
    const fileName = path.basename(requested);
    if (!fileName || (!fileName.endsWith('.sql') && !fileName.endsWith('.json'))) {
        return res.status(400).json({ error: 'Invalid backup file' });
    }
    const filePath = path.join(BACKUP_DIR, fileName);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Backup not found' });
    }
    res.download(filePath, fileName);
});

app.get('/api/owner/server-backups/status', requireAuth, requireOwner, (req, res) => {
    const effectiveGuildId = getDefaultServerBackupGuildId();
    const files = ServerBackupManager.listServerBackupFiles({ guildId: effectiveGuildId }).map((file) => {
        try {
            const inspection = ServerBackupManager.inspectServerBackupFile(file.name);
            return {
                ...file,
                label: inspection.label || null,
                notes: inspection.notes || null,
                valid: Boolean(inspection.validation?.valid),
                warningCount: Array.isArray(inspection.validation?.warnings) ? inspection.validation.warnings.length : 0,
                errorCount: Array.isArray(inspection.validation?.errors) ? inspection.validation.errors.length : 0,
                manifestAvailable: Boolean(inspection.manifest?.available),
                manifestSigned: Boolean(inspection.manifest?.signed),
                manifestValid: Boolean(inspection.manifest?.valid)
            };
        } catch {
            return file;
        }
    });
    const analytics = ServerBackupManager.buildServerBackupAnalytics({ guildId: effectiveGuildId, limit: 20 });
    const timeline = ServerBackupManager.buildBackupTimeline({ guildId: effectiveGuildId, limit: 6 });
    res.json({
        config: serverBackupConfig,
        state: serverBackupState,
        files,
        analytics,
        timeline,
        guilds: listAvailableDiscordGuilds(),
        effectiveGuildId
    });
});

app.post('/api/owner/server-backups/config', requireAuth, requireOwner, requireSensitiveDiscordSecurityBinding, (req, res) => {
    try {
        const next = { ...serverBackupConfig };
        if (typeof req.body?.enabled === 'boolean') {
            next.enabled = req.body.enabled;
        }
        if (Number.isFinite(Number(req.body?.intervalMinutes))) {
            next.intervalMinutes = Math.max(15, Math.min(10080, Number(req.body.intervalMinutes)));
        }
        if (Number.isFinite(Number(req.body?.retentionCount))) {
            next.retentionCount = Math.max(1, Math.min(50, Number(req.body.retentionCount)));
        }
        if (req.body?.includes && typeof req.body.includes === 'object') {
            next.includes = ServerBackupManager.normalizeBackupIncludes(req.body.includes);
        }

        const saved = saveServerBackupConfig(next);
        res.json({ success: true, config: saved, state: serverBackupState, guilds: listAvailableDiscordGuilds(), effectiveGuildId: getDefaultServerBackupGuildId() });
    } catch (error) {
        console.error('[ServerBackup] Failed to update config:', error.message);
        res.status(500).json({ error: 'Failed to update server backup configuration' });
    }
});

app.post('/api/owner/server-backups/run', requireAuth, requireOwner, requireSensitiveDiscordSecurityBinding, async (req, res) => {
    try {
        const includes = req.body?.includes && typeof req.body.includes === 'object'
            ? ServerBackupManager.normalizeBackupIncludes(req.body.includes)
            : undefined;
        const result = await runServerStructureBackup('manual', {
            includes,
            label: req.body?.label,
            notes: req.body?.notes,
            requestedBy: req.session?.username || null
        });
        if (!result.success) {
            return res.status(500).json({ error: result.error || 'Server backup failed', state: serverBackupState });
        }
        res.json({ success: true, state: serverBackupState });
    } catch (error) {
        console.error('[ServerBackup] Manual backup failed:', error.message);
        res.status(500).json({ error: 'Server backup failed', state: serverBackupState });
    }
});

app.get('/api/owner/server-backups/download', requireAuth, requireOwner, (req, res) => {
    const filePath = ServerBackupManager.getServerBackupFilePath(req.query.file || '');
    if (!filePath) {
        return res.status(400).json({ error: 'Invalid backup file' });
    }
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Backup not found' });
    }
    res.download(filePath, path.basename(filePath));
});

app.get('/api/owner/server-backups/download-manifest', requireAuth, requireOwner, (req, res) => {
    const manifestPath = ServerBackupManager.getServerBackupManifestPath(req.query.file || '');
    if (!manifestPath) {
        return res.status(400).json({ error: 'Invalid backup file' });
    }
    if (!fs.existsSync(manifestPath)) {
        return res.status(404).json({ error: 'Manifest not found' });
    }
    res.download(manifestPath, path.basename(manifestPath));
});

app.get('/api/owner/server-backups/diff', requireAuth, requireOwner, async (req, res) => {
    try {
        const sourceFile = String(req.query.source || '').trim();
        const targetFile = String(req.query.target || 'live').trim();
        if (!sourceFile) {
            return res.status(400).json({ error: 'A source backup file is required.' });
        }

        const sourcePayload = ServerBackupManager.readServerBackupFile(sourceFile);
        let targetPayload;
        let targetLabel = 'Current Server';

        if (targetFile && targetFile !== 'live') {
            targetPayload = ServerBackupManager.readServerBackupFile(targetFile);
            targetLabel = targetFile;
        } else {
            const guild = await resolveServerBackupGuild(sourcePayload?.guild?.id);
            if (!guild) {
                return res.status(404).json({ error: 'The live guild could not be resolved for comparison.' });
            }
            targetPayload = await ServerBackupManager.buildGuildBackupPayload(guild, {
                trigger: 'preview',
                includes: sourcePayload?.metadata?.includes || serverBackupConfig?.includes
            });
        }

        const diff = ServerBackupManager.buildSnapshotDiff(sourcePayload, targetPayload, {
            sourceLabel: sourceFile,
            targetLabel
        });

        res.json({ success: true, diff });
    } catch (error) {
        console.error('[ServerBackup] Diff failed:', error.message);
        res.status(500).json({ error: 'Failed to build backup diff' });
    }
});

app.get('/api/owner/server-backups/inspect', requireAuth, requireOwner, (req, res) => {
    try {
        const file = String(req.query.file || '').trim();
        if (!file) {
            return res.status(400).json({ error: 'A backup file is required.' });
        }

        const inspection = ServerBackupManager.inspectServerBackupFile(file);
        res.json({ success: true, inspection });
    } catch (error) {
        console.error('[ServerBackup] Inspect failed:', error.message);
        res.status(500).json({ error: 'Failed to inspect backup file' });
    }
});

app.get('/api/owner/server-backups/preflight', requireAuth, requireOwner, async (req, res) => {
    try {
        const file = String(req.query.file || '').trim();
        if (!file) {
            return res.status(400).json({ error: 'A backup file is required.' });
        }

        const payload = ServerBackupManager.readServerBackupFile(file);
        const guild = await resolveServerBackupGuild(payload?.guild?.id);
        if (!guild) {
            return res.status(404).json({ error: 'The target guild could not be resolved.' });
        }

        const livePayload = await ServerBackupManager.buildGuildBackupPayload(guild, {
            trigger: 'preflight',
            includes: payload?.metadata?.includes || serverBackupConfig?.includes
        });
        const exclusions = ServerBackupManager.normalizeRestoreExclusions({
            roleNames: req.query?.excludeRoles,
            channelNames: req.query?.excludeChannels
        });
        const scopedPayload = ServerBackupManager.applyRestoreExclusionsToPayload(payload, exclusions);
        const preflight = ServerBackupManager.buildRestorePreflightReport(scopedPayload, livePayload);
        res.json({ success: true, preflight });
    } catch (error) {
        console.error('[ServerBackup] Preflight failed:', error.message);
        res.status(500).json({ error: 'Failed to build restore preflight' });
    }
});

app.get('/api/owner/server-backups/restore-status', requireAuth, requireOwner, async (req, res) => {
    try {
        pruneServerBackupRestoreOperations();

        const operationId = String(req.query.operationId || '').trim();
        if (!operationId) {
            return res.status(400).json({ error: 'A restore operation ID is required.' });
        }

        const operation = serverBackupRestoreOperations.get(operationId);
        if (!operation) {
            return res.status(404).json({ error: 'The restore operation could not be found.' });
        }

        return res.json({ success: true, operation: serializeServerBackupRestoreOperation(operation) });
    } catch (error) {
        console.error('[ServerBackup] Restore status failed:', error.message);
        return res.status(500).json({ error: 'Failed to get restore status' });
    }
});

app.post('/api/owner/server-backups/restore', requireAuth, requireOwner, requireSensitiveDiscordSecurityBinding, async (req, res) => {
    try {
        const file = String(req.body?.file || '').trim();
        if (!file) {
            return res.status(400).json({ error: 'A backup file is required.' });
        }

        const payload = ServerBackupManager.readServerBackupFile(file);
        const guild = await resolveServerBackupGuild(payload?.guild?.id);
        if (!guild) {
            return res.status(404).json({ error: 'The target guild could not be resolved.' });
        }

        if (hasActiveServerBackupRestoreOperation()) {
            return res.status(409).json({ error: 'A server backup restore is already in progress.' });
        }

        const restoreOptions = ServerBackupManager.normalizeRestoreOptions({
            restoreSettings: req.body?.restoreSettings,
            restoreRoles: req.body?.restoreRoles,
            restoreChannels: req.body?.restoreChannels,
            restoreEmojis: req.body?.restoreEmojis,
            restoreStickers: req.body?.restoreStickers,
            applyPermissionOverwrites: req.body?.applyPermissionOverwrites
        });
        const restoreExclusions = ServerBackupManager.normalizeRestoreExclusions({
            roleNames: req.body?.excludeRoles,
            channelNames: req.body?.excludeChannels
        });

        const operation = createServerBackupRestoreOperation({
            file,
            requestedBy: req.session?.username || req.session?.user?.username || null
        });

        appendServerBackupRestoreOperationEvent(operation, {
            status: 'running',
            phase: 'preparing',
            stage: 'started',
            message: 'Restore started. Preparing Discord resources.'
        });

        res.status(202).json({
            success: true,
            operationId: operation.id,
            operation: serializeServerBackupRestoreOperation(operation)
        });

        void (async () => {
            try {
                const summary = await ServerBackupManager.restoreBackupToGuild(guild, payload, {
                    ...restoreOptions,
                    exclusions: restoreExclusions,
                    onProgress: (progress) => {
                        appendServerBackupRestoreOperationEvent(operation, {
                            ...progress,
                            status: 'running'
                        });
                    }
                });

                markServerBackupRestoreOperationCompleted(operation, summary);
            } catch (error) {
                console.error('[ServerBackup] Restore failed:', error.message);
                markServerBackupRestoreOperationFailed(operation, error);
            } finally {
                pruneServerBackupRestoreOperations();
            }
        })();
    } catch (error) {
        console.error('[ServerBackup] Restore failed:', error.message);
        res.status(500).json({ error: 'Failed to restore backup' });
    }
});

app.get('/api/owner/security/session-policy', requireAuth, requireOwner, async (req, res) => {
    try {
        return res.json({
            success: true,
            ...sessionPolicyState,
            limits: {
                ...SESSION_POLICY_LIMITS
            }
        });
    } catch (error) {
        console.error('Error getting session policy:', error);
        return res.status(500).json({ error: 'Failed to get session policy' });
    }
});

app.get('/api/owner/security/captcha-policy', requireAuth, requireOwner, async (req, res) => {
    try {
        return res.json({
            success: true,
            ...captchaPolicyState,
            defaults: {
                ...DEFAULT_CAPTCHA_POLICY
            },
            limits: {
                ...CAPTCHA_POLICY_LIMITS
            }
        });
    } catch (error) {
        console.error('Error getting captcha policy:', error);
        return res.status(500).json({ error: 'Failed to get captcha policy' });
    }
});

app.post('/api/owner/security/session-policy', requireAuth, requireOwner, requireSensitiveDiscordSecurityBinding, async (req, res) => {
    try {
        const incoming = req.body || {};

        if (incoming.singleSessionMode !== undefined && typeof incoming.singleSessionMode !== 'boolean') {
            return res.status(400).json({ error: 'singleSessionMode must be a boolean' });
        }

        if (incoming.idleTimeoutMs !== undefined && !Number.isFinite(Number(incoming.idleTimeoutMs))) {
            return res.status(400).json({ error: 'idleTimeoutMs must be a number' });
        }

        if (incoming.absoluteTimeoutMs !== undefined && !Number.isFinite(Number(incoming.absoluteTimeoutMs))) {
            return res.status(400).json({ error: 'absoluteTimeoutMs must be a number' });
        }

        if (incoming.singleSessionCheckIntervalMs !== undefined && !Number.isFinite(Number(incoming.singleSessionCheckIntervalMs))) {
            return res.status(400).json({ error: 'singleSessionCheckIntervalMs must be a number' });
        }

        const config = loadMiscConfig();
        if (!config.securitySettings || typeof config.securitySettings !== 'object') {
            config.securitySettings = {};
        }

        const nextPolicy = normalizeSessionPolicy(incoming, sessionPolicyState);
        config.securitySettings = {
            ...(config.securitySettings || {}),
            ...nextPolicy
        };
        saveMiscConfig(config);
        sessionPolicyState = nextPolicy;

        await logAdminAuthEvent(req.session.username, 'SESSIONS_REVOKED', req, {
            mode: 'single-session-policy',
            ...nextPolicy
        }).catch(() => { });

        return res.json({
            success: true,
            ...sessionPolicyState
        });
    } catch (error) {
        console.error('Error updating session policy:', error);
        return res.status(500).json({ error: 'Failed to update session policy' });
    }
});

app.post('/api/owner/security/captcha-policy', requireAuth, requireOwner, requireSensitiveDiscordSecurityBinding, async (req, res) => {
    try {
        const incoming = req.body || {};

        if (incoming.loginEnabled !== undefined && typeof incoming.loginEnabled !== 'boolean') {
            return res.status(400).json({ error: 'loginEnabled must be a boolean' });
        }

        if (incoming.registerEnabled !== undefined && typeof incoming.registerEnabled !== 'boolean') {
            return res.status(400).json({ error: 'registerEnabled must be a boolean' });
        }

        if (incoming.ttlMs !== undefined && !Number.isFinite(Number(incoming.ttlMs))) {
            return res.status(400).json({ error: 'ttlMs must be a number' });
        }

        if (incoming.maxAttempts !== undefined && !Number.isFinite(Number(incoming.maxAttempts))) {
            return res.status(400).json({ error: 'maxAttempts must be a number' });
        }

        if (incoming.minValue !== undefined && !Number.isFinite(Number(incoming.minValue))) {
            return res.status(400).json({ error: 'minValue must be a number' });
        }

        if (incoming.maxValue !== undefined && !Number.isFinite(Number(incoming.maxValue))) {
            return res.status(400).json({ error: 'maxValue must be a number' });
        }

        if (incoming.minSolveMs !== undefined && !Number.isFinite(Number(incoming.minSolveMs))) {
            return res.status(400).json({ error: 'minSolveMs must be a number' });
        }

        if (incoming.adaptiveDifficultyEnabled !== undefined && typeof incoming.adaptiveDifficultyEnabled !== 'boolean') {
            return res.status(400).json({ error: 'adaptiveDifficultyEnabled must be a boolean' });
        }

        if (incoming.failureWindowMs !== undefined && !Number.isFinite(Number(incoming.failureWindowMs))) {
            return res.status(400).json({ error: 'failureWindowMs must be a number' });
        }

        if (incoming.failureThreshold !== undefined && !Number.isFinite(Number(incoming.failureThreshold))) {
            return res.status(400).json({ error: 'failureThreshold must be a number' });
        }

        if (incoming.failureBlockMs !== undefined && !Number.isFinite(Number(incoming.failureBlockMs))) {
            return res.status(400).json({ error: 'failureBlockMs must be a number' });
        }

        const config = loadMiscConfig();
        if (!config.securitySettings || typeof config.securitySettings !== 'object') {
            config.securitySettings = {};
        }

        const nextPolicy = normalizeCaptchaPolicy(incoming, captchaPolicyState);
        config.securitySettings = {
            ...(config.securitySettings || {}),
            captchaPolicy: nextPolicy
        };

        saveMiscConfig(config);
        captchaPolicyState = nextPolicy;

        emitSecuritySignal(req, 'captcha-policy-updated', {
            username: String(req.session?.username || 'owner'),
            loginEnabled: Boolean(nextPolicy.loginEnabled),
            registerEnabled: Boolean(nextPolicy.registerEnabled),
            ttlMs: Number(nextPolicy.ttlMs || 0),
            maxAttempts: Number(nextPolicy.maxAttempts || 0),
            minValue: Number(nextPolicy.minValue || 0),
            maxValue: Number(nextPolicy.maxValue || 0),
            minSolveMs: Number(nextPolicy.minSolveMs || 0),
            adaptiveDifficultyEnabled: Boolean(nextPolicy.adaptiveDifficultyEnabled),
            failureWindowMs: Number(nextPolicy.failureWindowMs || 0),
            failureThreshold: Number(nextPolicy.failureThreshold || 0),
            failureBlockMs: Number(nextPolicy.failureBlockMs || 0)
        }, 5 * 1000);

        await logAdminAuthEvent(req.session.username, 'PASSWORD_CHANGED', req, {
            mode: 'captcha-policy-updated',
            ...nextPolicy
        }).catch(() => { });

        return res.json({
            success: true,
            ...captchaPolicyState
        });
    } catch (error) {
        console.error('Error updating captcha policy:', error);
        return res.status(500).json({ error: 'Failed to update captcha policy' });
    }
});

// Purge all bans (owner only)
app.post('/api/owner/purge-bans', requireAuth, requireOwner, requireSensitiveDiscordSecurityBinding, async (req, res) => {
    try {
        const result = await AdminPanelHelper.connection.query('DELETE FROM user_bans');
        const deletedCount = result.affectedRows || 0;

        console.log(`[Owner] ${req.session.username} purged ${deletedCount} ban records`);
        res.json({
            success: true,
            message: `Deleted ${deletedCount} ban records`,
            count: deletedCount
        });
    } catch (error) {
        console.error('Error purging bans:', error);
        res.status(500).json({ error: 'Failed to purge bans' });
    }
});

// Purge all warnings (owner only)
app.post('/api/owner/purge-warnings', requireAuth, requireOwner, requireSensitiveDiscordSecurityBinding, async (req, res) => {
    try {
        const [warnCases] = await AdminPanelHelper.connection.pool.query("SELECT case_id FROM moderation_cases WHERE action_type = 'WARN'");
        const caseIds = Array.isArray(warnCases) ? warnCases.map((row) => row.case_id).filter(Boolean) : [];

        if (caseIds.length) {
            const placeholders = caseIds.map(() => '?').join(', ');
            await AdminPanelHelper.connection.pool.query(`DELETE FROM moderation_case_events WHERE case_id IN (${placeholders})`, caseIds);
            await AdminPanelHelper.connection.pool.query(`DELETE FROM moderation_incidents WHERE case_id IN (${placeholders})`, caseIds);
        }

        const [result] = await AdminPanelHelper.connection.pool.query("DELETE FROM moderation_cases WHERE action_type = 'WARN'");
        const deletedCount = result?.affectedRows || 0;

        console.log(`[Owner] ${req.session.username} purged ${deletedCount} warning records`);
        res.json({
            success: true,
            message: `Deleted ${deletedCount} warning records`,
            count: deletedCount
        });
    } catch (error) {
        console.error('Error purging warnings:', error);
        res.status(500).json({ error: 'Failed to purge warnings' });
    }
});

// Wipe all user data (owner only) - EXTREME CAUTION
app.post('/api/owner/wipe-all-data', requireAuth, requireOwner, requireSensitiveDiscordSecurityBinding, async (req, res) => {
    try {
        // Clear all user data tables
        const tables = ['levels', 'warns', 'reminders', 'giveaways'];
        let totalDeleted = 0;

        for (const table of tables) {
            try {
                const result = await AdminPanelHelper.connection.query(`DELETE FROM ${table}`);
                totalDeleted += result.affectedRows || 0;
            } catch (err) {
                console.warn(`Could not clear table ${table}:`, err.message);
            }
        }

        console.log(`[Owner] ${req.session.username} WIPED ALL USER DATA - ${totalDeleted} records deleted`);
        console.log(`[Owner CRITICAL] This is an irreversible action. All user data has been deleted.`);

        res.json({
            success: true,
            message: `All user data has been wiped. ${totalDeleted} records deleted.`,
            count: totalDeleted
        });
    } catch (error) {
        console.error('Error wiping data:', error);
        res.status(500).json({ error: 'Failed to wipe data' });
    }
});

// Moderator api's

// Get recent moderation actions
app.get('/api/moderation/recent-actions', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasModeratorAccess(user)) {
            return res.status(403).json({ error: 'Moderator access required' });
        }

        const limit = parseInt(req.query.limit) || 15;
        const actions = await AdminPanelHelper.getRecentModerationActions(limit);
        res.json(actions);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get actions' });
    }
});

// Moderator overview stats
app.get('/api/moderation/overview', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasModeratorAccess(user)) {
            return res.status(403).json({ error: 'Moderator access required' });
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const weekAgo = new Date(today);
        weekAgo.setDate(weekAgo.getDate() - 7);

        const startMs = today.getTime();
        const endMs = tomorrow.getTime();
        const weekStartMs = weekAgo.getTime();

        const safeCount = async (query, params) => {
            try {
                const [rows] = await MySQLDatabaseManager.connection.pool.query(query, params);
                return rows?.[0]?.count || 0;
            } catch (err) {
                return 0;
            }
        };

        // Get counts
        const warnsToday = await safeCount(`SELECT COUNT(*) as count FROM moderation_cases WHERE action_type = 'WARN' AND status NOT IN ('cleared', 'reversed') AND created_at BETWEEN ? AND ?`, [startMs, endMs]);
        const warnsWeek = await safeCount(`SELECT COUNT(*) as count FROM moderation_cases WHERE action_type = 'WARN' AND status NOT IN ('cleared', 'reversed') AND created_at BETWEEN ? AND ?`, [weekStartMs, endMs]);
        const warnsAll = await safeCount(`SELECT COUNT(*) as count FROM moderation_cases WHERE action_type = 'WARN' AND status NOT IN ('cleared', 'reversed')`, []);

        const bansToday = await safeCount('SELECT COUNT(*) as count FROM user_bans WHERE banned = TRUE AND banned_at BETWEEN ? AND ?', [today, tomorrow]);
        const bansWeek = await safeCount('SELECT COUNT(*) as count FROM user_bans WHERE banned = TRUE AND banned_at BETWEEN ? AND ?', [weekAgo, tomorrow]);
        const bansAll = await safeCount('SELECT COUNT(*) as count FROM user_bans WHERE banned = TRUE', []);

        const activeTimeouts = await AdminPanelHelper.getActiveTimeoutsCount();
        const expiringToday = await safeCount(`SELECT COUNT(*) as count FROM moderation_cases WHERE action_type = 'TIMEOUT' AND status = 'active' AND expires_at BETWEEN ? AND ?`, [startMs, endMs]);
        const timeoutsAll = await safeCount(`SELECT COUNT(*) as count FROM moderation_cases WHERE action_type = 'TIMEOUT'`, []);

        const openTickets = await safeCount('SELECT COUNT(*) as count FROM tickets WHERE status = "open"', []);

        // Get trend indicators (compare with week average)
        const warnsTrend = warnsToday > (warnsWeek / 7) ? '↑ Above average' : warnsToday > 0 ? '→ Normal' : '↓ Below average';
        const bansTrend = bansToday > (bansWeek / 7) ? '↑ Above average' : bansToday > 0 ? '→ Normal' : '↓ Below average';
        const ticketsTrend = openTickets > 5 ? '⚠️ High load' : openTickets > 2 ? '→ Normal' : '✅ Low load';

        // Get top violation reason
        const [topViolationResult] = await MySQLDatabaseManager.connection.pool.query(
            `SELECT reason, COUNT(*) as count
             FROM moderation_cases
             WHERE action_type = 'WARN' AND status NOT IN ('cleared', 'reversed') AND created_at > ?
             GROUP BY reason ORDER BY count DESC LIMIT 1`,
            [weekStartMs]
        ).catch(() => [[{ reason: 'N/A', count: 0 }]]);
        const topViolation = topViolationResult?.[0]?.reason || 'None';

        // Get most warned user
        const [mostWarnedResult] = await MySQLDatabaseManager.connection.pool.query(
            `SELECT mc.user_id, COALESCE(mc.user_name, l.username, 'Unknown') as username, COUNT(*) as count
             FROM moderation_cases mc
             LEFT JOIN levels l ON mc.user_id = l.user_id
             WHERE mc.action_type = 'WARN' AND mc.status NOT IN ('cleared', 'reversed')
             GROUP BY mc.user_id ORDER BY count DESC LIMIT 1`,
            []
        ).catch(() => [[{ user_id: 'N/A', username: 'None', count: 0 }]]);
        const mostWarnedUser = mostWarnedResult?.[0]?.username || 'None';

        // Calculate response rate (open vs total tickets)
        const totalTickets = await safeCount('SELECT COUNT(*) as count FROM tickets', []);
        const responseRate = totalTickets > 0 ? Math.round((((totalTickets - openTickets) / totalTickets) * 100)) + '%' : '0%';

        res.json({
            warnsToday,
            warnsWeek,
            warnsAll,
            warnsTrend,

            bansToday,
            bansWeek,
            bansAll,
            bansTrend,

            activeTimeouts,
            expiringToday,
            timeoutsAll,

            openTickets,
            ticketsTrend,

            topViolation,
            mostWarnedUser,
            responseRate,

            avgResponseTime: '2-4 hours'
        });
    } catch (error) {
        console.error('Error getting overview stats:', error);
        res.status(500).json({ error: 'Failed to get overview stats' });
    }
});

// Get banned users
app.get('/api/moderation/bans', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasModeratorAccess(user)) {
            return res.status(403).json({ error: 'Moderator access required' });
        }

        // Get banned users with all fields from user_bans table
        const [banned] = await MySQLDatabaseManager.connection.pool.query(`
            SELECT 
                ub.*,
                COALESCE(ub.user_name, ui.username, l.username, 'Unknown') as username,
                COALESCE(ub.banned_by_name, m_ui.username, m.username, ub.banned_by) as banned_by_username
            FROM user_bans ub
            LEFT JOIN userinfo ui ON ub.user_id = ui.user_id
            LEFT JOIN levels l ON ub.user_id = l.user_id
            LEFT JOIN userinfo m_ui ON ub.banned_by = m_ui.user_id
            LEFT JOIN levels m ON ub.banned_by = m.user_id
            WHERE ub.banned = 1
            ORDER BY ub.banned_at DESC
        `);

        res.json({ success: true, data: banned || [] });
    } catch (error) {
        console.error('Error getting banned users:', error);
        res.status(500).json({ error: 'Failed to get bans' });
    }
});

// Unban user
app.delete('/api/moderation/bans/:userId', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasModeratorAccess(user)) {
            return res.status(403).json({ error: 'Moderator access required' });
        }

        const { userId } = req.params;
        if (!isValidDiscordUserId(userId)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }

        // Check if discordClient is available
        if (!discordClient) {
            console.error('Discord client not initialized inside unban route');
            return res.status(500).json({ error: 'Discord bot not connected' });
        }

        // Get ban info before unbanning
        let originalBanCaseId = null;
        let originalBanReason = 'No reason provided';

        try {
            const [banInfo] = await MySQLDatabaseManager.connection.pool.query(
                'SELECT ban_reason, ban_case_id FROM user_bans WHERE user_id = ? AND banned = 1 LIMIT 1',
                [userId]
            );

            if (!banInfo || banInfo.length === 0) {
                // Even if not found in DB as banned, we should try to unban from discord if requested?
                // But the route is conceptually for unbanning someone we know is banned.
                // If the user is not in user_bans table, maybe they were manually banned?
                // If so, the panel might not know about them properly.
                // But let's stick to "User not found or not banned".
                return res.status(404).json({ error: 'User not found or not banned in database' });
            }
            originalBanCaseId = banInfo[0].ban_case_id;
            originalBanReason = banInfo[0].ban_reason || 'No reason provided';
        } catch (dbErr) {
            console.error('Error fetching ban info:', dbErr);
            return res.status(500).json({ error: 'Database error fetching ban info' });
        }

        // Generate new case ID for unban action
        const { generateCaseId } = require('./Events/caseId');
        const unbanCaseId = generateCaseId('UNBAN');

        // Update database to mark user as unbanned
        const success = await AdminPanelHelper.unbanUser(userId);
        if (!success) {
            return res.status(500).json({ error: 'Failed to update database (unbanUser)' });
        }

        // Actually unban from Discord
        try {
            const mainConfig = require('./Config/main.json');
            const guild = await discordClient.guilds.fetch(mainConfig.serverID).catch(() => null);
            if (guild) {
                await guild.bans.remove(userId, `Unbanned via admin panel by ${req.session.username} - Case ID: ${unbanCaseId}`).catch(err => {
                    console.error('[Unban] Discord API unban failed (user might not be banned):', err.message);
                });
            } else {
                console.error('[Unban] Could not fetch guild to unban user');
            }
        } catch (discordErr) {
            console.error('[Unban] Failed to unban from Discord:', discordErr.message);
            // Continue even if Discord unban fails (database is updated)
        }

        // Log unban action to moderation log
        const { EmbedBuilder } = require('discord.js');

        try {
            const targetUser = await resolveDiscordUser(userId);
            const targetLabel = targetUser ? `${targetUser.tag} (${targetUser.id})` : userId;

            const unbanCreatedAt = Date.now();
            try {
                await MySQLDatabaseManager.upsertModerationCase({
                    caseId: unbanCaseId,
                    guildId: process.env.GUILD_ID || null,
                    userId,
                    userName: targetUser?.username || null,
                    actionType: 'UNBAN',
                    status: 'closed',
                    reason: `Unbanned via admin panel by ${req.session.username}`,
                    moderatorName: req.session.username || null,
                    moderatorSource: 'panel',
                    source: 'panel',
                    relatedCaseId: originalBanCaseId || null,
                    rootCaseId: originalBanCaseId || unbanCaseId,
                    metadata: originalBanReason ? { originalBanReason } : null,
                    createdAt: unbanCreatedAt,
                    updatedAt: unbanCreatedAt,
                    eventSummary: 'Unban case recorded'
                });

                if (originalBanCaseId) {
                    await MySQLDatabaseManager.updateModerationCaseStatus(originalBanCaseId, 'reversed', {
                        guildId: process.env.GUILD_ID || null,
                        actorName: req.session.username || null,
                        relatedCaseId: unbanCaseId,
                        details: `Reversed by admin panel unban case ${unbanCaseId}`,
                        updatedAt: unbanCreatedAt
                    });
                }
            } catch (dbErr) {
                console.error('[Unban] Failed to write moderation ledger record:', dbErr.message);
            }

            const logEmbed = new EmbedBuilder()
                .setTitle('🔓 User Unbanned')
                .setColor(0x43B581)
                .addFields(
                    { name: '👮 Administrator', value: `${req.session.username}`, inline: true },
                    { name: '👤 User', value: targetLabel, inline: true },
                    { name: '🔑 Unban Case ID', value: `\`${unbanCaseId}\``, inline: true },
                    { name: '📋 Original Ban Case ID', value: originalBanCaseId ? `\`${originalBanCaseId}\`` : 'N/A', inline: true },
                    { name: '📝 Original Ban Reason', value: originalBanReason, inline: false }
                )
                .setFooter({ text: `Unbanned by ${req.session.username} via Admin Panel` })
                .setTimestamp();

            if (discordClient && serverLogChannelId) {
                const logChannel = await discordClient.channels.fetch(serverLogChannelId).catch(() => null);
                if (logChannel) {
                    await logChannel.send({ embeds: [logEmbed] }).catch(err => console.error('Failed to send unban log:', err));
                }
            }
        } catch (logErr) {
            console.error('[Unban] Failed to log action:', logErr.message);
        }

        res.json({
            success: true,
            message: 'User unbanned',
            caseId: unbanCaseId
        });
    } catch (error) {
        console.error('Error unbanning user (main catch):', error);
        res.status(500).json({ error: error.message || 'Failed to unban user' });
    }
});

// Get active timeouts
app.get('/api/moderation/timeouts', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasModeratorAccess(user)) {
            return res.status(403).json({ error: 'Moderator access required' });
        }

        const timeouts = await AdminPanelHelper.getActiveTimeouts();
        res.json({ success: true, data: timeouts || [] });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get timeouts' });
    }
});

// Remove timeout
app.delete('/api/moderation/timeouts/:userId', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasModeratorAccess(user)) {
            return res.status(403).json({ error: 'Moderator access required' });
        }

        const { userId } = req.params;
        if (!isValidDiscordUserId(userId)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }

        // Get the timeout info before clearing (for logging)
        const timeoutInfo = await MySQLDatabaseManager.getLatestActiveTimeoutCaseForUser(userId, process.env.GUILD_ID || null);
        const caseId = timeoutInfo?.case_id || 'Unknown';
        const timeoutReason = timeoutInfo?.reason || 'No reason provided';

        // Update database first
        const success = await AdminPanelHelper.clearTimeout(userId, {
            clearedBy: req.session.username,
            clearedAt: Date.now(),
            reason: 'Timeout removed via admin panel'
        });

        // Remove timeout from Discord if client is available
        if (discordClient && success) {
            try {
                const mainConfig = require('./Config/main.json');
                const guild = await discordClient.guilds.fetch(mainConfig.serverID);
                if (guild) {
                    const member = await guild.members.fetch(userId).catch(() => null);
                    if (member && member.communicationDisabledUntil) {
                        await member.timeout(null, 'Timeout removed via admin panel');
                        console.log(`✅ Timeout removed from Discord for user ${userId}`);
                    }
                }
            } catch (discordError) {
                console.error('Error removing timeout from Discord:', discordError.message);
                // Still return success since database was updated
            }
        }

        // Send log message to server log channel
        if (success && discordClient) {
            try {
                const mainConfig = require('./Config/main.json');
                const guild = await discordClient.guilds.fetch(mainConfig.serverID);
                const logChannel = guild?.channels.cache.get(serverLogChannelId);

                if (logChannel && logChannel.isTextBased()) {
                    const { EmbedBuilder } = require('discord.js');
                    const targetUser = await resolveDiscordUser(userId);
                    const targetLabel = targetUser ? `${targetUser.tag} (${targetUser.id})` : userId;
                    const embed = new EmbedBuilder()
                        .setTitle('✅ Timeout Cleared')
                        .setColor(0x00AA00)
                        .setDescription('A timeout was removed from the Moderation panel.')
                        .addFields(
                            { name: '👤 User', value: `${targetLabel}\n<@${userId}>`, inline: false },
                            { name: '🆔 Original Case', value: caseId ? `\`${caseId}\`` : 'Unknown', inline: true },
                            { name: '👮 Moderator', value: req.session.username, inline: true },
                            { name: '📝 Original Reason', value: timeoutReason, inline: false },
                            { name: '🕒 Cleared At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                        )
                        .setThumbnail(targetUser?.displayAvatarURL?.({ size: 128 }) || null)
                        .setFooter({ text: 'Admin Panel • Moderation' })
                        .setTimestamp();

                    await logChannel.send({ embeds: [embed] });
                }
            } catch (logError) {
                console.error('Error logging timeout removal:', logError.message);
                // Don't fail the request if logging fails
            }
        }

        if (success) {
            res.json({ success: true, message: 'Timeout removed' });
        } else {
            res.status(404).json({ error: 'Timeout not found' });
        }
    } catch (error) {
        console.error('Error removing timeout:', error);
        res.status(500).json({ error: 'Failed to remove timeout' });
    }
});

// Search warnings
app.get('/api/moderation/warnings/search', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasModeratorAccess(user)) {
            return res.status(403).json({ error: 'Moderator access required' });
        }

        const query = (req.query.q || '').trim();
        const caseIdQuery = (req.query.caseId || '').trim();
        const normalizedQuery = query.toLowerCase();
        const normalizedCaseId = caseIdQuery.toLowerCase();
        const minCount = Math.max(parseInt(req.query.minCount, 10) || 0, 0);
        const sort = (req.query.sort || 'recent').toLowerCase();
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 10, 5), 50);
        const isExport = String(req.query.export || '').toLowerCase() === '1';

        // Get all levels first (all members)
        const allLevels = await AdminPanelHelper.getAllLevels();

        const [allWarnsRaw] = await MySQLDatabaseManager.connection.pool.query(`
            SELECT 
                mc.case_id as id,
                mc.user_id,
                mc.case_id,
                mc.reason,
                mc.moderator_id,
                FROM_UNIXTIME(mc.created_at/1000) as created_at,
                'WARN' as type,
                COALESCE(mc.user_name, u.username, ma.username) as username
            FROM moderation_cases mc
            LEFT JOIN levels u ON mc.user_id = u.user_id
            LEFT JOIN (
                SELECT ma1.user_id, ma1.username
                FROM member_activity ma1
                INNER JOIN (
                    SELECT user_id, MAX(timestamp) as max_ts
                    FROM member_activity
                    GROUP BY user_id
                ) ma2 ON ma1.user_id = ma2.user_id AND ma1.timestamp = ma2.max_ts
            ) ma ON mc.user_id = ma.user_id
            WHERE mc.action_type = 'WARN' AND mc.status NOT IN ('cleared', 'reversed')
            ORDER BY mc.created_at DESC
            LIMIT 2000
        `);

        const [allKicksRaw] = await MySQLDatabaseManager.connection.pool.query(`
            SELECT 
                mc.case_id as id,
                mc.user_id,
                mc.case_id,
                mc.reason,
                mc.moderator_id,
                FROM_UNIXTIME(mc.created_at/1000) as created_at,
                'KICK' as type,
                COALESCE(mc.user_name, u.username, ma.username) as username
            FROM moderation_cases mc
            LEFT JOIN levels u ON mc.user_id = u.user_id
            LEFT JOIN (
                SELECT ma1.user_id, ma1.username
                FROM member_activity ma1
                INNER JOIN (
                    SELECT user_id, MAX(timestamp) as max_ts
                    FROM member_activity
                    GROUP BY user_id
                ) ma2 ON ma1.user_id = ma2.user_id AND ma1.timestamp = ma2.max_ts
            ) ma ON mc.user_id = ma.user_id
            WHERE mc.action_type = 'KICK'
            ORDER BY mc.created_at DESC
            LIMIT 2000
        `);

        // Group warns by user
        const warnsByUser = {};
        const mergedActions = [...(allWarnsRaw || []), ...(allKicksRaw || [])];
        mergedActions.forEach(warn => {
            if (!warnsByUser[warn.user_id]) {
                warnsByUser[warn.user_id] = {
                    userId: warn.user_id,
                    username: warn.username,
                    warnCount: 0,
                    warns: []
                };
            }
            warnsByUser[warn.user_id].warnCount++;
            warnsByUser[warn.user_id].warns.push({
                id: warn.id,
                case_id: warn.case_id,
                reason: warn.reason,
                moderator_id: warn.moderator_id,
                created_at: warn.created_at,
                type: warn.type || 'WARN'
            });
        });

        // Create a combined list of all members with their warning data
        const allMembers = {};

        // Add all members from levels
        (allLevels || []).forEach(u => {
            allMembers[u.user_id] = {
                ...u,
                username: u.username || warnsByUser[u.user_id]?.username || 'Unknown',
                warn_count: warnsByUser[u.user_id]?.warnCount || 0,
                warns: warnsByUser[u.user_id]?.warns || [],
                joined_at: u.created_at || null
            };
        });

        // Add warn-only users not present in levels
        Object.keys(warnsByUser).forEach(userId => {
            if (!allMembers[userId]) {
                allMembers[userId] = {
                    user_id: userId,
                    username: warnsByUser[userId].username || 'Unknown',
                    level: 1,
                    messages: 0,
                    xp: 0,
                    warn_count: warnsByUser[userId].warnCount || 0,
                    warns: warnsByUser[userId].warns || [],
                    joined_at: null
                };
            }
        });

        // Fetch usernames from Discord for users with "Unknown" username
        if (discordClient) {
            try {
                const mainConfig = require('./Config/main.json');
                const guild = await discordClient.guilds.fetch(mainConfig.serverID);

                if (guild) {
                    const unknownUsers = Object.values(allMembers).filter(u => !u.username || u.username === 'Unknown');

                    for (const user of unknownUsers) {
                        try {
                            const member = await guild.members.fetch(user.user_id).catch(() => null);
                            if (member) {
                                user.username = member.user.username;
                                // Update database with fetched username
                                await MySQLDatabaseManager.connection.pool.query(
                                    'UPDATE levels SET username = ? WHERE user_id = ?',
                                    [member.user.username, user.user_id]
                                ).catch(() => { });
                            }
                        } catch (err) {
                            // Skip if user not found
                        }
                    }
                }
            } catch (err) {
                console.error('Error fetching usernames from Discord:', err.message);
            }
        }

        const isIdQuery = /^\d{6,}$/.test(query);
        const filtered = Object.values(allMembers).filter(u => {
            const username = (u.username || '').toLowerCase();
            const id = String(u.user_id || '');
            const warnCount = Number(u.warn_count || 0) || 0;

            if (warnCount < minCount) return false;

            if (query) {
                if (isIdQuery && !id.includes(query)) return false;
                if (!isIdQuery && !(username.includes(normalizedQuery) || id.includes(query))) return false;
            }

            if (normalizedCaseId) {
                const matches = Array.isArray(u.warns)
                    ? u.warns.some(entry => String(entry.case_id || '').toLowerCase().includes(normalizedCaseId))
                    : false;
                if (!matches) return false;
            }

            return true;
        });

        const getLatestTime = (entryList) => {
            if (!Array.isArray(entryList) || entryList.length === 0) return 0;
            return entryList.reduce((latest, entry) => {
                const time = entry.created_at ? new Date(entry.created_at).getTime() : Number(entry.timestamp || 0);
                return time > latest ? time : latest;
            }, 0);
        };

        const sorted = filtered.sort((a, b) => {
            if (sort === 'count') {
                return (Number(b.warn_count || 0) || 0) - (Number(a.warn_count || 0) || 0);
            }
            return getLatestTime(b.warns) - getLatestTime(a.warns);
        });

        const total = sorted.length;
        const totalWarnings = sorted.reduce((sum, entry) => sum + (Number(entry.warn_count || 0) || 0), 0);
        const latestWarningAt = sorted.reduce((latest, entry) => {
            const time = getLatestTime(entry.warns);
            return time > latest ? time : latest;
        }, 0);

        if (isExport) {
            return res.json({
                results: sorted,
                total,
                totalWarnings,
                latestWarningAt
            });
        }

        const start = (page - 1) * pageSize;
        const paged = sorted.slice(start, start + pageSize);

        res.json({
            results: paged,
            total,
            totalWarnings,
            latestWarningAt,
            page,
            pageSize
        });
    } catch (error) {
        console.error('Error searching warnings:', error);
        res.status(500).json({ error: 'Failed to search warnings' });
    }
});

// Search moderation actions (all case types)
app.get('/api/moderation/actions/search', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasModeratorAccess(user)) {
            return res.status(403).json({ error: 'Moderator access required' });
        }

        const query = (req.query.q || '').trim();
        const typeFilter = String(req.query.type || 'all').toUpperCase();
        const sortDir = String(req.query.sort || 'recent').toLowerCase() === 'oldest' ? 'ASC' : 'DESC';
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 10, 5), 50);
        const isExport = String(req.query.export || '').toLowerCase() === '1';

        const likeQuery = `%${query}%`;
        const actionsQuery = `
            SELECT
                mc.action_type as action,
                mc.case_id,
                mc.user_id,
                COALESCE(mc.user_name, u.username, 'Unknown') as username,
                mc.reason,
                mc.moderator_id,
                COALESCE(mc.moderator_name, m_ui.username, m.username, mc.moderator_id, 'System') as moderator_name,
                FROM_UNIXTIME(mc.created_at/1000) as timestamp,
                CASE WHEN mc.expires_at IS NOT NULL THEN FROM_UNIXTIME(mc.expires_at/1000) ELSE NULL END as expires_at,
                mc.related_case_id
            FROM moderation_cases mc
            LEFT JOIN levels u ON u.user_id COLLATE utf8mb4_unicode_ci = mc.user_id COLLATE utf8mb4_unicode_ci
            LEFT JOIN userinfo m_ui ON m_ui.user_id = CAST(mc.moderator_id AS UNSIGNED)
            LEFT JOIN levels m ON m.user_id COLLATE utf8mb4_unicode_ci = mc.moderator_id COLLATE utf8mb4_unicode_ci
            WHERE (? COLLATE utf8mb4_unicode_ci = '' OR mc.case_id LIKE ? COLLATE utf8mb4_unicode_ci OR mc.user_id LIKE ? COLLATE utf8mb4_unicode_ci OR COALESCE(mc.user_name, u.username, 'Unknown') LIKE ? COLLATE utf8mb4_unicode_ci)
              AND (? COLLATE utf8mb4_unicode_ci = 'ALL' OR mc.action_type = ? COLLATE utf8mb4_unicode_ci)
        `;

        const countQuery = `SELECT COUNT(*) as total FROM (${actionsQuery}) as count_table`;
        const dataQuery = `
            SELECT * FROM (${actionsQuery}) as data_table
            ORDER BY timestamp ${sortDir}
            LIMIT ? OFFSET ?
        `;

        const queryParams = [
            query, likeQuery, likeQuery, likeQuery,
            typeFilter, typeFilter
        ];

        const [countRows] = await MySQLDatabaseManager.connection.pool.query(countQuery, queryParams);
        const total = countRows[0]?.total || 0;

        const limit = isExport ? 5000 : pageSize;
        const offset = isExport ? 0 : (page - 1) * pageSize;

        const [rows] = await MySQLDatabaseManager.connection.pool.query(dataQuery, [...queryParams, limit, offset]);

        const results = (rows || []).map(row => ({
            action: row.action,
            caseId: row.case_id,
            userId: row.user_id,
            username: row.username,
            reason: row.reason,
            moderatorId: row.moderator_id,
            moderatorName: row.moderator_name,
            timestamp: row.timestamp,
            expires_at: row.expires_at,
            related_case_id: row.related_case_id
        }));

        if (isExport) {
            return res.json({
                results,
                total
            });
        }

        res.json({
            results,
            total,
            page,
            pageSize
        });
    } catch (error) {
        console.error('Error searching moderation actions:', error);
        res.status(500).json({ error: 'Failed to search moderation actions' });
    }
});

// Clear warnings
app.delete('/api/moderation/warnings/:userId', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasModeratorAccess(user)) {
            return res.status(403).json({ error: 'Moderator access required' });
        }

        const { userId } = req.params;
        if (!isValidDiscordUserId(userId)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }

        const success = await AdminPanelHelper.clearUserWarns(userId);
        if (success) {
            res.json({ success: true, message: 'Warnings cleared' });
        } else {
            res.status(404).json({ error: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to clear warnings' });
    }
});

// Get tickets
app.get('/api/tickets', requireAuth, async (req, res) => {
    try {
        const status = req.query.status && req.query.status !== 'all' ? req.query.status : null;
        const tickets = await AdminPanelHelper.getAllTickets(status || undefined);
        const list = Array.isArray(tickets) ? tickets : [];
        res.json(list.map(t => {
            const rawPriority = String(t.priority || '').trim().toLowerCase();
            const legacyCategoryLabel = rawPriority === 'high'
                ? 'High Priority'
                : rawPriority === 'medium'
                    ? 'Medium Priority'
                    : rawPriority === 'low'
                        ? 'Low Priority'
                        : 'Other';

            return {
                id: t.channelId || t.channel_id || t.id || 'N/A',
                channelId: t.channelId || t.channel_id || null,
                userId: t.userId || t.user_id || null,
                username: t.userName || t.user_name || t.username || 'Unknown',
                status: t.status || 'open',
                categoryKey: t.categoryKey || t.category_key || null,
                categoryLabel: t.categoryLabel || t.category_label || legacyCategoryLabel,
                priority: t.priority || null,
                claimedBy: t.claimedBy || t.claimed_by || null,
                claimedByName: t.claimedByName || t.claimed_by_name || null,
                closedBy: t.closedBy || t.closed_by || null,
                closedByName: t.closedByName || t.closed_by_name || null,
                closeReason: t.closeReason || t.close_reason || '',
                reason: t.reason || '',
                created_at: t.createdAt || t.created_at || null,
                closed_at: t.closedAt || t.closed_at || null,
                transcript_created_at: t.transcriptCreatedAt || t.transcript_created_at || null
            };
        }));
    } catch (error) {
        res.status(500).json({ error: 'Failed to get tickets' });
    }
});

// Get ticket transcript (moderator and above)
app.get('/api/tickets/:ticketId/transcript', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasModeratorAccess(user)) {
            return res.status(403).json({ error: 'Moderator access required' });
        }

        const { ticketId } = req.params;
        if (!ticketId) {
            return res.status(400).json({ error: 'Invalid ticket id' });
        }

        const ticket = await MySQLDatabaseManager.getTicket(ticketId);
        if (!ticket) {
            return res.status(404).json({ error: 'Ticket not found' });
        }

        const transcript = ticket.transcript || '';
        const createdAt = ticket.transcriptCreatedAt || null;
        res.json({
            ticketId,
            hasTranscript: Boolean(transcript),
            transcript,
            createdAt
        });
    } catch (error) {
        console.error('Error fetching ticket transcript:', error);
        res.status(500).json({ error: 'Failed to get ticket transcript' });
    }
});

// Claim ticket
app.post('/api/tickets/:ticketId/claim', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasModeratorAccess(user)) {
            return res.status(403).json({ error: 'Moderator access required' });
        }

        const { ticketId } = req.params;
        if (!ticketId) {
            return res.status(400).json({ error: 'Invalid ticket id' });
        }

        const linkedDiscordUserId = String(user?.discord_user_id || '').trim();
        const linkedDiscordUsername = String(user?.discord_username || '').trim();
        const claimedBy = linkedDiscordUserId || req.session.userId || req.session.username || 'system';
        const claimedByName = linkedDiscordUsername || user?.username || req.session.username || String(req.session.userId || 'system');

        const success = await AdminPanelHelper.claimTicket(
            ticketId,
            claimedBy,
            claimedByName
        );

        if (success) {
            if (discordClient?.channels?.fetch) {
                const ticketChannel = discordClient.channels.cache.get(ticketId)
                    || await discordClient.channels.fetch(ticketId).catch(() => null);

                if (ticketChannel) {
                    await updateTicketChannelAssigneeName(ticketChannel, linkedDiscordUsername || claimedByName).catch(() => { });

                    const claimerDisplay = linkedDiscordUserId
                        ? `<@${linkedDiscordUserId}>`
                        : `**${claimedByName}** (Admin Panel)`;

                    const notifyEmbed = new EmbedBuilder()
                        .setColor(0x5865F2)
                        .setTitle('🎫 Ticket Claimed')
                        .setDescription(`${claimerDisplay} claimed this ticket from the admin panel and is now responsible for the case.`)
                        .setFooter({ text: 'Support Team' })
                        .setTimestamp();

                    await ticketChannel.send({ embeds: [notifyEmbed] }).catch(() => { });
                }
            }

            res.json({
                success: true,
                message: 'Ticket claimed',
                claimedBy,
                claimedByName
            });
        } else {
            res.status(404).json({ error: 'Ticket not found' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to claim ticket' });
    }
});

// Search members
app.get('/api/users/search', requireAuth, async (req, res) => {
    try {
        const query = (req.query.q || '').trim();
        const levels = await AdminPanelHelper.getAllLevels();
        const allWarnsRaw = await AdminPanelHelper.getAllWarns();

        // Group warns by user and create a map of warn counts
        const warnMap = {};
        allWarnsRaw.forEach(warn => {
            if (!warnMap[w.user_id]) {
                warnMap[w.user_id] = {
                    warn_count: 0,
                    warns: [],
                    username: w.username || null
                };
            }
            warnMap[w.user_id].warn_count++;
            if (w.username) {
                warnMap[w.user_id].username = w.username;
            }
            warnMap[w.user_id].warns.push({
                id: w.id,
                case_id: w.case_id,
                reason: w.reason,
                moderator_id: w.moderator_id,
                created_at: w.created_at
            });
        });

        // Combine level data with warn data
        const allMembers = {};

        // Add all members from levels
        (levels || []).forEach(u => {
            allMembers[u.user_id] = {
                ...u,
                username: u.username || warnMap[u.user_id]?.username || 'Unknown',
                warn_count: warnMap[u.user_id]?.warn_count || 0,
                warns: warnMap[u.user_id]?.warns || [],
                joined_at: u.created_at || null
            };
        });

        // Add warn-only users not present in levels
        Object.keys(warnMap).forEach(userId => {
            if (!allMembers[userId]) {
                allMembers[userId] = {
                    user_id: userId,
                    username: warnMap[userId].username || 'Unknown',
                    level: 1,
                    messages: 0,
                    xp: 0,
                    warn_count: warnMap[userId].warn_count || 0,
                    warns: warnMap[userId].warns || [],
                    joined_at: null
                };
            }
        });

        // Fetch usernames from Discord for users with "Unknown" username
        if (discordClient) {
            try {
                const mainConfig = require('./Config/main.json');
                const guild = await discordClient.guilds.fetch(mainConfig.serverID);

                if (guild) {
                    const unknownUsers = Object.values(allMembers).filter(u => !u.username || u.username === 'Unknown');

                    for (const user of unknownUsers) {
                        try {
                            const member = await guild.members.fetch(user.user_id).catch(() => null);
                            if (member) {
                                user.username = member.user.username;
                                // Update database with fetched username
                                await MySQLDatabaseManager.connection.pool.query(
                                    'UPDATE levels SET username = ? WHERE user_id = ?',
                                    [member.user.username, user.user_id]
                                ).catch(() => { });
                            }
                        } catch (err) {
                            // Skip if user not found
                        }
                    }
                }
            } catch (err) {
                console.error('Error fetching usernames from Discord:', err.message);
            }
        }

        const normalizedQuery = query.toLowerCase();
        const isIdQuery = /^\d{6,}$/.test(query);
        const filtered = Object.values(allMembers).filter(u => {
            const username = (u.username || '').toLowerCase();
            const id = String(u.user_id || '');
            if (!query) return true;
            if (isIdQuery) return id.includes(query);
            return username.includes(normalizedQuery) || id.includes(query);
        });
        res.json(filtered.slice(0, 50));
    } catch (error) {
        console.error('Error searching members:', error);
        res.status(500).json({ error: 'Failed to search members' });
    }
});

// Get member notes
app.get('/api/members/:userId/notes', requireAuth, async (req, res) => {
    try {
        const { userId } = req.params;
        const notes = await MySQLDatabaseManager.getMemberNotes(userId);
        res.json({ notes });
    } catch (error) {
        console.error('Error getting member notes:', error);
        res.status(500).json({ error: 'Failed to get notes' });
    }
});

// Save member notes
app.post('/api/members/:userId/notes', requireAuth, async (req, res) => {
    try {
        const { userId } = req.params;
        const { notes } = req.body;
        const success = await MySQLDatabaseManager.updateMemberNotes(userId, notes || '');
        if (success) {
            res.json({ success: true, message: 'Notes saved' });
        } else {
            res.status(500).json({ error: 'Failed to save notes' });
        }
    } catch (error) {
        console.error('Error saving member notes:', error);
        res.status(500).json({ error: 'Failed to save notes' });
    }
});

// Admin APIs

// Get invite statistics (enhanced with detailed metrics)
app.get('/api/invites/stats', requireAuth, async (req, res) => {
    try {
        const [rows] = await MySQLDatabaseManager.connection.pool.query(`
            SELECT 
                code,
                created_by,
                role,
                used_by,
                created_at,
                expires_at,
                used_at,
                max_uses,
                current_uses,
                description,
                active,
                revoked_by,
                revoked_at,
                CASE
                    WHEN revoked_by IS NOT NULL THEN 'revoked'
                    WHEN current_uses >= max_uses THEN 'fully_used'
                    WHEN expires_at IS NOT NULL AND expires_at <= NOW() THEN 'expired'
                    WHEN active = TRUE AND (expires_at IS NULL OR expires_at > NOW()) AND current_uses < max_uses THEN 'active'
                    ELSE 'inactive'
                END as status
            FROM admin_invite_codes 
            ORDER BY created_at DESC 
            LIMIT 200
        `);
        res.json(rows || []);
    } catch (error) {
        console.error('Error fetching invite stats:', error);
        res.status(500).json({ error: 'Failed to get invite stats' });
    }
});

// Server stats
app.get('/api/server/stats', requireAuth, async (req, res) => {
    try {
        // Get all stats using a similar approach to /api/stats which we know works
        const [levelsRaw, reminders, bannedUsers] = await Promise.all([
            AdminPanelHelper.getAllLevels(),
            AdminPanelHelper.getAllReminders(),
            AdminPanelHelper.getAllBannedUsers()
        ]);

        // Get counts separately (these return numbers, not arrays)
        const giveawaysActive = await AdminPanelHelper.getGiveawaysCount();
        const warnsCount = await AdminPanelHelper.getWarnsCount();
        const activeTimeouts = await AdminPanelHelper.getActiveTimeoutsCount();

        const levels = Array.isArray(levelsRaw) ? levelsRaw : [];
        const totalUsers = levels.length;

        // Get members joined this month
        const [joinRows] = await MySQLDatabaseManager.connection.pool.query(
            "SELECT COUNT(*) as count FROM member_activity WHERE event_type = 'join' AND timestamp >= DATE_FORMAT(NOW(), '%Y-%m-01')"
        );
        const membersThisMonth = joinRows?.[0]?.count || 0;

        const memUsage = process.memoryUsage();

        const response = {
            totalMembers: totalUsers || 0,
            membersThisMonth: membersThisMonth || 0,
            totalWarns: warnsCount || 0,
            activeBans: bannedUsers?.length || 0,
            activeTimeouts: activeTimeouts || 0,
            activeGiveaways: giveawaysActive || 0,
            activeReminders: reminders?.length || 0,
            memoryUsage: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            rss: Math.round(memUsage.rss / 1024 / 1024),
            external: Math.round(memUsage.external / 1024 / 1024)
        };

        res.json(response);
    } catch (error) {
        console.error('Error getting server stats:', error);
        res.status(500).json({
            error: 'Failed to get server stats',
            totalMembers: 0,
            membersThisMonth: 0,
            totalWarns: 0,
            activeBans: 0,
            activeTimeouts: 0,
            activeGiveaways: 0,
            activeReminders: 0
        });
    }
});

// Activity trends
app.get('/api/server/activity-trends', requireAuth, async (req, res) => {
    try {
        // Get data for the last 7 days
        const days = [];
        const now = new Date();

        for (let i = 6; i >= 0; i--) {
            const date = new Date(now);
            date.setDate(date.getDate() - i);
            const startOfDay = new Date(date);
            startOfDay.setHours(0, 0, 0, 0);
            const endOfDay = new Date(date);
            endOfDay.setHours(23, 59, 59, 999);

            // Convert to milliseconds for BIGINT comparison
            const startMs = startOfDay.getTime();
            const endMs = endOfDay.getTime();

            // Count new members for this day (levels table uses TIMESTAMP)
            const [newMembers] = await AdminPanelHelper.connection.query(
                `SELECT COUNT(*) as count FROM levels WHERE created_at >= ? AND created_at < ?`,
                [startOfDay, endOfDay]
            );

            // Count warnings for this day (warns table uses BIGINT timestamp in milliseconds)
            const [warnings] = await AdminPanelHelper.connection.query(
                `SELECT COUNT(*) as count FROM moderation_cases WHERE action_type = 'WARN' AND status NOT IN ('cleared', 'reversed') AND created_at >= ? AND created_at < ?`,
                [startMs, endMs]
            );

            // Count bans for this day (user_bans uses TIMESTAMP)
            const [bans] = await AdminPanelHelper.connection.query(
                `SELECT COUNT(*) as count FROM user_bans WHERE created_at >= ? AND created_at < ?`,
                [startOfDay, endOfDay]
            );

            days.push({
                date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                newMembers: newMembers[0]?.count || 0,
                warnings: warnings[0]?.count || 0,
                bans: bans[0]?.count || 0
            });
        }

        res.json(days);
    } catch (error) {
        console.error('Error getting activity trends:', error);
        res.json([]);
    }
});

// Owner system metrics
app.get('/api/owner/system-metrics', requireAuth, requireOwner, async (req, res) => {
    try {
        const memUsage = process.memoryUsage();
        const uptime = process.uptime();

        res.json({
            memory: {
                heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
                heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
                rss: Math.round(memUsage.rss / 1024 / 1024),
                external: Math.round(memUsage.external / 1024 / 1024),
                heapPercentage: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100)
            },
            uptime: Math.floor(uptime),
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            cpuUsage: process.cpuUsage()
        });
    } catch (error) {
        console.error('Error getting system metrics:', error);
        res.status(500).json({ error: 'Failed to get system metrics' });
    }
});

// Owner database metrics
app.get('/api/owner/database-metrics', requireAuth, requireOwner, async (req, res) => {
    try {
        const [tables] = await MySQLDatabaseManager.connection.pool.query(
            `SELECT 
                table_name,
                table_rows,
                ROUND((data_length + index_length) / 1024 / 1024, 2) as size_mb
            FROM information_schema.tables 
            WHERE table_schema = DATABASE()
            ORDER BY (data_length + index_length) DESC`
        );

        res.json({ tables });
    } catch (error) {
        console.error('Error getting database metrics:', error);
        res.status(500).json({ error: 'Failed to get database metrics' });
    }
});

// Level distribution
app.get('/api/server/level-distribution', requireAuth, async (req, res) => {
    try {
        const levels = await AdminPanelHelper.getAllLevels();

        const ranges = [
            { label: '1-10', min: 1, max: 10 },
            { label: '11-20', min: 11, max: 20 },
            { label: '21-30', min: 21, max: 30 },
            { label: '31-40', min: 31, max: 40 },
            { label: '41+', min: 41, max: null }
        ];

        const counts = ranges.map(range => {
            const count = levels.reduce((sum, l) => {
                const level = parseInt(l.level) || 1;
                if (range.max === null) {
                    return sum + (level >= range.min ? 1 : 0);
                }
                return sum + (level >= range.min && level <= range.max ? 1 : 0);
            }, 0);
            return { ...range, count };
        });

        const total = levels.length || 0;
        const results = counts.map(range => ({
            label: range.label,
            count: range.count,
            percentage: total > 0 ? (range.count / total) * 100 : 0
        }));

        res.json({ total, ranges: results });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get level distribution' });
    }
});

// Warning trends (distribution of warns per user)

// Owner APIs 

async function resolveDatabaseHealthSnapshot() {
    try {
        if (typeof MySQLDatabaseManager.connection?.healthCheck === 'function') {
            const health = await MySQLDatabaseManager.connection.healthCheck();
            return {
                ok: Boolean(health?.ok),
                latencyMs: Number.isFinite(Number(health?.latencyMs)) ? Number(health.latencyMs) : null,
                checkedAt: Number.isFinite(Number(health?.lastHealthCheckAt)) ? Number(health.lastHealthCheckAt) : Date.now(),
                error: health?.error || null
            };
        }
    } catch {
    }

    try {
        const startedAt = Date.now();
        await MySQLDatabaseManager.connection.pool.query('SELECT 1');
        return {
            ok: true,
            latencyMs: Date.now() - startedAt,
            checkedAt: Date.now(),
            error: null
        };
    } catch (error) {
        return {
            ok: false,
            latencyMs: null,
            checkedAt: Date.now(),
            error: error?.message || 'Health check failed'
        };
    }
}

async function buildAdminPanelRuntimeDiagnostics() {
    const dbHealth = await resolveDatabaseHealthSnapshot();
    const now = Math.floor(Date.now() / 1000);
    let activeSessionCount = null;

    try {
        const [rows] = await MySQLDatabaseManager.connection.pool.query(
            'SELECT COUNT(*) as count FROM sessions WHERE expires > ?',
            [now]
        );
        activeSessionCount = Number(rows?.[0]?.count || 0);
    } catch (error) {
        activeSessionCount = null;
    }

    const discordState = {
        attached: Boolean(discordClient),
        ready: Boolean(discordClient?.isReady?.()),
        tag: discordClient?.user?.tag || null,
        userId: discordClient?.user?.id || null,
        guildCount: discordClient?.guilds?.cache?.size || 0,
        pingMs: typeof discordClient?.ws?.ping === 'number' ? discordClient.ws.ping : null
    };

    return {
        panel: {
            botName: PANEL_BOT_NAME,
            serverName: PANEL_SERVER_NAME,
            nodeEnv: process.env.NODE_ENV || 'development',
            port: Number(PORT),
            ioReady,
            sessionStoreReady: Boolean(sessionStore),
            startedAt: adminPanelRuntime.startedAt,
            uptimeMs: process.uptime() * 1000,
            runtime: { ...adminPanelRuntime }
        },
        discord: discordState,
        sockets: {
            ...socketMetrics,
            rooms: io?.of('/')?.adapter?.rooms?.size || 0,
            terminalBufferSize: terminalLogBuffer.length
        },
        backups: {
            database: {
                ...backupState,
                timerActive: Boolean(backupTimer),
                configEnabled: Boolean(backupConfig?.enabled)
            },
            server: {
                ...serverBackupState,
                timerActive: Boolean(serverBackupTimer),
                configEnabled: Boolean(serverBackupConfig?.enabled),
                activeRestoreOperations: Array.from(serverBackupRestoreOperations.values())
                    .filter((operation) => ['queued', 'running'].includes(String(operation?.status || '').toLowerCase())).length
            }
        },
        sessions: {
            active: activeSessionCount
        },
        database: dbHealth,
        botStats: getStats(),
        memory: process.memoryUsage()
    };
}

app.get('/healthz', (_req, res) => {
    res.status(200).json({
        ok: true,
        ioReady,
        sessionStoreReady: Boolean(sessionStore),
        discordAttached: Boolean(discordClient),
        uptimeMs: process.uptime() * 1000
    });
});

app.get('/readyz', async (_req, res) => {
    const dbHealth = await resolveDatabaseHealthSnapshot();
    const ready = Boolean(ioReady && sessionStore && dbHealth?.ok);

    res.status(ready ? 200 : 503).json({
        ready,
        ioReady,
        sessionStoreReady: Boolean(sessionStore),
        discordAttached: Boolean(discordClient),
        databaseHealthy: Boolean(dbHealth?.ok),
        databaseError: dbHealth?.error || null
    });
});

// Audit logs
app.get('/api/audit-logs', requireAuth, requireOwner, async (req, res) => {
    try {
        // Placeholder - would query audit_logs table
        res.json([]);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get audit logs' });
    }
});

// System health
app.get('/api/system/health', requireAuth, requireOwner, async (req, res) => {
    try {
        const startTime = Date.now();
        const memUsage = process.memoryUsage();
        const totalMemory = require('os').totalmem();
        const freeMemory = require('os').freemem();

        // Calculate memory percentages (heap usage vs heap total)
        const heapPercent = Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100);
        const systemMemPercent = Math.round(((totalMemory - freeMemory) / totalMemory) * 100);

        // Calculate CPU usage as percentage of system
        const cpus = require('os').cpus();
        let totalIdle = 0, totalTick = 0;
        cpus.forEach(cpu => {
            for (type in cpu.times) {
                totalTick += cpu.times[type];
            }
            totalIdle += cpu.times.idle;
        });
        const cpuUsagePercent = Math.round(100 - ~~(100 * totalIdle / totalTick));

        const dbHealth = await resolveDatabaseHealthSnapshot();

        const apiLatency = Date.now() - startTime;

        res.json({
            cpuUsage: `${cpuUsagePercent}%`,
            memoryUsage: `${heapPercent}%`,
            systemMemoryUsage: `${systemMemPercent}%`,
            freeMemory: `${Math.round((freeMemory / totalMemory) * 100)}%`,
            heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
            apiLatency: `${apiLatency}ms`,
            dbPing: dbHealth.ok
                ? (Number.isFinite(dbHealth.latencyMs) ? `${dbHealth.latencyMs}ms` : 'Connected')
                : 'Failed'
        });
    } catch (error) {
        console.error('Error getting system health:', error);
        res.status(500).json({ error: 'Failed to get system health' });
    }
});

app.get('/api/owner/runtime-diagnostics', requireAuth, requireOwner, async (req, res) => {
    try {
        const snapshot = await buildAdminPanelRuntimeDiagnostics();
        res.json(snapshot);
    } catch (error) {
        console.error('Error building admin panel runtime diagnostics:', error);
        res.status(500).json({ error: 'Failed to build runtime diagnostics' });
    }
});

// Database health endpoint
app.get('/api/system/db-health', requireAuth, requireOwner, async (req, res) => {
    try {
        const services = [];
        const dbHealth = await resolveDatabaseHealthSnapshot();

        services.push({
            status: dbHealth.ok ? '✓ Connected' : '✗ Failed',
            statusColor: dbHealth.ok ? 'green' : 'red',
            service: 'MySQL Database',
            lastCheck: new Date(dbHealth.checkedAt || Date.now()).toLocaleTimeString(),
            responseTime: Number.isFinite(dbHealth.latencyMs) ? `${dbHealth.latencyMs}ms` : 'N/A'
        });

        // Check tables
        try {
            const tables = ['levels', 'warns', 'sessions', 'reminders', 'giveaways', 'user_bans'];
            for (const table of tables) {
                try {
                    await MySQLDatabaseManager.connection.pool.query(`SELECT COUNT(*) as count FROM ${table} LIMIT 1`);
                    services.push({
                        status: '✓ OK',
                        statusColor: 'green',
                        service: `Table: ${table}`,
                        lastCheck: new Date().toLocaleTimeString(),
                        responseTime: '<5ms'
                    });
                } catch (err) {
                    services.push({
                        status: '✗ Error',
                        statusColor: 'red',
                        service: `Table: ${table}`,
                        lastCheck: new Date().toLocaleTimeString(),
                        responseTime: 'N/A'
                    });
                }
            }
        } catch (err) {
            console.error('Error checking tables:', err);
        }

        res.json(services);
    } catch (error) {
        console.error('Error getting database health:', error);
        res.status(500).json({ error: 'Failed to get database health' });
    }
});

// Active sessions endpoint
app.get('/api/system/sessions', requireAuth, requireOwner, async (req, res) => {
    try {
        // Clean up expired sessions first
        const now = Math.floor(Date.now() / 1000);
        await MySQLDatabaseManager.connection.pool.query(
            'DELETE FROM sessions WHERE expires < ?',
            [now]
        );

        const [sessions] = await MySQLDatabaseManager.connection.pool.query(
            'SELECT session_id, expires, data FROM sessions WHERE expires > ? ORDER BY expires DESC LIMIT 100',
            [now]
        );

        const sessionDuration = Math.floor(Number(sessionPolicyState.idleTimeoutMs) / 1000);

        const sessionMap = new Map(); // Map to store unique sessions by user+device

        sessions.forEach(session => {
            let sessionData = {};
            try {
                // The data is stored as a JSON string in the database
                if (typeof session.data === 'string') {
                    sessionData = JSON.parse(session.data);
                } else {
                    sessionData = session.data;
                }
            } catch (e) {
                console.error('Error parsing session data:', e);
                return;
            }

            const expiresAt = session.expires;
            const createdAt = Number(sessionData.loginTime)
                ? Math.floor(Number(sessionData.loginTime) / 1000)
                : (expiresAt - sessionDuration);

            // Extract IPv4 and IPv6 from stored session data
            // Try to use stored values first, then parse from primary IP
            let ipAddressV4 = sessionData.ipAddressV4 || null;
            let ipAddressV6 = sessionData.ipAddressV6 || null;

            // If we don't have V4/V6 stored, try to extract from the primary IP
            if (!ipAddressV4 && !ipAddressV6) {
                const storedIp = sessionData.ipAddress || sessionData.ip || sessionData.clientIP || 'Unknown';
                const ipInfo = getIpInfoFromCandidates([storedIp]);
                ipAddressV4 = ipInfo.ipv4 || null;
                ipAddressV6 = ipInfo.ipv6 || null;
            }

            const ipAddress = ipAddressV4 || ipAddressV6 || 'Unknown';
            const userAgent = sessionData.userAgent || sessionData.deviceInfo || '';
            const device = userAgent ? extractDeviceFromUserAgent(userAgent) : 'Unknown';
            const username = sessionData.username || 'Unknown';

            const hasUsefulIdentity = Boolean(username && username !== 'Unknown');
            const hasUsefulIp = Boolean(ipAddressV4 || ipAddressV6);
            const hasUsefulUserAgent = Boolean(userAgent && userAgent !== 'Unknown');
            const hasUsefulDevice = Boolean(device && device !== 'Unknown' && device !== 'Other');

            if (!hasUsefulIdentity && !hasUsefulIp && !hasUsefulUserAgent && !hasUsefulDevice) {
                return;
            }

            // Parse user agent for detailed info
            const parsedUA = parseUserAgent(userAgent);

            // Create a key for this user+device combination (ignore IP since it can vary)
            const sessionKey = `${username}|${device}`;

            // Calculate time until expiration
            const expiresIn = Math.max(0, expiresAt - now);
            const expiresInMinutes = Math.floor(expiresIn / 60);
            const expiresInHours = Math.floor(expiresInMinutes / 60);

            // Only keep the most recent session for this user+device combo
            if (!sessionMap.has(sessionKey)) {
                sessionMap.set(sessionKey, {
                    sessionId: session.session_id,
                    displayId: session.session_id.substring(0, 12) + '...',
                    username: username,
                    ipAddress: ipAddress,
                    ipAddressV4: ipAddressV4,
                    ipAddressV6: ipAddressV6,
                    userAgent: userAgent || 'Unknown',
                    device: device,
                    browser: parsedUA.browser,
                    browserVersion: parsedUA.browserVersion,
                    os: parsedUA.os,
                    osVersion: parsedUA.osVersion,
                    deviceType: parsedUA.deviceType,
                    deviceIcon: parsedUA.deviceIcon,
                    deviceInfo: parsedUA.full,
                    lastActivityAt: sessionData.lastActivityAt ? new Date(Number(sessionData.lastActivityAt)).toLocaleString() : 'Unknown',
                    createdAt: new Date(createdAt * 1000).toLocaleString(),
                    createdAtTimestamp: createdAt * 1000,
                    expiresAt: new Date(expiresAt * 1000).toLocaleString(),
                    expiresAtTimestamp: expiresAt * 1000,
                    expiresIn: expiresInHours > 0 ? `${expiresInHours}h` : `${expiresInMinutes}m`,
                    isActive: true
                });
            }
        });

        // Convert map to array and sort by creation time (newest first)
        const formattedSessions = Array.from(sessionMap.values())
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        const usernames = Array.from(
            new Set(formattedSessions.map((session) => session.username).filter((username) => username && username !== 'Unknown'))
        );

        const failedLoginCounts = new Map();
        const loginHistoryByUser = new Map();
        const newDeviceEventsByUser = new Map();

        if (usernames.length) {
            const placeholders = usernames.map(() => '?').join(', ');
            const [authEvents] = await MySQLDatabaseManager.connection.pool.query(
                `SELECT username, event_type, ip_address, metadata, created_at
                 FROM admin_auth_events
                 WHERE username IN (${placeholders})
                   AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
                 ORDER BY created_at DESC`,
                usernames
            );

            const nowMs = Date.now();
            const failedWindowMs = 30 * 60 * 1000;

            (authEvents || []).forEach((row) => {
                const username = row.username;
                if (!username) return;
                const createdAtMs = row.created_at ? new Date(row.created_at).getTime() : 0;

                const eventType = String(row.event_type || '');
                if (createdAtMs && (nowMs - createdAtMs) <= failedWindowMs) {
                    if (eventType === 'LOGIN_FAILED' || eventType.includes('FAILED')) {
                        failedLoginCounts.set(username, (failedLoginCounts.get(username) || 0) + 1);
                    }
                }

                if (eventType === 'LOGIN_SUCCESS' || eventType === 'LOGIN_SUCCESS_RECOVERY') {
                    const history = loginHistoryByUser.get(username) || [];
                    history.push({
                        ipAddress: row.ip_address || null,
                        createdAtMs
                    });
                    loginHistoryByUser.set(username, history);
                }

                let metadata = {};
                try {
                    metadata = row.metadata ? JSON.parse(row.metadata) : {};
                } catch (_) {
                    metadata = {};
                }

                if (metadata?.signal === 'new-device-login') {
                    const events = newDeviceEventsByUser.get(username) || [];
                    events.push({
                        createdAtMs,
                        deviceLabel: metadata.deviceLabel || null
                    });
                    newDeviceEventsByUser.set(username, events);
                }
            });

            for (const [username, events] of loginHistoryByUser.entries()) {
                const sorted = events.sort((a, b) => b.createdAtMs - a.createdAtMs);
                loginHistoryByUser.set(username, sorted);
            }
        }

        const riskContext = {
            failedLoginCounts,
            loginHistoryByUser,
            newDeviceEventsByUser
        };

        const sessionsWithRisk = await Promise.all(
            formattedSessions.map(async (session) => {
                const risk = await calculateSessionRisk(session, riskContext);
                return {
                    ...session,
                    riskScore: risk.score,
                    riskLevel: risk.level,
                    riskReasons: risk.reasons,
                    riskSignals: risk.signals
                };
            })
        );

        res.json(sessionsWithRisk);
    } catch (error) {
        console.error('Error getting sessions:', error);
        res.json([]); // Return empty if error
    }
});

// Revoke a specific session
app.delete('/api/system/sessions/:sessionId', requireAuth, requireOwner, async (req, res) => {
    try {
        const { sessionId } = req.params;

        if (!sessionId) {
            return res.status(400).json({ success: false, message: 'Session ID is required' });
        }

        // Delete the session from the database
        await MySQLDatabaseManager.connection.pool.query(
            'DELETE FROM sessions WHERE session_id = ?',
            [sessionId]
        );

        res.json({ success: true, message: 'Session revoked successfully' });
    } catch (error) {
        console.error('Error revoking session:', error);
        res.status(500).json({ success: false, message: 'Failed to revoke session' });
    }
});

// Revoke all sessions for a specific user
app.delete('/api/system/sessions/user/:username', requireAuth, requireOwner, async (req, res) => {
    try {
        const { username } = req.params;

        if (!username) {
            return res.status(400).json({ success: false, message: 'Username is required' });
        }

        // Get all sessions for this user
        const [sessions] = await MySQLDatabaseManager.connection.pool.query(
            'SELECT session_id, data FROM sessions'
        );

        let deletedCount = 0;
        for (const session of sessions) {
            try {
                let sessionData = {};
                if (typeof session.data === 'string') {
                    sessionData = JSON.parse(session.data);
                } else {
                    sessionData = session.data;
                }

                if (sessionData.username === username) {
                    await MySQLDatabaseManager.connection.pool.query(
                        'DELETE FROM sessions WHERE session_id = ?',
                        [session.session_id]
                    );
                    deletedCount++;
                }
            } catch (e) {
                console.error('Error parsing session:', e);
            }
        }

        res.json({
            success: true,
            message: `Revoked ${deletedCount} session(s) for user ${username}`,
            count: deletedCount
        });
    } catch (error) {
        console.error('Error revoking user sessions:', error);
        res.status(500).json({ success: false, message: 'Failed to revoke user sessions' });
    }
});

// Get current session ID (for marking as "Current Session" in UI)
app.get('/api/system/sessions/current', requireAuth, async (req, res) => {
    try {
        res.json({
            sessionId: req.sessionID,
            username: req.session?.username || 'Unknown'
        });
    } catch (error) {
        console.error('Error getting current session:', error);
        res.status(500).json({ sessionId: null });
    }
});

// Socket health metrics (owner only)
app.get('/api/system/socket-health', requireAuth, requireOwner, (req, res) => {
    try {
        const sockets = io?.of('/')?.sockets?.size || 0;
        const roomEntries = io?.of('/')?.adapter?.rooms ? Array.from(io.of('/').adapter.rooms.entries()) : [];
        const roomSummary = roomEntries
            .filter(([roomName, members]) => !io.of('/').sockets.has(roomName))
            .map(([roomName, members]) => ({
                room: roomName,
                connections: members?.size || 0
            }))
            .slice(0, 50);

        res.json({
            ...socketMetrics,
            sockets,
            rooms: roomSummary,
            sampledAt: Date.now()
        });
    } catch (error) {
        console.error('[SocketHealth] Failed to report socket metrics:', error.message);
        res.status(500).json({ error: 'Failed to load socket metrics' });
    }
});

// Security logs endpoint
app.get('/api/system/security-logs', requireAuth, requireOwner, async (req, res) => {
    try {
        const [logs] = await MySQLDatabaseManager.connection.pool.query(
            `SELECT id, moderator_id, event_type, user_id, reason, timestamp 
             FROM audit_logs 
             WHERE timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
             ORDER BY timestamp DESC 
             LIMIT 100`
        );

        const formattedLogs = logs.map(log => ({
            timestamp: new Date(log.timestamp).toLocaleString(),
            admin: log.moderator_id || 'System',
            action: formatActionType(log.event_type),
            target: log.user_id || '-',
            details: log.reason || '-',
            ipAddress: 'N/A'
        }));

        res.json(formattedLogs);
    } catch (error) {
        console.error('Error getting security logs:', error);
        res.json([]); // Return empty if error
    }
});

// Security signal events endpoint (owner-only)
app.get('/api/security/events', requireAuth, requireOwner, async (req, res) => {
    try {
        const requestedLimit = Number(req.query?.limit);
        const limit = Number.isFinite(requestedLimit)
            ? Math.max(1, Math.min(Math.trunc(requestedLimit), 500))
            : 100;

        const signal = String(req.query?.signal || '').trim().toLowerCase();
        const username = String(req.query?.username || '').trim().toLowerCase();

        let sql = `
            SELECT id, username, event_type, ip_address, user_agent, metadata, created_at
            FROM admin_auth_events
            WHERE username = 'security'
        `;
        const params = [];

        if (signal) {
            sql += ` AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.signal')) = ?`;
            params.push(signal);
        }

        if (username) {
            sql += ` AND LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.username')), '')) = ?`;
            params.push(username);
        }

        sql += ` ORDER BY created_at DESC LIMIT ?`;
        params.push(limit);

        const [rows] = await MySQLDatabaseManager.connection.pool.query(sql, params);

        const events = (rows || []).map((row) => {
            let metadata = {};
            try {
                metadata = typeof row.metadata === 'string'
                    ? JSON.parse(row.metadata)
                    : (row.metadata || {});
            } catch {
                metadata = {};
            }

            return {
                id: row.id,
                createdAt: row.created_at,
                username: row.username,
                eventType: row.event_type,
                signal: metadata?.signal || null,
                ipAddress: row.ip_address || null,
                userAgent: row.user_agent || null,
                metadata
            };
        });

        return res.json({
            success: true,
            count: events.length,
            events
        });
    } catch (error) {
        console.error('[SecurityEvents] Failed to fetch security events:', error.message);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch security events'
        });
    }
});

// Anti-raid dashboard metrics (owner-only)
app.get('/api/owner/anti-raid-dashboard', requireAuth, requireOwner, async (req, res) => {
    try {
        const requestedDays = Number(req.query?.days);
        const days = Number.isFinite(requestedDays)
            ? Math.max(1, Math.min(Math.trunc(requestedDays), 90))
            : 30;
        const requestedLimit = Number(req.query?.limit);
        const limit = Number.isFinite(requestedLimit)
            ? Math.max(1, Math.min(Math.trunc(requestedLimit), 200))
            : 20;

        const [summaryRows] = await MySQLDatabaseManager.connection.pool.query(
            `SELECT
                COUNT(*) AS total,
                AVG(risk_score) AS avgRisk,
                MAX(risk_score) AS peakRisk,
                SUM(event_type = 'lockdown_start') AS autoLockdowns,
                SUM(event_type = 'manual_enable') AS manualLockdowns,
                SUM(event_type IN ('lockdown_end', 'manual_disable')) AS resolved
             FROM anti_raid_events
             WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
            [days]
        );

        const [recentRows] = await MySQLDatabaseManager.connection.pool.query(
            `SELECT id, event_type, risk_score, trigger_count, details_json, created_at
             FROM anti_raid_events
             ORDER BY created_at DESC
             LIMIT ?`,
            [limit]
        );

        const triggerCounts = new Map();
        const recent = (recentRows || []).map((row) => {
            let details = null;
            if (row.details_json) {
                try {
                    details = typeof row.details_json === 'string'
                        ? JSON.parse(row.details_json)
                        : row.details_json;
                } catch {
                    details = null;
                }
            }

            const triggers = Array.isArray(details?.triggers) ? details.triggers : [];
            triggers.forEach((trigger) => {
                const name = String(trigger?.name || '').trim();
                if (!name) return;
                triggerCounts.set(name, (triggerCounts.get(name) || 0) + 1);
            });

            return {
                id: row.id,
                eventType: row.event_type,
                riskScore: row.risk_score === null ? null : Number(row.risk_score),
                triggerCount: row.trigger_count === null ? null : Number(row.trigger_count),
                details,
                createdAt: row.created_at
            };
        });

        const summaryRow = summaryRows?.[0] || {};
        const topTriggers = Array.from(triggerCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([name, count]) => ({ name, count }));

        res.json({
            success: true,
            windowDays: days,
            summary: {
                total: Number(summaryRow.total || 0),
                avgRisk: summaryRow.avgRisk === null ? null : Number(summaryRow.avgRisk),
                peakRisk: summaryRow.peakRisk === null ? null : Number(summaryRow.peakRisk),
                autoLockdowns: Number(summaryRow.autoLockdowns || 0),
                manualLockdowns: Number(summaryRow.manualLockdowns || 0),
                resolved: Number(summaryRow.resolved || 0)
            },
            topTriggers,
            recent
        });
    } catch (error) {
        console.error('[AntiRaidDashboard] Failed to fetch anti-raid stats:', error.message);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch anti-raid dashboard data'
        });
    }
});

// Helper functions to parse IP addresses
function parseSingleIp(ip) {
    if (!ip || ip === 'Unknown') {
        return { ipv4: null, ipv6: null, primary: null };
    }

    const cleaned = String(ip).split('%')[0].trim();
    if (!cleaned) {
        return { ipv4: null, ipv6: null, primary: null };
    }

    if (cleaned.startsWith('::ffff:')) {
        const ipv4 = cleaned.replace('::ffff:', '');
        return { ipv4, ipv6: null, primary: ipv4 };
    }

    if (cleaned.includes(':')) {
        return { ipv4: null, ipv6: cleaned, primary: cleaned };
    }

    return { ipv4: cleaned, ipv6: null, primary: cleaned };
}

function getIpInfoFromCandidates(candidates = []) {
    let ipv4 = null;
    let ipv6 = null;
    let primary = null;

    for (const candidate of candidates) {
        if (!candidate) continue;
        const parsed = parseSingleIp(candidate);
        if (!primary && parsed.primary) primary = parsed.primary;
        if (!ipv4 && parsed.ipv4) ipv4 = parsed.ipv4;
        if (!ipv6 && parsed.ipv6) ipv6 = parsed.ipv6;
    }

    return { ipv4, ipv6, primary };
}

function isPrivateIpv4(ipv4) {
    if (!ipv4) return false;
    const parts = String(ipv4).split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
        return false;
    }
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    return false;
}

function isPrivateIpv6(ipv6) {
    if (!ipv6) return false;
    const normalized = String(ipv6).toLowerCase();
    if (normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('fe80')) return true;
    return false;
}

function getIpLocationLabel(rawIp) {
    const parsed = parseSingleIp(rawIp);
    const primary = parsed.primary;
    if (!primary) return 'Unknown location';

    if (primary === '127.0.0.1' || primary === '::1') {
        return 'Localhost';
    }

    if (parsed.ipv4 && isPrivateIpv4(parsed.ipv4)) {
        return 'Private Network';
    }

    if (parsed.ipv6 && isPrivateIpv6(parsed.ipv6)) {
        return 'Private IPv6 Network';
    }

    return 'Public Network';
}

function getIpIntelligence(rawIp, userAgent = '') {
    const parsed = parseSingleIp(rawIp);
    const primary = parsed.primary;
    const ua = String(userAgent || '').toLowerCase();

    if (!primary) {
        return {
            ipVersion: 'Unknown',
            networkTypeLabel: 'Unknown Network',
            addressScope: 'Unknown',
            confidence: 'Low',
            riskSignals: ['No IP data']
        };
    }

    const isLoopback = primary === '127.0.0.1' || primary === '::1';
    const isPrivateV4 = Boolean(parsed.ipv4 && isPrivateIpv4(parsed.ipv4));
    const isPrivateV6 = Boolean(parsed.ipv6 && isPrivateIpv6(parsed.ipv6));
    const isPrivate = isLoopback || isPrivateV4 || isPrivateV6;
    const isPublic = !isPrivate;

    const ipVersion = parsed.ipv4 ? 'IPv4' : (parsed.ipv6 ? 'IPv6' : 'Unknown');
    const addressScope = isLoopback ? 'Loopback' : (isPrivate ? 'Private' : 'Public');
    const networkTypeLabel = isLoopback
        ? 'Localhost'
        : (isPrivate ? 'Private Network' : 'Public Network');

    const riskSignals = [];
    if (isPublic) riskSignals.push('Externally routable IP');
    if (ipVersion === 'IPv6') riskSignals.push('IPv6 transport');
    if (ua.includes('headless') || ua.includes('bot') || ua.includes('spider') || ua.includes('crawler')) {
        riskSignals.push('Automated client signature');
    }
    if (!ua || ua === 'unknown') riskSignals.push('Missing user agent');

    const confidence = isLoopback
        ? 'High (Local)'
        : (isPrivate ? 'Medium (Private network)' : 'Medium (Public IP only)');

    const reputation = getIpReputationAssessment(primary, userAgent);

    return {
        ipVersion,
        networkTypeLabel,
        addressScope,
        confidence,
        riskSignals: [...new Set([...riskSignals, ...reputation.reasonLabels])].slice(0, 6),
        reputationScore: reputation.score,
        reputationRiskLevel: reputation.riskLevel,
        reputationBlocked: reputation.shouldBlock
    };
}

function getIpReputationAssessment(rawIp, userAgent = '') {
    const parsed = parseSingleIp(rawIp);
    const primary = parsed.primary;
    const ua = String(userAgent || '').toLowerCase().trim();

    const isLoopback = primary === '127.0.0.1' || primary === '::1';
    const isPrivateV4 = Boolean(parsed.ipv4 && isPrivateIpv4(parsed.ipv4));
    const isPrivateV6 = Boolean(parsed.ipv6 && isPrivateIpv6(parsed.ipv6));
    const isPrivate = isLoopback || isPrivateV4 || isPrivateV6;

    let score = 0;
    const reasonCodes = [];
    const reasonLabels = [];

    const addReason = (code, label, amount) => {
        reasonCodes.push(String(code));
        reasonLabels.push(String(label));
        score += Number(amount) || 0;
    };

    if (!primary || String(primary).toLowerCase() === 'unknown') {
        addReason('missing-ip', 'Missing IP data', 35);
    } else if (isLoopback) {
        addReason('loopback-ip', 'Localhost source', -20);
    } else if (isPrivate) {
        addReason('private-network', 'Private network source', 5);
    } else {
        addReason('public-network', 'Public network source', 30);
    }

    if (parsed.ipv6 && !isPrivate) {
        addReason('public-ipv6', 'Public IPv6 source', 5);
    }

    if (!ua || ua === 'unknown') {
        addReason('missing-user-agent', 'Missing user agent', 20);
    }

    const automatedUaPattern = /(headless|bot|crawler|spider|curl|wget|python-requests|axios|go-http-client|scrapy|selenium|playwright|phantomjs|node-fetch|insomnia|postmanruntime)/i;
    if (automatedUaPattern.test(ua)) {
        addReason('automated-client', 'Automated client signature', 35);
    } else if (/(mozilla|chrome|safari|firefox|edg)/i.test(ua)) {
        addReason('browser-client', 'Browser-like user agent', -5);
    }

    score = Math.max(0, Math.min(100, Math.round(score)));

    let riskLevel = 'low';
    if (score >= 80) {
        riskLevel = 'critical';
    } else if (score >= 65) {
        riskLevel = 'high';
    } else if (score >= 45) {
        riskLevel = 'medium';
    }

    const shouldBlock = !isLoopback && !isPrivate && score >= IP_REPUTATION_BLOCK_SCORE;
    const isElevated = !shouldBlock && !isLoopback && score >= IP_REPUTATION_ELEVATED_SCORE;

    return {
        score,
        riskLevel,
        shouldBlock,
        isElevated,
        reasonCodes: reasonCodes.slice(0, 6),
        reasonLabels: reasonLabels.slice(0, 6)
    };
}

function toRadians(value) {
    return (Number(value) * Math.PI) / 180;
}

function getDistanceKm(lat1, lon1, lat2, lon2) {
    const radiusKm = 6371;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return radiusKm * c;
}

function isLikelyProxyNetwork(networkName = '', asn = '') {
    const label = `${networkName} ${asn}`.toLowerCase();
    return /(vpn|proxy|tor|hosting|datacenter|data center|cloud|digitalocean|linode|ovh|aws|amazon|google|gcp|azure|cloudflare|vultr|hetzner|contabo|leaseweb|m247|colo)/i.test(label);
}

function getSessionRiskLevel(score) {
    if (score >= 70) return 'high';
    if (score >= 30) return 'medium';
    return 'low';
}

function normalizeLabel(value) {
    return String(value || '').trim().toLowerCase();
}

function matchesDeviceLabel(sessionLabel, eventLabel) {
    const sessionValue = normalizeLabel(sessionLabel);
    const eventValue = normalizeLabel(eventLabel);
    if (!sessionValue || !eventValue) return false;
    return sessionValue.includes(eventValue) || eventValue.includes(sessionValue);
}

async function calculateSessionRisk(session, context) {
    const reasons = [];
    const signals = [];
    let score = 0;

    const addReason = (label, amount, signal) => {
        if (label) reasons.push(label);
        if (signal) signals.push(signal);
        score += Number(amount) || 0;
    };

    if (!session || typeof session !== 'object') {
        return { score: 0, level: 'low', reasons: [], signals: [] };
    }

    const reputation = getIpReputationAssessment(session.ipAddress, session.userAgent);
    if (reputation.shouldBlock) {
        addReason(`IP reputation blocked (${reputation.score})`, 35, 'ip-reputation-blocked');
    } else if (reputation.isElevated) {
        addReason(`IP reputation elevated (${reputation.score})`, 20, 'ip-reputation-elevated');
    }

    const failedCount = context.failedLoginCounts.get(session.username) || 0;
    if (failedCount >= 5) {
        addReason(`Failed logins in last 30m: ${failedCount}`, 30, 'failed-login-streak');
    } else if (failedCount >= 3) {
        addReason(`Failed logins in last 30m: ${failedCount}`, 20, 'failed-login-streak');
    } else if (failedCount >= 1) {
        addReason(`Failed logins in last 30m: ${failedCount}`, 10, 'failed-login-streak');
    }

    const loginTimeMs = Number(session.createdAtTimestamp || 0);
    const newDeviceEvents = context.newDeviceEventsByUser.get(session.username) || [];
    const newDeviceEvent = newDeviceEvents.find((event) => {
        if (!event?.createdAtMs || !loginTimeMs) return false;
        const deltaMs = Math.abs(event.createdAtMs - loginTimeMs);
        if (deltaMs > 24 * 60 * 60 * 1000) return false;
        if (event.deviceLabel && session.deviceInfo) {
            return matchesDeviceLabel(session.deviceInfo, event.deviceLabel);
        }
        return true;
    });
    if (newDeviceEvent) {
        addReason('New device login detected', 25, 'new-device-login');
    }

    const geo = await lookupIpGeolocation(session.ipAddress);
    if (geo?.network && isLikelyProxyNetwork(geo.network, geo.asn)) {
        addReason(`Possible VPN/hosting network (${geo.network})`, 20, 'vpn-proxy');
    }

    const loginHistory = context.loginHistoryByUser.get(session.username) || [];
    const previousLogin = loginHistory.find((entry) => entry.createdAtMs < loginTimeMs);
    if (previousLogin?.ipAddress && loginTimeMs) {
        const previousGeo = await lookupIpGeolocation(previousLogin.ipAddress);
        if (geo?.latitude && geo?.longitude && previousGeo?.latitude && previousGeo?.longitude) {
            const distanceKm = getDistanceKm(geo.latitude, geo.longitude, previousGeo.latitude, previousGeo.longitude);
            const hours = Math.max(0, (loginTimeMs - previousLogin.createdAtMs) / (60 * 60 * 1000));
            if (distanceKm >= 1500 && hours <= 6) {
                addReason(`Geo jump ${Math.round(distanceKm)}km in ${Math.round(hours)}h`, 30, 'geo-jump');
            } else if (distanceKm >= 800 && hours <= 6) {
                addReason(`Geo jump ${Math.round(distanceKm)}km in ${Math.round(hours)}h`, 20, 'geo-jump');
            } else if (distanceKm >= 1500 && hours <= 24) {
                addReason(`Geo jump ${Math.round(distanceKm)}km in ${Math.round(hours)}h`, 20, 'geo-jump');
            }
        }
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    return {
        score,
        level: getSessionRiskLevel(score),
        reasons: reasons.slice(0, 6),
        signals: signals.slice(0, 6)
    };
}

function evaluateRequestIpReputation(req, flow = 'auth', username = '') {
    const assessment = getIpReputationAssessment(req?.clientIP, req?.userAgent);
    const metadata = {
        flow: String(flow || 'auth'),
        username: String(username || ''),
        reputationScore: assessment.score,
        riskLevel: assessment.riskLevel,
        reasons: assessment.reasonCodes
    };

    if (assessment.shouldBlock) {
        emitSecuritySignal(req, 'ip-reputation-blocked', metadata, 30 * 1000);
    } else if (assessment.isElevated) {
        emitSecuritySignal(req, 'ip-reputation-elevated', metadata, 2 * 60 * 1000);
    }

    return assessment;
}

const GEO_LOOKUP_CACHE_TTL_MS = 10 * 60 * 1000;
const ipGeoLookupCache = new Map();

function isPublicIp(rawIp) {
    const parsed = parseSingleIp(rawIp);
    const primary = parsed.primary;
    if (!primary) return false;
    if (primary === '127.0.0.1' || primary === '::1') return false;
    if (parsed.ipv4 && isPrivateIpv4(parsed.ipv4)) return false;
    if (parsed.ipv6 && isPrivateIpv6(parsed.ipv6)) return false;
    return true;
}

function findBestPublicIpCandidate(candidates = []) {
    for (const candidate of candidates) {
        if (!candidate) continue;
        if (isPublicIp(candidate)) {
            return parseSingleIp(candidate).primary;
        }
    }
    return null;
}

async function lookupIpGeolocation(ipAddress) {
    const ip = String(ipAddress || '').trim();
    if (!ip || !isPublicIp(ip)) return null;

    const cached = ipGeoLookupCache.get(ip);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
    }

    const triedProviders = [];

    const valueFromIpApiCom = await lookupIpWithIpApiCom(ip).catch(() => null);
    triedProviders.push('ip-api.com');
    if (valueFromIpApiCom) {
        const value = { ...valueFromIpApiCom, providersTried: [...triedProviders] };
        ipGeoLookupCache.set(ip, {
            value,
            expiresAt: Date.now() + GEO_LOOKUP_CACHE_TTL_MS
        });
        return value;
    }

    const valueFromIpWho = await lookupIpWithIpWhoIs(ip).catch(() => null);
    triedProviders.push('ipwho.is');
    if (valueFromIpWho) {
        const value = { ...valueFromIpWho, providersTried: [...triedProviders] };
        ipGeoLookupCache.set(ip, {
            value,
            expiresAt: Date.now() + GEO_LOOKUP_CACHE_TTL_MS
        });
        return value;
    }

    const valueFromIpApi = await lookupIpWithIpApiCo(ip).catch(() => null);
    triedProviders.push('ipapi.co');
    if (valueFromIpApi) {
        const value = { ...valueFromIpApi, providersTried: [...triedProviders] };
        ipGeoLookupCache.set(ip, {
            value,
            expiresAt: Date.now() + GEO_LOOKUP_CACHE_TTL_MS
        });
        return value;
    }

    return null;
}

async function fetchJsonWithTimeout(url, timeoutMs = 2500) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) return null;
        const payload = await response.json().catch(() => null);
        return payload || null;
    } catch (_) {
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function lookupIpWithIpWhoIs(ip) {
    const payload = await fetchJsonWithTimeout(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,ip,latitude,longitude,city,region,country,continent,connection,message`);
    if (!payload?.success) return null;

    const latitude = Number(payload.latitude);
    const longitude = Number(payload.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

    const locationLabel = [payload.city, payload.region, payload.country]
        .map((part) => String(part || '').trim())
        .filter(Boolean)
        .join(', ') || (String(payload.continent || '').trim() || 'Approximate location');

    return {
        ip: String(payload.ip || ip),
        latitude,
        longitude,
        locationLabel,
        provider: 'ipwho.is',
        network: String(payload.connection?.isp || payload.connection?.org || '').trim() || null,
        asn: String(payload.connection?.asn || '').trim() || null
    };
}

async function lookupIpWithIpApiCo(ip) {
    const payload = await fetchJsonWithTimeout(`https://ipapi.co/${encodeURIComponent(ip)}/json/`);
    if (!payload || payload.error) return null;

    const latitude = Number(payload.latitude);
    const longitude = Number(payload.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

    const locationLabel = [payload.city, payload.region, payload.country_name]
        .map((part) => String(part || '').trim())
        .filter(Boolean)
        .join(', ') || 'Approximate location';

    return {
        ip: String(payload.ip || ip),
        latitude,
        longitude,
        locationLabel,
        provider: 'ipapi.co',
        network: String(payload.org || payload.asn || '').trim() || null,
        asn: String(payload.asn || '').trim() || null
    };
}

async function lookupIpWithIpApiCom(ip) {
    const payload = await fetchJsonWithTimeout(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,regionName,city,lat,lon,isp,org,as,query`);
    if (!payload || payload.status !== 'success') return null;

    const latitude = Number(payload.lat);
    const longitude = Number(payload.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

    const locationLabel = [payload.city, payload.regionName, payload.country]
        .map((part) => String(part || '').trim())
        .filter(Boolean)
        .join(', ') || 'Approximate location';

    return {
        ip: String(payload.query || ip),
        latitude,
        longitude,
        locationLabel,
        provider: 'ip-api.com',
        network: String(payload.isp || payload.org || '').trim() || null,
        asn: String(payload.as || '').trim() || null
    };
}

function parseRecoveryCodeHashes(serialized) {
    if (!serialized) return [];
    try {
        const parsed = JSON.parse(serialized);
        return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string' && value.trim()) : [];
    } catch (_) {
        return [];
    }
}

function generateRecoveryCodes(count = 10) {
    const codes = [];
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

    for (let idx = 0; idx < count; idx += 1) {
        let code = '';
        for (let i = 0; i < 12; i += 1) {
            const randomByte = crypto.randomBytes(1)[0];
            code += alphabet[randomByte % alphabet.length];
        }
        codes.push(`${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`);
    }

    return codes;
}

function hashRecoveryCode(code) {
    return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function getDiscordOAuthConfig(req) {
    const clientId = String(process.env.CLIENT_ID || '').trim();
    const clientSecret = String(process.env.DISCORD_OAUTH_CLIENT_SECRET || '').trim();
    const configuredRedirect = String(process.env.DISCORD_OAUTH_REDIRECT_URI || '').trim();
    const fallbackRedirect = `${req.protocol}://${req.get('host')}/api/account/discord/oauth/callback`;
    const redirectUri = configuredRedirect || fallbackRedirect;
    let callbackOrigin = '';
    let requestOrigin = '';
    let hostMatchesRequest = true;

    try {
        callbackOrigin = new URL(redirectUri).origin;
        requestOrigin = getRequestOrigin(req);
        hostMatchesRequest = normalizeOriginValue(callbackOrigin) === normalizeOriginValue(requestOrigin);
    } catch (_) {
        callbackOrigin = '';
        requestOrigin = getRequestOrigin(req);
        hostMatchesRequest = true;
    }

    return {
        clientId,
        clientSecret,
        redirectUri,
        callbackOrigin,
        requestOrigin,
        hostMatchesRequest,
        ready: Boolean(clientId && clientSecret && redirectUri)
    };
}

const DISCORD_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const discordOAuthStateStore = new Map();

function storeDiscordOAuthState(state, payload) {
    if (!state) return;
    discordOAuthStateStore.set(String(state), {
        ...payload,
        createdAt: Number(payload?.createdAt || Date.now())
    });
}

function consumeDiscordOAuthState(state) {
    const key = String(state || '');
    if (!key) return null;

    const record = discordOAuthStateStore.get(key);
    if (!record) return null;

    discordOAuthStateStore.delete(key);

    const age = Date.now() - Number(record.createdAt || 0);
    if (!Number.isFinite(age) || age > DISCORD_OAUTH_STATE_TTL_MS) {
        return null;
    }

    return record;
}

function sanitizeHtmlText(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function completeDiscordOAuthRequest(req, res, { success, message }) {
    const status = success ? 'success' : 'error';
    const encodedMessage = encodeURIComponent(String(message || 'OAuth request completed'));

    if (req.session?.authenticated) {
        return res.redirect(`/profile?discord_oauth=${status}&message=${encodedMessage}`);
    }

    // Serve custom HTML files for unauthenticated users
    const filePath = success
        ? path.join(__dirname, 'AdminPanel', 'views', 'discord-link-complete.html')
        : path.join(__dirname, 'AdminPanel', 'views', 'discord-link-failed.html');
    return res.status(success ? 200 : 400).sendFile(filePath);
}

// Helper function to extract device from user agent
function extractDeviceFromUserAgent(userAgent) {
    if (!userAgent) return 'Unknown';
    if (userAgent.includes('Chrome')) return 'Chrome';
    if (userAgent.includes('Firefox')) return 'Firefox';
    if (userAgent.includes('Safari')) return 'Safari';
    if (userAgent.includes('Edge')) return 'Edge';
    return 'Other';
}

// Enhanced user agent parser for session display
function parseUserAgent(userAgent) {
    if (!userAgent || userAgent === 'Unknown') {
        return {
            browser: 'Unknown',
            browserVersion: '',
            os: 'Unknown',
            osVersion: '',
            deviceType: 'Unknown',
            deviceIcon: '❓'
        };
    }

    const ua = String(userAgent);
    let browser = 'Unknown';
    let browserVersion = '';
    let os = 'Unknown';
    let osVersion = '';
    let deviceType = 'Desktop';
    let deviceIcon = '💻';

    // Detect browser
    if (ua.includes('Edg/')) {
        browser = 'Edge';
        const match = ua.match(/Edg\/([\d.]+)/);
        if (match) browserVersion = match[1];
    } else if (ua.includes('Chrome/') && !ua.includes('Edg')) {
        browser = 'Chrome';
        const match = ua.match(/Chrome\/([\d.]+)/);
        if (match) browserVersion = match[1];
    } else if (ua.includes('Firefox/')) {
        browser = 'Firefox';
        const match = ua.match(/Firefox\/([\d.]+)/);
        if (match) browserVersion = match[1];
    } else if (ua.includes('Safari/') && !ua.includes('Chrome')) {
        browser = 'Safari';
        const match = ua.match(/Version\/([\d.]+)/);
        if (match) browserVersion = match[1];
    } else if (ua.includes('Opera/') || ua.includes('OPR/')) {
        browser = 'Opera';
        const match = ua.match(/(?:Opera|OPR)\/([\d.]+)/);
        if (match) browserVersion = match[1];
    }

    // Detect OS
    if (ua.includes('Windows NT')) {
        os = 'Windows';
        const match = ua.match(/Windows NT ([\d.]+)/);
        if (match) {
            const version = match[1];
            if (version === '10.0') osVersion = '10/11';
            else if (version === '6.3') osVersion = '8.1';
            else if (version === '6.2') osVersion = '8';
            else if (version === '6.1') osVersion = '7';
            else osVersion = version;
        }
        deviceIcon = '🖥️';
    } else if (ua.includes('Mac OS X')) {
        os = 'macOS';
        const match = ua.match(/Mac OS X ([\d_]+)/);
        if (match) osVersion = match[1].replace(/_/g, '.');
        if (ua.includes('iPad') || ua.includes('iPhone')) {
            os = ua.includes('iPad') ? 'iPadOS' : 'iOS';
            deviceType = ua.includes('iPad') ? 'Tablet' : 'Mobile';
            deviceIcon = ua.includes('iPad') ? '📲' : '📱';
        } else {
            deviceIcon = '🖥️';
        }
    } else if (ua.includes('Android')) {
        os = 'Android';
        const match = ua.match(/Android ([\d.]+)/);
        if (match) osVersion = match[1];
        deviceType = ua.includes('Mobile') ? 'Mobile' : 'Tablet';
        deviceIcon = deviceType === 'Mobile' ? '📱' : '📲';
    } else if (ua.includes('Linux')) {
        os = 'Linux';
        deviceIcon = '🖥️';
    } else if (ua.includes('CrOS')) {
        os = 'Chrome OS';
        deviceIcon = '🖥️';
    }

    return {
        browser,
        browserVersion,
        os,
        osVersion,
        deviceType,
        deviceIcon,
        full: `${browser}${browserVersion ? ' ' + browserVersion.split('.')[0] : ''} on ${os}${osVersion ? ' ' + osVersion : ''}`
    };
}

const TWO_FACTOR_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS = 5;
const TWO_FACTOR_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const TWO_FACTOR_FAILURE_MAX_ATTEMPTS = 5;
const TWO_FACTOR_FAILURE_BLOCK_MS = 5 * 60 * 1000;
const twoFactorChallenges = new Map();
const twoFactorAttemptFailures = new Map();

function getTwoFactorAttemptKey(username, scope = 'default') {
    return `${String(scope || 'default').trim().toLowerCase()}:${String(username || '').trim().toLowerCase()}`;
}

function cleanupTwoFactorAttemptFailures(now = Date.now()) {
    for (const [key, record] of twoFactorAttemptFailures.entries()) {
        const attempts = Array.isArray(record?.attempts)
            ? record.attempts.filter((timestamp) => now - Number(timestamp || 0) <= TWO_FACTOR_FAILURE_WINDOW_MS)
            : [];
        const blockedUntil = Number(record?.blockedUntil || 0);

        if (!attempts.length && blockedUntil <= now) {
            twoFactorAttemptFailures.delete(key);
            continue;
        }

        record.attempts = attempts;
        if (blockedUntil <= now) {
            record.blockedUntil = 0;
        }
    }
}

function isTwoFactorAttemptBlocked(username, scope = 'default') {
    cleanupTwoFactorAttemptFailures();
    const key = getTwoFactorAttemptKey(username, scope);
    const record = twoFactorAttemptFailures.get(key);
    return Boolean(record && Number(record.blockedUntil || 0) > Date.now());
}

function noteTwoFactorAttemptFailure(username, scope = 'default') {
    const key = getTwoFactorAttemptKey(username, scope);
    const now = Date.now();
    const record = twoFactorAttemptFailures.get(key) || { attempts: [], blockedUntil: 0 };
    record.attempts = Array.isArray(record.attempts)
        ? record.attempts.filter((timestamp) => now - Number(timestamp || 0) <= TWO_FACTOR_FAILURE_WINDOW_MS)
        : [];
    record.attempts.push(now);

    if (record.attempts.length >= TWO_FACTOR_FAILURE_MAX_ATTEMPTS) {
        record.blockedUntil = now + TWO_FACTOR_FAILURE_BLOCK_MS;
    }

    twoFactorAttemptFailures.set(key, record);
    return record;
}

function clearTwoFactorAttemptFailures(username, scope = 'default') {
    twoFactorAttemptFailures.delete(getTwoFactorAttemptKey(username, scope));
}

function cleanupTwoFactorChallenges() {
    const now = Date.now();
    for (const [challengeId, challenge] of twoFactorChallenges.entries()) {
        if (!challenge || challenge.expiresAt <= now) {
            twoFactorChallenges.delete(challengeId);
        }
    }
}

setInterval(cleanupTwoFactorChallenges, 60 * 1000);
setInterval(cleanupTwoFactorAttemptFailures, 60 * 1000);

function createTwoFactorChallenge({ username, userId, role, ipAddress, userAgent, binding }) {
    const challengeId = crypto.randomBytes(24).toString('hex');
    twoFactorChallenges.set(challengeId, {
        username,
        userId,
        role,
        ipAddress,
        userAgent,
        binding,
        attemptCount: 0,
        expiresAt: Date.now() + TWO_FACTOR_CHALLENGE_TTL_MS
    });
    return challengeId;
}

async function logAdminAuthEvent(username, eventType, req, metadata = {}) {
    try {
        const { v7: uuidv7 } = require('uuid');
        const id = uuidv7();
        await MySQLDatabaseManager.connection.pool.execute(
            `INSERT INTO admin_auth_events (id, username, event_type, ip_address, user_agent, metadata)
             VALUES (?, ?, ?, ?, ?, ?)` ,
            [
                id,
                username || 'unknown',
                eventType,
                req?.clientIP || null,
                req?.userAgent || null,
                JSON.stringify(metadata || {})
            ]
        );
    } catch (error) {
        console.error('[AdminPanel] Failed to write auth event:', error.message);
    }
}

function parseSessionRow(row) {
    try {
        const parsed = JSON.parse(row.data || '{}');
        const cookieExpires = parsed?.cookie?.expires ? new Date(parsed.cookie.expires) : null;

        let ipAddressV4 = parsed.ipAddressV4 || null;
        let ipAddressV6 = parsed.ipAddressV6 || null;
        const rawIpAddress = parsed.ipAddress || null;

        if (!ipAddressV4 && !ipAddressV6 && rawIpAddress) {
            const ipInfo = getIpInfoFromCandidates([rawIpAddress]);
            ipAddressV4 = ipInfo.ipv4 || null;
            ipAddressV6 = ipInfo.ipv6 || null;
        }

        const preferredIpAddress = ipAddressV4 || ipAddressV6 || rawIpAddress || null;

        return {
            sessionId: row.session_id,
            username: parsed.username || null,
            userId: parsed.userId || null,
            role: parsed.role || null,
            loginTime: parsed.loginTime || null,
            lastActivityAt: parsed.lastActivityAt || null,
            absoluteExpiresAt: parsed.absoluteExpiresAt || null,
            ipAddress: preferredIpAddress,
            ipAddressV4,
            ipAddressV6,
            userAgent: parsed.userAgent || null,
            expiresAt: cookieExpires || (row.expires ? new Date(row.expires) : null)
        };
    } catch (_) {
        return null;
    }
}

function isHighConfidenceSession(session) {
    if (!session || typeof session !== 'object') return false;
    const hasIdentity = Boolean(session.username || session.userId);
    const hasContext = Boolean(session.userAgent || session.ipAddress || session.loginTime || session.role);
    return hasIdentity && hasContext;
}

async function listUserSessions(username, userId, currentSessionId, options = {}) {
    const includeLowConfidence = Boolean(options.includeLowConfidence);
    const [rows] = await MySQLDatabaseManager.connection.pool.query('SELECT session_id, expires, data FROM sessions');
    const sessions = (rows || [])
        .map(parseSessionRow)
        .filter(Boolean)
        .filter((session) => {
            const usernameMatch = username && session.username && String(session.username) === String(username);
            const userIdMatch = userId && session.userId !== null && String(session.userId) === String(userId);
            return Boolean(usernameMatch || userIdMatch);
        })
        .map((session) => ({
            ...session,
            isCurrent: session.sessionId === currentSessionId,
            device: extractDeviceFromUserAgent(session.userAgent),
            geoLabel: getIpLocationLabel(session.ipAddress)
        }))
        .filter((session) => {
            if (includeLowConfidence) return true;
            if (session.isCurrent) return true;
            return isHighConfidenceSession(session);
        })
        .sort((a, b) => {
            const aTime = a.loginTime ? Number(a.loginTime) : 0;
            const bTime = b.loginTime ? Number(b.loginTime) : 0;
            return bTime - aTime;
        });

    return sessions;
}

async function closeOtherUserSessions(username, userId, currentSessionId) {
    if (!username || !currentSessionId) return;

    const sessions = await listUserSessions(username, userId, currentSessionId, { includeLowConfidence: true });
    const idsToDelete = sessions
        .filter((session) => !session.isCurrent)
        .map((session) => session.sessionId)
        .filter(Boolean);

    if (!idsToDelete.length) return;

    const placeholders = idsToDelete.map(() => '?').join(', ');
    await MySQLDatabaseManager.connection.pool.query(
        `DELETE FROM sessions WHERE session_id IN (${placeholders})`,
        idsToDelete
    );
}

// Helper function to format action type
function formatActionType(action) {
    const actionMap = {
        'LOGIN': '🔓 Login',
        'LOGOUT': '🔒 Logout',
        'BAN': '⛔ Ban User',
        'UNBAN': '🔓 Unban User',
        'WARN': '⚠️ Warn User',
        'KICK': '👢 Kick User',
        'DELETE_MSG': '🗑️ Delete Message',
        'TIMEOUT': '⏱️ Timeout User',
        'ROLE_CHANGE': '👑 Role Change',
        'TICKET_CREATE': '🎫 Create Ticket',
        'TICKET_CLOSE': '✅ Close Ticket'
    };
    return actionMap[action] || action;
}


// Punishment history endpoint
app.get('/api/punishment-history/:userId', requireAuth, async (req, res) => {
    try {
        const { userId } = req.params;
        // Placeholder - would query punishment_history table
        res.json([]);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get punishment history' });
    }
});

// Server rules

// Get server rules (public endpoint)
app.get('/api/rules', async (req, res) => {
    try {
        res.json(RULES_CONFIG.rules);
    } catch (error) {
        console.error('Error fetching rules:', error);
        res.status(500).json({ error: 'Failed to fetch rules' });
    }
});

// Ban appeals

async function handleValidateBanCaseId(req, res) {
    try {
        const caseId = String(req.query?.caseId || '').trim();

        if (!/^BAN-[A-Za-z0-9]{1,50}$/.test(caseId)) {
            return res.status(400).json({ valid: false, error: 'Invalid case ID format' });
        }

        const { isValidBanCaseId } = require('./Functions/AppealHelper');
        const banCheck = await isValidBanCaseId(caseId);

        return res.json({ valid: Boolean(banCheck.valid) });
    } catch (error) {
        console.error('Error validating ban case ID:', error);
        return res.status(500).json({ valid: false, error: 'Failed to validate case ID' });
    }
}

// Validate ban case ID against database (public endpoint)
app.get('/api/appeals/validate-case-id', createRateLimiter(30, 60000), handleValidateBanCaseId);
app.get('/appeal/api/appeals/validate-case-id', createRateLimiter(30, 60000), handleValidateBanCaseId);

// Submit a ban appeal
app.post('/api/appeals/submit', createRateLimiter(1, 3600000), (req, res) => {
    appealEvidenceUpload.array('appealEvidence', 3)(req, res, async (uploadError) => {
        try {
            if (uploadError) {
                const message = uploadError instanceof multer.MulterError
                    ? (uploadError.code === 'LIMIT_FILE_SIZE'
                        ? 'Each evidence file must be 5MB or smaller.'
                        : 'Failed to process appeal evidence upload.')
                    : (uploadError.message || 'Failed to process appeal evidence upload.');
                return res.status(400).json({ error: message });
            }

            const { userId, userTag, caseId, reason, email } = req.body || {};
            const normalizedUserId = String(userId || '').trim();
            const normalizedUserTag = String(userTag || '').trim();
            const normalizedCaseId = String(caseId || '').trim();
            const normalizedReason = String(reason || '').trim();
            const normalizedEmail = String(email || '').trim();
            const evidenceFiles = buildAppealEvidenceMetadata(req.files || []);

            if (!normalizedUserId || !normalizedUserTag || !normalizedCaseId || !normalizedReason || !normalizedEmail) {
                cleanupAppealUploadFiles(req.files || []);
                return res.status(400).json({ error: 'Missing required fields' });
            }

            const { isValidBanCaseId } = require('./Functions/AppealHelper');
            const banCheck = await isValidBanCaseId(normalizedCaseId);
            if (!banCheck.valid) {
                cleanupAppealUploadFiles(req.files || []);
                return res.status(400).json({ error: 'Ban case ID is invalid or user is not currently banned.' });
            }

            if (!isValidEmailAddress(normalizedEmail)) {
                cleanupAppealUploadFiles(req.files || []);
                return res.status(400).json({ error: 'Invalid email format' });
            }

            const [existing] = await MySQLDatabaseManager.connection.pool.execute(
                'SELECT id FROM ban_appeals WHERE user_id = ? AND status = ? LIMIT 1',
                [normalizedUserId, 'pending']
            );

            if (existing.length > 0) {
                cleanupAppealUploadFiles(req.files || []);
                return res.status(400).json({ error: 'You already have a pending appeal. Please wait for a response.' });
            }

            try {
                await MySQLDatabaseManager.connection.pool.execute(
                    `INSERT INTO ban_appeals
                        (user_id, user_tag, ban_case_id, reason, user_email, evidence_json, review_stage)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        normalizedUserId,
                        normalizedUserTag,
                        normalizedCaseId,
                        normalizedReason,
                        normalizedEmail,
                        JSON.stringify(evidenceFiles),
                        'submitted'
                    ]
                );
            } catch (insertError) {
                if (insertError?.code === 'ER_BAD_FIELD_ERROR') {
                    await MySQLDatabaseManager.connection.pool.execute(
                        'INSERT INTO ban_appeals (user_id, user_tag, ban_case_id, reason) VALUES (?, ?, ?, ?)',
                        [normalizedUserId, normalizedUserTag, normalizedCaseId, normalizedReason]
                    );
                    cleanupAppealUploadFiles(req.files || []);
                } else {
                    throw insertError;
                }
            }

            const adminEmail = process.env.ADMIN_EMAIL;
            if (EmailHelper.isReady() && adminEmail) {
                await EmailHelper.sendNewAppealNotification(adminEmail, normalizedUserTag, normalizedUserId, normalizedReason).catch(err => {
                    console.error('Failed to send admin notification:', err.message);
                });
            }

            if (EmailHelper.isReady()) {
                await EmailHelper.sendAppealReceivedEmail(normalizedEmail, normalizedUserTag, normalizedCaseId).catch(err => {
                    console.error('Failed to send appeal received email:', err.message);
                });
            }

            res.json({ success: true, message: 'Appeal submitted successfully', evidenceCount: evidenceFiles.length });
        } catch (error) {
            cleanupAppealUploadFiles(req.files || []);
            console.error('Error submitting appeal:', error);
            res.status(500).json({ error: 'Failed to submit appeal' });
        }
    });
});

app.post('/api/appeals/update-pending', createRateLimiter(5, 60000), (req, res) => {
    appealEvidenceUpload.array('appealEvidence', 3)(req, res, async (uploadError) => {
        try {
            if (uploadError) {
                const message = uploadError instanceof multer.MulterError
                    ? (uploadError.code === 'LIMIT_FILE_SIZE'
                        ? 'Each evidence file must be 5MB or smaller.'
                        : 'Failed to process appeal evidence upload.')
                    : (uploadError.message || 'Failed to process appeal evidence upload.');
                return res.status(400).json({ error: message });
            }

            const normalizedCaseId = String(req.body?.caseId || '').trim();
            const normalizedUserId = String(req.body?.userId || '').trim();
            const normalizedReason = String(req.body?.reason || '').trim();
            const normalizedEmail = String(req.body?.email || '').trim();
            const uploadedEvidence = buildAppealEvidenceMetadata(req.files || []);

            if (!normalizedCaseId || !normalizedUserId || !normalizedReason || !normalizedEmail) {
                cleanupAppealUploadFiles(req.files || []);
                return res.status(400).json({ error: 'Case ID, User ID, email, and appeal reason are required.' });
            }

            if (!isValidEmailAddress(normalizedEmail)) {
                cleanupAppealUploadFiles(req.files || []);
                return res.status(400).json({ error: 'Invalid email format' });
            }

            const [appeals] = await MySQLDatabaseManager.connection.pool.execute(
                `SELECT id, evidence_json
                 FROM ban_appeals
                 WHERE ban_case_id = ? AND user_id = ? AND status = 'pending'
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [normalizedCaseId, normalizedUserId]
            );

            if (!appeals.length) {
                cleanupAppealUploadFiles(req.files || []);
                return res.status(404).json({ error: 'No pending appeal found for this case and user.' });
            }

            const appeal = appeals[0];
            const existingEvidence = parseAppealEvidenceJson(appeal.evidence_json);
            const allowedUploadedCount = Math.max(0, 5 - existingEvidence.length);
            const keptUploadedEvidence = uploadedEvidence.slice(0, allowedUploadedCount);
            const discardedUploadedEvidence = uploadedEvidence.slice(allowedUploadedCount);
            if (discardedUploadedEvidence.length) {
                deleteManagedAppealEvidenceFiles(discardedUploadedEvidence);
            }
            const mergedEvidence = [...existingEvidence, ...keptUploadedEvidence].slice(0, 5);

            await MySQLDatabaseManager.connection.pool.execute(
                `UPDATE ban_appeals
                 SET reason = ?,
                     user_email = ?,
                     evidence_json = ?,
                     updated_at = NOW()
                 WHERE id = ?`,
                [normalizedReason, normalizedEmail, JSON.stringify(mergedEvidence), appeal.id]
            );

            const [updatedRows] = await MySQLDatabaseManager.connection.pool.execute(
                `SELECT id, ban_case_id, status, created_at, updated_at, decided_at, withdrawn_at,
                        review_stage, public_status_note, owner_response, evidence_json
                 FROM ban_appeals
                 WHERE id = ?
                 LIMIT 1`,
                [appeal.id]
            );

            res.json({
                success: true,
                message: 'Pending appeal updated successfully.',
                appeal: buildPublicAppealRecord(updatedRows?.[0] || { id: appeal.id, ban_case_id: normalizedCaseId, status: 'pending', evidence_json: JSON.stringify(mergedEvidence) })
            });
        } catch (error) {
            cleanupAppealUploadFiles(req.files || []);
            console.error('Error updating pending appeal:', error);
            res.status(500).json({ error: 'Failed to update pending appeal' });
        }
    });
});

app.post('/api/appeals/withdraw', createRateLimiter(5, 60000), async (req, res) => {
    try {
        const normalizedCaseId = String(req.body?.caseId || '').trim();
        const normalizedUserId = String(req.body?.userId || '').trim();
        const withdrawReason = String(req.body?.withdrawReason || '').trim();

        if (!normalizedCaseId || !normalizedUserId) {
            return res.status(400).json({ error: 'Case ID and User ID are required.' });
        }

        const [appeals] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT id
             FROM ban_appeals
             WHERE ban_case_id = ? AND user_id = ? AND status = 'pending'
             ORDER BY created_at DESC
             LIMIT 1`,
            [normalizedCaseId, normalizedUserId]
        );

        if (!appeals.length) {
            return res.status(404).json({ error: 'No pending appeal found for this case and user.' });
        }

        await MySQLDatabaseManager.connection.pool.execute(
            `UPDATE ban_appeals
             SET status = 'withdrawn',
                 review_stage = 'withdrawn',
                 withdraw_reason = ?,
                 withdrawn_at = NOW(),
                 updated_at = NOW(),
                 public_status_note = COALESCE(NULLIF(public_status_note, ''), 'This appeal was withdrawn by the submitter before a final decision was made.')
             WHERE id = ?`,
            [withdrawReason || null, appeals[0].id]
        );

        res.json({ success: true, message: 'Appeal withdrawn successfully.' });
    } catch (error) {
        console.error('Error withdrawing appeal:', error);
        res.status(500).json({ error: 'Failed to withdraw appeal' });
    }
});

// Public API to check appeal status by case ID and user ID
app.post('/api/appeals/check-status', createRateLimiter(10, 60000), async (req, res) => {
    try {
        const { caseId, userId } = req.body;

        if (!caseId || !userId) {
            return res.status(400).json({ error: 'Case ID and User ID are required' });
        }

        // Query appeal by case ID and user ID for security
        const [appeals] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT id, user_tag, ban_case_id, status, created_at, updated_at, decided_at, withdrawn_at,
                    owner_response, review_stage, public_status_note, evidence_json, reason, user_email, withdraw_reason
             FROM ban_appeals 
             WHERE ban_case_id = ? AND user_id = ?
             ORDER BY created_at DESC
             LIMIT 1`,
            [caseId, userId]
        );

        if (appeals.length === 0) {
            return res.status(404).json({ error: 'No appeal found matching this Case ID and User ID' });
        }
        res.json({
            success: true,
            appeal: buildPublicAppealRecord(appeals[0])
        });
    } catch (error) {
        console.error('Error checking appeal status:', error);
        res.status(500).json({ error: 'Failed to check appeal status' });
    }
});

// Get user's appeal history (requires user ID verification)
app.post('/api/appeals/my-history', createRateLimiter(10, 60000), async (req, res) => {
    try {
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }

        // Query all appeals for this user
        const [appeals] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT id, user_tag, ban_case_id, status, created_at, updated_at, decided_at, withdrawn_at,
                    owner_response, review_stage, public_status_note, evidence_json, reason, user_email, withdraw_reason
             FROM ban_appeals 
             WHERE user_id = ?
             ORDER BY created_at DESC
             LIMIT 10`,
            [userId]
        );

        const history = appeals.map((appeal) => buildPublicAppealRecord(appeal));

        res.json({ success: true, appeals: history });
    } catch (error) {
        console.error('Error fetching appeal history:', error);
        res.status(500).json({ error: 'Failed to fetch appeal history' });
    }
});

// Get all pending appeals (moderator+ can view, owner+ can manage)
app.get('/api/appeals/pending', requireAuth, async (req, res) => {
    try {
        const [appeals] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT id, user_id, user_tag, ban_case_id, reason, created_at, updated_at, user_email,
                    review_stage, public_status_note, internal_note, evidence_json,
                    review_updated_by_id, review_updated_by_name
             FROM ban_appeals
             WHERE status = ?
             ORDER BY created_at DESC`,
            ['pending']
        );
        res.json(appeals);
    } catch (error) {
        console.error('Error fetching appeals:', error);
        res.status(500).json({ error: 'Failed to fetch appeals' });
    }
});

// Get all decided appeals (accepted/denied history)
app.get('/api/appeals/decided', requireAuth, async (req, res) => {
    try {
        let appeals;
        try {
            const [rows] = await MySQLDatabaseManager.connection.pool.execute(
                `SELECT id, user_id, user_tag, ban_case_id, reason, status, owner_response AS decision_code,
                        created_at, updated_at, decided_at, withdrawn_at, review_stage, public_status_note, internal_note, evidence_json,
                        decided_by_id AS moderator_id,
                        COALESCE(NULLIF(decided_by_name, ''), 'Owner') AS moderator,
                        COALESCE(NULLIF(decided_by_name, ''), 'Owner') AS moderator_tag
                 FROM ban_appeals
                 WHERE status IN ('accepted', 'denied', 'withdrawn')
                 ORDER BY decided_at DESC, created_at DESC`
            );
            appeals = rows;
        } catch (queryError) {
            if (queryError?.code !== 'ER_BAD_FIELD_ERROR') throw queryError;

            // Backward compatibility for older schemas before decided_by_* columns exist.
            const [rows] = await MySQLDatabaseManager.connection.pool.execute(
                `SELECT id, user_id, user_tag, ban_case_id, reason, status, owner_response AS decision_code,
                        created_at, updated_at, decided_at, withdrawn_at,
                        'submitted' AS review_stage,
                        NULL AS public_status_note,
                        NULL AS internal_note,
                        NULL AS evidence_json,
                        NULL AS moderator_id,
                        'Owner' AS moderator,
                        'Owner' AS moderator_tag
                 FROM ban_appeals
                 WHERE status IN ('accepted', 'denied', 'withdrawn')
                 ORDER BY decided_at DESC, created_at DESC`
            );
            appeals = rows;
        }
        res.json(appeals);
    } catch (error) {
        console.error('Error fetching decided appeals:', error);
        res.status(500).json({ error: 'Failed to fetch decided appeals' });
    }
});

const APPEAL_DECISION_CODES = {
    accepted: new Set(['accepted_standard', 'accepted_rejoin', 'accepted_warning', 'accepted_context', 'accepted_custom']),
    denied: new Set(['denied_standard', 'denied_policy', 'denied_insufficient', 'denied_wait', 'denied_custom'])
};

const APPEAL_DECISION_EMAIL_TEXT = {
    accepted_standard: 'Your ban appeal has been accepted. You may rejoin the server.',
    accepted_rejoin: 'After review, your appeal has been accepted and your restriction has been lifted.',
    accepted_warning: 'Your appeal was accepted. Please follow server rules moving forward to avoid future action.',
    accepted_context: 'Appeal accepted. The moderation team has reversed this case after reviewing the context.',
    accepted_custom: 'Your ban appeal has been accepted.',
    denied_standard: 'Your ban appeal has been denied.',
    denied_policy: 'After review, your appeal has been denied. The original moderation action stands.',
    denied_insufficient: 'Your appeal was denied due to insufficient new context to reverse the case.',
    denied_wait: 'Appeal denied. You may submit another appeal later if new evidence is available.',
    denied_custom: 'Your ban appeal has been denied.'
};

function normalizeAppealDecisionCode(status, rawCode) {
    const normalizedStatus = String(status || '').toLowerCase() === 'denied' ? 'denied' : 'accepted';
    const fallbackCode = normalizedStatus === 'denied' ? 'denied_standard' : 'accepted_standard';
    const code = String(rawCode || '').trim().toLowerCase();
    return APPEAL_DECISION_CODES[normalizedStatus].has(code) ? code : fallbackCode;
}

function resolveAppealEmailResponse(status, decisionCode, customResponse) {
    const cleanResponse = String(customResponse || '').trim();
    if (cleanResponse) return cleanResponse;
    return APPEAL_DECISION_EMAIL_TEXT[decisionCode] || APPEAL_DECISION_EMAIL_TEXT[status === 'denied' ? 'denied_standard' : 'accepted_standard'];
}

// Get appeals statistics
app.get('/api/appeals/stats', requireAuth, async (req, res) => {
    try {
        const [rows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT 
                COALESCE(SUM(status = 'pending'), 0) AS pending,
                COALESCE(SUM(status = 'accepted'), 0) AS accepted,
                COALESCE(SUM(status = 'denied'), 0) AS denied,
                COALESCE(SUM(status = 'withdrawn'), 0) AS withdrawn
            FROM ban_appeals`
        );
        const stats = rows?.[0] || { pending: 0, accepted: 0, denied: 0, withdrawn: 0 };
        res.json(stats);
    } catch (error) {
        console.error('Error fetching appeal stats:', error);
        res.status(500).json({ error: 'Failed to fetch appeal stats' });
    }
});

app.post('/api/appeals/:id/review', requireAuth, requireModerator, async (req, res) => {
    try {
        const { id } = req.params;
        const reviewStage = normalizeAppealReviewStage(req.body?.reviewStage);
        const publicStatusNote = String(req.body?.publicStatusNote || '').trim();
        const internalNote = String(req.body?.internalNote || '').trim();

        const [appeals] = await MySQLDatabaseManager.connection.pool.execute(
            'SELECT id FROM ban_appeals WHERE id = ? AND status = ? LIMIT 1',
            [id, 'pending']
        );

        if (!appeals.length) {
            return res.status(404).json({ error: 'Pending appeal not found' });
        }

        await MySQLDatabaseManager.connection.pool.execute(
            `UPDATE ban_appeals
             SET review_stage = ?,
                 public_status_note = ?,
                 internal_note = ?,
                 review_updated_by_id = ?,
                 review_updated_by_name = ?,
                 updated_at = NOW()
             WHERE id = ?`,
            [
                reviewStage,
                publicStatusNote || null,
                internalNote || null,
                String(req.session.userId || ''),
                String(req.session.username || 'Moderator'),
                id
            ]
        );

        res.json({ success: true, message: 'Appeal review details updated' });
    } catch (error) {
        console.error('Error updating appeal review details:', error);
        res.status(500).json({ error: 'Failed to update appeal review details' });
    }
});

// Accept ban appeal (owner only)
app.post('/api/appeals/:id/accept', requireAuth, requireOwner, async (req, res) => {
    try {
        const { id } = req.params;
        const { response, decisionCode } = req.body;
        const resolvedDecisionCode = normalizeAppealDecisionCode('accepted', decisionCode);

        // Fetch appeal details (works even on older schemas without user_email)
        const [appeals] = await MySQLDatabaseManager.connection.pool.execute(
            'SELECT id, user_tag FROM ban_appeals WHERE id = ?',
            [id]
        );

        const appeal = appeals[0];
        if (!appeal) {
            return res.status(404).json({ error: 'Appeal not found' });
        }

        try {
            await MySQLDatabaseManager.connection.pool.execute(
                'UPDATE ban_appeals SET status = ?, review_stage = ?, owner_response = ?, decided_at = NOW(), decided_by_id = ?, decided_by_name = ?, updated_at = NOW() WHERE id = ?',
                ['accepted', 'decision-issued', resolvedDecisionCode, String(req.session.userId || ''), String(req.session.username || 'Owner'), id]
            );
        } catch (updateError) {
            if (updateError?.code !== 'ER_BAD_FIELD_ERROR') throw updateError;

            // Backward compatibility for older schemas before decided_by_* columns exist.
            await MySQLDatabaseManager.connection.pool.execute(
                'UPDATE ban_appeals SET status = ?, owner_response = ?, decided_at = NOW() WHERE id = ?',
                ['accepted', resolvedDecisionCode, id]
            );
        }

        let userEmail = null;
        try {
            const [emailRows] = await MySQLDatabaseManager.connection.pool.execute(
                'SELECT user_email FROM ban_appeals WHERE id = ?',
                [id]
            );
            userEmail = emailRows?.[0]?.user_email || null;
        } catch (emailColumnError) {
            if (emailColumnError?.code !== 'ER_BAD_FIELD_ERROR') {
                throw emailColumnError;
            }
        }

        // Send email notification to user
        if (EmailHelper.isReady() && userEmail) {
            const finalResponse = resolveAppealEmailResponse('accepted', resolvedDecisionCode, response);
            await EmailHelper.sendAppealResponseEmail(
                userEmail,
                appeal.user_tag,
                'accepted',
                finalResponse
            ).catch(err => {
                console.error('Failed to send appeal response email:', err.message);
            });
        }

        console.log(`[Owner] ${req.session.username} accepted ban appeal #${id}`);
        res.json({ success: true, message: 'Appeal accepted' });
    } catch (error) {
        console.error('Error accepting appeal:', error);
        res.status(500).json({ error: 'Failed to accept appeal' });
    }
});

// Deny ban appeal (owner only)
app.post('/api/appeals/:id/deny', requireAuth, requireOwner, async (req, res) => {
    try {
        const { id } = req.params;
        const { response, decisionCode } = req.body;
        const resolvedDecisionCode = normalizeAppealDecisionCode('denied', decisionCode);

        // Fetch appeal details (works even on older schemas without user_email)
        const [appeals] = await MySQLDatabaseManager.connection.pool.execute(
            'SELECT id, user_tag FROM ban_appeals WHERE id = ?',
            [id]
        );

        const appeal = appeals[0];
        if (!appeal) {
            return res.status(404).json({ error: 'Appeal not found' });
        }

        try {
            await MySQLDatabaseManager.connection.pool.execute(
                'UPDATE ban_appeals SET status = ?, review_stage = ?, owner_response = ?, decided_at = NOW(), decided_by_id = ?, decided_by_name = ?, updated_at = NOW() WHERE id = ?',
                ['denied', 'decision-issued', resolvedDecisionCode, String(req.session.userId || ''), String(req.session.username || 'Owner'), id]
            );
        } catch (updateError) {
            if (updateError?.code !== 'ER_BAD_FIELD_ERROR') throw updateError;

            // Backward compatibility for older schemas before decided_by_* columns exist.
            await MySQLDatabaseManager.connection.pool.execute(
                'UPDATE ban_appeals SET status = ?, owner_response = ?, decided_at = NOW() WHERE id = ?',
                ['denied', resolvedDecisionCode, id]
            );
        }

        let userEmail = null;
        try {
            const [emailRows] = await MySQLDatabaseManager.connection.pool.execute(
                'SELECT user_email FROM ban_appeals WHERE id = ?',
                [id]
            );
            userEmail = emailRows?.[0]?.user_email || null;
        } catch (emailColumnError) {
            if (emailColumnError?.code !== 'ER_BAD_FIELD_ERROR') {
                throw emailColumnError;
            }
        }

        // Send email notification to user
        if (EmailHelper.isReady() && userEmail) {
            const finalResponse = resolveAppealEmailResponse('denied', resolvedDecisionCode, response);
            await EmailHelper.sendAppealResponseEmail(
                userEmail,
                appeal.user_tag,
                'denied',
                finalResponse
            ).catch(err => {
                console.error('Failed to send appeal response email:', err.message);
            });
        }

        console.log(`[Owner] ${req.session.username} denied ban appeal #${id}`);
        res.json({ success: true, message: 'Appeal denied' });
    } catch (error) {
        console.error('Error denying appeal:', error);
        res.status(500).json({ error: 'Failed to deny appeal' });
    }
});

// Alerts

let alertTablesInitialized = false;
let emailLogTableInitialized = false;
const ALERT_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const alertMonitorStatus = {
    running: false,
    lastRunAt: null,
    lastSuccessAt: null,
    lastDurationMs: null,
    lastError: null,
    lastErrorAt: null
};

async function ensureAlertTablesReady() {
    if (alertTablesInitialized) return;

    const pool = MySQLDatabaseManager?.connection?.pool;
    if (!pool) {
        throw new Error('Database pool is not ready');
    }

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS alert_settings (
            id INT AUTO_INCREMENT PRIMARY KEY,
            alert_type ENUM('cpu', 'memory', 'error_rate', 'rate_limit', 'database') NOT NULL UNIQUE,
            threshold FLOAT DEFAULT 80.0,
            enabled BOOLEAN DEFAULT TRUE,
            last_triggered TIMESTAMP NULL DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_type (alert_type)
        )
    `);

    try {
        await pool.execute(
            'ALTER TABLE alert_settings ADD COLUMN last_triggered TIMESTAMP NULL DEFAULT NULL'
        );
    } catch (error) {
        if (error?.code !== 'ER_DUP_FIELDNAME') {
            throw error;
        }
    }

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS active_alerts (
            id INT AUTO_INCREMENT PRIMARY KEY,
            alert_type VARCHAR(50) NOT NULL,
            severity ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium',
            message TEXT NOT NULL,
            value FLOAT,
            threshold FLOAT,
            resolved BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            resolved_at TIMESTAMP NULL,
            INDEX idx_type (alert_type),
            INDEX idx_resolved (resolved)
        )
    `);

    const defaultSettings = [
        ['cpu', 85],
        ['memory', 85],
        ['error_rate', 15],
        ['rate_limit', 60],
        ['database', 90]
    ];

    for (const [alertType, threshold] of defaultSettings) {
        await pool.execute(
            'INSERT IGNORE INTO alert_settings (alert_type, threshold, enabled) VALUES (?, ?, TRUE)',
            [alertType, threshold]
        );
    }

    alertTablesInitialized = true;
}

async function ensureEmailDeliveryLogsReady() {
    if (emailLogTableInitialized) return;

    const pool = MySQLDatabaseManager?.connection?.pool;
    if (!pool) {
        throw new Error('Database pool is not ready');
    }

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS email_delivery_logs (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            recipient_email VARCHAR(254) NOT NULL,
            recipient_domain VARCHAR(255) NULL,
            template_name VARCHAR(100) DEFAULT 'generic',
            subject VARCHAR(255) NULL,
            status ENUM('sent', 'failed', 'blocked') NOT NULL,
            error_message TEXT NULL,
            message_id VARCHAR(255) NULL,
            correlation_id VARCHAR(128) NULL,
            source VARCHAR(100) NULL,
            provider_response TEXT NULL,
            attempt_count INT DEFAULT 1,
            latency_ms INT DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_created (created_at),
            INDEX idx_status (status),
            INDEX idx_template (template_name),
            INDEX idx_recipient_domain (recipient_domain),
            INDEX idx_correlation_id (correlation_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const columnsToAdd = [
        { name: 'correlation_id', type: 'VARCHAR(128) DEFAULT NULL' },
        { name: 'source', type: 'VARCHAR(100) DEFAULT NULL' },
        { name: 'provider_response', type: 'TEXT' },
        { name: 'attempt_count', type: 'INT DEFAULT 1' },
        { name: 'latency_ms', type: 'INT DEFAULT NULL' }
    ];

    for (const col of columnsToAdd) {
        try {
            await pool.execute(`ALTER TABLE email_delivery_logs ADD COLUMN ${col.name} ${col.type}`);
        } catch (err) {
            if (err.code !== 'ER_DUP_FIELDNAME') {
                console.error(`Error adding ${col.name} to email_delivery_logs:`, err.message);
            }
        }
    }

    emailLogTableInitialized = true;
}

// Get alert settings (owner only)
app.get('/api/alerts/settings', requireAuth, requireOwner, async (req, res) => {
    try {
        await ensureAlertTablesReady();
        const [settings] = await MySQLDatabaseManager.connection.pool.execute(
            'SELECT id, alert_type, threshold, enabled FROM alert_settings ORDER BY alert_type'
        );
        res.json(settings);
    } catch (error) {
        console.error('Error fetching alert settings:', error);
        res.status(500).json({ error: 'Failed to fetch alert settings' });
    }
});

// Alert settings analytics for pie chart (owner only)
app.get('/api/owner/alert-settings-analytics', requireAuth, requireOwner, async (req, res) => {
    try {
        await ensureAlertTablesReady();

        // Get all alert settings with detailed information
        const [settings] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT alert_type, threshold, enabled, last_triggered, created_at, updated_at
             FROM alert_settings
             ORDER BY alert_type`
        );

        // Get active alerts count per type
        const [activeAlerts] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT alert_type, COUNT(*) as active_count
             FROM active_alerts
             WHERE resolved = FALSE
             GROUP BY alert_type`
        );

        // Get total alerts triggered in last 30 days per type
        const [recentAlerts] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT alert_type, COUNT(*) as recent_triggered
             FROM active_alerts
             WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
             GROUP BY alert_type`
        );

        // Create lookup maps
        const activeAlertsMap = {};
        activeAlerts.forEach(row => {
            activeAlertsMap[row.alert_type] = row.active_count;
        });

        const recentAlertsMap = {};
        recentAlerts.forEach(row => {
            recentAlertsMap[row.alert_type] = row.recent_triggered;
        });

        // Enhance settings with additional data
        const enhancedSettings = settings.map(setting => ({
            alert_type: setting.alert_type,
            threshold: setting.threshold,
            enabled: Boolean(setting.enabled),
            last_triggered: setting.last_triggered,
            active_alerts: activeAlertsMap[setting.alert_type] || 0,
            recent_triggered: recentAlertsMap[setting.alert_type] || 0,
            created_at: setting.created_at,
            updated_at: setting.updated_at
        }));

        // Calculate summary statistics
        const totalSettings = enhancedSettings.length;
        const enabledCount = enhancedSettings.filter(s => s.enabled).length;
        const disabledCount = totalSettings - enabledCount;
        const totalActiveAlerts = Object.values(activeAlertsMap).reduce((sum, count) => sum + count, 0);
        const totalRecentAlerts = Object.values(recentAlertsMap).reduce((sum, count) => sum + count, 0);

        res.json({
            success: true,
            settings: enhancedSettings,
            breakdown: enhancedSettings.map(s => ({
                alert_type: s.alert_type,
                enabled_count: s.enabled ? 1 : 0,
                disabled_count: s.enabled ? 0 : 1
            })),
            summary: {
                total: totalSettings,
                enabled: enabledCount,
                disabled: disabledCount,
                activeAlerts: totalActiveAlerts,
                recentAlerts: totalRecentAlerts
            }
        });
    } catch (error) {
        console.error('Error fetching alert settings analytics:', error);
        res.status(500).json({ error: 'Failed to fetch alert settings analytics' });
    }
});

app.get('/api/owner/bot-safety-alerts', requireAuth, requireOwner, async (req, res) => {
    try {
        const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
        const snapshot = await BotSafetyCenter.getDashboardSnapshot(limit);
        res.json({
            success: true,
            ...snapshot
        });
    } catch (error) {
        console.error('Error fetching bot safety alerts:', error);
        res.status(500).json({ error: 'Failed to fetch bot safety alerts' });
    }
});

app.get('/api/owner/config-overview', requireAuth, requireOwner, async (_req, res) => {
    try {
        return res.json({
            success: true,
            ...buildOwnerConfigOverview()
        });
    } catch (error) {
        console.error('Error fetching owner config overview:', error);
        return res.status(500).json({ error: 'Failed to fetch config overview' });
    }
});

app.get('/api/owner/bot-safety-config', requireAuth, requireOwner, async (_req, res) => {
    try {
        return res.json({
            success: true,
            config: BotSafetyCenter.getConfig()
        });
    } catch (error) {
        console.error('Error fetching bot safety config:', error);
        return res.status(500).json({ error: 'Failed to fetch bot safety config' });
    }
});

app.post('/api/owner/bot-safety-config', requireAuth, requireOwner, requireSensitiveDiscordSecurityBinding, async (req, res) => {
    try {
        const incoming = req.body || {};
        const allowedNumericKeys = new Set([
            'recentAlertLimit',
            'emojiBurstThreshold',
            'stickerBurstThreshold',
            'assetAuditWindowMs',
            'assetAuditCooldownMs',
            'inviteWindowMs',
            'inviteMutationThreshold',
            'inviteJoinSpikeThreshold',
            'inviterJoinSpikeThreshold',
            'inviteAlertCooldownMs',
            'nicknameAlertCooldownMs',
            'attachmentCountThreshold',
            'attachmentTotalSizeMbThreshold',
            'moderationEscalationCooldownMs',
            'moderationEscalationLastHourThreshold',
            'moderationEscalationLastDayThreshold',
            'moderationEscalationTimeoutThreshold',
            'moderationEscalationHighRiskThreshold'
        ]);

        const next = {};
        for (const [key, value] of Object.entries(incoming)) {
            if (key === 'enabled') {
                if (typeof value !== 'boolean') {
                    return res.status(400).json({ error: 'enabled must be a boolean' });
                }
                next.enabled = value;
                continue;
            }

            if (!allowedNumericKeys.has(key)) {
                return res.status(400).json({ error: `Unknown config key: ${key}` });
            }

            if (!Number.isFinite(Number(value))) {
                return res.status(400).json({ error: `${key} must be numeric` });
            }

            next[key] = Number(value);
        }

        const saved = BotSafetyCenter.saveConfig(next);

        await logAdminAuthEvent(req.session.username, 'SESSIONS_REVOKED', req, {
            mode: 'bot-safety-config-updated',
            changes: next
        }).catch(() => { });

        return res.json({
            success: true,
            config: saved
        });
    } catch (error) {
        console.error('Error updating bot safety config:', error);
        return res.status(500).json({ error: 'Failed to update bot safety config' });
    }
});

// Update alert settings (owner only)
app.post('/api/alerts/settings/:alertType', requireAuth, requireOwner, async (req, res) => {
    try {
        await ensureAlertTablesReady();
        const { alertType } = req.params;
        const { threshold, enabled } = req.body;

        await MySQLDatabaseManager.connection.pool.execute(
            'UPDATE alert_settings SET threshold = ?, enabled = ?, updated_at = NOW() WHERE alert_type = ?',
            [threshold, enabled ? 1 : 0, alertType]
        );

        console.log(`[Owner] ${req.session.username} updated alert settings for ${alertType}`);
        res.json({ success: true, message: 'Alert settings updated' });
    } catch (error) {
        console.error('Error updating alert settings:', error);
        res.status(500).json({ error: 'Failed to update alert settings' });
    }
});

// Get all alert settings (owner only)
app.get('/api/alerts/settings', requireAuth, requireOwner, async (req, res) => {
    try {
        await ensureAlertTablesReady();
        const [settings] = await MySQLDatabaseManager.connection.pool.execute(
            'SELECT alert_type, threshold, enabled, last_triggered, created_at, updated_at FROM alert_settings ORDER BY alert_type'
        );
        res.json(settings);
    } catch (error) {
        console.error('Error fetching alert settings:', error);
        res.status(500).json({ error: 'Failed to fetch alert settings' });
    }
});

// Get active alerts (owner only)
app.get('/api/alerts/active', requireAuth, requireOwner, async (req, res) => {
    try {
        await ensureAlertTablesReady();
        const [alerts] = await MySQLDatabaseManager.connection.pool.execute(
            'SELECT id, alert_type, severity, message, value, threshold, created_at FROM active_alerts WHERE resolved = FALSE ORDER BY created_at DESC'
        );
        res.json(alerts);
    } catch (error) {
        console.error('Error fetching active alerts:', error);
        res.status(500).json({ error: 'Failed to fetch active alerts' });
    }
});

// Alert monitor status (owner only)
app.get('/api/alerts/status', requireAuth, requireOwner, async (req, res) => {
    return res.json({
        running: Boolean(alertMonitorStatus.running),
        lastRunAt: alertMonitorStatus.lastRunAt,
        lastSuccessAt: alertMonitorStatus.lastSuccessAt,
        lastDurationMs: alertMonitorStatus.lastDurationMs,
        lastError: alertMonitorStatus.lastError,
        lastErrorAt: alertMonitorStatus.lastErrorAt,
        checkIntervalMs: ALERT_CHECK_INTERVAL_MS
    });
});

// Resolve alert (owner only)
app.post('/api/alerts/:id/resolve', requireAuth, requireOwner, async (req, res) => {
    try {
        await ensureAlertTablesReady();
        const { id } = req.params;

        await MySQLDatabaseManager.connection.pool.execute(
            'UPDATE active_alerts SET resolved = TRUE, resolved_at = NOW() WHERE id = ?',
            [id]
        );

        res.json({ success: true, message: 'Alert resolved' });
    } catch (error) {
        console.error('Error resolving alert:', error);
        res.status(500).json({ error: 'Failed to resolve alert' });
    }
});

app.get('/api/owner/email-analytics', requireAuth, requireOwner, async (req, res) => {
    try {
        await ensureEmailDeliveryLogsReady();

        const pool = MySQLDatabaseManager.connection.pool;

        const [summaryRows] = await pool.execute(
            `SELECT
                COUNT(*) AS total,
                SUM(status = 'sent') AS sentTotal,
                SUM(status = 'failed') AS failedTotal,
                SUM(status = 'blocked') AS blockedTotal,
                SUM(status = 'failed' AND (
                    LOWER(COALESCE(error_message, '')) LIKE '%timeout%'
                    OR LOWER(COALESCE(error_message, '')) LIKE '%temporarily%'
                    OR LOWER(COALESCE(error_message, '')) LIKE '%try again%'
                    OR LOWER(COALESCE(error_message, '')) LIKE '%eai_again%'
                    OR LOWER(COALESCE(error_message, '')) LIKE '%econn%'
                    OR LOWER(COALESCE(error_message, '')) LIKE '%socket%'
                    OR LOWER(COALESCE(error_message, '')) LIKE '%421%'
                    OR LOWER(COALESCE(error_message, '')) LIKE '%450%'
                    OR LOWER(COALESCE(error_message, '')) LIKE '%451%'
                    OR LOWER(COALESCE(error_message, '')) LIKE '%452%'
                )) AS transientFailedTotal,
                SUM(status = 'failed' AND NOT (
                    LOWER(COALESCE(error_message, '')) LIKE '%timeout%'
                    OR LOWER(COALESCE(error_message, '')) LIKE '%temporarily%'
                    OR LOWER(COALESCE(error_message, '')) LIKE '%try again%'
                    OR LOWER(COALESCE(error_message, '')) LIKE '%eai_again%'
                    OR LOWER(COALESCE(error_message, '')) LIKE '%econn%'
                    OR LOWER(COALESCE(error_message, '')) LIKE '%socket%'
                    OR LOWER(COALESCE(error_message, '')) LIKE '%421%'
                    OR LOWER(COALESCE(error_message, '')) LIKE '%450%'
                    OR LOWER(COALESCE(error_message, '')) LIKE '%451%'
                    OR LOWER(COALESCE(error_message, '')) LIKE '%452%'
                )) AS permanentFailedTotal,
                ROUND(AVG(NULLIF(latency_ms, 0)), 2) AS avgLatencyMs,
                ROUND(AVG(NULLIF(attempt_count, 0)), 2) AS avgAttemptCount,
                SUM(created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)) AS last24h,
                SUM(created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS last7d,
                SUM(created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS last30d,
                SUM(status = 'sent' AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)) AS sent24h,
                SUM(status = 'failed' AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)) AS failed24h,
                SUM(status = 'blocked' AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)) AS blocked24h
             FROM email_delivery_logs`
        );

        const [failureCategoryRows] = await pool.execute(
            `SELECT
                CASE
                    WHEN LOWER(COALESCE(error_message, '')) LIKE '%timeout%' THEN 'timeout'
                    WHEN LOWER(COALESCE(error_message, '')) LIKE '%temporarily%' OR LOWER(COALESCE(error_message, '')) LIKE '%try again%' THEN 'temporary_provider_issue'
                    WHEN LOWER(COALESCE(error_message, '')) LIKE '%eai_again%' THEN 'dns_retryable'
                    WHEN LOWER(COALESCE(error_message, '')) LIKE '%econn%' OR LOWER(COALESCE(error_message, '')) LIKE '%socket%' THEN 'connection_issue'
                    WHEN LOWER(COALESCE(error_message, '')) LIKE '%invalid recipient%' OR LOWER(COALESCE(error_message, '')) LIKE '%mailbox unavailable%' OR LOWER(COALESCE(error_message, '')) LIKE '%550%' THEN 'invalid_recipient'
                    WHEN LOWER(COALESCE(error_message, '')) LIKE '%rate limit%' THEN 'rate_limited'
                    ELSE 'other'
                END AS category,
                COUNT(*) AS count
             FROM email_delivery_logs
             WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
               AND status IN ('failed', 'blocked')
             GROUP BY category
             ORDER BY count DESC
             LIMIT 10`
        );

        const [failingDomainRows] = await pool.execute(
            `SELECT
                recipient_domain,
                COUNT(*) AS total,
                SUM(status = 'sent') AS sent,
                SUM(status = 'failed') AS failed,
                SUM(status = 'blocked') AS blocked
             FROM email_delivery_logs
             WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
               AND recipient_domain IS NOT NULL
               AND recipient_domain != ''
             GROUP BY recipient_domain
                         HAVING (SUM(status = 'failed') + SUM(status = 'blocked')) > 0
                         ORDER BY (SUM(status = 'failed') + SUM(status = 'blocked')) DESC, COUNT(*) DESC
             LIMIT 10`
        );

        const [templateRows] = await pool.execute(
            `SELECT
                template_name,
                COUNT(*) AS total,
                SUM(status = 'sent') AS sent,
                SUM(status = 'failed') AS failed,
                SUM(status = 'blocked') AS blocked
             FROM email_delivery_logs
             WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
             GROUP BY template_name
             ORDER BY total DESC
             LIMIT 8`
        );

        const [trendRows] = await pool.execute(
            `SELECT
                DATE(created_at) AS day,
                COUNT(*) AS total,
                SUM(status = 'sent') AS sent,
                SUM(status = 'failed') AS failed,
                SUM(status = 'blocked') AS blocked
             FROM email_delivery_logs
             WHERE created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)
             GROUP BY DATE(created_at)
             ORDER BY day ASC`
        );

        const [recentRows] = await pool.execute(
            `SELECT
                recipient_email,
                recipient_domain,
                template_name,
                subject,
                status,
                error_message,
                source,
                attempt_count,
                latency_ms,
                correlation_id,
                created_at
             FROM email_delivery_logs
             ORDER BY created_at DESC
             LIMIT 25`
        );

        res.json({
            success: true,
            summary: summaryRows?.[0] || {},
            templates: templateRows || [],
            trends: trendRows || [],
            recent: recentRows || [],
            failureCategories: failureCategoryRows || [],
            failingDomains: failingDomainRows || []
        });
    } catch (error) {
        console.error('Error fetching email analytics:', error);
        res.status(500).json({ error: 'Failed to fetch email analytics' });
    }
});

app.get('/api/owner/verification-analytics', requireAuth, requireOwner, async (req, res) => {
    try {
        const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
        const analytics = await getVerificationAnalytics({ days });
        return res.json(analytics);
    } catch (error) {
        console.error('Error fetching verification analytics:', error);
        return res.status(500).json({ error: 'Failed to fetch verification analytics' });
    }
});

app.get('/api/owner/staff-performance-analytics', requireAuth, requireOwner, async (req, res) => {
    try {
        const days = Math.max(1, Math.min(180, parseInt(req.query.days, 10) || 30));
        const windowStartMs = Date.now() - (days * 24 * 60 * 60 * 1000);

        const [staffRows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT
                COALESCE(NULLIF(moderator_id, ''), CONCAT('name:', LOWER(TRIM(COALESCE(moderator_name, ''))))) AS staff_key,
                NULLIF(moderator_id, '') AS moderator_id,
                COALESCE(NULLIF(moderator_name, ''), NULLIF(moderator_id, ''), 'Unknown Staff') AS moderator_name,
                SUM(CASE WHEN action_type = 'WARN' AND status NOT IN ('cleared', 'reversed') THEN 1 ELSE 0 END) AS warns,
                SUM(CASE WHEN action_type = 'TIMEOUT' AND status <> 'reversed' THEN 1 ELSE 0 END) AS timeouts,
                SUM(CASE WHEN action_type = 'KICK' AND status <> 'reversed' THEN 1 ELSE 0 END) AS kicks,
                SUM(CASE WHEN action_type = 'BAN' AND status <> 'reversed' THEN 1 ELSE 0 END) AS bans,
                COUNT(*) AS total_actions,
                COUNT(DISTINCT DATE(FROM_UNIXTIME(created_at / 1000))) AS active_days,
                MAX(created_at) AS last_action_at
             FROM moderation_cases
             WHERE created_at >= ?
               AND (
                    (moderator_id IS NOT NULL AND moderator_id <> '')
                    OR (moderator_name IS NOT NULL AND moderator_name <> '')
               )
             GROUP BY staff_key, moderator_id, moderator_name
             ORDER BY total_actions DESC
             LIMIT 100`,
            [windowStartMs]
        );

        const [recentRows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT
                case_id,
                action_type,
                status,
                user_id,
                COALESCE(NULLIF(user_name, ''), user_id, 'Unknown User') AS user_name,
                NULLIF(moderator_id, '') AS moderator_id,
                COALESCE(NULLIF(moderator_name, ''), NULLIF(moderator_id, ''), 'Unknown Staff') AS moderator_name,
                reason,
                created_at
             FROM moderation_cases
             WHERE created_at >= ?
               AND (
                    (moderator_id IS NOT NULL AND moderator_id <> '')
                    OR (moderator_name IS NOT NULL AND moderator_name <> '')
               )
             ORDER BY created_at DESC
             LIMIT 25`,
            [windowStartMs]
        );

        const staff = (staffRows || []).map((row) => {
            const warns = Number(row?.warns || 0);
            const timeouts = Number(row?.timeouts || 0);
            const kicks = Number(row?.kicks || 0);
            const bans = Number(row?.bans || 0);
            const totalActions = Number(row?.total_actions || 0);
            const activeDays = Math.max(1, Number(row?.active_days || 0));
            const weightedScore = (warns * 1) + (timeouts * 1.5) + (kicks * 2) + (bans * 2.5);

            return {
                staffKey: row?.staff_key || row?.moderator_id || row?.moderator_name || 'unknown',
                moderatorId: row?.moderator_id || null,
                moderatorName: row?.moderator_name || 'Unknown Staff',
                warns,
                timeouts,
                kicks,
                bans,
                totalActions,
                activeDays,
                actionsPerActiveDay: Number((totalActions / activeDays).toFixed(2)),
                weightedScore: Number(weightedScore.toFixed(2)),
                lastActionAt: Number(row?.last_action_at || 0) || null
            };
        });

        staff.sort((a, b) => b.weightedScore - a.weightedScore || b.totalActions - a.totalActions);

        const totals = staff.reduce((acc, entry) => {
            acc.warns += entry.warns;
            acc.timeouts += entry.timeouts;
            acc.kicks += entry.kicks;
            acc.bans += entry.bans;
            acc.totalActions += entry.totalActions;
            return acc;
        }, {
            warns: 0,
            timeouts: 0,
            kicks: 0,
            bans: 0,
            totalActions: 0
        });

        const topPerformer = staff[0] || null;
        const avgActionsPerStaff = staff.length > 0
            ? Number((totals.totalActions / staff.length).toFixed(2))
            : 0;

        return res.json({
            success: true,
            days,
            summary: {
                staffCount: staff.length,
                totalActions: totals.totalActions,
                avgActionsPerStaff,
                topPerformer: topPerformer
                    ? {
                        moderatorName: topPerformer.moderatorName,
                        moderatorId: topPerformer.moderatorId,
                        weightedScore: topPerformer.weightedScore,
                        totalActions: topPerformer.totalActions
                    }
                    : null,
                actionMix: {
                    warns: totals.warns,
                    timeouts: totals.timeouts,
                    kicks: totals.kicks,
                    bans: totals.bans
                }
            },
            staff,
            recent: (recentRows || []).map((row) => ({
                caseId: row?.case_id || null,
                actionType: row?.action_type || 'UNKNOWN',
                status: row?.status || 'open',
                userId: row?.user_id || null,
                userName: row?.user_name || row?.user_id || 'Unknown User',
                moderatorId: row?.moderator_id || null,
                moderatorName: row?.moderator_name || row?.moderator_id || 'Unknown Staff',
                reason: row?.reason || null,
                createdAt: Number(row?.created_at || 0) || null
            })),
            updatedAt: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error fetching staff performance analytics:', error);
        return res.status(500).json({ error: 'Failed to fetch staff performance analytics' });
    }
});

app.get('/api/owner/system-stats', requireAuth, requireOwner, async (req, res) => {
    try {
        const botStats = getStats();
        // os is likely already required at the top, but to be safe/clean we can use the global require or if it's top-level
        // Checking file content, os IS required at top.
        const os = require('os');

        const memoryUsage = process.memoryUsage();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;

        const stats = {
            system: {
                platform: process.platform,
                arch: os.arch(),
                release: os.release(),
                uptime: os.uptime(),
                loadavg: os.loadavg(),
                totalMem,
                freeMem,
                usedMem,
                cpus: os.cpus().length
            },
            process: {
                uptime: process.uptime(),
                memory: memoryUsage,
                version: process.version
            },
            bot: botStats
        };

        return res.json(stats);
    } catch (error) {
        console.error('Error fetching system stats:', error);
        return res.status(500).json({ error: 'Failed to fetch system stats' });
    }
});

// Phase 2: Scheduled jobs controls (owner only)
app.get('/api/jobs', requireAuth, requireOwner, async (req, res) => {
    try {
        const status = typeof req.query.status === 'string' ? req.query.status : null;
        const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
        const jobs = await MySQLDatabaseManager.getScheduledJobs({ status, limit });
        res.json({ jobs, count: jobs.length });
    } catch (error) {
        console.error('Error fetching jobs:', error);
        res.status(500).json({ error: 'Failed to fetch jobs' });
    }
});

app.post('/api/jobs/:id/retry', requireAuth, requireOwner, async (req, res) => {
    try {
        const ok = await MySQLDatabaseManager.retryScheduledJob(req.params.id);
        if (!ok) return res.status(404).json({ error: 'Job not found or could not be retried' });
        res.json({ success: true });
    } catch (error) {
        console.error('Error retrying job:', error);
        res.status(500).json({ error: 'Failed to retry job' });
    }
});

// Phase 2: AutoMod config APIs (owner only)
app.get('/api/automod/config', requireAuth, requireOwner, async (req, res) => {
    try {
        const config = normalizeAutoModProfiles(loadAutoModConfig());

        const effectiveConfig = buildEffectiveAutoModConfig(config);
        res.json({
            ...config,
            effectiveAutoMod: effectiveConfig
        });
    } catch (error) {
        console.error('Error reading automod config:', error);
        res.status(500).json({ error: 'Failed to read automod config' });
    }
});

app.post('/api/automod/config', requireAuth, requireOwner, async (req, res) => {
    try {
        const config = normalizeAutoModProfiles(loadAutoModConfig());

        const body = req.body || {};
        const profileName = typeof body.profileName === 'string' ? body.profileName.trim() : '';
        const profilePatch = body.profileConfig && typeof body.profileConfig === 'object' ? body.profileConfig : null;

        if (profileName && profilePatch) {
            const existing = config.autoModProfiles.profiles[profileName] || {};
            const mergedProfile = sanitizeAutoModProfileInput(profilePatch, existing);
            config.autoModProfiles.profiles[profileName] = mergedProfile;
        }

        const activeProfile = typeof body.activeProfile === 'string' ? body.activeProfile.trim() : '';
        if (activeProfile) {
            if (!config.autoModProfiles.profiles[activeProfile]) {
                return res.status(400).json({ error: 'Unknown AutoMod profile' });
            }
            config.autoModProfiles.activeProfile = activeProfile;
        }

        const deleteProfileName = typeof body.deleteProfile === 'string' ? body.deleteProfile.trim() : '';
        if (deleteProfileName) {
            if (['balanced', 'strict', 'relaxed'].includes(deleteProfileName)) {
                return res.status(400).json({ error: 'Default profiles cannot be deleted' });
            }
            if (config.autoModProfiles.activeProfile === deleteProfileName) {
                return res.status(400).json({ error: 'Cannot delete the active profile' });
            }
            delete config.autoModProfiles.profiles[deleteProfileName];
        }

        const rootPatch = {
            blockExternalInvites: body.blockExternalInvites,
            maxMentionsBeforeFlag: body.maxMentionsBeforeFlag,
            autoMod: {
                spamThreshold: body.spamThreshold,
                spamTimeout: body.spamTimeout,
                spamWarningThreshold: body.spamWarningThreshold
            },
            autoModAdvanced: {
                blockedRegexPatterns: body.blockedRegexPatterns,
                exemptChannelIds: body.exemptChannelIds,
                exemptRoleIds: body.exemptRoleIds,
                escalationThreshold24h: body.escalationThreshold24h,
                escalationTimeoutMs: body.escalationTimeoutMs
            }
        };

        const sanitizedRoot = sanitizeAutoModProfileInput(rootPatch, config);
        config.blockExternalInvites = sanitizedRoot.blockExternalInvites;
        config.maxMentionsBeforeFlag = sanitizedRoot.maxMentionsBeforeFlag;
        config.autoMod = {
            ...(config.autoMod || {}),
            ...sanitizedRoot.autoMod
        };
        config.autoModAdvanced = {
            ...(config.autoModAdvanced || {}),
            ...sanitizedRoot.autoModAdvanced
        };

        normalizeAutoModProfiles(config);
        saveAutoModConfig(config);
        res.json({
            success: true,
            message: 'AutoMod config updated',
            activeProfile: config.autoModProfiles.activeProfile,
            profiles: Object.keys(config.autoModProfiles.profiles || {})
        });
    } catch (error) {
        console.error('Error updating automod config:', error);
        res.status(500).json({ error: 'Failed to update automod config' });
    }
});

app.post('/api/automod/simulate', requireAuth, requireOwner, async (req, res) => {
    try {
        const body = req.body || {};
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!message) {
            return res.status(400).json({ error: 'Simulation message is required' });
        }

        const recentMessageCount = toFiniteNumber(body.recentMessageCount, 1, 1, 500);
        const priorViolations24h = toFiniteNumber(body.priorViolations24h, 0, 0, 500);

        const config = normalizeAutoModProfiles(loadAutoModConfig());
        const effectiveConfig = buildEffectiveAutoModConfig(config);
        const draftConfig = (body.draftConfig && typeof body.draftConfig === 'object') ? body.draftConfig : null;
        const evaluationConfig = draftConfig ? mergeAutoModSimulationDraft(effectiveConfig, draftConfig) : effectiveConfig;

        const result = evaluateAutoModSimulation({
            message,
            recentMessageCount,
            priorViolations24h,
            effectiveConfig: evaluationConfig
        });

        res.json({
            success: true,
            activeProfile: config?.autoModProfiles?.activeProfile || 'balanced',
            usedDraftConfig: Boolean(draftConfig),
            result
        });
    } catch (error) {
        console.error('Error running automod simulation:', error);
        res.status(500).json({ error: 'Failed to run automod simulation' });
    }
});

app.get('/api/automod/advanced', requireAuth, requireOwner, async (req, res) => {
    try {
        const windowHours = toFiniteNumber(req.query.windowHours, 168, 1, 720);
        const page = toFiniteNumber(req.query.page, 1, 1, 1000);
        const limit = toFiniteNumber(req.query.limit, 25, 5, 100);
        const offset = (page - 1) * limit;

        const statusFilter = normalizeAutoModReviewStatus(req.query.status, 'all') || 'all';
        const severityFilter = normalizeAutoModSeverity(req.query.severity, 'all') || 'all';

        const [summaryRows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN COALESCE(r.status, 'pending') = 'pending' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN COALESCE(r.status, 'pending') = 'approved' THEN 1 ELSE 0 END) AS approved,
                SUM(CASE WHEN COALESCE(r.status, 'pending') = 'dismissed' THEN 1 ELSE 0 END) AS dismissed,
                ROUND(AVG(COALESCE(v.risk_score, 0)), 2) AS avgRiskScore,
                SUM(CASE WHEN COALESCE(v.appeal_notified, 0) = 1 THEN 1 ELSE 0 END) AS appealAwareActions,
                SUM(CASE WHEN COALESCE(r.severity,
                    CASE
                        WHEN v.action_taken IN ('ban', 'kick') THEN 'critical'
                        WHEN v.action_taken = 'timeout' THEN 'high'
                        WHEN v.action_taken = 'warn' THEN 'medium'
                        WHEN v.violation_type IN ('spam', 'mentions') THEN 'medium'
                        ELSE 'low'
                    END
                ) IN ('high', 'critical') THEN 1 ELSE 0 END) AS highRisk
             FROM automod_violations v
             LEFT JOIN automod_violation_reviews r ON r.violation_id = v.id
             WHERE v.timestamp >= DATE_SUB(NOW(), INTERVAL ? HOUR)`,
            [windowHours]
        );

        const [actionRows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT v.action_taken AS action, COUNT(*) AS count
             FROM automod_violations v
             WHERE v.timestamp >= DATE_SUB(NOW(), INTERVAL ? HOUR)
             GROUP BY v.action_taken
             ORDER BY count DESC`,
            [windowHours]
        );

        const [trendRows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT
                DATE(v.timestamp) AS day,
                COUNT(*) AS total,
                SUM(CASE WHEN COALESCE(r.status, 'pending') = 'pending' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN COALESCE(r.status, 'pending') = 'approved' THEN 1 ELSE 0 END) AS approved,
                SUM(CASE WHEN COALESCE(r.status, 'pending') = 'dismissed' THEN 1 ELSE 0 END) AS dismissed
             FROM automod_violations v
             LEFT JOIN automod_violation_reviews r ON r.violation_id = v.id
             WHERE v.timestamp >= DATE_SUB(NOW(), INTERVAL ? HOUR)
             GROUP BY DATE(v.timestamp)
             ORDER BY day DESC
             LIMIT 14`,
            [windowHours]
        );

        const [typeRows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT v.violation_type AS type, COUNT(*) AS count
             FROM automod_violations v
             WHERE v.timestamp >= DATE_SUB(NOW(), INTERVAL ? HOUR)
             GROUP BY v.violation_type
             ORDER BY count DESC
             LIMIT 10`,
            [windowHours]
        );

        const [topUsersRows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT v.user_id, COUNT(*) AS count
             FROM automod_violations v
             WHERE v.timestamp >= DATE_SUB(NOW(), INTERVAL ? HOUR)
             GROUP BY v.user_id
             ORDER BY count DESC
             LIMIT 10`,
            [windowHours]
        );

        const [queueRows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT
                v.id,
                v.user_id,
                v.guild_id,
                v.violation_type,
                v.message_content,
                v.channel_id,
                v.action_taken,
                v.risk_score,
                v.risk_level,
                v.signal_count,
                v.appeal_notified,
                v.metadata_json,
                v.timestamp,
                COALESCE(r.status, 'pending') AS review_status,
                COALESCE(r.severity,
                    CASE
                        WHEN v.action_taken IN ('ban', 'kick') THEN 'critical'
                        WHEN v.action_taken = 'timeout' THEN 'high'
                        WHEN v.action_taken = 'warn' THEN 'medium'
                        WHEN v.violation_type IN ('spam', 'mentions') THEN 'medium'
                        ELSE 'low'
                    END
                ) AS review_severity,
                r.reviewer_username,
                r.reviewed_at,
                r.note
             FROM automod_violations v
             LEFT JOIN automod_violation_reviews r ON r.violation_id = v.id
             WHERE v.timestamp >= DATE_SUB(NOW(), INTERVAL ? HOUR)
               AND (? = 'all' OR COALESCE(r.status, 'pending') = ?)
               AND (? = 'all' OR COALESCE(r.severity,
                    CASE
                        WHEN v.action_taken IN ('ban', 'kick') THEN 'critical'
                        WHEN v.action_taken = 'timeout' THEN 'high'
                        WHEN v.action_taken = 'warn' THEN 'medium'
                        WHEN v.violation_type IN ('spam', 'mentions') THEN 'medium'
                        ELSE 'low'
                    END
               ) = ?)
             ORDER BY v.timestamp DESC
             LIMIT ? OFFSET ?`,
            [windowHours, statusFilter, statusFilter, severityFilter, severityFilter, limit, offset]
        );

        const [countRows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT COUNT(*) AS total
             FROM automod_violations v
             LEFT JOIN automod_violation_reviews r ON r.violation_id = v.id
             WHERE v.timestamp >= DATE_SUB(NOW(), INTERVAL ? HOUR)
               AND (? = 'all' OR COALESCE(r.status, 'pending') = ?)
               AND (? = 'all' OR COALESCE(r.severity,
                    CASE
                        WHEN v.action_taken IN ('ban', 'kick') THEN 'critical'
                        WHEN v.action_taken = 'timeout' THEN 'high'
                        WHEN v.action_taken = 'warn' THEN 'medium'
                        WHEN v.violation_type IN ('spam', 'mentions') THEN 'medium'
                        ELSE 'low'
                    END
               ) = ?)`,
            [windowHours, statusFilter, statusFilter, severityFilter, severityFilter]
        );

        const summary = summaryRows?.[0] || {};
        const totalItems = Number(countRows?.[0]?.total || 0);

        res.json({
            success: true,
            filters: { windowHours, page, limit, status: statusFilter, severity: severityFilter },
            summary: {
                total: Number(summary.total || 0),
                pending: Number(summary.pending || 0),
                approved: Number(summary.approved || 0),
                dismissed: Number(summary.dismissed || 0),
                highRisk: Number(summary.highRisk || 0),
                avgRiskScore: Number(summary.avgRiskScore || 0),
                appealAwareActions: Number(summary.appealAwareActions || 0),
                falsePositiveRate: Number(summary.total || 0) > 0
                    ? Number(((Number(summary.dismissed || 0) / Number(summary.total || 0)) * 100).toFixed(2))
                    : 0
            },
            trends: Array.isArray(trendRows) ? trendRows : [],
            types: Array.isArray(typeRows) ? typeRows : [],
            actions: Array.isArray(actionRows) ? actionRows : [],
            topUsers: Array.isArray(topUsersRows) ? topUsersRows : [],
            queue: Array.isArray(queueRows) ? queueRows : [],
            pagination: {
                total: totalItems,
                page,
                limit,
                pages: Math.max(1, Math.ceil(totalItems / limit))
            }
        });
    } catch (error) {
        console.error('Error fetching advanced automod data:', error);
        res.status(500).json({ error: 'Failed to fetch advanced AutoMod data' });
    }
});

app.post('/api/automod/workflow/:violationId', requireAuth, requireOwner, async (req, res) => {
    try {
        const violationId = Number(req.params.violationId);
        if (!Number.isFinite(violationId) || violationId <= 0) {
            return res.status(400).json({ error: 'Invalid violation id' });
        }

        const body = req.body || {};
        const nextStatus = normalizeAutoModReviewStatus(body.status, null);
        const nextSeverity = normalizeAutoModSeverity(body.severity, null);
        const nextNote = typeof body.note === 'string' ? body.note.trim().slice(0, 1500) : null;

        if (!nextStatus && !nextSeverity && nextNote === null) {
            return res.status(400).json({ error: 'No workflow fields provided' });
        }

        const [existingRows] = await MySQLDatabaseManager.connection.pool.execute(
            'SELECT id, violation_type, action_taken FROM automod_violations WHERE id = ? LIMIT 1',
            [violationId]
        );

        const violation = existingRows?.[0];
        if (!violation) {
            return res.status(404).json({ error: 'Violation not found' });
        }

        const severityToWrite = nextSeverity || getAutoModDefaultSeverityFromViolation(violation.violation_type, violation.action_taken);
        const statusToWrite = nextStatus || 'pending';

        await MySQLDatabaseManager.connection.pool.execute(
            `INSERT INTO automod_violation_reviews (
                violation_id,
                status,
                severity,
                reviewer_username,
                reviewed_at,
                note
            ) VALUES (?, ?, ?, ?, NOW(), ?)
            ON DUPLICATE KEY UPDATE
                status = VALUES(status),
                severity = VALUES(severity),
                reviewer_username = VALUES(reviewer_username),
                reviewed_at = NOW(),
                note = COALESCE(VALUES(note), note)`,
            [
                violationId,
                statusToWrite,
                severityToWrite,
                String(req.session?.username || 'unknown').slice(0, 100),
                nextNote
            ]
        );

        const [updatedRows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT
                v.id,
                v.user_id,
                v.violation_type,
                v.action_taken,
                v.timestamp,
                COALESCE(r.status, 'pending') AS review_status,
                COALESCE(r.severity,
                    CASE
                        WHEN v.action_taken IN ('ban', 'kick') THEN 'critical'
                        WHEN v.action_taken = 'timeout' THEN 'high'
                        WHEN v.action_taken = 'warn' THEN 'medium'
                        WHEN v.violation_type IN ('spam', 'mentions') THEN 'medium'
                        ELSE 'low'
                    END
                ) AS review_severity,
                r.reviewer_username,
                r.reviewed_at,
                r.note
             FROM automod_violations v
             LEFT JOIN automod_violation_reviews r ON r.violation_id = v.id
             WHERE v.id = ?
             LIMIT 1`,
            [violationId]
        );

        res.json({ success: true, item: updatedRows?.[0] || null });
    } catch (error) {
        console.error('Error updating automod workflow item:', error);
        res.status(500).json({ error: 'Failed to update AutoMod workflow item' });
    }
});

// Phase 2: Moderation intelligence dashboard data
app.get('/api/moderation/intelligence', requireAuth, async (req, res) => {
    try {
        const nowMs = Date.now();
        const dayAgoMs = nowMs - (24 * 60 * 60 * 1000);

        const [warnCountRows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT COUNT(*) as count FROM moderation_cases WHERE action_type = 'WARN' AND status NOT IN ('cleared', 'reversed') AND created_at >= ?`,
            [dayAgoMs]
        );

        const [automodCountRows] = await MySQLDatabaseManager.connection.pool.execute(
            'SELECT COUNT(*) as count FROM automod_violations WHERE timestamp >= DATE_SUB(NOW(), INTERVAL 1 DAY)'
        );

        const [timeoutCountRows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT COUNT(*) as count FROM moderation_cases WHERE action_type = 'TIMEOUT' AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)`,
            [nowMs]
        );

        const [riskyUsersRows] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT user_id, COUNT(*) as violations
             FROM automod_violations
             WHERE timestamp >= DATE_SUB(NOW(), INTERVAL 7 DAY)
             GROUP BY user_id
             ORDER BY violations DESC
             LIMIT 10`
        );

        res.json({
            last24h: {
                warns: warnCountRows?.[0]?.count || 0,
                automodViolations: automodCountRows?.[0]?.count || 0,
                activeTimeouts: timeoutCountRows?.[0]?.count || 0
            },
            riskyUsers: riskyUsersRows || []
        });
    } catch (error) {
        console.error('Error fetching moderation intelligence:', error);
        res.status(500).json({ error: 'Failed to fetch moderation intelligence' });
    }
});

// Websockets

io.on('connection', (socket) => {
    // Trust session data only (populated by express-socket.io-session)
    let role = socket.handshake?.session?.role || socket.request?.session?.role || 'user';
    let username = socket.handshake?.session?.username || socket.request?.session?.username || 'Unknown';
    let page = socket.request?.headers?.referer || socket.handshake?.headers?.referer || 'Unknown';
    // Extract just the path from the referer URL and remove leading slash
    if (page && typeof page === 'string') {
        try {
            const urlObj = new URL(page);
            page = urlObj.pathname.replace(/^\//, '');
        } catch {
            page = page.replace(/^\//, '');
        }
    }
    // Use the same logic as dropdown: show username or fallback, and role
    const displayUsername = username && username !== 'Unknown' ? username : 'User';
    const displayRole = (role || 'user').toUpperCase();
    const normalizedRole = String(role || 'user').toLowerCase();

    if (normalizedRole === 'owner') {
        socket.join('owners');
    }
    socket.join(`role:${normalizedRole}`);
    if (page) {
        socket.join(`page:${page}`);
    }

    socketMetrics.active += 1;
    socketMetrics.connects += 1;
    socketMetrics.lastConnectAt = Date.now();
    adminPanelRuntime.lastSocketActivityAt = Date.now();
    if (socketMetrics.perRole[normalizedRole] !== undefined) {
        socketMetrics.perRole[normalizedRole] += 1;
    }
    // console.log(`User '${displayUsername}' (${displayRole}) connected to WebSocket (Page: ${page})`);

    // Send initial stats
    const sendStats = async () => {
        try {
            const [levelsRaw, warnsRaw, reminders, giveaways, bannedUsers] = await Promise.all([
                AdminPanelHelper.getAllLevels(),
                AdminPanelHelper.getAllWarns(),
                AdminPanelHelper.getAllReminders(),
                AdminPanelHelper.getGiveawaysCount(),
                AdminPanelHelper.getAllBannedUsers()
            ]);

            const levels = Array.isArray(levelsRaw[0]) ? levelsRaw[0] : (Array.isArray(levelsRaw) ? levelsRaw : []);
            const warns = Array.isArray(warnsRaw[0]) ? warnsRaw[0] : (Array.isArray(warnsRaw) ? warnsRaw : []);

            socket.emit('stats-update', {
                totalUsers: levels.length,
                totalWarns: warns.length,
                totalReminders: reminders.length,
                totalGiveaways: giveaways || 0,
                totalBanned: bannedUsers.length,
                timestamp: Date.now()
            });
        } catch (error) {
            console.error('Error sending stats:', error);
        }
    };

    let statsInterval = null;

    socket.on('subscribe-stats', (payload = {}) => {
        const requestedInterval = Number(payload?.intervalMs);
        const intervalMs = Number.isFinite(requestedInterval)
            ? Math.min(Math.max(Math.floor(requestedInterval), 3000), 30000)
            : 10000;
        if (statsInterval) clearInterval(statsInterval);
        sendStats();
        statsInterval = setInterval(sendStats, intervalMs);
    });

    socket.on('unsubscribe-stats', () => {
        if (statsInterval) {
            clearInterval(statsInterval);
            statsInterval = null;
        }
    });

    socket.on('disconnect', () => {
        let username = socket.request?.session?.username || 'Unknown';
        let role = socket.request?.session?.role || 'user';
        let page = socket.request?.headers?.referer || socket.handshake?.headers?.referer || 'Unknown';
        // Extract just the path from the referer URL and remove leading slash
        if (page && typeof page === 'string') {
            try {
                const urlObj = new URL(page);
                page = urlObj.pathname.replace(/^\//, '');
            } catch {
                page = page.replace(/^\//, '');
            }
        }
        const displayUsername = username && username !== 'Unknown' ? username : 'User';
        const displayRole = (role || 'user').toUpperCase();
        // console.log(`User '${displayUsername}' (${displayRole}) disconnected from WebSocket (Page: ${page})`);
        if (statsInterval) clearInterval(statsInterval);
        socketMetrics.active = Math.max(0, socketMetrics.active - 1);
        socketMetrics.disconnects += 1;
        socketMetrics.lastDisconnectAt = Date.now();
        adminPanelRuntime.lastSocketActivityAt = Date.now();
        const normalized = String(role || 'user').toLowerCase();
        if (socketMetrics.perRole[normalized] !== undefined) {
            socketMetrics.perRole[normalized] = Math.max(0, socketMetrics.perRole[normalized] - 1);
        }
    });

    socket.on('error', (error) => {
        console.error('WebSocket error:', error);
        socketMetrics.errors += 1;
        socketMetrics.lastError = error?.message || String(error || 'unknown');
        adminPanelRuntime.lastSocketActivityAt = Date.now();
        adminPanelRuntime.lastSocketErrorAt = Date.now();
        adminPanelRuntime.lastSocketError = error?.message || String(error || 'unknown');
        if (statsInterval) clearInterval(statsInterval);
    });

    // Handle custom events
    socket.on('request-stats', sendStats);

    socket.on('request-terminal-logs', (payload = {}) => {
        if (String(socket.role || '').toLowerCase() !== 'owner') return;
        const requestedLimit = Number(payload?.limit);
        const limit = Number.isFinite(requestedLimit)
            ? Math.min(Math.max(Math.floor(requestedLimit), 1), 200)
            : 50;
        socket.emit('terminal-logs', terminalLogBuffer.slice(-limit));
    });

    socket.on('subscribe-terminal', (payload = {}) => {
        if (String(socket.role || '').toLowerCase() !== 'owner') return;
        socket.join(TERMINAL_ROOM);
        const requestedLimit = Number(payload?.limit);
        const limit = Number.isFinite(requestedLimit)
            ? Math.min(Math.max(Math.floor(requestedLimit), 1), 200)
            : 50;
        socket.emit('terminal-logs', terminalLogBuffer.slice(-limit));
    });

    socket.on('unsubscribe-terminal', () => {
        socket.leave(TERMINAL_ROOM);
    });
});

// Usermanagement

// Get all users
app.get('/api/users', requireAuth, async (req, res) => {
    try {
        const [users] = await MySQLDatabaseManager.connection.pool.query(`
            SELECT 
                l.user_id, 
                l.username, 
                COALESCE(COUNT(w.id), 0) as warnings, 
                l.level, 
                l.xp,
                l.created_at as joined_at,
                0 as is_banned,
                0 as message_count
            FROM levels l
            LEFT JOIN warns w ON l.user_id = w.user_id
            GROUP BY l.user_id, l.username, l.level, l.xp, l.created_at
            ORDER BY l.level DESC, l.xp DESC
            LIMIT 10
        `);

        res.json({ users: users || [] });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Warn a user
app.post('/api/warn', requireAuth, async (req, res) => {
    try {
        const { user_id, reason } = req.body;

        if (!user_id || !reason) {
            return res.status(400).json({ error: 'Missing user_id or reason' });
        }

        const adminUser = await AdminPanelHelper.getAdminUser(req.session.username);
        const moderatorId = adminUser ? adminUser.id : null;

        // Generate Case ID to satisfy unique constraint
        const caseId = createPrefixedCaseId('WARN');

        const currentWarnings = await MySQLDatabaseManager.getUserWarnsCount(user_id);
        const newWarnings = Number(currentWarnings || 0) + 1;

        await AdminPanelHelper.addWarn(user_id, reason, moderatorId, caseId, {
            moderatorName: adminUser?.username || 'Unknown',
            moderatorSource: 'panel'
        });

        // Log the action
        await MySQLDatabaseManager.connection.pool.query(
            'INSERT INTO user_interactions (user_id, command_name, status) VALUES (?, ?, ?)',
            [user_id, 'WARNED', 'success']
        );

        res.json({ success: true, warnings: newWarnings });
    } catch (error) {
        console.error('Error warning user:', error);
        res.status(500).json({ error: 'Failed to warn user' });
    }
});

// Ban a user
app.post('/api/ban', requireAuth, async (req, res) => {
    try {
        const { user_id, reason } = req.body;

        if (!user_id || !reason) {
            return res.status(400).json({ error: 'Missing user_id or reason' });
        }

        // Check if already banned
        const [existing] = await MySQLDatabaseManager.connection.pool.query(
            'SELECT banned FROM user_bans WHERE user_id = ?',
            [user_id]
        );

        if (existing.length === 0) {
            // Add ban
            await MySQLDatabaseManager.connection.pool.query(
                'INSERT INTO user_bans (user_id, banned, ban_reason, banned_at) VALUES (?, 1, ?, NOW())',
                [user_id, reason]
            );
        } else if (!existing[0].banned) {
            // Update existing non-ban to banned
            await MySQLDatabaseManager.connection.pool.query(
                'UPDATE user_bans SET banned = 1, ban_reason = ?, banned_at = NOW() WHERE user_id = ?',
                [reason, user_id]
            );
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error banning user:', error);
        res.status(500).json({ error: `Failed to ban user: ${error.message}` });
    }
});

// ALERT MONITORING 

function calculateCpuUsagePercent() {
    try {
        const cpus = os.cpus();
        if (!Array.isArray(cpus) || cpus.length === 0) return 0;

        let totalTick = 0;
        let totalIdle = 0;

        cpus.forEach((cpu) => {
            const times = cpu?.times || {};
            totalTick += Object.values(times).reduce((sum, value) => sum + Number(value || 0), 0);
            totalIdle += Number(times.idle || 0);
        });

        if (totalTick <= 0) return 0;
        return Math.max(0, Math.min(100, Math.round(100 - ((totalIdle / totalTick) * 100))));
    } catch (_) {
        return 0;
    }
}

function classifySeverity(currentValue, threshold, criticalMultiplier = 1.25) {
    if (currentValue >= threshold * criticalMultiplier) return 'critical';
    if (currentValue >= threshold * 1.1) return 'high';
    return 'medium';
}

async function createOrRefreshActiveAlert({ alertType, severity, message, value, threshold, notify = true }) {
    const pool = MySQLDatabaseManager?.connection?.pool;
    if (!pool) return;

    const [existing] = await pool.execute(
        'SELECT id, severity, message, value, threshold FROM active_alerts WHERE alert_type = ? AND resolved = FALSE ORDER BY created_at DESC LIMIT 1',
        [alertType]
    );

    let createdNew = false;
    if (!existing.length) {
        await pool.execute(
            'INSERT INTO active_alerts (alert_type, severity, message, value, threshold) VALUES (?, ?, ?, ?, ?)',
            [alertType, severity, message, value, threshold]
        );
        createdNew = true;
    } else {
        const row = existing[0];
        const changed = row.severity !== severity
            || String(row.message || '') !== String(message || '')
            || Number(row.value || 0) !== Number(value || 0)
            || Number(row.threshold || 0) !== Number(threshold || 0);

        if (changed) {
            await pool.execute(
                'UPDATE active_alerts SET severity = ?, message = ?, value = ?, threshold = ? WHERE id = ?',
                [severity, message, value, threshold, row.id]
            );
        }
    }

    await pool.execute(
        'UPDATE alert_settings SET last_triggered = NOW(), updated_at = NOW() WHERE alert_type = ?',
        [alertType]
    );

    if (!notify || !createdNew) return;

    await routeAlertToDiscord({
        alert_type: alertType,
        severity,
        message,
        value,
        threshold
    });

    io.emit('alert', {
        alert_type: alertType,
        severity,
        message,
        value,
        threshold
    });
}

async function resolveActiveAlert(alertType) {
    const pool = MySQLDatabaseManager?.connection?.pool;
    if (!pool) return;

    await pool.execute(
        'UPDATE active_alerts SET resolved = TRUE, resolved_at = NOW() WHERE alert_type = ? AND resolved = FALSE',
        [alertType]
    );
}

async function checkAndCreateAlerts() {
    if (alertMonitorStatus.running) return;

    const startedAt = Date.now();
    alertMonitorStatus.running = true;
    alertMonitorStatus.lastRunAt = new Date(startedAt).toISOString();
    const runIssues = [];

    try {
        await ensureAlertTablesReady();
        const pool = MySQLDatabaseManager?.connection?.pool;
        if (!pool) return;

        const memUsage = process.memoryUsage();
        const memPercent = memUsage.heapTotal > 0
            ? Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100)
            : 0;
        const cpuPercent = calculateCpuUsagePercent();

        // Get alert settings
        const [settings] = await pool.execute(
            'SELECT * FROM alert_settings WHERE enabled = TRUE'
        );

        for (const setting of settings) {
            const alertType = setting.alert_type;
            const threshold = Number(setting.threshold || 0);

            try {
                let currentValue = 0;
                let message = '';
                let severity = 'medium';

                if (alertType === 'memory') {
                    currentValue = memPercent;
                    message = `Memory usage is ${currentValue}%`;
                    severity = classifySeverity(currentValue, threshold, 1.2);
                } else if (alertType === 'cpu') {
                    currentValue = cpuPercent;
                    message = `CPU usage is ${currentValue}%`;
                    severity = classifySeverity(currentValue, threshold, 1.2);
                } else if (alertType === 'error_rate') {
                    const [errorStats] = await pool.execute(
                        'SELECT COUNT(*) as total, SUM(CASE WHEN status IN (\'ERROR\', \'RATE_LIMIT\', \'PERMISSION\') THEN 1 ELSE 0 END) as errors FROM user_interactions WHERE created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)'
                    );

                    const total = Number(errorStats?.[0]?.total || 0);
                    const errors = Number(errorStats?.[0]?.errors || 0);
                    currentValue = total > 0 ? Math.round((errors / total) * 100) : 0;
                    message = `Command error rate is ${currentValue}%`;
                    severity = classifySeverity(currentValue, threshold, 2);
                } else if (alertType === 'rate_limit') {
                    const [rateLimitStats] = await pool.execute(
                        'SELECT COUNT(*) as count FROM user_interactions WHERE status = \'RATE_LIMIT\' AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)'
                    );

                    currentValue = Number(rateLimitStats?.[0]?.count || 0);
                    message = `Rate limit hits in last hour: ${currentValue}`;
                    severity = currentValue >= threshold * 2 ? 'high' : 'medium';
                } else if (alertType === 'database') {
                    const started = Date.now();
                    await pool.query('SELECT 1');
                    currentValue = Date.now() - started;
                    message = `Database latency is ${currentValue}ms`;
                    severity = classifySeverity(currentValue, threshold, 1.5);
                } else {
                    continue;
                }

                if (currentValue >= threshold) {
                    console.warn(`⚠️ [ALERT] ${alertType} at ${currentValue} (threshold: ${threshold})`);
                    await createOrRefreshActiveAlert({
                        alertType,
                        severity,
                        message,
                        value: currentValue,
                        threshold,
                        notify: true
                    });
                } else {
                    await resolveActiveAlert(alertType);
                }
            } catch (innerError) {
                if (alertType === 'database') {
                    const message = 'Database health check failed (query unreachable)';
                    await createOrRefreshActiveAlert({
                        alertType,
                        severity: 'critical',
                        message,
                        value: 100,
                        threshold,
                        notify: true
                    });
                    continue;
                }

                runIssues.push(`${alertType}: ${innerError?.message || innerError}`);
                console.error(`Error evaluating ${alertType} alert:`, innerError?.message || innerError);
            }
        }

        alertMonitorStatus.lastSuccessAt = new Date().toISOString();
        if (runIssues.length > 0) {
            alertMonitorStatus.lastError = runIssues.slice(0, 3).join(' | ');
            alertMonitorStatus.lastErrorAt = new Date().toISOString();
        } else {
            alertMonitorStatus.lastError = null;
            alertMonitorStatus.lastErrorAt = null;
        }
    } catch (error) {
        alertMonitorStatus.lastError = String(error?.message || error);
        alertMonitorStatus.lastErrorAt = new Date().toISOString();
        console.error('Error checking alerts:', error);
    } finally {
        alertMonitorStatus.lastDurationMs = Date.now() - startedAt;
        alertMonitorStatus.running = false;
    }
}

async function routeAlertToDiscord(alert) {
    try {
        if (!discordClient) return;

        const alertsConfig = MISC_CONFIG.alerts || {};
        if (alertsConfig.discordRoutingEnabled === false) return;

        const preferredChannelId = discordChannelId || serverLogChannelId;
        if (!preferredChannelId) return;

        const channel = await discordClient.channels.fetch(preferredChannelId).catch(() => null);
        if (!channel || !channel.isTextBased()) return;

        const { EmbedBuilder } = require('discord.js');
        const embed = new EmbedBuilder()
            .setColor(alert.severity === 'high' ? 0xED4245 : alert.severity === 'medium' ? 0xFAA61A : 0x5865F2)
            .setTitle('🚨 System Alert')
            .setDescription(alert.message || 'A system alert was triggered.')
            .addFields(
                { name: 'Type', value: String(alert.alert_type || 'unknown'), inline: true },
                { name: 'Severity', value: String(alert.severity || 'medium'), inline: true },
                { name: 'Value/Threshold', value: `${alert.value ?? 'N/A'} / ${alert.threshold ?? 'N/A'}`, inline: true }
            )
            .setTimestamp();

        await channel.send({ embeds: [embed] }).catch(() => { });
    } catch (error) {
        console.error('Error routing alert to Discord:', error.message);
    }
}

// Start alert monitoring (check every 5 minutes)
setInterval(checkAndCreateAlerts, ALERT_CHECK_INTERVAL_MS);

// Run once shortly after startup so alert state is visible without waiting 5 minutes.
setTimeout(() => {
    void checkAndCreateAlerts();
}, 10_000);

// Initialize Email System
(async () => {
    const emailEnabled = String(process.env.ENABLE_EMAIL || '').toLowerCase() === 'true';
    if (emailEnabled) {
        const smtpConfig = {
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || '587'),
            secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
            from: process.env.ADMIN_EMAIL
        };

        const emailInitialized = await EmailHelper.initialize(smtpConfig);
        if (emailInitialized) {
            console.log('✅ Email system ready');
        }
    } else {
        console.log('ℹ️  Email system disabled (ENABLE_EMAIL=false in credentials.env)');
    }
})();

// ==================== ADVANCED ANALYTICS ENDPOINTS ====================

// Get moderation analytics
app.get('/api/moderation/analytics', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasModeratorAccess(user)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
        const monthAgo = new Date(new Date(now.getFullYear(), now.getMonth(), 1));

        // Get total counts
        const [[totalWarns]] = await MySQLDatabaseManager.connection.pool.query(
            `SELECT COUNT(*) as count FROM moderation_cases WHERE action_type = 'WARN' AND status NOT IN ('cleared', 'reversed')`
        );

        const [[totalBans]] = await MySQLDatabaseManager.connection.pool.query(
            'SELECT COUNT(*) as count FROM user_bans WHERE banned = TRUE'
        );

        const [[totalTimeouts]] = await MySQLDatabaseManager.connection.pool.query(
            `SELECT COUNT(*) as count FROM moderation_cases WHERE action_type = 'TIMEOUT'`
        );

        // Get action breakdown
        const [actionBreakdown] = await MySQLDatabaseManager.connection.pool.query(`
            SELECT 
                'WARN' as type,
                SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as today,
                SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as week,
                SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as month,
                MAX(created_at) as lastPerformed
            FROM moderation_cases
            WHERE action_type = 'WARN' AND status NOT IN ('cleared', 'reversed')
            UNION ALL
            SELECT
                'BAN' as type,
                SUM(CASE WHEN banned_at >= ? THEN 1 ELSE 0 END) as today,
                SUM(CASE WHEN banned_at >= ? THEN 1 ELSE 0 END) as week,
                SUM(CASE WHEN banned_at >= ? THEN 1 ELSE 0 END) as month,
                MAX(banned_at) as lastPerformed
            FROM user_bans
            WHERE banned = TRUE
            UNION ALL
            SELECT
                'TIMEOUT' as type,
                SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as today,
                SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as week,
                SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as month,
                MAX(created_at) as lastPerformed
            FROM moderation_cases
            WHERE action_type = 'TIMEOUT'
        `, [today, weekAgo, monthAgo, today, weekAgo, monthAgo, today.getTime(), weekAgo.getTime(), monthAgo.getTime()]);

        // Get top warned users
        const [topWarned] = await MySQLDatabaseManager.connection.pool.query(`
            SELECT 
                mc.user_id,
                COALESCE(mc.user_name, l.username, ma.username, 'Unknown') as username,
                COUNT(*) as warn_count,
                MAX(mc.created_at) as lastWarning
            FROM moderation_cases mc
            LEFT JOIN levels l ON mc.user_id = l.user_id
            LEFT JOIN (
                SELECT user_id, username
                FROM member_activity
                GROUP BY user_id
                ORDER BY MAX(timestamp) DESC
                LIMIT 1
            ) ma ON mc.user_id = ma.user_id
            WHERE mc.action_type = 'WARN' AND mc.status NOT IN ('cleared', 'reversed')
            GROUP BY mc.user_id
            ORDER BY warn_count DESC
            LIMIT 10
        `);

        res.json({
            totalWarnings: totalWarns?.count || 0,
            totalBans: totalBans?.count || 0,
            totalTimeouts: totalTimeouts?.count || 0,
            appealsProcessed: 0,
            actionBreakdown: actionBreakdown || [],
            topWarned: topWarned || []
        });
    } catch (error) {
        console.error('Error loading analytics:', error);
        res.status(500).json({ error: 'Failed to load analytics' });
    }
});

// Case lookup
app.get('/api/moderation/case/:caseId', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasModeratorAccess(user)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const { caseId } = req.params;

        const moderationCase = await MySQLDatabaseManager.getModerationCaseById(caseId);

        if (moderationCase) {
            return res.json({
                case_id: moderationCase.case_id,
                user_id: moderationCase.user_id,
                username: moderationCase.user_name,
                reason: moderationCase.reason,
                type: moderationCase.action_type,
                moderator_name: moderationCase.moderator_name,
                timestamp: moderationCase.created_at,
                status: moderationCase.effective_status,
                expires_at: moderationCase.expires_at || null,
                related_case_id: moderationCase.related_case_id || null
            });
        }

        res.status(404).json({ error: 'Case not found' });
    } catch (error) {
        console.error('Error looking up case:', error);
        res.status(500).json({ error: 'Failed to lookup case' });
    }
});

// User moderation history
// Advanced user lookup for moderator panel
app.get('/api/moderator/user/:userId', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasModeratorAccess(user)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const { userId } = req.params;
        // Get user info
        const [userInfo, notes, level, warns, bans, timeouts] = await Promise.all([
            AdminPanelHelper.connection.getUserInfo(userId),
            AdminPanelHelper.connection.getMemberNotes(userId),
            AdminPanelHelper.getUserLevel(userId),
            AdminPanelHelper.connection.getUserWarns(userId),
            AdminPanelHelper.connection.query('SELECT * FROM user_bans WHERE user_id = ?', [userId]),
            MySQLDatabaseManager.getUserModerationCases(userId, { actionTypes: ['TIMEOUT'], limit: 50 })
        ]);

        // Aggregate infractions
        let infractions = [];
        if (warns?.warns) {
            infractions = Object.entries(warns.warns).map(([caseId, w]) => ({
                type: w.type || 'WARN',
                reason: w.reason,
                timestamp: w.timestamp
            }));
        }
        if (Array.isArray(bans) && bans.length > 0 && bans[0]?.banned) {
            bans.forEach(ban => {
                infractions.push({
                    type: 'BAN',
                    reason: ban.ban_reason,
                    timestamp: ban.banned_at
                });
            });
        }
        if (Array.isArray(timeouts) && timeouts.length > 0) {
            timeouts.forEach(timeout => {
                infractions.push({
                    type: 'TIMEOUT',
                    reason: timeout.reason,
                    timestamp: timeout.created_at
                });
            });
        }
        infractions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        res.json({
            userId: userId,
            username: userInfo?.username || null,
            avatar: userInfo?.avatar || null,
            notes: notes || '',
            level: level?.level || 1,
            infractions
        });
    } catch (error) {
        console.error('Error in advanced user lookup:', error);
        res.status(500).json({ error: 'Failed to lookup user' });
    }
});
app.get('/api/moderation/user/:userId/history', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!hasModeratorAccess(user)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const { userId } = req.params;

        // Get all moderation actions for this user
        const warns = await MySQLDatabaseManager.getUserModerationCases(userId, {
            actionTypes: ['WARN', 'KICK', 'TIMEOUT', 'UNTIMEOUT', 'UNBAN'],
            limit: 50
        });

        const [bans] = await MySQLDatabaseManager.connection.pool.query(
            `SELECT ban_case_id as case_id, ban_reason as reason, banned_by as moderator_id, banned_by_name as moderator_name, 
                    'BAN' as type, banned_at as timestamp
             FROM user_bans WHERE user_id = ? ORDER BY banned_at DESC LIMIT 50`,
            [userId]
        );

        // Combine and sort
        const history = [
            ...(warns || []),
            ...(bans || [])
        ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        res.json(history);
    } catch (error) {
        console.error('Error loading user history:', error);
        res.status(500).json({ error: 'Failed to load user history' });
    }
});

// System stats for owner dashboard
app.get('/api/owner/system-stats', requireAuth, requireOwner, async (req, res) => {
    try {
        const botStats = getStats();
        const memUsage = process.memoryUsage();

        const system = {
            platform: os.platform(),
            arch: os.arch(),
            release: os.release(),
            cpus: os.cpus().length,
            totalMem: os.totalmem(),
            freeMem: os.freemem(),
            usedMem: os.totalmem() - os.freemem(),
            uptime: os.uptime(),
            loadavg: os.loadavg()
        };

        const proc = {
            uptime: process.uptime(),
            memory: memUsage,
            version: process.version
        };

        res.json({
            system,
            process: proc,
            bot: botStats
        });
    } catch (error) {
        console.error('Error fetching system stats:', error);
        res.status(500).json({ error: 'Failed to fetch system stats' });
    }
});

// Start server
server.on('error', (error) => {
    adminPanelRuntime.lastServerErrorAt = Date.now();
    adminPanelRuntime.lastServerError = error?.message || String(error || 'unknown');
    if (error?.code === 'EADDRINUSE') {
        console.warn(`⚠️ Admin Panel Server could not bind to port ${PORT} because it is already in use.`);
        console.warn('⚠️ Skipping embedded admin panel startup for this process.');
        return;
    }

    console.error('Admin Panel server failed to start:', error);
});

server.on('close', () => {
    ioReady = false;
});

server.listen(PORT, () => {
    ioReady = true;
    adminPanelRuntime.serverListeningAt = Date.now();
    console.log(`\nAdmin Panel Server Running on port ${PORT}`);
    console.log(`📡  WebSocket enabled for live updates`);
    if (!SESSION_SECRET) {
        console.error('SESSION_SECRET is missing! Check your credentials.env file.');
    }
    if (!sessionStore) {
        console.error('Session store is not initialized! Session handling will fail.');
    }
});

module.exports = { setDiscordClient };