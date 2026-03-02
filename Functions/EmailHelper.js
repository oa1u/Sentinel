// Email helper
// Utilities for initializing SMTP transport, sending emails safely with
// throttling/anti-abuse checks, and logging delivery results to the DB.
const nodemailer = require('nodemailer');
const path = require('path');
const { promises: dns } = require('dns');
const crypto = require('crypto');
const MySQLDatabaseManager = require('./MySQLDatabaseManager');

class EmailHelper {
    async isValidEmail(email) {
        if (!email || typeof email !== 'string') return false;
        const normalized = email.trim().toLowerCase();
        // RFC 5322 basic regex
        const rfcRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
        if (!rfcRegex.test(normalized) || normalized.length > 254) return false;
        // Disposable domains list (expand as needed)
        const disposableDomains = [
            'mailinator.com', '10minutemail.com', 'guerrillamail.com', 'tempmail.com', 'yopmail.com', 'dispostable.com', 'trashmail.com', 'fakeinbox.com', 'getnada.com', 'mintemail.com', 'moakt.com', 'mytemp.email', 'throwawaymail.com', 'maildrop.cc', 'mailcatch.com', 'spambox.us', 'mailnesia.com', 'spamgourmet.com', 'sharklasers.com', 'grr.la', 'mail.com', 'email.com'
        ];
        const domain = this.extractDomain(normalized);
        if (!domain || disposableDomains.includes(domain)) return false;
        // MX record check
        try {
            const mxRecords = await require('dns').promises.resolveMx(domain);
            if (!mxRecords || mxRecords.length === 0) return false;
        } catch (err) {
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
                const mainCfg = require('../Config/main.json');
                const emailCfg = mainCfg?.Email || mainCfg?.email || {};
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
        const templateName = String(metadata?.templateName || 'generic').trim() || 'generic';

        if (!this.isConfigured || !this.transporter) {
            console.warn('⚠️  Email system not configured. Skipping email send.');
            await this.logEmailDelivery({ to, subject, templateName, status: 'blocked', errorMessage: 'Email system not configured' });
            return { success: false, error: 'Email system not configured' };
        }

        // perform abuse/throttle checks (DB-backed when possible)
        const throttleCheck = await this.canSendToRecipient(to);
        if (!throttleCheck.allowed) {
            console.warn(`⚠️  Email blocked by anti-abuse policy: ${throttleCheck.reason}`);
            await this.logEmailDelivery({ to, subject, templateName, status: 'blocked', errorMessage: throttleCheck.reason });
            return { success: false, error: throttleCheck.reason };
        }

        try {
            const result = await this.transporter.sendMail({
                from: this.fromAddress,
                to,
                subject,
                text: text || html.replace(/<[^>]*>/g, ''), // Strip HTML for plain text
                html
            });

            console.log('✅ Email sent successfully');
            this.markRecipientSend(to);
            await this.logEmailDelivery({ to, subject, templateName, status: 'sent', messageId: result.messageId });
            return { success: true, messageId: result.messageId };
        } catch (error) {
            console.error('❌ Failed to send email:', error.message);
            await this.logEmailDelivery({ to, subject, templateName, status: 'failed', errorMessage: error.message });
            return { success: false, error: error.message };
        }
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
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_created (created_at),
                    INDEX idx_status (status),
                    INDEX idx_template (template_name),
                    INDEX idx_recipient_domain (recipient_domain)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            this.emailLogTableEnsured = true;
        } catch (error) {
            console.warn('⚠️  Unable to ensure email_delivery_logs table:', error.message);
        }
    }

    extractDomain(email) {
        const normalized = String(email || '').trim().toLowerCase();
        const atIndex = normalized.lastIndexOf('@');
        if (atIndex <= 0) return null;
        const domain = normalized.slice(atIndex + 1);
        return domain || null;
    }

    async logEmailDelivery({ to, subject, templateName, status, errorMessage = null, messageId = null }) {
        try {
            if (!MySQLDatabaseManager?.connection?.pool) return;
            await this.ensureEmailLogTable();

            const recipientEmail = String(to || '').trim().toLowerCase();
            if (!recipientEmail) return;

            await MySQLDatabaseManager.connection.pool.execute(
                `INSERT INTO email_delivery_logs
                    (recipient_email, recipient_domain, template_name, subject, status, error_message, message_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    recipientEmail,
                    this.extractDomain(recipientEmail),
                    String(templateName || 'generic').slice(0, 100),
                    String(subject || '').slice(0, 255) || null,
                    status,
                    errorMessage ? String(errorMessage) : null,
                    messageId ? String(messageId).slice(0, 255) : null
                ]
            );
        } catch (error) {
            console.warn('⚠️  Failed to write email analytics log:', error.message);
        }
    }

    getAdminPanelBaseUrl() {
        const explicit = String(process.env.ADMIN_PANEL_URL || '').trim();
        if (explicit) return explicit.replace(/\/$/, '');
        const host = String(process.env.ADMIN_ORIGIN || '').trim();
        if (host) return host.replace(/\/$/, '');
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
        const recipient = String(to || '').trim().toLowerCase();
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
        const recipient = String(to || '').trim().toLowerCase();
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

    async sendBanNotificationEmail(userEmail, userName, reason) {
        // This function is now deprecated. No email will be sent.
        return { success: false, error: 'Ban notification email template removed.' };
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