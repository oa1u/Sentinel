const MySQLDatabaseManager = require('./MySQLDatabaseManager');

const inviteCache = new Map();
const inviteCreators = new Map();
const inviteJoinCounts = new Map();
const inviterJoinCounts = new Map();

function ensureGuildCache(guildId) {
    if (!inviteCache.has(guildId)) {
        inviteCache.set(guildId, new Map());
    }
    if (!inviteCreators.has(guildId)) {
        inviteCreators.set(guildId, new Map());
    }
    if (!inviteJoinCounts.has(guildId)) {
        inviteJoinCounts.set(guildId, new Map());
    }
    if (!inviterJoinCounts.has(guildId)) {
        inviterJoinCounts.set(guildId, new Map());
    }
}

async function cacheGuildInvites(guild) {
    if (!guild?.id || !guild?.invites?.fetch) return;

    ensureGuildCache(guild.id);

    try {
        const invites = await guild.invites.fetch();
        const cache = inviteCache.get(guild.id);
        const creators = inviteCreators.get(guild.id);
        cache.clear();

        invites.forEach((invite) => {
            cache.set(invite.code, {
                uses: Number(invite.uses || 0),
                inviterId: invite.inviter?.id || null
            });
            if (invite.inviter?.id) {
                creators.set(invite.code, invite.inviter.id);
            }
        });
    } catch (error) {
        // Missing permissions or invite intent issues are common in some servers.
        console.warn(`[InviteTracker] Could not fetch invites for guild ${guild.id}: ${error?.message || error}`);
    }
}

async function primeAllGuildInvites(client) {
    if (!client?.guilds?.cache) return;

    for (const guild of client.guilds.cache.values()) {
        await cacheGuildInvites(guild);
    }
}

function trackInviteCreate(invite) {
    if (!invite?.guild?.id || !invite?.code) return;
    ensureGuildCache(invite.guild.id);

    const cache = inviteCache.get(invite.guild.id);
    cache.set(invite.code, {
        uses: Number(invite.uses || 0),
        inviterId: invite.inviter?.id || null
    });
    if (invite.inviter?.id) {
        inviteCreators.get(invite.guild.id).set(invite.code, invite.inviter.id);
    }
}

function trackInviteDelete(invite) {
    if (!invite?.guild?.id || !invite?.code) return;
    ensureGuildCache(invite.guild.id);

    const cache = inviteCache.get(invite.guild.id);
    cache.delete(invite.code);
}

function incrementInviteJoinCount(guildId, code) {
    ensureGuildCache(guildId);
    const counts = inviteJoinCounts.get(guildId);
    const current = Number(counts.get(code) || 0);
    const next = current + 1;
    counts.set(code, next);
    return next;
}

function incrementInviterJoinCount(guildId, inviterId) {
    if (!inviterId) return 0;
    ensureGuildCache(guildId);
    const counts = inviterJoinCounts.get(guildId);
    const current = Number(counts.get(inviterId) || 0);
    const next = current + 1;
    counts.set(inviterId, next);
    return next;
}

async function handleMemberJoin(member) {
    const guild = member?.guild;
    if (!guild?.id) return null;

    ensureGuildCache(guild.id);

    const before = new Map(inviteCache.get(guild.id));

    let invites;
    try {
        invites = await guild.invites.fetch();
    } catch (error) {
        console.warn(`[InviteTracker] Could not refresh invites for guild ${guild.id}: ${error?.message || error}`);
        return null;
    }

    const cache = inviteCache.get(guild.id);
    const creators = inviteCreators.get(guild.id);
    cache.clear();
    invites.forEach((invite) => {
        cache.set(invite.code, {
            uses: Number(invite.uses || 0),
            inviterId: invite.inviter?.id || null
        });
        if (invite.inviter?.id) {
            creators.set(invite.code, invite.inviter.id);
        }
    });

    let usedInvite = null;
    invites.forEach((invite) => {
        const previous = before.get(invite.code);
        const previousUses = Number(previous?.uses || 0);
        const currentUses = Number(invite.uses || 0);
        if (!usedInvite && currentUses > previousUses) {
            usedInvite = invite;
        }
    });

    if (!usedInvite && guild.vanityURLCode) {
        const totalJoins = incrementInviteJoinCount(guild.id, guild.vanityURLCode);
        await MySQLDatabaseManager.incrementInviteUsage({
            guildId: guild.id,
            inviteCode: guild.vanityURLCode,
            inviterId: null,
            joinedAt: Date.now()
        }).catch(() => { });
        return {
            code: guild.vanityURLCode,
            inviterId: null,
            uses: null,
            totalJoins,
            source: 'vanity'
        };
    }

    if (!usedInvite) {
        return null;
    }

    const inviterId = usedInvite.inviter?.id || null;
    const totalJoins = incrementInviteJoinCount(guild.id, usedInvite.code);
    incrementInviterJoinCount(guild.id, inviterId);

    await MySQLDatabaseManager.incrementInviteUsage({
        guildId: guild.id,
        inviteCode: usedInvite.code,
        inviterId,
        joinedAt: Date.now()
    }).catch(() => { });

    return {
        code: usedInvite.code,
        inviterId,
        uses: Number(usedInvite.uses || 0),
        totalJoins,
        source: 'invite'
    };
}

