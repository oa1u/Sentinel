const { ChannelType } = require('discord.js');
const { serverID } = require('../Config/main.json');
const { channels, misc } = require('../Config/constants');
const { createLogEmbed, sendLogEmbed } = require('./LoggingHelper');

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MIN_INACTIVE_MS = 3 * 24 * 60 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CHANCE = 0.35;
const EMPTY_MESSAGES_WARN_COOLDOWN_MS = 6 * 60 * 60 * 1000;
function loadRevivalMessages() {
    try {
        const messages = require('../Config/revivalMessages.json');
        return Array.isArray(messages) ? messages : [];
    } catch (error) {
        console.warn(`[ChannelRevival] Failed to load revivalMessages.json: ${error.message}`);
        return [];
    }
}

const lastRevivalByChannel = new Map();
let lastEmptyMessagesWarnAt = 0;

function resolveGuild(client) {
    if (!client) return null;
    if (serverID) {
        return client.guilds.cache.get(serverID) || null;
    }
    return client.guilds.cache.first() || null;
}

function resolveConfig() {
    const revival = misc?.revival || {};
    const intervalMs = Number(revival?.intervalMs) || DEFAULT_INTERVAL_MS;
    const minInactiveMs = Number(revival?.minInactiveMs) || DEFAULT_MIN_INACTIVE_MS;
    const cooldownMs = Number(revival?.cooldownMs) || DEFAULT_COOLDOWN_MS;
    const chance = Number.isFinite(Number(revival?.chance)) ? Number(revival?.chance) : DEFAULT_CHANCE;
    const messages = loadRevivalMessages();

    const ignoreChannelIds = Array.isArray(channels?.revivalIgnoreIds)
        ? channels.revivalIgnoreIds.map(id => String(id))
        : [];
    const targetChannelIds = Array.isArray(channels?.revivalTargetIds)
        ? channels.revivalTargetIds.map(id => String(id))
        : [];

    return { intervalMs, minInactiveMs, cooldownMs, chance, messages, ignoreChannelIds, targetChannelIds };
}

async function getLastMessageInfo(channel) {
    if (!channel || !channel.isTextBased || !channel.isTextBased()) return null;

    if (channel.lastMessage) {
        return {
            id: channel.lastMessage.id,
            createdTimestamp: channel.lastMessage.createdTimestamp,
            authorId: channel.lastMessage.author?.id || null
        };
    }

    if (channel.lastMessageId) {
        const message = await channel.messages.fetch(channel.lastMessageId).catch(() => null);
        if (message) {
            return {
                id: message.id,
                createdTimestamp: message.createdTimestamp,
                authorId: message.author?.id || null
            };
        }
    }

    const fetched = await channel.messages.fetch({ limit: 1 }).catch(() => null);
    const lastMessage = fetched?.first?.();
    if (!lastMessage) return null;

    return {
        id: lastMessage.id,
        createdTimestamp: lastMessage.createdTimestamp,
        authorId: lastMessage.author?.id || null
    };
}

function isEligibleChannel(channel, ignoreChannelIds, targetChannelIds) {
    if (!channel || !channel.isTextBased || !channel.isTextBased()) return false;
    if (channel.isThread && channel.isThread()) return false;
    if (ignoreChannelIds.includes(String(channel.id))) return false;
    if (channel.type === ChannelType.GuildForum) return false;
    if (channel.type === ChannelType.GuildStageVoice) return false;
    if (channel.type === ChannelType.GuildVoice) return false;
    if (channel.type === ChannelType.GuildCategory) return false;
    if (targetChannelIds.length > 0 && !targetChannelIds.includes(String(channel.id))) return false;

    return true;
}

function shouldSkipCooldown(channelId, cooldownMs) {
    const lastRevivedAt = lastRevivalByChannel.get(channelId) || 0;
    return Date.now() - lastRevivedAt < cooldownMs;
}

async function runChannelRevival(client) {
    const revivalConfig = misc?.revival || {};
    if (revivalConfig.enabled === false) return false;

    const guild = resolveGuild(client);
    if (!guild) return false;

    const { minInactiveMs, cooldownMs, chance, messages, ignoreChannelIds, targetChannelIds } = resolveConfig();
    const allChannels = await guild.channels.fetch().catch(() => null);
    if (!allChannels) return false;

    const candidates = [];

    for (const channel of allChannels.values()) {
        if (!isEligibleChannel(channel, ignoreChannelIds, targetChannelIds)) continue;
        if (shouldSkipCooldown(channel.id, cooldownMs)) continue;

        const lastMessage = await getLastMessageInfo(channel);
        const lastActivityAt = lastMessage?.createdTimestamp || channel.createdTimestamp || 0;
        if (!lastActivityAt) continue;

        if (Date.now() - lastActivityAt >= minInactiveMs) {
            candidates.push(channel);
        }
    }

    if (candidates.length === 0) return false;
    if (messages.length === 0) {
        const now = Date.now();
        if (now - lastEmptyMessagesWarnAt > EMPTY_MESSAGES_WARN_COOLDOWN_MS) {
            lastEmptyMessagesWarnAt = now;
            const embed = createLogEmbed({
                title: 'Channel Revival Disabled',
                description: 'No revival messages found. Add prompts to Config/revivalMessages.json to enable revival posts.',
                color: 0xE67E22
            });
            await sendLogEmbed(guild, embed);
        }
        return false;
    }

    if (Math.random() > Math.max(0, Math.min(1, chance))) return false;

    const selected = candidates[Math.floor(Math.random() * candidates.length)];
    const message = messages[Math.floor(Math.random() * messages.length)];

    await selected.send({ content: message }).catch((err) => {
        console.error(`[ChannelRevival] Failed to send revival message: ${err.message}`);
    });

    lastRevivalByChannel.set(selected.id, Date.now());
    return true;
}

module.exports = {
    runChannelRevival,
    resolveConfig
};