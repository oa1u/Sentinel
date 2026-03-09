const GuildMemberWelcome = require('./GuildMemberWelcome');
const Verification = require('./verification');
const InviteTracker = require('../Functions/InviteTracker');
const AntiRaid = require('../Functions/AntiRaid');

async function invokeHandler(handler, member, client, label) {
    if (!handler) return;

    try {
        if (typeof handler.execute === 'function') {
            await handler.execute(member, client);
        }
    } catch (error) {
        const safeLabel = label || handler?.name || 'unknown';
        console.error(`[GuildMemberAdd] ${safeLabel} failed:`, error?.message || error);
    }
}

module.exports = {
    name: 'guildMemberAdd',
    runOnce: false,
    async execute(member, client) {
        await invokeHandler(GuildMemberWelcome, member, client, 'GuildMemberWelcome');
        await invokeHandler(Verification, member, client, 'verification');
        const inviteInfo = await InviteTracker.handleMemberJoin(member).catch(() => null);
        await AntiRaid.handleMemberJoin(member, inviteInfo).catch(() => { });
    }
};