function truncateText(value, max = 1024) {
    const text = String(value ?? '').trim();
    if (!text) return 'N/A';
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(1, max - 3))}...`;
}

const LOG_COLORS = {
    CREATE: '#43B581',
    UPDATE: '#FAA61A',
    DELETE: '#ED4245',
    INFO: '#5865F2'
};

function buildFooter(scope, action) {
    return `${scope} • ${action}`;
}

function formatId(id) {
    return `\`${String(id || 'Unknown')}\``;
}

function formatTimestamp(dateLike, style = 'F') {
    if (!dateLike) return 'Unknown';
    const date = new Date(dateLike);
    if (Number.isNaN(date.getTime())) return 'Unknown';
    return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

function boolText(value) {
    return value ? 'Yes' : 'No';
}

function listChanges(changes, max = 8) {
    if (!Array.isArray(changes) || !changes.length) return 'No significant changes detected.';
    const shown = changes.slice(0, max).map((item) => `• ${item}`);
    const remaining = changes.length - shown.length;
    if (remaining > 0) shown.push(`• ...and ${remaining} more changes`);
    return truncateText(shown.join('\n'), 1024);
}

module.exports = {
    truncateText,
    formatId,
    formatTimestamp,
    boolText,
    listChanges,
    LOG_COLORS,
    buildFooter
};