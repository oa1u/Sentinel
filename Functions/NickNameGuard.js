const { ROLES: { administratorRoleId, moderatorRoleId } } = require('../Config/constants');
const { createLogEmbed, sendLogEmbed } = require('./LoggingHelper');
const BotSafetyCenter = require('./BotSafetyCenter');

const alertCooldowns = new Map();
const STAFF_PATTERNS = ['admin', 'administrator', 'mod', 'moderator', 'owner', 'staff', 'support', 'helper'];

function normalizeName(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/[^a-z0-9]/gi, '')
        .toLowerCase();
}

function isStaff(member) {
    return member?.roles?.cache?.has(administratorRoleId) || member?.roles?.cache?.has(moderatorRoleId);
}

function findStaffCollision(guild, member, normalizedNickname) {
    return guild.members.cache.find((entry) => {
        if (!entry || entry.id === member.id || !isStaff(entry)) return false;
        const comparableNames = [entry.nickname, entry.displayName, entry.user?.username].map(normalizeName).filter(Boolean);
        return comparableNames.some((value) => value && (value === normalizedNickname || normalizedNickname.includes(value) || value.includes(normalizedNickname)));
    }) || null;
}

async function handleGuildMemberUpdate(oldMember, newMember) {
    if (!newMember?.guild || !newMember.user || newMember.user.bot) return null;
    const config = BotSafetyCenter.getConfig();
    if (oldMember?.displayName === newMember.displayName) return null;
    if (isStaff(newMember)) return null;

    const rawNickname = newMember.nickname || newMember.displayName || '';
    const normalizedNickname = normalizeName(rawNickname);
    if (!normalizedNickname) return null;

    const suspiciousReasons = [];
    if (STAFF_PATTERNS.some((pattern) => normalizedNickname.includes(pattern))) {
        suspiciousReasons.push('Nickname includes staff-style wording.');
    }
    if (/@everyone|@here|discord\.gg|discord\.com\/invite/i.test(rawNickname)) {
        suspiciousReasons.push('Nickname includes a mention-style or invite-style pattern.');
    }

    const collision = findStaffCollision(newMember.guild, newMember, normalizedNickname);
    if (collision) {
        suspiciousReasons.push(`Nickname is very close to staff member ${collision.user.tag}.`);
    }

    if (!suspiciousReasons.length) return null;

    const cooldownKey = `${newMember.guild.id}:${newMember.id}`;
    const lastAlertAt = Number(alertCooldowns.get(cooldownKey) || 0);
    if (Date.now() - lastAlertAt < config.nicknameAlertCooldownMs) {
        return null;
    }
    alertCooldowns.set(cooldownKey, Date.now());

    BotSafetyCenter.recordAlert({
        type: 'nickname-guard',
        severity: 'warning',
        title: 'Suspicious Nickname Change',
        message: `${newMember.user.tag} changed their display name in a suspicious way.`,
        guildId: newMember.guild.id,
        guildName: newMember.guild.name,
        meta: {
            reasons: suspiciousReasons,
            collisionId: collision?.id || null
        }
    });

    const embed = createLogEmbed({
        title: 'Suspicious Nickname Change',
        description: `${newMember} changed their display name in a way that may need review.`,
        color: 0xF39C12,
        fields: [
            { name: 'Member', value: `${newMember.user.tag} (${newMember.id})`, inline: true },
            { name: 'Old display name', value: oldMember.displayName || 'None', inline: true },
            { name: 'New display name', value: newMember.displayName || 'None', inline: true },
            { name: 'Reasons', value: suspiciousReasons.join('\n'), inline: false }
        ]
    });

    await sendLogEmbed(newMember.guild, embed).catch(() => null);
    return { suspiciousReasons, collisionId: collision?.id || null };
}

module.exports = {
    handleGuildMemberUpdate
};