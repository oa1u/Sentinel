const { EmbedBuilder } = require('discord.js');
const JSONDatabase = require('../Functions/Database');
const { levelUpLogChannelId } = require('../Config/constants/channel.json');
const { config: CONFIG, multipliers: MULTIPLIERS, levelRoles: LEVEL_ROLES } = require('../Config/constants/leveling.json');

const levelDB = new JSONDatabase('levels', { writeInterval: 2000 });

const cooldowns = new Map();
let lastCleanup = Date.now();
const CLEANUP_INTERVAL = 300000;

function cleanupCooldowns() {
    const now = Date.now();
    const cutoff = now - CONFIG.xpCooldownMs;
    
    let removed = 0;
    for (const [key, timestamp] of cooldowns.entries()) {
        if (timestamp < cutoff) {
            cooldowns.delete(key);
            removed++;
        }
    }
    
    if (removed > 0) {
        console.log(`[Leveling] Cleaned ${removed} old cooldowns`);
    }
    
    lastCleanup = now;
}

function calculateRequiredXP(level) {
    return Math.floor(CONFIG.baseLevelRequirement * Math.pow(CONFIG.levelRequirementMultiplier, level - 1));
}

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

function getUserData(userId) {
    return levelDB.ensure(userId, {
        xp: 0,
        level: 1,
        totalXP: 0,
        messages: 0,
        lastXPGain: 0,
    });
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

// Send level up message
async function sendLevelUpNotification(message, userData, newLevel) {
    const nextLevelXP = calculateRequiredXP(newLevel + 1);
    
    const levelUpEmbed = new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle('🎉 Level Up!')
        .setDescription(
            `**Congrats ${message.author}!**\n\n` +
            `You're now **Level ${newLevel}**!\n\n` +
            `**Stats:**\n` +
            `> 📊 Total XP: **${userData.totalXP.toLocaleString()} XP**\n` +
            `> 💬 Messages: **${userData.messages.toLocaleString()}**\n` +
            `> ⬆️ Next Level: **${nextLevelXP.toLocaleString()} XP**`
        )
        .addFields(
            { name: '📈 Current Level', value: `**${newLevel}**`, inline: true },
            { name: '🎯 Next Level', value: `**${newLevel + 1}**`, inline: true },
            { name: '⚡ XP Needed', value: `**${nextLevelXP.toLocaleString()}**`, inline: true }
        )
        .setThumbnail(message.author.displayAvatarURL({ size: 256 }))
        .setTimestamp()
        .setFooter({ text: `Keep going to reach level ${newLevel + 1}!` });

    // Check for role rewards
    const levelRoleKey = `level${newLevel}RoleId`;
    if (LEVEL_ROLES[levelRoleKey]) {
        const role = message.guild.roles.cache.get(LEVEL_ROLES[levelRoleKey]);
        if (role) {
            try {
                await message.member.roles.add(role);
                levelUpEmbed.addFields({
                    name: '🎁 Reward Unlocked',
                    value: `You earned the ${role} role!`,
                    inline: false
                });
            } catch (err) {
                console.error(`Couldn't assign level role: ${err.message}`);
            }
        }
    }

    // Send notification
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

    // Log to mod channel
    const logChannel = message.guild.channels.cache.get(levelUpLogChannelId);
    if (logChannel) {
        const logEmbed = new EmbedBuilder()
            .setColor(0xFFD700)
            .setTitle('🎉 Level Up')
            .setDescription(`**${message.author.tag}** reached level ${newLevel}!`)
            .addFields(
                { name: '👤 User', value: `${message.author}\n\`${message.author.id}\``, inline: true },
                { name: '⬆️ Level', value: `**${newLevel}**`, inline: true },
                { name: '📊 XP', value: `**${userData.totalXP.toLocaleString()}**`, inline: true }
            )
            .setThumbnail(message.author.displayAvatarURL({ size: 128 }))
            .setTimestamp();
        
        logChannel.send({ embeds: [logEmbed] }).catch((err) => {
            console.error(`[Leveling] Couldn't log: ${err.message}`);
        });
    }
}

// Handle XP gain from messages
async function processXP(message) {
    if (message.author.bot) return;
    if (!message.guild) return;
    
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
    const userData = getUserData(message.author.id);
    const oldLevel = userData.level;
    
    // Calculate and add XP
    const xpGain = calculateXPGain(message);
    userData.xp += xpGain;
    userData.totalXP += xpGain;
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
    levelDB.set(message.author.id, userData);
    
    // Send level up notification if leveled up
    if (newLevel > oldLevel) {
        await sendLevelUpNotification(message, userData, newLevel);
    }
}

// Get top users
function getLeaderboard(limit = 10) {
    const allUsers = levelDB.all();
    const sorted = Object.entries(allUsers)
        .map(([id, data]) => ({ id, ...data }))
        .sort((a, b) => b.totalXP - a.totalXP)
        .slice(0, limit);
    
    return sorted;
}

// Get user's rank
function getUserRank(userId) {
    const allUsers = levelDB.all();
    const sorted = Object.entries(allUsers)
        .map(([id, data]) => ({ id, ...data }))
        .sort((a, b) => b.totalXP - a.totalXP);
    
    const rank = sorted.findIndex(u => u.id === userId) + 1;
    return rank || null;
}

// Admin: set user XP
function setUserXP(userId, xp) {
    const userData = getUserData(userId);
    userData.totalXP = xp;
    userData.xp = 0;
    userData.level = calculateLevel(xp);
    
    // Recalculate current level XP
    let totalRequired = 0;
    for (let i = 1; i < userData.level; i++) {
        totalRequired += calculateRequiredXP(i);
    }
    userData.xp = xp - totalRequired;
    
    levelDB.set(userId, userData);
    return userData;
}

// Admin: reset user
function resetUser(userId) {
    levelDB.delete(userId);
    return true;
}

module.exports = {
    name: 'messageCreate',
    async execute(message) {
        await processXP(message);
    },
    // Export utility functions for commands
    getUserData,
    getLeaderboard,
    getUserRank,
    calculateRequiredXP,
    setUserXP,
    resetUser,
    CONFIG,
};