const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require('../Config/constants');
const { formatId, formatTimestamp, LOG_COLORS, buildFooter } = require('./_logEmbedUtils');

module.exports = (client) => {
    client.on('guildScheduledEventCreate', async (event) => {
        const guild = event?.guild;
        if (!guild) return;

        const logs = client.channels.cache.get(serverLogChannelId);
        if (!logs) return;

        const start = formatTimestamp(event.scheduledStartTimestamp, 'F');
        const end = formatTimestamp(event.scheduledEndTimestamp, 'F');

        const embed = new EmbedBuilder()
            .setTitle('📅 Scheduled Event Created')
            .setColor(LOG_COLORS.CREATE)
            .setDescription('A scheduled event was created.')
            .addFields(
                { name: 'Event', value: `${event.name || 'Unknown'} (${formatId(event.id)})`, inline: true },
                { name: 'Status', value: String(event.status || 'Unknown'), inline: true },
                { name: 'Entity Type', value: String(event.entityType || 'Unknown'), inline: true },
                { name: 'Starts', value: start, inline: true },
                { name: 'Ends', value: end, inline: true },
                { name: 'Creator ID', value: formatId(event.creatorId), inline: true }
            )
            .setTimestamp()
            .setFooter({ text: buildFooter(guild.name, 'Scheduled Event Created') });

        return logs.send({ embeds: [embed] }).catch(() => null);
    });
};