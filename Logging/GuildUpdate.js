const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require('../Config/constants');
const { formatId, listChanges, LOG_COLORS, buildFooter } = require('./_logEmbedUtils');

module.exports = (client) => {
    client.on('guildUpdate', async (oldGuild, newGuild) => {
        const logs = client.channels.cache.get(serverLogChannelId);
        if (!logs) return;

        const changes = [];

        if (oldGuild.name !== newGuild.name) changes.push(`Name: **${oldGuild.name}** → **${newGuild.name}**`);
        if (oldGuild.description !== newGuild.description) changes.push(`Description changed`);
        if (oldGuild.verificationLevel !== newGuild.verificationLevel) changes.push(`Verification: **${oldGuild.verificationLevel}** → **${newGuild.verificationLevel}**`);
        if (oldGuild.afkTimeout !== newGuild.afkTimeout) changes.push(`AFK Timeout: **${oldGuild.afkTimeout}s** → **${newGuild.afkTimeout}s**`);
        if (oldGuild.afkChannelId !== newGuild.afkChannelId) changes.push(`AFK Channel changed`);
        if (oldGuild.systemChannelId !== newGuild.systemChannelId) changes.push(`System Channel changed`);
        if (oldGuild.icon !== newGuild.icon) changes.push(`Server icon changed`);
        if (oldGuild.banner !== newGuild.banner) changes.push(`Server banner changed`);

        if (!changes.length) return;

        const embed = new EmbedBuilder()
            .setTitle('🏠 Server Updated')
            .setColor(LOG_COLORS.UPDATE)
            .setDescription(`Server settings were updated for **${newGuild.name}**.`)
            .addFields(
                { name: 'Guild', value: `${newGuild.name} (${formatId(newGuild.id)})`, inline: true },
                { name: 'Total Changes', value: String(changes.length), inline: true },
                { name: 'Changes', value: listChanges(changes), inline: false }
            )
            .setTimestamp()
            .setFooter({ text: buildFooter(newGuild.name, 'Guild Updated') });

        return logs.send({ embeds: [embed] }).catch(() => null);
    });
};