const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');
const { MISC: miscConfig } = require('../../Config/constants');
const { sendErrorReply, sendSuccessReply, sendWarningReply, sendInfoReply } = require('../../Functions/EmbedBuilders');

const repConfig = miscConfig?.reputation || {};
const REP_DAILY_LIMIT = Math.max(1, Math.min(100, Number(repConfig.dailyLimit) || 3));
const REP_PAIR_COOLDOWN_MS = Math.max(60_000, Math.min(7 * 24 * 60 * 60 * 1000, Number(repConfig.pairCooldownMs) || 12 * 60 * 60 * 1000));

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
        ),
    category: 'utility',
    async execute(interaction) {
        if (!interaction.guild || !interaction.member) {
            return interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'view') {
            const targetUser = interaction.options.getUser('user') || interaction.user;
            const points = await DatabaseManager.getReputation(interaction.guildId, targetUser.id);
            const rankInfo = await DatabaseManager.getReputationRank(interaction.guildId, targetUser.id);

            return sendInfoReply(
                interaction,
                'Reputation Profile',
                `${targetUser} has **${points}** reputation point${points === 1 ? '' : 's'}.\nRank: **${rankInfo?.rank || 'Unranked'}**`
            );
        }

        if (subcommand === 'leaderboard') {
            const limit = interaction.options.getInteger('limit') || 10;
            const topRows = await DatabaseManager.getReputationLeaderboard(interaction.guildId, limit);
            if (!topRows.length) {
                return sendInfoReply(interaction, 'No Reputation Yet', 'No reputation points have been awarded in this server yet.');
            }

            const lines = topRows.map((row, index) => {
                return `**#${index + 1}** <@${row.user_id}> — **${row.points}** point${row.points === 1 ? '' : 's'}`;
            });

            const embed = new EmbedBuilder()
                .setColor(0x1e1f22)
                .setTitle('🏆 Reputation Leaderboard')
                .setDescription(lines.join('\n'))
                .setFooter({ text: `Requested by ${interaction.user.tag}` })
                .setTimestamp();

            if (interaction.deferred || interaction.replied) {
                return interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
            }
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        const targetUser = interaction.options.getUser('user', true);

        if (targetUser.id === interaction.user.id) {
            return sendWarningReply(interaction, 'Invalid Target', 'You cannot give reputation to yourself.');
        }

        if (targetUser.bot) {
            return sendWarningReply(interaction, 'Invalid Target', 'You cannot give reputation to bots.');
        }

        const result = await DatabaseManager.giveReputationPoint(interaction.guildId, interaction.user.id, targetUser.id, {
            cooldownMs: REP_PAIR_COOLDOWN_MS,
            dailyLimit: REP_DAILY_LIMIT
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

        return sendSuccessReply(
            interaction,
            'Reputation Added',
            `${interaction.user} gave +1 reputation to ${targetUser}.\nThey now have **${result.totalRep}** reputation point${result.totalRep === 1 ? '' : 's'}.\nToday: **${result.grantsToday}/${result.dailyLimit}** used.`,
            { ephemeral: false }
        );
    }
};