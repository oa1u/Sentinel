const { ChannelType } = require('discord.js');
const ConfigValidator = require('../Functions/ConfigValidator');
const { createLogEmbed, sendLogEmbed } = require('../Functions/LoggingHelper');

function formatChannelType(type) {
    return ChannelType[type] || String(type);
}

function serializePermissionOverwrites(channel) {
    return [...(channel?.permissionOverwrites?.cache?.values?.() || [])]
        .map((overwrite) => `${overwrite.id}:${overwrite.type}:${overwrite.allow.bitfield}:${overwrite.deny.bitfield}`)
        .sort()
        .join('|');
}

function collectChannelChanges(oldChannel, newChannel) {
    const changes = [];

    if (oldChannel.name !== newChannel.name) {
        changes.push(`Name: ${oldChannel.name} -> ${newChannel.name}`);
    }

    if (oldChannel.type !== newChannel.type) {
        changes.push(`Type: ${formatChannelType(oldChannel.type)} -> ${formatChannelType(newChannel.type)}`);
    }

    if (oldChannel.parentId !== newChannel.parentId) {
        const beforeParent = oldChannel.parent?.name || 'None';
        const afterParent = newChannel.parent?.name || 'None';
        changes.push(`Category: ${beforeParent} -> ${afterParent}`);
    }

    if ('rateLimitPerUser' in oldChannel && oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) {
        changes.push(`Slowmode: ${oldChannel.rateLimitPerUser || 0}s -> ${newChannel.rateLimitPerUser || 0}s`);
    }

    if ('nsfw' in oldChannel && oldChannel.nsfw !== newChannel.nsfw) {
        changes.push(`NSFW: ${oldChannel.nsfw ? 'Enabled' : 'Disabled'} -> ${newChannel.nsfw ? 'Enabled' : 'Disabled'}`);
    }

    if (serializePermissionOverwrites(oldChannel) !== serializePermissionOverwrites(newChannel)) {
        changes.push('Permission overwrites changed');
    }

    return changes;
}

module.exports = {
    name: 'channelUpdate',
    runOnce: false,
    call: async (client, args) => {
        const [oldChannel, newChannel] = args;
        const guild = newChannel?.guild || oldChannel?.guild;
        if (!guild || !newChannel) return;

        const changes = collectChannelChanges(oldChannel, newChannel);
        const references = ConfigValidator.findConfigReferencesById(newChannel.id, 'channel');
        if (!changes.length && !references.length) return;

        const embed = createLogEmbed({
            title: references.length ? 'Configured Channel Updated' : 'Channel Updated',
            description: `${newChannel} was updated in **${guild.name}**.`,
            color: references.length ? 0xF1C40F : 0x5865F2,
            fields: [
                { name: 'Channel', value: `${newChannel.name} (${newChannel.id})`, inline: false },
                { name: 'Changes', value: changes.join('\n') || 'No tracked changes', inline: false },
                ...(references.length
                    ? [{ name: 'Config References', value: references.map((ref) => `${ref.config}.${ref.path}`).join('\n'), inline: false }]
                    : [])
            ]
        });

        await sendLogEmbed(guild, embed).catch(() => null);

        if (references.length) {
            await ConfigValidator.validateAndNotify(client, guild, { reason: 'channel-update' }).catch(() => null);
        }
    }
};