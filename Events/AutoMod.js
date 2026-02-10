const { EmbedBuilder, MessageFlags } = require('discord.js');
const MySQLDatabaseManager = require('../Functions/MySQLDatabaseManager');
const { administratorRoleId, moderatorRoleId } = require('../Config/constants/roles.json');
const { serverLogChannelId } = require('../Config/constants/channel.json');
const misc = require('../Config/constants/misc.json');
const blockedWordsList = require('../Config/constants/blockedWords.json');

// This is the AutoMod system! It watches for spam, blocked words, invite links, and more.
// If someone breaks the rules, AutoMod will timeout or warn them automatically.
// TODO: Let admins set custom auto-mute times in the future.

// Load AutoMod configuration with defaults
const AUTOMOD_CONFIG = {
    blockInvites: misc.blockExternalInvites !== undefined ? misc.blockExternalInvites : true,
    maxMentions: misc.maxMentionsBeforeFlag || 6,
    spamThreshold: 5,              // How many messages before it's considered spam
    spamWindow: 5000,              // How quickly those messages have to be sent (ms)
    capsThreshold: 0.70,           // If 70% of a message is caps, it's flagged
    minLengthForCaps: 10,
    spamTimeout: 10 * 60 * 1000,   // Spammers get timed out for 10 minutes
    spamWarningThreshold: 2        // Users get 2 warnings before AutoMod acts
};

// Grab the list of blocked words and phrases from the config.
const blockedWords = Array.isArray(blockedWordsList) ? blockedWordsList : [];
const inviteRegex = /(https?:\/\/)?(www\.)?(discord\.gg|discord\.com\/invite)\/([A-Za-z0-9-]+)/gi;

// We'll keep track of who is spamming, and clean up this data every so often.
const userMessageTimestamps = new Map();

// Remove old spam data so we don't waste memory.
function cleanupSpamData() {
    const now = Date.now();
    const timeout = AUTOMOD_CONFIG.spamWindow * 2;

    for (const [userId, timestamps] of userMessageTimestamps.entries()) {
        const validTimestamps = timestamps.filter(ts => now - ts < timeout);
        
        if (validTimestamps.length === 0) {
            userMessageTimestamps.delete(userId);
        } else {
            userMessageTimestamps.set(userId, validTimestamps);
        }
    }
}

// Every 5 minutes, clean up spam data to keep things running smoothly.
setInterval(cleanupSpamData, 5 * 60 * 1000);

module.exports = {
    name: 'messageCreate',
    runOnce: false,
    call: async (client, args) => {
        const [message] = args;
        
        // Don't bother with bots or direct messages—they aren't moderated here.
        if (!message || message.author.bot) return;
        if (!message.guild) return;

        const member = message.member;
        // If you're staff, you skip all filters. We trust you!
        const isStaff = member?.roles.cache.has(administratorRoleId) || member?.roles.cache.has(moderatorRoleId);
        if (isStaff) return;

        try {
            const violation = await detectViolation(message, client);
            
            if (violation) {
                await handleViolation(message, client, violation);
            }
        } catch (error) {
            console.error('[AutoMod] Error processing message:', error);
        }
    }
};

// Check the message for anything that breaks server rules.
async function detectViolation(message, client) {
    const lower = message.content.toLowerCase();
    
    // Let's see if this message is spam.
    const spamViolation = detectSpam(message);
    if (spamViolation) return spamViolation;

    // Now check if the message is mostly caps.
    const capsViolation = detectExcessiveCaps(message);
    if (capsViolation) return capsViolation;

    // Look for any blocked words or profanity.
    const profanityViolation = detectProfanity(lower);
    if (profanityViolation) return profanityViolation;

    // See if the message contains a Discord invite link.
    if (AUTOMOD_CONFIG.blockInvites) {
        const inviteViolation = await detectInvites(message, client);
        if (inviteViolation) return inviteViolation;
    }

    // Check if the user is mentioning way too many people.
    const mentionViolation = detectMassMentions(message);
    if (mentionViolation) return mentionViolation;

    return null;
}

// Detect spam violations

function detectSpam(message) {
    const userId = message.author.id;
    const now = Date.now();

    if (!userMessageTimestamps.has(userId)) {
        userMessageTimestamps.set(userId, []);
    }

    const timestamps = userMessageTimestamps.get(userId);
    timestamps.push(now);

    // Keep only recent timestamps
    const recentTimestamps = timestamps.filter(
        ts => now - ts < AUTOMOD_CONFIG.spamWindow
    );
    userMessageTimestamps.set(userId, recentTimestamps);

    if (recentTimestamps.length >= AUTOMOD_CONFIG.spamThreshold) {
        return {
            type: 'spam',
            reason: `Spam detected (${recentTimestamps.length} messages in ${AUTOMOD_CONFIG.spamWindow / 1000}s)`,
            action: 'warn'
        };
    }

    return null;
}

