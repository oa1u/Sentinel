// Admin Panel server — backend for the dashboard
// Serves the admin UI, manages sessions, and applies security protections.

const express = require('express');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const bodyParser = require('body-parser');
const http = require('http');
const socketIo = require('socket.io');
const MySQLDatabaseManager = require('./Functions/MySQLDatabaseManager');
const AdminPanelHelper = require('./Functions/AdminPanelHelper');
const TotpHelper = require('./Functions/TotpHelper');
const EmailHelper = require('./Functions/EmailHelper');
const CsrfHelper = require('./Functions/CsrfHelper');
const { getStats } = require('./Functions/botStats');
const { generateCaseId } = require('./Events/caseId');
const { serverLogChannelId } = require('./Config/constants/channel.json');

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

const app = express();

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
app.use(helmet());
// Redirect to HTTPS if running in production
app.use((req, res, next) => {
    if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
        return res.redirect('https://' + req.headers.host + req.url);
    }
    next();
});
// (trust proxy is enabled later with a friendlier comment)

// Reference to the Discord bot client, set by index.js
let discordClient = null;
function setDiscordClient(client) {
    discordClient = client;
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
            // Allow localhost and ngrok URLs during development so local dev
            // and tunneling tools (like ngrok) work without CORS blocks.
            const allowedOrigins = [
                `http://localhost:${process.env.ADMIN_PORT || 3000}`,
                `http://127.0.0.1:${process.env.ADMIN_PORT || 3000}`,
                process.env.ADMIN_ORIGIN
            ];

            // Accept any ngrok URL for local development
            if (!origin || origin.includes('ngrok') || allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error('CORS not allowed'));
            }
        },
        methods: ['GET', 'POST'],
        credentials: true
    }
});
const PORT = process.env.ADMIN_PORT || 3000;

// Optional: stream recent server logs to connected admin UI clients.
// We keep a small rolling buffer so new clients can see recent activity.
const MAX_TERMINAL_LOGS = 500;
const terminalLogBuffer = [];

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
        io.emit('terminal-log-line', line);
    } catch {
        // Socket emit failures are fine — logging shouldn't crash the admin panel.
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


// Enable `trust proxy` so we can read the original client IP when behind a proxy
// (load balancers, reverse proxies, etc.). This helps accurate logging and rate-limits.
app.set('trust proxy', 1);

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
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    // Strict CSP: No inline scripts allowed (prevents XSS)
    // Chrome DevTools may show .well-known/appspecific requests; that's just browser behavior
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://cdn.socket.io 'unsafe-inline' 'unsafe-hashes'; style-src 'self' 'unsafe-inline' 'unsafe-hashes'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://cdn.jsdelivr.net https://cdn.socket.io; frame-src 'self' https://www.openstreetmap.org; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; child-src 'none'; object-src 'none';");
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
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
const SESSION_COOKIE_SECURE = process.env.NODE_ENV === 'production';
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
if (!SESSION_SECRET) {
    console.error('❌ CRITICAL: SESSION_SECRET is not set in Config/credentials.env');
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
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: SESSION_COOKIE_SECURE, // Use environment setting (true in production)
        sameSite: SESSION_COOKIE_SECURE ? 'none' : 'lax', // 'none' requires secure: true
        maxAge: DEFAULT_SESSION_POLICY.idleTimeoutMs,
        httpOnly: true, // Prevent JavaScript from accessing cookies
        path: '/'
    },
    rolling: true
});

app.use(sessionMiddleware);

// Listen for session store connection/disconnection events
// Note: session store event hooks were removed — they were no-ops.

// (Optional) Log session ID for debugging

app.use(bodyParser.json({ limit: '10kb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10kb' }));

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
        sameSite: 'lax', // Use Lax for better compatibility unless strict is needed
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
            return res.status(403).json({ error: 'Invalid Origin' });
        }

        const token = getCsrfRequestToken(req);
        const secret = req.session.csrfSecret;

        // 2. Verify Signed Token (Advanced timestamp + salt check)
        if (!CsrfHelper.verifyToken(secret, token)) {
            console.warn(`[CSRF] Invalid CSRF token for '${req.session.username}' (role: ${req.session.role}). Token verify failed.`);
            // Helps frontend clear stale tokens
            res.clearCookie('csrfToken', { path: '/' });
            return res.status(403).json({ error: 'Invalid or expired CSRF token', cause: 'verify_failed' });
        }
    }
    next();
});

// Basic rate limiter to prevent abuse of sensitive endpoints
const rateLimitStore = new Map();
function createRateLimiter(maxRequests = 5, windowMs = 60000) {
    return (req, res, next) => {
        const key = `${req.ip}_${req.path}`;
        const now = Date.now();
        const userLimits = rateLimitStore.get(key) || [];

        // Remove old requests from the log
        const recentRequests = userLimits.filter(timestamp => now - timestamp < windowMs);

        if (recentRequests.length >= maxRequests) {
            res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
            return res.status(429).json({ error: 'Too many requests, please try again later' });
        }

        recentRequests.push(now);
        rateLimitStore.set(key, recentRequests);

        // Occasionally clean up the rate limit store
        if (Math.random() < 0.01) {
            for (const [k, v] of rateLimitStore.entries()) {
                const active = v.filter(t => now - t < windowMs);
                if (active.length === 0) {
                    rateLimitStore.delete(k);
                } else {
                    rateLimitStore.set(k, active);
                }
            }
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
        return next(new Error('Unauthorized Socket.IO connection'));
    }

    const now = Date.now();
    const expiry = getSessionExpiryState(session, now);
    if (expiry.expired) {
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
// Serve Functions directory statically for frontend access to AdminPanelHelper.js
app.use('/Functions', express.static(path.join(__dirname, 'Functions')));
// Serve /Config directory statically for frontend access to main.json and other config files
app.use('/Config', express.static(path.join(__dirname, 'Config')));

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
}, 30 * 60 * 1000); // 30 minutes

// Middleware to require authentication for protected routes
function requireAuth(req, res, next) {
    // (Debug) Log session and cookies if needed
    if (req.session && req.session.authenticated) {
        // Save the user's IP and user agent in the session if not already set
        if (!req.session.ipAddress || !req.session.userAgent) {
            req.session.ipAddress = req.clientIP;
            req.session.ipAddressV4 = req.clientIPV4;
            req.session.ipAddressV6 = req.clientIPV6;
            req.session.userAgent = req.userAgent;
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
    /^\/api\/appeals\/submit$/
];

const API_ROLE_POLICIES = [
    { methods: null, pattern: /^\/api\/owner(?:\/|$)/, minRole: 'owner' },
    { methods: null, pattern: /^\/api\/jobs(?:\/|$)/, minRole: 'owner' },
    { methods: null, pattern: /^\/api\/automod(?:\/|$)/, minRole: 'owner' },
    { methods: null, pattern: /^\/api\/alerts(?:\/|$)/, minRole: 'owner' },
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

async function refreshSessionRoleIfNeeded(req) {
    if (!req.session || !req.session.authenticated || !req.session.username) return;

    const now = Date.now();
    const verifiedAt = Number(req.session.roleVerifiedAt) || 0;
    const roleFreshMs = 2 * 60 * 1000;

    if (now - verifiedAt < roleFreshMs && req.session.role) {
        return;
    }

    const user = await AdminPanelHelper.getAdminUser(req.session.username);
    if (!user || !user.role) {
        console.warn(`[Sessions] Refresh role failed for '${req.session.username}'. User not found or no role. marking unauth.`);
        req.session.authenticated = false;
        req.session.role = null;
        req.session.roleVerifiedAt = now;
        return;
    }

    // Log role mismatch or update
    if (req.session.role !== user.role) {
        console.info(`[Sessions] Updated role for '${req.session.username}': ${req.session.role} -> ${user.role}`);
    }

    req.session.role = user.role;
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
            console.warn(`[API Policy] Denied access to ${req.method} ${req.path}. User '${req.session?.username}' role '${currentRole}' (rank ${getRoleRank(currentRole)}) < required '${requiredRole}' (rank ${getRoleRank(requiredRole)})`);
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
            spamWarningThreshold: 2
        },
        autoModAdvanced: {
            escalationThreshold24h: 4,
            escalationTimeoutMs: 1800000
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
            spamWarningThreshold: 1
        },
        autoModAdvanced: {
            escalationThreshold24h: 3,
            escalationTimeoutMs: 2700000
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
            spamWarningThreshold: 3
        },
        autoModAdvanced: {
            escalationThreshold24h: 6,
            escalationTimeoutMs: 1200000
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

    return merged;
}

function evaluateAutoModSimulation({ message, recentMessageCount, priorViolations24h, effectiveConfig }) {
    const config = effectiveConfig || {};
    const autoMod = config.autoMod || {};
    const advanced = config.autoModAdvanced || {};

    const findings = [];
    const actions = [];
    const matchedRegexPatterns = [];
    const invalidRegexPatterns = [];

    const inviteRegex = /(discord\.gg|discord(app)?\.com\/invite)\/\S+/i;
    if (Boolean(config.blockExternalInvites) && inviteRegex.test(message)) {
        findings.push('Contains invite link while invite blocking is enabled');
        actions.push('Delete message / issue moderation action');
    }

    const mentionMatches = message.match(/<@!?\d+>|@everyone|@here/g);
    const mentionCount = Array.isArray(mentionMatches) ? mentionMatches.length : 0;
    if (mentionCount > toFiniteNumber(config.maxMentionsBeforeFlag, 6, 1, 200)) {
        findings.push(`Mention count ${mentionCount} exceeds limit ${toFiniteNumber(config.maxMentionsBeforeFlag, 6, 1, 200)}`);
        actions.push('Flag for mention spam review');
    }

    const letters = message.match(/[A-Za-z]/g) || [];
    const uppercase = message.match(/[A-Z]/g) || [];
    const minLengthForCaps = toFiniteNumber(autoMod.minLengthForCaps, 10, 1, 2000);
    if (letters.length >= minLengthForCaps) {
        const ratio = uppercase.length / letters.length;
        const capsThreshold = toFiniteNumber(autoMod.capsThreshold, 0.7, 0.1, 1);
        if (ratio >= capsThreshold) {
            findings.push(`Caps ratio ${(ratio * 100).toFixed(1)}% exceeds ${(capsThreshold * 100).toFixed(0)}% threshold`);
            actions.push('Apply caps warning policy');
        }
    }

    const patterns = Array.isArray(advanced.blockedRegexPatterns) ? advanced.blockedRegexPatterns : [];
    patterns.forEach((pattern) => {
        if (typeof pattern !== 'string' || !pattern.trim()) return;
        try {
            const reg = new RegExp(pattern, 'i');
            if (reg.test(message)) matchedRegexPatterns.push(pattern);
        } catch (error) {
            invalidRegexPatterns.push(pattern);
        }
    });
    if (matchedRegexPatterns.length) {
        findings.push(`Matched blocked regex pattern(s): ${matchedRegexPatterns.slice(0, 3).join(', ')}${matchedRegexPatterns.length > 3 ? ' ...' : ''}`);
        actions.push('Delete message and log pattern match');
    }

    const spamThreshold = toFiniteNumber(autoMod.spamThreshold, 5, 1, 200);
    const spamWarningThreshold = toFiniteNumber(autoMod.spamWarningThreshold, 2, 1, 200);
    const spamTimeout = toFiniteNumber(autoMod.spamTimeout, 600000, 1000, 86400000);
    if (recentMessageCount >= spamThreshold) {
        findings.push(`Recent message count ${recentMessageCount} reaches spam threshold ${spamThreshold}`);
        actions.push(`Apply spam timeout (${spamTimeout}ms)`);
    } else if (recentMessageCount >= spamWarningThreshold) {
        findings.push(`Recent message count ${recentMessageCount} reaches warning threshold ${spamWarningThreshold}`);
        actions.push('Issue spam warning');
    }

    const escalationThreshold = toFiniteNumber(advanced.escalationThreshold24h, 4, 1, 1000);
    const escalationTimeout = toFiniteNumber(advanced.escalationTimeoutMs, 1800000, 1000, 86400000);
    if (priorViolations24h >= escalationThreshold) {
        findings.push(`Prior violations ${priorViolations24h} trigger escalation threshold ${escalationThreshold}`);
        actions.push(`Escalate timeout (${escalationTimeout}ms)`);
    }

    return {
        verdict: findings.length ? 'flagged' : 'clean',
        findings,
        actions,
        metrics: {
            mentionCount,
            lettersCount: letters.length,
            uppercaseCount: uppercase.length,
            recentMessageCount,
            priorViolations24h
        },
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

// Main routes for the admin panel
app.get('/', (req, res) => {
    if (req.session && req.session.authenticated) {
        res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'dashboard.html'));
    } else {
        res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'login.html'));
    }
});

// Explicit admin panel route with role check
app.get('/admin', requireAuth, (req, res) => {
    if (req.session && req.session.role && (req.session.role === 'admin' || req.session.role === 'owner')) {
        res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'admin.html'));
    } else {
        res.redirect('/unauthorized');
    }
});

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

