const {
    EmbedBuilder,
    AttachmentBuilder,
    PermissionFlagsBits
} = require('discord.js');
const {
    CHANNELS: { ticketCategoryId, ticketLogChannelId },
    ROLES: { supportTeamRoleId }
} = require('../Config/constants');
const MySQLDatabaseManager = require('./MySQLDatabaseManager');

const ACTIVE_TICKET_STATUSES = new Set(['open', 'claimed', 'waiting_user', 'waiting_staff']);
const TICKET_CHANNEL_DELETE_DELAY_MS = 5000;
const TICKET_CHANNEL_DELETE_JOB_TYPE = 'ticket.cleanup_channel_delete';

function normalizeTicketStatus(status) {
    const normalized = String(status || '').trim().toLowerCase();
    if (ACTIVE_TICKET_STATUSES.has(normalized) || normalized === 'closed') {
        return normalized;
    }
    return 'open';
}

function getTicketStatusMeta(status) {
    switch (normalizeTicketStatus(status)) {
        case 'claimed':
            return { label: 'Claimed', emoji: '🟡', color: 0xF1C40F };
        case 'waiting_user':
            return { label: 'Waiting on User', emoji: '🟣', color: 0x9B59B6 };
        case 'waiting_staff':
            return { label: 'Waiting on Staff', emoji: '🔵', color: 0x3498DB };
        case 'closed':
            return { label: 'Closed', emoji: '🔴', color: 0xE74C3C };
        case 'open':
        default:
            return { label: 'Open', emoji: '🟢', color: 0x2ECC71 };
    }
}

function getTicketCategoryLabel(ticketData) {
    if (ticketData?.categoryLabel) {
        return ticketData.categoryLabel;
    }

    const legacyPriority = String(ticketData?.priority || '').trim().toLowerCase();
    if (legacyPriority === 'high') return 'High Priority';
    if (legacyPriority === 'medium') return 'Medium Priority';
    if (legacyPriority === 'low') return 'Low Priority';
    return 'Other';
}

function isTicketChannel(channel) {
    return Boolean(channel && channel.parentId === ticketCategoryId);
}

async function getTicketRecordByChannelId(channelId) {
    const normalizedChannelId = String(channelId || '').trim();
    if (!normalizedChannelId) return null;
    return MySQLDatabaseManager.getTicket(normalizedChannelId).catch(() => null);
}

async function getTicketRecordForChannel(channel) {
    if (!channel || !isTicketChannel(channel)) return null;
    return getTicketRecordByChannelId(channel.id);
}

function hasSupportOrAdmin(member) {
    return Boolean(
        member
        && (
            member.roles?.cache?.has(supportTeamRoleId)
            || member.permissions?.has(PermissionFlagsBits.Administrator)
        )
    );
}

function getTicketChannelBaseName(name) {
    return String(name || '')
        .replace(/\s+-\s+👤\s+.+$/u, '')
        .trim();
}

async function updateTicketChannelAssigneeName(channel, assigneeLabel) {
    if (!channel) return;
    const baseName = getTicketChannelBaseName(channel.name);
    const cleanLabel = String(assigneeLabel || '').trim();
    const nextName = cleanLabel
        ? `${baseName} - 👤 ${cleanLabel}`.slice(0, 95)
        : baseName.slice(0, 95);

    if (nextName && nextName !== channel.name) {
        await channel.setName(nextName).catch(() => { });
    }
}

async function buildTicketTranscript(channel, ticketData, closedByUser, closeReason, closeSource) {
    const closedByLabel = closedByUser?.tag || closedByUser?.username || closedByUser?.id || 'Unknown';
    const assigneeLabel = ticketData.claimedByName || ticketData.claimedBy || 'Unassigned';
    const statusMeta = getTicketStatusMeta(ticketData.status);
    const categoryLabel = getTicketCategoryLabel(ticketData);

    let transcript = `📋 Ticket Transcript - ${channel.name}\n`;
    transcript += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    transcript += `🎫 Ticket Information:\n`;
    transcript += `   • Ticket Owner: ${ticketData.userName || 'Unknown'} (${ticketData.userId || 'N/A'})\n`;
    transcript += `   • Created: ${ticketData.createdAt ? new Date(ticketData.createdAt).toLocaleString() : 'Unknown'}\n`;
    transcript += `   • Closed: ${new Date().toLocaleString()}\n`;
    transcript += `   • Closed By: ${closedByLabel} (${closedByUser?.id || 'N/A'})\n`;
    transcript += `   • Close Source: ${closeSource || 'manual'}\n`;
    transcript += `   • Close Reason: ${closeReason || 'No reason provided'}\n`;
    transcript += `   • Category: ${categoryLabel}\n`;
    transcript += `   • Status Before Close: ${statusMeta.label}\n`;
    transcript += `   • Assignee: ${assigneeLabel}\n`;
    transcript += `   • Reason: ${ticketData.reason || 'No reason'}\n`;
    transcript += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    transcript += `💬 Message History:\n\n`;

    try {
        const collectedMessages = [];
        let beforeMessageId = null;

        while (true) {
            const options = { limit: 100 };
            if (beforeMessageId) {
                options.before = beforeMessageId;
            }

            const batch = await channel.messages.fetch(options);
            if (!batch || batch.size === 0) {
                break;
            }

            const batchMessages = Array.from(batch.values());
            collectedMessages.push(...batchMessages);
            beforeMessageId = batchMessages[batchMessages.length - 1]?.id || null;

            if (batch.size < 100) {
                break;
            }
        }

        const sortedMessages = collectedMessages.sort((left, right) => left.createdTimestamp - right.createdTimestamp);

        for (const message of sortedMessages) {
            const timestamp = message.createdAt.toLocaleString();
            transcript += `[${timestamp}] ${message.author.tag}:\n`;
            if (message.content) {
                transcript += `   ${message.content}\n`;
            }
            if (message.embeds.length > 0) {
                transcript += `   [Embed: ${message.embeds[0].title || 'No title'}]\n`;
            }
            if (message.attachments.size > 0) {
                message.attachments.forEach((attachment) => {
                    transcript += `   [Attachment: ${attachment.name} - ${attachment.url}]\n`;
                });
            }
            transcript += `\n`;
        }

        transcript += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        transcript += `End of transcript - Total Messages: ${sortedMessages.length}\n`;
    } catch (error) {
        console.error('Error generating ticket transcript:', error);
        transcript += `\n⚠️ Error fetching message history\n`;
    }

    return transcript;
}

