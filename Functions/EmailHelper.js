// Email helper
// Utilities for initializing SMTP transport, sending emails safely with
// throttling/anti-abuse checks, and logging delivery results to the DB.
const nodemailer = require('nodemailer');
const path = require('path');
const { promises: dns } = require('dns');
const crypto = require('crypto');
const MySQLDatabaseManager = require('./MySQLDatabaseManager');
const { MISC: miscConfig } = require('../Config/constants');

function loadEmailConfig() {
    try {
        const fromMisc = miscConfig?.Email || miscConfig?.email;
        if (fromMisc && typeof fromMisc === 'object') {
            return fromMisc;
        }
    } catch (_) {
        // ignore missing config
    }

    try {
        const mainConfig = require('../Config/main.json');
        const fromMain = mainConfig?.Email || mainConfig?.email;
        if (fromMain && typeof fromMain === 'object') {
            return fromMain;
        }
    } catch (_) {
        // ignore missing config
    }

    return {};
}

class EmailHelper {
    async isValidEmail(email) {
        if (!email || typeof email !== 'string') return false;
        const normalized = this.normalizeEmail(email);
        // RFC 5322 basic regex
        const rfcRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
        if (!rfcRegex.test(normalized) || normalized.length > 254) return false;
        // Disposable domains list (expand as needed)
        const disposableDomains = [
            'mailinator.com', '10minutemail.com', 'guerrillamail.com', 'tempmail.com', 'yopmail.com', 'dispostable.com', 'trashmail.com', 'fakeinbox.com', 'getnada.com', 'mintemail.com', 'moakt.com', 'mytemp.email', 'throwawaymail.com', 'maildrop.cc', 'mailcatch.com', 'spambox.us', 'mailnesia.com', 'spamgourmet.com', 'sharklasers.com', 'grr.la', 'mail.com', 'email.com'
        ];
        const domain = this.extractDomain(normalized);
        if (!domain || disposableDomains.includes(domain)) return false;
        // MX record check (cached)
        const hasMx = await this.hasValidMx(domain);
        if (!hasMx) {
            return false;
        }
        return true;
    }
    constructor() {
        this.transporter = null;
        this.isConfigured = false;
        this.fromAddress = null;
        this.appealLink = this.loadAppealLink();
        this.recipientSendHistory = new Map();
        this.globalSendHistory = [];
        // defaults (can be overridden by Config/main.json Email section)
        this.emailAbuseWindowMs = 60 * 60 * 1000;
        this.maxRecipientEmailsPerWindow = 12;
        this.maxGlobalEmailsPerMinute = 80;
        this.minSecondsBetweenSameRecipient = 10;
        this.emailLogTableEnsured = false;
        this.maxSendRetries = 2;
        this.retryBaseDelayMs = 500;
        this.retryMaxDelayMs = 5000;
        this.sendTimeoutMs = 15000;
        this.maxHtmlLength = 500000;
        this.maxTextLength = 200000;
        this.maxSubjectLength = 255;
        this.mxCache = new Map();
        this.mxCacheTtlMs = 10 * 60 * 1000;
        this.maxMxCacheEntries = 500;
    }

    normalizeEmail(value) {
        return String(value || '').trim().toLowerCase();
    }

    sanitizeSubject(value) {
        return String(value || '')
            .replace(/[\r\n]+/g, ' ')
            .trim()
            .slice(0, this.maxSubjectLength);
    }

