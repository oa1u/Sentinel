const { EmbedBuilder } = require('discord.js');
const AfkManager = require('../Functions/AfkManager');

const { MISC: miscConfig } = require('../Config/constants');
const configuredAfkCooldown = Number(miscConfig?.afk?.mentionNoticeCooldownMs);
const configuredDefaultMentionsMode = String(miscConfig?.afk?.defaultMentionsMode || '').toLowerCase();
const DEFAULT_MENTIONS_MODE = ['off', 'compact', 'rich'].includes(configuredDefaultMentionsMode)
    ? configuredDefaultMentionsMode
    : 'compact';
const configuredRichMentionsMaxUsers = Number(miscConfig?.afk?.richMentionsMaxUsers);
const RICH_MENTIONS_MAX_USERS = Number.isFinite(configuredRichMentionsMaxUsers)
    ? Math.min(Math.max(Math.floor(configuredRichMentionsMaxUsers), 1), 10)
    : 5;
const AFK_MENTION_COOLDOWN_MS = Number.isFinite(configuredAfkCooldown)
    ? Math.min(Math.max(configuredAfkCooldown, 5_000), 10 * 60 * 1000)
    : 45_000;
const afkNoticeCooldownMap = new Map();

function buildCooldownKey(guildId, mentionerId, targetId) {
    return `${String(guildId || '')}:${String(mentionerId || '')}:${String(targetId || '')}`;
}

function shouldSendAfkNotice(guildId, mentionerId, targetId) {
    const now = Date.now();
    const key = buildCooldownKey(guildId, mentionerId, targetId);
    const lastSentAt = Number(afkNoticeCooldownMap.get(key) || 0);

    if (lastSentAt && (now - lastSentAt) < AFK_MENTION_COOLDOWN_MS) {
        return false;
    }

    afkNoticeCooldownMap.set(key, now);

    if (afkNoticeCooldownMap.size > 5000) {
        for (const [storedKey, timestamp] of afkNoticeCooldownMap.entries()) {
            if (now - Number(timestamp || 0) > AFK_MENTION_COOLDOWN_MS * 4) {
                afkNoticeCooldownMap.delete(storedKey);
            }
        }
    }

    return true;
}

function buildRelativeTime(timestampMs) {
    const safe = Number(timestampMs) || Date.now();
    return `<t:${Math.floor(safe / 1000)}:R>`;
}

function buildAbsoluteTime(timestampMs) {
    const safe = Number(timestampMs) || Date.now();
    return `<t:${Math.floor(safe / 1000)}:f>`;
}

function normalizeMentionsMode(mode) {
    const candidate = String(mode || '').toLowerCase();
    return ['off', 'compact', 'rich'].includes(candidate) ? candidate : DEFAULT_MENTIONS_MODE;
}