async function closeTicketChannel({ client, channel, closedByUser, closeReason, closeSource = 'manual' }) {
    if (!channel) {
        throw new Error('Ticket channel is required');
    }

    const ticketData = await getTicketRecordForChannel(channel);
    if (!ticketData) {
        throw new Error('Ticket record not found for channel');
    }

    const transcript = await buildTicketTranscript(channel, ticketData, closedByUser, closeReason, closeSource);
    const statusMeta = getTicketStatusMeta(ticketData.status);
    const closedByLabel = closedByUser?.tag || closedByUser?.username || closedByUser?.id || 'Unknown';
    const closedAt = Date.now();
    const categoryLabel = getTicketCategoryLabel(ticketData);

    const closingEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('🔒 Ticket Closing')
        .setDescription('This ticket is being closed and will be deleted shortly.')
        .addFields(
            { name: '⏱️ Time Remaining', value: '`5 seconds`', inline: true },
            { name: '💾 Transcript', value: 'Saved to logs', inline: true },
            { name: '📌 Last Status', value: `${statusMeta.emoji} ${statusMeta.label}`, inline: true },
            { name: '👤 Assignee', value: ticketData.claimedByName || ticketData.claimedBy || 'Unassigned', inline: true },
            { name: '🔒 Closed By', value: closedByLabel, inline: true },
            { name: '📝 Close Reason', value: `\`\`\`${closeReason || 'No reason provided'}\`\`\``, inline: false }
        )
        .setFooter({ text: 'Ticket lifecycle manager' })
        .setTimestamp(new Date(closedAt));

    await channel.send({ embeds: [closingEmbed] }).catch((error) => {
        console.error('[TicketLifecycle] Failed to send closing embed:', error.message);
    });

    const transcriptBuffer = Buffer.from(transcript, 'utf-8');
    const attachmentName = `transcript-${channel.name}-${closedAt}.txt`;

    const logChannel = channel.guild.channels.cache.get(ticketLogChannelId);
    if (logChannel) {
        const logEmbed = new EmbedBuilder()
            .setColor(0xF04747)
            .setTitle('🔒 Ticket Closed & Archived')
            .setDescription('The ticket lifecycle manager archived this ticket and attached the transcript below.')
            .addFields(
                { name: '🎫 Ticket', value: `\`${channel.name}\``, inline: false },
                { name: '👤 Ticket Owner', value: `${ticketData.userName || 'Unknown'}\n\`${ticketData.userId || 'N/A'}\``, inline: true },
                { name: '👥 Assignee', value: ticketData.claimedByName || ticketData.claimedBy || 'Unassigned', inline: true },
                { name: '🗂️ Category', value: categoryLabel, inline: true },
                { name: '📍 Previous Status', value: `${statusMeta.emoji} ${statusMeta.label}`, inline: true },
                { name: '🔒 Closed By', value: `${closedByLabel}\n\`${closedByUser?.id || 'N/A'}\``, inline: true },
                { name: '📝 Close Reason', value: `\`\`\`${closeReason || 'No reason provided'}\`\`\``, inline: false },
                { name: '🕐 Opened', value: ticketData.createdAt ? `<t:${Math.floor(Number(ticketData.createdAt) / 1000)}:F>` : 'Unknown', inline: true },
                { name: '🔒 Closed', value: `<t:${Math.floor(closedAt / 1000)}:F>`, inline: true },
                { name: '📦 Source', value: closeSource, inline: true }
            )
            .setFooter({ text: 'Full transcript attached below' })
            .setTimestamp(new Date(closedAt));

        await logChannel.send({
            embeds: [logEmbed],
            files: [new AttachmentBuilder(Buffer.from(transcriptBuffer), { name: attachmentName })]
        }).catch((error) => {
            console.error('[TicketLifecycle] Failed to send archive log:', error.message);
        });
    }

    if (ticketData.userId) {
        const owner = await client.users.fetch(ticketData.userId).catch(() => null);
        if (owner) {
            const ownerEmbed = new EmbedBuilder()
                .setColor(0xF04747)
                .setTitle('🎫 Your Ticket Was Closed')
                .setDescription('Your support ticket was closed. A transcript summary is attached so you can keep a record of the conversation.')
                .addFields(
                    { name: '👥 Assignee', value: ticketData.claimedByName || ticketData.claimedBy || 'Unassigned', inline: true },
                    { name: '🔒 Closed By', value: closedByLabel, inline: true },
                    { name: '📝 Close Reason', value: closeReason || 'No reason provided', inline: false }
                )
                .setTimestamp(new Date(closedAt));

            await owner.send({
                embeds: [ownerEmbed],
                files: [new AttachmentBuilder(Buffer.from(transcriptBuffer), { name: attachmentName })]
            }).catch(() => { });
        }
    }

    const persisted = await MySQLDatabaseManager.updateTicket(channel.id, {
        status: 'closed',
        closedAt,
        closedBy: closedByUser?.id || null,
        closedByName: closedByLabel,
        closeReason: closeReason || 'No reason provided',
        transcript,
        transcriptCreatedAt: closedAt
    });
    if (!persisted) {
        throw new Error('Failed to persist ticket closure state');
    }

    await MySQLDatabaseManager.enqueueJob(
        TICKET_CHANNEL_DELETE_JOB_TYPE,
        { channelId: channel.id },
        closedAt + TICKET_CHANNEL_DELETE_DELAY_MS,
        5
    ).catch(() => null);

    setTimeout(async () => {
        await deleteTicketChannelIfClosed(client, channel.id).catch((error) => {
            console.error('[TicketLifecycle] Failed to delete ticket channel:', error.message);
        });
    }, TICKET_CHANNEL_DELETE_DELAY_MS);

    return { ticketData, transcript, closedAt };
}

