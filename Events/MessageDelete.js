const GhostPingAlert = require('./GhostPingAlert');
const SnipeTracker = require('./SnipeTracker');

async function invokeHandler(handler, message, client, label) {
    if (!handler) return;

    try {
        if (typeof handler.execute === 'function') {
            await handler.execute(message, client);
        }
    } catch (error) {
        const safeLabel = label || handler?.name || 'unknown';
        console.error(`[MessageDelete] ${safeLabel} failed:`, error?.message || error);
    }
}

module.exports = {
    name: 'messageDelete',
    runOnce: false,
    async execute(message, client) {
        await invokeHandler(GhostPingAlert, message, client, 'GhostPingAlert');
        await invokeHandler(SnipeTracker, message, client, 'SnipeTracker');
    }
};