function escapeRegex(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSeverity(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'critical') {
        return normalized;
    }
    return 'medium';
}

function normalizeAction(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'warn' || normalized === 'delete' || normalized === 'timeout') {
        return normalized;
    }
    return 'warn';
}

function normalizeBaseText(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

function normalizeLeetspeak(value) {
    const map = {
        '@': 'a',
        '$': 's',
        '0': 'o',
        '1': 'i',
        '!': 'i',
        '3': 'e',
        '4': 'a',
        '5': 's',
        '7': 't',
        '8': 'b',
        '9': 'g'
    };

    return String(value || '').replace(/[@$01345789!]/g, (char) => map[char] || char);
}

function normalizeProfanityText(value) {
    const base = normalizeLeetspeak(normalizeBaseText(value));
    const normalized = base
        .replace(/[_\-.,/\\|()[\]{}<>~^`"':;]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const compact = normalized.replace(/[^a-z0-9]/g, '');
    const collapsed = compact.replace(/(.)\1{2,}/g, '$1$1');

    return {
        normalized,
        compact,
        collapsed
    };
}

function toMatcherEntry(entry) {
    if (entry === null || entry === undefined) return null;

    let metadata = {
        severity: 'medium',
        action: 'warn'
    };

    if (typeof entry === 'object' && !Array.isArray(entry)) {
        metadata = {
            severity: normalizeSeverity(entry.severity),
            action: normalizeAction(entry.action)
        };
        const mode = String(entry.mode || entry.type || '').toLowerCase();

        if (mode === 'regex' && entry.pattern) {
            const source = String(entry.pattern).trim();
            if (!source) return null;

            try {
                return {
                    mode: 'regex',
                    original: source,
                    regex: new RegExp(source, 'i'),
                    ...metadata
                };
            } catch (_) {
                return null;
            }
        }

        const term = String(entry.term || entry.word || entry.value || '').trim();
        if (!term) return null;
        return toMatcherEntry(term);
    }

    const raw = String(entry).trim();
    if (!raw) return null;

    if (raw.startsWith('re:')) {
        const source = raw.slice(3).trim();
        if (!source) return null;

        try {
            return {
                mode: 'regex',
                original: raw,
                regex: new RegExp(source, 'i'),
                ...metadata
            };
        } catch (_) {
            return null;
        }
    }

    if (raw.includes('*')) {
        const wildcardSource = `\\b${raw.split('*').map(escapeRegex).join('.*')}\\b`;
        try {
            return {
                mode: 'regex',
                original: raw,
                regex: new RegExp(wildcardSource, 'i'),
                ...metadata
            };
        } catch (_) {
            return null;
        }
    }

    const normalized = normalizeProfanityText(raw);
    if (!normalized.normalized) return null;

    return {
        mode: 'term',
        original: raw,
        normalized: normalized.normalized,
        compact: normalized.compact,
        collapsed: normalized.collapsed,
        ...metadata,
        useTokenBoundary: !normalized.normalized.includes(' ') && normalized.normalized.length <= 4
    };
}

function createProfanityMatcher(entries) {
    const rawEntries = Array.isArray(entries) ? entries : [];
    const prepared = rawEntries.map(toMatcherEntry).filter(Boolean);

    return {
        hasEntries: prepared.length > 0,
        size: prepared.length,
        findMatch(content) {
            if (!prepared.length) return null;

            const sourceText = String(content || '');
            if (!sourceText.trim()) return null;

            const normalizedText = normalizeProfanityText(sourceText);

            for (const entry of prepared) {
                if (entry.mode === 'regex') {
                    if (entry.regex.test(sourceText) || entry.regex.test(normalizedText.normalized)) {
                        return {
                            term: entry.original,
                            matchType: 'regex',
                            severity: entry.severity || 'medium',
                            action: entry.action || 'warn'
                        };
                    }
                    continue;
                }

                if (!entry.normalized) continue;

                if (entry.useTokenBoundary) {
                    const tokenRegex = new RegExp(`(?:^|\\b)${escapeRegex(entry.normalized)}(?:\\b|$)`, 'i');
                    if (tokenRegex.test(normalizedText.normalized)) {
                        return {
                            term: entry.original,
                            matchType: 'token',
                            severity: entry.severity || 'medium',
                            action: entry.action || 'warn'
                        };
                    }
                } else if (normalizedText.normalized.includes(entry.normalized)) {
                    return {
                        term: entry.original,
                        matchType: 'normalized',
                        severity: entry.severity || 'medium',
                        action: entry.action || 'warn'
                    };
                }

                if (entry.compact && entry.compact.length >= 4 && normalizedText.compact.includes(entry.compact)) {
                    return {
                        term: entry.original,
                        matchType: 'compact',
                        severity: entry.severity || 'medium',
                        action: entry.action || 'warn'
                    };
                }

                if (entry.collapsed && entry.collapsed.length >= 4 && normalizedText.collapsed.includes(entry.collapsed)) {
                    return {
                        term: entry.original,
                        matchType: 'collapsed',
                        severity: entry.severity || 'medium',
                        action: entry.action || 'warn'
                    };
                }
            }

            return null;
        }
    };
}

module.exports = {
    createProfanityMatcher,
    normalizeProfanityText
};