const DatabaseManager = require('../Functions/MySQLDatabaseManager');
const { MISC: miscConfig } = require('../Config/constants');

const economyConfig = miscConfig?.economy || {};
const CURRENCY_NAME = String(economyConfig.currencyName || 'coins');
const CURRENCY_SYMBOL = String(economyConfig.currencySymbol || '💰');

const ACTIVITY_ENABLED = economyConfig.activityEnabled !== false;
const ACTIVITY_MIN_REWARD = Math.max(1, Math.min(10000, Number(economyConfig.activityMinReward) || 4));
const ACTIVITY_MAX_REWARD = Math.max(ACTIVITY_MIN_REWARD, Math.min(100000, Number(economyConfig.activityMaxReward) || 12));
const ACTIVITY_COOLDOWN_MS = Math.max(15000, Math.min(60 * 60 * 1000, Number(economyConfig.activityCooldownMs) || 60 * 1000));
const MIN_MESSAGE_LENGTH = Math.max(2, Math.min(200, Number(economyConfig.activityMinMessageLength) || 8));
const BONUS_CHANCE = Math.min(Math.max(Number(economyConfig.activityBonusChance) || 0.03, 0), 1);
const BONUS_MULTIPLIER = Math.max(1.1, Math.min(10, Number(economyConfig.activityBonusMultiplier) || 2));
const BONUS_NOTIFY_CHANCE = Math.min(Math.max(Number(economyConfig.activityBonusNotifyChance) || 0.25, 0), 1);

const userCooldowns = new Map();
let lastCleanup = Date.now();
const CLEANUP_INTERVAL = 5 * 60 * 1000;
const MAX_COOLDOWN_SIZE = 25000;

function formatNumber(num) {
    return Number(num || 0).toLocaleString('en-US');
}

function moneyLine(amount) {
    return `${CURRENCY_SYMBOL} **${formatNumber(amount)}** ${CURRENCY_NAME}`;
}

function cleanupCooldowns(force = false) {
    const now = Date.now();
    if (!force && userCooldowns.size <= MAX_COOLDOWN_SIZE && (now - lastCleanup) < CLEANUP_INTERVAL) {
        return;
    }

    const cutoff = now - ACTIVITY_COOLDOWN_MS;
    for (const [key, timestamp] of userCooldowns.entries()) {
        if (timestamp < cutoff) {
            userCooldowns.delete(key);
        }
    }

    lastCleanup = now;
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

const economyActivityEvent = {
    name: 'messageCreate',
    runOnce: false,
    disabled: true,
    call: async (client, args) => {
        if (!ACTIVITY_ENABLED) return;

        const [message] = args;
        if (!message || !message.guild || !message.author) return;
        if (message.author.bot) return;

        const content = String(message.content || '').trim();
        if (content.length < MIN_MESSAGE_LENGTH) return;

        const cooldownKey = `${message.guild.id}:${message.author.id}`;
        const now = Date.now();

        if ((now - lastCleanup) > CLEANUP_INTERVAL || userCooldowns.size > MAX_COOLDOWN_SIZE) {
            cleanupCooldowns();
        }

        const previous = userCooldowns.get(cooldownKey);
        if (previous && (now - previous) < ACTIVITY_COOLDOWN_MS) {
            return;
        }

        userCooldowns.set(cooldownKey, now);

        const baseReward = randomInt(ACTIVITY_MIN_REWARD, ACTIVITY_MAX_REWARD);
        const gotBonus = Math.random() < BONUS_CHANCE;
        const finalReward = gotBonus ? Math.max(1, Math.floor(baseReward * BONUS_MULTIPLIER)) : baseReward;

        const result = await DatabaseManager.awardEconomyActivity(
            message.guild.id,
            message.author.id,
            finalReward,
            {
                txType: gotBonus ? 'activity_bonus_reward' : 'activity_reward',
                note: gotBonus ? 'Message activity bonus reward' : 'Message activity reward'
            }
        );

        if (!result?.ok) return;

        DatabaseManager.updateEconomyQuestProgress(
            message.guild.id,
            message.author.id,
            'activity',
            1
        ).catch(() => { });

        if (gotBonus && Math.random() < BONUS_NOTIFY_CHANCE) {
            message.channel.send({
                content: `✨ ${message.author}, bonus activity reward! You gained ${moneyLine(finalReward)}.`
            }).catch(() => { });
        }
    }
};

economyActivityEvent.formatNumber = formatNumber;
economyActivityEvent.moneyLine = moneyLine;

module.exports = economyActivityEvent;