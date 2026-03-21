const MySQLDatabaseManager = require('../../Functions/MySQLDatabaseManager');
const { EmbedBuilder } = require('discord.js');
const { SlashCommandBuilder } = require('@discordjs/builders');
const { ROLES: { administratorRoleId: adminRoleId } } = require('../../Config/constants');

function parseMetadataJson(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    try {
        return JSON.parse(value);
    } catch (_) {
        return null;
    }
}

function resolveTimestamp(value) {
    if (!value) return null;
    if (value instanceof Date) return value;

    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
        const ms = numeric > 10_000_000_000 ? numeric : numeric * 1000;
        const fromNumeric = new Date(ms);
        if (!Number.isNaN(fromNumeric.getTime())) return fromNumeric;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function extractViolationSummary(violation) {
    const metadata = parseMetadataJson(violation?.metadata_json);
    const firstSignal = Array.isArray(metadata?.signals) ? metadata.signals[0] : null;

    const caseId = String(
        metadata?.caseId
        || metadata?.case_id
        || violation?.case_id
        || violation?.id
        || 'N/A'
    );

    const reason = String(
        firstSignal?.reason
        || violation?.violation_reason
        || violation?.reason
        || violation?.violation_type
        || 'N/A'
    );

    const action = String(
        violation?.action_taken
        || metadata?.appliedAction
        || 'N/A'
    );

    const timestamp = resolveTimestamp(violation?.timestamp) || new Date();

    return {
        caseId,
        reason,
        action,
        timestamp,
        type: String(violation?.violation_type || firstSignal?.type || 'unknown')
    };
}

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

                warnings.slice(0, 15).forEach((warning) => {
                    const summary = extractViolationSummary(warning);
                    embed.addFields({
                        name: `Case: ${summary.caseId}`,
                        value: `Type: ${summary.type}\nReason: ${summary.reason}\nAction: ${summary.action}\nDate: ${summary.timestamp.toLocaleString()}`,
                        inline: false
                    });
                });

                if (warnings.length > 15) {
                    embed.setFooter({ text: `Showing 15 of ${warnings.length} warnings. Use /automodwarns clearone to remove individual entries.` });
                }

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
                const normalizedCaseId = String(caseId || '').trim();
                const idCandidate = Number.parseInt(normalizedCaseId, 10);
                const result = await MySQLDatabaseManager.connection.query(
                    `DELETE FROM automod_violations
                     WHERE user_id = ?
                     AND (
                        id = ?
                        OR JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.caseId')) = ?
                        OR JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.case_id')) = ?
                     )`,
                    [userId, Number.isNaN(idCandidate) ? -1 : idCandidate, normalizedCaseId, normalizedCaseId]
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