module.exports = {
    name: 'messageCreate',
    disabled: true,
    disabled: true,
    async execute(message) {
        try {
            if (!message || !message.guild || !message.author || message.author.bot) return;

            const guildId = message.guild.id;
            const authorId = message.author.id;

            const existing = AfkManager.getAfk(guildId, authorId);
            if (existing) {
                AfkManager.clearAfk(guildId, authorId);

                const backEmbed = new EmbedBuilder()
                    .setColor(0x43B581)
                    .setTitle('👋 Welcome Back')
                    .setDescription(`**${message.author}**, your AFK status has been removed.`)
                    .setThumbnail(message.author.displayAvatarURL())
                    .setFooter({ text: 'AFK System • Status Cleared', iconURL: message.guild.iconURL() })
                    .setTimestamp();

                await message.channel.send({ embeds: [backEmbed] }).catch(() => null);
            }

            const mentionedUsers = message.mentions?.users
                ? [...message.mentions.users.values()].filter(user => !user.bot && user.id !== message.author.id)
                : [];

            if (!mentionedUsers.length) return;

            const afkRecords = AfkManager.getMentionedAfkRecords(guildId, mentionedUsers);
            if (!afkRecords.length) return;

            const mentionedUsersById = new Map(mentionedUsers.map((user) => [user.id, user]));
            const mentionedMembersById = message.mentions?.members
                ? new Map([...message.mentions.members.values()].map((member) => [member.id, member]))
                : new Map();
            const getAfkDisplayLabel = (record) => {
                const member = mentionedMembersById.get(record.userId);
                const user = mentionedUsersById.get(record.userId);

                const displayName = String(member?.displayName || '').trim();
                const username = String(user?.username || '').trim();

                if (displayName && username) {
                    if (displayName.toLowerCase() === username.toLowerCase()) {
                        return `@${displayName}`;
                    }
                    return `${displayName} (@${username})`;
                }

                if (displayName) return `@${displayName}`;
                if (username) return `@${username}`;
                return `User ${record.userId}`;
            };

            const recordsToNotify = afkRecords.filter((record) => {
                const mentionsMode = normalizeMentionsMode(record.mentionsMode);
                if (mentionsMode === 'off') return false;
                return shouldSendAfkNotice(guildId, authorId, record.userId);
            }).map((record) => ({
                ...record,
                mentionsMode: normalizeMentionsMode(record.mentionsMode)
            }));

            if (!recordsToNotify.length) return;

            const compactRecords = recordsToNotify.filter(record => record.mentionsMode === 'compact').slice(0, 10);
            const richRecords = recordsToNotify.filter(record => record.mentionsMode === 'rich').slice(0, RICH_MENTIONS_MAX_USERS);

            if (compactRecords.length) {
                const compactLines = compactRecords.map((record) => {
                    return `• ${getAfkDisplayLabel(record)} is AFK (${buildRelativeTime(record.since)})\n  Reason: ${record.reason}`;
                });

                const compactMoreCount = Math.max(recordsToNotify.filter(record => record.mentionsMode === 'compact').length - compactRecords.length, 0);
                const compactEmbed = new EmbedBuilder()
                    .setColor(0xFAA61A)
                    .setTitle('💤 AFK Notice')
                    .setDescription(compactLines.join('\n') + (compactMoreCount ? `\n\n...and **${compactMoreCount}** more AFK user(s).` : ''))
                    .setFooter({ text: 'AFK System • Compact Mode', iconURL: message.guild.iconURL() })
                    .setTimestamp();

                await message.channel.send({ embeds: [compactEmbed] }).catch(() => null);
            }

            if (richRecords.length) {
                const richEmbed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('💤 AFK Details')
                    .setDescription('Some mentioned users are currently AFK.')
                    .setFooter({ text: 'AFK System • Rich Mode', iconURL: message.guild.iconURL() })
                    .setTimestamp();

                for (const record of richRecords) {
                    richEmbed.addFields({
                        name: `**${getAfkDisplayLabel(record)}**`,
                        value: `**Reason:** ${record.reason}\n**Since:** ${buildRelativeTime(record.since)} (${buildAbsoluteTime(record.since)})`,
                        inline: false
                    });
                }

                const richMoreCount = Math.max(recordsToNotify.filter(record => record.mentionsMode === 'rich').length - richRecords.length, 0);
                if (richMoreCount > 0) {
                    richEmbed.setFooter({ text: `+${richMoreCount} more AFK user(s) omitted.`, iconURL: message.guild.iconURL() });
                }

                await message.channel.send({ embeds: [richEmbed] }).catch(() => null);
            }

            if (!compactRecords.length && !richRecords.length) {
                const fallbackLines = recordsToNotify.slice(0, 10).map((record) => {
                    return `• ${getAfkDisplayLabel(record)} is AFK (${buildRelativeTime(record.since)})\n  Reason: ${record.reason}`;
                });

                const fallbackMoreCount = Math.max(recordsToNotify.length - 10, 0);
                const fallbackEmbed = new EmbedBuilder()
                    .setColor(0xFAA61A)
                    .setTitle('💤 AFK Notice')
                    .setDescription(fallbackLines.join('\n') + (fallbackMoreCount ? `\n\n...and **${fallbackMoreCount}** more AFK user(s).` : ''))
                    .setFooter({ text: 'AFK System • Fallback Mode', iconURL: message.guild.iconURL() })
                    .setTimestamp();

                await message.channel.send({ embeds: [fallbackEmbed] }).catch(() => null);
            }
        } catch (error) {
            console.error('[AFK] Failed to process messageCreate:', error?.message || error);
        }
    }
};