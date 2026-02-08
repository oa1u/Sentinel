const MySQLDatabaseManager = require('../../Functions/MySQLDatabaseManager');
const { EmbedBuilder } = require('discord.js');
const { SlashCommandBuilder } = require('@discordjs/builders');

module.exports = {
        data: new SlashCommandBuilder()
            .setName('automodwarns')
            .setDescription('Manage AutoMod warnings for a user.')
            .addSubcommand(sub =>
                sub.setName('list')
                    .setDescription('List all AutoMod warnings for a user')
                    .addUserOption(option =>
                        option.setName('user')
                            .setDescription('User to list warnings for')
                            .setRequired(false)
                    )
            )
            .addSubcommand(sub =>
                sub.setName('clearall')
                    .setDescription('Clear all AutoMod warnings for a user')
                    .addUserOption(option =>
                        option.setName('user')
                            .setDescription('User to clear warnings for')
                            .setRequired(true)
                    )
            )
            .addSubcommand(sub =>
                sub.setName('clearone')
                    .setDescription('Clear a specific AutoMod warning by case ID')
                    .addUserOption(option =>
                        option.setName('user')
                            .setDescription('User to clear warning for')
                            .setRequired(true)
                    )
                    .addStringOption(option =>
                        option.setName('caseid')
                            .setDescription('Case ID of the warning to clear')
                            .setRequired(true)
                    )
            ),
    category: 'management',
    async execute(interaction) {
        // Require administrator role or permissions
        const adminRoleId = require('../../Config/constants/roles.json').administratorRoleId;
        const member = interaction.member;
        const hasAdminRole = member.roles.cache.has(adminRoleId);
        const hasAdminPerm = member.permissions.has('Administrator');
        if (!hasAdminRole && !hasAdminPerm) {
            const embed = new EmbedBuilder()
                .setColor(0xFF4444)
                .setTitle('Permission Denied')
                .setDescription('You need the Administrator role or Administrator permissions to use this command.');
            return interaction.reply({ embeds: [embed], flags: require('discord.js').MessageFlags.Ephemeral });
        }

        const subcommand = interaction.options.getSubcommand();
        const user = interaction.options.getUser('user') || interaction.user;
        const userId = user.id;

        if (subcommand === 'list') {
            try {
                const warnings = await MySQLDatabaseManager.getAutomodViolations(userId, 100);
                if (!warnings || warnings.length === 0) {
                    const embed = new EmbedBuilder()
                        .setColor(0xFF4444)
                        .setTitle('No AutoMod Warnings')
                        .setDescription(`No AutoMod warnings found for user ${user.tag}.`);
                    return interaction.reply({ embeds: [embed], flags: require('discord.js').MessageFlags.Ephemeral });
                }

                const embed = new EmbedBuilder()
                    .setColor(0xFF6B6B)
                    .setTitle(`AutoMod Warnings for User ${user.tag}`);

                warnings.forEach(w => {
                    embed.addFields({
                        name: `Case: ${w.case_id || 'N/A'}`,
                        value: `Reason: ${w.reason || 'N/A'}\nDate: ${w.timestamp ? new Date(w.timestamp).toLocaleString() : 'N/A'}`,
                        inline: false
                    });
                });

                return interaction.reply({ embeds: [embed], flags: require('discord.js').MessageFlags.Ephemeral });
            } catch (err) {
                console.error('Error fetching AutoMod warnings:', err);
                const embed = new EmbedBuilder()
                    .setColor(0xFF4444)
                    .setTitle('Error')
                    .setDescription('Failed to fetch AutoMod warnings.');
                return interaction.reply({ embeds: [embed], flags: require('discord.js').MessageFlags.Ephemeral });
            }
        } else if (subcommand === 'clearall') {
            try {
                await MySQLDatabaseManager.connection.query(
                    'DELETE FROM automod_violations WHERE user_id = ?',
                    [userId]
                );
                const embed = new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle('Warnings Cleared')
                    .setDescription(`All AutoMod warnings cleared for user ${user.tag}.`);
                return interaction.reply({ embeds: [embed], flags: require('discord.js').MessageFlags.Ephemeral });
            } catch (err) {
                console.error('Error clearing AutoMod warnings:', err);
                const embed = new EmbedBuilder()
                    .setColor(0xFF4444)
                    .setTitle('Error')
                    .setDescription('Failed to clear AutoMod warnings.');
                return interaction.reply({ embeds: [embed], flags: require('discord.js').MessageFlags.Ephemeral });
            }
        } else if (subcommand === 'clearone') {
            const caseId = interaction.options.getString('caseid');
            try {
                const result = await MySQLDatabaseManager.connection.query(
                    'DELETE FROM automod_violations WHERE user_id = ? AND case_id = ?',
                    [userId, caseId]
                );
                if (result.affectedRows === 0) {
                    const embed = new EmbedBuilder()
                        .setColor(0xFF4444)
                        .setTitle('Warning Not Found')
                        .setDescription(`No warning found for user ${user.tag} with case ID ${caseId}.`);
                    return interaction.reply({ embeds: [embed], flags: require('discord.js').MessageFlags.Ephemeral });
                }
                const embed = new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle('Warning Cleared')
                    .setDescription(`Warning with case ID ${caseId} cleared for user ${user.tag}.`);
                return interaction.reply({ embeds: [embed], flags: require('discord.js').MessageFlags.Ephemeral });
            } catch (err) {
                console.error('Error clearing specific AutoMod warning:', err);
                const embed = new EmbedBuilder()
                    .setColor(0xFF4444)
                    .setTitle('Error')
                    .setDescription('Failed to clear specific AutoMod warning.');
                return interaction.reply({ embeds: [embed], flags: require('discord.js').MessageFlags.Ephemeral });
            }
        }
    }
};
