const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');
const { sendErrorReply } = require('../../Functions/EmbedBuilders');
const { getUserData, getUserRank, calculateRequiredXP } = require('../../Events/Leveling');

function formatLastXpGain(lastXPGain) {
    const timestampMs = Number(lastXPGain || 0);
    if (!timestampMs || timestampMs <= 0) return 'No tracked XP activity yet';
    const unix = Math.floor(timestampMs / 1000);
    return `<t:${unix}:R> (<t:${unix}:f>)`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('activity')
        .setDescription('Show activity stats for a user')
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('User to view activity for')
                .setRequired(false)
        )
        .addIntegerOption(option =>
            option
                .setName('days')
                .setDescription('Command activity window in days (default: 30, max: 365)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(365)
        )
        .addIntegerOption(option =>
            option
                .setName('channels')
                .setDescription('How many top channels to show (default: 3, max: 5)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(5)
        ),
    category: 'utility',
    async execute(interaction) {
        try {
            if (!interaction.guild || !interaction.member) {
                return interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
            }

            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferReply().catch(() => { });
            }

            const targetUser = interaction.options.getUser('user') || interaction.user;
            const days = interaction.options.getInteger('days') || 30;
            const channelLimit = interaction.options.getInteger('channels') || 3;

            const [userData, rank, topChannels, trackedMessages, commandSummary, reputation, reputationRank] = await Promise.all([
                getUserData(targetUser.id),
                getUserRank(targetUser.id),
                DatabaseManager.getTopUserChannels(interaction.guildId, targetUser.id, channelLimit),
                DatabaseManager.getUserChannelMessageTotal(interaction.guildId, targetUser.id),
                DatabaseManager.getUserCommandUsageSummary(interaction.guildId, targetUser.id, days, 3),
                DatabaseManager.getReputation(interaction.guildId, targetUser.id),
                DatabaseManager.getReputationRank(interaction.guildId, targetUser.id)
            ]);

            const level = Number(userData?.level || 1);
            const currentXp = Number(userData?.xp || 0);
            const totalXp = Number(userData?.totalXP || 0);
            const nextLevelRequirement = calculateRequiredXP(level + 1);
            const xpProgressPercent = Math.min(100, Math.max(0, Math.round((currentXp / Math.max(1, nextLevelRequirement)) * 100)));
            const xpTrackedMessages = Number(userData?.messages || 0);
            const totalMessages = trackedMessages > 0 ? trackedMessages : xpTrackedMessages;

            const topChannelsText = topChannels.length
                ? topChannels
                    .map((row, index) => `**${index + 1}.** <#${row.channelId}> — **${row.messageCount.toLocaleString()}** msg`)
                    .join('\n')
                : 'No channel activity tracked yet.';

            const topCommandsText = Array.isArray(commandSummary?.topCommands) && commandSummary.topCommands.length
                ? commandSummary.topCommands
                    .map((row, index) => `**${index + 1}.** \`/${row.command}\` — **${row.uses.toLocaleString()}** use${row.uses === 1 ? '' : 's'}`)
                    .join('\n')
                : 'No command usage tracked for this window.';

            const repPoints = Number(reputation || 0);
            const repRankText = reputationRank?.rank ? `#${reputationRank.rank}` : 'Unranked';

            const activityScore = Math.round(
                (Math.log10(Math.max(1, totalMessages)) * 40)
                + (Math.log10(Math.max(1, totalXp + 1)) * 30)
                + (Math.log10(Math.max(1, repPoints + 1)) * 30)
            );

            const embed = new EmbedBuilder()
                .setColor(0x1e1f22)
                .setAuthor({
                    name: `${targetUser.tag} (${targetUser.id})`,
                    iconURL: targetUser.displayAvatarURL({ size: 128 })
                })
                .setTitle('📊 User Activity')
                .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
                .addFields(
                    { name: 'Activity Score', value: `**${activityScore}**`, inline: true },
                    { name: 'Messages', value: `**${totalMessages.toLocaleString()}**`, inline: true },
                    { name: 'Level', value: `**${level}**`, inline: true },
                    { name: 'Server Rank', value: rank ? `**#${rank}**` : 'Unranked', inline: true },
                    { name: 'Total XP', value: `**${totalXp.toLocaleString()} XP**`, inline: true },
                    { name: 'Current Level XP', value: `**${currentXp.toLocaleString()} / ${nextLevelRequirement.toLocaleString()}** (${xpProgressPercent}%)`, inline: true },
                    { name: 'Reputation', value: `**${repPoints.toLocaleString()}** (Rank: **${repRankText}**)`, inline: true },
                    { name: 'Last XP Activity', value: formatLastXpGain(userData?.lastXPGain), inline: true },
                    { name: `Most Used Channels (Top ${channelLimit})`, value: topChannelsText, inline: false },
                    {
                        name: `Command Usage (${days}d)`,
                        value: [
                            `Total: **${Number(commandSummary?.total || 0).toLocaleString()}**`,
                            `Success: **${Number(commandSummary?.successRate || 0)}%**`,
                            `Failed: **${Number(commandSummary?.failed || 0).toLocaleString()}**`
                        ].join(' • '),
                        inline: false
                    },
                    { name: 'Top Commands', value: topCommandsText, inline: false }
                )
                .setFooter({
                    text: `Requested by ${interaction.user.tag}`,
                    iconURL: interaction.user.displayAvatarURL({ size: 128 })
                })
                .setTimestamp();

            if (trackedMessages <= 0 && xpTrackedMessages > 0) {
                embed.addFields({
                    name: 'Tracking Note',
                    value: 'Per-channel tracking was added recently. Channel usage stats will become more complete as new messages are sent.',
                    inline: false
                });
            }

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply({ embeds: [embed] });
            }

            return interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('[activity] Error:', error.message);
            return sendErrorReply(interaction, 'Activity Error', 'Could not load activity stats right now. Please try again.');
        }
    }
};
