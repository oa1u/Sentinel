const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const AdminPanelHelper = require('../../Functions/AdminPanelHelper');
const { sendErrorReply } = require('../../Functions/EmbedBuilders');

function formatTime(value) {
    const timestamp = Number(value);
    if (Number.isFinite(timestamp) && timestamp > 0) {
        const unix = Math.floor((timestamp > 10_000_000_000 ? timestamp : timestamp * 1000) / 1000);
        return `<t:${unix}:R>`;
    }

    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
        return `<t:${Math.floor(parsed / 1000)}:R>`;
    }

    return 'Unknown time';
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('modlogs')
        .setDescription('Show recent moderation actions')
        .addIntegerOption(option =>
            option
                .setName('limit')
                .setDescription('How many actions to display (default 10, max 25)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(25)
        ),
    category: 'moderation',
    async execute(interaction) {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
        }

        try {
            const limit = interaction.options.getInteger('limit') || 10;
            const logs = await AdminPanelHelper.getRecentModerationActions(limit);

            if (!logs.length) {
                return sendErrorReply(interaction, 'No Moderation Logs', 'No recent moderation actions were found.');
            }

            // Attempt to resolve usernames/ moderators in real-time via the bot client for more accurate labels
            const resolvedLines = await Promise.all(logs.slice(0, 25).map(async (entry, index) => {
                const action = String(entry.action || 'ACTION').toUpperCase();

                const userNameRaw = (entry.user_name || '').toString().trim();
                const userIdRaw = (entry.user_id || '').toString().trim();

                // Helper to try fetching a Discord user by id and return a readable label
                async function resolveUserLabel(id, storedName) {
                    if (!id && !storedName) return null;
                    // Try stored name first if it's meaningful
                    if (storedName && !/^unknown/i.test(storedName) && storedName !== id) {
                        return id ? `${storedName} (<@${id}>)` : storedName;
                    }
                    if (id && interaction?.client?.users) {
                        try {
                            const user = await interaction.client.users.fetch(id).catch(() => null);
                            if (user) return `${user.tag} (<@${id}>)`;
                        } catch (e) {
                            // ignore
                        }
                        return `<@${id}>`;
                    }
                    return storedName || (id ? `<@${id}>` : 'Unknown');
                }

                const targetLabel = await resolveUserLabel(userIdRaw, userNameRaw) || 'Unknown';

                const modNameRaw = (entry.moderator_name || '').toString().trim();
                const modIdRaw = (entry.moderator_id || '').toString().trim();
                const moderatorLabel = await resolveUserLabel(modIdRaw, modNameRaw) || 'System';

                const reason = entry.reason ? String(entry.reason).slice(0, 80) : 'No reason provided';
                return `**${index + 1}.** ${action} • ${targetLabel} by ${moderatorLabel}\n└ ${reason} • ${formatTime(entry.timestamp)}`;
            }));

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('📚 Recent Moderation Logs')
                .setDescription(lines.join('\n'))
                .setFooter({ text: `Showing ${Math.min(limit, logs.length)} of ${logs.length}` })
                .setTimestamp();

            return interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('[modlogs] Error:', error.message);
            return sendErrorReply(interaction, 'Modlogs Failed', `Could not fetch moderation logs.\nError: ${error.message}`);
        }
    }
};
