const path = require('path');
const fs = require('fs');

// Load configurations dynamically
let config = {};
try {
    const configPath = path.join(__dirname, '..', 'Config', 'main.json');
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.error('Failed to load main.json in EmailTemplates:', e);
}

const serverName = config.serverName || 'Our Server';
const websiteLink = config.WebsiteLink || '#';
const serverInvite = config.ServerInvite || '';
const botName = config.botName || 'Sentinel';
const supportHost = websiteLink.replace(/^https?:\/\//, '').split('/')[0] || 'example.com';
const supportEmail = String(process.env.ADMIN_EMAIL || '').trim() || `support@${supportHost}`;

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function sanitizeUrl(value, fallback = '#') {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    if (/^https?:\/\//i.test(raw)) return raw;
    return fallback;
}

function hasValidServerInvite(inviteUrl) {
    const raw = String(inviteUrl || '').trim();
    if (!raw || !/^https?:\/\//i.test(raw)) return false;

    // Block obvious placeholders to avoid sending broken invite links.
    const lowered = raw.toLowerCase();
    if (lowered.includes('your_invite_code')) return false;
    if (lowered.includes('example.com')) return false;

    return true;
}

function formatRole(value, fallback = 'Moderator') {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return fallback;
    return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function listItems(items = []) {
    if (!Array.isArray(items) || items.length === 0) return '';
    const safeItems = items
        .filter(Boolean)
        .map((item) => `<li>${escapeHtml(String(item))}</li>`)
        .join('');

    if (!safeItems) return '';
    return `<ul class="item-list">${safeItems}</ul>`;
}

function detailsBlock(title, rows = []) {
    const validRows = Array.isArray(rows) ? rows.filter((row) => row && row.label) : [];
    if (validRows.length === 0) return '';

    const body = validRows
        .map((row) => `
            <div class="kv-row">
                <span class="kv-label">${escapeHtml(row.label)}</span>
                <span class="kv-value">${escapeHtml(row.value ?? '')}</span>
            </div>
        `)
        .join('');

    return `
        <div class="details-block">
            <h3>${escapeHtml(title)}</h3>
            ${body}
        </div>
    `;
}

function actionButton(url, label) {
    const safeUrl = sanitizeUrl(url);
    const safeLabel = escapeHtml(label || 'Open Dashboard');
    return `<a href="${safeUrl}" class="btn">${safeLabel}</a>`;
}

// Core Email Wrapper for Consistent Styling Structure
const BaseTemplate = (content, headerTitle = '', footerHelpText) => {
    const helpLine = footerHelpText || `Need help? Visit the <a href="${sanitizeUrl(websiteLink)}">Admin Dashboard</a> or contact <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>.`;

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { margin: 0; padding: 0; background: #f2f5fa; font-family: 'Segoe UI', Tahoma, Arial, sans-serif; color: #1f2937; }
        .wrapper { width: 100%; table-layout: fixed; background: #f2f5fa; padding: 28px 0 40px 0; }
        .shell { max-width: 680px; margin: 0 auto; }
        .card { background: #ffffff; border: 1px solid #dbe4f0; border-radius: 14px; overflow: hidden; box-shadow: 0 8px 26px rgba(17, 24, 39, 0.08); }
        .header { padding: 26px 32px; background: linear-gradient(135deg, #0f2b52 0%, #1d4e89 100%); color: #ffffff; }
        .brand { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.86; margin-bottom: 8px; }
        .header h2 { margin: 0; font-size: 24px; line-height: 1.3; font-weight: 700; }
        .main { padding: 28px 32px; }
        .content p { margin: 0 0 14px 0; font-size: 15px; line-height: 1.7; color: #344054; }
        .content strong { color: #0b1320; }
        .status { border-radius: 10px; padding: 12px 14px; margin-bottom: 18px; font-size: 14px; font-weight: 700; border: 1px solid transparent; }
        .status.info { background: #eaf2ff; border-color: #c4d8ff; color: #0f4ea3; }
        .status.success { background: #e9f8ef; border-color: #b9ebca; color: #13653c; }
        .status.warning { background: #fff5e7; border-color: #ffddb0; color: #8a5100; }
        .status.danger { background: #ffecec; border-color: #ffc9c9; color: #8f1f1f; }
        .details-block { background: #f8fbff; border: 1px solid #deebfb; border-radius: 10px; padding: 16px 18px; margin: 16px 0 18px 0; }
        .details-block h3 { margin: 0 0 10px 0; font-size: 15px; color: #1e3a5f; }
        .kv-row { margin-bottom: 10px; }
        .kv-row:last-child { margin-bottom: 0; }
        .kv-label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; margin-bottom: 3px; font-weight: 700; }
        .kv-value { font-size: 15px; color: #0f172a; display: block; word-break: break-word; }
        .item-list { margin: 10px 0 14px 20px; padding: 0; color: #1f2937; }
        .item-list li { margin-bottom: 8px; line-height: 1.6; }
        .btn-wrap { text-align: center; margin: 18px 0 12px 0; }
        .btn { display: inline-block; text-decoration: none; background: #0f4ea3; color: #ffffff !important; font-size: 14px; font-weight: 700; padding: 12px 22px; border-radius: 8px; }
        .inline-link { color: #0f4ea3; text-decoration: none; word-break: break-all; }
        .chip { display: inline-block; background: #eef4ff; color: #234372; border: 1px solid #cfe0ff; border-radius: 999px; padding: 5px 12px; font-size: 13px; font-weight: 700; }
        .note { font-size: 13px; color: #52607a; background: #f7fafc; border-left: 3px solid #9bb6de; padding: 10px 12px; border-radius: 6px; margin-top: 12px; }
        .footer { padding: 18px 32px 24px 32px; background: #fbfdff; border-top: 1px solid #e3edf7; }
        .footer p { margin: 0 0 8px 0; font-size: 12px; line-height: 1.6; color: #64748b; }
        .footer a { color: #0f4ea3; text-decoration: none; }
        @media screen and (max-width: 680px) {
            .wrapper { padding: 12px 0 0 0; }
            .card { border-radius: 0; border-left: 0; border-right: 0; }
            .header, .main, .footer { padding-left: 20px; padding-right: 20px; }
            .header { padding-top: 22px; padding-bottom: 22px; }
        }
    </style>
</head>
<body>
    <center class="wrapper">
        <div class="shell">
            <table class="card" role="presentation">
                <tr>
                    <td class="header">
                        <div class="brand">${escapeHtml(serverName)} Administration</div>
                        <h2>${escapeHtml(headerTitle || botName)}</h2>
                    </td>
                </tr>
                <tr>
                    <td class="main">
                        <div class="content">
                            ${content}
                        </div>
                    </td>
                </tr>
                <tr>
                    <td class="footer">
                        <p>This is an automated message sent by <strong>${escapeHtml(serverName)}</strong>. Replies to this address are not monitored.</p>
                        <p>${helpLine}</p>
                        <p>Powered by ${escapeHtml(botName)}</p>
                    </td>
                </tr>
            </table>
        </div>
    </center>
</body>
</html>
`;
};

const templates = {
    appealResponse: ({ userName, appealStatus, response, statusEmoji, statusText }) => {
        const isAccepted = appealStatus === 'accepted';
        const statusClass = isAccepted ? 'success' : 'danger';
        const inviteIsValid = hasValidServerInvite(serverInvite);
        const safeServerInvite = inviteIsValid ? sanitizeUrl(serverInvite, '') : '';
        const inviteSection = isAccepted && inviteIsValid
            ? `
            <p><strong>Server Invite:</strong></p>
            <div class="btn-wrap">${actionButton(safeServerInvite, 'Join Server')}</div>
            <p>If the button does not open, use this direct link:<br><a href="${safeServerInvite}" class="inline-link">${escapeHtml(safeServerInvite)}</a></p>
            <div class="note">Use this invite link to rejoin the server. If it has expired, contact support for a new one.</div>
            `
            : isAccepted
                ? `<div class="note">Your appeal was accepted. Contact support for a fresh invite.</div>`
                : '';
        const nextSteps = isAccepted
            ? [
                'You may rejoin the server immediately if no additional restrictions are active.',
                'Review the community rules and available guidance before messaging again.',
                'Future violations may result in stricter penalties or permanent action.'
            ]
            : [
                'This decision applies to the current appeal and does not change prior moderation records.',
                'You may submit a new appeal after 7 days if new context becomes available.',
                'Repeated or abusive submissions may be ignored.'
            ];

        const content = `
            <div class="status ${statusClass}">
                ${escapeHtml(statusEmoji || '')} Appeal Decision: ${escapeHtml(statusText || (isAccepted ? 'Accepted' : 'Denied'))}
            </div>
            <p>Hello <strong>${escapeHtml(userName)}</strong>,</p>
            <p>Your appeal has been reviewed by the moderation team. The outcome and reviewer response are provided below for your records.</p>
            
            ${detailsBlock('Review Summary', [
            { label: 'Decision', value: statusText || (isAccepted ? 'Accepted' : 'Denied') },
            { label: 'Status', value: appealStatus || 'Unknown' },
            { label: 'Reference', value: 'Appeal response notification' }
        ])}

            ${detailsBlock('Administrator Response', [
            { label: 'Message', value: response || 'No additional details were provided.' }
        ])}
            
            <p><strong>What happens next:</strong></p>
            ${listItems(nextSteps)}
                        ${inviteSection}

            <div class="note">If you have additional evidence that was not included in your original submission, contact support and include relevant proof.</div>
        `;
        return BaseTemplate(
            content,
            'Appeal Decision Update',
            `Need help? Contact <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>.`
        );
    },

    appealReceived: ({ userName, caseId }) => {
        const content = `
            <div class="status info">
                Appeal Submitted Successfully
            </div>
            <p>Hello <strong>${escapeHtml(userName)}</strong>,</p>
            <p>We received your appeal and added it to the moderation review queue. This message confirms the submission was recorded successfully.</p>
            
            ${detailsBlock('Submission Details', [
            { label: 'Case ID', value: caseId },
            { label: 'Estimated review window', value: '24 to 48 hours' },
            { label: 'Queue', value: 'Administrative review' }
        ])}
            
            <p><strong>What to expect next:</strong></p>
            ${listItems([
            'A moderator will evaluate your appeal content and account history.',
            'You may receive a follow-up request if additional context is needed.',
            'You will receive a final decision by email once the review is complete.'
        ])}

            <div class="note">Please keep your case ID for reference when contacting support.</div>
        `;
        return BaseTemplate(
            content,
            'Appeal Confirmation',
            `Need help? Contact <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>.`
        );
    },

    registrationWelcome: ({ userName, role }) => {
        const roleLabel = formatRole(role);

        const content = `
            <div class="status success">
                Account Created
            </div>
            <p>Hello <strong>${escapeHtml(userName)}</strong>,</p>
            <p>Your administration panel account has been created and is now active.</p>
            
            ${detailsBlock('Access Summary', [
            { label: 'Display name', value: userName },
            { label: 'Assigned role', value: roleLabel },
            { label: 'Portal', value: sanitizeUrl(`${websiteLink}/login`) }
        ])}

            <p>Your current permission tier is: <span class="chip">${escapeHtml(roleLabel)}</span></p>

            <p><strong>Recommended first steps:</strong></p>
            ${listItems([
            'Sign in and verify your profile details.',
            'Enable Two-Factor Authentication (2FA) in account settings.',
            'Review moderation and escalation procedures before taking action.'
        ])}
            
            <div class="btn-wrap">${actionButton(`${websiteLink}/login`, 'Sign In to Dashboard')}</div>
        `;
        return BaseTemplate(content, 'Welcome to ' + botName + ' Admin');
    },

    emailVerification: ({ userName, verifyUrl }) => {
        const safeVerifyUrl = sanitizeUrl(verifyUrl);
        const content = `
            <div class="status info">
                Email Verification Required
            </div>
            <p>Hello <strong>${escapeHtml(userName)}</strong>,</p>
            <p>To complete account setup and enable full platform access, please verify your email address.</p>
            
            <div class="btn-wrap">${actionButton(safeVerifyUrl, 'Verify Email Address')}</div>

            ${detailsBlock('Verification Details', [
            { label: 'Recipient', value: userName },
            { label: 'Link validity', value: '24 hours from the time of this email' },
            { label: 'Action required', value: 'Confirm your email to activate login features' }
        ])}
            
            <p>
                If the button does not open, use this direct link:<br>
                <a href="${safeVerifyUrl}" class="inline-link">${escapeHtml(safeVerifyUrl)}</a>
            </p>
            
            <div class="note">If you did not request this verification, no action is needed. The link expires automatically.</div>
        `;
        return BaseTemplate(content, 'Verify Your Email');
    },

    passwordReset: ({ userName, resetUrl }) => {
        const safeResetUrl = sanitizeUrl(resetUrl);
        const content = `
            <div class="status warning">
                Password Reset Request
            </div>
            <p>Hello <strong>${escapeHtml(userName)}</strong>,</p>
            <p>We received a request to reset the password for your account.</p>
            
            <div class="btn-wrap">${actionButton(safeResetUrl, 'Reset Password')}</div>

            ${detailsBlock('Reset Request Details', [
            { label: 'Requested for', value: userName },
            { label: 'Link expiration', value: '30 minutes' },
            { label: 'Recommended action', value: 'Complete the reset and sign out of older sessions' }
        ])}
            
            <p>
                Direct reset link:<br>
                <a href="${safeResetUrl}" class="inline-link">${escapeHtml(safeResetUrl)}</a>
            </p>
            
            <div class="note">If you did not request this, ignore this email. Your current password will remain unchanged unless the reset link is used.</div>
        `;
        return BaseTemplate(content, 'Reset Your Password');
    },

    securityAlert: ({ userName, alertTitle, details }) => {
        const safeAlertTitle = String(alertTitle || 'Unusual security event detected').trim();
        const detailList = listItems(Array.isArray(details) ? details : []);

        const content = `
            <div class="status danger">
                Security Alert
            </div>
            <p>Hello <strong>${escapeHtml(userName)}</strong>,</p>
            <p>We detected activity that requires your immediate attention.</p>
            
            ${detailsBlock('Event Summary', [
            { label: 'Alert', value: safeAlertTitle },
            { label: 'Account', value: userName },
            { label: 'Priority', value: 'High' }
        ])}

            ${detailList ? `<p><strong>Observed indicators:</strong></p>${detailList}` : ''}
            
            <p><strong>Immediate steps:</strong></p>
            ${listItems([
            'Reset your password and revoke active sessions if available.',
            'Enable or reconfigure Two-Factor Authentication.',
            'Notify server ownership or security staff for incident follow-up.'
        ])}

            <div class="btn-wrap">${actionButton(`${websiteLink}/profile`, 'Open Security Settings')}</div>
        `;
        return BaseTemplate(content, 'Security Event Detected');
    },

    newAppealNotification: ({ userName, userId, reason, date }) => {
        const content = `
            <div class="status warning">
                New Appeal Awaiting Review
            </div>
            <p>Hello Administration Team,</p>
            <p>A new ban appeal was submitted and requires moderation review.</p>
            
            ${detailsBlock('Appeal Details', [
            { label: 'User', value: `${userName} (${userId})` },
            { label: 'Submitted at', value: date },
            { label: 'Queue', value: 'Pending administrative decision' }
        ])}

            ${detailsBlock('Appeal Statement', [
            { label: 'Reason provided', value: reason || 'No reason provided.' }
        ])}

            <p><strong>Recommended handling:</strong></p>
            ${listItems([
            'Confirm historical moderation context before deciding.',
            'Respond with a concise, policy-based rationale.',
            'Record action outcomes for audit and analytics.'
        ])}
            
            <div class="btn-wrap">${actionButton(`${websiteLink}/admin`, 'Open Admin Console')}</div>
        `;
        return BaseTemplate(
            content,
            'New Ban Appeal Submitted',
            `Need help? Contact <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>.`
        );
    }
};

module.exports = templates;