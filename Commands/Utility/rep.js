const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');
const { MISC: miscConfig } = require('../../Config/constants');
const { sendErrorReply, sendSuccessReply, sendWarningReply, sendInfoReply } = require('../../Functions/EmbedBuilders');

const repConfig = miscConfig?.reputation || {};
const REP_DAILY_LIMIT = Math.max(1, Math.min(100, Number(repConfig.dailyLimit) || 3));
const REP_PAIR_COOLDOWN_MS = Math.max(60_000, Math.min(7 * 24 * 60 * 60 * 1000, Number(repConfig.pairCooldownMs) || 12 * 60 * 60 * 1000));
const REP_LEADERBOARD_DEFAULT_LIMIT = Math.max(3, Math.min(20, Number(repConfig.leaderboardDefaultLimit) || 10));
const REP_REASON_MAX_LENGTH = Math.max(20, Math.min(300, Number(repConfig.reasonMaxLength) || 160));
const REP_ROLE_REWARDS = Array.isArray(repConfig.roleRewards) ? repConfig.roleRewards : [];

function formatDuration(ms) {
    const safeMs = Math.max(0, Number(ms) || 0);
    const totalSeconds = Math.ceil(safeMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || !parts.length) parts.push(`${seconds}s`);
    return parts.join(' ');
}

function formatNumber(value) {
    return Number(value || 0).toLocaleString();
}

function formatRelativeDate(value) {
    if (!value) return 'Never';

    const date = value instanceof Date ? value : new Date(value);
    const timestamp = Math.floor(date.getTime() / 1000);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Never';
    return `<t:${timestamp}:R>`;
}

function getRepTier(points) {
    if (points >= 100) return { name: 'Legend', icon: '👑', nextAt: null };
    if (points >= 50) return { name: 'Elite', icon: '💠', nextAt: 100 };
    if (points >= 25) return { name: 'Trusted', icon: '🌟', nextAt: 50 };
    if (points >= 10) return { name: 'Recognized', icon: '✨', nextAt: 25 };
    if (points >= 1) return { name: 'Supportive', icon: '🤝', nextAt: 10 };
    return { name: 'Newcomer', icon: '🆕', nextAt: 1 };
}

function getRepBadgeList(points) {
    const badges = [];
    if (points >= 100) badges.push('👑 Community Legend');
    else if (points >= 50) badges.push('💠 Elite Helper');
    else if (points >= 25) badges.push('🌟 Trusted Member');
    else if (points >= 10) badges.push('✨ Recognized Helper');
    else if (points >= 1) badges.push('🤝 First Reputation');
    return badges;
}

function getLeaderboardPrefix(index) {
    if (index === 0) return '🥇';
    if (index === 1) return '🥈';
    if (index === 2) return '🥉';
    return `#${index + 1}`;
}

function normalizeTimeframe(value) {
    return ['all', 'week', 'month'].includes(value) ? value : 'all';
}

function formatTimeframeLabel(value) {
    if (value === 'week') return 'Last 7 Days';
    if (value === 'month') return 'Last 30 Days';
    return 'All Time';
}

