const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');
const moment = require('moment');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('case')
        .setDescription('Manage moderation cases')
        .addSubcommand(subcommand =>
            subcommand
                .setName('view')
                .setDescription('View details of a specific case')
                .addStringOption(option =>
                    option.setName('case_id')
                        .setDescription('The Case ID to look up')
                        .setRequired(true)
                )
        ),
    category: 'moderation',
    async execute(interaction) {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'view') {
            const caseId = interaction.options.getString('case_id');

            // user_bans stores TIMESTAMP values while the other tables store milliseconds.
            const query = `
                SELECT 'WARN' as type, case_id, user_id, reason, moderator_id, timestamp as created_at_ms 
                FROM warns WHERE case_id = ?
                UNION ALL
                SELECT 'BAN' as type, ban_case_id as case_id, user_id, ban_reason as reason, banned_by as moderator_id, UNIX_TIMESTAMP(banned_at) * 1000 as created_at_ms 
                FROM user_bans WHERE ban_case_id = ?
                UNION ALL
                SELECT 'KICK' as type, case_id, user_id, reason, kicked_by as moderator_id, kicked_at as created_at_ms 
                FROM kicks WHERE case_id = ?
                UNION ALL
                SELECT 'TIMEOUT' as type, case_id, user_id, reason, issued_by as moderator_id, issued_at as created_at_ms 
                FROM timeouts WHERE case_id = ?
            `;

            const params = [caseId, caseId, caseId, caseId];

            try {
                const results = await DatabaseManager.query(query, params);

                if (!results || results.length === 0) {
                    return interaction.editReply({
                        content: `❌ **Case Not Found**\nNo case found with ID: \`${caseId}\``
                    });
                }

                const caseData = results[0];
                const typeLabel = caseData.type;
                const moderatorId = caseData.moderator_id;
                const userId = caseData.user_id;
                const timestamp = caseData.created_at_ms;

                const moderatorUser = await interaction.client.users.fetch(moderatorId).catch(() => null);
                const targetUser = await interaction.client.users.fetch(userId).catch(() => null);

                const moderatorTag = moderatorUser ? moderatorUser.tag : (moderatorId || 'Unknown');
                const userTag = targetUser ? targetUser.tag : (userId || 'Unknown');

                const embed = new EmbedBuilder()
                    .setTitle(`Case Details: ${caseId}`)
                    .setColor(getColorForType(typeLabel))
                    .addFields(
                        { name: 'Type', value: `**${typeLabel}**`, inline: true },
                        { name: 'User', value: `${userTag} (\`${userId}\`)`, inline: true },
                        { name: 'Moderator', value: `${moderatorTag} (\`${moderatorId}\`)`, inline: true },
                        { name: 'Reason', value: caseData.reason || 'No reason provided' },
                        { name: 'Date', value: timestamp ? `<t:${Math.floor(timestamp / 1000)}:F>` : 'Unknown' }
                    )
                    .setFooter({ text: `Case ID: ${caseId}` })
                    .setTimestamp();

                return interaction.editReply({ embeds: [embed] });

            } catch (error) {
                console.error('Error in case view command:', error);
                return interaction.editReply({ content: 'An error occurred while fetching case details.' });
            }
        }
    }
};

function getColorForType(type) {
    switch (type) {
        case 'BAN': return 0xFF0000;
        case 'KICK': return 0xFFA500;
        case 'WARN': return 0xFFFF00;
        case 'TIMEOUT': return 0x808080;
        default: return 0x0099FF;
    }
}
