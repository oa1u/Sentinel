const MySQLDatabaseManager = require('./MySQLDatabaseManager');
const { createLogEmbed, sendLogEmbed } = require('./LoggingHelper');
const BotSafetyCenter = require('./BotSafetyCenter');

const alertCooldowns = new Map();

function countRecentViolations(rows, withinMs) {
    const cutoff = Date.now() - withinMs;
    return rows.filter((row) => {
        const timestamp = new Date(row.timestamp || row.created_at || 0).getTime();
        return Number.isFinite(timestamp) && timestamp >= cutoff;
    });
}

async function handleViolation(message, context = {}) {
    if (!message?.guild || !message?.author?.id) return null;
    const config = BotSafetyCenter.getConfig();

    const userId = message.author.id;
    const recent = await MySQLDatabaseManager.getAutomodViolations(userId, 24).catch(() => []);
    if (!Array.isArray(recent) || recent.length === 0) return null;

    const lastHour = countRecentViolations(recent, 60 * 60 * 1000);
    const timeoutOrKickCount = recent.filter((entry) => ['timeout', 'kick'].includes(String(entry.action_taken || '').toLowerCase())).length;
    const highRiskCount = recent.filter((entry) => ['high', 'critical'].includes(String(entry.risk_level || '').toLowerCase())).length;

    const shouldAlert = lastHour.length >= config.moderationEscalationLastHourThreshold
        || recent.length >= config.moderationEscalationLastDayThreshold
        || timeoutOrKickCount >= config.moderationEscalationTimeoutThreshold
        || highRiskCount >= config.moderationEscalationHighRiskThreshold;
    if (!shouldAlert) return null;

    const cooldownKey = `${message.guild.id}:${userId}`;
    const lastAlertAt = Number(alertCooldowns.get(cooldownKey) || 0);
    if (Date.now() - lastAlertAt < config.moderationEscalationCooldownMs) {
        return null;
    }
    alertCooldowns.set(cooldownKey, Date.now());

    BotSafetyCenter.recordAlert({
        type: 'moderation-escalation',
        severity: 'critical',
        title: 'Moderation Escalation Recommended',
        message: `${message.author.tag} crossed the configured AutoMod escalation thresholds.`,
        guildId: message.guild.id,
        guildName: message.guild.name,
        meta: {
            recent24h: recent.length,
            recent1h: lastHour.length,
            timeoutOrKickCount,
            highRiskCount
        }
    });

    const embed = createLogEmbed({
        title: 'Moderation Escalation Recommended',
        description: `${message.author} has crossed escalation thresholds and should be reviewed by staff.`,
        color: 0xED4245,
        fields: [
            { name: 'User', value: `${message.author.tag} (${userId})`, inline: true },
            { name: 'Last hour', value: `${lastHour.length} AutoMod event(s)`, inline: true },
            { name: 'Last 24h', value: `${recent.length} AutoMod event(s)`, inline: true },
            { name: 'Timeouts / kicks', value: `${timeoutOrKickCount}`, inline: true },
            { name: 'High risk events', value: `${highRiskCount}`, inline: true },
            { name: 'Latest reason', value: String(context.reason || 'Unknown').slice(0, 300), inline: false }
        ]
    });

    await sendLogEmbed(message.guild, embed).catch(() => null);

    return {
        recent24h: recent.length,
        recent1h: lastHour.length,
        timeoutOrKickCount,
        highRiskCount
    };
}

module.exports = {
    handleViolation
};