const { ROLES: ROLES_CONFIG } = require('../Config/constants');

const DISCORD_OAUTH_REQUIRE_GUILD_MEMBER = (() => {
    const raw = String(process.env.DISCORD_OAUTH_REQUIRE_GUILD_MEMBER || 'true').trim().toLowerCase();
    return !['0', 'false', 'no', 'off'].includes(raw);
})();

const DISCORD_ROLE_TRUST_ENFORCED = (() => {
    const raw = String(process.env.DISCORD_ROLE_TRUST_ENFORCED || 'true').trim().toLowerCase();
    return !['0', 'false', 'no', 'off'].includes(raw);
})();

const DISCORD_RECENT_VERIFICATION_TTL_MS = (() => {
    const parsed = Number(process.env.DISCORD_RECENT_VERIFICATION_TTL_MS);
    return Number.isFinite(parsed) && parsed >= 5 * 60 * 1000 ? parsed : 24 * 60 * 60 * 1000;
})();

const DISCORD_SENSITIVE_VERIFICATION_TTL_MS = (() => {
    const parsed = Number(process.env.DISCORD_SENSITIVE_VERIFICATION_TTL_MS);
    return Number.isFinite(parsed) && parsed >= 60 * 1000 ? parsed : 10 * 60 * 1000;
})();

const DISCORD_ROLE_SYNC_MODE = (() => {
    const raw = String(process.env.DISCORD_ROLE_SYNC_MODE || 'enforce').trim().toLowerCase();
    if (['off', 'enforce', 'downgrade'].includes(raw)) return raw;
    return 'enforce';
})();

const ROLE_RANKS = Object.freeze({
    moderator: 1,
    admin: 2,
    owner: 3
});

function parseDiscordRoleIdList(rawValue) {
    return String(rawValue || '')
        .split(',')
        .map((entry) => String(entry || '').trim())
        .filter((entry) => /^\d{17,20}$/.test(entry));
}

function buildDiscordRoleIds(envValue, fallbackValues = []) {
    const envRoleIds = parseDiscordRoleIdList(envValue);
    if (envRoleIds.length > 0) {
        return Object.freeze(envRoleIds);
    }

    const fallbackRoleIds = fallbackValues
        .map((entry) => String(entry || '').trim())
        .filter((entry) => /^\d{17,20}$/.test(entry));

    return Object.freeze(Array.from(new Set(fallbackRoleIds)));
}

const DISCORD_OWNER_ROLE_IDS = buildDiscordRoleIds(process.env.DISCORD_OWNER_ROLE_IDS, [
    ROLES_CONFIG?.ownerRoleId
]);
const DISCORD_ADMIN_ROLE_IDS = buildDiscordRoleIds(process.env.DISCORD_ADMIN_ROLE_IDS, [
    ROLES_CONFIG?.administratorRoleId
]);
const DISCORD_MODERATOR_ROLE_IDS = buildDiscordRoleIds(process.env.DISCORD_MODERATOR_ROLE_IDS, [
    ROLES_CONFIG?.moderatorRoleId
]);

function getConfiguredDiscordGuildId() {
    const envGuildId = String(process.env.GUILD_ID || '').trim();
    if (envGuildId) return envGuildId;

    try {
        const mainConfig = require('../Config/main.json');
        return String(mainConfig?.serverID || mainConfig?.guildId || '').trim();
    } catch (_) {
        return '';
    }
}

function getRoleRank(role) {
    return ROLE_RANKS[String(role || '').toLowerCase()] || 0;
}

function getDiscordStoredVerificationSnapshot(user) {
    const parseTime = (value) => {
        const timestamp = value ? new Date(value).getTime() : 0;
        return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
    };

    return {
        lastVerifiedAtMs: parseTime(user?.discord_last_verified_at),
        guildVerifiedAtMs: parseTime(user?.discord_guild_verified_at),
        roleVerifiedAtMs: parseTime(user?.discord_role_verified_at),
        trustedPanelRole: String(user?.discord_last_trusted_role || '').trim() || null
    };
}

function isDiscordRoleTrustConfigured() {
    return DISCORD_OWNER_ROLE_IDS.length > 0 || DISCORD_ADMIN_ROLE_IDS.length > 0 || DISCORD_MODERATOR_ROLE_IDS.length > 0;
}

