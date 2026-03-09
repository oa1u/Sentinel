const { EmbedBuilder, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
const MySQLDatabaseManager = require('../Functions/MySQLDatabaseManager');
const { ROLES: { administratorRoleId, moderatorRoleId }, CHANNELS: { serverLogChannelId }, BLOCKED_WORDS: blockedWordsList } = require('../Config/constants');
const { createProfanityMatcher } = require('../Functions/ProfanityFilter');
const ModerationApiHelper = require('../Functions/ModerationApiHelper');
const mainConfig = require('../Config/main.json');

// AutoMod: watches for spam, blocked words, invite links and other rule violations.
// Automatically warns or mutes users when they break server rules.


const AUTOMOD_CONFIG_PATH = path.join(__dirname, '..', 'Config', 'constants', 'automod.json');

const DEFAULT_AUTOMOD_CONFIG = {
    blockInvites: true,
    profanityFilterEnabled: true,
    maxMentions: 6,
    spamThreshold: 5,
    spamWindow: 5000,
    capsThreshold: 0.70,
    minLengthForCaps: 10,
    spamTimeout: 10 * 60 * 1000,
    spamWarningThreshold: 2,
    similarityWindowMs: 120000,
    similarityThreshold: 0.88,
    similarityMinLength: 12,
    similarityRepeatThreshold: 3,
    riskWarnThreshold: 20,
    riskDeleteThreshold: 35,
    riskTimeoutThreshold: 60,
    baseTimeoutMs: 10 * 60 * 1000,
    maxTimeoutMs: 6 * 60 * 60 * 1000
};

const DEFAULT_ADVANCED_AUTOMOD_CONFIG = {
    exemptChannelIds: [],
    exemptRoleIds: [],
    inviteAllowlistGuildIds: [],
    blockedRegexPatterns: [],
    escalationThreshold24h: 4,
    escalationTimeoutMs: 30 * 60 * 1000,
    progressiveTimeoutMultiplier: 1.4,
    kickThreshold24h: 14,
    regexMaxPatternLength: 180,
    riskWeights: {
        spam: 28,
        similarity: 30,
        caps: 14,
        profanity: 26,
        regex: 34,
        invites: 30,
        mentions: 18
    }
};

let cachedAutoModConfig = null;
let cachedAutoModConfigAt = 0;

function compileBlockedRegexList(patterns, advancedConfig) {
    const maxPatternLength = Number.isFinite(Number(advancedConfig?.regexMaxPatternLength))
        ? Number(advancedConfig.regexMaxPatternLength)
        : DEFAULT_ADVANCED_AUTOMOD_CONFIG.regexMaxPatternLength;
    const invalidPatterns = [];

    const compiled = patterns
        .map((pattern) => {
            const source = String(pattern || '').trim();
            const qualityIssue = evaluateRegexQuality(source, maxPatternLength);
            if (qualityIssue) {
                invalidPatterns.push({ pattern: source, reason: qualityIssue });
                return null;
            }

            try {
                return { source, regex: new RegExp(source, 'i') };
            } catch (_) {
                invalidPatterns.push({ pattern: source, reason: 'Regex parse error' });
                return null;
            }
        })
        .filter(Boolean);

    if (invalidPatterns.length) {
        console.warn(`[AutoMod] Skipped ${invalidPatterns.length} invalid blocked regex pattern(s).`);
    }

    return {
        compiled,
        invalidPatterns,
        maxPatternLength
    };
}

function evaluateRegexQuality(pattern, maxPatternLength) {
    if (!pattern) return 'Pattern is empty';
    if (pattern.length > maxPatternLength) return `Pattern exceeds ${maxPatternLength} characters`;
    if (pattern === '.*' || pattern === '.+') return 'Pattern is too broad';
    if (/\(\.\*\)\{2,\}/.test(pattern) || /\(\.\+\)\{2,\}/.test(pattern)) {
        return 'Pattern likely causes catastrophic backtracking';
    }
    if (/(\(\?:?\.?\*\)){3,}/.test(pattern)) {
        return 'Pattern contains repeated broad wildcards';
    }
    return null;
}

function getRiskWeight(type, advancedConfig) {
    const fromConfig = advancedConfig?.riskWeights?.[type];
    if (Number.isFinite(Number(fromConfig))) {
        return Number(fromConfig);
    }
    return DEFAULT_ADVANCED_AUTOMOD_CONFIG.riskWeights[type] || 10;
}

function getSeverityRiskMultiplier(severity) {
    const normalized = String(severity || '').toLowerCase();
    if (normalized === 'critical') return 1.8;
    if (normalized === 'high') return 1.4;
    if (normalized === 'medium') return 1.1;
    if (normalized === 'low') return 0.85;
    return 1;
}

function resolveRiskLevel(riskScore, automodConfig) {
    const timeoutThreshold = Number(automodConfig.riskTimeoutThreshold) || DEFAULT_AUTOMOD_CONFIG.riskTimeoutThreshold;
    const deleteThreshold = Number(automodConfig.riskDeleteThreshold) || DEFAULT_AUTOMOD_CONFIG.riskDeleteThreshold;
    if (riskScore >= timeoutThreshold + 20) return 'critical';
    if (riskScore >= timeoutThreshold) return 'high';
    if (riskScore >= deleteThreshold) return 'medium';
    return 'low';
}

function normalizeSimilarityText(content) {
    return String(content || '')
        .toLowerCase()
        .replace(/<@!?\d+>|<#\d+>|<@&\d+>/g, ' ')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildBigrams(text) {
    const normalized = String(text || '');
    if (normalized.length < 2) return [];
    const result = [];
    for (let index = 0; index < normalized.length - 1; index += 1) {
        result.push(normalized.slice(index, index + 2));
    }
    return result;
}

function computeDiceSimilarity(first, second) {
    if (!first || !second) return 0;
    if (first === second) return 1;

    const firstBigrams = buildBigrams(first);
    const secondBigrams = buildBigrams(second);
    if (!firstBigrams.length || !secondBigrams.length) return 0;

    const secondCounts = new Map();
    secondBigrams.forEach((gram) => {
        secondCounts.set(gram, (secondCounts.get(gram) || 0) + 1);
    });

    let overlap = 0;
    firstBigrams.forEach((gram) => {
        const count = secondCounts.get(gram) || 0;
        if (count > 0) {
            overlap += 1;
            secondCounts.set(gram, count - 1);
        }
    });

    return (2 * overlap) / (firstBigrams.length + secondBigrams.length);
}

function resolveAppealLink() {
    const appealLink = String(mainConfig?.AppealLink || '').trim();
    if (!appealLink || appealLink === '#') return null;
    return appealLink;
}

function formatActionLabel(actionTaken, timeoutMs) {
    if (actionTaken === 'timeout' && timeoutMs > 0) {
        const minutes = Math.max(1, Math.round(timeoutMs / 60000));
        return `Timeout (${minutes} minute${minutes === 1 ? '' : 's'})`;
    }
    if (actionTaken === 'kick') return 'Kick';
    if (actionTaken === 'delete') return 'Message deleted';
    return 'Warning';
}

function createCaseId() {
    return `AUTOMOD-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function pickPrimarySignal(signals) {
    if (!Array.isArray(signals) || !signals.length) return null;
    return signals
        .slice()
        .sort((first, second) => Number(second.score || 0) - Number(first.score || 0))[0];
}

function determineBaseAction(riskScore, automodConfig) {
    const timeoutThreshold = Number(automodConfig.riskTimeoutThreshold) || DEFAULT_AUTOMOD_CONFIG.riskTimeoutThreshold;
    const deleteThreshold = Number(automodConfig.riskDeleteThreshold) || DEFAULT_AUTOMOD_CONFIG.riskDeleteThreshold;
    const warnThreshold = Number(automodConfig.riskWarnThreshold) || DEFAULT_AUTOMOD_CONFIG.riskWarnThreshold;

    if (riskScore >= timeoutThreshold) return 'timeout';
    if (riskScore >= deleteThreshold) return 'delete';
    if (riskScore >= warnThreshold) return 'warn';
    return 'warn';
}

function determineProgressiveAction({ baseAction, priorViolations24h, automodConfig, advancedConfig }) {
    const violationCount = Math.max(0, Number(priorViolations24h) || 0);
    const baseTimeoutMs = Number(automodConfig.baseTimeoutMs) || DEFAULT_AUTOMOD_CONFIG.baseTimeoutMs;
    const maxTimeoutMs = Number(automodConfig.maxTimeoutMs) || DEFAULT_AUTOMOD_CONFIG.maxTimeoutMs;
    const multiplier = Number(advancedConfig.progressiveTimeoutMultiplier) || DEFAULT_ADVANCED_AUTOMOD_CONFIG.progressiveTimeoutMultiplier;
    const kickThreshold = Number(advancedConfig.kickThreshold24h) || DEFAULT_ADVANCED_AUTOMOD_CONFIG.kickThreshold24h;

    const escalationTier = Math.floor(violationCount / 3);
    const timeoutMs = Math.min(maxTimeoutMs, Math.round(baseTimeoutMs * (multiplier ** escalationTier)));

    let action = baseAction;
    if (action === 'warn' && violationCount >= Number(advancedConfig.escalationThreshold24h || 0)) {
        action = 'delete';
    }
    if ((action === 'delete' || action === 'timeout') && violationCount >= Number(advancedConfig.escalationThreshold24h || 0)) {
        action = 'timeout';
    }
    if (action === 'timeout' && violationCount >= kickThreshold) {
        action = 'kick';
    }

    return {
        action,
        timeoutMs: action === 'timeout' ? Math.max(5 * 60 * 1000, timeoutMs) : 0,
        escalationTier
    };
}

const APPEAL_LINK = resolveAppealLink();

function readAutoModConfigSafe() {
    try {
        const raw = fs.readFileSync(AUTOMOD_CONFIG_PATH, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        console.error('[AutoMod] Failed to read automod config, using defaults:', error.message);
        return {};
    }
}

function buildEffectiveConfig(rawConfig) {
    const profileName = rawConfig?.autoModProfiles?.activeProfile;
    const profile = profileName && rawConfig?.autoModProfiles?.profiles
        ? rawConfig.autoModProfiles.profiles[profileName]
        : null;

    const mergedAutoMod = {
        ...(rawConfig?.autoMod || {}),
        ...((profile && profile.autoMod) || {})
    };

    const mergedAdvanced = {
        ...(rawConfig?.autoModAdvanced || {}),
        ...((profile && profile.autoModAdvanced) || {})
    };

    const automodConfig = {
        blockInvites: profile?.blockExternalInvites !== undefined
            ? Boolean(profile.blockExternalInvites)
            : (rawConfig.blockExternalInvites !== undefined ? Boolean(rawConfig.blockExternalInvites) : DEFAULT_AUTOMOD_CONFIG.blockInvites),
        profanityFilterEnabled: mergedAutoMod.profanityFilterEnabled !== undefined
            ? Boolean(mergedAutoMod.profanityFilterEnabled)
            : DEFAULT_AUTOMOD_CONFIG.profanityFilterEnabled,
        maxMentions: Number.isFinite(Number(profile?.maxMentionsBeforeFlag))
            ? Number(profile.maxMentionsBeforeFlag)
            : (Number.isFinite(Number(rawConfig.maxMentionsBeforeFlag)) ? Number(rawConfig.maxMentionsBeforeFlag) : DEFAULT_AUTOMOD_CONFIG.maxMentions),
        spamThreshold: Number.isFinite(Number(mergedAutoMod.spamThreshold)) ? Number(mergedAutoMod.spamThreshold) : DEFAULT_AUTOMOD_CONFIG.spamThreshold,
        spamWindow: Number.isFinite(Number(mergedAutoMod.spamWindow)) ? Number(mergedAutoMod.spamWindow) : DEFAULT_AUTOMOD_CONFIG.spamWindow,
        capsThreshold: Number.isFinite(Number(mergedAutoMod.capsThreshold)) ? Number(mergedAutoMod.capsThreshold) : DEFAULT_AUTOMOD_CONFIG.capsThreshold,
        minLengthForCaps: Number.isFinite(Number(mergedAutoMod.minLengthForCaps)) ? Number(mergedAutoMod.minLengthForCaps) : DEFAULT_AUTOMOD_CONFIG.minLengthForCaps,
        spamTimeout: Number.isFinite(Number(mergedAutoMod.spamTimeout)) ? Number(mergedAutoMod.spamTimeout) : DEFAULT_AUTOMOD_CONFIG.spamTimeout,
        spamWarningThreshold: Number.isFinite(Number(mergedAutoMod.spamWarningThreshold)) ? Number(mergedAutoMod.spamWarningThreshold) : DEFAULT_AUTOMOD_CONFIG.spamWarningThreshold
    };

    const advancedConfig = {
        exemptChannelIds: Array.isArray(mergedAdvanced.exemptChannelIds) ? mergedAdvanced.exemptChannelIds : DEFAULT_ADVANCED_AUTOMOD_CONFIG.exemptChannelIds,
        exemptRoleIds: Array.isArray(mergedAdvanced.exemptRoleIds) ? mergedAdvanced.exemptRoleIds : DEFAULT_ADVANCED_AUTOMOD_CONFIG.exemptRoleIds,
        inviteAllowlistGuildIds: Array.isArray(mergedAdvanced.inviteAllowlistGuildIds) ? mergedAdvanced.inviteAllowlistGuildIds : DEFAULT_ADVANCED_AUTOMOD_CONFIG.inviteAllowlistGuildIds,
        blockedRegexPatterns: Array.isArray(mergedAdvanced.blockedRegexPatterns) ? mergedAdvanced.blockedRegexPatterns : DEFAULT_ADVANCED_AUTOMOD_CONFIG.blockedRegexPatterns,
        escalationThreshold24h: Number.isFinite(Number(mergedAdvanced.escalationThreshold24h)) ? Number(mergedAdvanced.escalationThreshold24h) : DEFAULT_ADVANCED_AUTOMOD_CONFIG.escalationThreshold24h,
        escalationTimeoutMs: Number.isFinite(Number(mergedAdvanced.escalationTimeoutMs)) ? Number(mergedAdvanced.escalationTimeoutMs) : DEFAULT_ADVANCED_AUTOMOD_CONFIG.escalationTimeoutMs,
        progressiveTimeoutMultiplier: Number.isFinite(Number(mergedAdvanced.progressiveTimeoutMultiplier)) ? Number(mergedAdvanced.progressiveTimeoutMultiplier) : DEFAULT_ADVANCED_AUTOMOD_CONFIG.progressiveTimeoutMultiplier,
        kickThreshold24h: Number.isFinite(Number(mergedAdvanced.kickThreshold24h)) ? Number(mergedAdvanced.kickThreshold24h) : DEFAULT_ADVANCED_AUTOMOD_CONFIG.kickThreshold24h,
        regexMaxPatternLength: Number.isFinite(Number(mergedAdvanced.regexMaxPatternLength)) ? Number(mergedAdvanced.regexMaxPatternLength) : DEFAULT_ADVANCED_AUTOMOD_CONFIG.regexMaxPatternLength,
        riskWeights: {
            ...DEFAULT_ADVANCED_AUTOMOD_CONFIG.riskWeights,
            ...((mergedAdvanced.riskWeights && typeof mergedAdvanced.riskWeights === 'object') ? mergedAdvanced.riskWeights : {})
        }
    };

    const similarityWindowMs = Number.isFinite(Number(mergedAutoMod.similarityWindowMs)) ? Number(mergedAutoMod.similarityWindowMs) : DEFAULT_AUTOMOD_CONFIG.similarityWindowMs;
    const similarityThreshold = Number.isFinite(Number(mergedAutoMod.similarityThreshold)) ? Number(mergedAutoMod.similarityThreshold) : DEFAULT_AUTOMOD_CONFIG.similarityThreshold;
    const similarityMinLength = Number.isFinite(Number(mergedAutoMod.similarityMinLength)) ? Number(mergedAutoMod.similarityMinLength) : DEFAULT_AUTOMOD_CONFIG.similarityMinLength;
    const similarityRepeatThreshold = Number.isFinite(Number(mergedAutoMod.similarityRepeatThreshold)) ? Number(mergedAutoMod.similarityRepeatThreshold) : DEFAULT_AUTOMOD_CONFIG.similarityRepeatThreshold;
    const riskWarnThreshold = Number.isFinite(Number(mergedAutoMod.riskWarnThreshold)) ? Number(mergedAutoMod.riskWarnThreshold) : DEFAULT_AUTOMOD_CONFIG.riskWarnThreshold;
    const riskDeleteThreshold = Number.isFinite(Number(mergedAutoMod.riskDeleteThreshold)) ? Number(mergedAutoMod.riskDeleteThreshold) : DEFAULT_AUTOMOD_CONFIG.riskDeleteThreshold;
    const riskTimeoutThreshold = Number.isFinite(Number(mergedAutoMod.riskTimeoutThreshold)) ? Number(mergedAutoMod.riskTimeoutThreshold) : DEFAULT_AUTOMOD_CONFIG.riskTimeoutThreshold;
    const baseTimeoutMs = Number.isFinite(Number(mergedAutoMod.baseTimeoutMs)) ? Number(mergedAutoMod.baseTimeoutMs) : DEFAULT_AUTOMOD_CONFIG.baseTimeoutMs;
    const maxTimeoutMs = Number.isFinite(Number(mergedAutoMod.maxTimeoutMs)) ? Number(mergedAutoMod.maxTimeoutMs) : DEFAULT_AUTOMOD_CONFIG.maxTimeoutMs;

    automodConfig.similarityWindowMs = Math.max(10000, similarityWindowMs);
    automodConfig.similarityThreshold = Math.min(0.99, Math.max(0.5, similarityThreshold));
    automodConfig.similarityMinLength = Math.max(4, similarityMinLength);
    automodConfig.similarityRepeatThreshold = Math.max(2, similarityRepeatThreshold);
    automodConfig.riskWarnThreshold = Math.max(1, riskWarnThreshold);
    automodConfig.riskDeleteThreshold = Math.max(automodConfig.riskWarnThreshold, riskDeleteThreshold);
    automodConfig.riskTimeoutThreshold = Math.max(automodConfig.riskDeleteThreshold, riskTimeoutThreshold);
    automodConfig.baseTimeoutMs = Math.max(60 * 1000, baseTimeoutMs);
    automodConfig.maxTimeoutMs = Math.max(automodConfig.baseTimeoutMs, maxTimeoutMs);

    const regexBundle = compileBlockedRegexList(advancedConfig.blockedRegexPatterns, advancedConfig);

    return {
        profileName: profileName || 'base',
        automodConfig,
        advancedConfig,
        blockedRegexList: regexBundle.compiled,
        regexQuality: {
            invalidPatterns: regexBundle.invalidPatterns,
            validPatternCount: regexBundle.compiled.length,
            maxPatternLength: regexBundle.maxPatternLength
        }
    };
}

function getRuntimeAutoModConfig() {
    const now = Date.now();
    if (cachedAutoModConfig && now - cachedAutoModConfigAt < 5000) {
        return cachedAutoModConfig;
    }

    cachedAutoModConfig = buildEffectiveConfig(readAutoModConfigSafe());
    cachedAutoModConfigAt = now;
    return cachedAutoModConfig;
}

// Load blocked words and phrases from the config.
const profanityMatcher = createProfanityMatcher(blockedWordsList);
const inviteRegex = /(https?:\/\/)?(www\.)?(discord\.gg|discord\.com\/invite)\/([A-Za-z0-9-]+)/gi;

// Track recent message timestamps per user to detect spam; periodically prune old entries.
const userMessageTimestamps = new Map();
const userRecentNormalizedMessages = new Map();
const userNotificationCooldowns = new Map();
const USER_AUTOMOD_ALERT_COOLDOWN_MS = 45 * 1000;

// Purge stale spam timestamps to keep memory usage reasonable.
function cleanupSpamData() {
    const now = Date.now();
    const runtime = getRuntimeAutoModConfig();
    const timeout = runtime.automodConfig.spamWindow * 2;
    const similarityWindow = runtime.automodConfig.similarityWindowMs * 2;

    for (const [userId, timestamps] of userMessageTimestamps.entries()) {
        const validTimestamps = timestamps.filter(ts => now - ts < timeout);

        if (validTimestamps.length === 0) {
            userMessageTimestamps.delete(userId);
        } else {
            userMessageTimestamps.set(userId, validTimestamps);
        }
    }

    for (const [userId, messages] of userRecentNormalizedMessages.entries()) {
        const validMessages = messages.filter(entry => now - entry.at < similarityWindow);
        if (!validMessages.length) {
            userRecentNormalizedMessages.delete(userId);
        } else {
            userRecentNormalizedMessages.set(userId, validMessages);
        }
    }

    for (const [cooldownKey, timestamp] of userNotificationCooldowns.entries()) {
        if (now - Number(timestamp || 0) >= USER_AUTOMOD_ALERT_COOLDOWN_MS * 2) {
            userNotificationCooldowns.delete(cooldownKey);
        }
    }
}

// Run cleanup periodically to prevent unbounded memory growth.
setInterval(cleanupSpamData, 5 * 60 * 1000);

async function handleMessageCreate(message, client) {
    // Ignore bots and direct messages — moderation only runs inside guilds.
    if (!message || message.author?.bot) return;
    if (!message.guild) return;

    const member = message.member;
    // If you're staff, you skip all filters. We trust you!
    const isStaff = member?.roles.cache.has(administratorRoleId) || member?.roles.cache.has(moderatorRoleId);
    if (isStaff) return;
    const runtimeConfig = getRuntimeAutoModConfig();
    if (runtimeConfig.advancedConfig.exemptChannelIds.includes(message.channelId)) return;
    if (member?.roles?.cache && runtimeConfig.advancedConfig.exemptRoleIds.some(roleId => member.roles.cache.has(roleId))) return;

    try {
        const violation = await detectViolation(message, client, runtimeConfig);

        if (violation) {
            await handleViolation(message, client, violation, runtimeConfig);
        }
    } catch (error) {
        console.error('[AutoMod] Error processing message:', error);
    }
}

module.exports = {
    name: 'messageCreate',
    runOnce: false,
    disabled: true,
    call: async (client, args) => {
        const [message] = args;
        return handleMessageCreate(message, client);
    },
    handleMessageCreate
};

// Check the message for anything that breaks server rules.
async function detectViolation(message, client, runtimeConfig) {
    const content = message.content || '';
    const signals = [];

    const spamSignal = detectSpam(message, runtimeConfig.automodConfig, runtimeConfig.advancedConfig);
    if (spamSignal) signals.push(spamSignal);

    const similaritySignal = detectSimilaritySpam(message, runtimeConfig.automodConfig, runtimeConfig.advancedConfig);
    if (similaritySignal) signals.push(similaritySignal);

    const capsSignal = detectExcessiveCaps(message, runtimeConfig.automodConfig, runtimeConfig.advancedConfig);
    if (capsSignal) signals.push(capsSignal);

    if (runtimeConfig.automodConfig.profanityFilterEnabled) {
        const profanitySignal = await detectProfanity(content, runtimeConfig.advancedConfig);
        if (profanitySignal) signals.push(profanitySignal);
    }

    const regexSignal = detectBlockedRegex(message.content || '', runtimeConfig.blockedRegexList, runtimeConfig.advancedConfig);
    if (regexSignal) signals.push(regexSignal);

    if (runtimeConfig.automodConfig.blockInvites) {
        const inviteSignal = await detectInvites(message, client, runtimeConfig.advancedConfig);
        if (inviteSignal) signals.push(inviteSignal);
    }

    const mentionSignal = detectMassMentions(message, runtimeConfig.automodConfig, runtimeConfig.advancedConfig);
    if (mentionSignal) signals.push(mentionSignal);

    if (!signals.length) {
        return null;
    }

    const riskScore = signals.reduce((accumulator, item) => accumulator + Number(item.score || 0), 0);
    const primarySignal = pickPrimarySignal(signals);
    const riskLevel = resolveRiskLevel(riskScore, runtimeConfig.automodConfig);

    return {
        type: primarySignal?.type || 'spam',
        reason: primarySignal?.reason || 'AutoMod risk model flagged this message',
        signals,
        riskScore,
        riskLevel,
        baseAction: determineBaseAction(riskScore, runtimeConfig.automodConfig)
    };
}

// Detect spam violations

function detectSpam(message, automodConfig, advancedConfig) {
    const userId = message.author.id;
    const now = Date.now();

    if (!userMessageTimestamps.has(userId)) {
        userMessageTimestamps.set(userId, []);
    }

    const timestamps = userMessageTimestamps.get(userId);
    timestamps.push(now);

    // Keep only recent timestamps
    const recentTimestamps = timestamps.filter(
        ts => now - ts < automodConfig.spamWindow
    );
    userMessageTimestamps.set(userId, recentTimestamps);

    if (recentTimestamps.length >= automodConfig.spamThreshold) {
        return {
            type: 'spam',
            reason: `Spam detected (${recentTimestamps.length} messages in ${automodConfig.spamWindow / 1000}s)`,
            score: getRiskWeight('spam', advancedConfig),
            details: {
                recentMessageCount: recentTimestamps.length,
                spamWindowMs: automodConfig.spamWindow
            }
        };
    }

    return null;
}

// Detect excessive caps

function detectSimilaritySpam(message, automodConfig, advancedConfig) {
    const userId = message.author.id;
    const now = Date.now();
    const normalizedContent = normalizeSimilarityText(message.content || '');

    if (!normalizedContent || normalizedContent.length < automodConfig.similarityMinLength) {
        return null;
    }

    const existing = userRecentNormalizedMessages.get(userId) || [];
    const recent = existing.filter((entry) => now - entry.at < automodConfig.similarityWindowMs);

    let similarMatches = 0;
    let highestSimilarity = 0;
    recent.forEach((entry) => {
        const similarity = computeDiceSimilarity(normalizedContent, entry.content);
        highestSimilarity = Math.max(highestSimilarity, similarity);
        if (similarity >= automodConfig.similarityThreshold) {
            similarMatches += 1;
        }
    });

    recent.push({ content: normalizedContent, at: now });
    userRecentNormalizedMessages.set(userId, recent);

    if (similarMatches + 1 >= automodConfig.similarityRepeatThreshold) {
        return {
            type: 'similarity',
            reason: `Near-duplicate spam detected (${similarMatches + 1} similar messages)`,
            score: getRiskWeight('similarity', advancedConfig),
            details: {
                similarMessages: similarMatches + 1,
                similarityWindowMs: automodConfig.similarityWindowMs,
                threshold: automodConfig.similarityThreshold,
                highestSimilarity
            }
        };
    }

    return null;
}

function detectExcessiveCaps(message, automodConfig, advancedConfig) {
    if (message.content.length < automodConfig.minLengthForCaps) {
        return null;
    }

    const capsCount = (message.content.match(/[A-Z]/g) || []).length;
    const totalLetters = (message.content.match(/[A-Za-z]/g) || []).length;

    if (totalLetters > 0 && capsCount / totalLetters > automodConfig.capsThreshold) {
        const capsPercentage = Math.round((capsCount / totalLetters) * 100);
        return {
            type: 'caps',
            reason: `Excessive caps (${capsPercentage}% caps)`,
            score: getRiskWeight('caps', advancedConfig),
            details: {
                capsPercentage
            }
        };
    }

    return null;
}

// Detect profanity

async function detectProfanity(content, advancedConfig) {
    if (!String(content || '').trim()) return null;

    const baseRisk = getRiskWeight('profanity', advancedConfig);

    if (profanityMatcher.hasEntries) {
        const matched = profanityMatcher.findMatch(content);
        if (matched) {
            const severity = matched.severity || 'medium';
            return {
                type: 'profanity',
                reason: `Inappropriate language detected (${severity})`,
                score: Math.round(baseRisk * getSeverityRiskMultiplier(severity)),
                details: {
                    source: 'blocklist',
                    matchedWord: matched.term,
                    matchType: matched.matchType,
                    severity,
                    recommendedAction: matched.action || 'warn'
                }
            };
        }
    }

    const apiResult = await ModerationApiHelper.moderateText(content);
    if (!apiResult?.triggered) return null;

    return {
        type: 'profanity',
        reason: `OpenAI moderation flagged content (${apiResult.topCategory || 'sensitive_text'})`,
        score: Math.round(baseRisk * Number(apiResult.riskMultiplier || 1)),
        details: {
            source: 'openai',
            model: apiResult.model,
            flagged: Boolean(apiResult.flagged),
            severity: apiResult.severity || 'medium',
            topCategory: apiResult.topCategory || 'unknown',
            topScore: Number(apiResult.topScore || 0),
            recommendedAction: apiResult.recommendedAction || 'warn'
        }
    };
}

function detectBlockedRegex(content, blockedRegexList, advancedConfig) {
    if (!blockedRegexList.length || !content) return null;

    const matches = blockedRegexList
        .filter((entry) => entry.regex.test(content))
        .slice(0, 3)
        .map((entry) => entry.source);

    if (matches.length) {
        return {
            type: 'regex',
            reason: 'Message matched a blocked pattern',
            score: getRiskWeight('regex', advancedConfig) + ((matches.length - 1) * 4),
            details: {
                matchedPatterns: matches
            }
        };
    }

    return null;
}

// Detect invite links

async function detectInvites(message, client, advancedConfig) {
    if (!/(discord\.gg|discord\.com\/invite)\//i.test(message.content)) {
        return null;
    }

    const codes = Array.from(message.content.matchAll(inviteRegex))
        .map(m => m[4])
        .filter(Boolean);

    for (const code of codes) {
        try {
            const invite = await client.fetchInvite(code).catch(() => null);

            // No invite found or external invite
            if (!invite) {
                return {
                    type: 'invites',
                    reason: 'External invite link detected',
                    score: getRiskWeight('invites', advancedConfig)
                };
            }

            if (invite.guild?.id && invite.guild.id !== message.guild.id) {
                if (advancedConfig.inviteAllowlistGuildIds.includes(invite.guild.id)) {
                    continue;
                }
                return {
                    type: 'invites',
                    reason: 'External invite link detected',
                    score: getRiskWeight('invites', advancedConfig)
                };
            }
        } catch (err) {
            // Error fetching = assume external for safety
            return {
                type: 'invites',
                reason: 'External invite link detected',
                score: getRiskWeight('invites', advancedConfig)
            };
        }
    }

    return null;
}

// Detect mass mentions
function detectMassMentions(message, automodConfig, advancedConfig) {
    const mentionCount = (message.mentions.users.size || 0) + (message.mentions.roles.size || 0);

    if (automodConfig.maxMentions > 0 && mentionCount >= automodConfig.maxMentions) {
        return {
            type: 'mentions',
            reason: `Mass mentions (${mentionCount} mentions)`,
            score: getRiskWeight('mentions', advancedConfig),
            details: {
                mentionCount
            }
        };
    }

    return null;
}

// Handle the violation
async function handleViolation(message, client, violation, runtimeConfig) {
    const { type, reason, signals = [], riskScore = 0, riskLevel = 'low', baseAction = 'warn' } = violation;
    const { automodConfig, advancedConfig } = runtimeConfig;
    const userId = message.author.id;
    const caseId = createCaseId();

    let priorViolations24h = 0;
    try {
        const prior = await MySQLDatabaseManager.getAutomodViolations(userId, 24);
        priorViolations24h = Array.isArray(prior) ? prior.length : 0;
    } catch (historyError) {
        console.warn(`[AutoMod] Could not read violation history: ${historyError.message}`);
    }

    const progressive = determineProgressiveAction({
        baseAction,
        priorViolations24h,
        automodConfig,
        advancedConfig
    });

    const appealEligible = ['delete', 'timeout', 'kick', 'ban'].includes(progressive.action);
    let actionTaken = progressive.action;
    let timeoutMs = progressive.timeoutMs;

    // Delete the triggering message for all actionable signals.
    try {
        await message.delete();
    } catch (err) {
        console.error(`[AutoMod] Failed to delete message: ${err.message}`);
    }

    if (actionTaken === 'timeout') {
        try {
            if (!message.member?.moderatable) throw new Error('Member is not moderatable');
            await message.member.timeout(timeoutMs, `AutoMod: ${reason}`);
            await MySQLDatabaseManager.connection.query(
                `INSERT INTO timeouts (user_id, username, case_id, reason, issued_at, expires_at, issued_by, active)
                 VALUES (?, ?, ?, ?, NOW(), ?, 'AutoMod', TRUE)`,
                [
                    userId,
                    message.author.username,
                    caseId,
                    `AutoMod: ${reason}`,
                    Date.now() + timeoutMs
                ]
            );
        } catch (err) {
            console.error(`[AutoMod] Timeout action failed: ${err.message}`);
            actionTaken = 'delete';
            timeoutMs = 0;
        }
    }

    if (actionTaken === 'kick') {
        try {
            if (!message.member?.kickable) throw new Error('Member is not kickable');
            await message.member.kick(`AutoMod: ${reason}`);
        } catch (kickError) {
            console.error(`[AutoMod] Kick action failed: ${kickError.message}`);
            actionTaken = 'timeout';
            timeoutMs = Math.max(5 * 60 * 1000, Number(advancedConfig.escalationTimeoutMs) || DEFAULT_ADVANCED_AUTOMOD_CONFIG.escalationTimeoutMs);
            try {
                if (!message.member?.moderatable) throw new Error('Member is not moderatable');
                await message.member.timeout(timeoutMs, `AutoMod fallback timeout: ${reason}`);
            } catch (timeoutError) {
                console.error(`[AutoMod] Fallback timeout after kick failure failed: ${timeoutError.message}`);
                actionTaken = 'delete';
                timeoutMs = 0;
            }
        }
    }

    try {
        await MySQLDatabaseManager.logAutomodViolation(
            userId,
            message.guild.id,
            type,
            (message.content || '').slice(0, 1000),
            message.channel.id,
            actionTaken,
            {
                riskScore,
                riskLevel,
                signalCount: signals.length,
                appealNotified: Boolean(appealEligible && APPEAL_LINK),
                metadata: {
                    caseId,
                    baseAction,
                    appliedAction: actionTaken,
                    escalationTier: progressive.escalationTier,
                    priorViolations24h,
                    timeoutMs,
                    regexQuality: runtimeConfig.regexQuality,
                    signals: signals.map(signal => ({
                        type: signal.type,
                        reason: signal.reason,
                        score: signal.score,
                        details: signal.details || {}
                    }))
                }
            }
        );
    } catch (err) {
        console.warn(`[AutoMod] Could not log violation: ${err.message}`);
    }

    sendUserNotification(message, {
        reason,
        violationType: type,
        caseId,
        actionTaken,
        timeoutMs,
        riskScore,
        riskLevel,
        priorViolations24h,
        signalCount: signals.length,
        appealLink: APPEAL_LINK,
        appealEligible
    });

    logToServerChannel(message, client, {
        reason,
        violationType: type,
        caseId,
        actionTaken,
        timeoutMs,
        riskScore,
        riskLevel,
        priorViolations24h,
        signalCount: signals.length,
        appealNotified: Boolean(appealEligible && APPEAL_LINK)
    });
}

// Send DM to violating user
function sendUserNotification(message, context) {
    const {
        reason,
        violationType,
        caseId,
        actionTaken,
        timeoutMs,
        riskScore,
        riskLevel,
        priorViolations24h,
        signalCount,
        appealLink,
        appealEligible
    } = context;

    const notificationKey = `${message.author.id}:${String(violationType || 'unknown').toLowerCase()}:${String(actionTaken || 'warn').toLowerCase()}`;
    const lastNotifiedAt = Number(userNotificationCooldowns.get(notificationKey) || 0);
    const now = Date.now();
    if (lastNotifiedAt && (now - lastNotifiedAt) < USER_AUTOMOD_ALERT_COOLDOWN_MS) {
        return;
    }
    userNotificationCooldowns.set(notificationKey, now);

    const actionLabel = formatActionLabel(actionTaken, timeoutMs);
    const fields = [
        { name: '📌 Reason', value: `\`${reason}\``, inline: false },
        { name: '🏷️ Violation Type', value: `\`${violationType}\``, inline: true },
        { name: '📋 Case ID', value: `\`${caseId}\``, inline: true },
        { name: '⚡ Action', value: actionLabel, inline: true },
        { name: '📈 Risk', value: `Score ${Math.round(Number(riskScore || 0))} (${String(riskLevel || 'low').toUpperCase()})`, inline: true },
        { name: '📊 Signals', value: `${Math.max(1, Number(signalCount || 1))} triggered`, inline: true },
        { name: '🕒 Recent History', value: `${Math.max(0, Number(priorViolations24h || 0))} violation(s) in 24h`, inline: true }
    ];

    let embedDescription = 'Your message triggered AutoMod enforcement.';
    let color = 0xFF6B6B;
    if (actionTaken === 'timeout') {
        color = 0xFFA500;
        embedDescription = 'You were timed out due to repeated or high-risk violations.';
    } else if (actionTaken === 'kick') {
        color = 0xFF4444;
        embedDescription = 'You were removed from the server due to repeated high-risk violations.';
    }

    if (appealEligible && appealLink) {
        fields.push({
            name: '📝 Appeal',
            value: `[Submit an appeal](${appealLink}) if you believe this action was incorrect.`,
            inline: false
        });
    }

    fields.push({ name: '💡 Tip', value: 'Please review the server rules to avoid future violations.', inline: false });

    const userEmbed = new EmbedBuilder()
        .setColor(color)
        .setAuthor({ name: '⚠️ AutoMod Alert', iconURL: message.guild.iconURL() })
        .setDescription(embedDescription)
        .addFields(fields)
        .setFooter({ text: message.guild.name })
        .setTimestamp();

    message.author.send({ embeds: [userEmbed] }).catch(err => {
        if (message.channel.send) {
            message.channel.send({
                embeds: [userEmbed],
                flags: MessageFlags.SuppressNotifications
            }).then(msg => {
                setTimeout(() => msg.delete().catch(() => { }), 8000);
            }).catch(() => { });
        }
    });
}

