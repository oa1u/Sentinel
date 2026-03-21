const { isVerificationSessionActive } = require('./VerificationSessionManager');
const { MISC: miscConfig } = require('../Config/constants');

const verificationConfig = miscConfig?.verification || {};
const CHALLENGE_TIMEOUT_MS = 300000; // 5 minutes
const MAX_WRONG_ATTEMPTS_PER_STEP = Math.max(1, Math.min(10, Number(verificationConfig.maxWrongAttemptsPerStep) || 3));
const STRICT_ACCOUNT_AGE_DAYS = Math.max(0, Math.min(365, Number(verificationConfig.strictAccountAgeDays) || 7));

function normalizeInput(value) {
    return String(value || '').trim().toUpperCase();
}

function getVerificationRuntimeConfig() {
    return {
        challengeTimeoutMs: CHALLENGE_TIMEOUT_MS,
        maxWrongAttemptsPerStep: MAX_WRONG_ATTEMPTS_PER_STEP,
        strictAccountAgeDays: STRICT_ACCOUNT_AGE_DAYS
    };
}

function shouldUseStrictMode(createdTimestampMs) {
    const accountCreatedAtMs = Number(createdTimestampMs) || 0;
    if (!accountCreatedAtMs) return false;

    const accountAgeMs = Math.max(0, Date.now() - accountCreatedAtMs);
    const strictThresholdMs = STRICT_ACCOUNT_AGE_DAYS * 24 * 60 * 60 * 1000;
    return accountAgeMs < strictThresholdMs;
}

function createStepTwoChallenge({ strictMode = false } = {}) {
    const choicePool = strictMode ? 4 : 3;
    const choice = Math.floor(Math.random() * choicePool);

    if (choice === 0) {
        const limit = strictMode ? 30 : 9;
        const a = Math.floor(Math.random() * limit) + 1;
        const b = Math.floor(Math.random() * limit) + 1;
        return {
            type: 'math',
            question: `Step 2/2: What is ${a} + ${b}?`,
            answer: String(a + b)
        };
    }

    if (choice === 1) {
        const words = strictMode
            ? ['SECURITY', 'AUTHENTIC', 'FIREWALL', 'SENTINEL', 'VERIFICATION']
            : ['SECURE', 'HUMAN', 'VERIFY', 'SENTINEL', 'ACCESS'];
        const selected = words[Math.floor(Math.random() * words.length)];
        const reversed = selected.split('').reverse().join('');
        return {
            type: 'reverse',
            question: `Step 2/2: Reverse this word and type it exactly: ${selected}`,
            answer: reversed
        };
    }

    if (choice === 2) {
        const token = Math.random().toString(36).slice(2, strictMode ? 10 : 8).toUpperCase();
        return {
            type: 'token',
            question: `Step 2/2: Type this token exactly: ${token}`,
            answer: token
        };
    }

    const words = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT'];
    const shuffled = [...words].sort(() => Math.random() - 0.5).slice(0, 4);
    const expected = `${shuffled[1]} ${shuffled[3]}`;
    return {
        type: 'word_pair',
        question: `Step 2/2: Type the 2nd and 4th words exactly, separated by one space:\n${shuffled.join(' ')}`,
        answer: expected
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
    cleanupChannelMessages = false
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

        if (input === expected) return true;

        wrongAttempts += 1;

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
        return { status: 'timeout', message: null, wrongAttempts };
    }
}

module.exports = {
    getVerificationRuntimeConfig,
    shouldUseStrictMode,
    createStepTwoChallenge,
    collectExpectedResponse
};