async function resolveDiscordGuildMembership(discordClient, discordUserId) {
    const guildId = getConfiguredDiscordGuildId();
    const guildRequirementEnabled = DISCORD_OAUTH_REQUIRE_GUILD_MEMBER;
    const roleSyncConfigured = isDiscordRoleTrustConfigured();

    const buildMembershipResult = (overrides = {}) => ({
        required: guildRequirementEnabled,
        available: false,
        verified: null,
        guildId,
        guildName: null,
        memberDisplayName: null,
        trustedPanelRole: null,
        trustedRoleIds: [],
        trustedRoleNames: [],
        roleSyncConfigured,
        reason: '',
        ...overrides
    });

    const deriveTrustedPanelRole = (guild, member) => {
        if (!member) {
            return {
                trustedPanelRole: null,
                trustedRoleIds: [],
                trustedRoleNames: []
            };
        }

        const memberRoleIds = new Set(Array.from(member.roles?.cache?.keys?.() || []));
        const matchedRoleIds = [];
        const matchedRoleNames = [];
        let trustedPanelRole = null;

        if (guild?.ownerId && String(guild.ownerId) === String(member.id)) {
            trustedPanelRole = 'owner';
        }

        const mappings = [
            { panelRole: 'owner', roleIds: DISCORD_OWNER_ROLE_IDS },
            { panelRole: 'admin', roleIds: DISCORD_ADMIN_ROLE_IDS },
            { panelRole: 'moderator', roleIds: DISCORD_MODERATOR_ROLE_IDS }
        ];

        for (const mapping of mappings) {
            const hits = mapping.roleIds.filter((roleId) => memberRoleIds.has(roleId));
            if (hits.length > 0) {
                if (!trustedPanelRole || getRoleRank(mapping.panelRole) > getRoleRank(trustedPanelRole)) {
                    trustedPanelRole = mapping.panelRole;
                }
                matchedRoleIds.push(...hits);
                matchedRoleNames.push(...hits.map((roleId) => member.roles?.cache?.get(roleId)?.name).filter(Boolean));
            }
        }

        return {
            trustedPanelRole,
            trustedRoleIds: Array.from(new Set(matchedRoleIds)),
            trustedRoleNames: Array.from(new Set(matchedRoleNames))
        };
    };

    if (!guildRequirementEnabled && !roleSyncConfigured) {
        return buildMembershipResult({ required: false });
    }

    if (!discordUserId || !guildId || !discordClient?.guilds?.fetch) {
        return buildMembershipResult({ reason: 'Guild membership could not be verified yet' });
    }

    try {
        const guild = discordClient.guilds.cache.get(guildId)
            || await discordClient.guilds.fetch(guildId).catch(() => null);
        if (!guild) {
            return buildMembershipResult({ reason: 'Discord guild lookup failed' });
        }

        const member = guild.members.cache.get(discordUserId)
            || await guild.members.fetch(discordUserId).catch(() => null);
        const trustedRole = deriveTrustedPanelRole(guild, member);

        return buildMembershipResult({
            available: true,
            verified: Boolean(member),
            guildName: guild.name || null,
            memberDisplayName: member?.displayName || member?.user?.globalName || member?.user?.username || null,
            trustedPanelRole: trustedRole.trustedPanelRole,
            trustedRoleIds: trustedRole.trustedRoleIds,
            trustedRoleNames: trustedRole.trustedRoleNames,
            reason: member ? '' : 'Linked Discord account is not in the configured server'
        });
    } catch (error) {
        return buildMembershipResult({ reason: 'Guild membership verification is temporarily unavailable' });
    }
}

