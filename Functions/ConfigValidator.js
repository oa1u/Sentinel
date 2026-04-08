const fs = require('fs');
const path = require('path');
const { ChannelType, PermissionsBitField } = require('discord.js');
const { createLogEmbed, sendLogEmbeds } = require('./LoggingHelper');

const CONFIG_DIR = path.join(__dirname, '..', 'Config', 'constants');
const CHANNEL_CONFIG_PATH = path.join(CONFIG_DIR, 'channel.json');
const ROLE_CONFIG_PATH = path.join(CONFIG_DIR, 'roles.json');
const MISC_CONFIG_PATH = path.join(CONFIG_DIR, 'misc.json');
const AUTOMOD_CONFIG_PATH = path.join(CONFIG_DIR, 'automod.json');

const TEXT_CHANNEL_PERMISSION_KEYS = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.EmbedLinks
];

const CHANNEL_EXPECTATIONS = {
    ticketCategoryId: { allowedTypes: [ChannelType.GuildCategory] },
    joinToCreateChannelId: { allowedTypes: [ChannelType.GuildVoice, ChannelType.GuildStageVoice] },
    joinToCreateCategoryId: { allowedTypes: [ChannelType.GuildCategory] },
    mediaOnlyChannelIds: { allowedTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum] },
    inactiveChannelIgnoreIds: { allowedTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildCategory] },
    revivalIgnoreIds: { allowedTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildCategory] },
    revivalTargetIds: { allowedTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum] },
    lockdownChannelIds: { allowedTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum] }
};

const CHANNEL_PERMISSION_REQUIREMENTS = {
    serverLogChannelId: TEXT_CHANNEL_PERMISSION_KEYS,
    announcementChannelId: TEXT_CHANNEL_PERMISSION_KEYS,
    welcomeChannelId: TEXT_CHANNEL_PERMISSION_KEYS,
    leaveChannelId: TEXT_CHANNEL_PERMISSION_KEYS,
    ticketLogChannelId: TEXT_CHANNEL_PERMISSION_KEYS,
    verificationChannelId: TEXT_CHANNEL_PERMISSION_KEYS,
    captchaLogChannelId: TEXT_CHANNEL_PERMISSION_KEYS,
    giveawayChannelId: TEXT_CHANNEL_PERMISSION_KEYS,
    levelUpLogChannelId: TEXT_CHANNEL_PERMISSION_KEYS,
    birthdayChannelId: TEXT_CHANNEL_PERMISSION_KEYS,
    incidentChannelId: TEXT_CHANNEL_PERMISSION_KEYS,
    notificationChannelId: TEXT_CHANNEL_PERMISSION_KEYS,
    webhookChannelId: TEXT_CHANNEL_PERMISSION_KEYS,
    discordChannelId: TEXT_CHANNEL_PERMISSION_KEYS,
    antiraidLogChannelId: TEXT_CHANNEL_PERMISSION_KEYS,
    mediaOnlyLogChannelId: TEXT_CHANNEL_PERMISSION_KEYS
};

function readJsonSafe(filePath, fallbackValue) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        return fallbackValue;
    }
}

function normalizeId(value) {
    return String(value || '').trim();
}

function pathToLabel(pathValue) {
    return String(pathValue || '')
        .replace(/\[(\d+)\]/g, '.$1')
        .split('.')
        .filter(Boolean)
        .map((segment) => String(segment)
            .replace(/Id$/i, '')
            .replace(/Ids$/i, '')
            .replace(/([A-Z])/g, ' $1')
            .replace(/^./, (char) => char.toUpperCase()))
        .join(' > ');
}

function formatPermissions(permissionKeys) {
    return permissionKeys.map((permission) => {
        const entry = Object.entries(PermissionsBitField.Flags).find(([, bit]) => bit === permission);
        return entry?.[0] || String(permission);
    }).join(', ');
}

