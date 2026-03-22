const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits, AttachmentBuilder } = require('discord.js');
const ServerBackupManager = require('../../Functions/ServerBackupManager');

const MAX_DISCORD_FILE_BYTES = 8 * 1024 * 1024;

function formatBytes(bytes) {
    const size = Math.max(0, Number(bytes) || 0);
    if (size < 1024) return `${size} B`;
    const kb = size / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    return `${(mb / 1024).toFixed(1)} GB`;
}

function formatTimestamp(timestamp) {
    if (!timestamp) return 'Unknown';
    return `<t:${Math.floor(Number(timestamp) / 1000)}:F>\n<t:${Math.floor(Number(timestamp) / 1000)}:R>`;
}

function getIncludeOptions(interaction) {
    return ServerBackupManager.normalizeBackupIncludes({
        settings: interaction.options.getBoolean('include_settings'),
        roles: interaction.options.getBoolean('include_roles'),
        channels: interaction.options.getBoolean('include_channels'),
        emojis: interaction.options.getBoolean('include_emojis'),
        stickers: interaction.options.getBoolean('include_stickers'),
        permissionOverwrites: interaction.options.getBoolean('include_overwrites')
    });
}

function getRestoreExclusions(interaction) {
    return ServerBackupManager.normalizeRestoreExclusions({
        roleNames: interaction.options.getString('exclude_roles'),
        channelNames: interaction.options.getString('exclude_channels')
    });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('serverbackup')
        .setDescription('Create and access server structure backups.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand((subcommand) =>
            subcommand
                .setName('create')
                .setDescription('Create a fresh backup of this server.')
                .addBooleanOption((option) =>
                    option
                        .setName('attach')
                        .setDescription('Attach the created backup file if it fits in Discord upload limits.')
                        .setRequired(false)
                )
                .addStringOption((option) =>
                    option
                        .setName('label')
                        .setDescription('Optional short label for this snapshot.')
                        .setRequired(false)
                        .setMaxLength(80)
                )
                .addStringOption((option) =>
                    option
                        .setName('notes')
                        .setDescription('Optional notes about why this snapshot was created.')
                        .setRequired(false)
                        .setMaxLength(500)
                )
                .addBooleanOption((option) => option.setName('include_settings').setDescription('Include guild settings in the backup.').setRequired(false))
                .addBooleanOption((option) => option.setName('include_roles').setDescription('Include roles in the backup.').setRequired(false))
                .addBooleanOption((option) => option.setName('include_channels').setDescription('Include channels in the backup.').setRequired(false))
                .addBooleanOption((option) => option.setName('include_emojis').setDescription('Include emojis in the backup.').setRequired(false))
                .addBooleanOption((option) => option.setName('include_stickers').setDescription('Include stickers in the backup.').setRequired(false))
                .addBooleanOption((option) => option.setName('include_overwrites').setDescription('Include permission overwrites in the backup.').setRequired(false))
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('list')
                .setDescription('List recent backups for this server.')
                .addIntegerOption((option) =>
                    option
                        .setName('limit')
                        .setDescription('How many backups to show.')
                        .setRequired(false)
                        .setMinValue(1)
                        .setMaxValue(10)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('latest')
                .setDescription('Download the most recent backup for this server if it fits.')
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('preview')
                .setDescription('Compare the latest backup against the current server state.')
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('inspect')
                .setDescription('Inspect and validate the latest backup for this server.')
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('preflight')
                .setDescription('Assess restore risk against the current server state using the latest backup.')
                .addStringOption((option) =>
                    option
                        .setName('exclude_roles')
                        .setDescription('Comma-separated role names to exclude from the restore scope.')
                        .setRequired(false)
                        .setMaxLength(400)
                )
                .addStringOption((option) =>
                    option
                        .setName('exclude_channels')
                        .setDescription('Comma-separated channel names to exclude from the restore scope.')
                        .setRequired(false)
                        .setMaxLength(400)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('timeline')
                .setDescription('Show recent changes between adjacent server backup snapshots.')
                .addIntegerOption((option) =>
                    option
                        .setName('limit')
                        .setDescription('How many timeline entries to show.')
                        .setRequired(false)
                        .setMinValue(1)
                        .setMaxValue(5)
                )
        ),
    category: 'management',
    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'list') {
            const limit = interaction.options.getInteger('limit') || 5;
            const files = ServerBackupManager.listServerBackupFiles({ guildId: interaction.guildId }).slice(0, limit);

            if (!files.length) {
                return interaction.reply({ content: 'No server backups exist for this guild yet.', flags: MessageFlags.Ephemeral });
            }

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('Server Backups')
                .setDescription(files.map((file, index) => (
                    `**${index + 1}. ${file.name}**\n${formatTimestamp(file.createdAt)}\nSize: **${formatBytes(file.size)}**`
                )).join('\n\n'))
                .setFooter({ text: `Guild: ${interaction.guild.name}` })
                .setTimestamp();

            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        if (subcommand === 'latest') {
            const latest = ServerBackupManager.listServerBackupFiles({ guildId: interaction.guildId })[0];
            if (!latest) {
                return interaction.reply({ content: 'No server backups exist for this guild yet.', flags: MessageFlags.Ephemeral });
            }

            const filePath = ServerBackupManager.getServerBackupFilePath(latest.name);
            if (!filePath) {
                return interaction.reply({ content: 'The latest backup file could not be resolved safely.', flags: MessageFlags.Ephemeral });
            }

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('Latest Server Backup')
                .addFields(
                    { name: 'File', value: latest.name, inline: false },
                    { name: 'Created', value: formatTimestamp(latest.createdAt), inline: true },
                    { name: 'Size', value: formatBytes(latest.size), inline: true }
                )
                .setTimestamp();

            if (latest.size > MAX_DISCORD_FILE_BYTES) {
                embed.addFields({
                    name: 'Attachment',
                    value: 'This backup is too large to attach in Discord. Download it from the owner panel instead.',
                    inline: false
                });
                return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
            }

            return interaction.reply({
                embeds: [embed],
                files: [new AttachmentBuilder(filePath, { name: latest.name })],
                flags: MessageFlags.Ephemeral
            });
        }

        if (subcommand === 'preview') {
            const latest = ServerBackupManager.listServerBackupFiles({ guildId: interaction.guildId })[0];
            if (!latest) {
                return interaction.reply({ content: 'No server backups exist for this guild yet.', flags: MessageFlags.Ephemeral });
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            try {
                const sourcePayload = ServerBackupManager.readServerBackupFile(latest.name);
                const livePayload = await ServerBackupManager.buildGuildBackupPayload(interaction.guild, {
                    trigger: 'preview',
                    includes: sourcePayload?.metadata?.includes
                });
                const diff = ServerBackupManager.buildSnapshotDiff(sourcePayload, livePayload, {
                    sourceLabel: latest.name,
                    targetLabel: 'Current Server'
                });

                const embed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('Latest Backup Preview')
                    .setDescription(`Comparing **${latest.name}** against the current server state.`)
                    .addFields(
                        { name: 'Settings', value: `Changed: **${diff.summary.settingsChanged}**`, inline: true },
                        { name: 'Roles', value: `+ **${diff.summary.rolesAdded}**\n~ **${diff.summary.rolesChanged}**\n- **${diff.summary.rolesRemoved}**`, inline: true },
                        { name: 'Channels', value: `+ **${diff.summary.channelsAdded}**\n~ **${diff.summary.channelsChanged}**\n- **${diff.summary.channelsRemoved}**`, inline: true },
                        { name: 'Emojis', value: `+ **${diff.summary.emojisAdded}**\n~ **${diff.summary.emojisChanged}**\n- **${diff.summary.emojisRemoved}**`, inline: true },
                        { name: 'Stickers', value: `+ **${diff.summary.stickersAdded}**\n~ **${diff.summary.stickersChanged}**\n- **${diff.summary.stickersRemoved}**`, inline: true },
                        { name: 'Changed Settings', value: (diff.details.settingsChanged || []).slice(0, 10).join('\n') || 'None', inline: false }
                    )
                    .setTimestamp();

                return interaction.editReply({ embeds: [embed] });
            } catch (error) {
                console.error('Server backup preview failed:', error);
                return interaction.editReply({ content: 'Failed to preview the latest server backup.' });
            }
        }

        if (subcommand === 'inspect') {
            const latest = ServerBackupManager.listServerBackupFiles({ guildId: interaction.guildId })[0];
            if (!latest) {
                return interaction.reply({ content: 'No server backups exist for this guild yet.', flags: MessageFlags.Ephemeral });
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            try {
                const inspection = ServerBackupManager.inspectServerBackupFile(latest.name);
                const validation = inspection.validation || {};
                const summary = inspection.summary || {};
                const manifest = inspection.manifest || {};
                const statusText = validation.valid ? 'Healthy' : 'Issues Found';
                const includesText = Object.entries(summary.includes || {})
                    .filter(([, enabled]) => enabled)
                    .map(([key]) => key.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase()))
                    .join(', ') || 'Nothing';

                const embed = new EmbedBuilder()
                    .setColor(validation.valid ? 0x57F287 : 0xFEE75C)
                    .setTitle('Server Backup Inspection')
                    .setDescription(`Inspection for **${latest.name}**`)
                    .addFields(
                        { name: 'Status', value: statusText, inline: true },
                        { name: 'Version', value: String(inspection.version || 0), inline: true },
                        { name: 'Size', value: formatBytes(inspection.file?.size || 0), inline: true },
                        { name: 'Created', value: formatTimestamp(inspection.file?.createdAt), inline: true },
                        { name: 'Guild', value: inspection.guild?.name || interaction.guild.name, inline: true },
                        { name: 'Manifest', value: manifest.available ? `${manifest.signed ? 'Signed' : 'Unsigned'} • ${manifest.valid ? 'Valid' : 'Review'}` : 'Not generated', inline: true },
                        { name: 'Included', value: includesText, inline: false },
                        { name: 'Summary', value: `Roles: **${summary.roles || 0}**\nChannels: **${summary.channels || 0}**\nEmojis: **${summary.emojis || 0}**\nStickers: **${summary.stickers || 0}**`, inline: false },
                        { name: 'Warnings', value: (validation.warnings || []).slice(0, 6).join('\n') || 'None', inline: false },
                        { name: 'Errors', value: (validation.errors || []).slice(0, 6).join('\n') || 'None', inline: false }
                    )
                    .setTimestamp();

                return interaction.editReply({ embeds: [embed] });
            } catch (error) {
                console.error('Server backup inspection failed:', error);
                return interaction.editReply({ content: 'Failed to inspect the latest server backup.' });
            }
        }

        if (subcommand === 'preflight') {
            const latest = ServerBackupManager.listServerBackupFiles({ guildId: interaction.guildId })[0];
            if (!latest) {
                return interaction.reply({ content: 'No server backups exist for this guild yet.', flags: MessageFlags.Ephemeral });
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            try {
                const sourcePayload = ServerBackupManager.readServerBackupFile(latest.name);
                const exclusions = getRestoreExclusions(interaction);
                const scopedPayload = ServerBackupManager.applyRestoreExclusionsToPayload(sourcePayload, exclusions);
                const livePayload = await ServerBackupManager.buildGuildBackupPayload(interaction.guild, {
                    trigger: 'preflight',
                    includes: sourcePayload?.metadata?.includes
                });
                const preflight = ServerBackupManager.buildRestorePreflightReport(scopedPayload, livePayload);
                const exclusionSummary = [];
                if (exclusions.roleNames.length) exclusionSummary.push(`Roles excluded: **${exclusions.roleNames.length}**`);
                if (exclusions.channelNames.length) exclusionSummary.push(`Channels excluded: **${exclusions.channelNames.length}**`);

                const colorMap = { low: 0x57F287, medium: 0xFEE75C, high: 0xFAA61A, critical: 0xED4245 };
                const embed = new EmbedBuilder()
                    .setColor(colorMap[preflight.level] || 0x5865F2)
                    .setTitle('Server Backup Restore Preflight')
                    .setDescription(`Risk assessment for restoring **${latest.name}** into the current server state.`)
                    .addFields(
                        { name: 'Risk Level', value: preflight.level.toUpperCase(), inline: true },
                        { name: 'Risk Score', value: String(preflight.score), inline: true },
                        { name: 'Validation', value: preflight.validation?.valid ? 'Healthy' : 'Needs review', inline: true },
                        {
                            name: 'Diff Summary',
                            value: `Settings: **${preflight.diffSummary?.settingsChanged || 0}**\nRoles +/~/-: **${preflight.diffSummary?.rolesAdded || 0}/${preflight.diffSummary?.rolesChanged || 0}/${preflight.diffSummary?.rolesRemoved || 0}**\nChannels +/~/-: **${preflight.diffSummary?.channelsAdded || 0}/${preflight.diffSummary?.channelsChanged || 0}/${preflight.diffSummary?.channelsRemoved || 0}**`,
                            inline: false
                        },
                        { name: 'Scoped Exclusions', value: exclusionSummary.join('\n') || 'None', inline: false },
                        { name: 'Reasons', value: (preflight.reasons || []).join('\n') || 'No notable risks detected.', inline: false }
                    )
                    .setTimestamp();

                return interaction.editReply({ embeds: [embed] });
            } catch (error) {
                console.error('Server backup preflight failed:', error);
                return interaction.editReply({ content: 'Failed to build restore preflight.' });
            }
        }

        if (subcommand === 'timeline') {
            const limit = interaction.options.getInteger('limit') || 4;
            const timeline = ServerBackupManager.buildBackupTimeline({ guildId: interaction.guildId, limit: limit + 1 }).slice(0, limit);

            if (!timeline.length) {
                return interaction.reply({ content: 'Not enough backups exist yet to build a timeline.', flags: MessageFlags.Ephemeral });
            }

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('Server Backup Timeline')
                .setDescription(timeline.map((entry, index) => {
                    const currentName = entry.currentLabel || entry.currentFile;
                    const previousName = entry.previousLabel || entry.previousFile;
                    return `**${index + 1}. ${currentName}**\nCompared to: ${previousName}\nChanges: **${entry.totalChanges || 0}**\nRoles +/~/-: **${entry.summary?.rolesAdded || 0}/${entry.summary?.rolesChanged || 0}/${entry.summary?.rolesRemoved || 0}**\nChannels +/~/-: **${entry.summary?.channelsAdded || 0}/${entry.summary?.channelsChanged || 0}/${entry.summary?.channelsRemoved || 0}**`;
                }).join('\n\n'))
                .setFooter({ text: `Guild: ${interaction.guild.name}` })
                .setTimestamp();

            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const includes = getIncludeOptions(interaction);
            const label = interaction.options.getString('label');
            const notes = interaction.options.getString('notes');
            const result = await ServerBackupManager.createServerBackupFromGuild(interaction.guild, {
                trigger: `command:${interaction.user.id}`,
                includes,
                label,
                notes,
                requestedBy: { id: interaction.user.id, tag: interaction.user.tag, source: 'command' }
            });
            const shouldAttach = Boolean(interaction.options.getBoolean('attach'));

            const embed = new EmbedBuilder()
                .setColor(0x57F287)
                .setTitle('Server Backup Created')
                .setDescription(`A new backup was created for **${interaction.guild.name}**.`)
                .addFields(
                    { name: 'File', value: result.fileName, inline: false },
                    { name: 'Channels', value: String(result.summary.channelCount || 0), inline: true },
                    { name: 'Roles', value: String(result.summary.roleCount || 0), inline: true },
                    { name: 'Members', value: String(result.summary.memberCount || 0), inline: true },
                    { name: 'Emojis', value: String(result.summary.emojiCount || 0), inline: true },
                    { name: 'Stickers', value: String(result.summary.stickerCount || 0), inline: true },
                    { name: 'Size', value: formatBytes(result.size), inline: true },
                    {
                        name: 'Included',
                        value: Object.entries(result.includes || {})
                            .filter(([, enabled]) => enabled)
                            .map(([key]) => key.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase()))
                            .join(', ') || 'Nothing',
                        inline: false
                    },
                    { name: 'Label', value: result.label || 'None', inline: false },
                    { name: 'Notes', value: result.notes || 'None', inline: false },
                    { name: 'Manifest', value: result.manifest?.signed ? 'Signed manifest created' : 'Unsigned manifest created', inline: false }
                )
                .setFooter({ text: `Requested by ${interaction.user.tag}` })
                .setTimestamp();

            if (!shouldAttach) {
                return interaction.editReply({ embeds: [embed] });
            }

            if (result.size > MAX_DISCORD_FILE_BYTES) {
                embed.addFields({
                    name: 'Attachment',
                    value: 'The backup was created, but it is too large to attach here. Use the owner panel to download it.',
                    inline: false
                });
                return interaction.editReply({ embeds: [embed] });
            }

            const files = [new AttachmentBuilder(result.filePath, { name: result.fileName })];
            const manifestPath = ServerBackupManager.getServerBackupManifestPath(result.fileName);
            if (manifestPath) {
                files.push(new AttachmentBuilder(manifestPath, { name: `${result.fileName}.manifest.json` }));
            }

            return interaction.editReply({
                embeds: [embed],
                files
            });
        } catch (error) {
            console.error('Server backup command failed:', error);
            return interaction.editReply({ content: 'Failed to create the server backup.' });
        }
    }
};