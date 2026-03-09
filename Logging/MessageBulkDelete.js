const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require('../Config/constants');
const { truncateText, formatId, LOG_COLORS, buildFooter } = require('./_logEmbedUtils');

module.exports = (client) => {
    client.on('messageDeleteBulk', async (messages, channel) => {
        const first = messages?.first?.();
        const guild = first?.guild || channel?.guild;
        if (!guild) return;

        const logs = client.channels.cache.get(serverLogChannelId);
        if (!logs) return;

        const count = Number(messages?.size || 0);
        const sampleIds = messages?.first
            ? messages.first(8).map((m) => formatId(m.id)).join(', ')
            : 'N/A';
        const users = messages?.map ? [...new Set(messages.map((m) => m.author?.id).filter(Boolean))] : [];

        const embed = new EmbedBuilder()
            .setTitle('🧹 Messages Bulk Deleted')
            .setColor(LOG_COLORS.DELETE)
            .setDescription('Multiple messages were deleted in a single action.')
            .addFields(
                { name: 'Channel', value: channel ? `${channel}` : 'Unknown', inline: true },
                { name: 'Deleted Count', value: String(count), inline: true },
                { name: 'Unique Authors', value: String(users.length), inline: true },
                { name: 'Sample Message IDs', value: truncateText(sampleIds || 'N/A', 1024), inline: false }
            )
            .setTimestamp()
            .setFooter({ text: buildFooter(guild?.name || 'Unknown Guild', 'Message Bulk Delete') });

        return logs.send({ embeds: [embed] }).catch(() => null);
    });
};