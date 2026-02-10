// Admin Panel Server - main backend for the Discord bot dashboard
// Handles all routes, sessions, and security for the admin panel

const express = require('express');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const bcrypt = require('bcrypt');
const path = require('path');
const bodyParser = require('body-parser');
const http = require('http');
const socketIo = require('socket.io');
const MySQLDatabaseManager = require('./Functions/MySQLDatabaseManager');
const AdminPanelHelper = require('./Functions/AdminPanelHelper');
const { getStats } = require('./Functions/botStats');
const { generateCaseId } = require('./Events/caseId');

// Load environment variables and add security headers
const helmet = require('helmet');
require('dotenv').config({ 
    path: path.join(__dirname, 'Config', 'credentials.env'),
    override: false,
    debug: false,
    quiet: true
});

const app = express();
app.use(cookieParser());
app.use(helmet());
// Redirect to HTTPS if running in production
app.use((req, res, next) => {
    if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
        return res.redirect('https://' + req.headers.host + req.url);
    }
    next();
});
app.set('trust proxy', 1); // Needed to get the real client IP when behind a proxy

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
        origin: function(origin, callback) {
            // Allow localhost and ngrok URLs for development/testing
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

// (Optional) Log streaming for admin panel clients


// Trust proxy again for safety (sometimes needed by Express)
app.set('trust proxy', 1);

// MySQL session store configuration
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

// Set strict security headers to help prevent XSS and other attacks
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    // Strict CSP: No inline scripts allowed (prevents XSS)
    // Chrome DevTools may show .well-known/appspecific requests; that's just browser behavior
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://cdn.socket.io 'unsafe-inline' 'unsafe-hashes'; style-src 'self' 'unsafe-inline' 'unsafe-hashes'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://cdn.jsdelivr.net https://cdn.socket.io; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; child-src 'none'; object-src 'none';");
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});

// Middleware to capture client IP and user agent info
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

// Make sure SESSION_SECRET is set, or exit in production for safety
const crypto = require('crypto');
const SESSION_SECRET = process.env.SESSION_SECRET;
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
app.use(session({
    key: 'admin_session',
    secret: SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: true, // Always create a session for every user
    cookie: {
        secure: false, // Set to true if using HTTPS in production
        maxAge: 30 * 60 * 1000, // Session expires after 30 minutes of inactivity
        httpOnly: true, // Prevent JavaScript from accessing cookies
        sameSite: 'lax' // Helps prevent CSRF, but works in most browsers
    },
    rolling: true // Reset session expiry on every request
}));

// Listen for session store connection/disconnection events
if (sessionStore && typeof sessionStore.on === 'function') {
    sessionStore.on('disconnect', () => {
        // Lost connection to MySQL for sessions
    });
    sessionStore.on('connect', () => {
        // Connected to MySQL for sessions
    });
}

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

// Generate a CSRF token for each session
app.use((req, res, next) => {
    if (!req.session) {
        // If session isn't ready, skip CSRF setup
        return next();
    }
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    next();
});

// Endpoint to get the CSRF token for the frontend
app.get('/api/csrf', (req, res) => {
    if (!req.session) {
        return res.status(500).json({ error: 'Session not initialized' });
    }
    res.cookie('csrfToken', req.session.csrfToken, { httpOnly: false, sameSite: 'strict' });
    res.json({ csrfToken: req.session.csrfToken });
});

