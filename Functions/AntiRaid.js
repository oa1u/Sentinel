const { PermissionFlagsBits } = require('discord.js');
const { createLogEmbed, sendLogEmbed } = require('./LoggingHelper');
const MySQLDatabaseManager = require('./MySQLDatabaseManager');
const InviteTracker = require('./InviteTracker');
const automodConfig = require('../Config/constants/automod.json');
const { ROLES: { moderatorRoleId, administratorRoleId, supportTeamRoleId } } = require('../Config/constants');

const DEFAULT_CONFIG = {
    enabled: true,
    joinWindowMs: 60000,
    joinThreshold: 8,
    adaptiveThresholds: {
        enabled: true,
        baseJoinThreshold: 8,
        minJoinThreshold: 5,
        maxJoinThreshold: 25,
        perMembersStep: 1000
    },
    accountAgeDaysThreshold: 7,
    accountAgeSkewThreshold: 0.6,
    accountAgeMinSamples: 6,
    usernameEntropyThreshold: 0.35,
    usernameEntropyMinLength: 6,
    usernameEntropyTriggerCount: 5,
    nameClusterSimilarity: 0.82,
    nameClusterMinCount: 4,
    inviteAnomalyWindowMs: 300000,
    inviteAnomalyThreshold: 6,
    inviteReputation: {
        enabled: true,
        lowJoinThreshold: 3,
        lowJoinMultiplier: 1.6,
        highJoinThreshold: 20,
        highJoinMultiplier: 0.6,
        vanityMultiplier: 0.5,
        unknownMultiplier: 1.2,
        lowInviterJoinsThreshold: 5,
        lowInviterMultiplier: 1.3
    },
    earlyLeaveWindowMs: 300000,
    earlyLeaveThreshold: 5,
    earlyLeaveMaxAgeMs: 900000,
    lockdownSlowmodeSeconds: 30,
    lockdownAllTextChannels: false,
    lockdownChannelIds: [],
    autoRevertMs: 1800000,
    quarantineRoleId: '',
    protectedRoleIds: [],
    verificationSignals: {
        enabled: true,
        riskWindowMs: 600000,
        highRiskScoreThreshold: 45,
        highRiskCountThreshold: 4,
        autoLockdownOnHighRisk: false
    }
};

const guildStates = new Map();

function resolveConfig() {
    const base = automodConfig?.antiRaid || {};
    const adaptive = base.adaptiveThresholds || {};
    const inviteReputation = base.inviteReputation || {};
    const verificationSignals = base.verificationSignals || {};
    return {
        ...DEFAULT_CONFIG,
        ...base,
        adaptiveThresholds: {
            ...DEFAULT_CONFIG.adaptiveThresholds,
            ...adaptive
        },
        inviteReputation: {
            ...DEFAULT_CONFIG.inviteReputation,
            ...inviteReputation
        },
        verificationSignals: {
            ...DEFAULT_CONFIG.verificationSignals,
            ...verificationSignals
        },
        lockdownChannelIds: Array.isArray(base.lockdownChannelIds) ? base.lockdownChannelIds : DEFAULT_CONFIG.lockdownChannelIds,
        protectedRoleIds: Array.isArray(base.protectedRoleIds) ? base.protectedRoleIds : DEFAULT_CONFIG.protectedRoleIds
    };
}

function getState(guildId) {
    if (!guildStates.has(guildId)) {
        guildStates.set(guildId, {
            joinEvents: [],
            entropyEvents: [],
            inviteEvents: [],
            earlyLeaveEvents: [],
            verificationRiskEvents: [],
            joinRecords: new Map(),
            inviteCounts: new Map(),
            lockdown: {
                active: false,
                manual: false,
                reason: null,
                startedAt: null,
                lastTriggeredAt: null,
                timer: null,
                previousSlowmode: new Map(),
                lastRiskScore: null,
                lastTriggerCount: null
            }
        });
    }
    return guildStates.get(guildId);
}

function pruneEvents(events, windowMs) {
    const cutoff = Date.now() - windowMs;
    return events.filter((entry) => entry.ts >= cutoff);
}

function normalizeUsername(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .replace(/\d+/g, '')
        .trim();
}

function computeEntropyRatio(name) {
    const normalized = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!normalized) return 1;
    const unique = new Set(normalized.split(''));
    return unique.size / normalized.length;
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

function computeRiskScore(triggerCount, joinCount) {
    const safeTriggers = Math.max(0, Math.floor(Number(triggerCount) || 0));
    const safeJoins = Math.max(0, Math.floor(Number(joinCount) || 0));
    const base = 15;
    const triggerImpact = safeTriggers * 18;
    const joinImpact = Math.min(25, safeJoins * 2);
    return Math.min(100, base + triggerImpact + joinImpact);
}

