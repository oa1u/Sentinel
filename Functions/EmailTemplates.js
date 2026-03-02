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
const botName = config.botName || 'Sentinel';
const supportHost = websiteLink.replace(/^https?:\/\//, '').split('/')[0] || 'example.com';
const supportEmail = `support@${supportHost}`;

// Core Email Wrapper for Consistent Styling Structure
const BaseTemplate = (content, headerTitle = '') => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f6fb; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }
        .wrapper { width: 100%; table-layout: fixed; background-color: #f4f6fb; padding-bottom: 60px; }
        .webkit { max-width: 600px; margin: 0 auto; }
        .outer-table { width: 100%; max-width: 600px; margin: 0 auto; border-spacing: 0; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.05); margin-top: 40px; }
        .header { background: linear-gradient(135deg, #1e2028 0%, #2a2d39 100%); padding: 30px 40px; text-align: center; border-bottom: 4px solid #5b7fff; }
        .header h2 { color: #ffffff; margin: 0; font-size: 24px; font-weight: 700; letter-spacing: 0.5px; }
        .main { padding: 40px; }
        .content p { font-size: 16px; line-height: 1.6; color: #4b5563; margin-top: 0; margin-bottom: 16px; }
        .content strong { color: #1f2937; }
        .btn { display: inline-block; background-color: #5b7fff; color: #ffffff !important; font-weight: 600; text-decoration: none; padding: 14px 28px; border-radius: 8px; margin: 10px 0 20px 0; font-size: 16px; transition: background-color 0.2s ease; text-align: center; }
        .btn:hover { background-color: #4f6be0; }
        .alert { border-radius: 8px; padding: 18px 20px; margin-bottom: 24px; font-size: 15px; font-weight: 500; display: flex; align-items: center; gap: 10px; }
        .alert-info { background-color: #eff6ff; border-left: 4px solid #5b7fff; color: #1e40af; }
        .alert-success { background-color: #f0fdf4; border-left: 4px solid #22c55e; color: #166534; }
        .alert-warning { background-color: #fffbeb; border-left: 4px solid #f59e0b; color: #92400e; }
        .alert-danger { background-color: #fef2f2; border-left: 4px solid #ef4444; color: #991b1b; }
        .data-box { background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px; margin-bottom: 24px; }
        .data-row { margin-bottom: 16px; }
        .data-row:last-child { margin-bottom: 0; }
        .data-label { font-size: 13px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; display: block; margin-bottom: 4px; }
        .data-value { font-size: 16px; color: #1e293b; }
        .badge { display: inline-block; padding: 6px 12px; border-radius: 9999px; font-size: 14px; font-weight: 600; background-color: #e0e7ff; color: #3730a3; }
        .footer { background-color: #f8fafc; padding: 30px 40px; text-align: center; border-top: 1px solid #e2e8f0; }
        .footer p { margin: 0 0 10px 0; font-size: 13px; color: #64748b; line-height: 1.5; }
        .footer a { color: #5b7fff; text-decoration: none; }
        .footer a:hover { text-decoration: underline; }
        @media screen and (max-width: 600px) { .outer-table { margin-top: 20px !important; border-radius: 0 !important; } .header, .main, .footer { padding: 20px !important; } }
    </style>
</head>
<body>
    <center class="wrapper">
        <div class="webkit">
            <table class="outer-table" role="presentation">
                <tr>
                    <td class="header">
                        <h2>${headerTitle || botName}</h2>
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
                        <p>This is an automated message from <strong>${serverName}</strong>. Please do not reply directly to this email.</p>
                        <p>For assistance, visit our <a href="${websiteLink}">Dashboard</a> or email <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>
                    </td>
                </tr>
            </table>
        </div>
    </center>
</body>
</html>
`;

const templates = {
    appealResponse: ({ userName, appealStatus, response, statusEmoji, statusText }) => {
        const isAccepted = appealStatus === 'accepted';
        const alertClass = isAccepted ? 'alert-success' : 'alert-danger';
        const textColor = isAccepted ? '#22c55e' : '#ef4444';
        
        const content = `
            <div class="alert ${alertClass}">
                ${statusEmoji} <strong>Appeal ${statusText}</strong>
            </div>
            <p>Hello <strong>${userName}</strong>,</p>
            <p>Your ban appeal has been reviewed by the server administration team. The final decision is below:</p>
            
            <div class="data-box">
                <div class="data-row">
                    <span class="data-label">Administrator Response</span>
                    <div class="data-value" style="font-style: italic; border-left: 3px solid #cbd5e1; padding-left: 12px; margin-top: 8px;">
                        ${response}
                    </div>
                </div>
            </div>
            
            <p>
                ${isAccepted 
                    ? `<strong style="color: ${textColor};">You are now able to rejoin the server. Welcome back!</strong>` 
                    : `<strong style="color: ${textColor};">If you believe this decision is unfair, you may submit another appeal after 7 days.</strong>`}
            </p>
        `;
        return BaseTemplate(content, 'Ban Appeal Response');
    },

    appealReceived: ({ userName, caseId }) => {
        const content = `
            <div class="alert alert-info">
                📨 <strong>Appeal Received</strong>
            </div>
            <p>Hello <strong>${userName}</strong>,</p>
            <p>Your ban appeal has been successfully submitted and added to the administrative review queue. Our team will review your case as soon as possible.</p>
            
            <div class="data-box">
                <div class="data-row">
                    <span class="data-label">Case ID</span>
                    <span class="data-value" style="font-family: monospace; font-weight: 600; color: #5b7fff;">${caseId}</span>
                </div>
            </div>
            
            <p>Estimated review time is typically <strong>24-48 hours</strong>. You will receive another notification email once a final decision has been formulated.</p>
        `;
        return BaseTemplate(content, 'Appeal Review Queue');
    },

    registrationWelcome: ({ userName, role }) => {
        const safeRole = String(role || 'moderator').trim().toLowerCase();
        const roleLabel = safeRole.charAt(0).toUpperCase() + safeRole.slice(1);
        
        const content = `
            <div class="alert alert-success">
                ✅ <strong>Account Created Successfully</strong>
            </div>
            <p>Hello <strong>${userName}</strong>,</p>
            <p>Your administration panel account has been activated. You can now log into your dashboard using your registered credentials.</p>
            
            <p>Your current access tier is: <span class="badge">${roleLabel}</span></p>
            
            <p style="margin-top: 24px;">For maximum security, we highly recommend setting up <strong>Two-Factor Authentication (2FA)</strong> inside your profile settings immediately.</p>
            <center>
                <a href="${websiteLink}/login" class="btn">Log In to Dashboard</a>
            </center>
        `;
        return BaseTemplate(content, 'Welcome to ' + botName);
    },

    emailVerification: ({ userName, verifyUrl }) => {
        const content = `
            <div class="alert alert-info">
                📧 <strong>Email Verification Required</strong>
            </div>
            <p>Hello <strong>${userName}</strong>,</p>
            <p>To finalize your account setup and ensure your console access remains secure, we need to verify your email address. Please click the secure link below to verify.</p>
            
            <center>
                <a href="${verifyUrl}" class="btn">Verify Email Address</a>
            </center>
            
            <p style="font-size: 14px; color: #6b7280; text-align: center;">
                If the button above does not work, copy and paste this link into your browser:<br>
                <a href="${verifyUrl}" style="word-break: break-all;">${verifyUrl}</a>
            </p>
            
            <p style="margin-top: 24px; text-align: center;"><small><em>Note: This verification link will automatically expire in 24 hours. If you did not request this, please ignore it.</em></small></p>
        `;
        return BaseTemplate(content, 'Verify Your Email');
    },

    passwordReset: ({ userName, resetUrl }) => {
        const content = `
            <div class="alert alert-warning">
                🔑 <strong>Password Reset Request</strong>
            </div>
            <p>Hello <strong>${userName}</strong>,</p>
            <p>We received a secure request to reset the password associated with your account. If you initiated this, you can proceed by clicking the button below:</p>
            
            <center>
                <a href="${resetUrl}" class="btn">Reset My Password</a>
            </center>
            
            <p style="font-size: 14px; color: #6b7280; text-align: center;">
                If the button does not work, use this direct link:<br>
                <a href="${resetUrl}" style="word-break: break-all;">${resetUrl}</a>
            </p>
            
            <p style="margin-top: 24px; text-align: center;"><small><em>Note: This link will expire in 30 minutes for security purposes. If you did not request a reset, you can safely ignore this email and your password will remain unchanged.</em></small></p>
        `;
        return BaseTemplate(content, 'Reset Your Password');
    },

    securityAlert: ({ userName, alertTitle, details }) => {
        const detailItems = Array.isArray(details)
            ? details.filter(Boolean).map((item) => `<li style="margin-bottom: 8px;">${String(item)}</li>`).join('')
            : '';
            
        const content = `
            <div class="alert alert-danger">
                🚨 <strong>Critical Security Alert</strong>
            </div>
            <p>Hello <strong>${userName}</strong>,</p>
            <p>We noticed a critical security event related to your administration account:</p>
            
            <div class="data-box" style="border-left: 4px solid #ef4444;">
                <h3 style="margin-top: 0; color: #991b1b; font-size: 18px;">${alertTitle}</h3>
                ${detailItems ? `<ul style="color: #1e293b; padding-left: 20px; margin-bottom: 0;">${detailItems}</ul>` : ''}
            </div>
            
            <p><strong>If this wasn't you:</strong> Please reset your password immediately and contact server ownership for emergency assistance to secure your permissions.</p>
        `;
        return BaseTemplate(content, 'Security Event Detected');
    },

    newAppealNotification: ({ userName, userId, reason, date }) => {
        const content = `
            <div class="alert alert-warning">
                ⚠️ <strong>Awaiting Administrative Review</strong>
            </div>
            <p>Hello Administration Team,</p>
            <p>A new ban appeal has been recently submitted on the dashboard and is awaiting your review.</p>
            
            <div class="data-box">
                <div class="data-row">
                    <span class="data-label">User Information</span>
                    <span class="data-value"><strong>${userName}</strong> (${userId})</span>
                </div>
                <div class="data-row">
                    <span class="data-label">Appeal Submitted At</span>
                    <span class="data-value">${date}</span>
                </div>
                <div class="data-row" style="margin-top: 20px; padding-top: 16px; border-top: 1px solid #e2e8f0;">
                    <span class="data-label">Appeal Argument / Reason</span>
                    <div class="data-value" style="font-style: italic; color: #475569;">
                        "${reason}"
                    </div>
                </div>
            </div>
            
            <center>
                <a href="${websiteLink}/admin" class="btn">Open Admin Console</a>
            </center>
        `;
        return BaseTemplate(content, 'New Ban Appeal Submitted');
    }
};

module.exports = templates;