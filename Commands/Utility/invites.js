
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const InviteTracker = require('../../Functions/InviteTracker');

function formatCount(value) {
    const num = Number(value || 0);
    return Number.isFinite(num) ? num.toLocaleString('en-US') : '0';
}

function extractInviteCode(input) {
    if (!input) return '';
    const trimmed = String(input).trim();
    const inviteRegex = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]+)/i;
    const urlMatch = trimmed.match(inviteRegex);
    if (urlMatch && urlMatch[1]) return urlMatch[1];
    return trimmed.replace(/[^A-Za-z0-9-]/g, '');
}

function formatTimestamp(ms) {
    if (!ms) return 'Unknown';
    return `<t:${Math.floor(ms / 1000)}:R>`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('invites')
        .setDescription('Invite stats and leaderboard')
        .addSubcommand(sub =>
            sub.setName('leaderboard')
                .setDescription('Show top inviters in this server')
                .addIntegerOption(option =>
                    option.setName('limit')
                        .setDescription('How many users to show (1-20)')
                        .setRequired(false)
                        .setMinValue(1)
                        .setMaxValue(20)
                )
        )
        .addSubcommand(sub =>
            sub.setName('code')
                .setDescription('Show join stats for a specific invite code')
                .addStringOption(option =>
                    option.setName('invite')
                        .setDescription('Invite code or URL')
                        .setRequired(true)
                )
        ),
    category: 'utility',
    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guild?.id;
        if (!guildId) {
            return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        }

        if (sub === 'leaderboard') {
            await interaction.deferReply();
            const limit = interaction.options.getInteger('limit') || 10;
            const leaderboard = await InviteTracker.getInviteLeaderboard(guildId, limit);
            if (!leaderboard.length) {
                return interaction.editReply({ content: 'No invite data available yet.' });
            }
            const pageSize = 10;
            const maxPage = Math.max(1, Math.ceil(leaderboard.length / pageSize));
            let page = 1;

            const renderPage = async () => {
                const start = (page - 1) * pageSize;
                const slice = leaderboard.slice(start, start + pageSize);
                const lines = [];
                for (let i = 0; i < slice.length; i++) {
                    const entry = slice[i];
                    const user = await interaction.client.users.fetch(entry.inviterId).catch(() => null);
                    const label = user ? user.tag : entry.inviterId;
                    lines.push(`${start + i + 1}. **${label}** - ${formatCount(entry.joins)} join(s)`);
                }
                const embed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('🏆 Invite Leaderboard')
                    .setDescription(lines.join('\n'))
                    .setFooter({ text: `Page ${page}/${maxPage} • Top ${Math.min(limit, leaderboard.length)} inviters` })
                    .setTimestamp();
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('invite_lb_prev')
                        .setLabel('Prev')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(page <= 1),
                    new ButtonBuilder()
                        .setCustomId('invite_lb_next')
                        .setLabel('Next')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(page >= maxPage)
                );
                return { embed, row };
            };

            const first = await renderPage();
            const message = await interaction.editReply({ embeds: [first.embed], components: maxPage > 1 ? [first.row] : [] });

            if (maxPage > 1) {
                const collector = (message.createMessageComponentCollector ? message : interaction.channel).createMessageComponentCollector({
                    time: 2 * 60 * 1000,
                    filter: (i) => i.user.id === interaction.user.id && ['invite_lb_prev', 'invite_lb_next'].includes(i.customId)
                });

                collector.on('collect', async (i) => {
                    if (i.customId === 'invite_lb_prev') page = Math.max(1, page - 1);
                    if (i.customId === 'invite_lb_next') page = Math.min(maxPage, page + 1);
                    const next = await renderPage();
                    await i.update({ embeds: [next.embed], components: [next.row] });
                });

                collector.on('end', async () => {
                    try {
                        const disabledRow = new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('invite_lb_prev')
                                .setLabel('Prev')
                                .setStyle(ButtonStyle.Secondary)
                                .setDisabled(true),
                            new ButtonBuilder()
                                .setCustomId('invite_lb_next')
                                .setLabel('Next')
                                .setStyle(ButtonStyle.Secondary)
                                .setDisabled(true)
                        );
                        await message.edit({ components: [disabledRow] });
                    } catch (_) { /* ignore */ }
                });
            }
            return null;
        }

        if (sub === 'code') {
            await interaction.deferReply();
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
                .setTitle('❌ Invite Code Stats')
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
    }
};