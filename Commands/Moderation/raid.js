const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { generateCaseId } = require('../../Events/caseId');
const { sendSuccessReply, sendWarningReply, createModerationEmbed } = require('../../Functions/EmbedBuilders');
const { logModerationAction } = require('../../Functions/ModerationHelper');
const AntiRaid = require('../../Functions/AntiRaid');
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('raid')
        .setDescription('Anti-raid controls (staff override)')
        .addSubcommand(subcommand =>
            subcommand
                .setName('enable')
                .setDescription('Enable anti-raid lockdown')
                .addStringOption(option =>
                    option.setName('reason')
                        .setDescription('Reason for enabling lockdown')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('disable')
                .setDescription('Disable anti-raid lockdown')
                .addStringOption(option =>
                    option.setName('reason')
                        .setDescription('Reason for disabling lockdown')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Show anti-raid lockdown status')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('history')
                .setDescription('Show recent manual lockdown actions')
                .addIntegerOption(option =>
                    option.setName('limit')
                        .setDescription('Number of entries to show (default 5, max 10)')
                        .setRequired(false)
                )
        ),
    category: 'moderation',
    async execute(interaction) {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
        }

        if (!AntiRaid.canOverride(interaction)) {
            return sendWarningReply(interaction, 'Access Denied', 'You do not have permission to use raid controls.');
        }

        const subcommand = interaction.options.getSubcommand();
        const reason = interaction.options.getString('reason');

        if (subcommand === 'enable') {
            const caseId = generateCaseId('LOCKDOWN');
            const status = await AntiRaid.setManualLockdown(interaction.guild, true, interaction.user, reason);

            await DatabaseManager.upsertModerationCase({
                caseId,
                guildId: interaction.guild.id,
                userId: interaction.user.id,
                userName: interaction.guild.name,
                actionType: 'LOCKDOWN',
                status: 'active',
                reason,
                moderatorId: interaction.user.id,
                moderatorName: interaction.user.username,
                moderatorSource: 'discord',
                source: 'discord',
                metadata: { lockdownAction: 'enable' },
                createdAt: Date.now(),
                updatedAt: Date.now(),
                eventSummary: 'Lockdown enabled'
            }).catch(() => { });

            const logEmbed = createModerationEmbed({
                action: 'Lockdown Enabled',
                moderator: interaction.user,
                reason,
                caseId,
                color: 0xED4245
            });
            await logModerationAction(interaction, logEmbed).catch(() => { });

            return sendSuccessReply(
                interaction,
                'Lockdown Enabled',
                `Anti-raid lockdown is active.\n` +
                `Reason: ${reason}\n` +
                `Case ID: \`${caseId}\`\n` +
                `Started: <t:${Math.floor((status?.startedAt || Date.now()) / 1000)}:R>`
            );
        }

        if (subcommand === 'disable') {
            const caseId = generateCaseId('LOCKDOWN');
            await AntiRaid.setManualLockdown(interaction.guild, false, interaction.user, reason);

            await DatabaseManager.upsertModerationCase({
                caseId,
                guildId: interaction.guild.id,
                userId: interaction.user.id,
                userName: interaction.guild.name,
                actionType: 'LOCKDOWN',
                status: 'closed',
                reason,
                moderatorId: interaction.user.id,
                moderatorName: interaction.user.username,
                moderatorSource: 'discord',
                source: 'discord',
                metadata: { lockdownAction: 'disable' },
                createdAt: Date.now(),
                updatedAt: Date.now(),
                eventSummary: 'Lockdown disabled'
            }).catch(() => { });

            const logEmbed = createModerationEmbed({
                action: 'Lockdown Disabled',
                moderator: interaction.user,
                reason,
                caseId,
                color: 0x43B581
            });
            await logModerationAction(interaction, logEmbed).catch(() => { });

            return sendSuccessReply(
                interaction,
                'Lockdown Disabled',
                `Anti-raid lockdown has been disabled.\n` +
                `Reason: ${reason}\n` +
                `Case ID: \`${caseId}\``
            );
        }

        if (subcommand === 'history') {
            const requestedLimit = interaction.options.getInteger('limit');
            const limit = Number.isFinite(requestedLimit)
                ? Math.max(1, Math.min(10, Math.trunc(requestedLimit)))
                : 5;

            let rows = [];
            try {
                rows = await DatabaseManager.getLockdownHistory(interaction.guild.id, limit);
            } catch (err) {
                return sendWarningReply(interaction, 'History Unavailable', 'Unable to load manual lockdown history.');
            }

            if (!Array.isArray(rows) || rows.length === 0) {
                return sendSuccessReply(interaction, 'Lockdown History', 'No manual lockdown actions recorded yet.');
            }

            const lines = rows.map((row) => {
                const action = String(row.action_type || '').toUpperCase();
                const caseId = String(row.case_id || 'N/A');
                const moderatorName = String(row.moderator_name || 'Unknown');
                const reason = String(row.reason || 'No reason provided');
                const timestamp = row.created_at ? Math.floor(Number(row.created_at) / 1000) : null;
                const timeLabel = timestamp ? `<t:${timestamp}:R>` : 'Unknown time';
                return `• ${action} | ${timeLabel}\n  Case: \`${caseId}\` | By: ${moderatorName}\n  Reason: ${reason}`;
            });

            return sendSuccessReply(
                interaction,
                'Lockdown History',
                lines.join('\n')
            );
        }

        const status = AntiRaid.getStatus(interaction.guild.id);
        if (!status.active) {
            return sendSuccessReply(interaction, 'Lockdown Status', 'Anti-raid lockdown is currently disabled.');
        }

        return sendSuccessReply(
            interaction,
            'Lockdown Status',
            `Active: ✅\nManual: ${status.manual ? 'Yes' : 'No'}\nReason: ${status.reason || 'Unknown'}\nStarted: <t:${Math.floor((status.startedAt || Date.now()) / 1000)}:R>`
        );
    }
};