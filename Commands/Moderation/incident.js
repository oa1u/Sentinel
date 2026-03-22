const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');
const { CHANNELS } = require('../../Config/constants');
const { sendErrorReply, sendSuccessReply, sendInfoReply, sendWarningReply } = require('../../Functions/EmbedBuilders');

function normalizeActionType(input) {
    const normalized = String(input || '').trim().toUpperCase();
    if (['WARN', 'TIMEOUT', 'BAN', 'KICK', 'UNBAN', 'OTHER'].includes(normalized)) {
        return normalized;
    }
    return 'OTHER';
}

function truncate(value, max = 1024) {
    const text = String(value || '');
    if (text.length <= max) return text;
    return `${text.slice(0, max - 3)}...`;
}

function formatTimestamp(value) {
    if (!value) return 'Unknown';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown';
    return `<t:${Math.floor(date.getTime() / 1000)}:F>`;
}

function isLikelyImageUrl(value) {
    const url = String(value || '').trim();
    if (!url) return false;
    return /\.(png|jpe?g|gif|webp|bmp|tiff?|svg)(\?.*)?$/i.test(url)
        || /cdn\.discordapp\.com\/attachments\//i.test(url)
        || /media\.discordapp\.net\/attachments\//i.test(url)
        || /i\.imgur\.com\//i.test(url);
}

function isImageContentType(value) {
    const contentType = String(value || '').trim().toLowerCase();
    return contentType.startsWith('image/');
}

