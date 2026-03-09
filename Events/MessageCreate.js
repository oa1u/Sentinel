const AfkStatus = require('./AfkStatus');
const AutoMod = require('./AutoMod');
const EconomyActivity = require('./EconomyActivity');
const Leveling = require('./Leveling');
const MediaOnly = require('./MediaOnly');
const LuckyDrop = require('../Functions/LuckyDrop');

async function invokeHandler(handler, message, client, label) {
    if (!handler) return;

    try {
        if (typeof handler.handleMessageCreate === 'function') {
            await handler.handleMessageCreate(message, client);
            return;
        }

        if (typeof handler.call === 'function') {
            await handler.call(client, [message]);
            return;
        }

        if (typeof handler.execute === 'function') {
            await handler.execute(message, client);
        }
    } catch (error) {
        const safeLabel = label || handler?.name || 'unknown';
        console.error(`[MessageCreate] ${safeLabel} failed:`, error?.message || error);
    }
}

module.exports = {
    name: 'messageCreate',
    runOnce: false,
    async execute(message, client) {
        await invokeHandler(AfkStatus, message, client, 'AfkStatus');
        await invokeHandler(AutoMod, message, client, 'AutoMod');
        await invokeHandler(MediaOnly, message, client, 'MediaOnly');
        await invokeHandler(EconomyActivity, message, client, 'EconomyActivity');
        await invokeHandler(Leveling, message, client, 'Leveling');
        await LuckyDrop.handleMessage(message).catch(() => { });
    }
};