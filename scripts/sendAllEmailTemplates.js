const path = require('path');
const crypto = require('crypto');

require('dotenv').config({
    path: path.join(__dirname, '..', 'Config', 'credentials.env'),
    override: false,
    debug: false,
    quiet: true
});

const EmailHelper = require('../Functions/EmailHelper');

function printUsage() {
    console.log('\nEmail Template Bulk Sender\n');
    console.log('Usage:');
    console.log('  node scripts/sendAllEmailTemplates.js <targetEmail>\n');
    console.log('Example:');
    console.log('  node scripts/sendAllEmailTemplates.js admin@example.com\n');
    console.log('Notes:');
    console.log('  - SMTP credentials must be set in Config/credentials.env');
    console.log('  - Required env vars: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ADMIN_EMAIL\n');
}

function randomToken() {
    return crypto.randomBytes(24).toString('hex');
}

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        printUsage();
        process.exit(0);
    }

    const targetEmail = String(args[0] || '').trim().toLowerCase();
    if (!targetEmail) {
        console.error('Missing target email argument.');
        printUsage();
        process.exit(1);
    }

    const smtpConfig = {
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
        from: process.env.ADMIN_EMAIL
    };

    const initialized = await EmailHelper.initialize(smtpConfig);
    if (!initialized) {
        console.error('Email initialization failed. Check SMTP configuration in Config/credentials.env.');
        process.exit(1);
    }

    const valid = await EmailHelper.isValidEmail(targetEmail);
    if (!valid) {
        console.error(`Target email did not pass validation: ${targetEmail}`);
        process.exit(1);
    }

    // Allow immediate sequential sends to the same recipient for this testing run.
    EmailHelper.minSecondsBetweenSameRecipient = 0;

    const sampleUserName = 'Template Preview User';
    const sampleUserId = '123456789012345678';
    const now = new Date().toLocaleString();

    const sends = [
        {
            name: 'appeal_received',
            run: () => EmailHelper.sendAppealReceivedEmail(targetEmail, sampleUserName, 'CASE-EMAIL-001')
        },
        {
            name: 'appeal_response_accepted',
            run: () => EmailHelper.sendAppealResponseEmail(
                targetEmail,
                sampleUserName,
                'accepted',
                'After reviewing your case, your appeal has been approved. Please follow community guidelines moving forward.'
            )
        },
        {
            name: 'appeal_response_denied',
            run: () => EmailHelper.sendAppealResponseEmail(
                targetEmail,
                sampleUserName,
                'denied',
                'Your appeal was reviewed, but we are unable to remove the current action at this time due to policy violations.'
            )
        },
        {
            name: 'registration_welcome',
            run: () => EmailHelper.sendRegistrationWelcomeEmail(targetEmail, sampleUserName, 'moderator')
        },
        {
            name: 'email_verification',
            run: () => EmailHelper.sendEmailVerificationEmail(targetEmail, sampleUserName, randomToken())
        },
        {
            name: 'password_reset',
            run: () => EmailHelper.sendPasswordResetEmail(targetEmail, sampleUserName, randomToken())
        },
        {
            name: 'security_alert',
            run: () => EmailHelper.sendSecurityAlertEmail(
                targetEmail,
                sampleUserName,
                'Unrecognized sign-in attempt',
                [
                    'Location: Unknown region',
                    'Device: New browser session',
                    `Time: ${now}`
                ]
            )
        },
        {
            name: 'new_appeal_notification',
            run: () => EmailHelper.sendNewAppealNotification(
                targetEmail,
                sampleUserName,
                sampleUserId,
                'This is a sample appeal reason to preview admin-facing notification formatting.'
            )
        }
    ];

    const results = [];
    for (const task of sends) {
        try {
            const result = await task.run();
            results.push({ name: task.name, success: Boolean(result && result.success), error: result?.error || '' });
            if (result?.success) {
                console.log(`SENT: ${task.name}`);
            } else {
                console.error(`FAILED: ${task.name}${result?.error ? ` -> ${result.error}` : ''}`);
            }
        } catch (error) {
            results.push({ name: task.name, success: false, error: error?.message || 'Unknown error' });
            console.error(`FAILED: ${task.name} -> ${error?.message || 'Unknown error'}`);
        }
    }

    const successCount = results.filter((item) => item.success).length;
    const failCount = results.length - successCount;

    console.log('\nSummary');
    console.log(`  Target: ${targetEmail}`);
    console.log(`  Sent: ${successCount}/${results.length}`);
    console.log(`  Failed: ${failCount}`);

    if (failCount > 0) {
        console.log('\nFailed items:');
        for (const item of results.filter((entry) => !entry.success)) {
            console.log(`  - ${item.name}: ${item.error || 'Unknown error'}`);
        }
        process.exit(1);
    }

    process.exit(0);
}

main().catch((error) => {
    console.error('Unexpected error while sending templates:', error?.message || error);
    process.exit(1);
});
