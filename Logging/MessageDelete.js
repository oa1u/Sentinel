const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require('../Config/constants');
const { truncateText, formatId, formatTimestamp, LOG_COLORS, buildFooter } = require('./_logEmbedUtils');

module.exports = (client) => {
    client.on('messageDelete', async (message) => {
        if (!message?.guild || message?.author?.bot) return;

        const logs = client.channels.cache.get(serverLogChannelId);
        if (!logs) return;

        const safeContent = truncateText(message.content || 'No text content', 1000);
        const hasAttachments = Number(message.attachments?.size || 0);
        const attachmentList = hasAttachments
            ? message.attachments.first(3).map((a) => a.url).join('\n')
            : 'None';

        const embed = new EmbedBuilder()
            .setTitle('🗑️ Message Deleted')
            .setColor(LOG_COLORS.DELETE)
            .setDescription('A message was deleted in a text channel.')
            .addFields(
                { name: 'Author', value: message.author ? `${message.author.tag} (${formatId(message.author.id)})` : 'Unknown', inline: true },
                { name: 'Channel', value: message.channel ? `${message.channel}` : 'Unknown', inline: true },
                { name: 'Message ID', value: formatId(message.id), inline: true },
                { name: 'Sent At', value: formatTimestamp(message.createdTimestamp), inline: true },
                { name: 'Attachments', value: String(hasAttachments), inline: true },
                { name: 'Content Snapshot', value: safeContent, inline: false },
                { name: 'Attachment URLs', value: truncateText(attachmentList, 1024), inline: false }
            )
            .setTimestamp()
            .setFooter({ text: buildFooter(message.guild?.name || 'Unknown Guild', 'Message Deleted') });

        if (message.author) {
            embed.setThumbnail(message.author.displayAvatarURL({ size: 128 }));
        }

        return logs.send({ embeds: [embed] }).catch(() => null);
    });
};