function hasProtectedRole(member, config) {
    if (!member?.roles?.cache) return false;
    const hasModPermissions = member.permissions?.has(PermissionFlagsBits.ModerateMembers)
        || member.permissions?.has(PermissionFlagsBits.ManageGuild)
        || member.permissions?.has(PermissionFlagsBits.Administrator);
    if (hasModPermissions) return true;

    const protectedIds = new Set([
        ...config.protectedRoleIds.map((id) => String(id)),
        moderatorRoleId,
        administratorRoleId,
        supportTeamRoleId
    ].filter(Boolean));

    return member.roles.cache.some((role) => protectedIds.has(role.id));
}

async function applySlowmode(guild, config, state) {
    if (!guild) return;

    const channelsToUpdate = [];
    if (config.lockdownAllTextChannels) {
        const allChannels = await guild.channels.fetch().catch(() => null);
        if (allChannels) {
            for (const channel of allChannels.values()) {
                if (typeof channel?.setRateLimitPerUser !== 'function') continue;
                channelsToUpdate.push(channel);
            }
        }
    } else if (Array.isArray(config.lockdownChannelIds) && config.lockdownChannelIds.length > 0) {
        for (const channelId of config.lockdownChannelIds) {
            const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
            if (!channel || typeof channel.setRateLimitPerUser !== 'function') continue;
            channelsToUpdate.push(channel);
        }
    }

    if (channelsToUpdate.length === 0) return;

    for (const channel of channelsToUpdate) {
        if (!state.lockdown.previousSlowmode.has(channel.id)) {
            state.lockdown.previousSlowmode.set(channel.id, channel.rateLimitPerUser ?? 0);
        }

        await channel.setRateLimitPerUser(
            Math.max(0, Math.floor(Number(config.lockdownSlowmodeSeconds) || 0)),
            'Anti-raid lockdown'
        ).catch(() => null);
    }
}

async function revertSlowmode(guild, state) {
    if (!guild) return;
    for (const [channelId, previous] of state.lockdown.previousSlowmode.entries()) {
        const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
        if (!channel || typeof channel.setRateLimitPerUser !== 'function') continue;
        await channel.setRateLimitPerUser(previous ?? 0, 'Anti-raid auto-revert').catch(() => null);
    }
    state.lockdown.previousSlowmode.clear();
}

async function logAntiRaid(guild, title, description, fields = [], color = 0xF04747) {
    const embed = createLogEmbed({
        title,
        description,
        color,
        fields
    });
    await sendLogEmbed(guild, embed);
}

async function startLockdown(guild, config, state, reason, details = [], manual = false) {
    if (!guild) return;
    if (state.lockdown.active && state.lockdown.manual && !manual) return;

    state.lockdown.active = true;
    state.lockdown.manual = manual || state.lockdown.manual;
    state.lockdown.reason = reason;
    state.lockdown.startedAt = Date.now();
    state.lockdown.lastTriggeredAt = state.lockdown.startedAt;
    state.lockdown.lastTriggerCount = Array.isArray(details) ? details.length : null;
    state.lockdown.lastRiskScore = computeRiskScore(state.lockdown.lastTriggerCount || 0, state.joinEvents.length);

    await applySlowmode(guild, config, state);

    await logAntiRaid(guild, '🚨 Anti-Raid Lockdown', reason, details, 0xED4245);

    const eventType = manual ? 'manual_enable' : 'lockdown_start';
    await MySQLDatabaseManager.logAntiRaidEvent(
        guild.id,
        eventType,
        state.lockdown.lastRiskScore,
        state.lockdown.lastTriggerCount,
        {
            reason,
            triggers: details,
            joinCount: state.joinEvents.length
        }
    ).catch(() => { });

    if (!state.lockdown.manual && config.autoRevertMs > 0) {
        if (state.lockdown.timer) clearTimeout(state.lockdown.timer);
        state.lockdown.timer = setTimeout(async () => {
            await stopLockdown(guild, config, state, 'Auto-revert');
        }, config.autoRevertMs);
    }
}

function getRiskSnapshot(guildId) {
    if (!guildId) return null;
    const state = getState(String(guildId));
    return {
        active: state.lockdown.active,
        manual: state.lockdown.manual,
        reason: state.lockdown.reason,
        startedAt: state.lockdown.startedAt,
        lastTriggeredAt: state.lockdown.lastTriggeredAt,
        lastRiskScore: state.lockdown.lastRiskScore,
        lastTriggerCount: state.lockdown.lastTriggerCount
    };
}

