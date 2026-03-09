const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require('../Config/constants');
const { formatId, LOG_COLORS, buildFooter } = require('./_logEmbedUtils');

module.exports = (client) => {
    client.on('webhooksUpdate', async (channel) => {
        if (!channel?.guild) return;

        const logs = client.channels.cache.get(serverLogChannelId);
        if (!logs) return;

        const webhookCount = await channel.fetchWebhooks().then((h) => h.size).catch(() => null);

        const embed = new EmbedBuilder()
            .setTitle('🪝 Webhooks Updated')
            .setColor(LOG_COLORS.INFO)
            .setDescription('Webhook configuration changed in a channel.')
            .addFields(
                { name: 'Channel', value: `${channel}`, inline: true },
                { name: 'Channel ID', value: formatId(channel.id), inline: true },
                { name: 'Guild', value: `${channel.guild.name} (${formatId(channel.guild.id)})`, inline: true },
                { name: 'Webhook Count', value: webhookCount == null ? 'Unavailable' : String(webhookCount), inline: true }
            )
            .setTimestamp()
            .setFooter({ text: buildFooter(channel.guild.name, 'Webhooks Update') });

        return logs.send({ embeds: [embed] }).catch(() => null);
    });
};