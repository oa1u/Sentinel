const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require('../Config/constants');
const { formatId, formatTimestamp, LOG_COLORS, buildFooter } = require('./_logEmbedUtils');

module.exports = (client) => {
    client.on('channelPinsUpdate', async (channel, time) => {
        if (!channel?.guild) return;

        const logs = client.channels.cache.get(serverLogChannelId);
        if (!logs) return;

        const pinTime = formatTimestamp(time, 'F');

        const embed = new EmbedBuilder()
            .setTitle('📌 Channel Pins Updated')
            .setColor(LOG_COLORS.INFO)
            .setDescription(`Pins were updated in ${channel}.`)
            .addFields(
                { name: 'Channel', value: `${channel}`, inline: true },
                { name: 'Channel ID', value: formatId(channel.id), inline: true },
                { name: 'Last Pin Timestamp', value: pinTime, inline: true }
            )
            .setTimestamp()
            .setFooter({ text: buildFooter(channel.guild?.name || 'Unknown Guild', 'Channel Pins Update') });

        return logs.send({ embeds: [embed] }).catch(() => null);
    });
};