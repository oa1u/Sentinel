const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require('../Config/constants');
const { truncateText, formatId, formatTimestamp, LOG_COLORS, buildFooter } = require('./_logEmbedUtils');

module.exports = (client) => {
    client.on('messageUpdate', async (oldMessage, newMessage) => {
        try {
            if (oldMessage?.partial) await oldMessage.fetch().catch(() => null);
            if (newMessage?.partial) await newMessage.fetch().catch(() => null);

            if (!newMessage?.guild || newMessage?.author?.bot) return;

            const oldContent = String(oldMessage?.content || '').trim();
            const newContent = String(newMessage?.content || '').trim();

            if (oldContent === newContent) return;

            const logs = client.channels.cache.get(serverLogChannelId);
            if (!logs) return;

            const safeOld = truncateText(oldContent || 'No text content', 1000);
            const safeNew = truncateText(newContent || 'No text content', 1000);
            const messageUrl = newMessage.url || 'Unavailable';

            const embed = new EmbedBuilder()
                .setTitle('✏️ Message Updated')
                .setColor(LOG_COLORS.UPDATE)
                .setDescription('A message was edited.')
                .addFields(
                    { name: 'Author', value: `${newMessage.author.tag} (${formatId(newMessage.author.id)})`, inline: true },
                    { name: 'Channel', value: `${newMessage.channel}`, inline: true },
                    { name: 'Message ID', value: formatId(newMessage.id), inline: true },
                    { name: 'Edited At', value: formatTimestamp(Date.now()), inline: true },
                    { name: 'Jump To Message', value: messageUrl !== 'Unavailable' ? `[Open Message](${messageUrl})` : 'Unavailable', inline: true },
                    { name: 'Before', value: safeOld, inline: false },
                    { name: 'After', value: safeNew, inline: false }
                )
                .setTimestamp()
                .setFooter({ text: buildFooter(newMessage.guild?.name || 'Unknown Guild', 'Message Updated') });

            embed.setThumbnail(newMessage.author.displayAvatarURL({ size: 128 }));

            return logs.send({ embeds: [embed] }).catch(() => null);
        } catch (_) {
            return null;
        }
    });
};