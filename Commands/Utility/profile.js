const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const MySQLDatabaseManager = require('../../Functions/MySQLDatabaseManager');
const { getUserData, getUserRank, calculateRequiredXP } = require('../../Events/Leveling');

const DISCORD_BADGES = {
    Staff: '👮 Staff',
    Partner: '🤝 Partner',
    Hypesquad: '🎉 HypeSquad',
    HypeSquadOnlineHouse1: '🟣 Bravery',
    HypeSquadOnlineHouse2: '🔴 Brilliance',
    HypeSquadOnlineHouse3: '🟢 Balance',
    BugHunterLevel1: '🐛 Bug Hunter',
    BugHunterLevel2: '🐞 Bug Hunter Lv2',
    PremiumEarlySupporter: '⭐ Early Supporter',
    VerifiedDeveloper: '✅ Verified Developer',
    CertifiedModerator: '🛡️ Certified Moderator',
    ActiveDeveloper: '⚡ Active Developer'
};

const STATUS_META = {
    online: '🟢 Online',
    idle: '🌙 Idle',
    dnd: '⛔ Do Not Disturb',
    offline: '⚫ Offline'
};

const DEVICE_META = {
    desktop: '💻 Desktop',
    mobile: '📱 Mobile',
    web: '🌐 Browser'
};

const ACTIVITY_TYPE_META = {
    0: 'Playing',
    1: 'Streaming',
    2: 'Listening to',
    3: 'Watching',
    4: 'Custom Status',
    5: 'Competing in'
};

function formatNumber(value) {
    return Math.max(0, Number(value) || 0).toLocaleString('en-US');
}

function formatDiscordDate(timestamp, style) {
    if (!timestamp) {
        return 'Unknown';
    }

    return `<t:${Math.floor(timestamp / 1000)}:${style}>`;
}

function formatDateBlock(timestamp) {
    if (!timestamp) {
        return 'Unknown';
    }

    return `${formatDiscordDate(timestamp, 'D')}\n${formatDiscordDate(timestamp, 'R')}`;
}

