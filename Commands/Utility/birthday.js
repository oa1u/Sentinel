const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');
const { sendErrorReply, sendSuccessReply } = require('../../Functions/EmbedBuilders');

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

function formatBirthday(month, day) {
    const monthName = MONTH_NAMES[Math.max(0, Math.min(11, Number(month) - 1))] || `Month ${month}`;
    return `${monthName} ${Number(day)}`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('birthday')
        .setDescription('Set or view birthday information')
        .addSubcommand(subcommand =>
            subcommand
                .setName('set')
                .setDescription('Set your birthday')
                .addIntegerOption(option =>
                    option
                        .setName('month')
                        .setDescription('Birth month (1-12)')
                        .setRequired(true)
                        .setMinValue(1)
                        .setMaxValue(12)
                )
                .addIntegerOption(option =>
                    option
                        .setName('day')
                        .setDescription('Birth day (1-31)')
                        .setRequired(true)
                        .setMinValue(1)
                        .setMaxValue(31)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('view')
                .setDescription('View your birthday or another user\'s birthday')
                .addUserOption(option =>
                    option
                        .setName('user')
                        .setDescription('User to view (defaults to you)')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('Remove your saved birthday')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('Show birthdays in the next 7 days')
        ),
    category: 'utility',
    async execute(interaction) {
        if (!interaction.guild || !interaction.member) {
            return interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
        }

        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
        }

        const subcommand = interaction.options.getSubcommand();

        try {
            if (subcommand === 'set') {
                const month = interaction.options.getInteger('month', true);
                const day = interaction.options.getInteger('day', true);

                if (!DatabaseManager.isValidBirthday(month, day)) {
                    return sendErrorReply(interaction, 'Invalid Date', 'That birthday is not a valid calendar date.');
                }

                const saved = await DatabaseManager.setBirthday(interaction.guildId, interaction.user.id, month, day);
                if (!saved) {
                    return sendErrorReply(interaction, 'Save Failed', 'Could not save your birthday right now. Please try again.');
                }

                return sendSuccessReply(interaction, 'Birthday Saved', `Your birthday is set to **${formatBirthday(month, day)}**.`);
            }

            if (subcommand === 'view') {
                const targetUser = interaction.options.getUser('user') || interaction.user;
                const birthday = await DatabaseManager.getBirthday(interaction.guildId, targetUser.id);

                if (!birthday) {
                    return sendErrorReply(interaction, 'No Birthday Saved', `${targetUser.id === interaction.user.id ? 'You have' : `${targetUser} has`} not set a birthday yet.`);
                }

                const embed = new EmbedBuilder()
                    .setColor(0x1e1f22)
                    .setAuthor({
                        name: `${targetUser.tag} (${targetUser.id})`,
                        iconURL: targetUser.displayAvatarURL({ size: 128 })
                    })
                    .setTitle('🎂 Birthday')
                    .setDescription([
                        `**Date:** ${formatBirthday(birthday.month, birthday.day)}`,
                        `**Mention:** <@${targetUser.id}> | **ID:**  \\\`${targetUser.id}\\\``
                    ].join('\n'))
                    .setFooter({
                        text: `Requested by ${interaction.user.tag}`,
                        iconURL: interaction.user.displayAvatarURL({ size: 128 })
                    })
                    .setTimestamp();

                return interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
            }

            if (subcommand === 'remove') {
                const removed = await DatabaseManager.removeBirthday(interaction.guildId, interaction.user.id);
                if (!removed) {
                    return sendErrorReply(interaction, 'Nothing To Remove', 'You do not have a saved birthday in this server.');
                }

                return sendSuccessReply(interaction, 'Birthday Removed', 'Your saved birthday has been removed.');
            }

            if (subcommand === 'list') {
                const upcoming = await DatabaseManager.getUpcomingBirthdays(interaction.guildId, 7);

                if (!upcoming.length) {
                    return sendErrorReply(interaction, 'No Upcoming Birthdays', 'No birthdays are scheduled in the next 7 days.');
                }

                const lines = upcoming.slice(0, 20).map(item => {
                    const whenText = item.daysUntil === 0
                        ? 'today'
                        : item.daysUntil === 1
                            ? 'in 1 day'
                            : `in ${item.daysUntil} days`;
                    return `• <@${item.user_id}> — **${formatBirthday(item.month, item.day)}** (${whenText})`;
                });

                const moreCount = Math.max(upcoming.length - 20, 0);
                const embed = new EmbedBuilder()
                    .setColor(0x1e1f22)
                    .setTitle('🎉 Upcoming Birthdays (Next 7 Days)')
                    .setDescription(lines.join('\n') + (moreCount ? `\n\n...and **${moreCount}** more.` : ''))
                    .setFooter({
                        text: `Requested by ${interaction.user.tag}`,
                        iconURL: interaction.user.displayAvatarURL({ size: 128 })
                    })
                    .setTimestamp();

                return interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
            }

            return sendErrorReply(interaction, 'Unknown Action', 'That birthday action is not supported.');
        } catch (error) {
            console.error('[birthday] Error:', error.message);
            return sendErrorReply(interaction, 'Birthday Command Failed', `Could not complete this action.\nError: ${error.message}`);
        }
    }
};