async function buildDiscordLinkSecurityState({ user, discordClient }) {
    const linked = Boolean(user?.discord_user_id);
    const guildMembership = await resolveDiscordGuildMembership(discordClient, user?.discord_user_id || null);
    const storedVerification = getDiscordStoredVerificationSnapshot(user);
    const now = Date.now();
    const linkRequiredMessage = 'Link a Discord account to unlock protected panel actions';
    const liveVerificationSucceeded = linked
        && (!guildMembership.required || (guildMembership.available && guildMembership.verified !== false))
        && (!guildMembership.roleSyncConfigured || (guildMembership.available && guildMembership.verified === true));
    const lastVerifiedAtMs = liveVerificationSucceeded
        ? now
        : Number(storedVerification.lastVerifiedAtMs || 0);
    const verificationAgeMs = lastVerifiedAtMs > 0 ? Math.max(0, now - lastVerifiedAtMs) : null;
    const recentlyVerified = Number.isFinite(verificationAgeMs) && verificationAgeMs !== null && verificationAgeMs <= DISCORD_RECENT_VERIFICATION_TTL_MS;
    const sensitiveVerificationFresh = Number.isFinite(verificationAgeMs) && verificationAgeMs !== null && verificationAgeMs <= DISCORD_SENSITIVE_VERIFICATION_TTL_MS;
    const liveTrustedPanelRole = String(guildMembership.trustedPanelRole || '').trim() || null;
    const effectiveTrustedPanelRole = guildMembership.available
        ? liveTrustedPanelRole
        : (liveTrustedPanelRole || storedVerification.trustedPanelRole);
    const roleSyncConfigured = Boolean(guildMembership.roleSyncConfigured || isDiscordRoleTrustConfigured());
    const roleAlignmentOk = !roleSyncConfigured
        || !DISCORD_ROLE_TRUST_ENFORCED
        || getRoleRank(effectiveTrustedPanelRole) >= getRoleRank(user?.role);

    let securityEligible = linked && recentlyVerified;
    let securityReason = linked ? '' : linkRequiredMessage;

    if (linked && guildMembership.required && guildMembership.available && guildMembership.verified === false) {
        securityEligible = false;
        securityReason = guildMembership.reason || 'Join the configured Discord server with the linked account to continue';
    } else if (linked && !recentlyVerified) {
        securityEligible = false;
        securityReason = 'Discord verification is stale. Refresh your Discord trust from the Discord tab before continuing';
    } else if (linked && DISCORD_ROLE_TRUST_ENFORCED && roleSyncConfigured && !roleAlignmentOk) {
        securityEligible = false;
        securityReason = effectiveTrustedPanelRole
            ? `Your linked Discord trust level is ${effectiveTrustedPanelRole}, which is below your panel role (${user?.role || 'unknown'})`
            : 'Your linked Discord account does not hold a trusted staff role for this panel account';
    }

    return {
        linked,
        panelRole: user?.role || null,
        discordUserId: user?.discord_user_id || null,
        discordUsername: user?.discord_username || null,
        linkedAt: user?.discord_linked_at || null,
        lastVerifiedAt: lastVerifiedAtMs ? new Date(lastVerifiedAtMs).toISOString() : null,
        verificationAgeMs,
        recentlyVerified,
        sensitiveVerificationFresh,
        verificationSource: liveVerificationSucceeded ? 'live' : (lastVerifiedAtMs ? 'stored' : 'none'),
        guildVerificationRequired: Boolean(guildMembership.required),
        guildVerificationAvailable: Boolean(guildMembership.available),
        guildMemberVerified: guildMembership.verified,
        guildId: guildMembership.guildId || null,
        guildName: guildMembership.guildName || null,
        guildMemberDisplayName: guildMembership.memberDisplayName || null,
        trustedPanelRole: effectiveTrustedPanelRole,
        trustedRoleIds: Array.isArray(guildMembership.trustedRoleIds) ? guildMembership.trustedRoleIds : [],
        trustedRoleNames: Array.isArray(guildMembership.trustedRoleNames) ? guildMembership.trustedRoleNames : [],
        roleSyncConfigured,
        roleSyncMode: DISCORD_ROLE_SYNC_MODE,
        roleAlignmentOk,
        roleAutoDowngradeEligible: roleSyncConfigured && getRoleRank(effectiveTrustedPanelRole) > 0 && getRoleRank(effectiveTrustedPanelRole) < getRoleRank(user?.role),
        securityEligible,
        securityReason,
        liveVerificationSucceeded
    };
}

async function persistDiscordVerificationState({ databaseManager, user, state }) {
    if (!databaseManager?.connection?.pool || !user?.id || !state?.linked || !state?.recentlyVerified) return false;

    try {
        await databaseManager.connection.pool.execute(
            `UPDATE admin_users
             SET discord_last_verified_at = NOW(),
                 discord_guild_verified_at = ?,
                 discord_role_verified_at = ?,
                 discord_last_trusted_role = ?
             WHERE id = ?`,
            [
                state.guildMemberVerified === true ? new Date() : null,
                state.trustedPanelRole ? new Date() : null,
                state.trustedPanelRole || null,
                user.id
            ]
        );
        return true;
    } catch (error) {
        return false;
    }
}

