const { ChannelType } = require('discord.js');
const { serverID } = require('../Config/main.json');
const { channels, misc } = require('../Config/constants');
const { createLogEmbed, sendLogEmbed } = require('./LoggingHelper');

const DEFAULT_DAYS_INACTIVE = 30;
const DEFAULT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RESULTS = 20;

function resolveGuild(client) {
    if (!client) return null;
    if (serverID) {
        return client.guilds.cache.get(serverID) || null;
    }
    return client.guilds.cache.first() || null;
}

function resolveConfig() {
    const cleanup = misc?.cleanup || {};
    const daysInactive = Number(cleanup?.inactiveChannelReportDays) || DEFAULT_DAYS_INACTIVE;
    const intervalMs = Number(cleanup?.inactiveChannelReportIntervalMs) || DEFAULT_INTERVAL_MS;
    const maxResults = Math.max(1, Number(cleanup?.inactiveChannelReportMaxResults) || DEFAULT_MAX_RESULTS);
    const ignoreChannelIds = Array.isArray(channels?.inactiveChannelIgnoreIds)
        ? channels.inactiveChannelIgnoreIds.map(id => String(id))
        : [];

    return { daysInactive, intervalMs, maxResults, ignoreChannelIds };
}

async function getLastMessageTimestamp(channel) {
    if (!channel || !channel.isTextBased || !channel.isTextBased()) return null;

    if (channel.lastMessage?.createdTimestamp) {
        return channel.lastMessage.createdTimestamp;
    }

    if (channel.lastMessageId) {
        const message = await channel.messages.fetch(channel.lastMessageId).catch(() => null);
        if (message?.createdTimestamp) return message.createdTimestamp;
    }

    const fetched = await channel.messages.fetch({ limit: 1 }).catch(() => null);
    const lastMessage = fetched?.first?.();
    if (lastMessage?.createdTimestamp) return lastMessage.createdTimestamp;

    return null;
}

async function generateInactiveChannelReport(client) {
    const guild = resolveGuild(client);
    if (!guild) {
        console.warn('[InactiveChannelReporter] No guild available for report');
        return false;
    }

    const { daysInactive, maxResults, ignoreChannelIds } = resolveConfig();
    const cutoffMs = Date.now() - (daysInactive * 24 * 60 * 60 * 1000);

    const allChannels = await guild.channels.fetch().catch(() => null);
    if (!allChannels) return false;

    const eligibleChannels = allChannels
        .filter(channel => {
            if (!channel || !channel.isTextBased || !channel.isTextBased()) return false;
            if (channel.isThread && channel.isThread()) return false;
            if (ignoreChannelIds.includes(String(channel.id))) return false;
            if (channel.type === ChannelType.GuildForum) return false;
            if (channel.type === ChannelType.GuildStageVoice) return false;
            if (channel.type === ChannelType.GuildVoice) return false;
            if (channel.type === ChannelType.GuildCategory) return false;
            return true;
        })
        .sort((a, b) => a.position - b.position);

    const inactiveChannels = [];
    let checked = 0;
    let missingPerms = 0;

    for (const channel of eligibleChannels.values()) {
        checked += 1;
        try {
            const lastMessageAt = await getLastMessageTimestamp(channel);
            const lastActivityAt = lastMessageAt || channel.createdTimestamp || 0;
            if (!lastActivityAt) continue;

            if (lastActivityAt <= cutoffMs) {
                inactiveChannels.push({
                    channel,
                    lastActivityAt
                });
            }
        } catch (error) {
            missingPerms += 1;
        }
    }

    if (inactiveChannels.length === 0) {
        const emptyEmbed = createLogEmbed({
            title: 'Inactive Channels Report',
            description: `No channels exceeded ${daysInactive} days of inactivity.`,
            color: 0x2ECC71
        });
        return sendLogEmbed(guild, emptyEmbed);
    }

    inactiveChannels.sort((a, b) => a.lastActivityAt - b.lastActivityAt);

    const displayed = inactiveChannels.slice(0, maxResults).map(entry => {
        const days = Math.floor((Date.now() - entry.lastActivityAt) / (24 * 60 * 60 * 1000));
        const lastDate = new Date(entry.lastActivityAt).toISOString().slice(0, 10);
        return `<#${entry.channel.id}> - ${days} days inactive (last: ${lastDate})`;
    });

    const remaining = inactiveChannels.length - displayed.length;
    if (remaining > 0) {
        displayed.push(`...and ${remaining} more`);
    }

    const embed = createLogEmbed({
        title: 'Inactive Channels Report',
        description: `Channels inactive for ${daysInactive}+ days. Consider archiving or deleting as needed.`,
        color: 0xF1C40F,
        fields: [
            { name: 'Summary', value: `Checked: ${checked}\nInactive: ${inactiveChannels.length}\nSkipped: ${missingPerms}`, inline: true },
            { name: `Top ${Math.min(maxResults, inactiveChannels.length)} channels`, value: displayed.join('\n').slice(0, 1024) }
        ],
        footer: { text: 'Inactive channel report' }
    });

    return sendLogEmbed(guild, embed);
}

module.exports = {
    generateInactiveChannelReport,
    resolveConfig
};