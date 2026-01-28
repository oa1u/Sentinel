const { isModOrAdmin, getMemberFromMention } = require('./GetMemberFromMention');
const { sendErrorReply } = require('./EmbedBuilders');
const DatabaseManager = require('./DatabaseManager');
const { getMember, getUser } = require('./Helpers');

async function canModerateMember(interaction, targetUser, actionName = 'action') {
    const executor = interaction.member;
    const guild = interaction.guild;

    if (!isModOrAdmin(executor)) {
        await sendErrorReply(
            interaction,
            'No Permission',
            `You need mod permissions to ${actionName} members!`
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

async function sendModerationDM(user, embed) {
    try {
        const dmUser = await getUser(null, user.id);
        if (!dmUser) {
            console.warn(`Could not fetch user for DM: ${user.tag}`);
            return false;
        }
        
        await dmUser.send({ embeds: [embed] });
        return true;
    } catch (err) {
        console.warn(`Could not send DM to ${user.tag}: ${err.message}`);
        return false;
    }
}

async function logModerationAction(interaction, embed) {
    const { serverLogChannelId } = require('../Config/constants/channel.json');
    const loggingChannel = interaction.guild.channels.cache.get(serverLogChannelId);

    if (!loggingChannel) {
        console.warn('Logging channel not found or not configured');
        return false;
    }

    try {
        await loggingChannel.send({ embeds: [embed] });
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
        const user = await getMemberFromMention(interaction.guild, input)
            .then(m => m?.user || null)
            .catch(() => null);
        if (user) return user;
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