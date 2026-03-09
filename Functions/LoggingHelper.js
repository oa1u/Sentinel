const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require('../Config/constants');

// Logging helpers
// Small helpers to build and send nicely formatted log embeds to the
// configured server logging channel. Keeps logging code consistent.

// Finds and checks the logging channel for the server.
function getLoggingChannel(guild) {
    if (!guild || !serverLogChannelId) {
        console.warn('[LoggingHelper] Guild or serverLogChannelId not provided');
        return null;
    }

    const channel = guild.channels.cache.get(serverLogChannelId);
    if (!channel) {
        console.warn(`[LoggingHelper] Logging channel not found: ${serverLogChannelId}`);
        return null;
    }

    return channel;
}

// Sends a single embed to the logging channel, with error handling.
async function sendLogEmbed(guild, embed) {
    try {
        const channel = getLoggingChannel(guild);
        if (!channel) return false;

        await channel.send({ embeds: [embed] });
        return true;
    } catch (err) {
        console.error(`[LoggingHelper] Failed to send log embed: ${err.message}`);
        return false;
    }
}

// Sends multiple embeds in batches (Discord only allows 10 embeds per message).
async function sendLogEmbeds(guild, embeds) {
    try {
        const channel = getLoggingChannel(guild);
        if (!channel) return false;

        // Split into chunks of 10 (Discord's limit)
        for (let i = 0; i < embeds.length; i += 10) {
            const batch = embeds.slice(i, i + 10);
            await channel.send({ embeds: batch });
        }
        return true;
    } catch (err) {
        console.error(`[LoggingHelper] Failed to send log embeds: ${err.message}`);
        return false;
    }
}

// Builds a nice-looking log embed with all the usual info.
function createLogEmbed(options) {
    const {
        title,
        description,
        author,
        color = 0x5865F2,
        fields = [],
        thumbnail,
        footer,
        timestamp = true
    } = options;

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(description);

    if (author) {
        embed.setAuthor(author);
    }

    if (fields.length > 0) {
        embed.addFields(fields);
    }

    if (thumbnail) {
        embed.setThumbnail(thumbnail);
    }

    if (footer) {
        embed.setFooter(footer);
    }

    if (timestamp) {
        embed.setTimestamp();
    }

    return embed;
}

module.exports = {
    getLoggingChannel,
    sendLogEmbed,
    sendLogEmbeds,
    createLogEmbed
};