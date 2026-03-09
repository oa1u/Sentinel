const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require('../Config/constants');
const { formatId, boolText, truncateText, LOG_COLORS, buildFooter } = require('./_logEmbedUtils');

module.exports = (client) => {
    client.on('stickerCreate', async (sticker) => {
        const guild = sticker?.guild;
        if (!guild) return;

        const logs = client.channels.cache.get(serverLogChannelId);
        if (!logs) return;

        const embed = new EmbedBuilder()
            .setTitle('🎨 Sticker Created')
            .setColor(LOG_COLORS.CREATE)
            .setDescription('A sticker was created.')
            .addFields(
                { name: 'Sticker', value: `${sticker.name || 'Unknown'} (${formatId(sticker.id)})`, inline: true },
                { name: 'Tags', value: truncateText(sticker.tags || 'None', 256), inline: true },
                { name: 'Format', value: String(sticker.format || sticker.formatType || 'Unknown'), inline: true },
                { name: 'Available', value: boolText(sticker.available), inline: true },
                { name: 'Description', value: truncateText(sticker.description || 'None', 512), inline: false }
            )
            .setTimestamp()
            .setFooter({ text: buildFooter(guild.name, 'Sticker Created') });

        return logs.send({ embeds: [embed] }).catch(() => null);
    });
};