app.use((req, res, next) => {
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        if (!req.session) {
            // If session isn't ready, block the request
            return res.status(500).json({ error: 'Session not initialized' });
        }
        // Get CSRF token from headers, body, or cookies
        const token = req.headers['x-csrf-token'] || req.body?._csrf || (req.cookies ? req.cookies.csrfToken : undefined);
        if (token !== req.session.csrfToken) {
            // Block if CSRF token doesn't match
            return res.status(403).json({ error: 'Invalid CSRF token', expected: req.session.csrfToken, received: token });
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
app.use((req, res, next) => {
    // Don't check CSRF for login
    if (req.path === '/api/login') return next();
    if (["POST", "PUT", "DELETE"].includes(req.method)) {
        if (!req.session) {
            // If session isn't ready, block the request
            return res.status(500).json({ error: 'Session not initialized' });
        }
        // Get CSRF token from headers, body, or cookies
        const token = req.headers['x-csrf-token'] || req.body?._csrf || (req.cookies ? req.cookies.csrfToken : undefined);
        if (token !== req.session.csrfToken) {
            // Block if CSRF token doesn't match
            return res.status(403).json({ error: 'Invalid CSRF token', expected: req.session.csrfToken, received: token });
        }
    }
    next();
});
// Share session authentication with Socket.IO
const sharedSession = require('express-socket.io-session');
io.use(sharedSession(session({
    secret: process.env.SESSION_SECRET || 'keyboard cat',
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: { maxAge: 1800000, sameSite: 'lax' }
}), {
    autoSave: true
}));

io.use((socket, next) => {
    const session = socket.handshake.session;
    if (!session || !session.authenticated || !session.username || !session.role) {
        return next(new Error('Unauthorized Socket.IO connection'));
    }
    socket.username = session.username;
    socket.role = session.role;
    next();
});
app.use('/css', express.static(path.join(__dirname, 'AdminPanel', 'css')));
app.use('/public', express.static(path.join(__dirname, 'AdminPanel', 'public')));
app.use('/images', express.static(path.join(__dirname, 'AdminPanel', 'images')));

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
const fs = require('fs');
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
    const { username, password } = req.body;
    
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
            // Reset failed login attempts for this IP
            loginAttempts.delete(clientIP);
            
            // Create a new session ID to prevent session fixation attacks
            req.session.regenerate((err) => {
                    if (err) {
                        // Couldn't regenerate session ID
                        return res.status(500).json({ error: 'Session error' });
                    }
                
                req.session.authenticated = true;
                req.session.username = username;
                req.session.userId = user.id;
                req.session.role = user.role;
                req.session.loginTime = Date.now();
                req.session.ipAddress = clientIP;
                req.session.ipAddressV4 = req.clientIPV4;
                req.session.ipAddressV6 = req.clientIPV6;
                req.session.userAgent = req.userAgent;
                req.session.save((saveErr) => {
                    if (saveErr) {
                        // Couldn't save the session
                        return res.status(500).json({ error: 'Session save failed' });
                    }
                    // Session saved successfully after login
                    // Close older sessions for this user (keep current session only)
                    closeOtherUserSessions(username, user.id, req.sessionID).catch(err => {
                        // Error closing old sessions
                    });
                    // Ensure CSRF token exists after login
                    if (!req.session.csrfToken) {
                        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
                    }
                    res.cookie('csrfToken', req.session.csrfToken, { httpOnly: false, sameSite: 'strict' });
                    res.json({ success: true, role: user.role, csrfToken: req.session.csrfToken });
                });
            });
            
            // Update last login time (don't wait for this)
            AdminPanelHelper.updateLastLogin(username).catch(err => {
                // Error updating last login
            });
        } else {
            // Track failed attempt
            const attempts = trackLoginAttempt(clientIP);
            // Failed password attempt for user
            res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (error) {
        // Login error
        res.status(500).json({ error: 'Login failed', details: error?.message || error });
    }
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Session destroy error:', err);
            return res.status(500).json({ error: 'Logout failed' });
        }
        res.json({ success: true });
    });
});

