const MusicManager = require('../Functions/MusicManager');

module.exports = {
    name: 'voiceStateUpdate',
    disabled: true,
    async execute(oldState, newState, client) {
        await MusicManager.handleVoiceStateUpdate(oldState, newState, client);
    }
};