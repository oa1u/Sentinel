const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require('../Config/constants');
const { formatId, truncateText, LOG_COLORS, buildFooter } = require('./_logEmbedUtils');

module.exports = (client) => {
    client.on('stickerDelete', async (sticker) => {
        const guild = sticker?.guild;
        if (!guild) return;

        const logs = client.channels.cache.get(serverLogChannelId);
        if (!logs) return;

        const embed = new EmbedBuilder()
            .setTitle('🗑️ Sticker Deleted')
            .setColor(LOG_COLORS.DELETE)
            .setDescription('A sticker was deleted.')
            .addFields(
                { name: 'Sticker Name', value: sticker.name || 'Unknown', inline: true },
                { name: 'Sticker ID', value: formatId(sticker.id), inline: true },
                { name: 'Tags', value: truncateText(sticker.tags || 'None', 256), inline: true },
                { name: 'Description', value: truncateText(sticker.description || 'None', 512), inline: false }
            )
            .setTimestamp()
            .setFooter({ text: buildFooter(guild.name, 'Sticker Deleted') });

        return logs.send({ embeds: [embed] }).catch(() => null);
    });
};