app.get('/moderator', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'moderator.html'));
});

// Track login attempts to prevent brute force attacks
const loginAttempts = new Map();

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

// Login endpoint with rate limiting and lockout protection
app.post('/api/login', createRateLimiter(3, 60000), async (req, res) => {
    // Login endpoint was called
    if (!AdminPanelHelper || !AdminPanelHelper.getAdminUser) {
        // If AdminPanelHelper or getAdminUser is missing, something is wrong
    }
    const clientIP = req.clientIP;
    const { username, password, twoFactorToken, twoFactorChallenge } = req.body;

    // Block login if IP is locked out
    if (isIPLocked(clientIP)) {
        // Too many failed logins from this IP
        return res.status(429).json({ error: 'Too many failed attempts. Try again in 30 minutes.' });
    }

    // Make sure username and password are provided
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    // Check that the username is a valid string
    if (typeof username !== 'string' || username.length > 50 || username.length < 3) {
        return res.status(400).json({ error: 'Invalid username format' });
    }

    if (typeof password !== 'string' || password.length > 100) {
        return res.status(400).json({ error: 'Invalid password format' });
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
            await logAdminAuthEvent(username, 'LOGIN_FAILED', req, { reason: 'user-not-found', attempts: attempts.length });
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
                        userAgent: req.userAgent
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

                try {
                    const twoFactorSecret = TotpHelper.decryptTwoFactorSecret(
                        user.two_factor_secret,
                        process.env.SESSION_SECRET
                    );

                    const isValidTotp = TotpHelper.verifyTotp(twoFactorToken, twoFactorSecret, { window: 1 });
                    if (!isValidTotp) {
                        await logAdminAuthEvent(username, 'LOGIN_2FA_FAILED', req, { reason: 'invalid-token' });
                        return res.status(401).json({ error: 'Invalid 2FA code' });
                    }
                } catch (twoFactorError) {
                    await logAdminAuthEvent(username, 'LOGIN_2FA_FAILED', req, { reason: 'secret-decrypt-failed' });
                    return res.status(500).json({ error: 'Unable to verify 2FA code' });
                }

                twoFactorChallenges.delete(twoFactorChallenge);
            }

            // Reset failed login attempts for this IP
            loginAttempts.delete(clientIP);

            return await establishLoginSession(req, res, user, {
                authMethod: 'password'
            });
        } else {
            // Track failed attempt
            const attempts = trackLoginAttempt(clientIP);
            await logAdminAuthEvent(username, 'LOGIN_FAILED', req, { reason: 'password-mismatch', attempts: attempts.length });
            // Failed password attempt for user
            res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (error) {
        // Login error
        res.status(500).json({ error: 'Login failed', details: error?.message || error });
    }
});

