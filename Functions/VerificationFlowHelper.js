const { isVerificationSessionActive } = require('./VerificationSessionManager');
const { MISC: miscConfig } = require('../Config/constants');

const verificationConfig = miscConfig?.verification || {};
const riskConfig = verificationConfig.riskBased || {};
const tierConfig = verificationConfig.tiers || {};
const CHALLENGE_TIMEOUT_MS = Math.max(60 * 1000, Number(verificationConfig.challengeTimeoutMs || 5 * 60 * 1000));
const MAX_WRONG_ATTEMPTS_PER_STEP = Math.max(1, Math.min(10, Number(verificationConfig.maxWrongAttemptsPerStep) || 3));
const STRICT_ACCOUNT_AGE_DAYS = Math.max(0, Math.min(365, Number(verificationConfig.strictAccountAgeDays) || 7));
const TIER_TIMEOUT_MULTIPLIERS = {
    1: 1,
    2: 0.9,
    3: 0.8
};
const TIER_EXTRA_STEPS = {
    1: 1,
    2: 2,
    3: 3
};
const DEFAULT_RISK_WEIGHTS = {
    youngAccount: 25,
    noAvatar: 10,
    digitHeavyName: 12,
    repeatChars: 10,
    lowEntropyName: 12,
    joinBurst: 15,
    nameCollision: 18
};
const JOIN_BURST_WINDOW_MS = Math.max(5_000, Number(riskConfig.joinBurstWindowMs || 60_000));
const RECENT_NAME_WINDOW_MS = Math.max(30_000, Number(riskConfig.recentNameWindowMs || 1_800_000));
const recentJoinState = {
    lastJoinAtByGuild: new Map(),
    recentNamesByGuild: new Map()
};

function normalizeInput(value) {
    return String(value || '').trim().toUpperCase();
}

function getVerificationRuntimeConfig() {
    return {
        challengeTimeoutMs: CHALLENGE_TIMEOUT_MS,
        maxWrongAttemptsPerStep: MAX_WRONG_ATTEMPTS_PER_STEP,
        strictAccountAgeDays: STRICT_ACCOUNT_AGE_DAYS,
        riskBased: {
            strictScoreThreshold: Math.max(1, Number(riskConfig.strictScoreThreshold || 30)),
            autoFailEnabled: riskConfig.autoFailEnabled === true,
            autoFailScoreThreshold: Math.max(1, Number(riskConfig.autoFailScoreThreshold || 80)),
            antiRaidLink: {
                enabled: riskConfig.antiRaidLink?.enabled !== false,
                forceStrictOnLockdown: riskConfig.antiRaidLink?.forceStrictOnLockdown !== false,
                autoFailOnLockdown: riskConfig.antiRaidLink?.autoFailOnLockdown === true,
                recentLockdownMs: Math.max(60_000, Number(riskConfig.antiRaidLink?.recentLockdownMs || 900_000))
            }
        },
        tiers: {
            standardRiskScoreThreshold: Math.max(1, Number(tierConfig.standardRiskScoreThreshold || 30)),
            advancedRiskScoreThreshold: Math.max(1, Number(tierConfig.advancedRiskScoreThreshold || 55)),
            timeoutMultipliers: { ...TIER_TIMEOUT_MULTIPLIERS },
            extraSteps: { ...TIER_EXTRA_STEPS }
        }
    };
}

function shouldUseStrictMode(createdTimestampMs) {
    const accountCreatedAtMs = Number(createdTimestampMs) || 0;
    if (!accountCreatedAtMs) return false;

    const accountAgeMs = Math.max(0, Date.now() - accountCreatedAtMs);
    const strictThresholdMs = STRICT_ACCOUNT_AGE_DAYS * 24 * 60 * 60 * 1000;
    return accountAgeMs < strictThresholdMs;
}

function getRiskWeight(key) {
    if (Object.prototype.hasOwnProperty.call(riskConfig.weights || {}, key)) {
        return Number(riskConfig.weights[key] || 0);
    }
    return Number(DEFAULT_RISK_WEIGHTS[key] || 0);
}

