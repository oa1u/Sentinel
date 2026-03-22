const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');

const STATUS_CHOICES = [
    ['Open', 'open'],
    ['Active', 'active'],
    ['Closed', 'closed'],
    ['Cleared', 'cleared'],
    ['Reversed', 'reversed'],
    ['Expired', 'expired'],
    ['Appealed', 'appealed']
];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('case')
        .setDescription('Manage moderation cases')
        .addSubcommand(subcommand =>
            subcommand
                .setName('view')
                .setDescription('View details of a specific case')
                .addStringOption(option =>
                    option.setName('case_id')
                        .setDescription('The Case ID to look up')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('user')
                .setDescription('List recent cases for a user')
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('The user to look up')
                        .setRequired(true)
                )
                .addIntegerOption(option =>
                    option.setName('limit')
                        .setDescription('Maximum number of cases to show')
                        .setMinValue(1)
                        .setMaxValue(20)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('moderator')
                .setDescription('List recent cases created by a moderator')
                .addUserOption(option =>
                    option.setName('moderator')
                        .setDescription('The moderator to look up')
                        .setRequired(true)
                )
                .addIntegerOption(option =>
                    option.setName('limit')
                        .setDescription('Maximum number of cases to show')
                        .setMinValue(1)
                        .setMaxValue(20)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('recent')
                .setDescription('List the latest moderation cases')
                .addIntegerOption(option =>
                    option.setName('limit')
                        .setDescription('Maximum number of cases to show')
                        .setMinValue(1)
                        .setMaxValue(20)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('search')
                .setDescription('Search moderation cases by case ID, reason, or names')
                .addStringOption(option =>
                    option.setName('query')
                        .setDescription('Text to search for')
                        .setRequired(true)
                )
                .addIntegerOption(option =>
                    option.setName('limit')
                        .setDescription('Maximum number of cases to show')
                        .setMinValue(1)
                        .setMaxValue(20)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('List cases by lifecycle status')
                .addStringOption(option => {
                    option.setName('status')
                        .setDescription('Lifecycle status to filter by')
                        .setRequired(true);
                    for (const [name, value] of STATUS_CHOICES) {
                        option.addChoices({ name, value });
                    }
                    return option;
                })
                .addIntegerOption(option =>
                    option.setName('limit')
                        .setDescription('Maximum number of cases to show')
                        .setMinValue(1)
                        .setMaxValue(20)
                )
        ),
    category: 'moderation',
    async execute(interaction) {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
        }

        const subcommand = interaction.options.getSubcommand();

        try {
            if (subcommand === 'view') {
                return await handleViewCase(interaction);
            }

            return await handleCaseSearch(interaction, subcommand);
        } catch (error) {
            console.error('Error in case command:', error);
            return interaction.editReply({ content: 'An error occurred while fetching case details.' });
        }
    }
};

async function handleViewCase(interaction) {
    const caseId = String(interaction.options.getString('case_id', true) || '').trim().toUpperCase();
    const caseData = await DatabaseManager.getModerationCaseById(caseId);

    if (!caseData) {
        return interaction.editReply({
            content: `❌ **Case Not Found**\nNo case found with ID: \`${caseId}\``
        });
    }

    const moderatorLabel = formatActorLabel(caseData.moderator_name, caseData.moderator_id);
    const userLabel = formatActorLabel(caseData.user_name, caseData.user_id);
    const effectiveStatus = normalizeStatusLabel(caseData.effective_status || caseData.status);

    const embed = new EmbedBuilder()
        .setTitle(`Case Details: ${caseData.case_id}`)
        .setColor(getColorForType(caseData.action_type))
        .addFields(
            { name: 'Type', value: `**${String(caseData.action_type || 'OTHER').toUpperCase()}**`, inline: true },
            { name: 'Status', value: effectiveStatus, inline: true },
            { name: 'Target', value: userLabel, inline: true },
            { name: 'Moderator', value: moderatorLabel, inline: true },
            { name: 'Created', value: formatTimestamp(caseData.created_at), inline: true },
            { name: 'Updated', value: formatTimestamp(caseData.updated_at || caseData.created_at), inline: true },
            { name: 'Reason', value: truncate(caseData.reason || 'No reason provided', 1024), inline: false }
        )
        .setFooter({ text: `Case ID: ${caseData.case_id}` })
        .setTimestamp();

    if (caseData.expires_at) {
        embed.addFields({ name: 'Expires', value: formatTimestamp(caseData.expires_at), inline: true });
    }
    if (caseData.closed_at) {
        embed.addFields({ name: 'Closed', value: formatTimestamp(caseData.closed_at), inline: true });
    }
    if (caseData.related_case_id) {
        embed.addFields({ name: 'Related Case', value: `\`${caseData.related_case_id}\``, inline: true });
    }
    if (caseData.root_case_id && caseData.root_case_id !== caseData.case_id) {
        embed.addFields({ name: 'Root Case', value: `\`${caseData.root_case_id}\``, inline: true });
    }
    if (caseData.incident) {
        const incidentLines = [];
        if (caseData.incident.reason) {
            incidentLines.push(`Reason: ${truncate(caseData.incident.reason, 180)}`);
        }
        if (caseData.incident.proof_text) {
            incidentLines.push(`Proof: ${truncate(caseData.incident.proof_text, 180)}`);
        }
        if (caseData.incident.proof_url) {
            incidentLines.push(`Proof URL: ${truncate(caseData.incident.proof_url, 180)}`);
        }
        if (caseData.incident.message_link) {
            incidentLines.push(`Message: ${truncate(caseData.incident.message_link, 180)}`);
        }
        if (caseData.incident.updated_at || caseData.incident.created_at) {
            incidentLines.push(`Updated: ${formatTimestamp(caseData.incident.updated_at || caseData.incident.created_at)}`);
        }
        embed.addFields({
            name: 'Incident Proof',
            value: truncate(incidentLines.join('\n') || 'Incident proof is attached to this case.', 1024),
            inline: false
        });
    }

    const timelineLines = (Array.isArray(caseData.timeline) ? caseData.timeline : [])
        .slice(-6)
        .map(entry => {
            const summary = truncate(entry.summary || entry.event_type || 'Case event', 100);
            const details = entry.details ? `\n${truncate(entry.details, 120)}` : '';
            return `• **${summary}**\n${formatTimestamp(entry.created_at)}${details}`;
        });

    embed.addFields({
        name: 'Timeline',
        value: truncate(timelineLines.join('\n\n') || 'No timeline events recorded yet.', 1024),
        inline: false
    });

    const relatedLines = (Array.isArray(caseData.relatedCases) ? caseData.relatedCases : [])
        .slice(0, 6)
        .map(row => (
            `• \`${row.case_id}\` • **${String(row.action_type || 'OTHER').toUpperCase()}** • ${normalizeStatusLabel(row.status || row.effective_status || 'open')}`
        ));
    if (relatedLines.length) {
        embed.addFields({
            name: 'Linked Cases',
            value: truncate(relatedLines.join('\n'), 1024),
            inline: false
        });
    }

    return interaction.editReply({ embeds: [embed] });
}

async function handleCaseSearch(interaction, subcommand) {
    const limit = Number(interaction.options.getInteger('limit') || 10);
    let rows = [];
    let title = 'Moderation Cases';
    let description = 'Recent moderation case activity.';

    if (subcommand === 'user') {
        const user = interaction.options.getUser('user', true);
        rows = await DatabaseManager.searchModerationCases({ userId: user.id, limit });
        title = 'User Cases';
        description = `Recent cases for ${user.tag}`;
    } else if (subcommand === 'moderator') {
        const moderator = interaction.options.getUser('moderator', true);
        rows = await DatabaseManager.searchModerationCases({ moderatorId: moderator.id, limit });
        title = 'Moderator Cases';
        description = `Recent cases created by ${moderator.tag}`;
    } else if (subcommand === 'recent') {
        rows = await DatabaseManager.searchModerationCases({ limit });
        title = 'Recent Cases';
        description = 'Latest moderation cases recorded in the ledger.';
    } else if (subcommand === 'search') {
        const query = interaction.options.getString('query', true);
        rows = await DatabaseManager.searchModerationCases({ query, limit });
        title = 'Case Search';
        description = `Results for \`${truncate(query, 60)}\``;
    } else if (subcommand === 'status') {
        const status = interaction.options.getString('status', true);
        rows = await DatabaseManager.searchModerationCases({ status, limit: Math.max(limit, 20) });
        rows = rows.slice(0, limit);
        title = 'Cases By Status';
        description = `Showing cases with status **${normalizeStatusLabel(status)}**`;
    }

    if (!rows.length) {
        return interaction.editReply({ content: 'No matching moderation cases were found.' });
    }

    const summaryLines = rows.map((row, index) => formatCaseSummaryRow(row, index));
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(title)
        .setDescription(description)
        .addFields({
            name: `Results (${rows.length})`,
            value: truncate(summaryLines.join('\n\n'), 1024),
            inline: false
        })
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

function formatActorLabel(name, id) {
    if (name && id) {
        return `${name} (\`${id}\`)`;
    }
    if (name) {
        return name;
    }
    if (id) {
        return `\`${id}\``;
    }
    return 'Unknown';
}

function formatCaseSummaryRow(row, index) {
    const type = String(row.action_type || 'OTHER').toUpperCase();
    const status = normalizeStatusLabel(row.effective_status || row.status);
    const target = row.user_name || row.user_id || 'Unknown user';
    const moderator = row.moderator_name || row.moderator_id || 'Unknown moderator';
    const reason = truncate(row.reason || 'No reason provided', 90);

    return [
        `**${index + 1}.** \`${row.case_id}\` • **${type}** • ${status}`,
        `Target: ${target}`,
        `Moderator: ${moderator}`,
        `Created: ${formatShortTimestamp(row.created_at)}`,
        `Reason: ${reason}`
    ].join('\n');
}

function formatTimestamp(value) {
    const timestamp = toUnixTimestamp(value);
    if (!timestamp) {
        return 'Unknown';
    }
    return `<t:${timestamp}:F>\n<t:${timestamp}:R>`;
}

function formatShortTimestamp(value) {
    const timestamp = toUnixTimestamp(value);
    if (!timestamp) {
        return 'Unknown';
    }
    return `<t:${timestamp}:R>`;
}

function toUnixTimestamp(value) {
    if (!value) return null;

    if (value instanceof Date) {
        return Math.floor(value.getTime() / 1000);
    }

    const numericValue = Number(value);
    if (Number.isFinite(numericValue) && numericValue > 0) {
        return Math.floor((numericValue > 9999999999 ? numericValue : numericValue * 1000) / 1000);
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return null;
    }
    return Math.floor(parsed.getTime() / 1000);
}

function normalizeStatusLabel(status) {
    const normalized = String(status || 'open').trim().toLowerCase();
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function truncate(value, maxLength) {
    const safe = String(value || '');
    if (safe.length <= maxLength) {
        return safe;
    }
    return `${safe.slice(0, Math.max(0, maxLength - 3))}...`;
}

function getColorForType(type) {
    switch (String(type || '').toUpperCase()) {
        case 'BAN':
            return 0xED4245;
        case 'UNBAN':
            return 0x57F287;
        case 'KICK':
            return 0xFEE75C;
        case 'WARN':
            return 0xFAA61A;
        case 'TIMEOUT':
            return 0x5865F2;
        case 'UNTIMEOUT':
            return 0x57F287;
        case 'LOCKDOWN':
            return 0x2B2D31;
        default:
            return 0x0099FF;
    }
}
