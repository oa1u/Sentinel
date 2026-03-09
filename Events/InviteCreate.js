const InviteTracker = require('../Functions/InviteTracker');

module.exports = {
    name: 'inviteCreate',
    runOnce: false,
    async execute(invite) {
        InviteTracker.trackInviteCreate(invite);
    }
};
