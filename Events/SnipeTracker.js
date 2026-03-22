const { setSnipe, cleanupExpiredSnipes } = require('../Functions/SnipeCache');

// SnipeTracker: Logs all deleted messages as SNIPE in ghost_pings
// Export only the handler, not the event registration
exports.disabled = true;
exports.execute = async function (message, client) {
    try {
        if (!message) return;

        if (message.partial) {
            // Cannot fetch a deleted message.
            return;
        }

        if (!message.channelId || !message.author || message.author.bot) return;

        setSnipe(message);
        cleanupExpiredSnipes();

        // Log all deleted messages as SNIPE in snipes table
        const MySQLDatabaseManager = require('../Functions/MySQLDatabaseManager');
        await MySQLDatabaseManager.logSnipe(
            message.author.id,
            message.author.tag,
            message.content,
            message.channel.id,
            message.channel.name || null
        );
    } catch (error) {
        console.error('[SnipeTracker] Failed to capture deleted message:', error?.message || error);
    }
}