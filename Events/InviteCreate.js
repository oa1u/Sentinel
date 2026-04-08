const InviteTracker = require('../Functions/InviteTracker');
const InviteAbuseMonitor = require('../Functions/InviteAbuseMonitor');

module.exports = {
    name: 'inviteCreate',
    runOnce: false,
    async execute(invite) {
        InviteTracker.trackInviteCreate(invite);
        await InviteAbuseMonitor.handleInviteCreate(invite).catch(() => null);
    }
};