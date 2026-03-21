const { EmbedBuilder } = require('discord.js');
const { MISC: miscConfig } = require('../Config/constants');
const MySQLDatabaseManager = require('./MySQLDatabaseManager');
const Leveling = require('../Events/Leveling');

const luckyConfig = miscConfig?.luckyDrop || {};
const DROP_ENABLED = luckyConfig.enabled !== false;
const DROP_CHANCE = Math.min(Math.max(Number(luckyConfig.chance) || 0.01, 0), 1);
const DROP_COOLDOWN_MS = Math.max(10_000, Math.min(24 * 60 * 60 * 1000, Number(luckyConfig.cooldownMs) || 300000));
const XP_MIN = Math.max(1, Math.min(500, Number(luckyConfig.xpMin) || 5));
const XP_MAX = Math.max(XP_MIN, Math.min(5000, Number(luckyConfig.xpMax) || 25));
const COINS_MIN = Math.max(1, Math.min(250000, Number(luckyConfig.coinsMin) || 25));
const COINS_MAX = Math.max(COINS_MIN, Math.min(250000, Number(luckyConfig.coinsMax) || 150));
const COIN_WEIGHT = Math.min(Math.max(Number(luckyConfig.coinWeight) || 0.5, 0), 1);
const NOTIFY_CHANNEL = luckyConfig.notifyChannel !== false;

const userCooldowns = new Map();

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function canDropFor(userId) {
    const now = Date.now();
    const last = Number(userCooldowns.get(userId) || 0);
    if (last && now - last < DROP_COOLDOWN_MS) return false;
    userCooldowns.set(userId, now);
    return true;
}

async function handleMessage(message) {
    if (!DROP_ENABLED) return null;
    if (!message || !message.guild || !message.author || message.author.bot) return null;
    if (!canDropFor(message.author.id)) return null;
    if (Math.random() >= DROP_CHANCE) return null;

    const awardCoins = Math.random() < COIN_WEIGHT;

    if (awardCoins) {
        const amount = randomInt(COINS_MIN, COINS_MAX);
        const result = await MySQLDatabaseManager.awardEconomyActivity(
            message.guild.id,
            message.author.id,
            amount,
            { txType: 'lucky_drop', note: 'Lucky drop coin reward' }
        );

        if (result?.ok && NOTIFY_CHANNEL && message.channel?.isTextBased()) {
            const embed = new EmbedBuilder()
                .setColor(0x43B581)
                .setTitle('🍀 Lucky Drop!')
                .setDescription(`**${message.author}** found **${amount}** coins!`)
                .setThumbnail(message.author.displayAvatarURL())
                .setFooter({ text: 'Economy Reward • Lucky Drop', iconURL: message.guild.iconURL() })
                .setTimestamp();
            await message.channel.send({ embeds: [embed] }).catch(() => { });
        }

        return { type: 'coins', amount };
    }

    const xp = randomInt(XP_MIN, XP_MAX);
    const outcome = await Leveling.addBonusXP(message, xp);

    if (outcome && NOTIFY_CHANNEL && message.channel?.isTextBased()) {
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('✨ Lucky XP!')
            .setDescription(`**${message.author}** gained **${xp} XP**!`)
            .setThumbnail(message.author.displayAvatarURL())
            .setFooter({ text: 'Leveling Reward • Lucky XP', iconURL: message.guild.iconURL() })
            .setTimestamp();
        await message.channel.send({ embeds: [embed] }).catch(() => { });
    }

    return { type: 'xp', amount: xp };
}

module.exports = {
    handleMessage
};
