const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const AdminPanelHelper = require('../../Functions/AdminPanelHelper');
const { sendErrorReply, sendInfoReply } = require('../../Functions/EmbedBuilders');

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

function trimForField(value, maxLength) {
    const text = String(value || '').trim();
    if (!text) return 'Unknown';
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function getFirstNonEmpty(...values) {
    for (const value of values) {
        if (value === null || value === undefined) continue;
        const text = String(value).trim();
        if (text) return text;
    }
    return '';
}

function normalizeLogEntry(raw) {
    const action = getFirstNonEmpty(raw?.action, 'ACTION').toUpperCase();
    const userId = getFirstNonEmpty(raw?.user_id, raw?.userId);
    const userName = getFirstNonEmpty(raw?.user_name, raw?.username);
    const moderatorId = getFirstNonEmpty(raw?.moderator_id, raw?.moderatorId);
    const moderatorName = getFirstNonEmpty(raw?.moderator_name, raw?.moderatorName);
    const reason = getFirstNonEmpty(raw?.reason, 'No reason provided');
    const timestamp = raw?.timestamp_ms ?? raw?.timestamp ?? null;

    return {
        action,
        userId,
        userName,
        moderatorId,
        moderatorName,
        reason,
        timestamp
    };
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
            const userLabelCache = new Map();

            if (!logs.length) {
                return sendInfoReply(interaction, 'No Moderation Logs', 'No recent moderation actions were found.');
            }

            // Attempt to resolve usernames/ moderators in real-time via the bot client for more accurate labels
            const resolvedEntries = await Promise.all(logs.slice(0, 25).map(async (rawEntry) => {
                const entry = normalizeLogEntry(rawEntry);

                // Helper to resolve labels with optional guild-aware mention behavior.
                async function resolveUserLabel(id, storedName, options = {}) {
                    const { mentionOnlyIfInGuild = false } = options;
                    const cacheKey = `${id || 'none'}|${storedName || 'none'}|${mentionOnlyIfInGuild ? 'guild-only' : 'allow-mention'}`;

                    if (userLabelCache.has(cacheKey)) {
                        return userLabelCache.get(cacheKey);
                    }

                    if (!id && !storedName) return null;

                    const meaningfulStoredName = storedName && !/^unknown/i.test(storedName) && storedName !== id;

                    // Try stored name first if it's meaningful
                    if (meaningfulStoredName && !id) {
                        userLabelCache.set(cacheKey, storedName);
                        return storedName;
                    }

                    if (id && mentionOnlyIfInGuild && interaction?.guild?.members) {
                        try {
                            const member = await interaction.guild.members.fetch(id).catch(() => null);
                            if (member?.user) {
                                const value = `${member.user.tag} (<@${id}>)`;
                                userLabelCache.set(cacheKey, value);
                                return value;
                            }
                        } catch (e) {
                            // ignore
                        }

                        if (interaction?.client?.users) {
                            try {
                                const user = await interaction.client.users.fetch(id).catch(() => null);
                                if (user) {
                                    const value = user.tag;
                                    userLabelCache.set(cacheKey, value);
                                    return value;
                                }
                            } catch (e) {
                                // ignore
                            }
                        }

                        const fallback = meaningfulStoredName ? storedName : (id || 'Unknown');
                        userLabelCache.set(cacheKey, fallback);
                        return fallback;
                    }

                    if (meaningfulStoredName) {
                        const value = id ? `${storedName} (<@${id}>)` : storedName;
                        userLabelCache.set(cacheKey, value);
                        return value;
                    }

                    if (id && interaction?.client?.users) {
                        try {
                            const user = await interaction.client.users.fetch(id).catch(() => null);
                            if (user) {
                                const value = `${user.tag} (<@${id}>)`;
                                userLabelCache.set(cacheKey, value);
                                return value;
                            }
                        } catch (e) {
                            // ignore
                        }
                        const value = `<@${id}>`;
                        userLabelCache.set(cacheKey, value);
                        return value;
                    }

                    const fallback = storedName || (id ? `<@${id}>` : 'Unknown');
                    userLabelCache.set(cacheKey, fallback);
                    return fallback;
                }

                const targetLabel = await resolveUserLabel(entry.userId, entry.userName, { mentionOnlyIfInGuild: true }) || 'Unknown';
                const moderatorLabel = await resolveUserLabel(entry.moderatorId, entry.moderatorName, { mentionOnlyIfInGuild: true }) || 'System';

                const normalizedReason = entry.reason ? String(entry.reason).trim() : 'No reason provided';
                return {
                    action: trimForField(entry.action, 180),
                    targetLabel: trimForField(targetLabel, 160),
                    moderatorLabel: trimForField(moderatorLabel, 160),
                    reason: trimForField(normalizedReason, 260),
                    when: formatTime(entry.timestamp)
                };
            }));

            const fields = resolvedEntries.map((entry, index) => ({
                name: `${index + 1}. ${entry.action}`,
                value: `**Target:** ${entry.targetLabel}\n**Moderator:** ${entry.moderatorLabel}\n**Reason:** ${entry.reason}\n**When:** ${entry.when}`
            }));

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('📚 Recent Moderation Logs')
                .setDescription('Recent moderation actions in this server.')
                .addFields(fields)
                .setFooter({ text: `Showing ${Math.min(limit, logs.length)} of ${logs.length}` })
                .setTimestamp();

            return interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('[modlogs] Error:', error.message);
            return sendErrorReply(interaction, 'Modlogs Failed', `Could not fetch moderation logs.\nError: ${error.message}`);
        }
    }
};