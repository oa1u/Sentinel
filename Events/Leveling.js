const { EmbedBuilder } = require('discord.js');
const MySQLDatabaseManager = require('../Functions/MySQLDatabaseManager');
const { CHANNELS: { levelUpLogChannelId, welcomeChannelId, serverLogChannelId, rulesChannelId }, LEVELING: { config: CONFIG, multipliers: MULTIPLIERS, levelRoles: LEVEL_ROLES }, MISC: misc } = require('../Config/constants');

// Leveling system: awards XP for messages, tracks progress, and handles level-up notifications and rewards.
// TODO: Add per-channel/admin-configurable XP multipliers for finer control.

const cooldowns = new Map();
let lastCleanup = Date.now();
const CLEANUP_INTERVAL = (misc.cleanup?.cooldownCleanupInterval || 300000);
const MAX_COOLDOWN_SIZE = (misc.limits?.maxCooldownEntries || 10000);

// Remove old cooldown entries periodically to avoid memory growth and keep performance steady.
function cleanupCooldowns(force = false) {
    const now = Date.now();

    // If the map gets too big or enough time has passed, clean it up.
    if (force || cooldowns.size > MAX_COOLDOWN_SIZE || (now - lastCleanup > CLEANUP_INTERVAL)) {
        const cutoff = now - CONFIG.xpCooldownMs;

        let removed = 0;
        for (const [key, timestamp] of cooldowns.entries()) {
            if (timestamp < cutoff) {
                cooldowns.delete(key);
                removed++;
            }
        }

        if (removed > 0) {
            console.log(`[Leveling] Cleaned ${removed} old cooldowns (Map size: ${cooldowns.size}/${MAX_COOLDOWN_SIZE})`);
        }

        lastCleanup = now;
    }
}

// Calculate how much XP is required to reach a given level.
function calculateRequiredXP(level) {
    return Math.floor(CONFIG.baseLevelRequirement * Math.pow(CONFIG.levelRequirementMultiplier, level - 1));
}

// Determine the level for a total XP value.
function calculateLevel(xp) {
    let level = 1;
    let totalRequired = 0;

    while (totalRequired <= xp) {
        totalRequired += calculateRequiredXP(level);
        if (totalRequired > xp) break;
        level++;
    }

    return level - 1;
}

// Fetch a user's leveling record from the database (or return sensible defaults for new users).
async function getUserData(userId) {
    try {
        const data = await MySQLDatabaseManager.getUserLevel(userId);
        if (data) {
            return {
                xp: data.xp || 0,
                level: data.level || 1,
                messages: data.messages || 0,
                totalXP: data.total_xp || 0,
                lastXPGain: data.last_message || 0
            };
        }
        // New user, start from scratch
        return {
            xp: 0,
            level: 1,
            messages: 0,
            totalXP: 0,
            lastXPGain: 0
        };
    } catch (error) {
        console.error('[Leveling] Error getting user data:', error);
        return {
            xp: 0,
            level: 1,
            messages: 0,
            totalXP: 0,
            lastXPGain: 0
        };
    }
}

async function saveUserData(userId, data, username) {
    try {
        await MySQLDatabaseManager.setUserLevel(userId, {
            xp: data.xp,
            level: data.level,
            messages: data.messages,
            total_xp: data.totalXP,
            last_message: data.lastXPGain,
            username: username
        });
    } catch (error) {
        console.error('[Leveling] Error saving user data:', error);
    }
}