function truncateText(value, maxLength = 120) {
    const text = String(value || '').trim();
    if (!text) {
        return 'Unknown';
    }

    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, maxLength - 3)}...`;
}

function buildProgressBar(progress, length = 14) {
    const safeProgress = Math.max(0, Math.min(100, Number(progress) || 0));
    const filled = Math.round((safeProgress / 100) * length);
    const empty = Math.max(0, length - filled);
    return `${'▰'.repeat(filled)}${'▱'.repeat(empty)}`;
}

function getStreakStatus(lastDay) {
    if (!lastDay) {
        return 'No activity yet';
    }

    const now = new Date();
    const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const yesterdayStart = todayStart - 86400000;

    if (lastDay === todayStart) {
        return 'Active today';
    }

    if (lastDay === yesterdayStart) {
        return 'On track today';
    }

    return 'Streak broken';
}

function getDiscordBadgeList(userFlags) {
    return userFlags
        .map((flag) => DISCORD_BADGES[flag])
        .filter(Boolean);
}

function getServerBadgeList({ level, reputation, streak, bestStreak, joinedTimestamp, messages }) {
    const badges = [];
    const joinedDays = joinedTimestamp
        ? Math.floor((Date.now() - joinedTimestamp) / 86400000)
        : 0;

    if (level >= 30) {
        badges.push('🏆 Level Veteran');
    } else if (level >= 15) {
        badges.push('🥈 Rising Regular');
    } else if (level >= 5) {
        badges.push('🥉 First Milestone');
    }

    if (reputation >= 100) {
        badges.push('👑 Community Legend');
    } else if (reputation >= 50) {
        badges.push('💠 Elite Helper');
    } else if (reputation >= 25) {
        badges.push('🤝 Trusted Member');
    } else if (reputation >= 10) {
        badges.push('💬 Helpful Member');
    } else if (reputation >= 1) {
        badges.push('✨ First Reputation');
    }

    if (streak >= 30) {
        badges.push('🔥 Unbreakable Streak');
    } else if (streak >= 7 || bestStreak >= 7) {
        badges.push('📅 Consistent Chatter');
    }

    if (messages >= 1000) {
        badges.push('🗨️ Active Contributor');
    }

    if (joinedDays >= 365) {
        badges.push('🕰️ Veteran Member');
    } else if (joinedDays >= 180) {
        badges.push('📌 Established Member');
    }

    return badges;
}

function formatBadgeSection(discordBadges, serverBadges) {
    const discordLine = discordBadges.length
        ? discordBadges.join(' • ')
        : 'None visible';
    const serverLine = serverBadges.length
        ? serverBadges.join(' • ')
        : 'No milestone badges earned yet';

    return `Discord: ${discordLine}\nServer: ${serverLine}`;
}

function getPresenceStatus(member) {
    const status = member?.presence?.status || 'offline';
    return STATUS_META[status] || '⚫ Unknown';
}

function getMainDevice(member) {
    const clientStatus = member?.presence?.clientStatus;
    if (!clientStatus || typeof clientStatus !== 'object') {
        return 'Unknown';
    }

    const deviceKey = Object.keys(clientStatus)[0];
    return DEVICE_META[deviceKey] || 'Unknown';
}

function getCurrentActivity(member) {
    const activities = Array.isArray(member?.presence?.activities)
        ? member.presence.activities
        : [];
    const primaryActivity = activities.find((activity) => activity && activity.name);

    if (!primaryActivity) {
        return 'No visible activity';
    }

    if (primaryActivity.type === 4) {
        return primaryActivity.state
            ? `Custom Status: ${primaryActivity.state}`
            : 'Custom Status';
    }

    const label = ACTIVITY_TYPE_META[primaryActivity.type] || 'Doing';
    return `${label} ${primaryActivity.name}`;
}

function getBoosterText(member) {
    if (!member?.premiumSinceTimestamp) {
        return 'No';
    }

    return `Yes\nSince ${formatDiscordDate(member.premiumSinceTimestamp, 'D')}`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('profile')
        .setDescription('View a cleaner member profile with progress, reputation, streak, and badges.')
        .addUserOption((option) =>
            option
                .setName('user')
                .setDescription('Member to view')
                .setRequired(false)
        ),
    category: 'utility',
    async execute(interaction) {
        async function sendInteractionResponse(payload) {
            if (interaction.deferred) {
                const { flags, ...safePayload } = payload;
                return interaction.editReply(safePayload);
            }

            if (interaction.replied) {
                return interaction.followUp(payload);
            }

            return interaction.reply(payload);
        }

        if (!interaction.guild || !interaction.guildId) {
            return sendInteractionResponse({
                content: 'This command can only be used in a server.',
                flags: MessageFlags.Ephemeral
            });
        }

        const targetUser = interaction.options.getUser('user') || interaction.user;

        const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (!member) {
            return sendInteractionResponse({
                content: 'That user is not currently a member of this server.',
                flags: MessageFlags.Ephemeral
            });
        }

        const fetchedUser = await targetUser.fetch().catch(() => targetUser);
        const isBotProfile = Boolean(fetchedUser.bot);

        let levelData = null;
        let levelRank = null;
        let userInfo = null;
        let reputation = 0;
        let reputationRank = null;

        if (!isBotProfile) {
            await MySQLDatabaseManager.ensureMessageStreakColumns();

            [levelData, levelRank, userInfo, reputation, reputationRank] = await Promise.all([
                getUserData(targetUser.id),
                getUserRank(targetUser.id),
                MySQLDatabaseManager.getUserInfo(targetUser.id),
                MySQLDatabaseManager.getReputation(interaction.guildId, targetUser.id),
                MySQLDatabaseManager.getReputationRank(interaction.guildId, targetUser.id)
            ]);
        }

        const currentXP = Math.max(0, Number(levelData?.xp) || 0);
        const currentLevel = Math.max(1, Number(levelData?.level) || 1);
        const requiredXP = Math.max(1, calculateRequiredXP(currentLevel + 1));
        const progress = Math.floor((currentXP / requiredXP) * 100);
        const xpNeeded = Math.max(0, requiredXP - currentXP);

        const streak = Math.max(0, Number(userInfo?.message_streak) || 0);
        const bestStreak = Math.max(0, Number(userInfo?.message_streak_best) || 0);
        const lastStreakDay = userInfo?.message_streak_last_day
            ? Number(userInfo.message_streak_last_day)
            : null;

        const discordBadges = getDiscordBadgeList(fetchedUser.flags?.toArray?.() || []);
        const serverBadges = isBotProfile
            ? []
            : getServerBadgeList({
                level: currentLevel,
                reputation,
                streak,
                bestStreak,
                joinedTimestamp: member.joinedTimestamp,
                messages: Number(levelData?.messages) || 0
            });

        const levelValue = isBotProfile
            ? 'Bots are not included in leveling, streak, or reputation tracking.'
            : [
                `${buildProgressBar(progress)} **${Math.max(0, Math.min(100, progress))}%**`,
                `Level: **${formatNumber(currentLevel)}** • Rank: **${levelRank ? `#${formatNumber(levelRank)}` : 'Unranked'}**`,
                `XP: **${formatNumber(currentXP)} / ${formatNumber(requiredXP)}**`,
                `Next level in: **${formatNumber(xpNeeded)} XP**`
            ].join('\n');

        const streakValue = isBotProfile
            ? 'Not tracked for bots'
            : [
                `Current: **${formatNumber(streak)}** day${streak === 1 ? '' : 's'}`,
                `Best: **${formatNumber(bestStreak)}** day${bestStreak === 1 ? '' : 's'}`,
                `Status: ${getStreakStatus(lastStreakDay)}`
            ].join('\n');

        const reputationValue = isBotProfile
            ? 'Not tracked for bots'
            : [
                `Points: **${formatNumber(reputation)}**`,
                `Rank: **${reputationRank?.rank ? `#${formatNumber(reputationRank.rank)}` : 'Unranked'}**`
            ].join('\n');

        const activityValue = isBotProfile
            ? 'Message and XP totals are not tracked for bots'
            : [
                `Messages: **${formatNumber(levelData?.messages)}**`,
                `Total XP: **${formatNumber(levelData?.totalXP)}**`
            ].join('\n');

        const presenceValue = [
            `Status: ${getPresenceStatus(member)}`,
            `Main Device: ${getMainDevice(member)}`,
            `Activity: ${truncateText(getCurrentActivity(member), 100)}`
        ].join('\n');

        const topRole = member.roles.highest && member.roles.highest.id !== interaction.guild.id
            ? member.roles.highest.toString()
            : 'No highlighted role';

        const serverMetaValue = [
            `Booster: ${getBoosterText(member)}`,
            `Top Role: ${topRole}`
        ].join('\n');

        const summaryParts = [
            member.toString(),
            fetchedUser.bot ? 'Bot' : 'Member',
            member.nickname ? `Nick: ${member.nickname}` : null,
            `ID: ${fetchedUser.id}`
        ].filter(Boolean);

        const summaryLine = summaryParts.join(' • ');
        const statusLine = [
            getPresenceStatus(member),
            getMainDevice(member),
            member.premiumSinceTimestamp ? '💎 Booster' : 'No Boost'
        ].join(' • ');

        const embed = new EmbedBuilder()
            .setColor(member.displayHexColor !== '#000000' ? parseInt(member.displayHexColor.replace('#', ''), 16) : 0x5865F2)
            .setAuthor({
                name: 'Member Profile',
                iconURL: fetchedUser.displayAvatarURL()
            })
            .setTitle(member.displayName === fetchedUser.username ? fetchedUser.username : `${member.displayName} (@${fetchedUser.username})`)
            .setDescription(`${summaryLine}\n${statusLine}`)
            .setThumbnail(fetchedUser.displayAvatarURL({ size: 256 }))
            .addFields(
                { name: '🟢 Live Status', value: presenceValue, inline: true },
                { name: '💎 Server Profile', value: serverMetaValue, inline: true },
                { name: '📅 Dates', value: `Joined: ${formatDateBlock(member.joinedTimestamp)}\nCreated: ${formatDateBlock(fetchedUser.createdTimestamp)}`, inline: true },
                { name: '📈 Level Progress', value: levelValue, inline: false },
                { name: '🔥 Streak', value: streakValue, inline: true },
                { name: '🤝 Reputation', value: reputationValue, inline: true },
                { name: '💬 Activity', value: activityValue, inline: true },
                { name: '🏅 Earned Badges', value: formatBadgeSection(discordBadges, serverBadges), inline: false }
            )
            .setFooter({ text: `Requested by ${interaction.user.tag}` })
            .setTimestamp();

        const bannerUrl = fetchedUser.bannerURL({ size: 1024 });
        if (bannerUrl) {
            embed.setImage(bannerUrl);
        }

        return sendInteractionResponse({ embeds: [embed] });
    }
};