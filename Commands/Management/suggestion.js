const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const MySQLDatabaseManager = require('../../Functions/MySQLDatabaseManager');
const { administratorRoleId } = require('../../Config/constants/roles.json');

// Admins can handle suggestions—approve, deny, or mark as implemented.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('suggestion')
        .setDescription('Manage suggestions')
        .addSubcommand(subcommand =>
            subcommand
                .setName('approve')
                .setDescription('Approve a suggestion')
                .addStringOption(option =>
                    option.setName('id')
                        .setDescription('Suggestion ID or Case ID')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('response')
                        .setDescription('Response message')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('deny')
                .setDescription('Deny a suggestion')
                .addStringOption(option =>
                    option.setName('id')
                        .setDescription('Suggestion ID or Case ID')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('response')
                        .setDescription('Reason for denial')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('implement')
                .setDescription('Mark a suggestion as implemented')
                .addStringOption(option =>
                    option.setName('id')
                        .setDescription('Suggestion ID or Case ID')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('response')
                        .setDescription('Implementation notes')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('view')
                .setDescription('View a specific suggestion')
                .addStringOption(option =>
                    option.setName('id')
                        .setDescription('Suggestion ID or Case ID')
                        .setRequired(true))),
    execute: async (interaction) => {
        // Only admins are allowed to use this command.
        const member = interaction.member;
        const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator) ||
            member.roles.cache.has(administratorRoleId);

        if (!isAdmin) {
            return interaction.reply({
                content: '❌ You do not have permission to manage suggestions.',
                flags: MessageFlags.Ephemeral
            });
        }

        const subcommand = interaction.options.getSubcommand();
        let idInput = interaction.options.getString('id');
        let suggestionId = null;
        let caseId = null;
        if (/^\d+$/.test(idInput)) {
            suggestionId = parseInt(idInput, 10);
        } else {
            caseId = idInput;
            if (caseId) {
                const suggestionByCase = await MySQLDatabaseManager.getSuggestionByCaseId(caseId);
                if (suggestionByCase) suggestionId = suggestionByCase.suggestion_id;
            }
        }
        const response = interaction.options.getString('response');

        try {
            // Try to fetch the suggestion from the database.
            const suggestion = await MySQLDatabaseManager.getSuggestion(suggestionId);

            if (!suggestion) {
                return interaction.reply({
                    content: `❌ Suggestion #${suggestionId} not found.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            if (subcommand === 'view') {
                // Show all the details for this suggestion.
                const statusEmojis = {
                    'pending': '🟡',
                    'approved': '✅',
                    'denied': '❌',
                    'implemented': '🎉'
                };

                const embed = new EmbedBuilder()
                    .setColor(suggestion.status === 'approved' ? 0x57F287 : suggestion.status === 'denied' ? 0xED4245 : suggestion.status === 'implemented' ? 0xFEE75C : 0x5865F2)
                    .setAuthor({ name: `💡 Suggestion #${suggestion.suggestion_id}` })
                    .setTitle(`Suggestion: ${suggestion.title}`)
                    .setDescription(`**Description:**\n${suggestion.description}`)
                    .addFields(
                        { name: '👤 Submitted by', value: `<@${suggestion.user_id}>`, inline: true },
                        { name: '📊 Status', value: `${statusEmojis[suggestion.status]} **${suggestion.status.charAt(0).toUpperCase() + suggestion.status.slice(1)}**`, inline: true },
                        { name: '📈 Votes', value: `👍 ${suggestion.upvotes} | 👎 ${suggestion.downvotes}`, inline: true }
                    )
                    .setFooter({ text: `Case ID: ${suggestion.case_id || 'N/A'}` })
                    .setTimestamp(new Date(suggestion.created_at));

                if (suggestion.admin_response) {
                    embed.addFields({ name: '📝 Admin Response', value: suggestion.admin_response, inline: false });
                }

                if (suggestion.resolved_at) {
                    embed.addFields({ name: '✅ Resolved', value: `<t:${Math.floor(new Date(suggestion.resolved_at).getTime() / 1000)}:R>`, inline: true });
                }

                return interaction.reply({ embeds: [embed], ephemeral: true });
            }

            // Change the suggestion's status depending on the subcommand.
            let newStatus;
            if (subcommand === 'approve') newStatus = 'approved';
            else if (subcommand === 'deny') newStatus = 'denied';
            else if (subcommand === 'implement') newStatus = 'implemented';

            await MySQLDatabaseManager.updateSuggestionStatus(
                suggestionId,
                newStatus,
                interaction.user.id,
                response
            );

            // If the suggestion was posted in a channel, update the message there as well.
            if (suggestion.message_id) {
                try {
                    const channel = interaction.channel;
                    const msg = await channel.messages.fetch(suggestion.message_id);

                    const statusColors = {
                        'approved': 0x57F287,
                        'denied': 0xED4245,
                        'implemented': 0xFEE75C
                    };

                    const statusEmojis = {
                        'approved': '✅',
                        'denied': '❌',
                        'implemented': '🎉'
                    };

                    const embed = EmbedBuilder.from(msg.embeds[0])
                        .setColor(statusColors[newStatus])
                        .spliceFields(1, 1, { name: '📊 Status', value: `${statusEmojis[newStatus]} **${newStatus.charAt(0).toUpperCase() + newStatus.slice(1)}**`, inline: true });

                    if (response) {
                        embed.addFields({ name: '📝 Admin Response', value: response, inline: false });
                    }

                    embed.setFooter({ text: `Case ID: ${suggestion.case_id || 'N/A'}` });
                    await msg.edit({ embeds: [embed] });
                } catch (err) {
                    console.error('[Suggestion] Could not update original message:', err);
                }
            }

            // Record this action in the audit log for tracking.
            await MySQLDatabaseManager.logAuditEvent(interaction.guild.id, 'OTHER', {
                userId: interaction.user.id,
                action: `Suggestion ${newStatus}`,
                suggestionId: suggestionId,
                response: response || 'No response provided'
            });

            const actionEmojis = {
                'approved': '✅',
                'denied': '❌',
                'implemented': '🎉'
            };

            await interaction.reply({
                content: `${actionEmojis[newStatus]} Suggestion #${suggestionId} has been **${newStatus}**.`,
                flags: MessageFlags.Ephemeral
            });

            console.log(`[Suggestion] #${suggestionId} ${newStatus} by ${interaction.user.tag}`);

        } catch (error) {
            console.error('[Suggestion] Error:', error);
            await interaction.reply({
                content: '❌ An error occurred while processing the suggestion.',
                flags: MessageFlags.Ephemeral
            });
        }
    }
};