const { createLogEmbed, sendLogEmbed } = require('./LoggingHelper');
const BotSafetyCenter = require('./BotSafetyCenter');

const guildActivity = new Map();
const alertCooldowns = new Map();

function getGuildActivity(guildId) {
    if (!guildActivity.has(guildId)) {
        guildActivity.set(guildId, []);
    }
    return guildActivity.get(guildId);
}

function prune(entries) {
    const { assetAuditWindowMs } = BotSafetyCenter.getConfig();
    const now = Date.now();
    return entries.filter((entry) => now - entry.at <= assetAuditWindowMs);
}

function formatEntry(entry) {
    return `${entry.kind.toUpperCase()} ${entry.action}: ${entry.name || 'Unknown'} (${entry.id || 'no-id'})`;
}

async function recordAuditEvent(guild, kind, action, item, details = null) {
    if (!guild?.id || !kind || !action) return null;
    const config = BotSafetyCenter.getConfig();

    const now = Date.now();
    const entries = prune(getGuildActivity(guild.id));
    const event = {
        at: now,
        kind,
        action,
        id: item?.id || null,
        name: item?.name || item?.code || 'Unknown',
        details
    };
    entries.push(event);
    guildActivity.set(guild.id, entries);

    const sameKindEntries = entries.filter((entry) => entry.kind === kind);
    const threshold = kind === 'sticker' ? config.stickerBurstThreshold : config.emojiBurstThreshold;
    if (sameKindEntries.length < threshold) {
        return null;
    }

    const cooldownKey = `${guild.id}:${kind}`;
    const lastAlertAt = Number(alertCooldowns.get(cooldownKey) || 0);
    if (now - lastAlertAt < config.assetAuditCooldownMs) {
        return null;
    }
    alertCooldowns.set(cooldownKey, now);

    BotSafetyCenter.recordAlert({
        type: kind === 'emoji' ? 'emoji-burst' : 'sticker-burst',
        severity: 'warning',
        title: `${kind === 'emoji' ? 'Emoji' : 'Sticker'} Burst Detected`,
        message: `${sameKindEntries.length} ${kind} events were observed within the configured audit window.`,
        guildId: guild.id,
        guildName: guild.name,
        meta: {
            count: sameKindEntries.length,
            threshold,
            windowMs: config.assetAuditWindowMs
        }
    });

    const embed = createLogEmbed({
        title: `${kind === 'emoji' ? 'Emoji' : 'Sticker'} Burst Detected`,
        description: `High ${kind} activity was detected in **${guild.name}**.`,
        color: 0xF1C40F,
        fields: [
            { name: 'Window', value: `${Math.round(config.assetAuditWindowMs / 1000)} seconds`, inline: true },
            { name: 'Event count', value: `${sameKindEntries.length}`, inline: true },
            { name: 'Recent activity', value: sameKindEntries.slice(-6).map(formatEntry).join('\n'), inline: false }
        ]
    });

    await sendLogEmbed(guild, embed).catch(() => null);
    return { triggered: true, count: sameKindEntries.length };
}

module.exports = {
    handleEmojiCreate: async (emoji) => recordAuditEvent(emoji?.guild, 'emoji', 'create', emoji),
    handleEmojiDelete: async (emoji) => recordAuditEvent(emoji?.guild, 'emoji', 'delete', emoji),
    handleEmojiUpdate: async (oldEmoji, newEmoji) => recordAuditEvent(newEmoji?.guild || oldEmoji?.guild, 'emoji', 'update', newEmoji || oldEmoji, {
        previousName: oldEmoji?.name || null,
        nextName: newEmoji?.name || null
    }),
    handleStickerCreate: async (sticker) => recordAuditEvent(sticker?.guild, 'sticker', 'create', sticker),
    handleStickerDelete: async (sticker) => recordAuditEvent(sticker?.guild, 'sticker', 'delete', sticker),
    handleStickerUpdate: async (oldSticker, newSticker) => recordAuditEvent(newSticker?.guild || oldSticker?.guild, 'sticker', 'update', newSticker || oldSticker, {
        previousName: oldSticker?.name || null,
        nextName: newSticker?.name || null
    })
};