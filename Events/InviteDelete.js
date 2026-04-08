const InviteTracker = require('../Functions/InviteTracker');
const InviteAbuseMonitor = require('../Functions/InviteAbuseMonitor');

module.exports = {
    name: 'inviteDelete',
    runOnce: false,
    async execute(invite) {
        InviteTracker.trackInviteDelete(invite);
        await InviteAbuseMonitor.handleInviteDelete(invite).catch(() => null);
    }
};