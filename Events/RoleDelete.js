const ConfigValidator = require('../Functions/ConfigValidator');
const { createLogEmbed, sendLogEmbed } = require('../Functions/LoggingHelper');

module.exports = {
    name: 'roleDelete',
    runOnce: false,
    call: async (client, args) => {
        const [role] = args;
        if (!role?.guild) return;

        const references = ConfigValidator.findConfigReferencesById(role.id, 'role');
        if (!references.length) return;

        const embed = createLogEmbed({
            title: 'Configured Role Deleted',
            description: `A configured role was deleted from **${role.guild.name}**.`,
            color: 0xED4245,
            fields: [
                { name: 'Deleted Role', value: `${role.name} (${role.id})`, inline: false },
                { name: 'Config References', value: references.map((ref) => `${ref.config}.${ref.path}`).join('\n'), inline: false }
            ]
        });

        await sendLogEmbed(role.guild, embed).catch(() => null);
        await ConfigValidator.validateAndNotify(client, role.guild, { reason: 'role-delete' }).catch(() => null);
    }
};