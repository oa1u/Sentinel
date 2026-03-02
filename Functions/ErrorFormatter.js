const { EmbedBuilder } = require('discord.js');

// Helpers for building consistent error/success/info embeds and formatting
// error messages. This keeps user-facing messages clear and uniform across
// the bot.

// Standard colors for different types of messages.
const COLORS = {
    ERROR: 0xFF6B6B,     // Red
    SUCCESS: 0x43B581,   // Green
    WARNING: 0xFAA61A,   // Orange
    INFO: 0x5865F2,      // Blurple
    DEBUG: 0x9999FF      // Light blue
};

// Standard emojis for different actions and message types.
const EMOJIS = {
    ERROR: '❌',
    SUCCESS: '✅',
    WARNING: '⚠️',
    INFO: 'ℹ️',
    LOADING: '⏳',
    CLOCK: '⏰',
    LINK: '🔗',
    SHIELD: '🛡️',
    PERMISSION: '🔒',
    BANNED: '🔨',
    MUTED: '🔇'
};

// Builds an error embed for Discord messages.
function createErrorEmbed(title, description, options = {}) {
    const embed = new EmbedBuilder()
        .setColor(options.color || COLORS.ERROR)
        .setTitle(`${EMOJIS.ERROR} ${title}`)
        .setDescription(description);

    if (options.footer) {
        embed.setFooter({ text: options.footer });
    }
    if (options.timestamp !== false) {
        embed.setTimestamp();
    }
    if (options.fields) {
        embed.addFields(options.fields);
    }

    return embed;
}

// Builds a success embed for Discord messages.
function createSuccessEmbed(title, description, options = {}) {
    const embed = new EmbedBuilder()
        .setColor(options.color || COLORS.SUCCESS)
        .setTitle(`${EMOJIS.SUCCESS} ${title}`)
        .setDescription(description);

    if (options.footer) {
        embed.setFooter({ text: options.footer });
    }
    if (options.timestamp !== false) {
        embed.setTimestamp();
    }
    if (options.fields) {
        embed.addFields(options.fields);
    }

    return embed;
}


function createWarningEmbed(title, description, options = {}) {
    const embed = new EmbedBuilder()
        .setColor(options.color || COLORS.WARNING)
        .setTitle(`${EMOJIS.WARNING} ${title}`)
        .setDescription(description);

    if (options.footer) {
        embed.setFooter({ text: options.footer });
    }
    if (options.timestamp !== false) {
        embed.setTimestamp();
    }
    if (options.fields) {
        embed.addFields(options.fields);
    }

    return embed;
}


function createInfoEmbed(title, description, options = {}) {
    const embed = new EmbedBuilder()
        .setColor(options.color || COLORS.INFO)
        .setTitle(`${EMOJIS.INFO} ${title}`)
        .setDescription(description);

    if (options.footer) {
        embed.setFooter({ text: options.footer });
    }
    if (options.timestamp !== false) {
        embed.setTimestamp();
    }
    if (options.fields) {
        embed.addFields(options.fields);
    }

    return embed;
}


function createPermissionEmbed(permissionRequired = 'administrator') {
    return createErrorEmbed(
        'Permission Denied',
        `You need \`${permissionRequired}\` permission to use this command.`
    );
}


function createInvalidArgumentEmbed(argumentName, reason) {
    return createErrorEmbed(
        'Invalid Argument',
        `**${argumentName}** is invalid: ${reason}`
    );
}

function formatErrorMessage(error) {
    if (!error) return 'An unknown error occurred';

    // Handle common Discord.js errors
    if (error.message.includes('Missing Permissions')) {
        return 'I don\'t have permission to perform this action. Please check my role permissions.';
    }

    if (error.message.includes('Unknown User')) {
        return 'User not found. Please check the user ID or mention.';
    }

    if (error.message.includes('Unknown Channel')) {
        return 'Channel not found. Please check the channel ID or mention.';
    }

    if (error.message.includes('Unknown Role')) {
        return 'Role not found. Please check the role ID or mention.';
    }

    if (error.message.includes('Discord API')) {
        return 'Discord API error. Please try again later.';
    }

    // Default to the error message
    return error.message || 'An unknown error occurred';
}

module.exports = {
    COLORS,
    EMOJIS,
    createErrorEmbed,
    createSuccessEmbed,
    createWarningEmbed,
    createInfoEmbed,
    createPermissionEmbed,
    createInvalidArgumentEmbed,
    formatErrorMessage
};