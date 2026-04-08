const GuildMemberWelcome = require('./GuildMemberWelcome');
const Verification = require('./verification');
const InviteTracker = require('../Functions/InviteTracker');
const InviteAbuseMonitor = require('../Functions/InviteAbuseMonitor');
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
        // Run Invite tracking instantly (deduplicated)
        const inviteInfo = await InviteTracker.handleMemberJoin(member).catch(() => null);
        await InviteAbuseMonitor.handleMemberJoin(member, inviteInfo).catch(() => null);

        // Evaluate anti-raid triggers BEFORE executing heavy visual processes
        const isQuarantined = await AntiRaid.handleMemberJoin(member, inviteInfo).catch(() => false);

        // If system is locked down or they were quarantined, abort further automated onboarding
        if (isQuarantined) {
            return;
        }

        await invokeHandler(GuildMemberWelcome, member, client, 'GuildMemberWelcome');
        await invokeHandler(Verification, member, client, 'verification');
    }
};