async function handleVerificationRisk(member, riskScore = 0, flags = []) {
    if (!member?.guild) return;
    const config = resolveConfig();
    if (!config.enabled) return;

    const signalsConfig = config.verificationSignals || {};
    if (signalsConfig.enabled === false) return;

    const state = getState(member.guild.id);
    const now = Date.now();
    const safeScore = Number.isFinite(Number(riskScore)) ? Number(riskScore) : 0;
    const safeFlags = Array.isArray(flags) ? flags : [];

    const entry = { ts: now, score: safeScore, flags: safeFlags, userId: member.id };
    state.verificationRiskEvents = pruneEvents(
        [...state.verificationRiskEvents, entry],
        Math.max(10_000, Number(signalsConfig.riskWindowMs || DEFAULT_CONFIG.verificationSignals.riskWindowMs))
    );

    const threshold = Math.max(1, Number(signalsConfig.highRiskScoreThreshold || DEFAULT_CONFIG.verificationSignals.highRiskScoreThreshold));
    const countThreshold = Math.max(1, Number(signalsConfig.highRiskCountThreshold || DEFAULT_CONFIG.verificationSignals.highRiskCountThreshold));
    const highRiskCount = state.verificationRiskEvents.filter((event) => event.score >= threshold).length;

    if (signalsConfig.autoLockdownOnHighRisk && highRiskCount >= countThreshold) {
        const details = [
            { name: 'Verification risk', value: `High-risk verifications in window: ${highRiskCount}` }
        ];
        await startLockdown(member.guild, config, state, 'Verification risk surge', details);
        if (!hasProtectedRole(member, config)) {
            await applyQuarantine(member, config);
        }
    }
}

async function stopLockdown(guild, config, state, reason) {
    if (!state.lockdown.active) return;

    const eventType = state.lockdown.manual ? 'manual_disable' : 'lockdown_end';
    const riskScore = Number.isFinite(Number(state.lockdown.lastRiskScore)) ? state.lockdown.lastRiskScore : null;
    const triggerCount = Number.isFinite(Number(state.lockdown.lastTriggerCount)) ? state.lockdown.lastTriggerCount : null;
    await MySQLDatabaseManager.logAntiRaidEvent(
        guild.id,
        eventType,
        riskScore,
        triggerCount,
        { reason }
    ).catch(() => { });

    state.lockdown.active = false;
    state.lockdown.manual = false;
    state.lockdown.reason = null;
    state.lockdown.startedAt = null;
    state.lockdown.lastRiskScore = null;
    state.lockdown.lastTriggerCount = null;

    if (state.lockdown.timer) {
        clearTimeout(state.lockdown.timer);
        state.lockdown.timer = null;
    }

    await revertSlowmode(guild, state);

    await logAntiRaid(guild, '✅ Anti-Raid Lockdown Ended', reason, [], 0x43B581);
}

async function applyQuarantine(member, config) {
    if (!member || !config.quarantineRoleId) return;
    const roleId = String(config.quarantineRoleId).trim();
    if (!roleId) return;

    const role = member.guild.roles.cache.get(roleId);
    if (!role) return;

    if (!member.manageable) return;
    if (member.roles.cache.has(role.id)) return;

    await member.roles.add(role, 'Anti-raid quarantine').catch(() => null);
}

function countByInvite(events, useWeights = false) {
    const counts = new Map();
    for (const entry of events) {
        if (!entry.inviteCode) continue;
        const key = entry.inviteCode;
        const increment = useWeights
            ? Math.max(0.1, Number(entry.inviteWeight) || 1)
            : 1;
        counts.set(key, (counts.get(key) || 0) + increment);
    }
    return counts;
}

function isJoinVelocityTriggered(events, config) {
    return events.length >= config.joinThreshold;
}

function isAccountAgeSkewTriggered(events, config) {
    if (events.length < config.accountAgeMinSamples) return false;
    const youngCount = events.filter((entry) => entry.accountAgeDays <= config.accountAgeDaysThreshold).length;
    return youngCount / events.length >= config.accountAgeSkewThreshold;
}

function isEntropyTriggered(events, config) {
    const lowEntropy = events.filter((entry) => entry.lowEntropy).length;
    if (lowEntropy < config.usernameEntropyTriggerCount) return false;

    const normalizedCounts = new Map();
    for (const entry of events) {
        if (!entry.normalizedName) continue;
        normalizedCounts.set(entry.normalizedName, (normalizedCounts.get(entry.normalizedName) || 0) + 1);
    }
    return Array.from(normalizedCounts.values()).some((count) => count >= config.usernameEntropyTriggerCount);
}

