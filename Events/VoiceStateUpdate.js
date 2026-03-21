const JoinToCreate = require('./JoinToCreate');
const MusicVoiceState = require('./MusicVoiceState');

async function invokeHandler(handler, oldState, newState, client, label) {
    if (!handler) return;

    try {
        if (typeof handler.call === 'function') {
            await handler.call(client, [oldState, newState]);
            return;
        }

        if (typeof handler.execute === 'function') {
            await handler.execute(oldState, newState, client);
        }
    } catch (error) {
        const safeLabel = label || handler?.name || 'unknown';
        console.error(`[VoiceStateUpdate] ${safeLabel} failed:`, error?.message || error);
    }
}

module.exports = {
    name: 'voiceStateUpdate',
    runOnce: false,
    async execute(oldState, newState, client) {
        await invokeHandler(JoinToCreate, oldState, newState, client, 'JoinToCreate');
        await invokeHandler(MusicVoiceState, oldState, newState, client, 'MusicVoiceState');
    }
};