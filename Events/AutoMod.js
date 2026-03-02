const { EmbedBuilder, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
const MySQLDatabaseManager = require('../Functions/MySQLDatabaseManager');
const { administratorRoleId, moderatorRoleId } = require('../Config/constants/roles.json');
const { serverLogChannelId } = require('../Config/constants/channel.json');
const blockedWordsList = require('../Config/constants/blockedWords.json');

// AutoMod: watches for spam, blocked words, invite links and other rule violations.
// Automatically warns or mutes users when they break server rules.


const AUTOMOD_CONFIG_PATH = path.join(__dirname, '..', 'Config', 'constants', 'automod.json');

const DEFAULT_AUTOMOD_CONFIG = {
    blockInvites: true,
    maxMentions: 6,
    spamThreshold: 5,
    spamWindow: 5000,
    capsThreshold: 0.70,
    minLengthForCaps: 10,
    spamTimeout: 10 * 60 * 1000,
    spamWarningThreshold: 2
};

const DEFAULT_ADVANCED_AUTOMOD_CONFIG = {
    exemptChannelIds: [],
    exemptRoleIds: [],
    inviteAllowlistGuildIds: [],
    blockedRegexPatterns: [],
    escalationThreshold24h: 4,
    escalationTimeoutMs: 30 * 60 * 1000
};

let cachedAutoModConfig = null;
let cachedAutoModConfigAt = 0;

function compileBlockedRegexList(patterns) {
    return patterns
        .map((pattern) => {
            try {
                return new RegExp(pattern, 'i');
            } catch (_) {
                console.warn(`[AutoMod] Invalid blocked regex pattern skipped: ${pattern}`);
                return null;
            }
        })
        .filter(Boolean);
}

function readAutoModConfigSafe() {
    try {
        const raw = fs.readFileSync(AUTOMOD_CONFIG_PATH, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        console.error('[AutoMod] Failed to read automod config, using defaults:', error.message);
        return {};
    }
}

function buildEffectiveConfig(rawConfig) {
    const profileName = rawConfig?.autoModProfiles?.activeProfile;
    const profile = profileName && rawConfig?.autoModProfiles?.profiles
        ? rawConfig.autoModProfiles.profiles[profileName]
        : null;

    const mergedAutoMod = {
        ...(rawConfig?.autoMod || {}),
        ...((profile && profile.autoMod) || {})
    };

    const mergedAdvanced = {
        ...(rawConfig?.autoModAdvanced || {}),
        ...((profile && profile.autoModAdvanced) || {})
    };

    const automodConfig = {
        blockInvites: profile?.blockExternalInvites !== undefined
            ? Boolean(profile.blockExternalInvites)
            : (rawConfig.blockExternalInvites !== undefined ? Boolean(rawConfig.blockExternalInvites) : DEFAULT_AUTOMOD_CONFIG.blockInvites),
        maxMentions: Number.isFinite(Number(profile?.maxMentionsBeforeFlag))
            ? Number(profile.maxMentionsBeforeFlag)
            : (Number.isFinite(Number(rawConfig.maxMentionsBeforeFlag)) ? Number(rawConfig.maxMentionsBeforeFlag) : DEFAULT_AUTOMOD_CONFIG.maxMentions),
        spamThreshold: Number.isFinite(Number(mergedAutoMod.spamThreshold)) ? Number(mergedAutoMod.spamThreshold) : DEFAULT_AUTOMOD_CONFIG.spamThreshold,
        spamWindow: Number.isFinite(Number(mergedAutoMod.spamWindow)) ? Number(mergedAutoMod.spamWindow) : DEFAULT_AUTOMOD_CONFIG.spamWindow,
        capsThreshold: Number.isFinite(Number(mergedAutoMod.capsThreshold)) ? Number(mergedAutoMod.capsThreshold) : DEFAULT_AUTOMOD_CONFIG.capsThreshold,
        minLengthForCaps: Number.isFinite(Number(mergedAutoMod.minLengthForCaps)) ? Number(mergedAutoMod.minLengthForCaps) : DEFAULT_AUTOMOD_CONFIG.minLengthForCaps,
        spamTimeout: Number.isFinite(Number(mergedAutoMod.spamTimeout)) ? Number(mergedAutoMod.spamTimeout) : DEFAULT_AUTOMOD_CONFIG.spamTimeout,
        spamWarningThreshold: Number.isFinite(Number(mergedAutoMod.spamWarningThreshold)) ? Number(mergedAutoMod.spamWarningThreshold) : DEFAULT_AUTOMOD_CONFIG.spamWarningThreshold
    };

    const advancedConfig = {
        exemptChannelIds: Array.isArray(mergedAdvanced.exemptChannelIds) ? mergedAdvanced.exemptChannelIds : DEFAULT_ADVANCED_AUTOMOD_CONFIG.exemptChannelIds,
        exemptRoleIds: Array.isArray(mergedAdvanced.exemptRoleIds) ? mergedAdvanced.exemptRoleIds : DEFAULT_ADVANCED_AUTOMOD_CONFIG.exemptRoleIds,
        inviteAllowlistGuildIds: Array.isArray(mergedAdvanced.inviteAllowlistGuildIds) ? mergedAdvanced.inviteAllowlistGuildIds : DEFAULT_ADVANCED_AUTOMOD_CONFIG.inviteAllowlistGuildIds,
        blockedRegexPatterns: Array.isArray(mergedAdvanced.blockedRegexPatterns) ? mergedAdvanced.blockedRegexPatterns : DEFAULT_ADVANCED_AUTOMOD_CONFIG.blockedRegexPatterns,
        escalationThreshold24h: Number.isFinite(Number(mergedAdvanced.escalationThreshold24h)) ? Number(mergedAdvanced.escalationThreshold24h) : DEFAULT_ADVANCED_AUTOMOD_CONFIG.escalationThreshold24h,
        escalationTimeoutMs: Number.isFinite(Number(mergedAdvanced.escalationTimeoutMs)) ? Number(mergedAdvanced.escalationTimeoutMs) : DEFAULT_ADVANCED_AUTOMOD_CONFIG.escalationTimeoutMs
    };

    return {
        profileName: profileName || 'base',
        automodConfig,
        advancedConfig,
        blockedRegexList: compileBlockedRegexList(advancedConfig.blockedRegexPatterns)
    };
}

function getRuntimeAutoModConfig() {
    const now = Date.now();
    if (cachedAutoModConfig && now - cachedAutoModConfigAt < 5000) {
        return cachedAutoModConfig;
    }

    cachedAutoModConfig = buildEffectiveConfig(readAutoModConfigSafe());
    cachedAutoModConfigAt = now;
    return cachedAutoModConfig;
}

// Load blocked words and phrases from the config.
const blockedWords = Array.isArray(blockedWordsList) ? blockedWordsList : [];
const inviteRegex = /(https?:\/\/)?(www\.)?(discord\.gg|discord\.com\/invite)\/([A-Za-z0-9-]+)/gi;

// Track recent message timestamps per user to detect spam; periodically prune old entries.
const userMessageTimestamps = new Map();

// Purge stale spam timestamps to keep memory usage reasonable.
function cleanupSpamData() {
    const now = Date.now();
    const timeout = getRuntimeAutoModConfig().automodConfig.spamWindow * 2;

    for (const [userId, timestamps] of userMessageTimestamps.entries()) {
        const validTimestamps = timestamps.filter(ts => now - ts < timeout);

        if (validTimestamps.length === 0) {
            userMessageTimestamps.delete(userId);
        } else {
            userMessageTimestamps.set(userId, validTimestamps);
        }
    }
}

// Run cleanup periodically to prevent unbounded memory growth.
setInterval(cleanupSpamData, 5 * 60 * 1000);

module.exports = {
    name: 'messageCreate',
    runOnce: false,
    call: async (client, args) => {
        const [message] = args;

        // Ignore bots and direct messages — moderation only runs inside guilds.
        if (!message || message.author.bot) return;
        if (!message.guild) return;

        const member = message.member;
        // If you're staff, you skip all filters. We trust you!
        const isStaff = member?.roles.cache.has(administratorRoleId) || member?.roles.cache.has(moderatorRoleId);
        if (isStaff) return;
        const runtimeConfig = getRuntimeAutoModConfig();
        if (runtimeConfig.advancedConfig.exemptChannelIds.includes(message.channelId)) return;
        if (member?.roles?.cache && runtimeConfig.advancedConfig.exemptRoleIds.some(roleId => member.roles.cache.has(roleId))) return;

        try {
            const violation = await detectViolation(message, client, runtimeConfig);

            if (violation) {
                await handleViolation(message, client, violation, runtimeConfig);
            }
        } catch (error) {
            console.error('[AutoMod] Error processing message:', error);
        }
    }
};

// Check the message for anything that breaks server rules.
async function detectViolation(message, client, runtimeConfig) {
    const lower = message.content.toLowerCase();

    // Let's see if this message is spam.
    const spamViolation = detectSpam(message, runtimeConfig.automodConfig);
    if (spamViolation) return spamViolation;

    // Now check if the message is mostly caps.
    const capsViolation = detectExcessiveCaps(message, runtimeConfig.automodConfig);
    if (capsViolation) return capsViolation;

    // Look for any blocked words or profanity.
    const profanityViolation = detectProfanity(lower);
    if (profanityViolation) return profanityViolation;

    const regexViolation = detectBlockedRegex(message.content || '', runtimeConfig.blockedRegexList);
    if (regexViolation) return regexViolation;

    // See if the message contains a Discord invite link.
    if (runtimeConfig.automodConfig.blockInvites) {
        const inviteViolation = await detectInvites(message, client, runtimeConfig.advancedConfig);
        if (inviteViolation) return inviteViolation;
    }

    // Check if the user is mentioning way too many people.
    const mentionViolation = detectMassMentions(message, runtimeConfig.automodConfig);
    if (mentionViolation) return mentionViolation;

    return null;
}

// Detect spam violations

function detectSpam(message, automodConfig) {
    const userId = message.author.id;
    const now = Date.now();

    if (!userMessageTimestamps.has(userId)) {
        userMessageTimestamps.set(userId, []);
    }

    const timestamps = userMessageTimestamps.get(userId);
    timestamps.push(now);

    // Keep only recent timestamps
    const recentTimestamps = timestamps.filter(
        ts => now - ts < automodConfig.spamWindow
    );
    userMessageTimestamps.set(userId, recentTimestamps);

    if (recentTimestamps.length >= automodConfig.spamThreshold) {
        return {
            type: 'spam',
            reason: `Spam detected (${recentTimestamps.length} messages in ${automodConfig.spamWindow / 1000}s)`,
            action: 'warn'
        };
    }

    return null;
}

// Detect excessive caps

function detectExcessiveCaps(message, automodConfig) {
    if (message.content.length < automodConfig.minLengthForCaps) {
        return null;
    }

    const capsCount = (message.content.match(/[A-Z]/g) || []).length;
    const totalLetters = (message.content.match(/[A-Za-z]/g) || []).length;

    if (totalLetters > 0 && capsCount / totalLetters > automodConfig.capsThreshold) {
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

function detectBlockedRegex(content, blockedRegexList) {
    if (!blockedRegexList.length || !content) return null;

    const matched = blockedRegexList.find(regex => regex.test(content));
    if (matched) {
        return {
            type: 'profanity',
            reason: 'Message matched a blocked pattern',
            action: 'delete'
        };
    }

    return null;
}

// Detect invite links

async function detectInvites(message, client, advancedConfig) {
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
                if (advancedConfig.inviteAllowlistGuildIds.includes(invite.guild.id)) {
                    continue;
                }
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
function detectMassMentions(message, automodConfig) {
    const mentionCount = (message.mentions.users.size || 0) + (message.mentions.roles.size || 0);

    if (automodConfig.maxMentions > 0 && mentionCount >= automodConfig.maxMentions) {
        return {
            type: 'mentions',
            reason: `Mass mentions (${mentionCount} mentions)`,
            action: 'delete'
        };
    }

    return null;
}

// Handle the violation
async function handleViolation(message, client, violation, runtimeConfig) {
    const { type, reason, action } = violation;
    const { automodConfig, advancedConfig } = runtimeConfig;
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
            if (spamViolations.length >= automodConfig.spamWarningThreshold) {
                // Timeout after multiple violations
                try {
                    const timeoutMs = Number(automodConfig.spamTimeout) || 10 * 60 * 1000;
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
                    sendUserNotification(message, `AutoMod: Repeated spam violations`, 'spam', caseId, automodConfig);
                } catch (err) {
                    console.error(`[AutoMod] Failed to timeout user or save case: ${err.message}`);
                    // Still notify user even if timeout fails
                    sendUserNotification(message, `AutoMod: Repeated spam violations`, 'spam', caseId, automodConfig);
                }
            } else {
                // Always send notification for warn action
                sendUserNotification(message, reason, type, caseId, automodConfig);
            }
        } catch (err) {
            console.warn(`[AutoMod] Could not check violation history: ${err.message}`);
            // Always notify user if violation check fails
            sendUserNotification(message, reason, type, caseId, automodConfig);
        }
        // Only send one embed for spam
        return;
    }

    // Global escalation for repeated non-spam violations in last 24h
    try {
        const violations = await MySQLDatabaseManager.getAutomodViolations(userId, 24);
        const totalRecent = Array.isArray(violations) ? violations.length : 0;

        if (totalRecent >= advancedConfig.escalationThreshold24h) {
            const timeoutMs = Math.max(5 * 60 * 1000, advancedConfig.escalationTimeoutMs);
            try {
                await message.member.timeout(timeoutMs, 'AutoMod: Repeated violations within 24 hours');
                await MySQLDatabaseManager.connection.query(
                    `INSERT INTO timeouts (user_id, username, case_id, reason, issued_at, expires_at, issued_by, active)
                     VALUES (?, ?, ?, ?, NOW(), ?, 'AutoMod', TRUE)`,
                    [
                        userId,
                        message.author.username,
                        caseId,
                        'AutoMod: Repeated violations within 24 hours',
                        Date.now() + timeoutMs
                    ]
                );
            } catch (timeoutErr) {
                console.error(`[AutoMod] Failed escalation timeout: ${timeoutErr.message}`);
            }
        }
    } catch (escalationErr) {
        console.warn(`[AutoMod] Escalation check failed: ${escalationErr.message}`);
    }

    // Send DM to user for other violation types
    sendUserNotification(message, reason, type, caseId, automodConfig);

    // Log to server log channel
    logToServerChannel(message, client, reason, type, caseId);
}

// Send DM to violating user
function sendUserNotification(message, reason, violationType, caseId, automodConfig) {
    let embedDescription = 'Your message was automatically removed.';
    let fields = [
        { name: '📌 Reason', value: `\`${reason}\``, inline: true },
        { name: '📋 Case ID', value: `\`${caseId}\``, inline: true }
    ];
    let color = 0xFF6B6B;
    // If user was muted/timed out for spam, show mute info
    if (reason.includes('Repeated spam violations')) {
        // Find timeout duration from config
        const timeoutMs = Number(automodConfig?.spamTimeout) || 10 * 60 * 1000;
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
                setTimeout(() => msg.delete().catch(() => { }), 8000);
            }).catch(() => { });
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