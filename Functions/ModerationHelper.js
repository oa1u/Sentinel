const { isModOrAdmin, getMemberFromMention } = require('./GetMemberFromMention');
const { sendErrorReply } = require('./EmbedBuilders');
const DatabaseManager = require('./MySQLDatabaseManager');
const { getMember, getUser } = require('./Helpers');
const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require('../Config/constants');

// Helper functions for moderation commands.
// Checks permissions, logs actions, and sends DM notifications for mod actions.
// Helps keep moderation commands clean and simple.
// Moderation helpers
// A small collection of helper functions used by moderation commands.
// They handle permission checks, role-hierarchy validation, logging to the
// moderation channel, and sending DMs to users — keeping command files
// focused on the actual moderation workflow.

// Check whether the command executor is allowed to act on the target user.
// This validates permissions, prevents self-actions, and enforces role hierarchy.
async function canModerateMember(interaction, targetUser, actionName = 'action') {
    const executor = interaction.member;
    const guild = interaction.guild;

    // Map common moderation actions to the Discord permission required for that action
    const actionPermissionMap = {
        ban: 'BanMembers',
        kick: 'KickMembers',
        timeout: 'ModerateMembers',
        untimeout: 'ModerateMembers',
        clear: 'ManageMessages',
        deletemsg: 'ManageMessages',
        slowmode: 'ManageMessages',
        warn: 'ModerateMembers',
        note: 'ModerateMembers',
    };

    const requiredPerm = actionPermissionMap[actionName?.toLowerCase()] || null;

    // Allow if the executor has the explicit permission for this action,
    // or if they have moderator/admin level permissions (ModerateMembers or Administrator).
    const hasExplicit = requiredPerm ? executor.permissions.has(requiredPerm) : false;
    if (!hasExplicit && !isModOrAdmin(executor)) {
        await sendErrorReply(
            interaction,
            'No Permission',
            `You need permission to ${actionName} members!`
        );
        return false;
    }

    if (executor.id === targetUser.id) {
        await sendErrorReply(
            interaction,
            'Error',
            `You cannot ${actionName} yourself!`
        );
        return false;
    }

    // Make sure you can't moderate someone with a higher role than you.
    const targetMember = await getMember(guild, targetUser.id);
    if (targetMember && executor.roles.highest.position <= targetMember.roles.highest.position) {
        await sendErrorReply(
            interaction,
            'Role Hierarchy',
            `You cannot ${actionName} that user due to role hierarchy!`
        );
        return false;
    }

    return true;
}

function getOrCreateWarnEntry(userId) {
    return DatabaseManager.getUserWarns(userId);
}

function addCase(userId, caseId, caseData) {
    DatabaseManager.addCase(userId, caseId, caseData);
}

// Tries to send a DM to a user. Doesn't always work if their DMs are off.
async function sendModerationDM(user, embed) {
    try {
        // If it's a user object, just send it
        if (user && typeof user.send === 'function') {
            await user.send({ embeds: [embed] }).catch(dmErr => {
                throw new Error(`DM send failed: ${dmErr.message}`);
            });
            return true;
        }

        // Try to DM them directly if they have an ID
        if (user && user.id) {
            try {
                await user.send({ embeds: [embed] });
                return true;
            } catch (dmErr) {
                console.warn(`Could not send DM to ${user.tag || user.id}: ${dmErr.message}`);
                return false;
            }
        }

        console.warn(`Invalid user object for DM: ${user?.id || 'unknown'}`);
        return false;
    } catch (err) {
        console.warn(`DM operation failed for ${user?.tag || user?.id || 'unknown'}: ${err.message}`);
        return false;
    }
}

// Log moderation action to the server log channel
function moderationEmbedHasField(embed, needle) {
    const fields = Array.isArray(embed?.data?.fields) ? embed.data.fields : [];
    const normalizedNeedle = String(needle || '').toLowerCase();
    return fields.some((field) => String(field?.name || '').toLowerCase().includes(normalizedNeedle));
}

function appendModerationContext(embed, interaction) {
    const prepared = EmbedBuilder.from(embed);

    const commandName = interaction?.commandName ? `/${interaction.commandName}` : 'Unknown';
    const channelLabel = interaction?.channel ? `${interaction.channel}` : 'Unknown';
    const moderatorLabel = interaction?.user
        ? `${interaction.user}\n\`${interaction.user.id}\``
        : 'Unknown';

    const extraFields = [];

    if (!moderationEmbedHasField(prepared, 'command')) {
        extraFields.push({ name: '🧭 Command', value: commandName, inline: true });
    }
    if (!moderationEmbedHasField(prepared, 'channel')) {
        extraFields.push({ name: '📍 Channel', value: channelLabel, inline: true });
    }
    if (!moderationEmbedHasField(prepared, 'moderator')) {
        extraFields.push({ name: '👮 Moderator', value: moderatorLabel, inline: true });
    }

    if (extraFields.length) {
        const existingCount = Array.isArray(prepared.data?.fields) ? prepared.data.fields.length : 0;
        const remaining = Math.max(0, 25 - existingCount);
        if (remaining > 0) prepared.addFields(...extraFields.slice(0, remaining));
    }

    if (!prepared.data?.timestamp) {
        prepared.setTimestamp(new Date());
    }

    const footerText = String(prepared.data?.footer?.text || '').trim();
    if (!footerText) {
        prepared.setFooter({ text: 'Moderation • Server Log' });
    } else if (!footerText.toLowerCase().includes('server log')) {
        prepared.setFooter({ text: `${footerText} • Server Log` });
    }

    return prepared;
}

async function logModerationAction(interaction, embed) {
    let loggingChannel = interaction.guild.channels.cache.get(serverLogChannelId);

    if (!loggingChannel && serverLogChannelId) {
        loggingChannel = await interaction.guild.channels.fetch(serverLogChannelId).catch(() => null);
    }

    if (!loggingChannel) {
        console.warn('Logging channel not found or not configured');
        return false;
    }

    try {
        const preparedEmbed = appendModerationContext(embed, interaction);
        await loggingChannel.send({ embeds: [preparedEmbed] });
        return true;
    } catch (err) {
        console.error(`Error logging action: ${err.message}`);
        return false;
    }
}

// Resolve user from mention, ID, or username
async function resolveUser(interaction, input) {
    // Already a User object
    if (input && typeof input === 'object' && input.id) {
        return input;
    }

    // Try getting from mention/string input
    if (typeof input === 'string') {
        try {
            const user = await getMemberFromMention(interaction.guild, input)
                .then(m => m?.user || null)
                .catch(err => {
                    console.warn(`[ModerationHelper] Could not resolve user from input '${input}': ${err.message}`);
                    return null;
                });
            if (user) return user;
        } catch (err) {
            console.error(`[ModerationHelper] Error in resolveUser: ${err.message}`);
        }
    }

    return null;
}

module.exports = {
    canModerateMember,
    getOrCreateWarnEntry,
    addCase,
    sendModerationDM,
    logModerationAction,
    resolveUser
};