function getInviteJoinCount(guildId, code) {
    if (!guildId || !code) return 0;
    const counts = inviteJoinCounts.get(guildId);
    if (!counts) return 0;
    return Number(counts.get(code) || 0);
}

async function getInviterJoinCount(guildId, inviterId) {
    if (!guildId || !inviterId) return 0;

    const dbStats = await MySQLDatabaseManager.getInviteStatsByUser(guildId, inviterId).catch(() => null);
    if (dbStats && Number.isFinite(Number(dbStats.total))) {
        return Number(dbStats.total || 0);
    }

    const counts = inviterJoinCounts.get(guildId);
    if (!counts) return 0;
    return Number(counts.get(inviterId) || 0);
}

async function getInvitesByUser(guildId, inviterId) {
    if (!guildId || !inviterId) return [];

    const dbStats = await MySQLDatabaseManager.getInviteStatsByUser(guildId, inviterId).catch(() => null);
    if (dbStats && Array.isArray(dbStats.perInvite) && dbStats.perInvite.length) {
        return dbStats.perInvite.map((entry) => ({
            code: entry.code,
            uses: null,
            joins: Number(entry.joins || 0),
            lastJoinedAt: entry.lastJoinedAt || null
        }));
    }

    const creators = inviteCreators.get(guildId);
    const cache = inviteCache.get(guildId);
    const codeCounts = inviteJoinCounts.get(guildId);
    if (!creators || !cache) return [];

    const results = [];
    for (const [code, creatorId] of creators.entries()) {
        if (creatorId !== inviterId) continue;
        const cached = cache.get(code);
        results.push({
            code,
            uses: Number(cached?.uses || 0),
            joins: Number(codeCounts?.get(code) || 0)
        });
    }

    return results.sort((a, b) => b.joins - a.joins);
}

async function getInviteStatsByCode(guildId, inviteCode) {
    if (!guildId || !inviteCode) return null;

    const dbStats = await MySQLDatabaseManager.getInviteStatsByCode(guildId, inviteCode).catch(() => null);
    if (dbStats) return dbStats;

    const cache = inviteCache.get(guildId);
    const counts = inviteJoinCounts.get(guildId);
    if (!cache || !counts) return null;

    const cached = cache.get(inviteCode);
    if (!cached) return null;

    return {
        code: inviteCode,
        inviterId: cached.inviterId || null,
        joins: Number(counts.get(inviteCode) || 0),
        lastJoinedAt: null
    };
}

async function getInviteLeaderboard(guildId, limit = 10) {
    if (!guildId) return [];

    const dbStats = await MySQLDatabaseManager.getInviteLeaderboard(guildId, limit).catch(() => null);
    if (Array.isArray(dbStats) && dbStats.length) return dbStats;

    const counts = inviterJoinCounts.get(guildId);
    if (!counts) return [];

    return Array.from(counts.entries())
        .map(([inviterId, joins]) => ({ inviterId, joins: Number(joins || 0) }))
        .sort((a, b) => b.joins - a.joins)
        .slice(0, Math.max(1, Math.min(20, Number(limit) || 10)))
}

module.exports = {
    cacheGuildInvites,
    primeAllGuildInvites,
    trackInviteCreate,
    trackInviteDelete,
    handleMemberJoin,
    getInviteJoinCount,
    getInviterJoinCount,
    getInvitesByUser,
    getInviteStatsByCode,
    getInviteLeaderboard
};