function normalizeName(input) {
    return String(input || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getDigitRatio(input) {
    const value = String(input || '');
    if (!value.length) return 0;
    const digits = value.replace(/[^0-9]/g, '').length;
    return digits / value.length;
}

function getEntropyScore(input) {
    const value = normalizeName(input);
    if (!value.length) return 0;
    const uniqueCount = new Set(value.split('')).size;
    return uniqueCount / value.length;
}

function assessVerificationRisk(member) {
    if (riskConfig.enabled === false || !member?.user) {
        return { score: 0, flags: [], shouldUseStrictMode: false, shouldAutoFail: false };
    }

    const flags = [];
    let score = 0;
    const now = Date.now();
    const accountAgeDays = Math.max(0, (now - Number(member.user.createdTimestamp || 0)) / (24 * 60 * 60 * 1000));
    const accountAgeThreshold = Math.max(0, Number(riskConfig.accountAgeDaysThreshold || 7));

    if (accountAgeDays < accountAgeThreshold) {
        score += getRiskWeight('youngAccount');
        flags.push(`young_account:${accountAgeDays.toFixed(1)}d`);
    }

    if (riskConfig.noAvatarEnabled !== false && !member.user.avatar) {
        score += getRiskWeight('noAvatar');
        flags.push('no_avatar');
    }

    const digitRatio = getDigitRatio(member.user.username);
    const digitRatioThreshold = Math.max(0, Number(riskConfig.digitRatioThreshold || 0.5));
    if (digitRatio >= digitRatioThreshold) {
        score += getRiskWeight('digitHeavyName');
        flags.push(`digit_heavy:${digitRatio.toFixed(2)}`);
    }

    const repeatThreshold = Math.max(2, Number(riskConfig.repeatCharThreshold || 4));
    const repeatRegex = new RegExp(`(.)\\1{${repeatThreshold - 1},}`);
    if (repeatRegex.test(member.user.username || '')) {
        score += getRiskWeight('repeatChars');
        flags.push('repeat_chars');
    }

    const entropy = getEntropyScore(member.user.username);
    const entropyThreshold = Math.max(0, Number(riskConfig.entropyThreshold || 0.35));
    if (entropy > 0 && entropy <= entropyThreshold) {
        score += getRiskWeight('lowEntropyName');
        flags.push(`low_entropy:${entropy.toFixed(2)}`);
    }

    const guildId = member.guild?.id || 'global';
    const lastJoinAt = recentJoinState.lastJoinAtByGuild.get(guildId) || 0;
    const joinDelta = lastJoinAt ? now - lastJoinAt : null;
    if (joinDelta !== null && joinDelta <= JOIN_BURST_WINDOW_MS) {
        score += getRiskWeight('joinBurst');
        flags.push(`join_burst:${Math.round(joinDelta / 1000)}s`);
    }
    recentJoinState.lastJoinAtByGuild.set(guildId, now);

    const normalized = normalizeName(member.user.username);
    if (riskConfig.nameCollisionEnabled !== false && normalized) {
        const recent = recentJoinState.recentNamesByGuild.get(guildId) || [];
        const cutoff = now - RECENT_NAME_WINDOW_MS;
        const filtered = recent.filter((entry) => entry && entry.at >= cutoff);
        const collision = filtered.find((entry) => entry.name === normalized);
        if (collision) {
            score += getRiskWeight('nameCollision');
            flags.push('name_collision');
        }
        filtered.push({ name: normalized, at: now });
        recentJoinState.recentNamesByGuild.set(guildId, filtered.slice(-50));
    }

    const strictScoreThreshold = Math.max(1, Number(riskConfig.strictScoreThreshold || 30));
    const autoFailScoreThreshold = Math.max(1, Number(riskConfig.autoFailScoreThreshold || 80));
    const shouldUseStrict = score >= strictScoreThreshold;
    const shouldAutoFail = riskConfig.autoFailEnabled === true && score >= autoFailScoreThreshold;

    return { score, flags, shouldUseStrictMode: shouldUseStrict, shouldAutoFail };
}

function shuffleArray(values) {
    const copy = [...values];
    for (let index = copy.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
    }
    return copy;
}

function randomIntInclusive(min, max) {
    const safeMin = Math.min(min, max);
    const safeMax = Math.max(min, max);
    return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

function buildMathChallenge(tier) {
    const limit = tier >= 3 ? 40 : tier === 2 ? 18 : 9;
    const a = randomIntInclusive(1, limit);
    const b = randomIntInclusive(1, limit);
    const c = tier >= 3 ? randomIntInclusive(1, 12) : 0;
    const answer = tier >= 3 ? a + b + c : a + b;
    const prompt = tier >= 3
        ? `What is ${a} + ${b} + ${c}?`
        : `What is ${a} + ${b}?`;
    return {
        type: 'math',
        prompt,
        answer: String(answer),
        hint: 'Add the numbers carefully and reply with digits only.'
    };
}

function buildReverseWordChallenge(tier) {
    const words = tier >= 3
        ? ['MODERATION', 'VERIFICATION', 'AUTHENTIC', 'PROTECTION']
        : tier === 2
            ? ['SECURITY', 'CHANNEL', 'HUMANITY', 'ACCESS']
            : ['SECURE', 'VERIFY', 'ACCESS', 'HUMAN', 'PANEL'];
    const selected = words[randomIntInclusive(0, words.length - 1)];
    return {
        type: 'reverse',
        prompt: `Type the word "${selected}" backwards.`,
        answer: selected.split('').reverse().join(''),
        hint: 'Letters only. Uppercase and lowercase both work.'
    };
}

function buildTokenChallenge(tier) {
    const tokenLength = tier >= 3 ? 10 : tier === 2 ? 8 : 6;
    const token = Math.random().toString(36).slice(2, 2 + tokenLength).toUpperCase();
    return {
        type: 'token',
        prompt: `Type this token exactly: ${token}`,
        answer: token,
        hint: 'Copy each character exactly as shown.'
    };
}

function buildWordPairChallenge() {
    const words = shuffleArray(['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT']).slice(0, 4);
    const answer = `${words[1]} ${words[3]}`;
    return {
        type: 'word_pair',
        prompt: `Type the 2nd and 4th words exactly, separated by one space:\n${words.join(' ')}`,
        answer,
        hint: 'Only reply with the requested two words.'
    };
}

function buildSequenceChallenge(tier) {
    const step = tier >= 3 ? randomIntInclusive(2, 6) : randomIntInclusive(1, 4);
    const start = randomIntInclusive(2, tier >= 3 ? 18 : 12);
    const sequence = [start, start + step, start + (step * 2), start + (step * 3)];
    return {
        type: 'sequence',
        prompt: `Complete the number pattern: ${sequence.join(', ')}, ?`,
        answer: String(start + (step * 4)),
        hint: 'Look at how much the number increases each time.'
    };
}

function buildLargestNumberChallenge(tier) {
    const values = new Set();
    while (values.size < 4) {
        values.add(randomIntInclusive(3, tier >= 3 ? 60 : 25));
    }
    const list = Array.from(values);
    return {
        type: 'largest_number',
        prompt: `Pick the largest number: ${list.join(' • ')}.`,
        answer: String(Math.max(...list)),
        hint: 'Compare each value once, then enter only the highest number.'
    };
}

function buildVowelCountChallenge() {
    const words = ['SENTINEL', 'MODERATION', 'SECURITY', 'CHANNEL', 'VERIFIER', 'AUTHORITY'];
    const selected = words[randomIntInclusive(0, words.length - 1)];
    const vowels = (selected.match(/[AEIOU]/g) || []).length;
    return {
        type: 'vowel_count',
        prompt: `How many vowels are in the word "${selected}"?`,
        answer: String(vowels),
        hint: 'Count A, E, I, O, and U only.'
    };
}

function buildOddOneOutChallenge() {
    const groups = [
        { items: ['TEXT', 'VOICE', 'FORUM', 'BANANA'], answer: 'BANANA' },
        { items: ['MOD', 'ADMIN', 'OWNER', 'WINDOW'], answer: 'WINDOW' },
        { items: ['VERIFY', 'SECURE', 'PROTECT', 'HAMMER'], answer: 'HAMMER' }
    ];
    const selected = groups[randomIntInclusive(0, groups.length - 1)];
    return {
        type: 'odd_one_out',
        prompt: `Which item does not belong with the others? ${selected.items.join(' • ')}`,
        answer: selected.answer,
        hint: 'Reply with only the item that does not fit.'
    };
}

function buildSortLettersChallenge() {
    const words = ['GUARD', 'PANEL', 'HUMAN', 'TOKEN', 'ALERT'];
    const selected = words[randomIntInclusive(0, words.length - 1)];
    const shuffled = shuffleArray(selected.split('')).join('');
    const answer = selected.split('').sort().join('');
    return {
        type: 'sort_letters',
        prompt: `Sort these letters alphabetically and type the result as one word: ${shuffled}`,
        answer,
        hint: 'Do not add spaces between the letters.'
    };
}

function getChallengeFactoriesForTier(tier) {
    const base = [buildMathChallenge, buildReverseWordChallenge, buildTokenChallenge, buildLargestNumberChallenge];
    if (tier === 1) return base;
    const medium = [...base, buildWordPairChallenge, buildSequenceChallenge, buildVowelCountChallenge];
    if (tier === 2) return medium;
    return [...medium, buildOddOneOutChallenge, buildSortLettersChallenge];
}

function createStepTwoChallenge({ strictMode = false } = {}) {
    const plan = createAdaptiveChallengePlan({ strictMode, riskScore: strictMode ? 40 : 0 });
    return plan.challenges[0];
}

function createAdaptiveChallengePlan({ strictMode = false, riskScore = 0, antiRaid = null } = {}) {
    const runtime = getVerificationRuntimeConfig();
    const antiRaidActive = Boolean(antiRaid?.active);
    const antiRaidRecent = Boolean(antiRaid?.recent);
    let tier = 1;

    if (strictMode || riskScore >= runtime.tiers.standardRiskScoreThreshold || antiRaidRecent) {
        tier = 2;
    }
    if (riskScore >= runtime.tiers.advancedRiskScoreThreshold || antiRaidActive) {
        tier = 3;
    }

    const factories = shuffleArray(getChallengeFactoriesForTier(tier));
    const needed = Math.max(1, Number(runtime.tiers.extraSteps[tier] || 1));
    const challenges = [];
    const usedTypes = new Set();

    for (const factory of factories) {
        const challenge = factory(tier);
        if (!challenge || usedTypes.has(challenge.type)) continue;
        usedTypes.add(challenge.type);
        challenges.push(challenge);
        if (challenges.length >= needed) break;
    }

    return {
        tier,
        tierLabel: tier === 3 ? 'Advanced' : tier === 2 ? 'Elevated' : 'Standard',
        timeoutMultiplier: Number(runtime.tiers.timeoutMultipliers[tier] || 1),
        challenges,
        antiRaidLinked: antiRaidActive || antiRaidRecent
    };
}

async function collectExpectedResponse({
    channel,
    memberId,
    expectedAnswer,
    wrongAnswerEmbed,
    sessionId,
    timeoutMs = CHALLENGE_TIMEOUT_MS,
    maxWrongAttempts = MAX_WRONG_ATTEMPTS_PER_STEP,
    cleanupChannelMessages = false,
    onAttempt = null
} = {}) {
    let wrongAttempts = 0;
    const safeMaxWrongAttempts = Math.max(1, Number(maxWrongAttempts || MAX_WRONG_ATTEMPTS_PER_STEP));
    const safeTimeoutMs = Math.max(5_000, Number(timeoutMs || CHALLENGE_TIMEOUT_MS));

    const filter = (message) => {
        if (!message || message.author?.bot) return false;
        if (message.author.id !== memberId) return false;

        const sessionState = isVerificationSessionActive(memberId, sessionId);
        if (!sessionState.valid) return false;

        const input = normalizeInput(message.content);
        const expected = normalizeInput(expectedAnswer);

        if (input === expected) {
            if (typeof onAttempt === 'function') {
                onAttempt({ status: 'correct', wrongAttempts, message });
            }
            return true;
        }

        wrongAttempts += 1;

        if (typeof onAttempt === 'function') {
            onAttempt({ status: 'incorrect', wrongAttempts, message });
        }

        if (cleanupChannelMessages) {
            message.delete().catch(() => { });
        }

        if (wrongAttempts >= safeMaxWrongAttempts) {
            return true;
        }

        message.channel.send({ embeds: [wrongAnswerEmbed] })
            .then((notice) => {
                if (cleanupChannelMessages) {
                    setTimeout(() => notice.delete().catch(() => { }), 8000);
                }
            })
            .catch(() => { });

        return false;
    };

    try {
        const collected = await channel.awaitMessages({
            filter,
            max: 1,
            time: safeTimeoutMs
        });

        const response = collected?.first() || null;
        if (!response) {
            if (typeof onAttempt === 'function') {
                onAttempt({ status: 'timeout', wrongAttempts, message: null });
            }
            return { status: 'timeout', message: null, wrongAttempts };
        }

        const input = normalizeInput(response.content);
        const expected = normalizeInput(expectedAnswer);
        if (input === expected) {
            return { status: 'passed', message: response, wrongAttempts };
        }

        return {
            status: wrongAttempts >= safeMaxWrongAttempts ? 'max_attempts' : 'incorrect',
            message: response,
            wrongAttempts
        };
    } catch {
        if (typeof onAttempt === 'function') {
            onAttempt({ status: 'timeout', wrongAttempts, message: null });
        }
        return { status: 'timeout', message: null, wrongAttempts };
    }
}

module.exports = {
    getVerificationRuntimeConfig,
    shouldUseStrictMode,
    assessVerificationRisk,
    createStepTwoChallenge,
    createAdaptiveChallengePlan,
    collectExpectedResponse,
    normalizeInput
};