const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const InviteTracker = require('../../Functions/InviteTracker');

function extractInviteCode(input) {
    if (!input) return '';
    const trimmed = String(input).trim();

    const inviteRegex = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]+)/i;
    const urlMatch = trimmed.match(inviteRegex);
    if (urlMatch && urlMatch[1]) return urlMatch[1];

    return trimmed.replace(/[^A-Za-z0-9-]/g, '');
}

function formatCount(value) {
    const num = Number(value || 0);
    return Number.isFinite(num) ? num.toLocaleString('en-US') : '0';
}

function formatTimestamp(ms) {
    if (!ms) return 'Unknown';
    return `<t:${Math.floor(ms / 1000)}:R>`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('invitecode')
        .setDescription('Show join stats for a specific invite code')
        .addStringOption(option =>
            option.setName('invite')
                .setDescription('Invite code or URL')
                .setRequired(true)
        ),
    category: 'utility',
    async execute(interaction) {
        await interaction.deferReply().catch(() => { });

        const guildId = interaction.guild?.id;
        if (!guildId) {
            return interaction.editReply({ content: 'This command can only be used in a server.' });
        }

        const rawInput = interaction.options.getString('invite', true);
        const code = extractInviteCode(rawInput);
        if (!code) {
            return interaction.editReply({ content: 'Please provide a valid invite code or URL.' });
        }

        const stats = await InviteTracker.getInviteStatsByCode(guildId, code);
        if (!stats) {
            return interaction.editReply({ content: `No tracked data for invite \`${code}\`.` });
        }

        const inviterId = stats.inviterId;
        const inviter = inviterId
            ? await interaction.client.users.fetch(inviterId).catch(() => null)
            : null;

        const inviterLabel = inviter
            ? `${inviter.tag}`
            : inviterId
                ? `Unknown User (${inviterId})`
                : 'Vanity URL';

        const inviterTotal = inviterId
            ? await InviteTracker.getInviterJoinCount(guildId, inviterId)
            : null;

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🔗 Invite Code Stats')
            .setDescription(`Stats for **${code}**`)
            .addFields(
                { name: 'Inviter', value: inviterLabel, inline: true },
                { name: 'Joins via this code', value: `**${formatCount(stats.joins)}**`, inline: true },
                { name: 'Last Join', value: formatTimestamp(stats.lastJoinedAt), inline: true }
            )
            .setTimestamp();

        if (inviterTotal !== null) {
            embed.addFields({
                name: 'Inviter Total (all codes)',
                value: `**${formatCount(inviterTotal)}**`,
                inline: true
            });
        }

        if (inviter?.displayAvatarURL) {
            embed.setThumbnail(inviter.displayAvatarURL({ size: 128 }));
        }

        return interaction.editReply({ embeds: [embed] });
    }
};