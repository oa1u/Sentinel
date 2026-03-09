const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require('../Config/constants');
const { formatId, boolText, LOG_COLORS, buildFooter } = require('./_logEmbedUtils');

module.exports = (client) => {
    client.on('integrationUpdate', async (integration) => {
        const guild = integration?.guild;
        if (!guild) return;

        const logs = client.channels.cache.get(serverLogChannelId);
        if (!logs) return;

        const embed = new EmbedBuilder()
            .setTitle('✏️ Integration Updated')
            .setColor(LOG_COLORS.UPDATE)
            .setDescription('An integration was updated.')
            .addFields(
                { name: 'Integration', value: integration.name || 'Unknown', inline: true },
                { name: 'Type', value: integration.type || 'Unknown', inline: true },
                { name: 'ID', value: formatId(integration.id), inline: true },
                { name: 'Enabled', value: boolText(integration.enabled), inline: true },
                { name: 'Syncing', value: boolText(integration.syncing), inline: true },
                { name: 'Role ID', value: formatId(integration.roleId), inline: true }
            )
            .setTimestamp()
            .setFooter({ text: buildFooter(guild.name, 'Integration Updated') });

        return logs.send({ embeds: [embed] }).catch(() => null);
    });
};