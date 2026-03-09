const { setSnipe, cleanupExpiredSnipes } = require('../Functions/SnipeCache');

module.exports = {
    name: 'messageDelete',
    disabled: true,
    runOnce: false,
    async execute(message) {
        try {
            if (!message) return;

            if (message.partial) {
                try {
                    await message.fetch();
                } catch {
                    return;
                }
            }

            if (!message.channelId || !message.author || message.author.bot) return;

            setSnipe(message);
            cleanupExpiredSnipes();
        } catch (error) {
            console.error('[SnipeTracker] Failed to capture deleted message:', error?.message || error);
        }
    }
};