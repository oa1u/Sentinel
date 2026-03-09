const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getSnipe } = require('../../Functions/SnipeCache');
const { sendInfoReply } = require('../../Functions/EmbedBuilders');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('snipe')
        .setDescription('Show the last deleted message in this channel'),
    category: 'utility',
    async execute(interaction) {
        if (!interaction.guild || !interaction.channel) {
            return interaction.reply({ content: 'This command can only be used in a server channel.', flags: MessageFlags.Ephemeral });
        }

        const sniped = getSnipe(interaction.channelId);
        if (!sniped) {
            return sendInfoReply(interaction, 'Nothing To Snipe', 'No recently deleted message was found in this channel.');
        }

        const deletedUnix = Math.floor(Number(sniped.deletedAt || Date.now()) / 1000);
        const createdUnix = Number(sniped.createdTimestamp || 0) > 0
            ? Math.floor(Number(sniped.createdTimestamp) / 1000)
            : null;

        const contentText = sniped.content || '*No text content (possibly attachment-only).*';
        const attachmentText = sniped.attachments?.length
            ? sniped.attachments.map((item, index) => `${index + 1}. [${item.name}](${item.url})`).join('\n')
            : 'None';

        const embed = new EmbedBuilder()
            .setColor(0x1e1f22)
            .setTitle('🕵️ Last Deleted Message')
            .setDescription(contentText)
            .addFields(
                { name: 'Author', value: `<@${sniped.userId}>`, inline: true },
                { name: 'Deleted', value: `<t:${deletedUnix}:R>`, inline: true },
                { name: 'Original Time', value: createdUnix ? `<t:${createdUnix}:R>` : 'Unknown', inline: true },
                { name: 'Attachments', value: attachmentText, inline: false }
            )
            .setFooter({
                text: `Requested by ${interaction.user.tag}`,
                iconURL: interaction.user.displayAvatarURL({ size: 128 })
            })
            .setTimestamp();

        if (interaction.deferred || interaction.replied) {
            return interaction.editReply({ embeds: [embed] });
        }
        return interaction.reply({ embeds: [embed] });
    }
};