function loadConfigReferences() {
    const channelConfig = readJsonSafe(CHANNEL_CONFIG_PATH, {});
    const roleConfig = readJsonSafe(ROLE_CONFIG_PATH, {});
    const miscConfig = readJsonSafe(MISC_CONFIG_PATH, {});
    const automodConfig = readJsonSafe(AUTOMOD_CONFIG_PATH, {});
    const references = [];

    for (const [key, value] of Object.entries(channelConfig)) {
        const expected = CHANNEL_EXPECTATIONS[key] || {};
        const permissionRequirements = CHANNEL_PERMISSION_REQUIREMENTS[key] || null;
        if (Array.isArray(value)) {
            value.forEach((entry, index) => {
                references.push({
                    kind: 'channel',
                    config: 'channel',
                    key,
                    path: `${key}[${index}]`,
                    id: normalizeId(entry),
                    allowedTypes: expected.allowedTypes || null,
                    permissionRequirements,
                    optional: true
                });
            });
            continue;
        }

        references.push({
            kind: 'channel',
            config: 'channel',
            key,
            path: key,
            id: normalizeId(value),
            allowedTypes: expected.allowedTypes || null,
            permissionRequirements,
            optional: false
        });
    }

    for (const [key, value] of Object.entries(roleConfig)) {
        if (Array.isArray(value)) {
            value.forEach((entry, index) => {
                references.push({
                    kind: 'role',
                    config: 'roles',
                    key,
                    path: `${key}[${index}]`,
                    id: normalizeId(entry),
                    optional: true
                });
            });
            continue;
        }

        references.push({
            kind: 'role',
            config: 'roles',
            key,
            path: key,
            id: normalizeId(value),
            optional: false
        });
    }

    const miscRewardRoles = Array.isArray(miscConfig?.reputation?.roleRewards) ? miscConfig.reputation.roleRewards : [];
    miscRewardRoles.forEach((entry, index) => {
        references.push({
            kind: 'role',
            config: 'misc',
            key: 'reputation.roleRewards.roleId',
            path: `reputation.roleRewards[${index}].roleId`,
            id: normalizeId(entry?.roleId),
            optional: true
        });
    });

    const rateLimitExemptRoles = Array.isArray(miscConfig?.economy?.rateLimitExemptRoles)
        ? miscConfig.economy.rateLimitExemptRoles
        : [];
    rateLimitExemptRoles.forEach((entry, index) => {
        references.push({
            kind: 'role',
            config: 'misc',
            key: 'economy.rateLimitExemptRoles',
            path: `economy.rateLimitExemptRoles[${index}]`,
            id: normalizeId(entry),
            optional: true
        });
    });

    const advancedConfigs = [
        {
            prefix: 'autoModAdvanced',
            value: automodConfig?.autoModAdvanced || {}
        },
        ...Object.entries(automodConfig?.autoModProfiles?.profiles || {}).map(([profileName, profileValue]) => ({
            prefix: `autoModProfiles.profiles.${profileName}.autoModAdvanced`,
            value: profileValue?.autoModAdvanced || {}
        }))
    ];

    advancedConfigs.forEach(({ prefix, value }) => {
        const exemptChannelIds = Array.isArray(value?.exemptChannelIds) ? value.exemptChannelIds : [];
        const exemptRoleIds = Array.isArray(value?.exemptRoleIds) ? value.exemptRoleIds : [];

        exemptChannelIds.forEach((entry, index) => {
            references.push({
                kind: 'channel',
                config: 'automod',
                key: `${prefix}.exemptChannelIds`,
                path: `${prefix}.exemptChannelIds[${index}]`,
                id: normalizeId(entry),
                optional: true
            });
        });

        exemptRoleIds.forEach((entry, index) => {
            references.push({
                kind: 'role',
                config: 'automod',
                key: `${prefix}.exemptRoleIds`,
                path: `${prefix}.exemptRoleIds[${index}]`,
                id: normalizeId(entry),
                optional: true
            });
        });
    });

    return references;
}