    stripHtmlToText(html) {
        return String(html || '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, this.maxTextLength);
    }

    getCachedMx(domain) {
        const cacheItem = this.mxCache.get(domain);
        if (!cacheItem) return null;
        if (Date.now() - cacheItem.at > this.mxCacheTtlMs) {
            this.mxCache.delete(domain);
            return null;
        }
        return cacheItem.value;
    }

    setCachedMx(domain, value) {
        if (!domain) return;
        if (this.mxCache.size >= this.maxMxCacheEntries) {
            const oldestKey = this.mxCache.keys().next().value;
            if (oldestKey) this.mxCache.delete(oldestKey);
        }
        this.mxCache.set(domain, { value, at: Date.now() });
    }

    async hasValidMx(domain) {
        if (!domain) return false;
        const cached = this.getCachedMx(domain);
        if (cached !== null) return Boolean(cached);

        try {
            const mxRecords = await dns.resolveMx(domain);
            const hasMx = Array.isArray(mxRecords) && mxRecords.length > 0;
            this.setCachedMx(domain, hasMx);
            return hasMx;
        } catch (_) {
            this.setCachedMx(domain, false);
            return false;
        }
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    isRetryableEmailError(error) {
        const code = String(error?.code || '').toUpperCase();
        const responseCode = Number(error?.responseCode || 0);
        const message = String(error?.message || '').toLowerCase();

        if (['ETIMEDOUT', 'ECONNECTION', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'ESOCKET'].includes(code)) {
            return true;
        }
        if ([421, 450, 451, 452].includes(responseCode)) {
            return true;
        }
        if (message.includes('timeout') || message.includes('temporarily') || message.includes('try again')) {
            return true;
        }
        return false;
    }

    buildDeliveryContext(metadata = {}) {
        const correlationId = String(metadata?.correlationId || metadata?.requestId || '').trim();
        const source = String(metadata?.source || '').trim();
        const providerResponse = metadata?.providerResponse ? String(metadata.providerResponse) : null;
        return {
            correlationId: correlationId || null,
            source: source || null,
            providerResponse
        };
    }

    loadAppealLink() {
        try {
            const mainConfig = require('../Config/main.json');
            return mainConfig.AppealLink || null;
        } catch (error) {
            console.warn('⚠️  Could not load AppealLink from main.json');
            return null;
        }
    }

    async initialize(smtpConfig) {
        try {
            if (!smtpConfig || !smtpConfig.host || !smtpConfig.user || !smtpConfig.pass) {
                console.warn('⚠️  Email: SMTP configuration incomplete. Email system will be disabled.');
                this.isConfigured = false;
                return false;
            }

            try {
                const emailCfg = loadEmailConfig();
                if (emailCfg) {
                    if (Number.isFinite(Number(emailCfg.sendTimeoutMs))) {
                        this.sendTimeoutMs = Number(emailCfg.sendTimeoutMs);
                    }
                    if (Number.isFinite(Number(emailCfg.maxSendRetries))) {
                        this.maxSendRetries = Number(emailCfg.maxSendRetries);
                    }
                    if (Number.isFinite(Number(emailCfg.retryBaseDelayMs))) {
                        this.retryBaseDelayMs = Number(emailCfg.retryBaseDelayMs);
                    }
                    if (Number.isFinite(Number(emailCfg.retryMaxDelayMs))) {
                        this.retryMaxDelayMs = Number(emailCfg.retryMaxDelayMs);
                    }
                }
            } catch (_) {
                // ignore missing config
            }

            this.fromAddress = String(
                smtpConfig.from || process.env.ADMIN_EMAIL || smtpConfig.user || ''
            ).trim();

            if (!this.fromAddress || this.fromAddress.toLowerCase() === 'apikey') {
                console.warn('⚠️  Email: Missing valid sender address. Set ADMIN_EMAIL to a verified sender.');
                this.isConfigured = false;
                return false;
            }

            this.transporter = nodemailer.createTransport({
                host: smtpConfig.host,
                port: smtpConfig.port || 587,
                secure: smtpConfig.secure || false,
                connectionTimeout: this.sendTimeoutMs,
                greetingTimeout: this.sendTimeoutMs,
                socketTimeout: this.sendTimeoutMs,
                auth: {
                    user: smtpConfig.user,
                    pass: smtpConfig.pass
                }
            });

            // Test the connection
            await this.transporter.verify();
            await this.checkDomainAuthSignals();
            // Load optional email-related overrides from config
            try {
                const emailCfg = loadEmailConfig();
                if (emailCfg) {
                    if (Number.isFinite(Number(emailCfg.emailAbuseWindowSeconds))) {
                        this.emailAbuseWindowMs = Number(emailCfg.emailAbuseWindowSeconds) * 1000;
                    }
                    if (Number.isFinite(Number(emailCfg.maxRecipientEmailsPerWindow))) {
                        this.maxRecipientEmailsPerWindow = Number(emailCfg.maxRecipientEmailsPerWindow);
                    }
                    if (Number.isFinite(Number(emailCfg.maxGlobalEmailsPerMinute))) {
                        this.maxGlobalEmailsPerMinute = Number(emailCfg.maxGlobalEmailsPerMinute);
                    }
                    if (Number.isFinite(Number(emailCfg.minSecondsBetweenSameRecipient))) {
                        this.minSecondsBetweenSameRecipient = Number(emailCfg.minSecondsBetweenSameRecipient);
                    }
                    if (Number.isFinite(Number(emailCfg.maxSendRetries))) {
                        this.maxSendRetries = Number(emailCfg.maxSendRetries);
                    }
                    if (Number.isFinite(Number(emailCfg.retryBaseDelayMs))) {
                        this.retryBaseDelayMs = Number(emailCfg.retryBaseDelayMs);
                    }
                    if (Number.isFinite(Number(emailCfg.retryMaxDelayMs))) {
                        this.retryMaxDelayMs = Number(emailCfg.retryMaxDelayMs);
                    }
                    if (Number.isFinite(Number(emailCfg.sendTimeoutMs))) {
                        this.sendTimeoutMs = Number(emailCfg.sendTimeoutMs);
                    }
                }
            } catch (e) {
                // ignore missing config
            }
            console.log('✅ Email system initialized successfully');
            this.isConfigured = true;
            return true;
        } catch (error) {
            console.error('❌ Email initialization failed:', error.message);
            this.isConfigured = false;
            return false;
        }
    }

    /**
     * Send a generic email
     */
    async sendEmail(to, subject, html, text = '', metadata = {}) {
        const normalizedPayload = (to && typeof to === 'object' && !Array.isArray(to))
            ? {
                to: to.to,
                subject: to.subject,
                html: to.html,
                text: to.text || '',
                metadata: (to.metadata && typeof to.metadata === 'object') ? to.metadata : {}
            }
            : { to, subject, html, text, metadata };

        const extraMetadata = (normalizedPayload.metadata && typeof normalizedPayload.metadata === 'object')
            ? normalizedPayload.metadata
            : {};
        const templateName = String(extraMetadata?.templateName || 'generic').trim() || 'generic';
        const deliveryContext = this.buildDeliveryContext(extraMetadata);
        const recipientEmail = this.normalizeEmail(normalizedPayload.to);
        const sanitizedSubject = this.sanitizeSubject(normalizedPayload.subject);
        const htmlBody = String(normalizedPayload.html || '').slice(0, this.maxHtmlLength);
        const textBody = normalizedPayload.text
            ? String(normalizedPayload.text).slice(0, this.maxTextLength)
            : this.stripHtmlToText(htmlBody);

        if (!recipientEmail || !this.extractDomain(recipientEmail)) {
            await this.logEmailDelivery({ to: recipientEmail, subject: sanitizedSubject, templateName, status: 'blocked', errorMessage: 'Invalid recipient email', context: deliveryContext });
            return { success: false, error: 'Invalid recipient email' };
        }

        if (!htmlBody && !textBody) {
            await this.logEmailDelivery({ to: recipientEmail, subject: sanitizedSubject, templateName, status: 'blocked', errorMessage: 'Email content is empty', context: deliveryContext });
            return { success: false, error: 'Email content is empty' };
        }

        if (!this.isConfigured || !this.transporter) {
            console.warn('⚠️  Email system not configured. Skipping email send.');
            await this.logEmailDelivery({ to: recipientEmail, subject: sanitizedSubject, templateName, status: 'blocked', errorMessage: 'Email system not configured', context: deliveryContext });
            return { success: false, error: 'Email system not configured' };
        }

        const throttleCheck = await this.canSendToRecipient(recipientEmail);
        if (!throttleCheck.allowed) {
            console.warn(`⚠️  Email blocked by anti-abuse policy: ${throttleCheck.reason}`);
            await this.logEmailDelivery({ to: recipientEmail, subject: sanitizedSubject, templateName, status: 'blocked', errorMessage: throttleCheck.reason, context: deliveryContext });
            return { success: false, error: throttleCheck.reason };
        }

        const attemptsAllowed = Math.max(0, Number(this.maxSendRetries)) + 1;

        for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
            const startedAt = Date.now();
            try {
                const result = await this.transporter.sendMail({
                    from: this.fromAddress,
                    to: recipientEmail,
                    subject: sanitizedSubject,
                    text: textBody,
                    html: htmlBody || undefined
                });

                this.markRecipientSend(recipientEmail);
                await this.logEmailDelivery({
                    to: recipientEmail,
                    subject: sanitizedSubject,
                    templateName,
                    status: 'sent',
                    messageId: result.messageId,
                    context: {
                        ...deliveryContext,
                        providerResponse: result?.response ? String(result.response) : deliveryContext.providerResponse,
                        attempt,
                        latencyMs: Date.now() - startedAt
                    }
                });
                console.log(`✅ Email sent successfully (attempt ${attempt}/${attemptsAllowed})`);
                return { success: true, messageId: result.messageId };
            } catch (error) {
                const retryable = this.isRetryableEmailError(error);
                const canRetry = retryable && attempt < attemptsAllowed;

                if (!canRetry) {
                    await this.logEmailDelivery({
                        to: recipientEmail,
                        subject: sanitizedSubject,
                        templateName,
                        status: 'failed',
                        errorMessage: error.message,
                        context: {
                            ...deliveryContext,
                            providerResponse: error?.response ? String(error.response) : deliveryContext.providerResponse,
                            attempt,
                            latencyMs: Date.now() - startedAt
                        }
                    });
                    console.error(`❌ Failed to send email (attempt ${attempt}/${attemptsAllowed}):`, error.message);
                    return { success: false, error: error.message };
                }

                const delayMs = Math.min(
                    this.retryMaxDelayMs,
                    this.retryBaseDelayMs * (2 ** (attempt - 1))
                );
                await this.sleep(delayMs);
            }
        }

        return { success: false, error: 'Unknown email delivery failure' };
    }

    async ensureEmailLogTable() {
        if (this.emailLogTableEnsured) return;

        try {
            await MySQLDatabaseManager.connection.pool.execute(`
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
            this.emailLogTableEnsured = true;
        } catch (error) {
            console.warn('⚠️  Unable to ensure email_delivery_logs table:', error.message);
        }
    }

    extractDomain(email) {
        const normalized = this.normalizeEmail(email);
        const atIndex = normalized.lastIndexOf('@');
        if (atIndex <= 0) return null;
        const domain = normalized.slice(atIndex + 1);
        return domain || null;
    }

    async logEmailDelivery({ to, subject, templateName, status, errorMessage = null, messageId = null, context = {} }) {
        try {
            if (!MySQLDatabaseManager?.connection?.pool) return;
            await this.ensureEmailLogTable();

            const recipientEmail = this.normalizeEmail(to);
            if (!recipientEmail) return;

            const correlationId = context?.correlationId ? String(context.correlationId).slice(0, 128) : null;
            const source = context?.source ? String(context.source).slice(0, 100) : null;
            const providerResponse = context?.providerResponse ? String(context.providerResponse) : null;
            const attemptCount = Number.isFinite(Number(context?.attempt))
                ? Math.max(1, Math.round(Number(context.attempt)))
                : 1;
            const latencyMs = Number.isFinite(Number(context?.latencyMs))
                ? Math.max(0, Math.round(Number(context.latencyMs)))
                : null;

            try {
                await MySQLDatabaseManager.connection.pool.execute(
                    `INSERT INTO email_delivery_logs
                        (recipient_email, recipient_domain, template_name, subject, status, error_message, message_id, correlation_id, source, provider_response, attempt_count, latency_ms)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        recipientEmail,
                        this.extractDomain(recipientEmail),
                        String(templateName || 'generic').slice(0, 100),
                        this.sanitizeSubject(subject) || null,
                        status,
                        errorMessage ? String(errorMessage) : null,
                        messageId ? String(messageId).slice(0, 255) : null,
                        correlationId,
                        source,
                        providerResponse,
                        attemptCount,
                        latencyMs
                    ]
                );
            } catch (insertErr) {
                if (insertErr?.code !== 'ER_BAD_FIELD_ERROR') {
                    throw insertErr;
                }
                await MySQLDatabaseManager.connection.pool.execute(
                    `INSERT INTO email_delivery_logs
                        (recipient_email, recipient_domain, template_name, subject, status, error_message, message_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        recipientEmail,
                        this.extractDomain(recipientEmail),
                        String(templateName || 'generic').slice(0, 100),
                        this.sanitizeSubject(subject) || null,
                        status,
                        errorMessage ? String(errorMessage) : null,
                        messageId ? String(messageId).slice(0, 255) : null
                    ]
                );
            }
        } catch (error) {
            console.warn('⚠️  Failed to write email analytics log:', error.message);
        }
    }

    getAdminPanelBaseUrl() {
        const explicit = String(process.env.ADMIN_PANEL_URL || '').trim();
        if (explicit) return explicit.replace(/\/$/, '');
        const host = String(process.env.ADMIN_ORIGIN || '').trim();
        if (host) return host.replace(/\/$/, '');
        try {
            const mainConfig = require('../Config/main.json');
            const websiteLink = String(mainConfig?.WebsiteLink || '').trim();
            if (websiteLink) return websiteLink.replace(/\/$/, '');
        } catch (_) {
            // ignore config read errors
        }
        const port = String(process.env.ADMIN_PORT || '3000').trim();
        return `http://localhost:${port}`;
    }

    getFromDomain() {
        const from = String(this.fromAddress || '').trim().toLowerCase();
        const at = from.lastIndexOf('@');
        if (at === -1) return null;
        return from.slice(at + 1).trim() || null;
    }

    async checkDomainAuthSignals() {
        const domain = this.getFromDomain();
        if (!domain) return;

        const hasRecord = async (hostname, predicate) => {
            try {
                const txtRecords = await dns.resolveTxt(hostname);
                const flattened = (txtRecords || []).map((parts) => parts.join('')).filter(Boolean);
                return flattened.some((record) => predicate(String(record || '')));
            } catch (_) {
                return false;
            }
        };

        const hasSpf = await hasRecord(domain, (record) => /^v=spf1\b/i.test(record));
        const hasDmarc = await hasRecord(`_dmarc.${domain}`, (record) => /^v=dmarc1\b/i.test(record));
        const hasDefaultDkim = await hasRecord(`default._domainkey.${domain}`, (record) => /^v=dkim1\b/i.test(record));

        if (hasSpf && hasDmarc && hasDefaultDkim) {
            console.log(`✅ Email domain auth checks passed for ${domain} (SPF, DKIM, DMARC detected)`);
            return;
        }

        const missing = [
            hasSpf ? null : 'SPF',
            hasDefaultDkim ? null : 'DKIM(default selector)',
            hasDmarc ? null : 'DMARC'
        ].filter(Boolean);

        console.warn(`⚠️  Email domain auth hardening: missing ${missing.join(', ')} for ${domain}`);
    }

    async canSendToRecipient(to) {
        const recipient = this.normalizeEmail(to);
        if (!recipient) {
            return { allowed: false, reason: 'Missing recipient' };
        }

        const now = Date.now();
        const minuteWindowSec = 60;
        const abuseWindowSec = Math.max(1, Math.floor(this.emailAbuseWindowMs / 1000));

        // Try DB-backed transactional check (uses advisory lock) if DB is available
        try {
            if (MySQLDatabaseManager?.connection?.pool) {
                await this.ensureEmailLogTable();

                // Acquire a per-recipient advisory lock to avoid race windows across instances
                const lockName = 'email_send_lock_' + crypto.createHash('sha256').update(recipient).digest('hex');
                let gotLock = false;
                try {
                    const [lockRes] = await MySQLDatabaseManager.connection.pool.query('SELECT GET_LOCK(?, 5) AS got', [lockName]);
                    gotLock = Boolean(lockRes && lockRes[0] && Number(lockRes[0].got) === 1);

                    // If we couldn't get the lock quickly, fall back to non-locked DB check (best-effort)
                    if (!gotLock) {
                        // Global sends in last minute
                        const [globalRows] = await MySQLDatabaseManager.connection.pool.query(
                            `SELECT COUNT(*) AS cnt FROM email_delivery_logs WHERE status = 'sent' AND created_at > DATE_SUB(NOW(), INTERVAL ? SECOND)`,
                            [minuteWindowSec]
                        );
                        const globalCount = Number((globalRows && globalRows[0] && globalRows[0].cnt) || 0);
                        if (globalCount >= this.maxGlobalEmailsPerMinute) {
                            return { allowed: false, reason: 'Global email rate limit reached' };
                        }

                        const [recipientRows] = await MySQLDatabaseManager.connection.pool.query(
                            `SELECT COUNT(*) AS cnt, UNIX_TIMESTAMP(MAX(created_at)) AS last_ts FROM email_delivery_logs WHERE recipient_email = ? AND status = 'sent' AND created_at > DATE_SUB(NOW(), INTERVAL ? SECOND)`,
                            [recipient, abuseWindowSec]
                        );
                        const recipientCount = Number((recipientRows && recipientRows[0] && recipientRows[0].cnt) || 0);
                        const lastTsSec = Number((recipientRows && recipientRows[0] && recipientRows[0].last_ts) || 0);
                        if (recipientCount >= this.maxRecipientEmailsPerWindow) {
                            return { allowed: false, reason: 'Recipient hourly limit reached' };
                        }
                        const lastMs = lastTsSec ? (lastTsSec * 1000) : 0;
                        if (lastMs && (now - lastMs) < (this.minSecondsBetweenSameRecipient * 1000)) {
                            return { allowed: false, reason: 'Recipient cooldown active' };
                        }

                        return { allowed: true };
                    }

                    // With lock held: perform checks and return while holding the lock to avoid races
                    const [globalRows] = await MySQLDatabaseManager.connection.pool.query(
                        `SELECT COUNT(*) AS cnt FROM email_delivery_logs WHERE status = 'sent' AND created_at > DATE_SUB(NOW(), INTERVAL ? SECOND)`,
                        [minuteWindowSec]
                    );
                    const globalCount = Number((globalRows && globalRows[0] && globalRows[0].cnt) || 0);
                    if (globalCount >= this.maxGlobalEmailsPerMinute) {
                        return { allowed: false, reason: 'Global email rate limit reached' };
                    }

                    const [recipientRows] = await MySQLDatabaseManager.connection.pool.query(
                        `SELECT COUNT(*) AS cnt, UNIX_TIMESTAMP(MAX(created_at)) AS last_ts FROM email_delivery_logs WHERE recipient_email = ? AND status = 'sent' AND created_at > DATE_SUB(NOW(), INTERVAL ? SECOND)`,
                        [recipient, abuseWindowSec]
                    );
                    const recipientCount = Number((recipientRows && recipientRows[0] && recipientRows[0].cnt) || 0);
                    const lastTsSec = Number((recipientRows && recipientRows[0] && recipientRows[0].last_ts) || 0);
                    if (recipientCount >= this.maxRecipientEmailsPerWindow) {
                        return { allowed: false, reason: 'Recipient hourly limit reached' };
                    }
                    const lastMs = lastTsSec ? (lastTsSec * 1000) : 0;
                    if (lastMs && (now - lastMs) < (this.minSecondsBetweenSameRecipient * 1000)) {
                        return { allowed: false, reason: 'Recipient cooldown active' };
                    }

                    return { allowed: true };
                } finally {
                    try {
                        if (gotLock) {
                            await MySQLDatabaseManager.connection.pool.query('SELECT RELEASE_LOCK(?)', [lockName]);
                        }
                    } catch (releaseErr) {
                        // ignore release errors
                    }
                }
            }
        } catch (dbErr) {
            // fall back to in-memory checks below
            console.warn('⚠️  EmailHelper DB transactional check failed, falling back to in-memory checks:', dbErr?.message || dbErr);
        }

        // In-memory fallback (existing behavior)
        const minuteWindow = 60 * 1000;

        this.globalSendHistory = this.globalSendHistory.filter((ts) => now - ts < minuteWindow);
        if (this.globalSendHistory.length >= this.maxGlobalEmailsPerMinute) {
            return { allowed: false, reason: 'Global email rate limit reached' };
        }

        const recipientHistory = (this.recipientSendHistory.get(recipient) || [])
            .filter((ts) => now - ts < this.emailAbuseWindowMs);
        this.recipientSendHistory.set(recipient, recipientHistory);

        if (recipientHistory.length >= this.maxRecipientEmailsPerWindow) {
            return { allowed: false, reason: 'Recipient hourly limit reached' };
        }

        const latestSend = recipientHistory.length > 0 ? recipientHistory[recipientHistory.length - 1] : 0;
        if (latestSend && (now - latestSend) < (this.minSecondsBetweenSameRecipient * 1000)) {
            return { allowed: false, reason: 'Recipient cooldown active' };
        }

        return { allowed: true };
    }

    markRecipientSend(to) {
        const recipient = this.normalizeEmail(to);
        if (!recipient) return;

        const now = Date.now();
        const recipientHistory = (this.recipientSendHistory.get(recipient) || [])
            .filter((ts) => now - ts < this.emailAbuseWindowMs);
        recipientHistory.push(now);
        this.recipientSendHistory.set(recipient, recipientHistory);
        this.globalSendHistory.push(now);
    }

    async sendAppealResponseEmail(userEmail, userName, appealStatus, response) {
        const EmailTemplates = require('./EmailTemplates');
        const statusEmoji = appealStatus === 'accepted' ? '✅' : '❌';
        const statusText = appealStatus === 'accepted' ? 'Accepted' : 'Denied';
        const html = EmailTemplates.appealResponse({ userName, appealStatus, response, statusEmoji, statusText });
        return this.sendEmail(userEmail, `Ban Appeal ${statusText}`, html, '', { templateName: 'appeal_response' });
    }

    async sendNewAppealNotification(adminEmail, userName, userId, reason) {
        const EmailTemplates = require('./EmailTemplates');
        const html = EmailTemplates.newAppealNotification({
            userName,
            userId,
            reason,
            date: new Date().toLocaleString()
        });

        return this.sendEmail(adminEmail, `New Ban Appeal from ${userName}`, html, '', { templateName: 'appeal_notification' });
    }

    async sendAppealReceivedEmail(userEmail, userName, caseId) {
        const EmailTemplates = require('./EmailTemplates');
        const html = EmailTemplates.appealReceived({ userName, caseId });
        return this.sendEmail(userEmail, 'Your Ban Appeal Was Received', html, '', { templateName: 'appeal_received' });
    }

    async sendRegistrationWelcomeEmail(userEmail, userName, role = 'moderator') {
        const EmailTemplates = require('./EmailTemplates');
        const html = EmailTemplates.registrationWelcome({ userName, role });
        return this.sendEmail(userEmail, 'Welcome to the Admin Panel', html, '', { templateName: 'registration_welcome' });
    }

    async sendEmailVerificationEmail(userEmail, userName, token) {
        const EmailTemplates = require('./EmailTemplates');
        const verifyUrl = `${this.getAdminPanelBaseUrl()}/verify-email?token=${encodeURIComponent(token)}`;
        const html = EmailTemplates.emailVerification({ userName, verifyUrl });
        return this.sendEmail(userEmail, 'Verify Your Email Address', html, '', { templateName: 'email_verification' });
    }

    async sendPasswordResetEmail(userEmail, userName, token) {
        const EmailTemplates = require('./EmailTemplates');
        const resetUrl = `${this.getAdminPanelBaseUrl()}/recovery?resetToken=${encodeURIComponent(token)}`;
        const html = EmailTemplates.passwordReset({ userName, resetUrl });
        return this.sendEmail(userEmail, 'Password Reset Request', html, '', { templateName: 'password_reset' });
    }

    async sendSecurityAlertEmail(userEmail, userName, alertTitle, details = []) {
        const EmailTemplates = require('./EmailTemplates');
        const html = EmailTemplates.securityAlert({ userName, alertTitle, details });
        return this.sendEmail(userEmail, `Security Alert: ${alertTitle}`, html, '', { templateName: 'security_alert' });
    }

    isReady() {
        return this.isConfigured && this.transporter !== null;
    }
}

module.exports = new EmailHelper();