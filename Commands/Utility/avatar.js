const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('avatar')
        .setDescription('Show a user avatar')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User to view avatar for')
                .setRequired(false)
        ),
    category: 'utility',
    async execute(interaction) {
        try {
            const targetUser = interaction.options.getUser('user') || interaction.user;
            const avatarURL = targetUser.displayAvatarURL({ size: 4096, forceStatic: false });
            const avatarPng = targetUser.displayAvatarURL({ extension: 'png', size: 4096, forceStatic: true });
            const avatarWebp = targetUser.displayAvatarURL({ extension: 'webp', size: 4096, forceStatic: false });
            const avatarJpg = targetUser.displayAvatarURL({ extension: 'jpg', size: 4096, forceStatic: true });
            const avatarGif = targetUser.displayAvatarURL({ extension: 'gif', size: 4096, forceStatic: false });
            const isAnimated = targetUser.avatar && targetUser.avatar.startsWith('a_');

            const embed = new EmbedBuilder()
                .setColor(0x1e1f22)
                .setAuthor({
                    name: `${targetUser.tag} (${targetUser.id})`,
                    iconURL: targetUser.displayAvatarURL({ size: 128 })
                })
                .setTitle('User Avatar')
                .setImage(avatarURL)
                .setDescription([
                    `**Formats:** [PNG](${avatarPng}) • [JPG](${avatarJpg}) • [WEBP](${avatarWebp})${isAnimated ? ` • [GIF](${avatarGif})` : ''}`,
                    `**Mention:** <@${targetUser.id}> | **ID:** \`${targetUser.id}\``
                ].join('\n'))
                .setFooter({
                    text: `Requested by ${interaction.user.tag}`,
                    iconURL: interaction.user.displayAvatarURL({ size: 128 })
                })
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('[avatar] Error:', error.message);
            await interaction.reply({
                content: '❌ Failed to fetch avatar. Please try again.',
                flags: require('discord.js').MessageFlags.Ephemeral
            }).catch(() => { });
        }
    }
};
