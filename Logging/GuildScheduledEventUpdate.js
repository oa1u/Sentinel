const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require('../Config/constants');
const { formatId, listChanges, LOG_COLORS, buildFooter } = require('./_logEmbedUtils');

module.exports = (client) => {
    client.on('guildScheduledEventUpdate', async (oldEvent, newEvent) => {
        const guild = newEvent?.guild || oldEvent?.guild;
        if (!guild) return;

        const logs = client.channels.cache.get(serverLogChannelId);
        if (!logs) return;

        const changes = [];

        if (oldEvent.name !== newEvent.name) changes.push(`Name: **${oldEvent.name}** → **${newEvent.name}**`);
        if (oldEvent.description !== newEvent.description) changes.push('Description changed');
        if (oldEvent.status !== newEvent.status) changes.push(`Status: **${oldEvent.status}** → **${newEvent.status}**`);
        if (oldEvent.scheduledStartTimestamp !== newEvent.scheduledStartTimestamp) changes.push('Start time changed');
        if (oldEvent.scheduledEndTimestamp !== newEvent.scheduledEndTimestamp) changes.push('End time changed');

        if (!changes.length) return;

        const embed = new EmbedBuilder()
            .setTitle('📅 Scheduled Event Updated')
            .setColor(LOG_COLORS.UPDATE)
            .setDescription('A scheduled event was updated.')
            .addFields(
                { name: 'Event', value: `${newEvent.name || 'Unknown'} (${formatId(newEvent.id)})`, inline: true },
                { name: 'Status', value: String(newEvent.status || 'Unknown'), inline: true },
                { name: 'Changes', value: listChanges(changes), inline: false }
            )
            .setTimestamp()
            .setFooter({ text: buildFooter(guild.name, 'Scheduled Event Updated') });

        return logs.send({ embeds: [embed] }).catch(() => null);
    });
};