function isNameClusterTriggered(events, config) {
    const names = events
        .map((entry) => entry.normalizedName)
        .filter((name) => typeof name === 'string' && name.length >= config.usernameEntropyMinLength);

    if (names.length < config.nameClusterMinCount) return false;

    for (let i = 0; i < names.length; i += 1) {
        let clusterCount = 1;
        for (let j = i + 1; j < names.length; j += 1) {
            if (computeDiceSimilarity(names[i], names[j]) >= config.nameClusterSimilarity) {
                clusterCount += 1;
            }
            if (clusterCount >= config.nameClusterMinCount) return true;
        }
    }

    return false;
}

function resolveJoinThreshold(guild, config) {
    const adaptive = config.adaptiveThresholds || {};
    if (!adaptive.enabled) return config.joinThreshold;

    const memberCount = Number(guild?.memberCount || 0);
    const step = Math.max(1, Math.floor(Number(adaptive.perMembersStep) || 1000));
    const base = Math.max(1, Math.floor(Number(adaptive.baseJoinThreshold) || config.joinThreshold));
    const min = Math.max(1, Math.floor(Number(adaptive.minJoinThreshold) || base));
    const max = Math.max(min, Math.floor(Number(adaptive.maxJoinThreshold) || base));

    const adjustment = Math.floor(memberCount / step);
    const threshold = base + adjustment;
    return Math.min(Math.max(threshold, min), max);
}

function isInviteAnomalyTriggered(events, config) {
    const useWeights = config.inviteReputation?.enabled === true;
    const counts = countByInvite(events, useWeights);
    return Array.from(counts.values()).some((count) => count >= config.inviteAnomalyThreshold);
}

function isEarlyLeaveTriggered(events, config) {
    return events.length >= config.earlyLeaveThreshold;
}

async function computeInviteWeight(inviteInfo, guildId, config) {
    const repConfig = config.inviteReputation || {};
    if (!repConfig.enabled) return 1;

    if (!inviteInfo || !guildId) return repConfig.unknownMultiplier || 1;

    let weight = 1;
    if (inviteInfo.source === 'vanity') {
        weight *= Number(repConfig.vanityMultiplier) || 1;
    } else if (!inviteInfo.code) {
        weight *= Number(repConfig.unknownMultiplier) || 1;
    }

    const totalJoins = Number(inviteInfo.totalJoins ?? inviteInfo.uses ?? 0) || 0;
    if (totalJoins <= 1) {
        weight *= Number(repConfig.firstUseMultiplier) || 1;
    }
    if (totalJoins <= Number(repConfig.lowJoinThreshold) || 0) {
        weight *= Number(repConfig.lowJoinMultiplier) || 1;
    } else if (totalJoins >= Number(repConfig.highJoinThreshold) || 0) {
        weight *= Number(repConfig.highJoinMultiplier) || 1;
    }

    if (inviteInfo.inviterId) {
        const inviterJoins = await InviteTracker.getInviterJoinCount(guildId, inviteInfo.inviterId).catch(() => 0);
        if (Number(inviterJoins || 0) <= Number(repConfig.lowInviterJoinsThreshold) || 0) {
            weight *= Number(repConfig.lowInviterMultiplier) || 1;
        }
    }

    if (!Number.isFinite(weight) || weight <= 0) return 1;
    return Math.min(3, Math.max(0.2, weight));
}