async function applyDiscordRoleSyncPolicy({ databaseManager, user, state }) {
    if (!databaseManager?.connection?.pool || !user || !state.roleSyncConfigured || !DISCORD_ROLE_TRUST_ENFORCED) {
        return { user, state };
    }

    const currentRank = getRoleRank(user.role);

    // If user is not linked to Discord but has a staff role, block access
    if (!state?.linked && currentRank > 0) {
        state.roleAlignmentOk = false;
        state.securityReason = 'Discord account linking is required for staff roles';
        return { user, state };
    }

    if (!state?.linked) {
        return { user, state };
    }

    const trustedRole = String(state.trustedPanelRole || '').trim() || null;
    
    // If user has no Discord staff roles but panel role is staff, downgrade to null/user
    if (!trustedRole && currentRank > 0 && DISCORD_ROLE_SYNC_MODE === 'downgrade') {
        const previousRole = user.role;
        
        try {
            await databaseManager.connection.pool.execute(
                `UPDATE admin_users
                 SET role = NULL, discord_last_role_sync_at = NOW()
                 WHERE id = ?`,
                [user.id]
            );

            user.role = null;
            state.panelRole = null;
            state.roleAlignmentOk = true;
            state.roleAutoSynced = true;
            state.roleSyncReason = `Panel role was removed (was ${previousRole}) because linked Discord account has no staff roles`;
            state.previousPanelRole = previousRole;
        } catch (error) {
        }

        return { user, state };
    }

    // Also enforce when user has no Discord roles (not just when trustedRole is empty string)
    if (!trustedRole && currentRank > 0 && DISCORD_ROLE_SYNC_MODE === 'enforce') {
        // In enforce mode, prevent access but don't modify the database role
        state.roleAlignmentOk = false;
        return { user, state };
    }

    // Existing logic for when user HAS Discord roles
    if (!trustedRole) {
        return { user, state };
    }

    const trustedRank = getRoleRank(trustedRole);
    if (!currentRank || !trustedRank || trustedRank >= currentRank || DISCORD_ROLE_SYNC_MODE !== 'downgrade') {
        return { user, state };
    }

    const previousRole = user.role;

    try {
        await databaseManager.connection.pool.execute(
            `UPDATE admin_users
             SET role = ?, discord_last_role_sync_at = NOW()
             WHERE id = ?`,
            [trustedRole, user.id]
        );

        user.role = trustedRole;
        state.panelRole = trustedRole;
        state.roleAlignmentOk = true;
        state.roleAutoSynced = true;
        state.roleSyncReason = `Panel role was reduced from ${previousRole} to ${trustedRole} to match Discord trust`;
        state.previousPanelRole = previousRole;
    } catch (error) {
    }

    return { user, state };
}

async function synchronizeAdminUserDiscordState({ databaseManager, discordClient, user, touchRoleSyncAt = false }) {
    let state = await buildDiscordLinkSecurityState({ user, discordClient });

    if (state.linked && state.liveVerificationSucceeded) {
        await persistDiscordVerificationState({ databaseManager, user, state });
    }

    const syncResult = await applyDiscordRoleSyncPolicy({ databaseManager, user, state });
    state = syncResult.state;

    if (touchRoleSyncAt && user?.id && !state?.roleAutoSynced && typeof databaseManager?.markAdminUserDiscordRoleSyncChecked === 'function') {
        await databaseManager.markAdminUserDiscordRoleSyncChecked(user.id, new Date());
    }

    return {
        user: syncResult.user,
        state,
        changed: Boolean(state?.roleAutoSynced)
    };
}

module.exports = {
    DISCORD_ROLE_SYNC_MODE,
    DISCORD_ROLE_TRUST_ENFORCED,
    getRoleRank,
    isDiscordRoleTrustConfigured,
    resolveDiscordGuildMembership,
    buildDiscordLinkSecurityState,
    persistDiscordVerificationState,
    applyDiscordRoleSyncPolicy,
    synchronizeAdminUserDiscordState
};