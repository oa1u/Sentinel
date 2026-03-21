const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require('../Config/constants');
const { formatId, formatTimestamp, LOG_COLORS, buildFooter } = require('./_logEmbedUtils');

module.exports = (client) => {
    client.on('guildScheduledEventDelete', async (event) => {
        const guild = event?.guild;
        if (!guild) return;

        const logs = client.channels.cache.get(serverLogChannelId);
        if (!logs) return;

        const embed = new EmbedBuilder()
            .setTitle('❌ Scheduled Event Deleted')
            .setColor(LOG_COLORS.DELETE)
            .setDescription('A scheduled event was deleted.')
            .addFields(
                { name: 'Event Name', value: event.name || 'Unknown', inline: true },
                { name: 'Event ID', value: formatId(event.id), inline: true },
                { name: 'Status', value: String(event.status || 'Unknown'), inline: true },
                { name: 'Started', value: formatTimestamp(event.scheduledStartTimestamp, 'F'), inline: true },
                { name: 'Ended', value: formatTimestamp(event.scheduledEndTimestamp, 'F'), inline: true }
            )
            .setTimestamp()
            .setFooter({ text: buildFooter(guild.name, 'Scheduled Event Deleted') });

        return logs.send({ embeds: [embed] }).catch(() => null);
    });
};