const { createLogEmbed, sendLogEmbed } = require('./LoggingHelper');
const BotSafetyCenter = require('./BotSafetyCenter');

const inviteEvents = new Map();
const joinEvents = new Map();
const alertCooldowns = new Map();

function getBucket(map, guildId) {
    if (!map.has(guildId)) {
        map.set(guildId, []);
    }
    return map.get(guildId);
}

function prune(entries) {
    const { inviteWindowMs } = BotSafetyCenter.getConfig();
    const now = Date.now();
    return entries.filter((entry) => now - entry.at <= inviteWindowMs);
}

async function maybeSendAlert(guild, key, embedFactory) {
    if (!guild?.id) return;
    const config = BotSafetyCenter.getConfig();
    const now = Date.now();
    const cooldownKey = `${guild.id}:${key}`;
    const last = Number(alertCooldowns.get(cooldownKey) || 0);
    if (now - last < config.inviteAlertCooldownMs) {
        return;
    }
    alertCooldowns.set(cooldownKey, now);
    await sendLogEmbed(guild, embedFactory()).catch(() => null);
}

async function handleInviteMutation(invite, action) {
    const guild = invite?.guild;
    if (!guild?.id) return;
    const config = BotSafetyCenter.getConfig();
    const entries = prune(getBucket(inviteEvents, guild.id));
    entries.push({ at: Date.now(), action, code: invite.code || 'unknown' });
    inviteEvents.set(guild.id, entries);

    if (entries.length >= config.inviteMutationThreshold) {
        BotSafetyCenter.recordAlert({
            type: 'invite-churn',
            severity: 'warning',
            title: 'Invite Churn Detected',
            message: `${entries.length} invite create/delete events were observed in the configured window.`,
            guildId: guild.id,
            guildName: guild.name,
            meta: { threshold: config.inviteMutationThreshold, windowMs: config.inviteWindowMs }
        });
        await maybeSendAlert(guild, 'invite-mutation-burst', () => createLogEmbed({
            title: 'Invite Churn Detected',
            description: `Rapid invite ${action === 'create' ? 'creation' : 'deletion'} activity was detected in **${guild.name}**.`,
            color: 0xF39C12,
            fields: [
                { name: 'Window', value: `${Math.round(config.inviteWindowMs / 60000)} minutes`, inline: true },
                { name: 'Events', value: `${entries.length}`, inline: true },
                { name: 'Recent activity', value: entries.slice(-8).map((entry) => `${entry.action}: ${entry.code}`).join('\n'), inline: false }
            ]
        }));
    }
}

async function handleMemberJoin(member, inviteInfo) {
    const guild = member?.guild;
    if (!guild?.id || !inviteInfo?.code) return;
    const config = BotSafetyCenter.getConfig();

    const entries = prune(getBucket(joinEvents, guild.id));
    entries.push({
        at: Date.now(),
        code: inviteInfo.code,
        inviterId: inviteInfo.inviterId || null,
        source: inviteInfo.source || 'unknown',
        memberId: member.id
    });
    joinEvents.set(guild.id, entries);

    const sameCode = entries.filter((entry) => entry.code === inviteInfo.code);
    if (sameCode.length >= config.inviteJoinSpikeThreshold) {
        BotSafetyCenter.recordAlert({
            type: 'invite-join-spike',
            severity: 'critical',
            title: 'Invite Join Spike Detected',
            message: `Invite ${inviteInfo.code} generated ${sameCode.length} joins in the configured window.`,
            guildId: guild.id,
            guildName: guild.name,
            meta: { threshold: config.inviteJoinSpikeThreshold, inviteCode: inviteInfo.code }
        });
        await maybeSendAlert(guild, `invite-joins:${inviteInfo.code}`, () => createLogEmbed({
            title: 'Invite Join Spike Detected',
            description: `Multiple joins were attributed to invite **${inviteInfo.code}** in a short window.`,
            color: 0xED4245,
            fields: [
                { name: 'Invite code', value: inviteInfo.code, inline: true },
                { name: 'Joins in window', value: `${sameCode.length}`, inline: true },
                { name: 'Source', value: inviteInfo.source || 'unknown', inline: true }
            ]
        }));
    }

    if (inviteInfo.inviterId) {
        const sameInviter = entries.filter((entry) => entry.inviterId === inviteInfo.inviterId);
        if (sameInviter.length >= config.inviterJoinSpikeThreshold) {
            BotSafetyCenter.recordAlert({
                type: 'inviter-join-spike',
                severity: 'critical',
                title: 'Inviter Activity Spike',
                message: `Inviter ${inviteInfo.inviterId} generated ${sameInviter.length} joins in the configured window.`,
                guildId: guild.id,
                guildName: guild.name,
                meta: { threshold: config.inviterJoinSpikeThreshold, inviterId: inviteInfo.inviterId }
            });
            await maybeSendAlert(guild, `inviter:${inviteInfo.inviterId}`, () => createLogEmbed({
                title: 'Inviter Activity Spike',
                description: `An inviter generated an unusual number of joins in **${guild.name}**.`,
                color: 0xED4245,
                fields: [
                    { name: 'Inviter ID', value: inviteInfo.inviterId, inline: true },
                    { name: 'Joins in window', value: `${sameInviter.length}`, inline: true },
                    { name: 'Latest invite', value: inviteInfo.code, inline: true }
                ]
            }));
        }
    }
}

module.exports = {
    handleInviteCreate: async (invite) => handleInviteMutation(invite, 'create'),
    handleInviteDelete: async (invite) => handleInviteMutation(invite, 'delete'),
    handleMemberJoin
};