async function deleteTicketChannelIfClosed(client, channelId) {
    if (!client || !channelId) {
        return { ok: false, code: 'invalid_input' };
    }

    const ticketData = await getTicketRecordByChannelId(channelId);
    if (!ticketData) {
        return { ok: false, code: 'ticket_not_found' };
    }

    if (normalizeTicketStatus(ticketData.status) !== 'closed') {
        return { ok: false, code: 'ticket_not_closed' };
    }

    const channel = client.channels?.cache?.get(channelId) || await client.channels?.fetch?.(channelId).catch(() => null);
    if (!channel) {
        return { ok: true, code: 'channel_missing' };
    }

    if (!isTicketChannel(channel)) {
        return { ok: false, code: 'channel_not_ticket_category' };
    }

    await channel.delete().catch((error) => {
        throw new Error(error?.message || 'Channel deletion failed');
    });

    return { ok: true, code: 'channel_deleted' };
}

async function syncTicketConversationState(message) {
    if (!message || !message.channel || message.author?.bot || !isTicketChannel(message.channel)) {
        return false;
    }

    const ticket = await MySQLDatabaseManager.getTicket(message.channel.id).catch(() => null);
    if (!ticket || normalizeTicketStatus(ticket.status) === 'closed') {
        return false;
    }

    const member = message.member || await message.guild?.members?.fetch(message.author.id).catch(() => null);
    const isOwner = Boolean(ticket.userId && ticket.userId === message.author.id);
    const isSupport = hasSupportOrAdmin(member);

    if (!isOwner && !isSupport) {
        return false;
    }

    const updates = {};
    if (isSupport) {
        updates.status = 'waiting_user';
        if (!ticket.claimedBy || String(ticket.claimedBy) !== String(message.author.id)) {
            updates.claimedBy = message.author.id;
            updates.claimedByName = message.author.tag;
            await updateTicketChannelAssigneeName(message.channel, message.author.username);
        } else if (!ticket.claimedByName) {
            updates.claimedByName = message.author.tag;
        }
    } else if (isOwner) {
        updates.status = ticket.claimedBy ? 'waiting_staff' : 'open';
    }

    if (!updates.status) {
        return false;
    }

    if (
        normalizeTicketStatus(ticket.status) === updates.status
        && updates.claimedBy === undefined
        && updates.claimedByName === undefined
    ) {
        return false;
    }

    await MySQLDatabaseManager.updateTicket(message.channel.id, updates).catch(() => false);
    return true;
}

module.exports = {
    ACTIVE_TICKET_STATUSES,
    closeTicketChannel,
    deleteTicketChannelIfClosed,
    getTicketRecordByChannelId,
    getTicketRecordForChannel,
    getTicketChannelBaseName,
    getTicketStatusMeta,
    hasSupportOrAdmin,
    isTicketChannel,
    normalizeTicketStatus,
    syncTicketConversationState,
    updateTicketChannelAssigneeName
};