function getIncidentImageUrl({ attachmentUrl, proofUrl }) {
    if (attachmentUrl && isLikelyImageUrl(attachmentUrl)) return attachmentUrl;
    if (proofUrl && isLikelyImageUrl(proofUrl)) return proofUrl;
    return null;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('incident')
        .setDescription('Create and retrieve moderation incident proof linked to case IDs')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addSubcommand((subcommand) =>
            subcommand
                .setName('create')
                .setDescription('Create or update an incident proof record for a moderation case')
                .addStringOption((option) =>
                    option
                        .setName('caseid')
                        .setDescription('Moderation case ID (e.g., WARN-ABC12345)')
                        .setRequired(true)
                )
                .addUserOption((option) =>
                    option
                        .setName('user')
                        .setDescription('User this incident belongs to')
                        .setRequired(true)
                )
                .addStringOption((option) =>
                    option
                        .setName('action')
                        .setDescription('Moderation action type')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Warn', value: 'WARN' },
                            { name: 'Timeout', value: 'TIMEOUT' },
                            { name: 'Ban', value: 'BAN' },
                            { name: 'Kick', value: 'KICK' },
                            { name: 'Unban', value: 'UNBAN' },
                            { name: 'Other', value: 'OTHER' }
                        )
                )
                .addStringOption((option) =>
                    option
                        .setName('reason')
                        .setDescription('Moderation reason summary')
                        .setRequired(true)
                        .setMaxLength(1000)
                )
                .addStringOption((option) =>
                    option
                        .setName('proof')
                        .setDescription('Proof details (what happened and why action was taken)')
                        .setRequired(true)
                        .setMaxLength(4000)
                )
                .addAttachmentOption((option) =>
                    option
                        .setName('attachment')
                        .setDescription('Screenshot or file proof')
                        .setRequired(false)
                )
                .addStringOption((option) =>
                    option
                        .setName('proofurl')
                        .setDescription('External proof URL')
                        .setRequired(false)
                )
                .addStringOption((option) =>
                    option
                        .setName('messagelink')
                        .setDescription('Discord message link used as evidence')
                        .setRequired(false)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('view')
                .setDescription('View incident proof for a case ID')
                .addStringOption((option) =>
                    option
                        .setName('caseid')
                        .setDescription('Moderation case ID')
                        .setRequired(true)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('list')
                .setDescription('List recent incident proof records for a user')
                .addUserOption((option) =>
                    option
                        .setName('user')
                        .setDescription('Target user')
                        .setRequired(true)
                )
                .addIntegerOption((option) =>
                    option
                        .setName('limit')
                        .setDescription('How many recent incidents to return (1-20)')
                        .setRequired(false)
                        .setMinValue(1)
                        .setMaxValue(20)
                )
        ),
    category: 'moderation',

    async execute(interaction) {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'create') {
            const caseId = String(interaction.options.getString('caseid', true) || '').trim().toUpperCase();
            const targetUser = interaction.options.getUser('user', true);
            const actionType = normalizeActionType(interaction.options.getString('action', true));
            const reason = String(interaction.options.getString('reason', true) || '').trim();
            const proofText = String(interaction.options.getString('proof', true) || '').trim();
            const proofUrl = String(interaction.options.getString('proofurl') || '').trim();
            const messageLink = String(interaction.options.getString('messagelink') || '').trim();
            const attachment = interaction.options.getAttachment('attachment');
            const attachmentUrl = String(attachment?.url || '').trim();
            const attachmentName = String(attachment?.name || '').trim() || `incident-${caseId}.png`;
            const attachmentContentType = String(attachment?.contentType || '').trim().toLowerCase();

            if (!caseId) {
                return sendWarningReply(interaction, 'Invalid Case ID', 'Please provide a valid case ID.');
            }

            if (!reason || !proofText) {
                return sendWarningReply(interaction, 'Missing Details', 'Reason and proof details are required.');
            }

            const caseExists = await DatabaseManager.moderationCaseExists(caseId);
            if (!caseExists) {
                return sendWarningReply(
                    interaction,
                    'Case ID Not Found',
                    `No moderation case with ID \`${caseId}\` was found in the moderation ledger.`
                );
            }

            const result = await DatabaseManager.createModerationIncident({
                caseId,
                userId: targetUser.id,
                actionType,
                reason,
                proofText,
                proofUrl: proofUrl || null,
                attachmentUrl: attachmentUrl || null,
                messageLink: messageLink || null,
                moderatorId: interaction.user.id,
                moderatorName: interaction.user.username
            });

            if (!result?.success) {
                return sendErrorReply(
                    interaction,
                    'Incident Save Failed',
                    `Could not save incident record.\nError: ${result?.error || 'Unknown error'}`
                );
            }

            const incidentEmbed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('🧾 Moderation Incident Logged')
                .setDescription('A new incident proof record has been created.')
                .addFields(
                    { name: 'Case ID', value: `\`${caseId}\``, inline: true },
                    { name: 'Action', value: actionType, inline: true },
                    { name: 'User', value: `${targetUser.tag}\n\`${targetUser.id}\``, inline: true },
                    { name: 'Moderator', value: `${interaction.user.tag}\n\`${interaction.user.id}\``, inline: true },
                    { name: 'Reason', value: truncate(reason, 1024), inline: false },
                    { name: 'Proof', value: truncate(proofText, 1024), inline: false }
                )
                .setTimestamp();

            if (proofUrl) {
                incidentEmbed.addFields({ name: 'Proof URL', value: truncate(proofUrl, 1024), inline: false });
            }
            if (attachmentUrl) {
                incidentEmbed.addFields({ name: 'Attachment', value: truncate(attachmentUrl, 1024), inline: false });
            }
            if (messageLink) {
                incidentEmbed.addFields({ name: 'Message Link', value: truncate(messageLink, 1024), inline: false });
            }

            const previewImageUrl = getIncidentImageUrl({ attachmentUrl, proofUrl });

            let incidentPostSummary = '⚠️ Incident channel not configured.';
            const incidentChannelId = String(CHANNELS?.incidentChannelId || '').trim();
            if (incidentChannelId) {
                const incidentChannel = await interaction.guild.channels.fetch(incidentChannelId).catch(() => null);
                if (incidentChannel && incidentChannel.isTextBased()) {
                    const sendPayload = { embeds: [incidentEmbed] };

                    // Upload the provided attachment URL as an actual message file so Discord reliably renders image previews.
                    const canAttachFile = Boolean(attachmentUrl);
                    if (canAttachFile) {
                        sendPayload.files = [{ attachment: attachmentUrl, name: attachmentName }];
                    }

                    const attachmentIsImage = canAttachFile && (isImageContentType(attachmentContentType) || isLikelyImageUrl(attachmentUrl));
                    if (attachmentIsImage) {
                        incidentEmbed.setImage(`attachment://${attachmentName}`);
                    } else if (previewImageUrl) {
                        incidentEmbed.setImage(previewImageUrl);
                    }

                    const posted = await incidentChannel.send(sendPayload).catch(() => null);
                    if (posted?.url) {
                        incidentPostSummary = `✅ Logged in <#${incidentChannelId}>\n${posted.url}`;
                    } else {
                        incidentPostSummary = `✅ Logged in <#${incidentChannelId}>`;
                    }
                } else {
                    incidentPostSummary = `⚠️ Could not access incident channel \`${incidentChannelId}\`.`;
                }
            }

            return sendSuccessReply(
                interaction,
                'Incident Saved',
                `Incident proof saved for case \`${caseId}\`\n` +
                `Action: **${actionType}**\n` +
                `User: ${targetUser}\n` +
                `Attachment: ${attachmentUrl ? '✅' : 'Not provided'}\n` +
                `Proof URL: ${proofUrl ? '✅' : 'Not provided'}\n` +
                `${incidentPostSummary}`
            );
        }

        if (subcommand === 'view') {
            const caseId = String(interaction.options.getString('caseid', true) || '').trim().toUpperCase();
            const incident = await DatabaseManager.getModerationIncidentByCaseId(caseId);

            if (!incident) {
                return sendInfoReply(interaction, 'No Incident Found', `No incident proof found for case \`${caseId}\`.`);
            }

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('📁 Incident Record')
                .addFields(
                    { name: 'Case ID', value: `\`${incident.case_id}\``, inline: true },
                    { name: 'Action', value: String(incident.action_type || 'OTHER'), inline: true },
                    { name: 'User ID', value: String(incident.user_id || 'Unknown'), inline: true },
                    { name: 'Moderator', value: `${incident.moderator_name || 'Unknown'}\n\`${incident.moderator_id || 'N/A'}\``, inline: true },
                    { name: 'Created', value: formatTimestamp(incident.created_at), inline: true },
                    { name: 'Updated', value: formatTimestamp(incident.updated_at), inline: true },
                    { name: 'Reason', value: truncate(incident.reason || 'No reason provided', 1024), inline: false },
                    { name: 'Proof', value: truncate(incident.proof_text || 'No proof text provided', 1024), inline: false }
                )
                .setTimestamp();

            if (incident.proof_url) {
                embed.addFields({ name: 'Proof URL', value: truncate(String(incident.proof_url), 1024), inline: false });
            }
            if (incident.attachment_url) {
                embed.addFields({ name: 'Attachment', value: truncate(String(incident.attachment_url), 1024), inline: false });
            }
            if (incident.message_link) {
                embed.addFields({ name: 'Message Link', value: truncate(String(incident.message_link), 1024), inline: false });
            }

            const imageUrl = getIncidentImageUrl({
                attachmentUrl: incident.attachment_url,
                proofUrl: incident.proof_url
            });
            if (imageUrl) {
                embed.setImage(imageUrl);
            }

            return interaction.editReply({ embeds: [embed] });
        }

        if (subcommand === 'list') {
            const targetUser = interaction.options.getUser('user', true);
            const limit = Number(interaction.options.getInteger('limit') || 10);
            const rows = await DatabaseManager.getModerationIncidentsByUser(targetUser.id, limit);

            if (!rows.length) {
                return sendInfoReply(interaction, 'No Incident Records', `No incident proof records found for ${targetUser}.`);
            }

            const lines = rows.map((row, index) => {
                const created = row.created_at ? `<t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:R>` : 'Unknown';
                return `${index + 1}. \`${row.case_id}\` • **${row.action_type || 'OTHER'}** • ${created}`;
            });

            const embed = new EmbedBuilder()
                .setColor(0x57F287)
                .setTitle('🗂️ Incident Records')
                .setDescription(`Recent incident proof records for ${targetUser}`)
                .addFields({ name: `Latest ${rows.length}`, value: lines.join('\n').slice(0, 3900), inline: false })
                .setTimestamp();

            return interaction.editReply({ embeds: [embed] });
        }

        return sendWarningReply(interaction, 'Unknown Action', 'That incident action is not supported.');
    }
};