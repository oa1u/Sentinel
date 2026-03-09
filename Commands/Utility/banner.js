const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { sendErrorReply, sendInfoReply } = require('../../Functions/EmbedBuilders');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('banner')
        .setDescription('Show a user banner')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User to view banner for')
                .setRequired(false)
        ),
    category: 'utility',
    async execute(interaction) {
        try {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferReply().catch(() => { });
            }

            const targetUser = interaction.options.getUser('user') || interaction.user;
            const fetchedUser = await interaction.client.users.fetch(targetUser.id, { force: true });
            const bannerURL = fetchedUser.bannerURL({ size: 4096, forceStatic: false });

            if (!bannerURL) {
                return sendInfoReply(interaction, 'No Banner', `**${targetUser.tag}** does not have a profile banner.`);
            }

            const bannerPng = fetchedUser.bannerURL({ extension: 'png', size: 4096, forceStatic: true });
            const bannerWebp = fetchedUser.bannerURL({ extension: 'webp', size: 4096, forceStatic: false });
            const bannerJpg = fetchedUser.bannerURL({ extension: 'jpg', size: 4096, forceStatic: true });
            const bannerGif = fetchedUser.bannerURL({ extension: 'gif', size: 4096, forceStatic: false });
            const isAnimated = Boolean(fetchedUser.banner && fetchedUser.banner.startsWith('a_'));

            const embed = new EmbedBuilder()
                .setColor(0x1e1f22)
                .setAuthor({
                    name: `${targetUser.tag} (${targetUser.id})`,
                    iconURL: targetUser.displayAvatarURL({ size: 128 })
                })
                .setTitle('User Banner')
                .setImage(bannerURL)
                .setDescription([
                    `**Formats:** [PNG](${bannerPng}) • [JPG](${bannerJpg}) • [WEBP](${bannerWebp})${isAnimated ? ` • [GIF](${bannerGif})` : ''}`,
                    `**Mention:** <@${targetUser.id}> | **ID:** \\\`${targetUser.id}\\\``
                ].join('\n'))
                .setFooter({
                    text: `Requested by ${interaction.user.tag}`,
                    iconURL: interaction.user.displayAvatarURL({ size: 128 })
                })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('[banner] Error:', error.message);
            await sendErrorReply(interaction, 'Banner Error', 'Failed to fetch banner. Please try again.');
        }
    }
};