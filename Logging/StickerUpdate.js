const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require('../Config/constants');
const { formatId, listChanges, LOG_COLORS, buildFooter } = require('./_logEmbedUtils');

module.exports = (client) => {
    client.on('stickerUpdate', async (oldSticker, newSticker) => {
        const guild = newSticker?.guild || oldSticker?.guild;
        if (!guild) return;

        const logs = client.channels.cache.get(serverLogChannelId);
        if (!logs) return;

        const changes = [];

        if (oldSticker.name !== newSticker.name) changes.push(`Name: **${oldSticker.name}** → **${newSticker.name}**`);
        if (oldSticker.description !== newSticker.description) changes.push('Description changed');
        if (oldSticker.tags !== newSticker.tags) changes.push(`Tags: **${oldSticker.tags || 'None'}** → **${newSticker.tags || 'None'}**`);
        if (oldSticker.available !== newSticker.available) changes.push(`Available: **${newSticker.available ? 'Yes' : 'No'}**`);

        if (!changes.length) return;

        const embed = new EmbedBuilder()
            .setTitle('🎨 Sticker Updated')
            .setColor(LOG_COLORS.UPDATE)
            .setDescription('A sticker was updated.')
            .addFields(
                { name: 'Sticker', value: `${newSticker.name || 'Unknown'} (${formatId(newSticker.id)})`, inline: true },
                { name: 'Available', value: newSticker.available ? 'Yes' : 'No', inline: true },
                { name: 'Changes', value: listChanges(changes), inline: false }
            )
            .setTimestamp()
            .setFooter({ text: buildFooter(guild.name, 'Sticker Updated') });

        return logs.send({ embeds: [embed] }).catch(() => null);
    });
};