// Log violation to server log channel
function logToServerChannel(message, client, context) {
    const {
        reason,
        violationType,
        caseId,
        actionTaken,
        timeoutMs,
        riskScore,
        riskLevel,
        priorViolations24h,
        signalCount,
        appealNotified
    } = context;

    const logChannel = message.guild.channels.cache.get(serverLogChannelId);
    if (!logChannel) {
        console.warn('[AutoMod] Server log channel not found');
        return;
    }

    const logEmbed = new EmbedBuilder()
        .setColor(0xFF4444)
        .setAuthor({ name: '🛡️ AutoMod Detection', iconURL: client.user.displayAvatarURL() })
        .setTitle('Message Filtered')
        .setDescription(`A message was automatically removed for violating server rules.`)
        .addFields(
            { name: '👤 User', value: `${message.author} (${message.author.tag})\n\`${message.author.id}\``, inline: true },
            { name: '📍 Channel', value: `${message.channel}\n\`#${message.channel.name}\``, inline: true },
            { name: '⚡ Action', value: `\`${formatActionLabel(actionTaken, timeoutMs)}\``, inline: true },
            { name: '📈 Risk', value: `\`${Math.round(Number(riskScore || 0))}\` (${String(riskLevel || 'low').toUpperCase()})`, inline: true },
            { name: '📊 Signals', value: `\`${Math.max(1, Number(signalCount || 1))}\``, inline: true },
            { name: '🕒 Prior 24h', value: `\`${Math.max(0, Number(priorViolations24h || 0))}\``, inline: true },
            { name: '📝 Appeal Notified', value: appealNotified ? 'Yes' : 'No', inline: true },
            { name: '⚠️ Reason', value: `\`\`\`${reason}\`\`\``, inline: false },
            { name: '🏷️ Violation Type', value: `\`${violationType}\``, inline: true },
            { name: '📋 Case ID', value: `\`${caseId}\``, inline: true },
            { name: '📝 Message Content', value: message.content ? `\`\`\`${message.content.slice(0, 500)}\`\`\`` : '`(no text content)`', inline: false }
        )
        .setFooter({ text: `User ID: ${message.author.id}` })
        .setTimestamp();

    logChannel.send({ embeds: [logEmbed] }).catch(err => {
        console.error(`[AutoMod] Failed to log to server channel: ${err.message}`);
    });
}