const afkMap = new Map();

const DEFAULT_REASON = 'No reason provided';
const MAX_REASON_LENGTH = 200;
const DEFAULT_MENTIONS_MODE = 'compact';
const VALID_MENTIONS_MODES = new Set(['off', 'compact', 'rich']);

function buildKey(guildId, userId) {
    return `${String(guildId || 'global')}:${String(userId || '')}`;
}

function normalizeReason(reason) {
    const cleaned = String(reason || '').trim();
    if (!cleaned) return DEFAULT_REASON;
    if (cleaned.length <= MAX_REASON_LENGTH) return cleaned;
    return `${cleaned.slice(0, MAX_REASON_LENGTH - 1)}…`;
}

function normalizeMentionsMode(mode) {
    const cleaned = String(mode || '').trim().toLowerCase();
    if (!cleaned) return DEFAULT_MENTIONS_MODE;
    return VALID_MENTIONS_MODES.has(cleaned) ? cleaned : DEFAULT_MENTIONS_MODE;
}

function setAfk(guildId, userId, reason, mentionsMode) {
    const key = buildKey(guildId, userId);
    const record = {
        guildId: String(guildId || 'global'),
        userId: String(userId || ''),
        reason: normalizeReason(reason),
        mentionsMode: normalizeMentionsMode(mentionsMode),
        since: Date.now()
    };

    afkMap.set(key, record);
    return record;
}

function updateAfk(guildId, userId, updates = {}) {
    const key = buildKey(guildId, userId);
    const existing = afkMap.get(key);
    if (!existing) return null;

    const nextReason = Object.prototype.hasOwnProperty.call(updates, 'reason')
        ? normalizeReason(updates.reason)
        : existing.reason;
    const nextMentionsMode = Object.prototype.hasOwnProperty.call(updates, 'mentionsMode')
        ? normalizeMentionsMode(updates.mentionsMode)
        : existing.mentionsMode;

    const updated = {
        ...existing,
        reason: nextReason,
        mentionsMode: nextMentionsMode,
        updatedAt: Date.now()
    };

    afkMap.set(key, updated);
    return updated;
}

function clearAfk(guildId, userId) {
    const key = buildKey(guildId, userId);
    const existing = afkMap.get(key) || null;
    afkMap.delete(key);
    return existing;
}

function getAfk(guildId, userId) {
    return afkMap.get(buildKey(guildId, userId)) || null;
}

function isAfk(guildId, userId) {
    return afkMap.has(buildKey(guildId, userId));
}

function getMentionedAfkRecords(guildId, users = []) {
    const uniqueIds = new Set();
    const result = [];

    for (const user of users) {
        const userId = String(user?.id || '');
        if (!userId || uniqueIds.has(userId)) continue;
        uniqueIds.add(userId);

        const record = getAfk(guildId, userId);
        if (!record) continue;

        result.push({
            userId,
            reason: record.reason,
            since: record.since,
            mentionsMode: normalizeMentionsMode(record.mentionsMode)
        });
    }

    return result;
}

module.exports = {
    setAfk,
    updateAfk,
    clearAfk,
    getAfk,
    isAfk,
    getMentionedAfkRecords,
    normalizeReason,
    normalizeMentionsMode,
    DEFAULT_REASON,
    DEFAULT_MENTIONS_MODE,
    VALID_MENTIONS_MODES
};