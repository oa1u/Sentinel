const { EmbedBuilder, MessageFlags } = require('discord.js');

// Embed builders
// Centralized helpers to create consistent, well-styled Discord embeds used
// across the bot. This keeps message formatting uniform and easy to update.

// Simple templates for error, success, warning and info messages.
function createErrorEmbed(title, description) {
    return new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle(`❌ ${title}`)
        .setDescription(description)
        .setFooter({ text: 'Error occurred • Action not completed' })
        .setTimestamp();
}

function createSuccessEmbed(title, description) {
    return new EmbedBuilder()
        .setColor(0x43B581)
        .setTitle(`✅ ${title}`)
        .setDescription(description)
        .setFooter({ text: 'Success • Action completed' })
        .setTimestamp();
}

function createWarningEmbed(title, description) {
    return new EmbedBuilder()
        .setColor(0xFAA61A)
        .setTitle(`⚠️ ${title}`)
        .setDescription(description)
        .setFooter({ text: 'Warning • Please review' })
        .setTimestamp();
}

function createInfoEmbed(title, description) {
    return new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`ℹ️ ${title}`)
        .setDescription(description)
        .setFooter({ text: 'Information • For your reference' })
        .setTimestamp();
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

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`⚖️ ${action.toUpperCase()}`)
        .setDescription(`A moderation action has been taken against a member.`)
        .setTimestamp();

    if (target) {
        embed.addFields({
            name: '👤 Target User',
            value: `${target.toString()}\n\`ID: ${target.id}\``,
            inline: true
        });
    }

    if (moderator) {
        embed.addFields({
            name: '👮 Moderator',
            value: `${moderator.toString()}\n\`ID: ${moderator.id}\``,
            inline: true
        });
    }

    embed.addFields({
        name: '📝 Reason',
        value: `\`\`\`${reason}\`\`\``,
        inline: false
    });

    if (caseId) {
        embed.addFields({
            name: '📋 Case ID',
            value: caseId,
            inline: true
        });
    }

    if (duration) {
        embed.addFields({
            name: '⏰ Duration',
            value: duration,
            inline: true
        });
    }

    embed.setFooter({ text: 'Moderation • Action logged' });

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

    const embed = new EmbedBuilder()
        .setTitle(`${actionEmoji} ${actionTitle}`)
        .setColor(color)
        .setDescription(description || `A moderation action was taken in **${guildName}**.`)
        .setTimestamp();

    if (statusValue) {
        embed.addFields({ name: statusLabel, value: statusValue, inline: true });
    }

    if (effectiveDate) {
        embed.addFields({ name: effectiveLabel, value: effectiveDate, inline: true });
    }

    if (duration) {
        embed.addFields({ name: durationLabel, value: duration, inline: true });
    }

    embed.addFields({ name: 'Reason', value: `${'```'}${reason}${'```'}`, inline: false });

    if (caseId) {
        embed.addFields({ name: 'Case ID', value: `${'```'}${caseId}${'```'}`, inline: true });
    }

    if (moderatorName) {
        embed.addFields({ name: 'Moderator', value: `${'```'}${moderatorName}${'```'}`, inline: true });
    }

    if (Array.isArray(extraFields) && extraFields.length > 0) {
        embed.addFields(...extraFields);
    }

    if (appealLink) {
        embed.addFields({ name: 'Appeal Process', value: `[Submit Appeal](${appealLink})`, inline: false });
    }

    if (guildName) {
        embed.setFooter({ text: `${guildName} • Moderation System` });
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

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`👤 ${title}`)
        .setDescription(`Detailed information about this user.`)
        .setTimestamp();

    const displayUser = user.user || user;
    const isGuildMember = !!user.guild; // Check if it's a guild member object

    if (thumbnail) {
        embed.setThumbnail(displayUser.displayAvatarURL({ size: 256 }));
    }

    embed.addFields({
        name: 'Username',
        value: `\`${displayUser.username || displayUser.tag}\``,
        inline: true
    });

    if (isGuildMember) {
        embed.addFields({
            name: 'Server Nickname',
            value: user.displayName || 'Not set',
            inline: true
        });
    }

    if (displayUser.id) {
        embed.addFields({
            name: 'User ID',
            value: `\`${displayUser.id}\``,
            inline: true
        });
    }

    embed.setFooter({ text: 'User Information System' });

    return embed;
}

// Reply to an interaction with an error embed (ephemeral by default).
async function sendErrorReply(interaction, title, description) {
    const embed = createErrorEmbed(title, description);

    if (interaction.replied || interaction.deferred) {
        return interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } else {
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
}

// Reply to an interaction with a success embed (ephemeral by default).
async function sendSuccessReply(interaction, title, description) {
    const embed = createSuccessEmbed(title, description);

    if (interaction.replied || interaction.deferred) {
        return interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } else {
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
}

module.exports = {
    createErrorEmbed,
    createSuccessEmbed,
    createWarningEmbed,
    createInfoEmbed,
    createModerationEmbed,
    createModerationDmEmbed,
    createUserEmbed,
    sendErrorReply,
    sendSuccessReply
};