async function applyReputationRoleRewards(member, totalRep) {
    if (!member || !member.manageable) {
        return [];
    }

    const eligibleRewards = REP_ROLE_REWARDS
        .filter((reward) => reward && reward.roleId && Number(reward.minPoints) > 0 && totalRep >= Number(reward.minPoints))
        .sort((left, right) => Number(left.minPoints) - Number(right.minPoints));

    const grantedRewards = [];
    for (const reward of eligibleRewards) {
        if (member.roles.cache.has(reward.roleId)) {
            grantedRewards.push(reward);
            continue;
        }

        const role = member.guild.roles.cache.get(reward.roleId);
        if (!role) {
            continue;
        }

        const updatedMember = await member.roles.add(role, `Reputation reward unlocked at ${totalRep} reputation`).catch(() => null);
        if (updatedMember) {
            grantedRewards.push(reward);
        }
    }

    return grantedRewards;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('rep')
        .setDescription('Manage reputation points')
        .addSubcommand(subcommand =>
            subcommand
                .setName('give')
                .setDescription('Give +1 reputation to a user')
                .addUserOption(option =>
                    option
                        .setName('user')
                        .setDescription('User to give reputation to')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('reason')
                        .setDescription('Optional reason for this reputation grant')
                        .setRequired(false)
                        .setMaxLength(REP_REASON_MAX_LENGTH)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('view')
                .setDescription('View your or another user\'s reputation')
                .addUserOption(option =>
                    option
                        .setName('user')
                        .setDescription('User to check (defaults to you)')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('leaderboard')
                .setDescription('Show top reputation users in this server')
                .addIntegerOption(option =>
                    option
                        .setName('limit')
                        .setDescription('How many users to show (1-20)')
                        .setRequired(false)
                        .setMinValue(1)
                        .setMaxValue(20)
                )
                .addStringOption(option =>
                    option
                        .setName('timeframe')
                        .setDescription('Choose the leaderboard time range')
                        .setRequired(false)
                        .addChoices(
                            { name: 'All Time', value: 'all' },
                            { name: 'Last 7 Days', value: 'week' },
                            { name: 'Last 30 Days', value: 'month' }
                        )
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('stats')
                .setDescription('View detailed reputation statistics for this server')
        ),
    category: 'utility',
    async execute(interaction) {
        if (!interaction.guild || !interaction.member) {
            return interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'view') {
            const targetUser = interaction.options.getUser('user') || interaction.user;
            const profile = await DatabaseManager.getReputationProfile(interaction.guildId, targetUser.id);
            const points = Number(profile?.points || 0);
            const tier = getRepTier(points);
            const repBadges = getRepBadgeList(points);
            const recentReasonText = Array.isArray(profile?.recentReasons) && profile.recentReasons.length
                ? profile.recentReasons.map((item) => {
                    const reasonText = item.reason || 'No comment provided';
                    return `• <@${item.giverId}>: ${reasonText} (${formatRelativeDate(item.createdAt)})`;
                }).join('\n')
                : 'No recent reputation comments yet.';

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle(`🤝 Reputation Profile: ${targetUser.username}`)
                .setDescription(`${tier.icon} **${tier.name}** member reputation summary.`)
                .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
                .addFields(
                    {
                        name: 'Overview',
                        value: [
                            `Points: **${formatNumber(points)}**`,
                            `Rank: **${profile?.rank ? `#${formatNumber(profile.rank)}` : 'Unranked'}**`,
                            `Tier: **${tier.name}**`
                        ].join('\n'),
                        inline: true
                    },
                    {
                        name: 'Activity',
                        value: [
                            `Received total: **${formatNumber(profile?.receivedCount)}**`,
                            `Given total: **${formatNumber(profile?.givenCount)}**`,
                            `Received today: **${formatNumber(profile?.receivedToday)}**`,
                            `Given today: **${formatNumber(profile?.givenToday)}**`
                        ].join('\n'),
                        inline: true
                    },
                    {
                        name: 'Recent',
                        value: [
                            `Last received: **${formatRelativeDate(profile?.lastReceivedAt)}**`,
                            `Last given: **${formatRelativeDate(profile?.lastGivenAt)}**`,
                            `Next tier: **${tier.nextAt ? `${formatNumber(tier.nextAt - points)} more point(s)` : 'Max tier reached'}**`
                        ].join('\n'),
                        inline: false
                    },
                    {
                        name: 'Badges',
                        value: repBadges.length ? repBadges.join(' • ') : 'No reputation badges unlocked yet.',
                        inline: false
                    },
                    {
                        name: 'Recent Comments',
                        value: recentReasonText,
                        inline: false
                    }
                )
                .setFooter({ text: `Requested by ${interaction.user.tag}` })
                .setTimestamp();

            if (interaction.deferred || interaction.replied) {
                return interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
            }
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        if (subcommand === 'leaderboard') {
            const limit = interaction.options.getInteger('limit') || REP_LEADERBOARD_DEFAULT_LIMIT;
            const timeframe = normalizeTimeframe(interaction.options.getString('timeframe') || 'all');
            const topRows = await DatabaseManager.getReputationLeaderboard(interaction.guildId, limit, timeframe);
            if (!topRows.length) {
                return sendInfoReply(interaction, 'No Reputation Yet', 'No reputation points have been awarded in this timeframe yet.');
            }

            const selfRank = await DatabaseManager.getReputationRank(interaction.guildId, interaction.user.id, timeframe);

            const lines = topRows.map((row, index) => {
                const prefix = getLeaderboardPrefix(index);
                const tier = getRepTier(row.points);
                return `**${prefix}** <@${row.user_id}> - **${formatNumber(row.points)}** point${row.points === 1 ? '' : 's'} ${tier.icon}`;
            });

            const embed = new EmbedBuilder()
                .setColor(0x1e1f22)
                .setTitle(`🏆 Reputation Leaderboard • ${formatTimeframeLabel(timeframe)}`)
                .setDescription(lines.join('\n'))
                .addFields({
                    name: 'Your Position',
                    value: selfRank?.rank
                        ? `You are currently **#${formatNumber(selfRank.rank)}** with **${formatNumber(selfRank.points)}** point${selfRank.points === 1 ? '' : 's'}.`
                        : 'You are currently unranked in this timeframe.',
                    inline: false
                })
                .setFooter({ text: `Requested by ${interaction.user.tag}` })
                .setTimestamp();

            if (interaction.deferred || interaction.replied) {
                return interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
            }
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        if (subcommand === 'stats') {
            const stats = await DatabaseManager.getReputationServerStats(interaction.guildId);
            if (!stats || stats.totalGrants <= 0) {
                return sendInfoReply(interaction, 'No Reputation Stats Yet', 'There is not enough reputation activity in this server yet.');
            }

            const embed = new EmbedBuilder()
                .setColor(0x43B581)
                .setTitle('📊 Reputation Server Stats')
                .setDescription('A broader view of how reputation is being used in this server.')
                .addFields(
                    {
                        name: 'Overview',
                        value: [
                            `Tracked users: **${formatNumber(stats.trackedUsers)}**`,
                            `Total points: **${formatNumber(stats.totalPoints)}**`,
                            `Total grants: **${formatNumber(stats.totalGrants)}**`
                        ].join('\n'),
                        inline: true
                    },
                    {
                        name: 'Today',
                        value: [
                            `Grants today: **${formatNumber(stats.grantsToday)}**`,
                            `Daily limit per user: **${formatNumber(REP_DAILY_LIMIT)}**`,
                            `Pair cooldown: **${formatDuration(REP_PAIR_COOLDOWN_MS)}**`
                        ].join('\n'),
                        inline: true
                    },
                    {
                        name: 'Leaders',
                        value: [
                            `Top receiver: ${stats.topReceiver ? `<@${stats.topReceiver.userId}> (${formatNumber(stats.topReceiver.total)})` : 'N/A'}`,
                            `Top giver: ${stats.topGiver ? `<@${stats.topGiver.userId}> (${formatNumber(stats.topGiver.total)})` : 'N/A'}`,
                            `Configured rewards: **${formatNumber(REP_ROLE_REWARDS.filter((reward) => reward?.roleId).length)}**`
                        ].join('\n'),
                        inline: false
                    }
                )
                .setFooter({ text: `Requested by ${interaction.user.tag}` })
                .setTimestamp();

            if (interaction.deferred || interaction.replied) {
                return interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
            }
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        const targetUser = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason');

        if (targetUser.id === interaction.user.id) {
            return sendWarningReply(interaction, 'Invalid Target', 'You cannot give reputation to yourself.');
        }

        if (targetUser.bot) {
            return sendWarningReply(interaction, 'Invalid Target', 'You cannot give reputation to bots.');
        }

        const result = await DatabaseManager.giveReputationPoint(interaction.guildId, interaction.user.id, targetUser.id, {
            cooldownMs: REP_PAIR_COOLDOWN_MS,
            dailyLimit: REP_DAILY_LIMIT,
            reason
        });

        if (!result?.ok && result?.code === 'cooldown') {
            return sendWarningReply(
                interaction,
                'Reputation Cooldown',
                `You can give reputation to ${targetUser} again in **${formatDuration(result.retryAfterMs)}**.`
            );
        }

        if (!result?.ok && result?.code === 'daily_limit') {
            return sendWarningReply(
                interaction,
                'Daily Reputation Limit Reached',
                `You have reached your daily limit (**${result.dailyLimit}**) for today.`
            );
        }

        if (!result?.ok) {
            return sendErrorReply(interaction, 'Reputation Failed', 'Could not update reputation right now. Please try again.');
        }

        const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        const grantedRewards = await applyReputationRoleRewards(member, result.totalRep);
        const rewardText = grantedRewards.length
            ? `\nUnlocked roles: ${grantedRewards.map((reward) => `\`${reward.tier}\``).join(', ')}`
            : '';
        const reasonText = result.reason ? `\nReason: **${result.reason}**` : '';

        return sendSuccessReply(
            interaction,
            'Reputation Added',
            `${interaction.user} gave +1 reputation to ${targetUser}.\nThey now have **${formatNumber(result.totalRep)}** reputation point${result.totalRep === 1 ? '' : 's'}.\nToday: **${formatNumber(result.grantsToday)}/${formatNumber(result.dailyLimit)}** used.${reasonText}${rewardText}`,
            { ephemeral: false }
        );
    }
};