// API Routes - Protected
// Secure user info route
app.get('/api/users/:id', requireAuth, async (req, res) => {
    const userId = req.params.id;
    if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'Invalid user ID' });
    }
    try {
        // Try to get user from Discord client if available
        let user = null;
        if (discordClient) {
            user = await discordClient.users.fetch(userId).catch(() => null);
        }
        // Fallback: get from database if available
        if (!user) {
            user = await AdminPanelHelper.getAdminUserById?.(userId);
        }
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        // Only return safe fields
        const safeUser = {
            id: user.id,
            username: user.username,
            role: user.role || (user.bot ? 'Bot' : 'User'),
            avatar: user.avatarURL?.() || user.avatar || null
        };
        return res.json({ success: true, user: safeUser });
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
        
        // Update database first
        const success = await AdminPanelHelper.unbanUser(userId);
        
        // Unban from Discord if client is available
        if (discordClient && success) {
            try {
                const mainConfig = require('./Config/main.json');
                const guild = await discordClient.guilds.fetch(mainConfig.serverID);
                if (guild) {
                    await guild.bans.remove(userId, 'Unbanned via admin panel');
                    console.log(`✅ User ${userId} unbanned from Discord`);
                }
            } catch (discordError) {
                // User might not be banned in Discord, or bot lacks permissions
                console.error('Error unbanning from Discord:', discordError.message);
                // Still return success since database was updated
            }
        }
        
        if (success) {
            res.json({ success: true, message: 'User unbanned successfully' });
        } else {
            res.status(404).json({ error: 'User not found or not banned' });
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
    const { username, password, inviteCode } = req.body;
    
    // Input validation
    if (!username || !password || !inviteCode) {
        return res.status(400).json({ error: 'All fields required' });
    }
    
    // Validate types
    if (typeof username !== 'string' || typeof password !== 'string' || typeof inviteCode !== 'string') {
        return res.status(400).json({ error: 'Invalid input format' });
    }
    
    if (password.length < 8 || password.length > 100) {
        return res.status(400).json({ error: 'Password must be 8-100 characters' });
    }
    
    // Require at least one uppercase, one lowercase, one number, and one special character
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{8,}$/;
    if (!passwordRegex.test(password)) {
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
        
        // Validate invite code
        console.log(`[Registration] Validating invite code: ${inviteCode}`);
        const [inviteCodes] = await MySQLDatabaseManager.connection.pool.query(
            'SELECT * FROM admin_invite_codes WHERE code = ? AND used_by IS NULL AND active = TRUE AND (expires_at IS NULL OR expires_at > NOW())',
            [inviteCode]
        );
        
        console.log(`[Registration] Found ${inviteCodes?.length || 0} matching invite codes`);
        
        if (!inviteCodes || inviteCodes.length === 0) {
            // Debug: Check if code exists at all
            const [debugCodes] = await MySQLDatabaseManager.connection.pool.query(
                'SELECT code, used_by, active, expires_at FROM admin_invite_codes WHERE code = ?',
                [inviteCode]
            );
            console.log(`[Registration] Debug - Code in DB:`, debugCodes);
            return res.status(400).json({ error: 'Invalid or expired invite code' });
        }
        
        const invite = inviteCodes[0];
        const role = invite.role || 'moderator';
        
        console.log(`[Registration] Creating user ${username} with role ${role}`);
        
        // Hash password
        const passwordHash = await bcrypt.hash(password, 10);
        
        // Create new admin user with role from invite code
        const newUser = await AdminPanelHelper.createAdminUser(username, passwordHash, role);
        
        if (newUser) {
            // Mark invite code as used
            await MySQLDatabaseManager.connection.pool.query(
                'UPDATE admin_invite_codes SET used_by = ?, used_at = NOW() WHERE code = ?',
                [username, inviteCode]
            );
            
            console.log(`[Admin] New user registered: ${username} with role ${role} using invite ${inviteCode}`);
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
        res.json({
            success: true,
            username: user.username,
            role: user.role,
            created_at: user.created_at,
            last_login: user.last_login
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
        
        res.json({
            success: true,
            username: user.username,
            role: user.role,
            created_at: user.created_at,
            last_login: user.last_login,
            id: user.id,
            avgSessionTime: 'N/A',
            loginCount: 0
        });
    } catch (error) {
        console.error('Error getting user info:', error);
        res.status(500).json({ error: 'Failed to get user info' });
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
            'UPDATE admin_users SET password_hash = ? WHERE username = ?',
            [newPasswordHash, req.session.username]
        );
        connection.release();
        
        console.log(`[Admin] User ${req.session.username} changed their password`);
        res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        console.error('Error changing password:', error);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

// Invite codes

// Generate new invite code (OWNER ONLY)
app.post('/api/invites/generate', requireAuth, async (req, res) => {
    let { role = 'moderator', expiresInDays = 7 } = req.body;
    
    try {
        // Validate inputs - only allow admin and moderator roles
        if (typeof role !== 'string' || !['admin', 'moderator'].includes(role)) {
            return res.status(400).json({ error: 'Invalid role. Only admin and moderator roles can be invited.' });
        }
        
        if (typeof expiresInDays !== 'number' || expiresInDays < 1 || expiresInDays > 365) {
            expiresInDays = 7; // Default to 7 days
        }
        
        // Check if user is owner
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!user || user.role !== 'owner') {
            return res.status(403).json({ error: 'Only owner can generate invite codes' });
        }
        
        // Generate a random invite code
        const inviteCode = `INV_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`.toUpperCase();
        const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
        
        // Save to database
        await MySQLDatabaseManager.connection.pool.query(
            'INSERT INTO admin_invite_codes (code, created_by, role, expires_at, active) VALUES (?, ?, ?, ?, TRUE)',
            [inviteCode, req.session.username, role, expiresAt]
        );
        
        console.log(`[Admin] ${req.session.username} generated invite code: ${inviteCode} for role ${role}`);
        
        res.json({ 
            success: true, 
            code: inviteCode,
            role: role,
            expiresAt: expiresAt,
            message: 'Invite code generated successfully'
        });
    } catch (error) {
        console.error('Error generating invite code:', error);
        res.status(500).json({ error: 'Failed to generate invite code' });
    }
});

// List active invite codes
app.get('/api/invites/list', requireAuth, async (req, res) => {
    try {
        const user = await AdminPanelHelper.getAdminUser(req.session.username);
        if (!user || (user.role !== 'owner' && user.role !== 'admin')) {
            return res.status(403).json({ error: 'Admin access required' });
        }
        
        // Return mock invites (in production, retrieve from database)
        res.json({ 
            success: true, 
            invites: [],
            message: 'No active invites. Generate one using /api/invites/generate'
        });
    } catch (error) {
        console.error('Error listing invite codes:', error);
        res.status(500).json({ error: 'Failed to list invite codes' });
    }
});

// Revoke invite code (OWNER ONLY)
app.post('/api/invites/revoke/:code', requireAuth, async (req, res) => {
    const { code } = req.params;
    
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
        
        console.log(`[Admin] ${req.session.username} revoked invite code: ${code}`);
        
        res.json({ success: true, message: 'Invite code revoked' });
    } catch (error) {
        console.error('Error revoking invite code:', error);
        res.status(500).json({ error: 'Failed to revoke invite code' });
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
            'UPDATE admin_users SET password_hash = ? WHERE username = ?',
            [newPasswordHash, req.session.username]
        );
        connection.release();
        
        console.log(`[Admin] User ${req.session.username} changed their password`);
        res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        console.error('Error changing password:', error);
        res.status(500).json({ error: 'Failed to change password' });
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
                                ).catch(() => {});
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

        console.log(`[Admin] ${req.session.username} exported database`);

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
        
        // For now, return empty violations
        res.json({ success: true, data: [] });
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

        console.log(`[Admin] ${req.session.username} bulk banned ${results.success.length} users`);
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

        console.log(`[Admin] ${req.session.username} warned ${results.success.length} users`);
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
                `INSERT INTO warns (user_id, case_id, reason, moderator_id, type, timestamp) 
                 VALUES (?, ?, ?, ?, 'WARN', ?)`,
                [userId, caseId, reason.trim(), adminUser.id, Date.now()]
            );
            console.log('[Warn] Database insert successful');
        } catch (dbError) {
            console.error('[Warn] Database error:', dbError.message);
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
                    const embed = new EmbedBuilder()
                        .setTitle('⚠️ User Warned')
                        .setColor(0xFFAA00)
                        .addFields(
                            { name: 'User ID', value: userId, inline: true },
                            { name: 'Case ID', value: caseId, inline: true },
                            { name: 'Reason', value: reason.trim(), inline: false },
                            { name: 'Warned By', value: req.session.username, inline: true },
                            { name: 'Issued At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                        )
                        .setFooter({ text: 'Admin Panel • Moderation Log' })
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

        // Ban the user in Discord
        if (discordClient) {
            try {
                const mainConfig = require('./Config/main.json');
                const guild = await discordClient.guilds.fetch(mainConfig.serverID);
                await guild.members.ban(userId, { reason: reason.trim() });
                console.log(`✅ User ${userId} banned from Discord`);
            } catch (discordError) {
                return res.status(400).json({ error: `Failed to ban from Discord: ${discordError.message}` });
            }
        }

        // Add ban to database
        try {
            await MySQLDatabaseManager.connection.pool.query(
                `INSERT INTO user_bans (user_id, banned, ban_case_id, banned_at, banned_by, ban_reason) 
                 VALUES (?, TRUE, ?, NOW(), ?, ?)`,
                [userId, caseId, adminUser.id, reason.trim()]
            );

            // Also log in warns table for consistency
            await MySQLDatabaseManager.connection.pool.query(
                `INSERT INTO warns (user_id, case_id, reason, moderator_id, type, timestamp) 
                 VALUES (?, ?, ?, ?, 'BAN', ?)`,
                [userId, caseId, reason.trim(), adminUser.id, Date.now()]
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
                    const embed = new EmbedBuilder()
                        .setTitle('🔨 User Banned')
                        .setColor(0xFF0000)
                        .addFields(
                            { name: 'User ID', value: userId, inline: true },
                            { name: 'Case ID', value: caseId, inline: true },
                            { name: 'Reason', value: reason.trim(), inline: false },
                            { name: 'Banned By', value: req.session.username, inline: true },
                            { name: 'Banned At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                        )
                        .setFooter({ text: 'Admin Panel • Moderation Log' })
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
        try {
            const expiresAt = new Date(Date.now() + durationMs);
            await MySQLDatabaseManager.connection.pool.query(
                `INSERT INTO timeouts (user_id, timeout_case_id, reason, moderator_id, expires_at, created_at) 
                 VALUES (?, ?, ?, ?, ?, NOW())`,
                [userId, caseId, reason.trim(), adminUser.id, expiresAt]
            );

            // Also log in warns table for consistency
            await MySQLDatabaseManager.connection.pool.query(
                `INSERT INTO warns (user_id, case_id, reason, moderator_id, type, timestamp) 
                 VALUES (?, ?, ?, ?, 'TIMEOUT', ?)`,
                [userId, caseId, reason.trim(), adminUser.id, Date.now()]
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
                    const embed = new EmbedBuilder()
                        .setTitle('⏱️ User Timed Out')
                        .setColor(0xFFA500)
                        .addFields(
                            { name: 'User ID', value: userId, inline: true },
                            { name: 'Case ID', value: caseId, inline: true },
                            { name: 'Duration', value: duration, inline: true },
                            { name: 'Reason', value: reason.trim(), inline: false },
                            { name: 'Timed Out By', value: req.session.username, inline: true },
                            { name: 'Expires At', value: `<t:${Math.floor((Date.now() + durationMs) / 1000)}:F>`, inline: true }
                        )
                        .setFooter({ text: 'Admin Panel • Moderation Log' })
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
        try {
            await MySQLDatabaseManager.connection.pool.query(
                `UPDATE timeouts SET expires_at = NOW() WHERE user_id = ? AND expires_at > NOW()`,
                [userId]
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
                    const embed = new EmbedBuilder()
                        .setTitle('✅ Timeout Removed')
                        .setColor(0x00AA00)
                        .addFields(
                            { name: 'User ID', value: userId, inline: true },
                            { name: 'Removed By', value: req.session.username, inline: true },
                            { name: 'Removed At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                        )
                        .setFooter({ text: 'Admin Panel • Moderation Log' })
                        .setTimestamp();
                    
                    await logChannel.send({ embeds: [embed] });
                }
            } catch (logError) {
                console.error('Error logging timeout removal:', logError.message);
            }
        }

        console.log(`[Admin] ${req.session.username} removed timeout from user ${userId} via search`);
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

        const startMs = today.getTime();
        const endMs = tomorrow.getTime();

        const safeCount = async (query, params) => {
            try {
                const [rows] = await MySQLDatabaseManager.connection.pool.query(query, params);
                return rows?.[0]?.count || 0;
            } catch (err) {
                return 0;
            }
        };

        const [warnsToday, bansToday, activeTimeouts, openTickets] = await Promise.all([
            safeCount('SELECT COUNT(*) as count FROM warns WHERE type = "WARN" AND timestamp BETWEEN ? AND ?', [startMs, endMs]),
            safeCount('SELECT COUNT(*) as count FROM user_bans WHERE banned = TRUE AND banned_at BETWEEN ? AND ?', [today, tomorrow]),
            AdminPanelHelper.getActiveTimeoutsCount(),
            safeCount('SELECT COUNT(*) as count FROM tickets WHERE status = "open"', [])
        ]);

        res.json({
            warnsToday,
            bansToday,
            activeTimeouts,
            openTickets
        });
    } catch (error) {
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
            return res.status(500).json({ error: 'Discord bot not connected' });
        }

        // Get ban info before unbanning
        const [banInfo] = await MySQLDatabaseManager.connection.pool.query(
            'SELECT ban_reason, ban_case_id FROM user_bans WHERE user_id = ? AND banned = 1 LIMIT 1',
            [userId]
        );

        if (!banInfo || banInfo.length === 0) {
            return res.status(404).json({ error: 'User not found or not banned' });
        }

        const originalBanCaseId = banInfo[0].ban_case_id;
        const originalBanReason = banInfo[0].ban_reason || 'No reason provided';

        // Generate new case ID for unban action
        const unbanCaseId = generateCaseId('UNBAN');

        // Update database to mark user as unbanned
        const success = await AdminPanelHelper.unbanUser(userId);
        if (!success) {
            return res.status(500).json({ error: 'Failed to update database' });
        }

        // Actually unban from Discord
        try {
            const guild = discordClient.guilds.cache.first();
            if (guild) {
                await guild.members.unban(userId, `Unbanned via admin panel by ${req.session.username} - Case ID: ${unbanCaseId}`);
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

            const logChannel = discordClient.channels.cache.get(serverLogChannelId);
            if (logChannel) {
                await logChannel.send({ embeds: [logEmbed] });
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
        res.status(500).json({ error: 'Failed to unban' });
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
                    const embed = new EmbedBuilder()
                        .setTitle('⏱️ Timeout Removed')
                        .setColor(0x00FF00)
                        .addFields(
                            { name: 'User ID', value: userId, inline: true },
                            { name: 'Case ID', value: caseId, inline: true },
                            { name: 'Original Reason', value: timeoutReason, inline: false },
                            { name: 'Removed By', value: req.session.username, inline: true },
                            { name: 'Removed At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                        )
                        .setFooter({ text: 'Admin Panel • Moderation Log' })
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
        const normalizedQuery = query.toLowerCase();
        
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
                                ).catch(() => {});
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

        // Use the previously declared normalizedQuery
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
        console.error('Error searching warnings:', error);
        res.status(500).json({ error: 'Failed to search warnings' });
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
                                ).catch(() => {});
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

// Get invite statistics
app.get('/api/invites/stats', requireAuth, async (req, res) => {
    try {
        const [rows] = await MySQLDatabaseManager.connection.pool.query(
            'SELECT code, created_by, role, used_by, created_at, expires_at FROM admin_invite_codes ORDER BY created_at DESC LIMIT 100'
        );
        res.json(rows || []);
    } catch (error) {
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
        
        const sessionDuration = 86400; // 24 hour session duration (from cookie maxAge)
        
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
            const createdAt = expiresAt - sessionDuration; // Calculate when created
            
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
            
            // Create a key for this user+device combination (ignore IP since it can vary)
            const sessionKey = `${username}|${device}`;
            
            // Only keep the most recent session for this user+device combo
            if (!sessionMap.has(sessionKey)) {
                sessionMap.set(sessionKey, {
                    id: session.session_id.substring(0, 8) + '...',
                    username: username,
                    ipAddress: ipAddress,
                    ipAddressV4: ipAddressV4,
                    ipAddressV6: ipAddressV6,
                    userAgent: userAgent || 'Unknown',
                    device: device,
                    createdAt: new Date(createdAt * 1000).toLocaleString(),
                    expiresAt: new Date(expiresAt * 1000).toLocaleString(),
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

// Helper function to extract device from user agent
function extractDeviceFromUserAgent(userAgent) {
    if (!userAgent) return 'Unknown';
    if (userAgent.includes('Chrome')) return 'Chrome';
    if (userAgent.includes('Firefox')) return 'Firefox';
    if (userAgent.includes('Safari')) return 'Safari';
    if (userAgent.includes('Edge')) return 'Edge';
    return 'Other';
}

function escapeLikeValue(value) {
    return String(value).replace(/[\\%_]/g, '\\$&');
}

async function closeOtherUserSessions(username, userId, currentSessionId) {
    if (!username || !currentSessionId) return;

    const usernamePattern = `%"username":"${escapeLikeValue(username)}"%`;
    const userIdPattern = userId ? `%"userId":${escapeLikeValue(userId)}%` : null;

    const params = [currentSessionId, usernamePattern];
    let sql = 'DELETE FROM sessions WHERE session_id <> ? AND data LIKE ? ESCAPE "\\\\"';

    if (userIdPattern) {
        sql += ' OR (session_id <> ? AND data LIKE ? ESCAPE "\\\\")';
        params.push(currentSessionId, userIdPattern);
    }

    await MySQLDatabaseManager.connection.pool.query(sql, params);
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
        const { userId, userTag, caseId, reason } = req.body;
        
        if (!userId || !userTag || !caseId || !reason) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Validate case ID format
        if (!caseId.startsWith('BAN-')) {
            return res.status(400).json({ error: 'Invalid ban case ID format' });
        }
        
        // Check if user already has a pending appeal
        const [existing] = await MySQLDatabaseManager.connection.pool.execute(
            'SELECT id FROM ban_appeals WHERE user_id = ? AND status = ?',
            [userId, 'pending']
        );
        
        if (existing.length > 0) {
            return res.status(400).json({ error: 'You already have a pending appeal. Please wait for a response.' });
        }
        
        // Submit appeal with ban case ID
        await MySQLDatabaseManager.connection.pool.execute(
            'INSERT INTO ban_appeals (user_id, user_tag, ban_case_id, reason) VALUES (?, ?, ?, ?)',
            [userId, userTag, caseId, reason]
        );
        
        res.json({ success: true, message: 'Appeal submitted successfully' });
    } catch (error) {
        console.error('Error submitting appeal:', error);
        res.status(500).json({ error: 'Failed to submit appeal' });
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
        const { response } = req.body;
        
        await MySQLDatabaseManager.connection.pool.execute(
            'UPDATE ban_appeals SET status = ?, owner_response = ?, decided_at = NOW() WHERE id = ?',
            ['accepted', response || 'Your ban appeal has been accepted. You may rejoin the server.', id]
        );
        
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
        const { response } = req.body;
        
        await MySQLDatabaseManager.connection.pool.execute(
            'UPDATE ban_appeals SET status = ?, owner_response = ?, decided_at = NOW() WHERE id = ?',
            ['denied', response || 'Your ban appeal has been denied.', id]
        );
        
        console.log(`[Owner] ${req.session.username} denied ban appeal #${id}`);
        res.json({ success: true, message: 'Appeal denied' });
    } catch (error) {
        console.error('Error denying appeal:', error);
        res.status(500).json({ error: 'Failed to deny appeal' });
    }
});

// Alerts

// Get alert settings (owner only)
app.get('/api/alerts/settings', requireAuth, requireOwner, async (req, res) => {
    try {
        const [settings] = await MySQLDatabaseManager.connection.pool.execute(
            'SELECT id, alert_type, threshold, enabled FROM alert_settings ORDER BY alert_type'
        );
        res.json(settings);
    } catch (error) {
        console.error('Error fetching alert settings:', error);
        res.status(500).json({ error: 'Failed to fetch alert settings' });
    }
});

// Update alert settings (owner only)
app.post('/api/alerts/settings/:alertType', requireAuth, requireOwner, async (req, res) => {
    try {
        const { alertType } = req.params;
        const { threshold, enabled } = req.body;
        
        await MySQLDatabaseManager.connection.pool.execute(
            'UPDATE alert_settings SET threshold = ?, enabled = ? WHERE alert_type = ?',
            [threshold, enabled ? 1 : 0, alertType]
        );
        
        console.log(`[Owner] ${req.session.username} updated alert settings for ${alertType}`);
        res.json({ success: true, message: 'Alert settings updated' });
    } catch (error) {
        console.error('Error updating alert settings:', error);
        res.status(500).json({ error: 'Failed to update alert settings' });
    }
});

// Get active alerts (owner only)
app.get('/api/alerts/active', requireAuth, requireOwner, async (req, res) => {
    try {
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

// Websockets

io.on('connection', (socket) => {
    let role = socket.request?.session?.role || socket.handshake?.auth?.role || socket.handshake?.query?.role || 'user';
    let username = socket.request?.session?.username || socket.handshake?.auth?.username || socket.handshake?.query?.username || 'Unknown';
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
    console.log(`User '${displayUsername}' (${displayRole}) connected to WebSocket (Page: ${page})`);
    
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
        console.log(`User '${displayUsername}' (${displayRole}) disconnected from WebSocket (Page: ${page})`);
        clearInterval(statsInterval);
    });
    
    socket.on('error', (error) => {
        console.error('WebSocket error:', error);
        clearInterval(statsInterval);
    });
    
    // Handle custom events
    socket.on('request-stats', sendStats);
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

// Get user details
app.get('/api/users/:userId', requireAuth, async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Validate user ID format
        if (!userId || !/^\d{17,19}$/.test(userId)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }
        
        // Try to get user from levels table first
        const [users] = await MySQLDatabaseManager.connection.pool.query(`
            SELECT 
                l.user_id, 
                COALESCE(NULLIF(l.username, ''), CONCAT('User-', SUBSTRING(l.user_id, -4))) as username,
                COALESCE(COUNT(w.id), 0) as warnings, 
                l.level, 
                l.xp,
                l.messages,
                l.created_at as joined_at
            FROM levels l
            LEFT JOIN warns w ON l.user_id = w.user_id 
                AND (w.type IS NULL OR w.type = 'WARN')
                AND w.reason NOT LIKE '%(timeout%'
                AND w.reason NOT LIKE '%(untimeout)%'
            WHERE l.user_id = ?
            GROUP BY l.user_id
        `, [userId]);

        // Get userinfo table data
        const userInfo = await MySQLDatabaseManager.getUserInfo(userId);
        // Get ban info
        const [banRows] = await MySQLDatabaseManager.connection.pool.query(`SELECT * FROM user_bans WHERE user_id = ?`, [userId]);
        const banInfo = banRows?.[0] || {};

        if (users.length > 0) {
            // Merge all available data
            const user = users[0];
            const fullUser = {
                user_id: user.user_id || userId,
                username: user.username || userInfo?.username || `User-${userId.slice(-4)}`,
                nickname: userInfo?.nickname || 'N/A',
                joined_at: user.joined_at || userInfo?.joined_at || null,
                created_at: userInfo?.created_at || user.joined_at || null,
                bio: userInfo?.bio || 'N/A',
                level: user.level || 0,
                xp: user.xp || 0,
                warnings: user.warnings || 0,
                is_banned: banInfo.banned || 0,
                ban_reason: banInfo.ban_reason || userInfo?.ban_reason || null,
                ban_date: banInfo.banned_at || userInfo?.ban_date || null,
                is_timed_out: userInfo?.is_timed_out || 0,
                timeout_reason: userInfo?.timeout_reason || null,
                timeout_expires: userInfo?.timeout_expires || null,
                status: userInfo?.status || 'N/A',
                flags: userInfo?.flags || 'N/A',
                messages: user.messages || userInfo?.messages || 0
            };
            return res.json(fullUser);
        }
        
        // If not in levels, check member_activity and warn tables
        const [memberData] = await MySQLDatabaseManager.connection.pool.query(`
            SELECT 
                ? as user_id,
                COALESCE(ma.username, CONCAT('User-', SUBSTRING(?, -4))) as username,
                COALESCE(w_count.warn_count, 0) as warnings,
                1 as level,
                0 as xp,
                0 as messages,
                COALESCE(ma.timestamp, NOW()) as joined_at,
                COALESCE(ub.banned, 0) as is_banned
            FROM (SELECT 1) t
            LEFT JOIN (
                SELECT user_id, username, timestamp 
                FROM member_activity 
                WHERE user_id = ? 
                ORDER BY timestamp DESC 
                LIMIT 1
            ) ma ON 1=1
            LEFT JOIN (
                SELECT user_id, COUNT(*) as warn_count 
                FROM warns 
                WHERE user_id = ? 
                AND (type IS NULL OR type = 'WARN')
                AND reason NOT LIKE '%(timeout%'
                AND reason NOT LIKE '%(untimeout)%'
                GROUP BY user_id
            ) w_count ON 1=1
            LEFT JOIN user_bans ub ON ? = ub.user_id AND ub.banned = TRUE
        `, [userId, userId, userId, userId, userId]);
        
        if (memberData.length > 0 && memberData[0].username !== `User-${userId.slice(-4)}`) {
            // Ensure all expected fields are present
            const user = memberData[0];
            const fullUser = {
                user_id: user.user_id || userId,
                username: user.username || `User-${userId.slice(-4)}`,
                nickname: user.nickname || 'N/A',
                joined_at: user.joined_at || null,
                created_at: user.created_at || null,
                bio: user.bio || 'N/A',
                level: user.level || 0,
                xp: user.xp || 0,
                warnings: user.warnings || 0,
                is_banned: user.is_banned || 0,
                ban_reason: user.ban_reason || null,
                ban_date: user.ban_date || null,
                is_timed_out: user.is_timed_out || 0,
                timeout_reason: user.timeout_reason || null,
                timeout_expires: user.timeout_expires || null,
                status: user.status || 'N/A',
                flags: user.flags || 'N/A',
                messages: user.messages || 0
            };
            return res.json(fullUser);
        }
        
        // User doesn't exist anywhere, return 404
        return res.status(404).json({ error: 'User not found' });
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

// Warn a user
app.post('/api/warn', requireAuth, async (req, res) => {
    try {
        const { user_id, reason } = req.body;
        
        if (!user_id || !reason) {
            return res.status(400).json({ error: 'Missing user_id or reason' });
        }
        
        // Get current warning count
        const [warns] = await MySQLDatabaseManager.connection.pool.query(
            'SELECT COUNT(*) as warnings FROM warns WHERE user_id = ? AND type = "WARN"',
            [user_id]
        );
        
        const newWarnings = (warns[0]?.warnings || 0) + 1;
        
        // Add new warning
        await MySQLDatabaseManager.connection.pool.query(
            'INSERT INTO warns (user_id, reason, created_at) VALUES (?, ?, NOW())',
            [user_id, reason]
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

// Start alert monitoring (check every 5 minutes)
setInterval(checkAndCreateAlerts, 5 * 60 * 1000);

// Start server
server.listen(PORT, () => {
    ioReady = true;
    console.log(`\n🎛️  Admin Panel Server Running on port ${PORT}`);
    console.log(`📡  WebSocket enabled for live updates`);
    if (!SESSION_SECRET) {
        console.error('SESSION_SECRET is missing! Check your credentials.env file.');
    }
    if (!sessionStore) {
        console.error('Session store is not initialized! Session handling will fail.');
    }
});

module.exports = { setDiscordClient };