// Detect excessive caps

function detectExcessiveCaps(message) {
    if (message.content.length < AUTOMOD_CONFIG.minLengthForCaps) {
        return null;
    }

    const capsCount = (message.content.match(/[A-Z]/g) || []).length;
    const totalLetters = (message.content.match(/[A-Za-z]/g) || []).length;

    if (totalLetters > 0 && capsCount / totalLetters > AUTOMOD_CONFIG.capsThreshold) {
        const capsPercentage = Math.round((capsCount / totalLetters) * 100);
        return {
            type: 'caps',
            reason: `Excessive caps (${capsPercentage}% caps)`,
            action: 'delete'
        };
    }

    return null;
}

// Detect profanity
 
function detectProfanity(lowerContent) {
    if (!blockedWords.length) return null;

    const matched = blockedWords.find(
        word => word && lowerContent.includes(String(word).toLowerCase())
    );

    if (matched) {
        return {
            type: 'profanity',
            reason: 'Inappropriate language detected',
            action: 'delete'
        };
    }

    return null;
}

// Detect invite links

async function detectInvites(message, client) {
    if (!/(discord\.gg|discord\.com\/invite)\//i.test(message.content)) {
        return null;
    }

    const codes = Array.from(message.content.matchAll(inviteRegex))
        .map(m => m[4])
        .filter(Boolean);

    for (const code of codes) {
        try {
            const invite = await client.fetchInvite(code).catch(() => null);

            // No invite found or external invite
            if (!invite) {
                return {
                    type: 'invites',
                    reason: 'External invite link detected',
                    action: 'delete'
                };
            }

            if (invite.guild?.id && invite.guild.id !== message.guild.id) {
                return {
                    type: 'invites',
                    reason: 'External invite link detected',
                    action: 'delete'
                };
            }
        } catch (err) {
            // Error fetching = assume external for safety
            return {
                type: 'invites',
                reason: 'External invite link detected',
                action: 'delete'
            };
        }
    }

    return null;
}

// Detect mass mentions
function detectMassMentions(message) {
    const mentionCount = (message.mentions.users.size || 0) + (message.mentions.roles.size || 0);

    if (AUTOMOD_CONFIG.maxMentions > 0 && mentionCount >= AUTOMOD_CONFIG.maxMentions) {
        return {
            type: 'mentions',
            reason: `Mass mentions (${mentionCount} mentions)`,
            action: 'delete'
        };
    }

    return null;
}