async function sendFirstMessageHighlight(message) {
    const firstMessageConfig = misc?.firstMessage || {};
    if (firstMessageConfig.enabled === false) return;

    const logTarget = serverLogChannelId
        ? (message.guild.channels.cache.get(serverLogChannelId) || await message.guild.channels.fetch(serverLogChannelId).catch(() => null))
        : null;

    if (firstMessageConfig.logToServerChannel !== false && logTarget?.isTextBased?.()) {
        const logEmbed = new EmbedBuilder()
            .setColor(0x43B581)
            .setTitle('📌 First Message Logged')
            .setDescription(`${message.author.tag} posted their first message.`)
            .addFields(
                {
                    name: 'Member', value: `${message.author.toString()}
\`ID: ${message.author.id}\``, inline: true
                },
                { name: 'Channel', value: message.channel.toString(), inline: true },
                { name: 'Message', value: `[Jump to message](${message.url})`, inline: true }
            )
            .setTimestamp();

        await logTarget.send({ embeds: [logEmbed] }).catch((err) => {
            console.error(`[FirstMessage] Failed to send log highlight: ${err.message}`);
        });
    }

    if (firstMessageConfig.replyToUser !== false) {
        const replyText = String(firstMessageConfig.replyMessage || '').trim();
        if (replyText) {
            const rulesMention = rulesChannelId ? `<#${rulesChannelId}>` : 'the rules channel';
            const resolvedReplyText = replyText.replace(/\{rulesChannel\}/g, rulesMention);
            const mentionUser = firstMessageConfig.replyMention !== false;
            const replyEmbed = new EmbedBuilder()
                .setColor(0x43B581)
                .setTitle(`Welcome to ${message.guild?.name || 'the server'}!`)
                .setDescription(resolvedReplyText)
                .addFields(
                    { name: 'Getting Started', value: `Please read ${rulesMention} and check any pinned guides.`, inline: false },
                    { name: 'Need Help?', value: 'Feel free to ask a staff member if you need anything.', inline: false }
                )
                .setThumbnail(message.author.displayAvatarURL({ size: 128 }))
                .setFooter({ text: 'Thanks for joining us!' });
            const replyPayload = {
                embeds: [replyEmbed],
                allowedMentions: {
                    repliedUser: mentionUser,
                    users: mentionUser ? [message.author.id] : []
                }
            };

            let replied = false;
            if (firstMessageConfig.replyInChannel !== false && message.channel?.isTextBased?.()) {
                try {
                    const replyMessage = await message.reply(replyPayload);
                    setTimeout(() => replyMessage.delete().catch(() => { }), 120000);
                    replied = true;
                } catch (err) {
                    console.error(`[FirstMessage] Failed to reply in channel: ${err.message}`);
                }
            }

            if (!replied && firstMessageConfig.replyInDm === true) {
                try {
                    const dmMessage = await message.author.send({ embeds: [replyEmbed] });
                    setTimeout(() => dmMessage.delete().catch(() => { }), 120000);
                } catch (err) {
                    console.error(`[FirstMessage] Failed to DM user: ${err.message}`);
                }
            }
        }
    }
}

