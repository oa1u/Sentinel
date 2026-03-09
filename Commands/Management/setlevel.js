const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { setUserXP, resetUser, getUserData, calculateRequiredXP } = require('../../Events/Leveling');
const { sendErrorReply, sendSuccessReply, sendWarningReply } = require('../../Functions/EmbedBuilders');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setlevel')
        .setDescription('Set a user\'s XP, level, or rank (Admin only)')
        .addSubcommand(subcommand =>
            subcommand
                .setName('xp')
                .setDescription('Set a user\'s total XP')
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('User to modify')
                        .setRequired(true)
                )
                .addIntegerOption(option =>
                    option.setName('amount')
                        .setDescription('Total XP to set')
                        .setRequired(true)
                        .setMinValue(0)
                        .setMaxValue(999999999) // Prevent integer overflow
                        .setMaxValue(999999999) // Prevent crazy big numbers from breaking things
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('level')
                .setDescription('Set a user\'s level')
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('User to modify')
                        .setRequired(true)
                )
                .addIntegerOption(option =>
                    option.setName('amount')
                        .setDescription('Level to set (1-100)')
                        .setRequired(true)
                        .setMinValue(1)
                        .setMaxValue(100)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('reset')
                .setDescription('Reset a user\'s level and XP')
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('User to reset')
                        .setRequired(true)
                )
        ),
    category: 'management',
    async execute(interaction) {
        // Only admins are allowed to use this command.
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            await sendWarningReply(
                interaction,
                'No Permission',
                'You need **Administrator** permission!'
            );
            return;
        }

        const subcommand = interaction.options.getSubcommand();
        const targetUser = interaction.options.getUser('user');

        if (targetUser.bot) {
            await sendWarningReply(
                interaction,
                'Invalid User',
                'You cannot modify bot levels!'
            );
            return;
        }

        if (subcommand === 'xp') {
            const amount = interaction.options.getInteger('amount');
            const userData = await setUserXP(targetUser.id, amount);

            await sendSuccessReply(
                interaction,
                'XP Updated',
                `Set **${targetUser.tag}**'s XP to **${amount.toLocaleString()}**\n` +
                `New Level: **${userData.level}**`
            );
        } else if (subcommand === 'level') {
            const level = interaction.options.getInteger('amount');

            // Figure out how much XP is needed for the chosen level.
            let totalXP = 0;
            for (let i = 1; i < level; i++) {
                totalXP += calculateRequiredXP(i);
            }

            const userData = await setUserXP(targetUser.id, totalXP);

            await sendSuccessReply(
                interaction,
                'Level Updated',
                `Set **${targetUser.tag}**'s level to **${level}**\n` +
                `Total XP: **${totalXP.toLocaleString()}**`
            );
        } else if (subcommand === 'reset') {
            const oldData = await getUserData(targetUser.id);
            await resetUser(targetUser.id);

            await sendSuccessReply(
                interaction,
                'Level Reset',
                `Reset **${targetUser.tag}**'s level and XP\n` +
                `Previous Level: **${oldData.level}** (${oldData.totalXP.toLocaleString()} XP)`
            );
        }
    }
};