async function handleMemberJoin(member, inviteInfo = null) {
    if (!member?.guild) return;
    const config = resolveConfig();
    if (!config.enabled) return;

    const state = getState(member.guild.id);
    const now = Date.now();

    const accountAgeDays = member.user?.createdTimestamp
        ? Math.floor((now - member.user.createdTimestamp) / (24 * 60 * 60 * 1000))
        : 999;

    const entropyRatio = computeEntropyRatio(member.user?.username);
    const normalizedName = normalizeUsername(member.user?.username);
    const lowEntropy = (member.user?.username || '').length >= config.usernameEntropyMinLength
        && entropyRatio <= config.usernameEntropyThreshold;

    const joinEntry = {
        ts: now,
        accountAgeDays,
        entropyRatio,
        lowEntropy,
        normalizedName,
        inviteCode: inviteInfo?.code || null,
        inviteWeight: await computeInviteWeight(inviteInfo, member.guild.id, config)
    };

    state.joinEvents = pruneEvents([...state.joinEvents, joinEntry], config.joinWindowMs);
    state.entropyEvents = pruneEvents([...state.entropyEvents, joinEntry], config.joinWindowMs);
    state.inviteEvents = pruneEvents([...state.inviteEvents, joinEntry], config.inviteAnomalyWindowMs);
    state.joinRecords.set(member.id, now);

    if (state.lockdown.active) {
        if (!hasProtectedRole(member, config)) {
            await applyQuarantine(member, config);
        }
        return;
    }

    const triggers = [];

    const joinThreshold = resolveJoinThreshold(member.guild, config);
    if (state.joinEvents.length >= joinThreshold) {
        triggers.push({ name: 'Join velocity', value: `Joins in window: ${state.joinEvents.length} (threshold ${joinThreshold})` });
    }

    if (isAccountAgeSkewTriggered(state.joinEvents, config)) {
        const youngCount = state.joinEvents.filter((entry) => entry.accountAgeDays <= config.accountAgeDaysThreshold).length;
        triggers.push({ name: 'Account age skew', value: `${youngCount}/${state.joinEvents.length} new accounts` });
    }

    if (isEntropyTriggered(state.entropyEvents, config)) {
        const lowEntropyCount = state.entropyEvents.filter((entry) => entry.lowEntropy).length;
        triggers.push({ name: 'Username entropy', value: `${lowEntropyCount} low-entropy names detected` });
    }

    if (isNameClusterTriggered(state.entropyEvents, config)) {
        triggers.push({ name: 'Name-pattern cluster', value: `Similar usernames detected (>= ${config.nameClusterMinCount})` });
    }

    if (isInviteAnomalyTriggered(state.inviteEvents, config)) {
        const useWeights = config.inviteReputation?.enabled === true;
        const counts = countByInvite(state.inviteEvents, useWeights);
        const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
        if (top) {
            const label = useWeights
                ? `Invite ${top[0]} weighted score ${Number(top[1]).toFixed(2)}`
                : `Invite ${top[0]} used ${top[1]} times`;
            triggers.push({ name: 'Invite anomaly', value: label });
        }
    }

    if (triggers.length > 0) {
        await startLockdown(member.guild, config, state, 'Automated anti-raid trigger', triggers);
        if (!hasProtectedRole(member, config)) {
            await applyQuarantine(member, config);
        }
    }
}

async function handleMemberLeave(member) {
    if (!member?.guild) return;
    const config = resolveConfig();
    if (!config.enabled) return;

    const state = getState(member.guild.id);
    const now = Date.now();

    const joinedAt = state.joinRecords.get(member.id);
    state.joinRecords.delete(member.id);

    if (!joinedAt) return;
    if (now - joinedAt > config.earlyLeaveMaxAgeMs) return;

    state.earlyLeaveEvents = pruneEvents([...state.earlyLeaveEvents, { ts: now }], config.earlyLeaveWindowMs);

    if (!state.lockdown.active && isEarlyLeaveTriggered(state.earlyLeaveEvents, config)) {
        const triggers = [{ name: 'Early-leave churn', value: `Leaves in window: ${state.earlyLeaveEvents.length}` }];
        await startLockdown(member.guild, config, state, 'Automated anti-raid trigger', triggers);
    }
}

async function setManualLockdown(guild, enabled, moderator = null, reason = 'Staff override') {
    if (!guild) return null;
    const config = resolveConfig();
    const state = getState(guild.id);

    if (enabled) {
        const details = moderator ? [{ name: 'Moderator', value: `${moderator.tag || moderator.username || moderator.id}` }] : [];
        await startLockdown(guild, config, state, reason, details, true);
        return { active: true, manual: true, reason: state.lockdown.reason, startedAt: state.lockdown.startedAt };
    }

    await stopLockdown(guild, config, state, reason);
    return { active: false, manual: false };
}

function getStatus(guildId) {
    const state = getState(guildId);
    return {
        active: state.lockdown.active,
        manual: state.lockdown.manual,
        reason: state.lockdown.reason,
        startedAt: state.lockdown.startedAt
    };
}

function canOverride(interaction) {
    if (!interaction?.member) return false;
    const member = interaction.member;
    const hasManageGuild = member.permissions?.has(PermissionFlagsBits.ManageGuild);
    const hasModeratorRole = member.roles?.cache?.has(moderatorRoleId);
    const hasAdminRole = member.roles?.cache?.has(administratorRoleId);
    return hasManageGuild || hasModeratorRole || hasAdminRole;
}

module.exports = {
    handleMemberJoin,
    handleMemberLeave,
    handleVerificationRisk,
    setManualLockdown,
    getStatus,
    getRiskSnapshot,
    canOverride
};