function calculateXPGain(message) {
    let xp = CONFIG.baseXpPerMessage + Math.floor(Math.random() * CONFIG.randomXpVariance);

    if (message.content.length > 100) {
        xp *= MULTIPLIERS.longMessageXpMultiplier;
    }

    if (message.attachments.size > 0) {
        xp *= MULTIPLIERS.messageHasImageXpMultiplier;
    }

    if (message.content.match(/https?:\/\//)) {
        xp *= MULTIPLIERS.messageHasLinkXpMultiplier;
    }

    return Math.floor(xp);
}

// Notify the user (and optionally log) when they level up.
async function sendLevelUpNotification(message, userData, newLevel) {
    const nextLevelXP = calculateRequiredXP(newLevel + 1);
    const currentLevelXP = calculateRequiredXP(newLevel);
    const progressPercentage = Math.round((userData.totalXP / nextLevelXP) * 100);

    const levelUpEmbed = new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle('🎉 Congratulations on Your Level Up!')
        .setDescription(
            `${message.author} has advanced to a new level in the server.\n\n` +
            `Your engagement is appreciated and we're excited to see your continued participation!`
        )
        .setThumbnail(message.author.displayAvatarURL({ size: 256 }))
        .addFields(
            { name: 'New Level Achieved', value: `**${newLevel}**`, inline: true },
            { name: 'Next Level Goal', value: `**${newLevel + 1}**`, inline: true },
            { name: 'Progress', value: `**${progressPercentage}%** toward next level`, inline: true },
            { name: 'Total XP Earned', value: `**${userData.totalXP.toLocaleString()} XP**\n(From ${userData.messages.toLocaleString()} messages)`, inline: false },
            { name: 'XP for Next Level', value: `**${nextLevelXP.toLocaleString()} XP** required`, inline: true },
            { name: 'Level Progression', value: `Level ${newLevel} → Level ${newLevel + 1}`, inline: true }
        )
        .setTimestamp()
        .setFooter({ text: '⭐ Keep up the great work!' });

    // Apply any configured role reward for the new level.
    const levelRoleKey = `level${newLevel}RoleId`;
    if (LEVEL_ROLES[levelRoleKey]) {
        const role = message.guild.roles.cache.get(LEVEL_ROLES[levelRoleKey]);
        if (role) {
            try {
                await message.member.roles.add(role);
                levelUpEmbed.addFields({
                    name: '🏆 Role Reward Unlocked',
                    value: `You have been awarded: ${role.toString()}\n\nThis role grants special perks and recognition in the server.`,
                    inline: false
                });
            } catch (err) {
                console.error(`Couldn't assign level role: ${err.message}`);
            }
        }
    }

    // Deliver the level-up notification to the user or the channel if direct reply fails.
    try {
        await message.reply({ embeds: [levelUpEmbed] });
    } catch {
        // Can't reply, send in channel instead
        try {
            await message.channel.send({ embeds: [levelUpEmbed] });
        } catch (err) {
            console.error(`Couldn't send level up message: ${err.message}`);
        }
    }

    // Post an admin-friendly log message about the level-up if a log channel is configured.
    const logChannel = message.guild.channels.cache.get(levelUpLogChannelId);
    if (logChannel) {
        const logEmbed = new EmbedBuilder()
            .setColor(0xFFD700)
            .setTitle('🎉 Member Level Up Achievement')
            .setDescription(`${message.author.tag} has reached Level ${newLevel}!`)
            .addFields(
                { name: 'Member', value: `${message.author.toString()}\n\`ID: ${message.author.id}\``, inline: true },
                { name: 'Level Reached', value: `**${newLevel}**\n(Next: ${newLevel + 1})`, inline: true },
                { name: 'Total XP Accumulated', value: `**${userData.totalXP.toLocaleString()} XP**`, inline: false },
                { name: 'Total Messages', value: `**${userData.messages.toLocaleString()}** messages`, inline: true },
                { name: 'Achievement Date', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
            )
            .setThumbnail(message.author.displayAvatarURL({ size: 128 }))
            .setTimestamp()
            .setFooter({ text: 'Leveling System • Member Achievement Log' });

        logChannel.send({ embeds: [logEmbed] }).catch((err) => {
            console.error(`[Leveling] Couldn't log: ${err.message}`);
        });
    }
}

// Handles XP gain from messages
async function processXP(message) {
    if (message.author.bot) return;
    if (!message.guild) return;

    MySQLDatabaseManager.updateUserMessageStreak(
        message.author.id,
        message.author.username
    ).catch(() => { });

    MySQLDatabaseManager.trackUserChannelActivity(
        message.guild.id,
        message.author.id,
        message.channel.id,
        message.author.username
    ).catch(() => { });

    const now = Date.now();
    const cooldownKey = `${message.author.id}_${message.guild.id}`;

    // Clean up old cooldowns periodically
    if (now - lastCleanup > CLEANUP_INTERVAL) {
        cleanupCooldowns();
    }

    if (cooldowns.has(cooldownKey)) {
        const expirationTime = cooldowns.get(cooldownKey) + CONFIG.xpCooldownMs;
        if (now < expirationTime) return;
    }

    // Set new cooldown
    cooldowns.set(cooldownKey, now);

    // Get user data
    const userData = await getUserData(message.author.id);
    const oldLevel = userData.level;

    // Calculate and add XP
    const xpGain = calculateXPGain(message);
    userData.xp += xpGain;
    userData.totalXP += xpGain;
    const wasFirstMessage = userData.messages === 0;
    userData.messages += 1;
    userData.lastXPGain = now;

    // Check for level up
    let newLevel = oldLevel;
    while (userData.xp >= calculateRequiredXP(newLevel + 1)) {
        userData.xp -= calculateRequiredXP(newLevel + 1);
        newLevel++;
    }

    userData.level = newLevel;

    // Save to database
    await saveUserData(message.author.id, userData, message.author.username);

    if (wasFirstMessage) {
        await sendFirstMessageHighlight(message);
    }

    // Send level up notification if leveled up
    if (newLevel > oldLevel) {
        await sendLevelUpNotification(message, userData, newLevel);
    }
}

async function addBonusXP(message, bonusXp = 0) {
    if (!message || !message.guild || !message.author || message.author.bot) return null;

    const safeBonus = Math.max(1, Math.floor(Number(bonusXp) || 0));
    if (!safeBonus) return null;

    const userData = await getUserData(message.author.id);
    const oldLevel = userData.level;

    userData.xp += safeBonus;
    userData.totalXP += safeBonus;

    let newLevel = oldLevel;
    while (userData.xp >= calculateRequiredXP(newLevel + 1)) {
        userData.xp -= calculateRequiredXP(newLevel + 1);
        newLevel++;
    }

    userData.level = newLevel;

    await saveUserData(message.author.id, userData, message.author.username);

    if (newLevel > oldLevel) {
        await sendLevelUpNotification(message, userData, newLevel);
    }

    return { oldLevel, newLevel };
}

// Gets top users
async function getLeaderboard(limit = 10) {
    try {
        const allUsers = await MySQLDatabaseManager.getAllLevels();
        const sorted = allUsers
            .sort((a, b) => (b.total_xp || 0) - (a.total_xp || 0))
            .slice(0, limit)
            .map(user => ({
                id: user.user_id,
                level: user.level,
                xp: user.xp,
                totalXP: user.total_xp,
                messages: user.messages
            }));

        return sorted;
    } catch (error) {
        console.error('[Leveling] Error getting leaderboard:', error);
        return [];
    }
}

// Gets user's rank
async function getUserRank(userId) {
    try {
        const allUsers = await MySQLDatabaseManager.getAllLevels();
        const sorted = allUsers
            .sort((a, b) => (b.total_xp || 0) - (a.total_xp || 0));

        const rank = sorted.findIndex(u => u.user_id === userId) + 1;
        return rank || null;
    } catch (error) {
        console.error('[Leveling] Error getting user rank:', error);
        return null;
    }
}

// Admin: set user XP
async function setUserXP(userId, xp, username = null) {
    const userData = await getUserData(userId);
    userData.totalXP = xp;
    userData.xp = 0;
    userData.level = calculateLevel(xp);

    // Recalculate current level XP
    let totalRequired = 0;
    for (let i = 1; i < userData.level; i++) {
        totalRequired += calculateRequiredXP(i);
    }
    userData.xp = xp - totalRequired;

    await saveUserData(userId, userData, username);
    return userData;
}

// Admin: reset user
async function resetUser(userId) {
    try {
        await MySQLDatabaseManager.deleteUserLevel(userId);
        return true;
    } catch (error) {
        console.error('[Leveling] Error resetting user:', error);
        return false;
    }
}

async function handleMessageCreate(message) {
    try {
        await processXP(message);
    } catch (error) {
        console.error('[Leveling] Error processing XP:', error);
        // Don't throw - just log and continue to prevent bot crashes
    }
}

module.exports = {
    name: 'messageCreate',
    disabled: true,
    async execute(message) {
        return handleMessageCreate(message);
    },
    handleMessageCreate,
    getUserData,
    getLeaderboard,
    getUserRank,
    calculateRequiredXP,
    addBonusXP,
    setUserXP,
    resetUser,
    CONFIG,
};