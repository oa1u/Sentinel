const InviteTracker = require('../Functions/InviteTracker');

module.exports = {
    name: 'inviteDelete',
    runOnce: false,
    async execute(invite) {
        InviteTracker.trackInviteDelete(invite);
    }
};