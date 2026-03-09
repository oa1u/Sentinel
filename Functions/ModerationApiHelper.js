const OPENAI_MODERATION_ENDPOINT = 'https://api.openai.com/v1/moderations';
const DEFAULT_OPENAI_MODEL = 'omni-moderation-latest';
const DEFAULT_MIN_SCORE = 0.78;
const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CACHE_MAX = 500;

function parseBoolean(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    const normalized = String(value).trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

function toFiniteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function normalizeSeverity(score) {
    if (score >= 0.93) return { severity: 'critical', riskMultiplier: 1.8, recommendedAction: 'timeout' };
    if (score >= 0.86) return { severity: 'high', riskMultiplier: 1.45, recommendedAction: 'delete' };
    if (score >= 0.72) return { severity: 'medium', riskMultiplier: 1.15, recommendedAction: 'warn' };
    return { severity: 'low', riskMultiplier: 0.9, recommendedAction: 'warn' };
}

class ModerationApiHelper {
    constructor() {
        this.openAiEnabled = parseBoolean(process.env.ENABLE_OPENAI_MODERATION, false);
        this.openAiApiKey = String(process.env.OPENAI_API_KEY || '').trim();
        this.openAiModel = String(process.env.OPENAI_MODERATION_MODEL || DEFAULT_OPENAI_MODEL).trim() || DEFAULT_OPENAI_MODEL;
        this.minScore = Math.max(0, Math.min(1, toFiniteNumber(process.env.OPENAI_MODERATION_MIN_SCORE, DEFAULT_MIN_SCORE)));
        this.timeoutMs = Math.max(500, toFiniteNumber(process.env.OPENAI_MODERATION_TIMEOUT_MS, DEFAULT_TIMEOUT_MS));
        this.cacheTtlMs = Math.max(1000, toFiniteNumber(process.env.OPENAI_MODERATION_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS));
        this.cacheMaxEntries = Math.max(50, toFiniteNumber(process.env.OPENAI_MODERATION_CACHE_MAX, DEFAULT_CACHE_MAX));
        this.cache = new Map();
    }

    refreshConfig() {
        this.openAiEnabled = parseBoolean(process.env.ENABLE_OPENAI_MODERATION, false);
        this.openAiApiKey = String(process.env.OPENAI_API_KEY || '').trim();
        this.openAiModel = String(process.env.OPENAI_MODERATION_MODEL || DEFAULT_OPENAI_MODEL).trim() || DEFAULT_OPENAI_MODEL;
        this.minScore = Math.max(0, Math.min(1, toFiniteNumber(process.env.OPENAI_MODERATION_MIN_SCORE, DEFAULT_MIN_SCORE)));
        this.timeoutMs = Math.max(500, toFiniteNumber(process.env.OPENAI_MODERATION_TIMEOUT_MS, DEFAULT_TIMEOUT_MS));
        this.cacheTtlMs = Math.max(1000, toFiniteNumber(process.env.OPENAI_MODERATION_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS));
        this.cacheMaxEntries = Math.max(50, toFiniteNumber(process.env.OPENAI_MODERATION_CACHE_MAX, DEFAULT_CACHE_MAX));
    }

    getCacheKey(text) {
        return text.toLowerCase().replace(/\s+/g, ' ').trim();
    }

    readCache(text) {
        const key = this.getCacheKey(text);
        const cached = this.cache.get(key);
        if (!cached) return null;
        if (Date.now() - cached.at > this.cacheTtlMs) {
            this.cache.delete(key);
            return null;
        }
        return cached.value;
    }

    writeCache(text, value) {
        const key = this.getCacheKey(text);
        this.cache.set(key, { at: Date.now(), value });

        if (this.cache.size <= this.cacheMaxEntries) return;

        const firstKey = this.cache.keys().next().value;
        if (firstKey) this.cache.delete(firstKey);
    }

    isEnabled() {
        this.refreshConfig();
        return this.openAiEnabled && Boolean(this.openAiApiKey);
    }

    async moderateText(content) {
        const text = String(content || '').trim();
        if (!text) return null;
        if (!this.isEnabled()) return null;

        const cached = this.readCache(text);
        if (cached) return cached;

        if (typeof fetch !== 'function') {
            const fetchUnavailable = {
                source: 'openai',
                triggered: false,
                available: false,
                error: 'Fetch API is unavailable in this Node runtime'
            };
            this.writeCache(text, fetchUnavailable);
            return fetchUnavailable;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const response = await fetch(OPENAI_MODERATION_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.openAiApiKey}`
                },
                body: JSON.stringify({
                    model: this.openAiModel,
                    input: text.slice(0, 4000)
                }),
                signal: controller.signal
            });

            if (!response.ok) {
                const body = await response.text().catch(() => '');
                const failure = {
                    source: 'openai',
                    triggered: false,
                    available: false,
                    error: `HTTP ${response.status}${body ? `: ${body.slice(0, 180)}` : ''}`
                };
                this.writeCache(text, failure);
                return failure;
            }

            const payload = await response.json();
            const result = Array.isArray(payload?.results) ? payload.results[0] : null;
            if (!result) {
                const malformed = {
                    source: 'openai',
                    triggered: false,
                    available: false,
                    error: 'Missing moderation result payload'
                };
                this.writeCache(text, malformed);
                return malformed;
            }

            const categoryScores = result.category_scores && typeof result.category_scores === 'object'
                ? result.category_scores
                : {};

            let topCategory = null;
            let topScore = 0;
            Object.entries(categoryScores).forEach(([category, score]) => {
                const numericScore = Number(score) || 0;
                if (numericScore > topScore) {
                    topScore = numericScore;
                    topCategory = category;
                }
            });

            const triggered = Boolean(result.flagged) || topScore >= this.minScore;
            const severityModel = normalizeSeverity(topScore);

            const normalized = {
                source: 'openai',
                available: true,
                triggered,
                flagged: Boolean(result.flagged),
                model: this.openAiModel,
                minScore: this.minScore,
                topCategory,
                topScore,
                categories: result.categories || {},
                categoryScores,
                severity: severityModel.severity,
                riskMultiplier: severityModel.riskMultiplier,
                recommendedAction: severityModel.recommendedAction
            };
            this.writeCache(text, normalized);
            return normalized;
        } catch (error) {
            const runtimeFailure = {
                source: 'openai',
                triggered: false,
                available: false,
                error: error?.message || String(error)
            };
            this.writeCache(text, runtimeFailure);
            return runtimeFailure;
        } finally {
            clearTimeout(timeout);
        }
    }
}

module.exports = new ModerationApiHelper();