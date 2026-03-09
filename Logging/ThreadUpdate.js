const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require('../Config/constants');
const { formatId, listChanges, LOG_COLORS, buildFooter } = require('./_logEmbedUtils');

module.exports = (client) => {
    client.on('threadUpdate', async (oldThread, newThread) => {
        if (!newThread?.guild) return;

        const logs = client.channels.cache.get(serverLogChannelId);
        if (!logs) return;

        const changes = [];

        if (oldThread.name !== newThread.name) changes.push(`Name: **${oldThread.name}** → **${newThread.name}**`);
        if (oldThread.archived !== newThread.archived) changes.push(`Archived: **${newThread.archived ? 'Yes' : 'No'}**`);
        if (oldThread.locked !== newThread.locked) changes.push(`Locked: **${newThread.locked ? 'Yes' : 'No'}**`);
        if (oldThread.autoArchiveDuration !== newThread.autoArchiveDuration) {
            changes.push(`Auto Archive: **${oldThread.autoArchiveDuration}** → **${newThread.autoArchiveDuration}** min`);
        }

        if (!changes.length) return;

        const embed = new EmbedBuilder()
            .setTitle('🧵 Thread Updated')
            .setColor(LOG_COLORS.UPDATE)
            .setDescription(`Thread settings were updated.`)
            .addFields(
                { name: 'Thread', value: `${newThread}`, inline: true },
                { name: 'Thread ID', value: formatId(newThread.id), inline: true },
                { name: 'Archived', value: newThread.archived ? 'Yes' : 'No', inline: true },
                { name: 'Locked', value: newThread.locked ? 'Yes' : 'No', inline: true },
                { name: 'Changes', value: listChanges(changes), inline: false }
            )
            .setTimestamp()
            .setFooter({ text: buildFooter(newThread.parent?.name || newThread.guild?.name || 'Unknown Scope', 'Thread Updated') });

        return logs.send({ embeds: [embed] }).catch(() => null);
    });
};