async function resolveBotMember(guild) {
    if (!guild) return null;
    if (guild.members?.me) return guild.members.me;
    try {
        return await guild.members.fetchMe();
    } catch {
        return null;
    }
}

function buildIssue(severity, ref, message) {
    return {
        severity,
        kind: ref.kind,
        config: ref.config,
        key: ref.key,
        path: ref.path,
        label: pathToLabel(ref.path),
        message
    };
}

function validateRoleExpectations(role, ref, botMember) {
    const issues = [];
    const normalizedKey = String(ref.key || '');

    if (normalizedKey === 'administratorRoleId' && !role.permissions.has(PermissionsBitField.Flags.Administrator)) {
        issues.push(buildIssue('warning', ref, 'Configured administrator role no longer has the Administrator permission.'));
    }

    if (normalizedKey === 'moderatorRoleId' && !role.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        issues.push(buildIssue('warning', ref, 'Configured moderator role no longer has the ModerateMembers permission.'));
    }

    if (botMember && !role.editable && /verifiedRoleId|quarantineRoleId|level\d+RoleId|supportTeamRoleId|reputation\.roleRewards\.roleId/i.test(normalizedKey)) {
        issues.push(buildIssue('warning', ref, 'Bot cannot manage this configured role because it is above the bot role or managed externally.'));
    }

    return issues;
}

function validateChannelExpectations(channel, ref, botMember) {
    const issues = [];
    const channelTypeName = Object.entries(ChannelType).find(([, value]) => value === channel.type)?.[0] || String(channel.type);

    if (Array.isArray(ref.allowedTypes) && ref.allowedTypes.length > 0 && !ref.allowedTypes.includes(channel.type)) {
        issues.push(buildIssue('error', ref, `Configured channel exists but has the wrong type (${channelTypeName}).`));
    }

    if (botMember && Array.isArray(ref.permissionRequirements) && ref.permissionRequirements.length > 0 && channel.permissionsFor) {
        const permissions = channel.permissionsFor(botMember);
        if (permissions) {
            const missingPermissions = ref.permissionRequirements.filter((permission) => !permissions.has(permission));
            if (missingPermissions.length > 0) {
                issues.push(buildIssue('warning', ref, `Bot is missing channel permissions: ${formatPermissions(missingPermissions)}.`));
            }
        }
    }

    return issues;
}

async function validateConfigForGuild(client, guildOrId) {
    const guild = typeof guildOrId === 'string'
        ? (client?.guilds?.cache?.get(guildOrId) || await client?.guilds?.fetch?.(guildOrId).catch(() => null))
        : guildOrId;

    if (!guild) {
        return {
            ok: false,
            guildId: typeof guildOrId === 'string' ? guildOrId : null,
            guildName: null,
            issues: [{ severity: 'error', message: 'Configured guild could not be resolved.' }],
            references: []
        };
    }

    const references = loadConfigReferences();
    const botMember = await resolveBotMember(guild);
    const issues = [];

    for (const ref of references) {
        if (!ref.id) {
            if (!ref.optional) {
                issues.push(buildIssue('warning', ref, 'Configured value is empty.'));
            }
            continue;
        }

        if (ref.kind === 'channel') {
            const channel = guild.channels.cache.get(ref.id);
            if (!channel) {
                issues.push(buildIssue('error', ref, 'Configured channel no longer exists in the guild.'));
                continue;
            }

            issues.push(...validateChannelExpectations(channel, ref, botMember));
            continue;
        }

        const role = guild.roles.cache.get(ref.id);
        if (!role || role.id === guild.id) {
            issues.push(buildIssue('error', ref, 'Configured role no longer exists in the guild.'));
            continue;
        }

        issues.push(...validateRoleExpectations(role, ref, botMember));
    }

    return {
        ok: issues.every((issue) => issue.severity !== 'error'),
        guildId: guild.id,
        guildName: guild.name,
        issues,
        references
    };
}

function findConfigReferencesById(id, kind) {
    const normalizedId = normalizeId(id);
    if (!normalizedId) return [];
    return loadConfigReferences().filter((reference) => reference.kind === kind && reference.id === normalizedId);
}