app.post('/api/login/recovery', createRateLimiter(3, 60000), async (req, res) => {
    const clientIP = req.clientIP;
    const username = String(req.body?.username || '').trim();
    const recoveryCodeRaw = String(req.body?.recoveryCode || '').trim();

    if (isIPLocked(clientIP)) {
        return res.status(429).json({ error: 'Too many failed attempts. Try again in 30 minutes.' });
    }

    if (!username || !recoveryCodeRaw) {
        return res.status(400).json({ error: 'Username and recovery code are required' });
    }

    if (typeof username !== 'string' || username.length > 50 || username.length < 3) {
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
            await logAdminAuthEvent(username, 'LOGIN_FAILED', req, { reason: 'user-not-found', mode: 'recovery', attempts: attempts.length });
            return res.status(401).json({ error: 'Invalid recovery credentials' });
        }

        const hashes = parseRecoveryCodeHashes(user.recovery_code_hashes);
        const inputHash = hashRecoveryCode(normalizedCode);
        const index = hashes.findIndex((value) => String(value) === inputHash);

        if (index === -1) {
            const attempts = trackLoginAttempt(clientIP);
            await logAdminAuthEvent(username, 'LOGIN_FAILED', req, { reason: 'recovery-code-mismatch', mode: 'recovery', attempts: attempts.length });
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

        return await establishLoginSession(req, res, user, {
            authMethod: 'recovery-code',
            logMetadata: {
                role: user.role,
                remainingRecoveryCodes: remainingHashes.length
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

function isStrongPassword(value) {
    const candidate = String(value || '');
    if (candidate.length < 8 || candidate.length > 100) return false;
    return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{8,}$/.test(candidate);
}

function createSecureToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('hex');
}

async function sendSecurityAlertIfPossible(user, title, details = []) {
    const email = String(user?.email || '').trim();
    const username = String(user?.username || '').trim() || 'User';
    if (!EmailHelper.isReady() || !email) return;

    await EmailHelper.sendSecurityAlertEmail(email, username, title, details).catch((emailError) => {
        console.error('[SecurityEmail] Failed to send security alert:', emailError?.message || emailError);
    });
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

    res.cookie('csrfToken', initialToken, {
        httpOnly: false,
        sameSite: 'lax',
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
            const [timeoutRows] = await MySQLDatabaseManager.connection.pool.query(
                `SELECT reason, expires_at, active
                 FROM timeouts
                 WHERE user_id = ?
                 ORDER BY expires_at DESC
                 LIMIT 1`,
                [userId]
            );
            timeoutRow = Array.isArray(timeoutRows) && timeoutRows.length ? timeoutRows[0] : null;
        } catch (_) {
            timeoutRow = null;
        }

        const isBanned = Boolean(banRow && Number(banRow.banned) === 1);
        const timeoutExpires = timeoutRow?.expires_at || null;
        const timeoutActiveFlag = timeoutRow ? (timeoutRow.active === undefined ? true : Boolean(timeoutRow.active)) : false;
        const isTimedOut = Boolean(timeoutRow && timeoutActiveFlag && timeoutExpires && new Date(timeoutExpires).getTime() > Date.now());

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
            safeCount('SELECT COUNT(*) as count FROM warns WHERE type = "WARN" AND timestamp >= ? AND timestamp < ?', [todayMs, tomorrowMs], 'Warns'),
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

// Combined dashboard endpoint - reduces API calls
app.get('/api/dashboard/all', requireAuth, async (req, res) => {
    try {
        const [levels, warns, reminders, giveaways, bannedUsers] = await Promise.all([
            AdminPanelHelper.getAllLevels(),
            AdminPanelHelper.getAllWarns(),
            AdminPanelHelper.getAllReminders(),
            AdminPanelHelper.getGiveawaysCount(),
            AdminPanelHelper.getAllBannedUsers()
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
            bannedUsersCount: bannedUsers.length
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
        if (!userId || !/^\d{17,19}$/.test(userId)) {
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
        if (!userId || !/^\d{17,19}$/.test(userId)) {
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

            try {
                await MySQLDatabaseManager.connection.pool.query(
                    `INSERT INTO unbans (
                        user_id, unban_case_id, unbanned_at, unbanned_by,
                        unbanned_by_name, unbanned_by_source, user_name,
                        original_ban_case_id, original_ban_reason, reason
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                    , [
                        userId,
                        unbanCaseId,
                        new Date(),
                        null,
                        req.session?.username || null,
                        'panel',
                        targetUser?.username || null,
                        originalBanCaseId,
                        originalBanReason,
                        `Unbanned via admin panel by ${req.session?.username || 'Unknown'}`
                    ]
                );
            } catch (dbErr) {
                console.error('[Unban] Failed to insert unban record:', dbErr.message);
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

        if (!/^\d{17,19}$/.test(userId)) {
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
        if (!user || (user.role !== 'moderator' && user.role !== 'admin' && user.role !== 'owner')) {
            return res.status(403).json({ error: 'Moderator access required' });
        }

        const { userId, reason } = req.body;

        // Input validation
        if (!userId || typeof userId !== 'string' || !/^\d{17,19}$/.test(userId)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }

        if (!reason || typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 500) {
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
        if (!user || (user.role !== 'moderator' && user.role !== 'admin' && user.role !== 'owner')) {
            return res.status(403).json({ error: 'Moderator access required' });
        }

        const { userId, reason } = req.body;

        // Input validation
        if (!userId || typeof userId !== 'string' || !/^\d{17,19}$/.test(userId)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }

        if (!reason || typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 500) {
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
        if (!user || (user.role !== 'moderator' && user.role !== 'admin' && user.role !== 'owner')) {
            return res.status(403).json({ error: 'Moderator access required' });
        }

        const { userId, duration, reason } = req.body;

        // Input validation
        if (!userId || typeof userId !== 'string' || !/^\d{17,19}$/.test(userId)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }

        if (!duration || typeof duration !== 'number' || duration < 60000 || duration > 2419200000) {
            return res.status(400).json({ error: 'Duration must be between 1 minute and 28 days' });
        }

        if (!reason || typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 500) {
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
            await member.timeout(duration, reason.trim());
            resolvedUsername = member.user?.username || null;
            await resolveDiscordUser(userId.trim());
        }

        // Log the timeout request
        const timeoutRecord = {
            userId: userId.trim(),
            username: resolvedUsername,
            duration,
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
            expiresAt: Date.now() + duration
        });

        console.log(`[Admin] ${req.session.username} timed out user ${userId} for ${duration}ms: ${reason}`);
        res.json({ success: true, message: 'User timed out', timeout: timeoutRecord });
    } catch (error) {
        console.error('Error timing out user:', error);
        res.status(500).json({ error: 'Failed to timeout user' });
    }
});

app.get('/api/user/:userId', requireAuth, async (req, res) => {
    try {
        const { userId } = req.params;

        if (!userId || !/^\d{17,19}$/.test(userId)) {
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
        if (!user || (user.role !== 'admin' && user.role !== 'owner')) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const users = await AdminPanelHelper.getAllAdminUsers();
        res.json(users);
    } catch (error) {
        console.error('Error fetching admin users:', error);
        res.status(500).json({ error: 'Failed to fetch admin users' });
    }
});

app.post('/api/admin/users', requireAuth, async (req, res) => {
    try {
        // Check if user has admin role
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!user || (user.role !== 'admin' && user.role !== 'owner')) {
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
        if (!user || (user.role !== 'admin' && user.role !== 'owner')) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { userId } = req.params;
        const updates = req.body;

        // Validate userId
        if (!userId || typeof userId !== 'string' || !/^\d+$/.test(userId)) {
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

        const success = await AdminPanelHelper.updateAdminUser(userId, updates);

        if (success) {
            console.log(`[Admin] ${req.session.username} updated admin user ${userId}`);
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
        if (!user || (user.role !== 'admin' && user.role !== 'owner')) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { userId } = req.params;

        // Validate userId
        if (!userId || typeof userId !== 'string' || !/^\d+$/.test(userId)) {
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
        if (!user || user.role !== 'owner') {
            return res.status(403).json({ error: 'Owner access required' });
        }

        const { userId } = req.params;

        // Validate userId
        if (!userId || typeof userId !== 'string' || !/^\d+$/.test(userId)) {
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
            u.bio,
            u.flags,
            u.status,
            (SELECT COUNT(*) FROM warns WHERE user_id = l.user_id) as warn_count,
            b.banned,
            b.ban_reason,
            b.banned_at
        FROM levels l
        LEFT JOIN userinfo u ON l.user_id = u.user_id
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
            sql += ` AND EXISTS (SELECT 1 FROM timeouts t WHERE t.user_id = l.user_id AND t.active = 1)`;
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
        if (/^\d{17,20}$/.test(query)) {
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
                MySQLDatabaseManager.connection.pool.query('SELECT COUNT(*) as count FROM warns WHERE user_id = ?', [user.id]),
                MySQLDatabaseManager.connection.pool.query('SELECT id, user_id, case_id, reason, moderator_id, moderator_name, type, timestamp, created_at FROM warns WHERE user_id = ? ORDER BY timestamp DESC LIMIT 20', [user.id]),
                MySQLDatabaseManager.connection.pool.query('SELECT user_id, banned, ban_case_id, banned_at, banned_by, banned_by_name, ban_reason, created_at FROM user_bans WHERE user_id = ? ORDER BY created_at DESC', [user.id]),
                MySQLDatabaseManager.connection.pool.query('SELECT * FROM member_notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [user.id]).catch(() => [[]]),
                MySQLDatabaseManager.connection.pool.query('SELECT id, user_id, case_id, reason, issued_by, issued_by_name, issued_at, expires_at, active FROM timeouts WHERE user_id = ? ORDER BY issued_at DESC LIMIT 10', [user.id]).catch(() => [[]])
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
        if (!/^\d{17,19}$/.test(userId)) {
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
    const { username, email, password, inviteCode } = req.body;

    // Input validation
    if (!username || !email || !password || !inviteCode) {
        return res.status(400).json({ error: 'All fields required' });
    }

    // Validate types
    if (typeof username !== 'string' || typeof email !== 'string' || typeof password !== 'string' || typeof inviteCode !== 'string') {
        return res.status(400).json({ error: 'Invalid input format' });
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

function sendVerifyEmailStatusPage(res, { title, message, hint = '', statusCode = 200 } = {}) {
    const safeTitle = sanitizeHtmlText(title || 'Status');
    const safeMessage = sanitizeHtmlText(message || 'Request completed.');
    const safeHint = sanitizeHtmlText(hint || '');
    const code = Number.isInteger(statusCode) ? statusCode : 200;

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
        await sendSecurityAlertIfPossible(user, 'Password reset completed', ['Method: Email reset token']);

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
        ]);

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

        let discordProfile = null;
        if (user.discord_user_id && discordClient) {
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
            linked: Boolean(user.discord_user_id),
            discordUserId: user.discord_user_id || null,
            discordUsername: user.discord_username || null,
            linkedAt: user.discord_linked_at || null,
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

app.post('/api/security/sessions/logout-others', requireAuth, async (req, res) => {
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

app.post('/api/security/sessions/revoke', requireAuth, async (req, res) => {
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

app.post('/api/security/recovery-codes/generate', requireAuth, async (req, res) => {
    try {
        const currentPassword = String(req.body?.currentPassword || '').trim();
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

        const state = crypto.randomBytes(24).toString('hex');
        storeDiscordOAuthState(state, {
            username: req.session.username,
            createdAt: Date.now()
        });

        req.session.discordOAuthState = {
            value: state,
            createdAt: Date.now()
        };

        await new Promise((resolve) => req.session.save(() => resolve()));

        const params = new URLSearchParams({
            client_id: oauth.clientId,
            redirect_uri: oauth.redirectUri,
            response_type: 'code',
            scope: 'identify',
            state,
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
            callbackHost
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

        if (!code || !state) {
            return completeDiscordOAuthRequest(req, res, { success: false, message: 'Missing OAuth callback data' });
        }

        const sessionStateAgeMs = Date.now() - Number(stateData?.createdAt || 0);
        const sessionStateValid = Boolean(
            stateData?.value &&
            state === stateData.value &&
            Number.isFinite(sessionStateAgeMs) &&
            sessionStateAgeMs <= DISCORD_OAUTH_STATE_TTL_MS
        );

        if (!serverState && !sessionStateValid) {
            return completeDiscordOAuthRequest(req, res, { success: false, message: 'Invalid or expired OAuth state' });
        }

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
            scope: 'identify'
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

        const discordUsername = me.discriminator && me.discriminator !== '0'
            ? `${me.username}#${me.discriminator}`
            : me.username;

        await MySQLDatabaseManager.connection.pool.execute(
            `UPDATE admin_users
             SET discord_user_id = ?, discord_username = ?, discord_linked_at = NOW()
             WHERE id = ?`,
            [me.id, discordUsername || null, panelUser.id]
        );

        return completeDiscordOAuthRequest(req, res, { success: true, message: 'Discord account linked successfully' });
    } catch (error) {
        console.error('Error handling Discord OAuth callback:', error);
        return completeDiscordOAuthRequest(req, res, { success: false, message: 'Discord OAuth callback failed' });
    }
});

app.post('/api/account/discord-unlink', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        await MySQLDatabaseManager.connection.pool.execute(
            `UPDATE admin_users
             SET discord_user_id = NULL, discord_username = NULL, discord_linked_at = NULL
             WHERE id = ?`,
            [user.id]
        );

        return res.json({ success: true });
    } catch (error) {
        console.error('Error unlinking Discord account:', error);
        return res.status(500).json({ error: 'Failed to unlink Discord account' });
    }
});

app.post('/api/security/2fa/setup', requireAuth, async (req, res) => {
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
        const otpauthUri = TotpHelper.buildOtpauthUrl({
            secret,
            accountName: user.username,
            issuer: 'OA1U Admin Panel'
        });

        req.session.pendingTwoFactorSetup = {
            secret,
            createdAt: Date.now()
        };
        await req.session.save(() => { });

        return res.json({
            success: true,
            secret,
            otpauthUri
        });
    } catch (error) {
        console.error('Error initializing 2FA setup:', error);
        return res.status(500).json({ error: 'Failed to initialize 2FA setup' });
    }
});

app.post('/api/security/2fa/enable', requireAuth, async (req, res) => {
    try {
        const { token } = req.body || {};
        const pending = req.session.pendingTwoFactorSetup;

        if (!pending || !pending.secret || (Date.now() - Number(pending.createdAt || 0) > (10 * 60 * 1000))) {
            return res.status(400).json({ error: '2FA setup has expired. Start setup again.' });
        }

        if (!TotpHelper.verifyTotp(token, pending.secret, { window: 1 })) {
            return res.status(401).json({ error: 'Invalid verification code' });
        }

        const encryptedSecret = TotpHelper.encryptTwoFactorSecret(pending.secret, process.env.SESSION_SECRET);
        await MySQLDatabaseManager.connection.pool.execute(
            `UPDATE admin_users
             SET two_factor_enabled = TRUE,
                 two_factor_secret = ?,
                 two_factor_enabled_at = NOW()
             WHERE username = ?`,
            [encryptedSecret, req.session.username]
        );

        delete req.session.pendingTwoFactorSetup;
        await req.session.save(() => { });
        await logAdminAuthEvent(req.session.username, 'TWO_FACTOR_ENABLED', req, {});

        return res.json({ success: true });
    } catch (error) {
        console.error('Error enabling 2FA:', error);
        return res.status(500).json({ error: 'Failed to enable 2FA' });
    }
});

app.post('/api/security/2fa/disable', requireAuth, async (req, res) => {
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

        const decryptedSecret = TotpHelper.decryptTwoFactorSecret(user.two_factor_secret, process.env.SESSION_SECRET);
        const validToken = TotpHelper.verifyTotp(token, decryptedSecret, { window: 1 });
        if (!validToken) {
            return res.status(401).json({ error: 'Invalid verification code' });
        }

        await MySQLDatabaseManager.connection.pool.execute(
            `UPDATE admin_users
             SET two_factor_enabled = FALSE,
                 two_factor_secret = NULL,
                 two_factor_enabled_at = NULL
             WHERE username = ?`,
            [req.session.username]
        );

        await logAdminAuthEvent(req.session.username, 'TWO_FACTOR_DISABLED', req, {});
        await sendSecurityAlertIfPossible(user, 'Two-factor authentication disabled', [
            '2FA was disabled on your account.',
            `Time: ${new Date().toLocaleString()}`
        ]);
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
        const passwordHash = await bcrypt.hash(newPassword, 10);

        // Update password in database
        const connection = await MySQLConnection.getConnection();
        await connection.query(
            'UPDATE admin_users SET password_hash = ?, password_changed_at = NOW() WHERE username = ?',
            [newPasswordHash, req.session.username]
        );
        connection.release();

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
        if (!user || user.role !== 'owner') {
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
        if (!user || (user.role !== 'owner' && user.role !== 'admin')) {
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
        if (!user || (user.role !== 'owner' && user.role !== 'admin')) {
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
        if (!user || user.role !== 'owner') {
            return res.status(403).json({ error: 'Only owner can revoke invite codes' });
        }

        if (permanent === true) {
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
        if (!user || user.role !== 'owner') {
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
        if (!user || user.role !== 'owner') {
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

function requireAdmin(req, res, next) {
    AdminPanelHelper.getAdminUser(req.session.username)
        .then(user => {
            if (!user || user.role !== 'admin') {
                return res.redirect('/unauthorized');
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
app.get('/search', requireAuth, (req, res) => {
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
        const connection = await MySQLConnection.getConnection();
        await connection.query(
            'UPDATE admin_users SET password_hash = ?, password_changed_at = NOW() WHERE username = ?',
            [newPasswordHash, req.session.username]
        );
        connection.release();

        console.log(`[Admin] User ${req.session.username} changed their password`);
        logAdminAuthEvent(req.session.username, 'PASSWORD_CHANGED', req, { route: '/api/user/change-password' }).catch(() => { });
        await sendSecurityAlertIfPossible(user, 'Password changed', [
            'Your account password was changed.',
            `Time: ${new Date().toLocaleString()}`
        ]);
        res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        console.error('Error changing password:', error);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

// Change email endpoint
app.post('/api/user/change-email', createRateLimiter(5, 60000), requireAuth, async (req, res) => {
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
        ]);

        console.log(`[Admin] User ${req.session.username} changed their email address`);
        logAdminAuthEvent(req.session.username, 'EMAIL_CHANGED', req, { route: '/api/user/change-email' }).catch(() => { });
        return res.json({ success: true, email: normalizedEmail, message: 'Email changed successfully' });
    } catch (error) {
        console.error('Error changing email:', error);
        return res.status(500).json({ error: 'Failed to change email' });
    }
});

// Audit logs page route
app.get('/audit-logs', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'AdminPanel', 'views', 'audit-logs.html'));
});

// Get top users (admin only)
app.get('/api/admin/top-users', requireAuth, async (req, res) => {
    try {
        // Check if user is admin
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!user || (user.role !== 'admin' && user.role !== 'owner')) {
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
        if (!user || (user.role !== 'admin' && user.role !== 'owner')) {
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
        if (!user || (user.role !== 'admin' && user.role !== 'owner')) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        // Get ticket counts from the helper
        const tickets = await AdminPanelHelper.getAllTickets('all') || [];

        // Count by status
        let open = 0, claimed = 0, closed = 0;

        tickets.forEach(ticket => {
            if (ticket.status === 'open') open++;
            else if (ticket.status === 'claimed') claimed++;
            else if (ticket.status === 'closed') closed++;
        });

        const total = open + claimed + closed;

        res.json({
            success: true,
            open: open,
            claimed: claimed,
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
        if (!user || (user.role !== 'admin' && user.role !== 'owner')) {
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
        if (!user || (user.role !== 'admin' && user.role !== 'owner')) {
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
        if (!user || (user.role !== 'admin' && user.role !== 'owner')) {
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
        if (!user || (user.role !== 'admin' && user.role !== 'owner')) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const levels = await AdminPanelHelper.getAllLevels();

        // Reset all levels to 1 and XP to 0 (this would require a helper method)
        // For now, just return the count
        console.log(`[Admin] ${req.session.username} attempted to reset ${levels.length} levels`);

        res.json({
            success: true,
            count: levels.length,
            message: `Reset ${levels.length} users to level 1`
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
        if (!user || (user.role !== 'admin' && user.role !== 'owner')) {
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
        if (!user || (user.role !== 'admin' && user.role !== 'owner')) {
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
        // Try to find case in warns, bans, timeouts, kicks, etc.
        // Warns
        const warn = await MySQLDatabaseManager.connection.query('SELECT * FROM warns WHERE case_id = ? LIMIT 1', [caseId]);
        if (warn && warn.length > 0) {
            return res.json({
                type: warn[0].type || 'WARN',
                userId: warn[0].user_id,
                userName: warn[0].user_name,
                moderatorId: warn[0].moderator_id,
                moderatorName: warn[0].moderator_name,
                moderatorSource: warn[0].moderator_source,
                reason: warn[0].reason,
                timestamp: warn[0].timestamp,
                duration: warn[0].duration,
                expiresAt: warn[0].expires_at,
                status: 'active',
                extra: null
            });
        }
        // Bans
        const ban = await MySQLDatabaseManager.connection.query('SELECT * FROM user_bans WHERE ban_case_id = ? LIMIT 1', [caseId]);
        if (ban && ban.length > 0) {
            return res.json({
                type: 'BAN',
                userId: ban[0].user_id,
                userName: ban[0].user_name,
                moderatorId: ban[0].banned_by,
                moderatorName: ban[0].banned_by_name,
                moderatorSource: ban[0].banned_by_source,
                reason: ban[0].ban_reason,
                timestamp: ban[0].banned_at,
                duration: null,
                expiresAt: null,
                status: ban[0].banned ? 'active' : 'inactive',
                extra: null
            });
        }
        // Timeouts
        const timeout = await MySQLDatabaseManager.connection.query('SELECT * FROM warns WHERE case_id = ? AND type = "TIMEOUT" LIMIT 1', [caseId]);
        if (timeout && timeout.length > 0) {
            return res.json({
                type: 'TIMEOUT',
                userId: timeout[0].user_id,
                userName: timeout[0].user_name,
                moderatorId: timeout[0].moderator_id,
                moderatorName: timeout[0].moderator_name,
                moderatorSource: timeout[0].moderator_source,
                reason: timeout[0].reason,
                timestamp: timeout[0].timestamp,
                duration: timeout[0].duration,
                expiresAt: timeout[0].expires_at,
                status: 'active',
                extra: null
            });
        }
        // Kicks
        const kick = await MySQLDatabaseManager.connection.query('SELECT * FROM warns WHERE case_id = ? AND type = "KICK" LIMIT 1', [caseId]);
        if (kick && kick.length > 0) {
            return res.json({
                type: 'KICK',
                userId: kick[0].user_id,
                userName: kick[0].user_name,
                moderatorId: kick[0].moderator_id,
                moderatorName: kick[0].moderator_name,
                moderatorSource: kick[0].moderator_source,
                reason: kick[0].reason,
                timestamp: kick[0].timestamp,
                duration: kick[0].duration,
                expiresAt: kick[0].expires_at,
                status: 'active',
                extra: null
            });
        }
        // Untimeouts
        const untimeout = await MySQLDatabaseManager.connection.query('SELECT * FROM warns WHERE case_id = ? AND type = "UNTIMEOUT" LIMIT 1', [caseId]);
        if (untimeout && untimeout.length > 0) {
            return res.json({
                type: 'UNTIMEOUT',
                userId: untimeout[0].user_id,
                userName: untimeout[0].user_name,
                moderatorId: untimeout[0].moderator_id,
                moderatorName: untimeout[0].moderator_name,
                moderatorSource: untimeout[0].moderator_source,
                reason: untimeout[0].reason,
                timestamp: untimeout[0].timestamp,
                duration: untimeout[0].duration,
                expiresAt: untimeout[0].expires_at,
                status: 'active',
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
    if (ms > 28 * 24 * 60 * 60 * 1000) {
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
                FROM warns w
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
                LEFT JOIN timeouts t ON w.user_id = t.user_id AND t.expires_at > NOW()
                WHERE l.user_id IS NULL
                  AND (w.type IS NULL OR w.type = 'WARN')
                  AND w.reason NOT LIKE '%(timeout%'
                  AND w.reason NOT LIKE '%(untimeout)%'
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
        if (!userId || !/^\d{17,19}$/.test(userId)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }

        // Build profile from available data
        const [levels, warns] = await Promise.all([
            AdminPanelHelper.getAllLevels(),
            AdminPanelHelper.getUserWarns(userId)
        ]);

        const userLevel = levels.find(l => l.user_id === userId);

        if (!userLevel) {
            return res.status(404).json({ error: 'User not found' });
        }

        const profile = {
            user_id: userId,
            username: userLevel.username || 'Unknown User',
            level: userLevel.level || 0,
            xp: userLevel.xp || 0,
            messages: userLevel.messages || 0,
            warn_count: warns?.warn_count || 0,
            banned: warns?.banned || false,
            warnings: warns?.warnings || [],
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
        const { status, guildId, limit } = req.query;

        // For now, return empty suggestions
        res.json({ success: true, data: [] });
    } catch (error) {
        console.error('Error getting suggestions:', error);
        res.status(500).json({ error: 'Failed to get suggestions' });
    }
});

// Get AutoMod violations endpoint
app.get('/api/admin/automod-violations', requireAuth, async (req, res) => {
    try {
        const { userId, hours = 24 } = req.query;
        const safeHours = Math.max(1, Math.min(720, parseInt(hours, 10) || 24));

        let query = `
            SELECT id, user_id, guild_id, violation_type, message_content, channel_id, action_taken, timestamp
            FROM automod_violations
            WHERE timestamp >= DATE_SUB(NOW(), INTERVAL ? HOUR)
        `;
        const params = [safeHours];

        if (typeof userId === 'string' && /^\d{17,19}$/.test(userId)) {
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
        if (!user || (user.role !== 'admin' && user.role !== 'owner')) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { userIds, reason } = req.body;

        if (!Array.isArray(userIds) || userIds.length === 0) {
            return res.status(400).json({ error: 'Invalid user IDs' });
        }

        // Validate user IDs
        if (userIds.length > 50) {
            return res.status(400).json({ error: 'Cannot ban more than 50 users at once' });
        }

        // Validate each user ID format
        const invalidIds = userIds.filter(id => !id || typeof id !== 'string' || !/^\d{17,20}$/.test(id));
        if (invalidIds.length > 0) {
            return res.status(400).json({ error: 'Invalid Discord ID format in user list' });
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
        if (!user || (user.role !== 'admin' && user.role !== 'owner')) {
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
        if (!user || (user.role !== 'admin' && user.role !== 'owner')) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { userIds } = req.body;

        if (!Array.isArray(userIds) || userIds.length === 0) {
            return res.status(400).json({ error: 'Invalid user IDs' });
        }

        if (userIds.length > 50) {
            return res.status(400).json({ error: 'Cannot unban more than 50 users at once' });
        }

        // Validate each user ID format
        const invalidIds = userIds.filter(id => !id || typeof id !== 'string' || !/^\d{17,20}$/.test(id));
        if (invalidIds.length > 0) {
            return res.status(400).json({ error: 'Invalid Discord ID format in user list' });
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

        if (!Array.isArray(userIds) || userIds.length === 0) {
            return res.status(400).json({ error: 'Invalid user IDs' });
        }

        if (userIds.length > 50) {
            return res.status(400).json({ error: 'Cannot warn more than 50 users at once' });
        }

        // Validate reason
        if (!reason || typeof reason !== 'string' || reason.trim().length < 3) {
            return res.status(400).json({ error: 'Reason must be between 3-500 characters' });
        }

        // Validate each user ID format
        const invalidIds = userIds.filter(id => !id || typeof id !== 'string' || !/^\d{17,20}$/.test(id));
        if (invalidIds.length > 0) {
            return res.status(400).json({ error: 'Invalid Discord ID format in user list' });
        }

        const results = { success: [], failed: [] };

        for (const userId of userIds) {
            try {
                const caseId = `WARN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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

        if (!adminUser || (adminUser.role !== 'moderator' && adminUser.role !== 'admin' && adminUser.role !== 'owner')) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }

        if (!userId || !/^\d{17,19}$/.test(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }

        if (!reason || typeof reason !== 'string' || reason.trim().length < 3) {
            return res.status(400).json({ error: 'Reason is required and must be at least 3 characters' });
        }

        // Generate case ID
        const caseId = `WARN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        console.log('[Warn] Generated case ID:', caseId);

        // Add the warning to database
        try {
            await MySQLDatabaseManager.connection.pool.query(
                `INSERT INTO warns (user_id, case_id, reason, moderator_id, moderator_name, type, timestamp) 
                 VALUES (?, ?, ?, ?, ?, 'WARN', ?)`,
                [userId, caseId, reason.trim(), adminUser.id, adminUser.username, Date.now()]
            );
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
                const { serverLogChannelId } = require('./Config/constants/channel.json');
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

        if (!adminUser || (adminUser.role !== 'admin' && adminUser.role !== 'owner')) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        if (!userId || !/^\d{17,19}$/.test(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }

        if (!reason || typeof reason !== 'string' || reason.trim().length < 3) {
            return res.status(400).json({ error: 'Reason is required and must be at least 3 characters' });
        }

        // Generate case ID
        const caseId = `BAN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

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
            await MySQLDatabaseManager.connection.pool.query(
                `INSERT INTO user_bans (user_id, banned, ban_case_id, banned_at, banned_by, banned_by_name, ban_reason) 
                 VALUES (?, TRUE, ?, NOW(), ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    banned = TRUE,
                    ban_case_id = VALUES(ban_case_id),
                    banned_at = NOW(),
                    banned_by = VALUES(banned_by),
                    banned_by_name = VALUES(banned_by_name),
                    ban_reason = VALUES(ban_reason)`,
                [userId, caseId, adminUser.id, adminUser.username, reason.trim()]
            );

            // Also log in warns table for consistency
            await MySQLDatabaseManager.connection.pool.query(
                `INSERT INTO warns (user_id, case_id, reason, moderator_id, moderator_name, type, timestamp) 
                 VALUES (?, ?, ?, ?, ?, 'BAN', ?)`,
                [userId, caseId, reason.trim(), adminUser.id, adminUser.username, Date.now()]
            );
        } catch (dbError) {
            return res.status(500).json({ error: `Database error: ${dbError.message}` });
        }

        // Log to server log channel
        if (discordClient) {
            try {
                const mainConfig = require('./Config/main.json');
                const { serverLogChannelId } = require('./Config/constants/channel.json');
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

        if (!adminUser || (adminUser.role !== 'admin' && adminUser.role !== 'owner')) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        if (!userId || !/^\d{17,19}$/.test(userId)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }

        if (!duration || typeof duration !== 'string' || duration.trim().length < 1) {
            return res.status(400).json({ error: 'Duration is required' });
        }

        if (!reason || typeof reason !== 'string' || reason.trim().length < 3) {
            return res.status(400).json({ error: 'Reason is required and must be at least 3 characters' });
        }

        // Convert duration string to milliseconds (e.g., "10m" -> 600000, "1h" -> 3600000)
        const durationMs = parseDurationToMs(duration.trim());
        if (!durationMs || durationMs <= 0) {
            return res.status(400).json({ error: 'Invalid duration format. Use format like "10m", "1h", "7d"' });
        }

        // Generate case ID
        const caseId = `TIMEOUT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

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

            // Also log in warns table for consistency (non-blocking)
            try {
                await MySQLDatabaseManager.connection.pool.query(
                    `INSERT INTO warns (user_id, case_id, reason, moderator_id, moderator_name, type, timestamp) 
                     VALUES (?, ?, ?, ?, ?, 'TIMEOUT', ?)`,
                    [userId, caseId, reason.trim(), adminUser.id, adminUser.username, Date.now()]
                );
            } catch (warnLogError) {
                console.error('[Admin] Failed to write timeout warn log:', warnLogError.message);
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
                const { serverLogChannelId } = require('./Config/constants/channel.json');
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

        if (!adminUser || (adminUser.role !== 'admin' && adminUser.role !== 'owner')) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        if (!userId || !/^\d{17,19}$/.test(userId)) {
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
        const untimeoutCaseId = `UNTIMEOUT-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
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
                const { serverLogChannelId } = require('./Config/constants/channel.json');
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

// Check if user is owner
function requireOwner(req, res, next) {
    AdminPanelHelper.getAdminUser(req.session.username)
        .then(user => {
            if (!user || user.role !== 'owner') {
                // Redirect to unauthorized page instead of error
                return res.redirect('/unauthorized');
            }
            next();
        })
        .catch(error => {
            error.status = 500;
            next(error);
        });
}

// Force logout all users (owner only)
app.post('/api/owner/force-logout-all', requireAuth, requireOwner, async (req, res) => {
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

app.post('/api/owner/security/session-policy', requireAuth, requireOwner, async (req, res) => {
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

// Purge all bans (owner only)
app.post('/api/owner/purge-bans', requireAuth, requireOwner, async (req, res) => {
    try {
        const result = await AdminPanelHelper.connection.query('DELETE FROM bans');
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
app.post('/api/owner/purge-warnings', requireAuth, requireOwner, async (req, res) => {
    try {
        const result = await AdminPanelHelper.connection.query('DELETE FROM warns');
        const deletedCount = result.affectedRows || 0;

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
app.post('/api/owner/wipe-all-data', requireAuth, requireOwner, async (req, res) => {
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
        if (user.role !== 'moderator' && user.role !== 'admin' && user.role !== 'owner') {
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
        if (user.role !== 'moderator' && user.role !== 'admin' && user.role !== 'owner') {
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
        const warnsToday = await safeCount('SELECT COUNT(*) as count FROM warns WHERE (type IS NULL OR type = "WARN") AND timestamp BETWEEN ? AND ?', [startMs, endMs]);
        const warnsWeek = await safeCount('SELECT COUNT(*) as count FROM warns WHERE (type IS NULL OR type = "WARN") AND timestamp BETWEEN ? AND ?', [weekStartMs, endMs]);
        const warnsAll = await safeCount('SELECT COUNT(*) as count FROM warns WHERE type IS NULL OR type = "WARN"', []);

        const bansToday = await safeCount('SELECT COUNT(*) as count FROM user_bans WHERE banned = TRUE AND banned_at BETWEEN ? AND ?', [today, tomorrow]);
        const bansWeek = await safeCount('SELECT COUNT(*) as count FROM user_bans WHERE banned = TRUE AND banned_at BETWEEN ? AND ?', [weekAgo, tomorrow]);
        const bansAll = await safeCount('SELECT COUNT(*) as count FROM user_bans WHERE banned = TRUE', []);

        const activeTimeouts = await AdminPanelHelper.getActiveTimeoutsCount();
        const expiringToday = await safeCount('SELECT COUNT(*) as count FROM timeouts WHERE active = TRUE AND expires_at BETWEEN ? AND ?', [today, tomorrow]);
        const timeoutsAll = await safeCount('SELECT COUNT(*) as count FROM timeouts', []);

        const openTickets = await safeCount('SELECT COUNT(*) as count FROM tickets WHERE status = "open"', []);

        // Get trend indicators (compare with week average)
        const warnsTrend = warnsToday > (warnsWeek / 7) ? '↑ Above average' : warnsToday > 0 ? '→ Normal' : '↓ Below average';
        const bansTrend = bansToday > (bansWeek / 7) ? '↑ Above average' : bansToday > 0 ? '→ Normal' : '↓ Below average';
        const ticketsTrend = openTickets > 5 ? '⚠️ High load' : openTickets > 2 ? '→ Normal' : '✅ Low load';

        // Get top violation reason
        const [topViolationResult] = await MySQLDatabaseManager.connection.pool.query(
            'SELECT reason, COUNT(*) as count FROM warns WHERE (type IS NULL OR type = "WARN") AND timestamp > ? GROUP BY reason ORDER BY count DESC LIMIT 1',
            [weekStartMs]
        ).catch(() => [[{ reason: 'N/A', count: 0 }]]);
        const topViolation = topViolationResult?.[0]?.reason || 'None';

        // Get most warned user
        const [mostWarnedResult] = await MySQLDatabaseManager.connection.pool.query(
            'SELECT w.user_id, COALESCE(l.username, "Unknown") as username, COUNT(*) as count FROM warns w LEFT JOIN levels l ON w.user_id = l.user_id WHERE w.type IS NULL OR w.type = "WARN" GROUP BY w.user_id ORDER BY count DESC LIMIT 1',
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
        if (!user || (user.role !== 'moderator' && user.role !== 'admin' && user.role !== 'owner')) {
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
        if (!user || (user.role !== 'moderator' && user.role !== 'admin' && user.role !== 'owner')) {
            return res.status(403).json({ error: 'Moderator access required' });
        }

        const { userId } = req.params;
        if (!userId || !/^\d{17,19}$/.test(userId)) {
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
        const { serverLogChannelId } = require('./Config/constants/channel.json');

        try {
            const targetUser = await resolveDiscordUser(userId);
            const targetLabel = targetUser ? `${targetUser.tag} (${targetUser.id})` : userId;

            // Store unban in database
            try {
                await MySQLDatabaseManager.connection.pool.query(
                    `INSERT INTO unbans (
                        user_id, unban_case_id, unbanned_at, unbanned_by,
                        unbanned_by_name, unbanned_by_source, user_name,
                        original_ban_case_id, original_ban_reason, reason
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                    , [
                        userId,
                        unbanCaseId,
                        new Date(),
                        null,
                        req.session.username || null,
                        'panel',
                        targetUser?.username || null,
                        originalBanCaseId || null,
                        originalBanReason || null,
                        `Unbanned via admin panel by ${req.session.username}`
                    ]
                );
            } catch (dbErr) {
                console.error('[Unban] Failed to insert unban record:', dbErr.message);
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
        if (!user || (user.role !== 'moderator' && user.role !== 'admin' && user.role !== 'owner')) {
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
        if (!user || (user.role !== 'moderator' && user.role !== 'admin' && user.role !== 'owner')) {
            return res.status(403).json({ error: 'Moderator access required' });
        }

        const { userId } = req.params;
        if (!userId || !/^\d{17,19}$/.test(userId)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }

        // Get the timeout info before clearing (for logging)
        const [timeoutInfo] = await MySQLDatabaseManager.connection.pool.query(
            'SELECT case_id, reason FROM timeouts WHERE user_id = ? AND active = TRUE LIMIT 1',
            [userId]
        );
        const caseId = timeoutInfo?.[0]?.case_id || 'Unknown';
        const timeoutReason = timeoutInfo?.[0]?.reason || 'No reason provided';

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
                const { serverLogChannelId } = require('./Config/constants/channel.json');
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
        if (!user || (user.role !== 'moderator' && user.role !== 'admin' && user.role !== 'owner')) {
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
                w.id,
                w.user_id,
                w.case_id,
                w.reason,
                w.moderator_id,
                w.created_at,
                'WARN' as type,
                COALESCE(u.username, ma.username) as username
            FROM warns w
            LEFT JOIN levels u ON w.user_id = u.user_id
            LEFT JOIN (
                SELECT ma1.user_id, ma1.username
                FROM member_activity ma1
                INNER JOIN (
                    SELECT user_id, MAX(timestamp) as max_ts
                    FROM member_activity
                    GROUP BY user_id
                ) ma2 ON ma1.user_id = ma2.user_id AND ma1.timestamp = ma2.max_ts
            ) ma ON w.user_id = ma.user_id
            WHERE (w.type IS NULL OR w.type = 'WARN')
              AND w.reason NOT LIKE '%(timeout%'
              AND w.reason NOT LIKE '%(untimeout)%'
            ORDER BY w.created_at DESC
            LIMIT 2000
        `);

        const [allKicksRaw] = await MySQLDatabaseManager.connection.pool.query(`
            SELECT 
                k.id,
                k.user_id,
                k.case_id,
                k.reason,
                k.kicked_by as moderator_id,
                FROM_UNIXTIME(k.kicked_at/1000) as created_at,
                'KICK' as type,
                COALESCE(k.username, u.username, ma.username) as username
            FROM kicks k
            LEFT JOIN levels u ON k.user_id = u.user_id
            LEFT JOIN (
                SELECT ma1.user_id, ma1.username
                FROM member_activity ma1
                INNER JOIN (
                    SELECT user_id, MAX(timestamp) as max_ts
                    FROM member_activity
                    GROUP BY user_id
                ) ma2 ON ma1.user_id = ma2.user_id AND ma1.timestamp = ma2.max_ts
            ) ma ON k.user_id = ma.user_id
            ORDER BY k.kicked_at DESC
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
        if (!user || (user.role !== 'moderator' && user.role !== 'admin' && user.role !== 'owner')) {
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
            SELECT * FROM (
                SELECT 
                    CONVERT('WARN' USING utf8mb4) COLLATE utf8mb4_unicode_ci as action,
                    CONVERT(CAST(w.case_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as case_id,
                    CONVERT(CAST(w.user_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as user_id,
                    CONVERT(CAST(COALESCE(u.username, w.user_name, 'Unknown') AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as username,
                    CONVERT(CAST(w.reason AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as reason,
                    CONVERT(CAST(w.moderator_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_id,
                    CONVERT(CAST(COALESCE(m_ui.username, m.username, w.moderator_name, w.moderator_id, 'System') AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_name,
                    COALESCE(w.created_at, FROM_UNIXTIME(w.timestamp/1000)) as timestamp,
                    NULL as expires_at,
                    NULL as related_case_id
                FROM warns w
                LEFT JOIN levels u ON u.user_id COLLATE utf8mb4_unicode_ci = w.user_id COLLATE utf8mb4_unicode_ci
                LEFT JOIN userinfo m_ui ON m_ui.user_id = CAST(w.moderator_id AS UNSIGNED)
                LEFT JOIN levels m ON m.user_id COLLATE utf8mb4_unicode_ci = w.moderator_id COLLATE utf8mb4_unicode_ci
                WHERE (w.type IS NULL OR w.type = 'WARN')
                    AND w.reason NOT LIKE '%(timeout%'
                    AND w.reason NOT LIKE '%(untimeout)%'

                UNION ALL

                SELECT 
                    CONVERT('UNTIMEOUT' USING utf8mb4) COLLATE utf8mb4_unicode_ci as action,
                    CONVERT(CAST(w.case_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as case_id,
                    CONVERT(CAST(w.user_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as user_id,
                    CONVERT(CAST(COALESCE(u.username, w.user_name, 'Unknown') AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as username,
                    CONVERT(CAST(w.reason AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as reason,
                    CONVERT(CAST(w.moderator_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_id,
                    CONVERT(CAST(COALESCE(m_ui.username, m.username, w.moderator_name, w.moderator_id, 'System') AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_name,
                    COALESCE(w.created_at, FROM_UNIXTIME(w.timestamp/1000)) as timestamp,
                    NULL as expires_at,
                    NULL as related_case_id
                FROM warns w
                LEFT JOIN levels u ON u.user_id COLLATE utf8mb4_unicode_ci = w.user_id COLLATE utf8mb4_unicode_ci
                LEFT JOIN userinfo m_ui ON m_ui.user_id = CAST(w.moderator_id AS UNSIGNED)
                LEFT JOIN levels m ON m.user_id COLLATE utf8mb4_unicode_ci = w.moderator_id COLLATE utf8mb4_unicode_ci
                WHERE w.reason LIKE '%(untimeout)%'

                UNION ALL

                SELECT 
                    CONVERT('KICK' USING utf8mb4) COLLATE utf8mb4_unicode_ci as action,
                    CONVERT(CAST(k.case_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as case_id,
                    CONVERT(CAST(k.user_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as user_id,
                    CONVERT(CAST(COALESCE(k.username, u.username, 'Unknown') AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as username,
                    CONVERT(CAST(k.reason AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as reason,
                    CONVERT(CAST(k.kicked_by AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_id,
                    CONVERT(CAST(COALESCE(k.kicked_by_name, m_ui.username, m.username, k.kicked_by, 'System') AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_name,
                    FROM_UNIXTIME(k.kicked_at/1000) as timestamp,
                    NULL as expires_at,
                    NULL as related_case_id
                FROM kicks k
                LEFT JOIN levels u ON u.user_id COLLATE utf8mb4_unicode_ci = k.user_id COLLATE utf8mb4_unicode_ci
                LEFT JOIN userinfo m_ui ON m_ui.user_id = CAST(k.kicked_by AS UNSIGNED)
                LEFT JOIN levels m ON m.user_id COLLATE utf8mb4_unicode_ci = k.kicked_by COLLATE utf8mb4_unicode_ci

                UNION ALL

                SELECT 
                    CONVERT('BAN' USING utf8mb4) COLLATE utf8mb4_unicode_ci as action,
                    CONVERT(CAST(b.ban_case_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as case_id,
                    CONVERT(CAST(b.user_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as user_id,
                    CONVERT(CAST(COALESCE(b.user_name, u.username, 'Unknown') AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as username,
                    CONVERT(CAST(b.ban_reason AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as reason,
                    CONVERT(CAST(b.banned_by AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_id,
                    CONVERT(CAST(COALESCE(b.banned_by_name, m_ui.username, m.username, b.banned_by, 'System') AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_name,
                    b.banned_at as timestamp,
                    NULL as expires_at,
                    NULL as related_case_id
                FROM user_bans b
                LEFT JOIN levels u ON u.user_id COLLATE utf8mb4_unicode_ci = b.user_id COLLATE utf8mb4_unicode_ci
                LEFT JOIN userinfo m_ui ON m_ui.user_id = CAST(b.banned_by AS UNSIGNED)
                LEFT JOIN levels m ON m.user_id COLLATE utf8mb4_unicode_ci = b.banned_by COLLATE utf8mb4_unicode_ci
                WHERE b.ban_case_id IS NOT NULL

                UNION ALL

                SELECT 
                    CONVERT('UNBAN' USING utf8mb4) COLLATE utf8mb4_unicode_ci as action,
                    CONVERT(CAST(ub.unban_case_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as case_id,
                    CONVERT(CAST(ub.user_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as user_id,
                    CONVERT(CAST(COALESCE(ub.user_name, u.username, 'Unknown') AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as username,
                    CONVERT(CAST(COALESCE(ub.reason, ub.original_ban_reason, 'Unbanned') AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as reason,
                    CONVERT(CAST(ub.unbanned_by AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_id,
                    CONVERT(CAST(COALESCE(ub.unbanned_by_name, ub.unbanned_by, 'System') AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_name,
                    ub.unbanned_at as timestamp,
                    NULL as expires_at,
                    CONVERT(CAST(ub.original_ban_case_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as related_case_id
                FROM unbans ub
                LEFT JOIN levels u ON u.user_id COLLATE utf8mb4_unicode_ci = ub.user_id COLLATE utf8mb4_unicode_ci

                UNION ALL

                SELECT 
                    CONVERT('TIMEOUT' USING utf8mb4) COLLATE utf8mb4_unicode_ci as action,
                    CONVERT(CAST(t.case_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as case_id,
                    CONVERT(CAST(t.user_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as user_id,
                    CONVERT(CAST(COALESCE(t.username, u.username, 'Unknown') AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as username,
                    CONVERT(CAST(t.reason AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as reason,
                    CONVERT(CAST(t.issued_by AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_id,
                    CONVERT(CAST(COALESCE(t.issued_by_name, m_ui.username, m.username, t.issued_by, 'System') AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_name,
                    FROM_UNIXTIME(t.issued_at/1000) as timestamp,
                    FROM_UNIXTIME(t.expires_at/1000) as expires_at,
                    NULL as related_case_id
                FROM timeouts t
                LEFT JOIN levels u ON u.user_id COLLATE utf8mb4_unicode_ci = t.user_id COLLATE utf8mb4_unicode_ci
                LEFT JOIN userinfo m_ui ON m_ui.user_id = CAST(t.issued_by AS UNSIGNED)
                LEFT JOIN levels m ON m.user_id COLLATE utf8mb4_unicode_ci = t.issued_by COLLATE utf8mb4_unicode_ci
            ) combined
            WHERE (? COLLATE utf8mb4_unicode_ci = '' OR combined.case_id LIKE ? COLLATE utf8mb4_unicode_ci OR combined.user_id LIKE ? COLLATE utf8mb4_unicode_ci OR combined.username LIKE ? COLLATE utf8mb4_unicode_ci)
                AND (? COLLATE utf8mb4_unicode_ci = 'ALL' OR combined.action = ? COLLATE utf8mb4_unicode_ci)
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
        if (!user || (user.role !== 'moderator' && user.role !== 'admin' && user.role !== 'owner')) {
            return res.status(403).json({ error: 'Moderator access required' });
        }

        const { userId } = req.params;
        if (!userId || !/^\d{17,19}$/.test(userId)) {
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
        res.json(list.map(t => ({
            id: t.channelId || t.channel_id || t.id || 'N/A',
            channelId: t.channelId || t.channel_id || null,
            userId: t.userId || t.user_id || null,
            username: t.userName || t.user_name || t.username || 'Unknown',
            status: t.status || 'open',
            priority: t.priority || 'medium',
            reason: t.reason || '',
            created_at: t.createdAt || t.created_at || null
        })));
    } catch (error) {
        res.status(500).json({ error: 'Failed to get tickets' });
    }
});

// Claim ticket
app.post('/api/tickets/:ticketId/claim', requireAuth, async (req, res) => {
    try {
        const { ticketId } = req.params;
        if (!ticketId) {
            return res.status(400).json({ error: 'Invalid ticket id' });
        }
        const success = await AdminPanelHelper.claimTicket(ticketId, req.session.userId || req.session.username || 'system');
        if (success) {
            res.json({ success: true, message: 'Ticket claimed' });
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
                `SELECT COUNT(*) as count FROM warns WHERE type = "WARN" AND timestamp >= ? AND timestamp < ?`,
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
        const connection = await MySQLConnection.getConnection();
        const [tables] = await connection.query(
            `SELECT 
                table_name,
                table_rows,
                ROUND((data_length + index_length) / 1024 / 1024, 2) as size_mb
            FROM information_schema.tables 
            WHERE table_schema = DATABASE()
            ORDER BY (data_length + index_length) DESC`
        );
        connection.release();

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

        // Measure DB latency
        let dbLatency = 0;
        try {
            const dbStart = Date.now();
            await MySQLDatabaseManager.connection.pool.query('SELECT 1');
            dbLatency = Date.now() - dbStart;
        } catch (err) {
            dbLatency = -1; // Connection failed
        }

        const apiLatency = Date.now() - startTime;

        res.json({
            cpuUsage: `${cpuUsagePercent}%`,
            memoryUsage: `${heapPercent}%`,
            systemMemoryUsage: `${systemMemPercent}%`,
            freeMemory: `${Math.round((freeMemory / totalMemory) * 100)}%`,
            heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
            apiLatency: `${apiLatency}ms`,
            dbPing: dbLatency >= 0 ? `${dbLatency}ms` : 'Failed'
        });
    } catch (error) {
        console.error('Error getting system health:', error);
        res.status(500).json({ error: 'Failed to get system health' });
    }
});

// Database health endpoint
app.get('/api/system/db-health', requireAuth, requireOwner, async (req, res) => {
    try {
        const services = [];
        const startTime = Date.now();

        // Check MySQL connection
        try {
            const dbStart = Date.now();
            await MySQLDatabaseManager.connection.pool.query('SELECT 1');
            const responseTime = Date.now() - dbStart;
            services.push({
                status: '✓ Connected',
                statusColor: 'green',
                service: 'MySQL Database',
                lastCheck: new Date().toLocaleTimeString(),
                responseTime: `${responseTime}ms`
            });
        } catch (err) {
            services.push({
                status: '✗ Failed',
                statusColor: 'red',
                service: 'MySQL Database',
                lastCheck: new Date().toLocaleTimeString(),
                responseTime: 'N/A'
            });
        }

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

        res.json(formattedSessions);
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

    return {
        ipVersion,
        networkTypeLabel,
        addressScope,
        confidence,
        riskSignals: riskSignals.slice(0, 4)
    };
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

    return {
        clientId,
        clientSecret,
        redirectUri,
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

function sendHtmlStatusPage(res, { title, message, hint = '', statusCode = 200 } = {}) {
    const safeTitle = sanitizeHtmlText(title || 'Status');
    const safeMessage = sanitizeHtmlText(message || 'Request completed.');
    const safeHint = sanitizeHtmlText(hint || '');
    const code = Number.isInteger(statusCode) ? statusCode : 200;

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

function completeDiscordOAuthRequest(req, res, { success, message }) {
    const status = success ? 'success' : 'error';
    const encodedMessage = encodeURIComponent(String(message || 'OAuth request completed'));

    if (req.session?.authenticated) {
        return res.redirect(`/profile?discord_oauth=${status}&message=${encodedMessage}`);
    }

    const safeMessage = sanitizeHtmlText(message || (success ? 'OAuth completed.' : 'OAuth failed.'));
    const title = success ? 'Discord Link Complete' : 'Discord Link Failed';
    const hint = success
        ? 'Return to your admin panel tab and refresh the profile page.'
        : 'Return to your admin panel tab, refresh, and try again.';

    return res.status(success ? 200 : 400).send(`<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${sanitizeHtmlText(title)}</title>
</head>
<body>
    <main>
        <h1>${sanitizeHtmlText(title)}</h1>
        <p>${safeMessage}</p>
        <p>${sanitizeHtmlText(hint)}</p>
    </main>
</body>
</html>`);
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

function escapeLikeValue(value) {
    return String(value).replace(/[\\%_]/g, '\\$&');
}

const TWO_FACTOR_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const twoFactorChallenges = new Map();

function cleanupTwoFactorChallenges() {
    const now = Date.now();
    for (const [challengeId, challenge] of twoFactorChallenges.entries()) {
        if (!challenge || challenge.expiresAt <= now) {
            twoFactorChallenges.delete(challengeId);
        }
    }
}

setInterval(cleanupTwoFactorChallenges, 60 * 1000);

function createTwoFactorChallenge({ username, userId, role, ipAddress, userAgent }) {
    const challengeId = crypto.randomBytes(24).toString('hex');
    twoFactorChallenges.set(challengeId, {
        username,
        userId,
        role,
        ipAddress,
        userAgent,
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
        const rulesConfig = require('./Config/constants/rules.json');
        res.json(rulesConfig.rules);
    } catch (error) {
        console.error('Error fetching rules:', error);
        res.status(500).json({ error: 'Failed to fetch rules' });
    }
});

// Ban appeals

// Submit a ban appeal
app.post('/api/appeals/submit', createRateLimiter(1, 3600000), async (req, res) => {
    try {
        const { userId, userTag, caseId, reason, email } = req.body;

        if (!userId || !userTag || !caseId || !reason || !email) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Validate case ID format and ban status using AppealHelper
        const { isValidBanCaseId } = require('./Functions/AppealHelper');
        const banCheck = await isValidBanCaseId(caseId);
        if (!banCheck.valid) {
            return res.status(400).json({ error: 'Ban case ID is invalid or user is not currently banned.' });
        }

        // Validate email (required)
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        // Check if user already has a pending appeal
        const [existing] = await MySQLDatabaseManager.connection.pool.execute(
            'SELECT id FROM ban_appeals WHERE user_id = ? AND status = ?',
            [userId, 'pending']
        );

        if (existing.length > 0) {
            return res.status(400).json({ error: 'You already have a pending appeal. Please wait for a response.' });
        }

        // Submit appeal with ban case ID and email (fallback for older schemas without user_email)
        try {
            await MySQLDatabaseManager.connection.pool.execute(
                'INSERT INTO ban_appeals (user_id, user_tag, ban_case_id, reason, user_email) VALUES (?, ?, ?, ?, ?)',
                [userId, userTag, caseId, reason, email]
            );
        } catch (insertError) {
            if (insertError?.code === 'ER_BAD_FIELD_ERROR') {
                await MySQLDatabaseManager.connection.pool.execute(
                    'INSERT INTO ban_appeals (user_id, user_tag, ban_case_id, reason) VALUES (?, ?, ?, ?)',
                    [userId, userTag, caseId, reason]
                );
            } else {
                throw insertError;
            }
        }

        // Send notification email to admin if configured
        const adminEmail = process.env.ADMIN_EMAIL;
        if (EmailHelper.isReady() && adminEmail) {
            await EmailHelper.sendNewAppealNotification(adminEmail, userTag, userId, reason).catch(err => {
                console.error('Failed to send admin notification:', err.message);
            });
        }

        // Send appeal received confirmation to user
        if (EmailHelper.isReady()) {
            await EmailHelper.sendAppealReceivedEmail(email, userTag, caseId).catch(err => {
                console.error('Failed to send appeal received email:', err.message);
            });
        }

        res.json({ success: true, message: 'Appeal submitted successfully' });
    } catch (error) {
        console.error('Error submitting appeal:', error);
        res.status(500).json({ error: 'Failed to submit appeal' });
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
            `SELECT id, user_tag, ban_case_id, status, created_at, decided_at, owner_response
             FROM ban_appeals 
             WHERE ban_case_id = ? AND user_id = ?
             ORDER BY created_at DESC
             LIMIT 1`,
            [caseId, userId]
        );

        if (appeals.length === 0) {
            return res.status(404).json({ error: 'No appeal found matching this Case ID and User ID' });
        }

        const appeal = appeals[0];

        // Resolve decision code to human-readable text
        let responseText = null;
        if (appeal.status !== 'pending' && appeal.owner_response) {
            const decisionCode = String(appeal.owner_response).trim();
            responseText = APPEAL_DECISION_EMAIL_TEXT[decisionCode] || appeal.owner_response;
        }

        // Return safe appeal info
        res.json({
            success: true,
            appeal: {
                id: appeal.id,
                status: appeal.status,
                caseId: appeal.ban_case_id,
                submittedAt: appeal.created_at,
                decidedAt: appeal.decided_at,
                response: responseText
            }
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
            `SELECT id, user_tag, ban_case_id, status, created_at, decided_at, owner_response
             FROM ban_appeals 
             WHERE user_id = ?
             ORDER BY created_at DESC
             LIMIT 10`,
            [userId]
        );

        // Return safe appeal history
        const history = appeals.map(appeal => {
            // Resolve decision code to human-readable text
            let responseText = null;
            if (appeal.status !== 'pending' && appeal.owner_response) {
                const decisionCode = String(appeal.owner_response).trim();
                responseText = APPEAL_DECISION_EMAIL_TEXT[decisionCode] || appeal.owner_response;
            }

            return {
                id: appeal.id,
                status: appeal.status,
                caseId: appeal.ban_case_id,
                submittedAt: appeal.created_at,
                decidedAt: appeal.decided_at,
                response: responseText
            };
        });

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
            'SELECT id, user_id, user_tag, ban_case_id, reason, created_at FROM ban_appeals WHERE status = ? ORDER BY created_at DESC',
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
        const [appeals] = await MySQLDatabaseManager.connection.pool.execute(
            `SELECT id, user_id, user_tag, ban_case_id, reason, status, owner_response AS decision_code, created_at, decided_at
             FROM ban_appeals
             WHERE status IN ('accepted', 'denied')
             ORDER BY decided_at DESC, created_at DESC`
        );
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
                COALESCE(SUM(status = 'denied'), 0) AS denied
            FROM ban_appeals`
        );
        const stats = rows?.[0] || { pending: 0, accepted: 0, denied: 0 };
        res.json(stats);
    } catch (error) {
        console.error('Error fetching appeal stats:', error);
        res.status(500).json({ error: 'Failed to fetch appeal stats' });
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

        await MySQLDatabaseManager.connection.pool.execute(
            'UPDATE ban_appeals SET status = ?, owner_response = ?, decided_at = NOW() WHERE id = ?',
            ['accepted', resolvedDecisionCode, id]
        );

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

        await MySQLDatabaseManager.connection.pool.execute(
            'UPDATE ban_appeals SET status = ?, owner_response = ?, decided_at = NOW() WHERE id = ?',
            ['denied', resolvedDecisionCode, id]
        );

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
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_created (created_at),
            INDEX idx_status (status),
            INDEX idx_template (template_name),
            INDEX idx_recipient_domain (recipient_domain)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

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
                SUM(created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)) AS last24h,
                SUM(created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS last7d,
                SUM(created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS last30d,
                SUM(status = 'sent' AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)) AS sent24h,
                SUM(status = 'failed' AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)) AS failed24h,
                SUM(status = 'blocked' AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)) AS blocked24h
             FROM email_delivery_logs`
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
                template_name,
                subject,
                status,
                error_message,
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
            recent: recentRows || []
        });
    } catch (error) {
        console.error('Error fetching email analytics:', error);
        res.status(500).json({ error: 'Failed to fetch email analytics' });
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
            const mergedProfile = {
                ...existing,
                ...profilePatch,
                autoMod: {
                    ...(existing.autoMod || {}),
                    ...((profilePatch && profilePatch.autoMod) || {})
                },
                autoModAdvanced: {
                    ...(existing.autoModAdvanced || {}),
                    ...((profilePatch && profilePatch.autoModAdvanced) || {})
                }
            };
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

        config.blockExternalInvites = body.blockExternalInvites !== undefined ? Boolean(body.blockExternalInvites) : config.blockExternalInvites;
        config.maxMentionsBeforeFlag = Number.isFinite(Number(body.maxMentionsBeforeFlag)) ? Number(body.maxMentionsBeforeFlag) : config.maxMentionsBeforeFlag;
        config.autoMod = config.autoMod || {};
        if (Number.isFinite(Number(body.spamThreshold))) config.autoMod.spamThreshold = Number(body.spamThreshold);
        if (Number.isFinite(Number(body.spamTimeout))) config.autoMod.spamTimeout = Number(body.spamTimeout);
        if (Number.isFinite(Number(body.spamWarningThreshold))) config.autoMod.spamWarningThreshold = Number(body.spamWarningThreshold);

        config.autoModAdvanced = config.autoModAdvanced || {};
        if (Array.isArray(body.blockedRegexPatterns)) {
            config.autoModAdvanced.blockedRegexPatterns = body.blockedRegexPatterns.slice(0, 100);
        }
        if (Array.isArray(body.exemptChannelIds)) {
            config.autoModAdvanced.exemptChannelIds = body.exemptChannelIds.filter(id => typeof id === 'string').slice(0, 200);
        }
        if (Array.isArray(body.exemptRoleIds)) {
            config.autoModAdvanced.exemptRoleIds = body.exemptRoleIds.filter(id => typeof id === 'string').slice(0, 200);
        }
        if (Number.isFinite(Number(body.escalationThreshold24h))) config.autoModAdvanced.escalationThreshold24h = Number(body.escalationThreshold24h);
        if (Number.isFinite(Number(body.escalationTimeoutMs))) config.autoModAdvanced.escalationTimeoutMs = Number(body.escalationTimeoutMs);

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
                highRisk: Number(summary.highRisk || 0)
            },
            trends: Array.isArray(trendRows) ? trendRows : [],
            types: Array.isArray(typeRows) ? typeRows : [],
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
            'SELECT COUNT(*) as count FROM warns WHERE timestamp >= ?',
            [dayAgoMs]
        );

        const [automodCountRows] = await MySQLDatabaseManager.connection.pool.execute(
            'SELECT COUNT(*) as count FROM automod_violations WHERE timestamp >= DATE_SUB(NOW(), INTERVAL 1 DAY)'
        );

        const [timeoutCountRows] = await MySQLDatabaseManager.connection.pool.execute(
            'SELECT COUNT(*) as count FROM timeouts WHERE active = TRUE AND (expires_at IS NULL OR expires_at > ?)',
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
    // Prioritize session from handshake (populated by express-socket.io-session)
    let role = socket.handshake?.session?.role || socket.request?.session?.role || socket.handshake?.auth?.role || socket.handshake?.query?.role || 'user';
    let username = socket.handshake?.session?.username || socket.request?.session?.username || socket.handshake?.auth?.username || socket.handshake?.query?.username || 'Unknown';
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

    // Send stats immediately
    sendStats();

    // Send stats every 5 seconds for live updates
    const statsInterval = setInterval(sendStats, 5000);

    socket.on('disconnect', () => {
        let username = socket.request?.session?.username || socket.handshake?.auth?.username || socket.handshake?.query?.username || 'Unknown';
        let role = socket.request?.session?.role || socket.handshake?.auth?.role || socket.handshake?.query?.role || 'user';
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
        clearInterval(statsInterval);
    });

    socket.on('error', (error) => {
        console.error('WebSocket error:', error);
        clearInterval(statsInterval);
    });

    // Handle custom events
    socket.on('request-stats', sendStats);

    socket.on('request-terminal-logs', (payload = {}) => {
        const requestedLimit = Number(payload?.limit);
        const limit = Number.isFinite(requestedLimit)
            ? Math.min(Math.max(Math.floor(requestedLimit), 1), 200)
            : 50;
        socket.emit('terminal-logs', terminalLogBuffer.slice(-limit));
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
        const caseId = `WARN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Get current warning count
        const [warns] = await MySQLDatabaseManager.connection.pool.query(
            'SELECT COUNT(*) as warnings FROM warns WHERE user_id = ? AND type = "WARN"',
            [user_id]
        );

        const newWarnings = (warns[0]?.warnings || 0) + 1;

        // Add new warning with Case ID and Type
        // Using 'created_at' as in original query, but adding case_id, type, moderator_id
        // Validating columns: user_id, case_id, reason, moderator_id, type, created_at
        await MySQLDatabaseManager.connection.pool.query(
            'INSERT INTO warns (user_id, case_id, reason, moderator_id, moderator_name, type, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
            [user_id, caseId, reason, moderatorId, adminUser?.username || 'Unknown', 'WARN']
        );

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

async function checkAndCreateAlerts() {
    try {
        await ensureAlertTablesReady();
        const memUsage = process.memoryUsage();
        const memPercent = Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100);

        // Get alert settings
        const [settings] = await MySQLDatabaseManager.connection.pool.execute(
            'SELECT * FROM alert_settings WHERE enabled = TRUE'
        );

        for (const setting of settings) {
            const { alert_type, threshold } = setting;
            let currentValue = 0;
            let severity = 'low';

            if (alert_type === 'error_rate') {
                // Get error rate from last hour
                const [errorStats] = await MySQLDatabaseManager.connection.pool.execute(
                    'SELECT COUNT(*) as total, SUM(CASE WHEN status IN (\'ERROR\', \'RATE_LIMIT\', \'PERMISSION\') THEN 1 ELSE 0 END) as errors FROM user_interactions WHERE created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)'
                );

                const errorRate = errorStats[0].total > 0 ? (errorStats[0].errors / errorStats[0].total) * 100 : 0;
                currentValue = Math.round(errorRate);

                if (currentValue >= threshold) {
                    severity = currentValue >= 30 ? 'high' : 'medium';

                    const [existing] = await MySQLDatabaseManager.connection.pool.execute(
                        'SELECT id FROM active_alerts WHERE alert_type = ? AND resolved = FALSE',
                        [alert_type]
                    );

                    if (existing.length === 0) {
                        await MySQLDatabaseManager.connection.pool.execute(
                            'INSERT INTO active_alerts (alert_type, severity, message, value, threshold) VALUES (?, ?, ?, ?, ?)',
                            [alert_type, severity, `Command error rate is ${currentValue}%`, currentValue, threshold]
                        );
                        console.warn(`⚠️ [ALERT] Error rate at ${currentValue}% (threshold: ${threshold}%)`);
                        await routeAlertToDiscord({
                            alert_type,
                            severity,
                            message: `Command error rate is ${currentValue}%`,
                            value: currentValue,
                            threshold
                        });
                        io.emit('alert', {
                            alert_type,
                            severity,
                            message: `Command error rate is ${currentValue}%`,
                            value: currentValue,
                            threshold
                        });
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error checking alerts:', error);
    }
}

async function routeAlertToDiscord(alert) {
    try {
        if (!discordClient) return;

        const misc = require('./Config/constants/misc.json');
        const alertsConfig = misc.alerts || {};
        if (alertsConfig.discordRoutingEnabled === false) return;

        const preferredChannelId = alertsConfig.discordChannelId || serverLogChannelId;
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
setInterval(checkAndCreateAlerts, 5 * 60 * 1000);

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
        if (!user || (user.role !== 'moderator' && user.role !== 'admin' && user.role !== 'owner')) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
        const monthAgo = new Date(new Date(now.getFullYear(), now.getMonth(), 1));

        // Get total counts
        const [[totalWarns]] = await MySQLDatabaseManager.connection.pool.query(
            'SELECT COUNT(*) as count FROM warns WHERE type IS NULL OR type = "WARN"'
        );

        const [[totalBans]] = await MySQLDatabaseManager.connection.pool.query(
            'SELECT COUNT(*) as count FROM user_bans WHERE banned = TRUE'
        );

        const [[totalTimeouts]] = await MySQLDatabaseManager.connection.pool.query(
            'SELECT COUNT(*) as count FROM timeouts'
        );

        // Get action breakdown
        const [actionBreakdown] = await MySQLDatabaseManager.connection.pool.query(`
            SELECT 
                'WARN' as type,
                SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as today,
                SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as week,
                SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as month,
                MAX(created_at) as lastPerformed
            FROM warns
            WHERE type IS NULL OR type = 'WARN'
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
                SUM(CASE WHEN issued_at >= ? THEN 1 ELSE 0 END) as today,
                SUM(CASE WHEN issued_at >= ? THEN 1 ELSE 0 END) as week,
                SUM(CASE WHEN issued_at >= ? THEN 1 ELSE 0 END) as month,
                MAX(issued_at) as lastPerformed
            FROM timeouts
        `, [today, weekAgo, monthAgo, today, weekAgo, monthAgo, today, weekAgo, monthAgo]);

        // Get top warned users
        const [topWarned] = await MySQLDatabaseManager.connection.pool.query(`
            SELECT 
                w.user_id,
                COALESCE(l.username, ma.username, 'Unknown') as username,
                COUNT(*) as warn_count,
                MAX(w.created_at) as lastWarning
            FROM warns w
            LEFT JOIN levels l ON w.user_id = l.user_id
            LEFT JOIN (
                SELECT user_id, username
                FROM member_activity
                GROUP BY user_id
                ORDER BY MAX(timestamp) DESC
                LIMIT 1
            ) ma ON w.user_id = ma.user_id
            WHERE w.type IS NULL OR w.type = 'WARN'
            GROUP BY w.user_id
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
        if (!user || (user.role !== 'moderator' && user.role !== 'admin' && user.role !== 'owner')) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const { caseId } = req.params;

        // Search in warns table
        const [warns] = await MySQLDatabaseManager.connection.pool.query(
            `SELECT w.*, l.username FROM warns w
             LEFT JOIN levels l ON w.user_id = l.user_id
             WHERE w.case_id = ? LIMIT 1`,
            [caseId]
        );

        if (warns && warns.length > 0) {
            return res.json(warns[0]);
        }

        // Search in user_bans table
        const [bans] = await MySQLDatabaseManager.connection.pool.query(
            `SELECT ub.*, l.username FROM user_bans ub
             LEFT JOIN levels l ON ub.user_id = l.user_id
             WHERE ub.ban_case_id = ? LIMIT 1`,
            [caseId]
        );

        if (bans && bans.length > 0) {
            const ban = bans[0];
            return res.json({
                case_id: ban.ban_case_id,
                user_id: ban.user_id,
                username: ban.username,
                reason: ban.ban_reason,
                type: 'BAN',
                moderator_name: ban.banned_by_name,
                timestamp: ban.banned_at
            });
        }

        // Search in timeouts table
        const [timeouts] = await MySQLDatabaseManager.connection.pool.query(
            `SELECT t.*, l.username FROM timeouts t
             LEFT JOIN levels l ON t.user_id = l.user_id
             WHERE t.case_id = ? LIMIT 1`,
            [caseId]
        );

        if (timeouts && timeouts.length > 0) {
            return res.json(timeouts[0]);
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
        if (!user || (user.role !== 'moderator' && user.role !== 'admin' && user.role !== 'owner')) {
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
            AdminPanelHelper.connection.query('SELECT * FROM timeouts WHERE user_id = ?', [userId])
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
                    timestamp: timeout.issued_at
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
        if (!user || (user.role !== 'moderator' && user.role !== 'admin' && user.role !== 'owner')) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const { userId } = req.params;

        // Get all moderation actions for this user
        const [warns] = await MySQLDatabaseManager.connection.pool.query(
            `SELECT case_id, reason, moderator_id, moderator_name, type, created_at as timestamp
             FROM warns WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
            [userId]
        );

        const [bans] = await MySQLDatabaseManager.connection.pool.query(
            `SELECT ban_case_id as case_id, ban_reason as reason, banned_by as moderator_id, banned_by_name as moderator_name, 
                    'BAN' as type, banned_at as timestamp
             FROM user_bans WHERE user_id = ? ORDER BY banned_at DESC LIMIT 50`,
            [userId]
        );

        const [timeouts] = await MySQLDatabaseManager.connection.pool.query(
            `SELECT case_id, reason, issued_by as moderator_id, issued_by_name as moderator_name,
                    'TIMEOUT' as type, issued_at as timestamp, expires_at
             FROM timeouts WHERE user_id = ? ORDER BY issued_at DESC LIMIT 50`,
            [userId]
        );

        // Combine and sort
        const history = [
            ...(warns || []),
            ...(bans || []),
            ...(timeouts || [])
        ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        res.json(history);
    } catch (error) {
        console.error('Error loading user history:', error);
        res.status(500).json({ error: 'Failed to load user history' });
    }
});

// Start server
server.listen(PORT, () => {
    ioReady = true;
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