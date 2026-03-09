const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const InviteTracker = require('../../Functions/InviteTracker');

function formatCount(value) {
    const num = Number(value || 0);
    return Number.isFinite(num) ? num.toLocaleString('en-US') : '0';
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('invites')
        .setDescription('Show invite stats for a user')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User to check (defaults to you)')
                .setRequired(false)
        ),
    category: 'utility',
    async execute(interaction) {
        await interaction.deferReply().catch(() => { });

        const targetUser = interaction.options.getUser('user') || interaction.user;
        const guildId = interaction.guild?.id;
        if (!guildId) {
            return interaction.editReply({ content: 'This command can only be used in a server.' });
        }

        const total = await InviteTracker.getInviterJoinCount(guildId, targetUser.id);
        const perInvite = await InviteTracker.getInvitesByUser(guildId, targetUser.id);

        const lines = perInvite.length
            ? perInvite.slice(0, 10).map((entry) => {
                return `• \`${entry.code}\` — ${formatCount(entry.joins)} join(s)`;
            })
            : ['No tracked invites yet.'];

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🔗 Invite Tracker')
            .setDescription(`Invite stats for **${targetUser.tag}**`)
            .addFields(
                { name: 'Total Joins (tracked)', value: `**${formatCount(total)}**`, inline: true },
                { name: 'Per Invite', value: lines.join('\n'), inline: false }
            )
            .setFooter({ text: 'Counts are stored in MySQL.' })
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    }
};