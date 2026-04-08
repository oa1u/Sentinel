const { PermissionsBitField } = require('discord.js');
const ConfigValidator = require('../Functions/ConfigValidator');
const { createLogEmbed, sendLogEmbed } = require('../Functions/LoggingHelper');

function collectPermissionDelta(oldRole, newRole) {
    const before = new PermissionsBitField(oldRole.permissions.bitfield);
    const after = new PermissionsBitField(newRole.permissions.bitfield);
    const allFlags = Object.entries(PermissionsBitField.Flags);
    const added = [];
    const removed = [];

    for (const [name, bit] of allFlags) {
        const hadBefore = before.has(bit);
        const hasAfter = after.has(bit);
        if (!hadBefore && hasAfter) added.push(name);
        if (hadBefore && !hasAfter) removed.push(name);
    }

    return { added, removed };
}

function collectRoleChanges(oldRole, newRole) {
    const changes = [];

    if (oldRole.name !== newRole.name) {
        changes.push(`Name: ${oldRole.name} -> ${newRole.name}`);
    }
    if (oldRole.color !== newRole.color) {
        changes.push(`Color: ${oldRole.hexColor} -> ${newRole.hexColor}`);
    }
    if (oldRole.hoist !== newRole.hoist) {
        changes.push(`Displayed separately: ${oldRole.hoist ? 'Yes' : 'No'} -> ${newRole.hoist ? 'Yes' : 'No'}`);
    }
    if (oldRole.mentionable !== newRole.mentionable) {
        changes.push(`Mentionable: ${oldRole.mentionable ? 'Yes' : 'No'} -> ${newRole.mentionable ? 'Yes' : 'No'}`);
    }
    if (oldRole.position !== newRole.position) {
        changes.push(`Position: ${oldRole.position} -> ${newRole.position}`);
    }

    const permissionDelta = collectPermissionDelta(oldRole, newRole);
    if (permissionDelta.added.length || permissionDelta.removed.length) {
        const addedText = permissionDelta.added.length ? `Added: ${permissionDelta.added.slice(0, 5).join(', ')}` : '';
        const removedText = permissionDelta.removed.length ? `Removed: ${permissionDelta.removed.slice(0, 5).join(', ')}` : '';
        changes.push([addedText, removedText].filter(Boolean).join(' | '));
    }

    return changes;
}

module.exports = {
    name: 'roleUpdate',
    runOnce: false,
    call: async (client, args) => {
        const [oldRole, newRole] = args;
        if (!newRole?.guild) return;

        const references = ConfigValidator.findConfigReferencesById(newRole.id, 'role');
        if (!references.length) return;

        const changes = collectRoleChanges(oldRole, newRole);
        const embed = createLogEmbed({
            title: 'Configured Role Updated',
            description: `${newRole} was updated and is referenced by the bot configuration.`,
            color: 0xF39C12,
            fields: [
                { name: 'Role', value: `${newRole.name} (${newRole.id})`, inline: false },
                { name: 'Config References', value: references.map((ref) => `${ref.config}.${ref.path}`).join('\n'), inline: false },
                { name: 'Changes', value: changes.join('\n') || 'No tracked changes', inline: false }
            ]
        });

        await sendLogEmbed(newRole.guild, embed).catch(() => null);
        await ConfigValidator.validateAndNotify(client, newRole.guild, { reason: 'role-update' }).catch(() => null);
    }
};