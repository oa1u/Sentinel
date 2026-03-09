const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');
const { sendErrorReply, sendInfoReply } = require('../../Functions/EmbedBuilders');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('audit')
        .setDescription('Show moderation intelligence summary for a user')
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('User to audit')
                .setRequired(true)
        ),
    category: 'moderation',
    async execute(interaction) {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
        }

        try {
            const target = interaction.options.getUser('user', true);
            const profile = await DatabaseManager.getUserProfile(target.id);

            if (!profile) {
                return sendInfoReply(interaction, 'No Data Found', 'No audit data was found for this user.');
            }

            const warningCount = Array.isArray(profile.warnings) ? profile.warnings.length : 0;
            const violationCount = Array.isArray(profile.violations) ? profile.violations.length : 0;
            const auditLogCount = Array.isArray(profile.auditLogs) ? profile.auditLogs.length : 0;
            const isBanned = Boolean(profile.ban?.banned);
            const level = profile.user?.level || 0;
            const xp = profile.user?.xp || 0;

            const riskScore = Math.min(
                100,
                (warningCount * 10) +
                (violationCount * 6) +
                (auditLogCount * 2) +
                (isBanned ? 30 : 0)
            );

            const riskLabel = riskScore >= 70 ? 'High' : riskScore >= 40 ? 'Medium' : 'Low';

            const embed = new EmbedBuilder()
                .setColor(riskScore >= 70 ? 0xED4245 : riskScore >= 40 ? 0xFAA61A : 0x43B581)
                .setTitle('🧠 User Audit Summary')
                .setDescription(`Target: ${target}`)
                .addFields(
                    { name: '⚠️ Warnings', value: `${warningCount}`, inline: true },
                    { name: '🛡️ AutoMod Violations', value: `${violationCount}`, inline: true },
                    { name: '📜 Audit Entries', value: `${auditLogCount}`, inline: true },
                    { name: '🔨 Banned', value: isBanned ? 'Yes' : 'No', inline: true },
                    { name: '📈 Level / XP', value: `${level} / ${xp}`, inline: true },
                    { name: '🎯 Risk', value: `${riskLabel} (${riskScore}/100)`, inline: true }
                )
                .setTimestamp();

            return interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('[audit] Error:', error.message);
            return sendErrorReply(interaction, 'Audit Failed', `Could not build the audit summary.\nError: ${error.message}`);
        }
    }
};