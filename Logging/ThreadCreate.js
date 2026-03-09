const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require('../Config/constants');
const { formatId, LOG_COLORS, buildFooter } = require('./_logEmbedUtils');

module.exports = (client) => {
    client.on('threadCreate', async (thread) => {
        if (!thread?.guild) return;

        const logs = client.channels.cache.get(serverLogChannelId);
        if (!logs) return;

        const embed = new EmbedBuilder()
            .setTitle('🧵 Thread Created')
            .setColor(LOG_COLORS.CREATE)
            .setDescription('A new thread channel was created.')
            .addFields(
                { name: 'Thread', value: `${thread}`, inline: true },
                { name: 'Thread ID', value: formatId(thread.id), inline: true },
                { name: 'Parent Channel', value: thread.parent ? `${thread.parent}` : 'Unknown', inline: true },
                { name: 'Owner ID', value: formatId(thread.ownerId), inline: true },
                { name: 'Auto Archive', value: `${thread.autoArchiveDuration || 'Unknown'} min`, inline: true },
                { name: 'Private', value: thread.type === 12 ? 'Yes' : 'No', inline: true }
            )
            .setTimestamp()
            .setFooter({ text: buildFooter(thread.guild?.name || 'Unknown Guild', 'Thread Created') });

        return logs.send({ embeds: [embed] }).catch(() => null);
    });
};