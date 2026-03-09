const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const InviteTracker = require('../../Functions/InviteTracker');

function formatCount(value) {
    const num = Number(value || 0);
    return Number.isFinite(num) ? num.toLocaleString('en-US') : '0';
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('inviteleaderboard')
        .setDescription('Show top inviters in this server')
        .addIntegerOption(option =>
            option.setName('limit')
                .setDescription('How many users to show (1-20)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(20)
        ),
    category: 'utility',
    async execute(interaction) {
        await interaction.deferReply().catch(() => { });

        const guildId = interaction.guild?.id;
        if (!guildId) {
            return interaction.editReply({ content: 'This command can only be used in a server.' });
        }

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
                lines.push(`${start + i + 1}. **${label}** — ${formatCount(entry.joins)} join(s)`);
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
        const message = await interaction.editReply({ embeds: [first.embed], components: [first.row] });

        const collector = message.createMessageComponentCollector({
            time: 2 * 60 * 1000,
            filter: (i) => i.user.id === interaction.user.id
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
            } catch (_) {
                // ignore
            }
        });

        return null;
    }
};