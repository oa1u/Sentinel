const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require('../Config/constants');
const MySQLDatabaseManager = require('../Functions/MySQLDatabaseManager');

const DEFAULT_GHOST_PING_WINDOW_MS = 120000;
const configuredWindow = Number(process.env.GHOST_PING_WINDOW_MS);
const GHOST_PING_WINDOW_MS = Number.isFinite(configuredWindow) && configuredWindow > 0
    ? configuredWindow
    : DEFAULT_GHOST_PING_WINDOW_MS;

// GhostPingAlert: Detects and logs ghost pings on message deletion
// Export only the handler, not the event registration
exports.disabled = true;
exports.execute = async function (message, client) {
    try {
        console.log(`[GhostPingAlert] messageDelete triggered for message ID: ${message?.id}`);
        if (!message) return console.log(`[GhostPingAlert] Abort: No message`);

        if (message.partial) {
            console.log(`[GhostPingAlert] Message is partial, cannot read mentions reliably. Aborting.`);
            // Cannot fetch a deleted message from Discord API
            return;
        }

        if (!message.guild || !message.channel || !message.author || message.author.bot) {
            return console.log(`[GhostPingAlert] Abort: Missing guild/channel/author or is bot`);
        }

        const createdAt = Number(message.createdTimestamp || 0);
        if (!Number.isFinite(createdAt) || createdAt <= 0) return console.log(`[GhostPingAlert] Abort: Invalid createdAt: ${createdAt}`);

        const ageMs = Date.now() - createdAt;
        console.log(`[GhostPingAlert] Message age: ${ageMs}ms (Window: ${GHOST_PING_WINDOW_MS}ms)`);
        if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > GHOST_PING_WINDOW_MS) {
            return console.log(`[GhostPingAlert] Abort: Age outside window`);
        }

        const mentionedUsers = message.mentions?.users
            ? [...message.mentions.users.values()].filter((user) => !user.bot && user.id !== message.author.id)
            : [];
        const mentionedRoles = message.mentions?.roles
            ? [...message.mentions.roles.values()]
            : [];
        const hasEveryoneMention = Boolean(message.mentions?.everyone);

        console.log(`[GhostPingAlert] Mentions - Users: ${mentionedUsers.length}, Roles: ${mentionedRoles.length}, Everyone: ${hasEveryoneMention}`);
        if (!mentionedUsers.length && !mentionedRoles.length && !hasEveryoneMention) {
            return console.log(`[GhostPingAlert] Abort: No valid mentions`);
        }

        const logs = await client.channels.fetch(serverLogChannelId).catch(() => null);

        const userTargets = mentionedUsers.map((user) => `${user}`);
        const roleTargets = mentionedRoles.map((role) => `${role}`);
        const targetSegments = [];
        if (userTargets.length) targetSegments.push(userTargets.join(', '));
        if (roleTargets.length) targetSegments.push(roleTargets.join(', '));
        if (hasEveryoneMention) targetSegments.push('@everyone/@here');

        await MySQLDatabaseManager.logGhostPing(
            message.author.id,
            message.author.tag,
            message.content,
            targetSegments.join(', '),
            message.channel.id,
            message.channel.name || null,
            'GHOST_PING'
        );

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