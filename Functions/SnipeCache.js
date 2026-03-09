const SNIPES_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_CONTENT_LENGTH = 1800;

const lastDeletedByChannel = new Map();

function trimContent(text) {
    const safe = String(text || '').trim();
    if (!safe) return '';
    if (safe.length <= MAX_CONTENT_LENGTH) return safe;
    return `${safe.slice(0, MAX_CONTENT_LENGTH - 1)}…`;
}

function buildAttachmentList(attachments) {
    if (!attachments || typeof attachments.values !== 'function') return [];
    return [...attachments.values()]
        .map((attachment) => ({
            name: String(attachment?.name || 'attachment'),
            url: String(attachment?.url || '')
        }))
        .filter((item) => item.url)
        .slice(0, 5);
}

function setSnipe(message) {
    if (!message || !message.channelId || !message.author) return null;

    const record = {
        channelId: String(message.channelId),
        guildId: message.guildId ? String(message.guildId) : null,
        userId: String(message.author.id || ''),
        username: String(message.author.tag || message.author.username || 'Unknown User'),
        content: trimContent(message.content),
        attachments: buildAttachmentList(message.attachments),
        createdTimestamp: Number(message.createdTimestamp || 0) || null,
        deletedAt: Date.now()
    };

    lastDeletedByChannel.set(record.channelId, record);
    return record;
}

function getSnipe(channelId) {
    const key = String(channelId || '');
    if (!key) return null;

    const record = lastDeletedByChannel.get(key);
    if (!record) return null;

    const ageMs = Date.now() - Number(record.deletedAt || 0);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > SNIPES_TTL_MS) {
        lastDeletedByChannel.delete(key);
        return null;
    }

    return record;
}

function cleanupExpiredSnipes() {
    const now = Date.now();
    for (const [channelId, record] of lastDeletedByChannel.entries()) {
        if (!record || (now - Number(record.deletedAt || 0)) > SNIPES_TTL_MS) {
            lastDeletedByChannel.delete(channelId);
        }
    }
}

module.exports = {
    setSnipe,
    getSnipe,
    cleanupExpiredSnipes
};