function normalizeConfigScope(configKey) {
    const normalized = String(configKey || '').trim().toLowerCase();
    if (normalized === 'role') return 'roles';
    return normalized;
}

function pathSegmentsIntersect(firstSegments, secondSegments) {
    const left = Array.isArray(firstSegments) ? firstSegments.map(String) : [];
    const right = Array.isArray(secondSegments) ? secondSegments.map(String) : [];
    if (!left.length || !right.length) {
        return left.length === 0 || right.length === 0;
    }

    const shortestLength = Math.min(left.length, right.length);
    for (let index = 0; index < shortestLength; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }

    return true;
}

function filterValidationIssues(report, selectors = []) {
    const issues = Array.isArray(report?.issues) ? report.issues : [];
    const normalizedSelectors = Array.isArray(selectors)
        ? selectors.map((selector) => ({
            config: normalizeConfigScope(selector?.config),
            pathSegments: Array.isArray(selector?.pathSegments) ? selector.pathSegments.map(String) : []
        }))
        : [];

    if (!normalizedSelectors.length) {
        return issues;
    }

    return issues.filter((issue) => {
        const issueConfig = normalizeConfigScope(issue?.config);
        const issuePathSegments = String(issue?.path || '')
            .replace(/\[(\d+)\]/g, '.$1')
            .split('.')
            .filter(Boolean)
            .map(String);

        return normalizedSelectors.some((selector) => {
            if (selector.config && selector.config !== issueConfig) {
                return false;
            }

            return pathSegmentsIntersect(selector.pathSegments, issuePathSegments);
        });
    });
}

function buildValidationEmbeds(report, reason = 'manual') {
    const issues = Array.isArray(report?.issues) ? report.issues : [];
    if (!issues.length) return [];

    const grouped = [];
    for (let index = 0; index < issues.length; index += 8) {
        grouped.push(issues.slice(index, index + 8));
    }

    return grouped.map((group, index) => createLogEmbed({
        title: index === 0 ? 'Config Validation Alert' : `Config Validation Alert (${index + 1})`,
        description: `Detected configuration issues for **${report.guildName || report.guildId || 'unknown guild'}** during **${reason}** validation.`,
        color: 0xED4245,
        fields: group.map((issue) => ({
            name: `${issue.severity === 'error' ? 'Error' : 'Warning'} • ${issue.label || issue.path || 'Unknown Path'}`,
            value: issue.message,
            inline: false
        })),
        footer: {
            text: `Issues: ${issues.length}`
        }
    }));
}

async function notifyValidationIssues(client, guildOrId, report, reason = 'manual') {
    if (!report || !Array.isArray(report.issues) || !report.issues.length) {
        return report;
    }

    const guild = typeof guildOrId === 'string'
        ? (client?.guilds?.cache?.get(guildOrId) || await client?.guilds?.fetch?.(guildOrId).catch(() => null))
        : guildOrId;
    if (!guild) return report;

    const embeds = buildValidationEmbeds(report, reason);
    if (embeds.length) {
        await sendLogEmbeds(guild, embeds).catch(() => null);
    }

    return report;
}

async function validateAndNotify(client, guildOrId, options = {}) {
    const reason = String(options.reason || 'manual');
    const report = await validateConfigForGuild(client, guildOrId);

    if (report.issues.length > 0) {
        console.warn(`[ConfigValidator] ${report.issues.length} issue(s) found during ${reason} validation for ${report.guildName || report.guildId || 'unknown guild'}.`);
        await notifyValidationIssues(client, guildOrId, report, reason);
    } else {
        console.log(`[ConfigValidator] No config issues found for ${report.guildName || report.guildId || 'unknown guild'} (${reason}).`);
    }

    return report;
}

module.exports = {
    validateConfigForGuild,
    validateAndNotify,
    notifyValidationIssues,
    findConfigReferencesById,
    buildValidationEmbeds,
    filterValidationIssues
};