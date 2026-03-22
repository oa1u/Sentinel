const { EmbedBuilder, MessageFlags } = require('discord.js');

// Embed builders
// Centralized helpers to create consistent, well-styled Discord embeds used
// across the bot. This keeps message formatting uniform and easy to update.

const EMBED_LIMITS = {
    title: 256,
    description: 4096,
    footer: 2048,
    fieldName: 256,
    fieldValue: 1024,
    maxFields: 25
};

const EMBED_STYLE = {
    error: {
        color: 0xF04747,
        emoji: '❌',
        footer: 'Error occurred • Action not completed'
    },
    success: {
        color: 0x43B581,
        emoji: '✅',
        footer: 'Success • Action completed'
    },
    warning: {
        color: 0xFAA61A,
        emoji: '⚠️',
        footer: 'Warning • Please review'
    },
    info: {
        color: 0x5865F2,
        emoji: 'ℹ️',
        footer: 'Information • For your reference'
    }
};

function normalizeText(value, fallback = '') {
    if (value === null || value === undefined) return fallback;
    return String(value).trim();
}

function trimToLimit(value, limit, fallback = 'N/A') {
    const text = normalizeText(value, fallback);
    if (!text.length) return fallback;
    if (text.length <= limit) return text;
    return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function sanitizeInlineCode(value) {
    const text = normalizeText(value, 'N/A').replace(/`/g, '\\`');
    return trimToLimit(text, EMBED_LIMITS.fieldValue, 'N/A');
}

function sanitizeCodeBlock(value) {
    const text = normalizeText(value, 'No reason provided').replace(/```/g, 'ˋˋˋ');
    const safeBody = trimToLimit(text, EMBED_LIMITS.fieldValue - 6, 'No reason provided');
    return `\`\`\`${safeBody}\`\`\``;
}

function normalizeFields(fields = []) {
    if (!Array.isArray(fields) || fields.length === 0) return [];

    return fields
        .filter((field) => field && typeof field === 'object')
        .slice(0, EMBED_LIMITS.maxFields)
        .map((field) => ({
            name: trimToLimit(field.name, EMBED_LIMITS.fieldName, 'Details'),
            value: trimToLimit(field.value, EMBED_LIMITS.fieldValue, 'N/A'),
            inline: Boolean(field.inline)
        }));
}

function getModerationActionStyle(action = '') {
    const normalized = String(action || '').toLowerCase();
    if (normalized.includes('ban')) return { color: 0xED4245, emoji: '🔨' };
    if (normalized.includes('kick')) return { color: 0xFEE75C, emoji: '👢' };
    if (normalized.includes('warn')) return { color: 0xFAA61A, emoji: '⚠️' };
    if (normalized.includes('timeout')) return { color: 0x5865F2, emoji: '⏱️' };
    if (normalized.includes('slowmode')) return { color: 0x57F287, emoji: '🐢' };
    if (normalized.includes('clear') || normalized.includes('purge')) return { color: 0x57F287, emoji: '🧹' };
    return { color: 0x5865F2, emoji: '⚖️' };
}

function sanitizeActionLabel(action = 'Action') {
    const text = String(action || 'Action')
        .replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\u2600-\u27BF\uFE0F\u200D\s]+/gu, '')
        .trim();
    return trimToLimit(text || 'Action', EMBED_LIMITS.title, 'Action');
}

function createStandardEmbed(style = 'info', title = '', description = '', options = {}) {
    const profile = EMBED_STYLE[style] || EMBED_STYLE.info;
    const safeTitle = trimToLimit(title, EMBED_LIMITS.title, style.toUpperCase());
    const safeDescription = trimToLimit(description, EMBED_LIMITS.description, 'No additional details provided.');

    const embed = new EmbedBuilder()
        .setColor(options.color ?? profile.color)
        .setTitle(`${options.emoji ?? profile.emoji} ${safeTitle}`)
        .setDescription(safeDescription);

    if (options.timestamp !== false) {
        embed.setTimestamp(options.timestamp instanceof Date ? options.timestamp : new Date());
    }

    const footerText = trimToLimit(options.footerText ?? profile.footer, EMBED_LIMITS.footer, profile.footer);
    const footerIconURL = normalizeText(options.footerIconURL, '') || undefined;
    embed.setFooter({ text: footerText, iconURL: footerIconURL });

    if (options.thumbnailURL) {
        embed.setThumbnail(String(options.thumbnailURL));
    }

    if (options.imageURL) {
        embed.setImage(String(options.imageURL));
    }

    const safeFields = normalizeFields(options.fields);
    if (safeFields.length) {
        embed.addFields(safeFields);
    }

    return embed;
}

// Simple templates for error, success, warning and info messages.
function createErrorEmbed(title, description, options = {}) {
    return createStandardEmbed('error', title, description, options);
}

function createSuccessEmbed(title, description, options = {}) {
    return createStandardEmbed('success', title, description, options);
}

function createWarningEmbed(title, description, options = {}) {
    return createStandardEmbed('warning', title, description, options);
}

function createInfoEmbed(title, description, options = {}) {
    return createStandardEmbed('info', title, description, options);
}

// Build a standardized moderation embed for logging actions (ban/kick/timeout/etc.).
function createModerationEmbed(options = {}) {
    const {
        action = 'Action',
        target,
        moderator,
        reason = 'No reason provided',
        caseId,
        duration = null,
        color = 0xFF0000
    } = options;

    const style = getModerationActionStyle(action);
    const resolvedColor = color || style.color;
    const actionLabel = sanitizeActionLabel(action);

    const embed = createInfoEmbed(`${actionLabel} Log`, 'A moderation action has been recorded in the server logs.', {
        emoji: style.emoji,
        color: resolvedColor,
        footerText: 'Moderation • Audit Log'
    });

    embed.setAuthor({ name: 'Moderation Action Logged' });

    if (target) {
        embed.addFields({
            name: '👤 Target User',
            value: `${target.toString()}\n\`${sanitizeInlineCode(target.tag || target.username || 'Unknown')}\`\n\`ID: ${sanitizeInlineCode(target.id)}\``,
            inline: true
        });
    }

    if (moderator) {
        embed.addFields({
            name: '👮 Moderator',
            value: `${moderator.toString()}\n\`${sanitizeInlineCode(moderator.tag || moderator.username || 'Unknown')}\`\n\`ID: ${sanitizeInlineCode(moderator.id)}\``,
            inline: true
        });
    }

    embed.addFields({
        name: '🏷️ Action',
        value: trimToLimit(actionLabel, EMBED_LIMITS.fieldValue, 'Action'),
        inline: true
    });

    embed.addFields({
        name: '📝 Reason',
        value: sanitizeCodeBlock(reason),
        inline: false
    });

    if (caseId) {
        embed.addFields({
            name: '📋 Case ID',
            value: sanitizeInlineCode(caseId),
            inline: true
        });
    }

    if (duration) {
        embed.addFields({
            name: '⏰ Duration',
            value: trimToLimit(duration, EMBED_LIMITS.fieldValue, 'N/A'),
            inline: true
        });
    }

    return embed;
}

// Build the DM that gets sent to users to explain moderation actions.
function createModerationDmEmbed(options = {}) {
    const {
        actionTitle = 'Moderation Notice',
        actionEmoji = '⚖️',
        color = 0xF04747,
        guildName = 'the server',
        description,
        statusLabel = 'Status',
        statusValue,
        effectiveDate,
        effectiveLabel = 'Effective Date',
        reason = 'No reason provided',
        caseId,
        moderatorName,
        appealLink,
        duration,
        durationLabel = 'Duration',
        extraFields = []
    } = options;

    const embed = createInfoEmbed(actionTitle, description || `A moderation action was taken in **${guildName}**.`, {
        emoji: actionEmoji,
        color,
        footerText: guildName ? `${guildName} • Moderation System` : undefined
    });

    if (statusValue) {
        embed.addFields({ name: trimToLimit(statusLabel, EMBED_LIMITS.fieldName, 'Status'), value: trimToLimit(statusValue, EMBED_LIMITS.fieldValue, 'N/A'), inline: true });
    }

    if (effectiveDate) {
        embed.addFields({ name: trimToLimit(effectiveLabel, EMBED_LIMITS.fieldName, 'Effective Date'), value: trimToLimit(effectiveDate, EMBED_LIMITS.fieldValue, 'N/A'), inline: true });
    }

    if (duration) {
        embed.addFields({ name: trimToLimit(durationLabel, EMBED_LIMITS.fieldName, 'Duration'), value: trimToLimit(duration, EMBED_LIMITS.fieldValue, 'N/A'), inline: true });
    }

    embed.addFields({ name: 'Reason', value: sanitizeCodeBlock(reason), inline: false });

    if (caseId) {
        embed.addFields({ name: 'Case ID', value: sanitizeCodeBlock(caseId), inline: true });
    }

    if (moderatorName) {
        embed.addFields({ name: 'Moderator', value: sanitizeCodeBlock(moderatorName), inline: true });
    }

    if (Array.isArray(extraFields) && extraFields.length > 0) {
        embed.addFields(...normalizeFields(extraFields));
    }

    if (appealLink) {
        embed.addFields({ name: 'Appeal Process', value: `[Submit Appeal](${appealLink})`, inline: false });
    }

    return embed;
}

// Create a user profile embed for displaying account information.
function createUserEmbed(user, options = {}) {
    const {
        title = 'User Profile',
        thumbnail = true,
        color = 0x5865F2
    } = options;

    const embed = createInfoEmbed(title, 'Detailed information about this user.', {
        emoji: '👤',
        color,
        footerText: 'User Information System'
    });

    const displayUser = user.user || user;
    const isGuildMember = !!user.guild; // Check if it's a guild member object

    if (thumbnail) {
        embed.setThumbnail(displayUser.displayAvatarURL({ size: 256 }));
    }

    embed.addFields({
        name: 'Username',
        value: `\`${sanitizeInlineCode(displayUser.username || displayUser.tag)}\``,
        inline: true
    });

    if (isGuildMember) {
        embed.addFields({
            name: 'Server Nickname',
            value: trimToLimit(user.displayName || 'Not set', EMBED_LIMITS.fieldValue, 'Not set'),
            inline: true
        });
    }

    if (displayUser.id) {
        embed.addFields({
            name: 'User ID',
            value: `\`${sanitizeInlineCode(displayUser.id)}\``,
            inline: true
        });
    }

    return embed;
}

async function sendEmbedReply(interaction, embed, options = {}) {
    const shouldEphemeral = options.ephemeral !== false;
    const messageOptions = {
        embeds: [embed],
        flags: shouldEphemeral ? MessageFlags.Ephemeral : undefined
    };

    try {
        if (interaction.replied || interaction.deferred) {
            return await interaction.followUp(messageOptions);
        }
        return await interaction.reply(messageOptions);
    } catch (error) {
        if (!interaction.replied && !interaction.deferred) {
            throw error;
        }
        return interaction.followUp(messageOptions).catch(() => null);
    }
}

// Reply to an interaction with an error embed (ephemeral by default).
async function sendErrorReply(interaction, title, description, options = {}) {
    const embed = createErrorEmbed(title, description, options);
    return sendEmbedReply(interaction, embed, options);
}

// Reply to an interaction with a success embed (ephemeral by default).
async function sendSuccessReply(interaction, title, description, options = {}) {
    const embed = createSuccessEmbed(title, description, options);
    return sendEmbedReply(interaction, embed, options);
}

async function sendWarningReply(interaction, title, description, options = {}) {
    const embed = createWarningEmbed(title, description, options);
    return sendEmbedReply(interaction, embed, options);
}

async function sendInfoReply(interaction, title, description, options = {}) {
    const embed = createInfoEmbed(title, description, options);
    return sendEmbedReply(interaction, embed, options);
}

module.exports = {
    createStandardEmbed,
    createErrorEmbed,
    createSuccessEmbed,
    createWarningEmbed,
    createInfoEmbed,
    createModerationEmbed,
    createModerationDmEmbed,
    createUserEmbed,
    sendEmbedReply,
    sendErrorReply,
    sendSuccessReply,
    sendWarningReply,
    sendInfoReply
};