// Handle the violation
async function handleViolation(message, client, violation) {
    const { type, reason, action } = violation;
    const userId = message.author.id;
    const caseId = `AUTOMOD-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Delete the message
    try {
        await message.delete();
    } catch (err) {
        console.error(`[AutoMod] Failed to delete message: ${err.message}`);
    }

    // Log to automod_violations table with caseId, reason, action, etc.
    try {
        await MySQLDatabaseManager.logAutomodViolation(
            userId,
            message.guild.id,
            type,
            message.content.slice(0, 1000),
            message.channel.id,
            action
        );
    } catch (err) {
        console.warn(`[AutoMod] Could not log violation: ${err.message}`);
    }

    // Handle spam with escalating actions
    if (type === 'spam') {
        try {
            const violations = await MySQLDatabaseManager.getAutomodViolations(userId, 24); // Check last 24 hours
            const spamViolations = Array.isArray(violations)
                ? violations.filter(v => v.violation_type === 'spam')
                : [];
            if (spamViolations.length >= AUTOMOD_CONFIG.spamWarningThreshold) {
                // Timeout after multiple violations
                try {
                    const timeoutMs = Number(AUTOMOD_CONFIG.spamTimeout) || 10 * 60 * 1000;
                    // Check for existing active timeout for this user
                    const [existingTimeouts] = await MySQLDatabaseManager.connection.query(
                        `SELECT * FROM timeouts WHERE user_id = ? AND active = TRUE AND issued_by = 'AutoMod'`,
                        [userId]
                    );
                    if (!existingTimeouts || existingTimeouts.length === 0) {
                        await message.member.timeout(
                            timeoutMs,
                            `AutoMod: Repeated spam violations`
                        );
                        await MySQLDatabaseManager.connection.query(
                            `INSERT INTO timeouts (user_id, username, case_id, reason, issued_at, expires_at, issued_by, active)
                             VALUES (?, ?, ?, ?, NOW(), ?, 'AutoMod', TRUE)`,
                            [
                                userId,
                                message.author.username,
                                caseId,
                                `AutoMod: Repeated spam violations`,
                                Date.now() + timeoutMs
                            ]
                        );
                    }
                    // Always send notification for timeout
                    sendUserNotification(message, `AutoMod: Repeated spam violations`, 'spam', caseId);
                } catch (err) {
                    console.error(`[AutoMod] Failed to timeout user or save case: ${err.message}`);
                    // Still notify user even if timeout fails
                    sendUserNotification(message, `AutoMod: Repeated spam violations`, 'spam', caseId);
                }
            } else {
                // Always send notification for warn action
                sendUserNotification(message, reason, type, caseId);
            }
        } catch (err) {
            console.warn(`[AutoMod] Could not check violation history: ${err.message}`);
            // Always notify user if violation check fails
            sendUserNotification(message, reason, type, caseId);
        }
        // Only send one embed for spam
        return;
    }

    // Send DM to user for other violation types
    sendUserNotification(message, reason, type, caseId);

    // Log to server log channel
    logToServerChannel(message, client, reason, type, caseId);
}

// Send DM to violating user
function sendUserNotification(message, reason, violationType, caseId) {
    let embedDescription = 'Your message was automatically removed.';
    let fields = [
        { name: '📌 Reason', value: `\`${reason}\``, inline: true },
        { name: '📋 Case ID', value: `\`${caseId}\``, inline: true }
    ];
    let color = 0xFF6B6B;
    // If user was muted/timed out for spam, show mute info
    if (reason.includes('Repeated spam violations')) {
        // Find timeout duration from config
        const timeoutMs = Number(AUTOMOD_CONFIG.spamTimeout) || 10 * 60 * 1000;
        const minutes = Math.round(timeoutMs / 60000);
        embedDescription = `You have been muted for ${minutes} minutes due to repeated spam violations.`;
        color = 0xFFA500;
        fields.push({ name: '⏳ Duration', value: `${minutes} minutes`, inline: true });
    }
    fields.push({ name: '💡 Tip', value: 'Please review the server rules to avoid future violations.', inline: false });
    const userEmbed = new EmbedBuilder()
        .setColor(color)
        .setAuthor({ name: '⚠️ AutoMod Alert', iconURL: message.guild.iconURL() })
        .setDescription(embedDescription)
        .addFields(fields)
        .setFooter({ text: message.guild.name })
        .setTimestamp();

    message.author.send({ embeds: [userEmbed] }).catch(err => {
        // If DMs are disabled, send ephemeral message in channel
        if (message.channel.send) {
            message.channel.send({
                embeds: [userEmbed],
                flags: MessageFlags.SuppressNotifications
            }).then(msg => {
                setTimeout(() => msg.delete().catch(() => {}), 8000);
            }).catch(() => {});
        }
    });
}

// Log violation to server log channel
function logToServerChannel(message, client, reason, violationType, caseId) {
    const logChannel = message.guild.channels.cache.get(serverLogChannelId);
    if (!logChannel) {
        console.warn('[AutoMod] Server log channel not found');
        return;
    }

    const logEmbed = new EmbedBuilder()
        .setColor(0xFF4444)
        .setAuthor({ name: '🛡️ AutoMod Detection', iconURL: client.user.displayAvatarURL() })
        .setTitle('Message Filtered')
        .setDescription(`A message was automatically removed for violating server rules.`)
        .addFields(
            { name: '👤 User', value: `${message.author} (${message.author.tag})\n\`${message.author.id}\``, inline: true },
            { name: '📍 Channel', value: `${message.channel}\n\`#${message.channel.name}\``, inline: true },
            { name: '⚠️ Reason', value: `\`\`\`${reason}\`\`\``, inline: false },
            { name: '🏷️ Violation Type', value: `\`${violationType}\``, inline: true },
            { name: '📋 Case ID', value: `\`${caseId}\``, inline: true },
            { name: '📝 Message Content', value: message.content ? `\`\`\`${message.content.slice(0, 500)}\`\`\`` : '`(no text content)`', inline: false }
        )
        .setFooter({ text: `User ID: ${message.author.id}` })
        .setTimestamp();

    logChannel.send({ embeds: [logEmbed] }).catch(err => {
        console.error(`[AutoMod] Failed to log to server channel: ${err.message}`);
    });
}