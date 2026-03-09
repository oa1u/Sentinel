const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require('../Config/constants');

const DEFAULT_GHOST_PING_WINDOW_MS = 120000;
const configuredWindow = Number(process.env.GHOST_PING_WINDOW_MS);
const GHOST_PING_WINDOW_MS = Number.isFinite(configuredWindow) && configuredWindow > 0
    ? configuredWindow
    : DEFAULT_GHOST_PING_WINDOW_MS;

module.exports = {
    name: 'messageDelete',
    disabled: true,
    async execute(message, client) {
        try {
            if (!message) return;

            if (message.partial) {
                try {
                    await message.fetch();
                } catch (_) {
                    return;
                }
            }

            if (!message.guild || !message.channel || !message.author || message.author.bot) return;

            const createdAt = Number(message.createdTimestamp || 0);
            if (!Number.isFinite(createdAt) || createdAt <= 0) return;

            const ageMs = Date.now() - createdAt;
            if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > GHOST_PING_WINDOW_MS) return;

            const mentionedUsers = message.mentions?.users
                ? [...message.mentions.users.values()].filter((user) => !user.bot)
                : [];
            const mentionedRoles = message.mentions?.roles
                ? [...message.mentions.roles.values()]
                : [];
            const hasEveryoneMention = Boolean(message.mentions?.everyone);

            if (!mentionedUsers.length && !mentionedRoles.length && !hasEveryoneMention) return;

            const logs = await client.channels.fetch(serverLogChannelId).catch(() => null);

            const userTargets = mentionedUsers.map((user) => `${user}`);
            const roleTargets = mentionedRoles.map((role) => `${role}`);
            const targetSegments = [];
            if (userTargets.length) targetSegments.push(userTargets.join(', '));
            if (roleTargets.length) targetSegments.push(roleTargets.join(', '));
            if (hasEveryoneMention) targetSegments.push('@everyone/@here');

            const elapsedSeconds = Math.max(1, Math.round(ageMs / 1000));
            const rawContent = String(message.content || '').trim();
            const preview = rawContent
                ? (rawContent.length > 300 ? `${rawContent.slice(0, 297)}...` : rawContent)
                : 'No text content (embed or attachment only).';

            const channelEmbed = new EmbedBuilder()
                .setTitle('👻 Ghost Ping Alert')
                .setColor('#ED4245')
                .setDescription(`${message.author} deleted a ping quickly.`)
                .addFields(
                    { name: 'Who Pinged', value: `${message.author}`, inline: true },
                    { name: 'Who Was Pinged', value: targetSegments.join(' | ') || 'Unknown', inline: true },
                    { name: 'Deleted After', value: `${elapsedSeconds}s`, inline: true }
                )
                .setTimestamp();

            if (message.channel && message.channel.isTextBased()) {
                await message.channel.send({ embeds: [channelEmbed] }).catch(() => null);
            }

            const embed = new EmbedBuilder()
                .setTitle('👻 Ghost Ping Alert!')
                .setColor('#ED4245')
                .setDescription(`${message.author} pinged and deleted a message quickly.`)
                .addFields(
                    { name: 'Who Pinged', value: `${message.author} (\`${message.author.tag}\`)`, inline: false },
                    { name: 'Who Was Pinged', value: targetSegments.join(' | ') || 'Unknown', inline: false },
                    { name: 'Channel', value: `${message.channel}`, inline: true },
                    { name: 'Deleted After', value: `${elapsedSeconds}s`, inline: true },
                    { name: 'Window', value: `${Math.round(GHOST_PING_WINDOW_MS / 1000)}s`, inline: true },
                    { name: 'Message Preview', value: preview, inline: false }
                )
                .setFooter({ text: `Author ID: ${message.author.id}` })
                .setTimestamp();

            if (logs && logs.isTextBased()) {
                await logs.send({ embeds: [embed] });
            }
        } catch (error) {
            console.error('[GhostPingAlert] Failed to process messageDelete:', error?.message || error);
        }
    }
};