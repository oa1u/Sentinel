const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require('../Config/constants');
const { formatId, LOG_COLORS, buildFooter } = require('./_logEmbedUtils');

module.exports = (client) => {
    client.on('threadDelete', async (thread) => {
        if (!thread?.guild) return;

        const logs = client.channels.cache.get(serverLogChannelId);
        if (!logs) return;

        const embed = new EmbedBuilder()
            .setTitle('🗑️ Thread Deleted')
            .setColor(LOG_COLORS.DELETE)
            .setDescription('A thread was deleted.')
            .addFields(
                { name: 'Thread Name', value: thread.name || 'Unknown', inline: true },
                { name: 'Thread ID', value: formatId(thread.id), inline: true },
                { name: 'Parent Channel', value: thread.parent ? `${thread.parent}` : 'Unknown', inline: true },
                { name: 'Owner ID', value: formatId(thread.ownerId), inline: true },
                { name: 'Archived', value: thread.archived ? 'Yes' : 'No', inline: true }
            )
            .setTimestamp()
            .setFooter({ text: buildFooter(thread.guild?.name || 'Unknown Guild', 'Thread Deleted') });

        return logs.send({ embeds: [embed] }).catch(() => null);
    });
};