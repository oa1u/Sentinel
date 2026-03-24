const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const credits = require('../../Config/constants/credits.json');

const ROLE_DISPLAY_ORDER = [
    'Developer',
    'Tester'
];

function normalizeCredits(entries) {
    if (!Array.isArray(entries)) return [];

    return entries
        .map((entry) => ({
            username: String(entry?.username || '').trim(),
            role: String(entry?.role || '').trim(),
            discordId: String(entry?.discordId || '').trim(),
            website: String(entry?.website || '').trim()
        }))
        .filter((entry) => entry.username || entry.role || entry.discordId || entry.website);
}

function formatCreditLine(entry) {
    const username = entry.username || 'Unknown contributor';
    const discordId = entry.discordId || 'No Discord ID added';
    const parts = [`**${username}**`, discordId];

    if (entry.website) {
        parts.push(entry.website);
    }

    return `• ${parts.join(' - ')}`;
}

function groupCreditsByRole(entries) {
    const groups = new Map();

    for (const entry of entries) {
        const role = entry.role || 'Contributor';
        if (!groups.has(role)) {
            groups.set(role, []);
        }
        groups.get(role).push(entry);
    }

    return Array.from(groups.entries())
        .sort(([leftRole], [rightRole]) => compareCreditRoles(leftRole, rightRole))
        .map(([role, roleEntries]) => ({
            role,
            lines: roleEntries.map(formatCreditLine)
        }));
}

function compareCreditRoles(leftRole, rightRole) {
    const leftIndex = ROLE_DISPLAY_ORDER.findIndex((role) => role.toLowerCase() === String(leftRole || '').toLowerCase());
    const rightIndex = ROLE_DISPLAY_ORDER.findIndex((role) => role.toLowerCase() === String(rightRole || '').toLowerCase());

    const normalizedLeftIndex = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const normalizedRightIndex = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;

    if (normalizedLeftIndex !== normalizedRightIndex) {
        return normalizedLeftIndex - normalizedRightIndex;
    }

    return String(leftRole || '').localeCompare(String(rightRole || ''));
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('credits')
        .setDescription('Show the people credited for helping with the project'),
    category: 'utility',
    async execute(interaction) {
        const entries = normalizeCredits(credits);

        if (!entries.length) {
            return interaction.reply({
                content: 'No credits have been added yet. Update Config/constants/credits.json to populate this command.',
                flags: MessageFlags.Ephemeral
            });
        }

        const groupedEntries = groupCreditsByRole(entries);

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('Project Credits')
            .setDescription('People who helped with this project.')
            .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
            .setTimestamp();

        groupedEntries.forEach((group) => {
            embed.addFields({
                name: group.role,
                value: group.lines.join('\n')
            });
        });

        return interaction.reply({ embeds: [embed] });
    }
};