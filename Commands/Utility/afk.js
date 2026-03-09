const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { sendSuccessReply, sendInfoReply } = require('../../Functions/EmbedBuilders');
const AfkManager = require('../../Functions/AfkManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('afk')
        .setDescription('Manage your AFK status')
        .addSubcommand(subcommand =>
            subcommand
                .setName('set')
                .setDescription('Set or update your AFK status')
                .addStringOption(option =>
                    option
                        .setName('reason')
                        .setDescription('Optional AFK reason')
                        .setRequired(false)
                        .setMaxLength(200)
                )
                .addStringOption(option =>
                    option
                        .setName('mentions_mode')
                        .setDescription('How users are notified when they mention you')
                        .setRequired(false)
                        .addChoices(
                            { name: 'Off', value: 'off' },
                            { name: 'Compact', value: 'compact' },
                            { name: 'Rich', value: 'rich' }
                        )
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('off')
                .setDescription('Clear your AFK status')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('View your current AFK status')
        ),
    category: 'utility',
    async execute(interaction) {
        if (!interaction.guild || !interaction.member) {
            return interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
        }

        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
        }

        const guildId = interaction.guildId;
        const userId = interaction.user.id;
        const existing = AfkManager.getAfk(guildId, userId);
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'status') {
            if (!existing) {
                return sendInfoReply(
                    interaction,
                    'AFK Status',
                    'You are not currently AFK. Use `/afk set` to enable AFK.'
                );
            }

            const sinceUnix = Math.floor(Number(existing.since || Date.now()) / 1000);
            return sendInfoReply(
                interaction,
                'AFK Status',
                `You are currently AFK.\nReason: **${existing.reason}**\nMentions mode: **${existing.mentionsMode || 'compact'}**\nSince: <t:${sinceUnix}:R> (<t:${sinceUnix}:f>)`
            );
        }

        if (subcommand === 'off') {
            if (!existing) {
                return sendInfoReply(
                    interaction,
                    'AFK Already Off',
                    'You are not currently AFK.'
                );
            }

            AfkManager.clearAfk(guildId, userId);
            return sendSuccessReply(
                interaction,
                'AFK Removed',
                'Welcome back! Your AFK status has been removed.'
            );
        }

        const reasonInput = interaction.options.getString('reason');
        const mentionsModeInput = interaction.options.getString('mentions_mode');

        if (existing) {
            const updated = AfkManager.updateAfk(guildId, userId, {
                ...(reasonInput !== null ? { reason: reasonInput } : {}),
                ...(mentionsModeInput !== null ? { mentionsMode: mentionsModeInput } : {})
            });

            return sendInfoReply(
                interaction,
                'AFK Updated',
                `Your AFK settings were updated.\nReason: **${updated.reason}**\nMentions mode: **${updated.mentionsMode}**\nUse \`/afk off\` or send a message to remove it.`
            );
        }

        const record = AfkManager.setAfk(guildId, userId, reasonInput, mentionsModeInput);

        return sendInfoReply(
            interaction,
            'AFK Enabled',
            `You are now marked as AFK.\nReason: **${record.reason}**\nMentions mode: **${record.mentionsMode}**\nUse \`/afk off\` or send a message to remove it.`
        );
    }
};
