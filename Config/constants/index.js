const fs = require('fs');
const path = require('path');

const channels = require('./channel.json');
const roles = require('./roles.json');
const misc = require('./misc.json');
const economy = require('./economy.json');
const automod = require('./automod.json');
const autoResponder = require('./autoResponder.json');
const leveling = require('./leveling.json');
const rules = require('./rules.json');
const serverBackups = require('./serverBackups.json');

function loadBlockedWordsSafe() {
    const blockedWordsPath = path.join(__dirname, 'blockedWords.json');
    try {
        if (!fs.existsSync(blockedWordsPath)) {
            return [];
        }

        const raw = fs.readFileSync(blockedWordsPath, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.warn(`[constants] Failed to load blockedWords.json, using empty list: ${error.message}`);
        return [];
    }
}

const blockedWords = loadBlockedWordsSafe();

module.exports = {
    channels,
    roles,
    misc,
    automod,
    autoResponder,
    leveling,
    blockedWords,
    rules,
    economy,
    serverBackups,
    CHANNELS: channels,
    ROLES: roles,
    MISC: misc,
    ECONOMY: economy,
    AUTOMOD: automod,
    AUTO_RESPONDER: autoResponder,
    LEVELING: leveling,
    BLOCKED_WORDS: blockedWords,
    RULES: rules,
    SERVER_BACKUPS: serverBackups
};