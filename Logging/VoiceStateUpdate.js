const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require('../Config/constants');
const { formatId, listChanges, LOG_COLORS, buildFooter } = require('./_logEmbedUtils');

module.exports = (client) => {
    client.on('voiceStateUpdate', async (oldState, newState) => {
        const guild = newState?.guild || oldState?.guild;
        if (!guild) return;

        const logs = client.channels.cache.get(serverLogChannelId);
        if (!logs) return;

        const member = newState?.member || oldState?.member;
        if (!member || member.user?.bot) return;

        const changes = [];

        if (oldState.channelId !== newState.channelId) {
            if (!oldState.channelId && newState.channelId) {
                changes.push(`Joined ${newState.channel}`);
            } else if (oldState.channelId && !newState.channelId) {
                changes.push(`Left ${oldState.channel}`);
            } else {
                changes.push(`Moved ${oldState.channel} → ${newState.channel}`);
            }
        }

        if (oldState.selfMute !== newState.selfMute) changes.push(`Self Mute: ${newState.selfMute ? 'On' : 'Off'}`);
        if (oldState.selfDeaf !== newState.selfDeaf) changes.push(`Self Deaf: ${newState.selfDeaf ? 'On' : 'Off'}`);
        if (oldState.serverMute !== newState.serverMute) changes.push(`Server Mute: ${newState.serverMute ? 'On' : 'Off'}`);
        if (oldState.serverDeaf !== newState.serverDeaf) changes.push(`Server Deaf: ${newState.serverDeaf ? 'On' : 'Off'}`);
        if (oldState.streaming !== newState.streaming) changes.push(`Streaming: ${newState.streaming ? 'On' : 'Off'}`);
        if (oldState.selfVideo !== newState.selfVideo) changes.push(`Camera: ${newState.selfVideo ? 'On' : 'Off'}`);

        if (!changes.length) return;

        const embed = new EmbedBuilder()
            .setTitle('🔊 Voice State Updated')
            .setColor(LOG_COLORS.INFO)
            .setDescription(`${member} changed voice settings.`)
            .addFields(
                { name: 'User', value: `${member.user.tag} (${formatId(member.id)})`, inline: true },
                { name: 'Current Channel', value: newState.channel ? `${newState.channel}` : 'Not connected', inline: true },
                { name: 'Changes', value: listChanges(changes), inline: false }
            )
            .setTimestamp()
            .setFooter({ text: buildFooter(guild.name, 'Voice State Update') });

        embed.setThumbnail(member.user.displayAvatarURL({ size: 128 }));

        return logs.send({ embeds: [embed] }).catch(() => null);
    });
};