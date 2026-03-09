const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const AdminPanelHelper = require('../../Functions/AdminPanelHelper');
const { sendErrorReply, sendInfoReply } = require('../../Functions/EmbedBuilders');
const { ROLES: { administratorRoleId, moderatorRoleId } } = require('../../Config/constants');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('moderations')
        .setDescription('List users who are currently timed out'),
    category: 'moderation',
    async execute(interaction) {
        if (!interaction.guild || !interaction.member) {
            return interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
        }

        const hasModeratorRole = interaction.member.roles?.cache?.has(moderatorRoleId);
        const hasAdminRole = interaction.member.roles?.cache?.has(administratorRoleId);
        const hasModeratePermission = interaction.member.permissions?.has(PermissionFlagsBits.ModerateMembers);

        const hasAccess = hasModeratorRole || hasAdminRole || hasModeratePermission;
        if (!hasAccess) {
            return interaction.reply({
                content: '❌ You need a moderator/admin role or relevant moderation permissions to use this command.',
                flags: MessageFlags.Ephemeral
            }).catch(() => { });
        }

        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
        }

        try {
            const activeTimeouts = await AdminPanelHelper.getActiveTimeouts();

            if (!activeTimeouts.length) {
                return sendInfoReply(interaction, 'No Active Timeouts', 'There are no users currently timed out.');
            }

            const lines = activeTimeouts.slice(0, 25).map((entry, index) => {
                const userId = entry.user_id;
                const caseId = entry.case_id ? ` • Case: \`${entry.case_id}\`` : '';
                const expiresText = entry.expires_at
                    ? `<t:${Math.floor(Number(entry.expires_at) / 1000)}:R>`
                    : 'No expiry';
                return `**${index + 1}.** <@${userId}> • Expires ${expiresText}${caseId}`;
            });

            const moreCount = Math.max(activeTimeouts.length - 25, 0);

            const embed = new EmbedBuilder()
                .setColor(0xFAA61A)
                .setTitle('⏱️ Active Timeouts')
                .setDescription(lines.join('\n') + (moreCount ? `\n\n...and **${moreCount}** more.` : ''))
                .setFooter({ text: `${activeTimeouts.length} active timeout${activeTimeouts.length === 1 ? '' : 's'}` })
                .setTimestamp();

            return interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('[moderations] Error:', error.message);
            return sendErrorReply(interaction, 'Command Failed', `Could not fetch active timeouts.\nError: ${error.message}`);
        }
    }
};