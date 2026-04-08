const {
    SlashCommandBuilder,
    PermissionsBitField,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelType,
    MessageFlags
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const ConfigDoctor = require('../../Functions/ConfigDoctor');
const ConfigValidator = require('../../Functions/ConfigValidator');

const SETUP_SESSION_TTL_MS = 20 * 60 * 1000;
const CLEAR_SELECTION_VALUE = '__clear_selection__';
const MANUAL_MODAL_INPUT_ID = 'setup_manual_value';

const CONFIG_DEFINITIONS = {
    channel: {
        fileName: 'channel.json',
        title: 'Channel Constants',
        description: 'Configure channel and category references used throughout the bot.'
    },
    role: {
        fileName: 'roles.json',
        title: 'Role Constants',
        description: 'Configure staff, verification, and reward role references.'
    },
    misc: {
        fileName: 'misc.json',
        title: 'Misc Settings',
        description: 'Configure general operational, verification, economy, and security settings.'
    },
    automod: {
        fileName: 'automod.json',
        title: 'AutoMod Settings',
        description: 'Configure AutoMod, anti-raid, and moderation profiles.'
    },
    autoResponder: {
        fileName: 'autoResponder.json',
        title: 'Auto-Responder Settings',
        description: 'Configure knowledge-base entries, triggers, and responder behavior.'
    },
    leveling: {
        fileName: 'leveling.json',
        title: 'Leveling Settings',
        description: 'Configure XP, leveling rewards, and related behavior.'
    },
    economy: {
        fileName: 'economy.json',
        title: 'Economy Settings',
        description: 'Configure economy balances, rewards, and progression settings.'
    },
    rules: {
        fileName: 'rules.JSON',
        title: 'Rules',
        description: 'Configure the server rules content.'
    },
    serverBackups: {
        fileName: 'serverBackups.json',
        title: 'Server Backup Settings',
        description: 'Configure backup presets and restore metadata.'
    },
    blockedWords: {
        fileName: 'blockedWords.json',
        title: 'Blocked Words',
        description: 'Configure the blocked words list used by moderation systems.'
    },
    api: {
        fileName: 'api.json',
        title: 'API Settings',
        description: 'Configure API keys, endpoints, and integration settings.'
    },
    credits: {
        fileName: 'credits.json',
        title: 'Credits',
        description: 'Configure credits and attribution data.'
    }
};

const CONFIG_PRESETS = {
    core: {
        description: 'Critical server wiring for channels, staff roles, and verification.',
        targets: [
            {
                configKey: 'channel',
                paths: [
                    'serverLogChannelId',
                    'announcementChannelId',
                    'welcomeChannelId',
                    'leaveChannelId',
                    'rulesChannelId',
                    'verificationChannelId',
                    'ticketCategoryId',
                    'ticketLogChannelId'
                ]
            },
            {
                configKey: 'role',
                paths: [
                    'verifiedRoleId',
                    'moderatorRoleId',
                    'administratorRoleId',
                    'ownerRoleId',
                    'supportTeamRoleId',
                    'quarantineRoleId'
                ]
            }
        ]
    },
    moderation: {
        description: 'AutoMod, anti-raid, and moderation log coverage.',
        targets: [
            {
                configKey: 'channel',
                paths: [
                    'serverLogChannelId',
                    'antiraidLogChannelId',
                    'incidentChannelId',
                    'mediaOnlyChannelIds',
                    'mediaOnlyLogChannelId',
                    'lockdownChannelIds'
                ]
            },
            {
                configKey: 'role',
                paths: ['moderatorRoleId', 'administratorRoleId', 'protectedRoleIds', 'quarantineRoleId']
            },
            {
                configKey: 'automod',
                paths: ['blockExternalInvites', 'maxMentionsBeforeFlag', 'autoMod', 'autoModAdvanced', 'antiRaid', 'autoModProfiles']
            }
        ]
    },
    onboarding: {
        description: 'Welcome, rules, verification, and first-message flow.',
        targets: [
            {
                configKey: 'channel',
                paths: ['welcomeChannelId', 'leaveChannelId', 'rulesChannelId', 'verificationChannelId', 'captchaLogChannelId']
            },
            {
                configKey: 'role',
                paths: ['verifiedRoleId']
            },
            {
                configKey: 'misc',
                paths: ['verification', 'firstMessage']
            },
            {
                configKey: 'rules',
                paths: []
            }
        ]
    },
    engagement: {
        description: 'Giveaways, leveling, economy, reputation, and auto-responder.',
        targets: [
            {
                configKey: 'channel',
                paths: ['giveawayChannelId', 'levelUpLogChannelId', 'birthdayChannelId', 'suggestionChannelId']
            },
            {
                configKey: 'misc',
                paths: ['economy', 'luckyDrop', 'reputation', 'revival']
            },
            {
                configKey: 'economy',
                paths: []
            },
            {
                configKey: 'leveling',
                paths: []
            },
            {
                configKey: 'autoResponder',
                paths: []
            }
        ]
    },
    security: {
        description: 'Panel hardening, resilience, and verification risk controls.',
        targets: [
            {
                configKey: 'misc',
                paths: ['securitySettings', 'resilience', 'verification.riskBased', 'alerts']
            },
            {
                configKey: 'automod',
                paths: ['antiRaid', 'autoModAdvanced']
            },
            {
                configKey: 'api',
                paths: []
            }
        ]
    }
};

const CHANNEL_FIELD_INFO = {
    serverLogChannelId: { description: 'Main moderation and server action log channel.' },
    announcementChannelId: { description: 'Channel used for public server announcements.' },
    suggestionChannelId: { description: 'Channel where suggestions are posted and reviewed.' },
    welcomeChannelId: { description: 'Channel for member welcome messages.' },
    leaveChannelId: { description: 'Channel for member leave messages.' },
    ticketCategoryId: { description: 'Category that new support tickets are created under.', allowedTypes: [ChannelType.GuildCategory] },
    ticketLogChannelId: { description: 'Log channel for ticket actions and transcripts.' },
    joinToCreateChannelId: { description: 'Voice channel members join to create temporary voice rooms.', allowedTypes: [ChannelType.GuildVoice, ChannelType.GuildStageVoice] },
    joinToCreateCategoryId: { description: 'Category where temporary voice rooms are created.', allowedTypes: [ChannelType.GuildCategory] },
    verificationChannelId: { description: 'Channel where members start the verification process.' },
    captchaLogChannelId: { description: 'Channel used for captcha and verification logs.' },
    giveawayChannelId: { description: 'Channel where giveaways are hosted.' },
    levelUpLogChannelId: { description: 'Channel for level-up announcements or logs.' },
    birthdayChannelId: { description: 'Channel for birthday announcements.' },
    rulesChannelId: { description: 'Channel containing server rules.' },
    incidentChannelId: { description: 'Channel for incident alerts and urgent moderation notices.' },
    notificationChannelId: { description: 'Channel for panel or automation notifications.' },
    webhookChannelId: { description: 'Channel that receives webhook-based alerts or logs.' },
    discordChannelId: { description: 'Primary Discord updates or sync channel used by the panel.' },
    antiraidLogChannelId: { description: 'Channel for anti-raid detections and lockdown logs.' },
    mediaOnlyChannelIds: { description: 'Channels where only media posts should be allowed.', multi: true },
    mediaOnlyLogChannelId: { description: 'Channel for media-only moderation logs.' },
    inactiveChannelIgnoreIds: { description: 'Channels ignored by inactive-channel scans and reports.', multi: true },
    revivalIgnoreIds: { description: 'Channels excluded from automatic channel revival checks.', multi: true },
    revivalTargetIds: { description: 'Channels that receive automatic revival messages when inactive.', multi: true },
    lockdownChannelIds: { description: 'Channels specifically targeted during anti-raid lockdowns.', multi: true },
    autoResponderAllowedChannelIds: { description: 'If set, the Auto-Responder only works in these channels.', multi: true },
    autoResponderBlockedChannelIds: { description: 'Channels where the Auto-Responder should never reply.', multi: true }
};

const ROLE_FIELD_INFO = {
    verifiedRoleId: { description: 'Role granted after a member completes verification.' },
    moderatorRoleId: { description: 'Primary moderator role used for staff permissions and checks.' },
    administratorRoleId: { description: 'Administrator role used for higher-level bot controls.' },
    ownerRoleId: { description: 'Owner or top-level management role recognized by the panel.' },
    supportTeamRoleId: { description: 'Role used for ticket support or general help staff.' },
    level5RoleId: { description: 'Automatic reward role for level 5 members.' },
    level10RoleId: { description: 'Automatic reward role for level 10 members.' },
    level25RoleId: { description: 'Automatic reward role for level 25 members.' },
    level50RoleId: { description: 'Automatic reward role for level 50 members.' },
    level75RoleId: { description: 'Automatic reward role for level 75 members.' },
    level100RoleId: { description: 'Automatic reward role for level 100 members.' },
    quarantineRoleId: { description: 'Restriction role used when isolating a member.' },
    protectedRoleIds: { description: 'Roles protected from anti-raid cleanup or bulk enforcement actions.', multi: true }
};

const sessionsById = new Map();
const sessionIdsByOwnerKey = new Map();

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createSessionId() {
    return `stp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function getOwnerKey(guildId, userId) {
    return `${String(guildId || 'dm')}:${String(userId || 'unknown')}`;
}

function isSessionExpired(session) {
    return !session || Date.now() >= Number(session.expiresAt || 0);
}

function getSessionById(sessionId) {
    const session = sessionsById.get(String(sessionId || '')) || null;
    if (!session) return null;
    if (isSessionExpired(session)) {
        destroySession(session);
        return null;
    }
    return session;
}

function storeSession(session) {
    sessionsById.set(session.id, session);
    sessionIdsByOwnerKey.set(session.ownerKey, session.id);
}

function destroySession(session) {
    if (!session) return;
    sessionsById.delete(session.id);
    if (sessionIdsByOwnerKey.get(session.ownerKey) === session.id) {
        sessionIdsByOwnerKey.delete(session.ownerKey);
    }
}

function prettifyConstantName(key) {
    let name = String(key || '').replace(/Id$/i, '');
    name = name.replace(/Ids$/i, '');
    name = name.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase());
    return name.trim() || 'Root';
}

function prettifyPath(pathSegments) {
    if (!Array.isArray(pathSegments) || pathSegments.length === 0) {
        return 'Root';
    }

    return pathSegments.map((segment) => (/^\d+$/.test(String(segment)) ? `[${Number(segment) + 1}]` : prettifyConstantName(segment))).join(' > ');
}

function normalizePathPrefix(pathValue) {
    return String(pathValue || '')
        .trim()
        .replace(/\[(\d+)\]/g, '.$1')
        .split('.')
        .map((segment) => segment.trim())
        .filter(Boolean);
}

function matchesPathPrefix(pathSegments, prefixSegments) {
    if (!Array.isArray(prefixSegments) || prefixSegments.length === 0) {
        return true;
    }

    if (!Array.isArray(pathSegments) || prefixSegments.length > pathSegments.length) {
        return false;
    }

    return prefixSegments.every((segment, index) => String(pathSegments[index]) === String(segment));
}

function getValueAtPath(rootValue, pathSegments) {
    if (!Array.isArray(pathSegments) || pathSegments.length === 0) {
        return rootValue;
    }

    return pathSegments.reduce((current, segment) => current?.[segment], rootValue);
}

function setValueAtPath(rootValue, pathSegments, nextValue) {
    if (!Array.isArray(pathSegments) || pathSegments.length === 0) {
        return nextValue;
    }

    const parent = getValueAtPath(rootValue, pathSegments.slice(0, -1));
    if (parent && typeof parent === 'object') {
        parent[pathSegments[pathSegments.length - 1]] = nextValue;
    }
    return rootValue;
}

function inferFieldKind(pathSegments, value) {
    const leafKey = String(pathSegments[pathSegments.length - 1] || 'root');

    if (/ChannelId$/i.test(leafKey) || /CategoryId$/i.test(leafKey)) {
        return 'channel';
    }
    if (/ChannelIds$/i.test(leafKey) || /CategoryIds$/i.test(leafKey)) {
        return 'channelMulti';
    }
    if (/RoleId$/i.test(leafKey)) {
        return 'role';
    }
    if (/RoleIds$/i.test(leafKey)) {
        return 'roleMulti';
    }
    if (Array.isArray(value)) {
        if (value.every((entry) => typeof entry === 'string')) return 'stringList';
        if (value.every((entry) => typeof entry === 'number')) return 'numberList';
        if (value.every((entry) => typeof entry === 'boolean')) return 'booleanList';
    }
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'string') return 'string';
    return 'json';
}

function collectEditableFields(value, pathSegments = []) {
    if (Array.isArray(value)) {
        const inferredKind = inferFieldKind(pathSegments, value);
        if (['channelMulti', 'roleMulti', 'stringList', 'numberList', 'booleanList'].includes(inferredKind)) {
            return [{ pathSegments, kind: inferredKind }];
        }

        if (value.every((entry) => isPlainObject(entry))) {
            return value.flatMap((entry, index) => collectEditableFields(entry, [...pathSegments, String(index)]));
        }

        return [{ pathSegments, kind: inferFieldKind(pathSegments, value) }];
    }

    if (isPlainObject(value)) {
        const entries = Object.entries(value);
        if (entries.length === 0 && pathSegments.length > 0) {
            return [{ pathSegments, kind: 'json' }];
        }
        return entries.flatMap(([key, childValue]) => collectEditableFields(childValue, [...pathSegments, key]));
    }

    return [{ pathSegments, kind: inferFieldKind(pathSegments, value) }];
}

function isUnsetValue(value) {
    if (value === null || typeof value === 'undefined') return true;
    if (typeof value === 'string') return value.trim().length === 0;
    if (Array.isArray(value)) return value.length === 0 || value.every((entry) => String(entry || '').trim().length === 0);
    return false;
}

function truncateText(value, maxLength = 300) {
    const normalized = String(value || '');
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatValueSummary(kind, value) {
    if (['stringList', 'numberList', 'booleanList'].includes(kind)) {
        const entries = Array.isArray(value) ? value : [];
        return entries.length === 0 ? 'Not set' : `\`${truncateText(entries.join(', '), 700)}\``;
    }

    if (kind === 'channelMulti' || kind === 'roleMulti') {
        const entries = Array.isArray(value) ? value.map((entry) => String(entry || '')).filter(Boolean) : [];
        if (entries.length === 0) return 'Not set';
        return truncateText(entries.map((entry) => (kind === 'roleMulti' ? `<@&${entry}>` : `<#${entry}>`)).join(', '), 700);
    }

    if (kind === 'channel' || kind === 'role') {
        const normalized = String(value || '').trim();
        if (!normalized) return 'Not set';
        return kind === 'role' ? `<@&${normalized}>` : `<#${normalized}>`;
    }

    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') return value.trim().length ? `\`${truncateText(value, 700)}\`` : 'Not set';

    const serialized = JSON.stringify(value, null, 2);
    return serialized ? `\`\`\`json\n${truncateText(serialized, 650)}\n\`\`\`` : 'Not set';
}

function parseIdList(input) {
    const matches = String(input || '').match(/\d{17,20}/g) || [];
    return [...new Set(matches)];
}

function validateChannelIds(guild, ids, allowedTypes) {
    const defaultTypes = [
        ChannelType.GuildText,
        ChannelType.GuildVoice,
        ChannelType.GuildAnnouncement,
        ChannelType.GuildStageVoice,
        ChannelType.GuildForum,
        ChannelType.GuildCategory
    ];
    const allowed = Array.isArray(allowedTypes) && allowedTypes.length > 0 ? allowedTypes : defaultTypes;

    for (const id of ids) {
        const channel = guild.channels.cache.get(id);
        if (!channel) {
            return `Channel \`${id}\` does not exist in this server.`;
        }
        if (!allowed.includes(channel.type)) {
            return `Channel \`${channel.name}\` is not a valid type for this field.`;
        }
    }

    return null;
}

function validateRoleIds(guild, ids) {
    for (const id of ids) {
        const role = guild.roles.cache.get(id);
        if (!role || role.id === guild.id) {
            return `Role \`${id}\` does not exist in this server.`;
        }
    }
    return null;
}

function getFieldInfo(configKey, field, currentValue) {
    const leafKey = String(field.pathSegments[field.pathSegments.length - 1] || 'root');
    const infoMap = configKey === 'channel' ? CHANNEL_FIELD_INFO : configKey === 'role' ? ROLE_FIELD_INFO : {};
    const baseInfo = infoMap[leafKey] || {};

    return {
        label: baseInfo.label || prettifyPath(field.pathSegments),
        description: baseInfo.description || `Configure ${prettifyPath(field.pathSegments).toLowerCase()}.`,
        allowedTypes: baseInfo.allowedTypes || null,
        currentValue,
        kind: field.kind
    };
}

function buildSelectOptions(guild, fieldInfo) {
    if (fieldInfo.kind === 'channel' || fieldInfo.kind === 'channelMulti') {
        const defaultTypes = [
            ChannelType.GuildText,
            ChannelType.GuildVoice,
            ChannelType.GuildAnnouncement,
            ChannelType.GuildStageVoice,
            ChannelType.GuildForum,
            ChannelType.GuildCategory
        ];
        const allowedTypes = fieldInfo.allowedTypes || defaultTypes;

        return guild.channels.cache
            .filter((channel) => allowedTypes.includes(channel.type))
            .sort((left, right) => left.rawPosition - right.rawPosition)
            .map((channel) => ({ label: channel.name.slice(0, 100), value: channel.id }))
            .slice(0, 24);
    }

    return guild.roles.cache
        .filter((role) => role.id !== guild.id)
        .sort((left, right) => right.position - left.position)
        .map((role) => ({ label: role.name.slice(0, 100), value: role.id }))
        .slice(0, 24);
}

function supportsSelect(fieldKind) {
    return ['channel', 'channelMulti', 'role', 'roleMulti'].includes(fieldKind);
}

function supportsClear(fieldKind, value) {
    if (['channel', 'role', 'string'].includes(fieldKind)) return true;
    if (['channelMulti', 'roleMulti', 'stringList', 'numberList', 'booleanList'].includes(fieldKind)) return true;
    if (Array.isArray(value)) return true;
    return false;
}

function parseManualInput(guild, fieldInfo, rawInput) {
    const input = String(rawInput || '').trim();
    const fieldKind = fieldInfo.kind;

    if (fieldKind === 'channel' || fieldKind === 'channelMulti') {
        const ids = parseIdList(input);
        if (ids.length === 0) return { error: 'Provide one or more valid channel IDs or channel mentions.' };
        const validationError = validateChannelIds(guild, ids, fieldInfo.allowedTypes);
        if (validationError) return { error: validationError };
        if (fieldKind === 'channel' && ids.length !== 1) return { error: 'This field accepts exactly one channel.' };
        return { value: fieldKind === 'channel' ? ids[0] : ids };
    }

    if (fieldKind === 'role' || fieldKind === 'roleMulti') {
        const ids = parseIdList(input);
        if (ids.length === 0) return { error: 'Provide one or more valid role IDs or role mentions.' };
        const validationError = validateRoleIds(guild, ids);
        if (validationError) return { error: validationError };
        if (fieldKind === 'role' && ids.length !== 1) return { error: 'This field accepts exactly one role.' };
        return { value: fieldKind === 'role' ? ids[0] : ids };
    }

    if (fieldKind === 'boolean') {
        const normalized = input.toLowerCase();
        if (['true', 'yes', 'on', 'enabled', '1'].includes(normalized)) return { value: true };
        if (['false', 'no', 'off', 'disabled', '0'].includes(normalized)) return { value: false };
        if (normalized === 'toggle') return { value: !fieldInfo.currentValue };
        return { error: 'Use true, false, or toggle for boolean values.' };
    }

    if (fieldKind === 'number') {
        const numericValue = Number(input);
        if (!Number.isFinite(numericValue)) return { error: 'Provide a valid number.' };
        return { value: numericValue };
    }

    if (fieldKind === 'stringList') {
        if (input.startsWith('[')) {
            try {
                const parsed = JSON.parse(input);
                if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
                    return { error: 'Provide a JSON array of strings or a comma-separated list.' };
                }
                return { value: parsed };
            } catch (error) {
                return { error: `Invalid JSON array: ${error.message}` };
            }
        }
        return { value: input.split(/[\n,|]/).map((entry) => entry.trim()).filter(Boolean) };
    }

    if (fieldKind === 'numberList') {
        let values;
        try {
            values = input.startsWith('[')
                ? JSON.parse(input)
                : input.split(/[\n,|]/).map((entry) => entry.trim()).filter(Boolean).map((entry) => Number(entry));
        } catch (error) {
            return { error: `Invalid JSON array: ${error.message}` };
        }

        if (!Array.isArray(values) || values.some((entry) => !Number.isFinite(Number(entry)))) {
            return { error: 'Provide a JSON array of numbers or a comma-separated numeric list.' };
        }
        return { value: values.map((entry) => Number(entry)) };
    }

    if (fieldKind === 'booleanList') {
        let rawValues;
        try {
            rawValues = input.startsWith('[')
                ? JSON.parse(input)
                : input.split(/[\n,|]/).map((entry) => entry.trim()).filter(Boolean);
        } catch (error) {
            return { error: `Invalid JSON array: ${error.message}` };
        }

        if (!Array.isArray(rawValues)) {
            return { error: 'Provide a JSON array of booleans or a comma-separated boolean list.' };
        }

        const normalizedValues = rawValues.map((entry) => String(entry).trim().toLowerCase());
        if (normalizedValues.some((entry) => !['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(entry))) {
            return { error: 'Boolean lists only support true/false style values.' };
        }

        return { value: normalizedValues.map((entry) => ['true', '1', 'yes', 'on'].includes(entry)) };
    }

    if (fieldKind === 'string') {
        return { value: input };
    }

    try {
        return { value: JSON.parse(input) };
    } catch (error) {
        return { error: `Invalid JSON: ${error.message}` };
    }
}

function clearFieldValue(fieldInfo) {
    if (['channel', 'role', 'string'].includes(fieldInfo.kind)) return '';
    if (['channelMulti', 'roleMulti', 'stringList', 'numberList', 'booleanList'].includes(fieldInfo.kind)) return [];
    if (Array.isArray(fieldInfo.currentValue)) return [];
    return fieldInfo.currentValue;
}

function getManualInputHelp(fieldInfo) {
    if (supportsSelect(fieldInfo.kind)) {
        const valueLabel = fieldInfo.kind.includes('role') ? 'role' : 'channel';
        const quantityLabel = fieldInfo.kind.endsWith('Multi') ? `one or more ${valueLabel}s` : `one ${valueLabel}`;
        return `Enter ${quantityLabel} using IDs or mentions.`;
    }
    if (fieldInfo.kind === 'boolean') return 'Enter true, false, or toggle.';
    if (fieldInfo.kind === 'number') return 'Enter a numeric value.';
    if (fieldInfo.kind === 'string') return 'Enter the text to save.';
    if (['stringList', 'numberList', 'booleanList'].includes(fieldInfo.kind)) return 'Enter a comma-separated list or a JSON array.';
    return 'Enter valid JSON for this field.';
}

function markChanged(session, pathSegments) {
    session.changedPaths.add(pathSegments.join('.') || 'root');
}

function summarizeChangedPaths(session) {
    const changed = [...session.changedPaths];
    if (changed.length === 0) return 'No values were changed.';
    return changed.slice(0, 10).map((entry) => `• ${entry}`).join('\n');
}

function summarizePendingPaths(session) {
    const remainingFields = session.fields.slice(session.index);
    if (remainingFields.length === 0) return 'No remaining fields.';
    return remainingFields.slice(0, 10).map((field, index) => `• ${session.index + index + 1}. ${field.configKey}.${field.pathSegments.join('.') || 'root'}`).join('\n');
}

function buildJumpOptions(session) {
    return session.fields
        .slice(0, 24)
        .map((field, index) => ({
            label: truncateText(`${index + 1}. ${prettifyPath(field.pathSegments)}`, 100),
            description: truncateText(`${field.configKey} • ${field.kind}`, 100),
            value: String(index),
            default: index === session.index
        }));
}

function buildReviewEmbed(session) {
    const completionRatio = session.fields.length === 0 ? 1 : session.index / session.fields.length;

    return new EmbedBuilder()
        .setTitle(`Setup Review: ${session.title}`)
        .setDescription('Live session snapshot for the current setup run.')
        .addFields(
            { name: 'Progress', value: `${session.index}/${session.fields.length} (${Math.round(completionRatio * 100)}%)`, inline: true },
            { name: 'Changed fields', value: String(session.changedPaths.size), inline: true },
            { name: 'Remaining', value: String(Math.max(0, session.fields.length - session.index)), inline: true },
            { name: 'Changed paths', value: summarizeChangedPaths(session).slice(0, 1024), inline: false },
            { name: 'Upcoming', value: summarizePendingPaths(session).slice(0, 1024), inline: false }
        )
        .setColor(0x5865F2);
}

function buildValidationSelectors(session) {
    return [...session.changedPaths]
        .map((entry) => String(entry || '').split('.').filter(Boolean))
        .filter((segments) => segments.length > 0)
        .map(([config, ...pathSegments]) => ({ config, pathSegments }));
}

async function buildSetupValidationState(session, guild, client) {
    if (!session || session.changedPaths.size === 0) return null;

    const report = await ConfigValidator.validateConfigForGuild(client, guild);
    const relevantIssues = ConfigValidator.filterValidationIssues(report, buildValidationSelectors(session));
    const diagnoses = relevantIssues.map((issue) => ({
        ...issue,
        suggestion: ConfigDoctor.buildSuggestion(issue)
    }));

    return { report, relevantIssues, diagnoses };
}

function buildValidationField(validationState) {
    if (!validationState) {
        return {
            name: 'Validation',
            value: 'Skipped because no values changed.',
            inline: false
        };
    }

    const issues = Array.isArray(validationState.relevantIssues) ? validationState.relevantIssues : [];
    if (issues.length === 0) {
        return {
            name: 'Validation',
            value: 'No validator issues were found for the fields changed in this setup session.',
            inline: false
        };
    }

    return {
        name: 'Validation',
        value: issues.slice(0, 5).map((issue) => `• ${issue.label || issue.path || 'Unknown path'}: ${issue.message}`).join('\n'),
        inline: false
    };
}

function buildDoctorField(validationState) {
    if (!validationState) return null;
    const diagnoses = Array.isArray(validationState.diagnoses) ? validationState.diagnoses : [];
    if (diagnoses.length === 0) return null;
    return {
        name: 'Suggested Fixes',
        value: diagnoses.slice(0, 3).map((issue) => `• ${issue.label || issue.path || 'Unknown path'}: ${issue.suggestion}`).join('\n').slice(0, 1024),
        inline: false
    };
}

function saveSessionConfig(session) {
    for (const configEntry of Object.values(session.configs || {})) {
        fs.writeFileSync(configEntry.filePath, JSON.stringify(configEntry.config, null, 2));
    }
}

function loadConfigDefinition(configKey) {
    const configDefinition = CONFIG_DEFINITIONS[configKey];
    if (!configDefinition) return null;

    const filePath = path.join(__dirname, '../../Config/constants', configDefinition.fileName);
    let config;
    try {
        config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        config = {};
    }

    return { configKey, filePath, definition: configDefinition, config };
}

function buildFieldsForConfig(configKey, config, { onlyMissing = false, sectionSegments = [], paths = [] } = {}) {
    let fields = collectEditableFields(config).map((field) => ({ ...field, configKey }));

    if (sectionSegments.length > 0) {
        fields = fields.filter((field) => matchesPathPrefix(field.pathSegments, sectionSegments));
    }

    if (Array.isArray(paths) && paths.length > 0) {
        const normalizedPaths = paths.map((pathValue) => normalizePathPrefix(pathValue));
        fields = fields.filter((field) => normalizedPaths.some((pathSegments) => matchesPathPrefix(field.pathSegments, pathSegments)));
    }

    if (onlyMissing) {
        fields = fields.filter((field) => isUnsetValue(getValueAtPath(config, field.pathSegments)));
    }

    return fields;
}

function buildSetupPlan({ configKey, presetKey, onlyMissing, sectionSegments }) {
    if (presetKey) {
        const preset = CONFIG_PRESETS[presetKey];
        if (!preset) return { error: 'Unknown preset.' };

        const configs = {};
        const fields = [];
        for (const target of preset.targets) {
            const configEntry = loadConfigDefinition(target.configKey);
            if (!configEntry) continue;
            configs[target.configKey] = configEntry;
            fields.push(...buildFieldsForConfig(target.configKey, configEntry.config, {
                onlyMissing,
                paths: target.paths || []
            }));
        }

        return {
            title: `${presetKey} preset`,
            description: preset.description,
            configs,
            fields
        };
    }

    const configEntry = loadConfigDefinition(configKey);
    if (!configEntry) return { error: 'Unknown config.' };

    return {
        title: configEntry.definition.fileName,
        description: configEntry.definition.description,
        configs: { [configKey]: configEntry },
        fields: buildFieldsForConfig(configKey, configEntry.config, { onlyMissing, sectionSegments })
    };
}

function getCurrentField(session) {
    return session.fields[session.index] || null;
}

function getStepToken(session) {
    return `${session.index}-${session.revision}`;
}

function buildActionId(action, session) {
    return `setup:action:${action}:${session.id}:${getStepToken(session)}`;
}

function buildSelectId(session) {
    return `setup:select:${session.id}:${getStepToken(session)}`;
}

function buildModalId(session) {
    return `setup:modal:${session.id}:${getStepToken(session)}`;
}

function getSessionMessagePayload(session, guild, notice = null) {
    const field = getCurrentField(session);
    if (!field) {
        return {
            embeds: [
                new EmbedBuilder()
                    .setTitle('Setup Session')
                    .setDescription('No remaining fields.')
                    .setColor(0x5865F2)
            ],
            components: []
        };
    }

    const configEntry = session.configs[field.configKey];
    const currentValue = getValueAtPath(configEntry.config, field.pathSegments);
    const fieldInfo = getFieldInfo(field.configKey, field, currentValue);
    const timeRemainingMs = Math.max(0, Number(session.expiresAt || 0) - Date.now());
    const noticeLines = notice ? [`**${notice.type === 'error' ? 'Notice' : 'Update'}:** ${notice.message}`, ''] : [];

    const embed = new EmbedBuilder()
        .setTitle(`Setup: ${session.title}`)
        .setDescription([
            ...noticeLines,
            session.description,
            '',
            `**Step:** ${session.index + 1}/${session.fields.length}`,
            `**Field:** ${fieldInfo.label}`,
            `**Path:** ${field.pathSegments.join('.') || 'root'}`,
            `**Detected type:** ${field.kind}`,
            `**Current value:** ${formatValueSummary(field.kind, currentValue)}`,
            '',
            'Use the controls below. `Edit Value` opens a modal for manual input, and `Save & Exit` commits progress immediately.'
        ].join('\n'))
        .addFields(
            { name: 'Configs', value: Object.keys(session.configs || {}).join(', ') || session.configKey, inline: true },
            { name: 'Mode', value: session.onlyMissing ? 'Only missing values' : 'All fields', inline: true },
            { name: 'Changed fields', value: String(session.changedPaths.size), inline: true },
            { name: 'Remaining', value: String(Math.max(0, session.fields.length - session.index - 1)), inline: true },
            { name: 'Help', value: getManualInputHelp(fieldInfo), inline: false }
        )
        .setColor(notice?.type === 'error' ? 0xED4245 : notice?.type === 'success' ? 0x57F287 : 0x5865F2)
        .setFooter({
            text: `Session ${session.id} • Expires in ${Math.max(1, Math.ceil(timeRemainingMs / 60000))}m`
        });

    const controlsRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(buildActionId('back', session))
            .setLabel('Back')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(session.index === 0),
        new ButtonBuilder()
            .setCustomId(buildActionId('skip', session))
            .setLabel('Skip')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(buildActionId('edit', session))
            .setLabel('Edit Value')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(buildActionId('clear', session))
            .setLabel('Clear')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!supportsClear(field.kind, currentValue)),
        new ButtonBuilder()
            .setCustomId(buildActionId('save', session))
            .setLabel('Save & Exit')
            .setStyle(ButtonStyle.Success)
    );

    const sessionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(buildActionId('review', session))
            .setLabel('Review')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(buildActionId('validate', session))
            .setLabel('Validate Now')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(buildActionId('discard', session))
            .setLabel('Discard')
            .setStyle(ButtonStyle.Danger)
    );

    const components = [controlsRow, sessionRow];
    const selectOptions = supportsSelect(field.kind) ? buildSelectOptions(guild, fieldInfo) : [];
    if (selectOptions.length > 0) {
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(buildSelectId(session))
            .setPlaceholder(field.kind.endsWith('Multi') ? 'Select one or more values' : 'Select one value')
            .addOptions([
                {
                    label: field.kind.endsWith('Multi') ? 'Clear current selections' : 'Clear current selection',
                    value: CLEAR_SELECTION_VALUE,
                    description: field.kind.endsWith('Multi') ? 'Save this field as an empty list.' : 'Save this field as empty.'
                },
                ...selectOptions
            ])
            .setMinValues(1)
            .setMaxValues(field.kind.endsWith('Multi') ? Math.min(selectOptions.length + 1, 25) : 1);
        components.push(new ActionRowBuilder().addComponents(selectMenu));
    }

    const jumpOptions = buildJumpOptions(session);
    if (jumpOptions.length > 0) {
        components.push(
            new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`setup:jump:${session.id}:${getStepToken(session)}`)
                    .setPlaceholder('Jump to another field')
                    .addOptions(jumpOptions)
                    .setMinValues(1)
                    .setMaxValues(1)
            )
        );
    }

    if (field.kind === 'boolean') {
        components.push(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(buildActionId('bool_true', session)).setLabel('Set True').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(buildActionId('bool_false', session)).setLabel('Set False').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(buildActionId('bool_toggle', session)).setLabel('Toggle').setStyle(ButtonStyle.Secondary)
            )
        );
    }

    return { embeds: [embed], components };
}

async function editSessionMessage(session, payload) {
    if (!session?.webhook || !session?.messageId) return;
    await session.webhook.editMessage(session.messageId, payload).catch(() => null);
}

async function buildSummaryPayload(session, guild, client, title, description, color) {
    const validationState = await buildSetupValidationState(session, guild, client).catch((error) => {
        console.error('[setup] Failed to validate updated config:', error);
        return {
            relevantIssues: [{
                label: 'Validator Error',
                message: 'Setup saved, but validator could not complete.'
            }]
        };
    });
    const doctorField = buildDoctorField(validationState);

    return {
        embeds: [
            new EmbedBuilder()
                .setTitle(title)
                .setDescription(description)
                .addFields(
                    { name: 'Configs', value: Object.keys(session.configs || {}).join(', ') || session.configKey, inline: true },
                    { name: 'Changed fields', value: String(session.changedPaths.size), inline: true },
                    { name: 'Summary', value: summarizeChangedPaths(session), inline: false },
                    buildValidationField(validationState),
                    ...(doctorField ? [doctorField] : [])
                )
                .setColor(color)
        ],
        components: []
    };
}

async function buildPreviewValidationPayload(session, guild, client) {
    const validationState = await buildSetupValidationState(session, guild, client);
    const embed = new EmbedBuilder()
        .setTitle('Setup Validator Preview')
        .setDescription('Current validator status for the fields touched in this live session.')
        .addFields(buildValidationField(validationState))
        .setColor(validationState?.relevantIssues?.length ? 0xFEE75C : 0x57F287);

    const doctorField = buildDoctorField(validationState);
    if (doctorField) {
        embed.addFields(doctorField);
    }

    return { embeds: [embed], flags: MessageFlags.Ephemeral };
}

async function supersedeSession(session, reason) {
    if (!session) return;
    await editSessionMessage(session, {
        embeds: [
            new EmbedBuilder()
                .setTitle('Setup Session Replaced')
                .setDescription(reason)
                .setColor(0xFEE75C)
        ],
        components: []
    });
    destroySession(session);
}

async function finalizeSession(session, guild, client, title, description, color) {
    saveSessionConfig(session);
    const payload = await buildSummaryPayload(session, guild, client, title, description, color);
    await editSessionMessage(session, payload);
    destroySession(session);
}

async function discardSession(session, reason) {
    await editSessionMessage(session, {
        embeds: [
            new EmbedBuilder()
                .setTitle('Setup Discarded')
                .setDescription(reason)
                .addFields(
                    { name: 'Changed fields ignored', value: String(session.changedPaths.size), inline: true },
                    { name: 'Session summary', value: summarizeChangedPaths(session).slice(0, 1024), inline: false }
                )
                .setColor(0xED4245)
        ],
        components: []
    });
    destroySession(session);
}

async function advanceSession(session, guild, client, notice = null) {
    session.revision += 1;
    if (session.index >= session.fields.length) {
        await finalizeSession(session, guild, client, 'Setup Complete', `✅ Saved **${session.configKey}** successfully.`, 0x57F287);
        return;
    }
    await editSessionMessage(session, getSessionMessagePayload(session, guild, notice));
}

function validateInteractiveAccess(interaction, sessionId, stepToken) {
    const session = getSessionById(sessionId);
    if (!session) {
        return { error: 'This setup session expired or no longer exists.' };
    }
    if (interaction.user.id !== session.userId || interaction.guildId !== session.guildId) {
        return { error: 'This setup session belongs to another user or guild.' };
    }
    if (session.messageId && interaction.message && interaction.message.id !== session.messageId) {
        return { error: 'This setup panel is no longer the active one.' };
    }
    if (stepToken !== getStepToken(session)) {
        return { error: 'This setup interaction is stale. Use the latest panel.' };
    }
    return { session };
}

function buildManualModal(session, fieldInfo) {
    const modal = new ModalBuilder()
        .setCustomId(buildModalId(session))
        .setTitle(`Edit ${truncateText(fieldInfo.label, 40)}`);

    let defaultValue = '';
    if (fieldInfo.kind === 'json') {
        defaultValue = JSON.stringify(fieldInfo.currentValue, null, 2);
    } else if (Array.isArray(fieldInfo.currentValue)) {
        defaultValue = fieldInfo.currentValue.join(', ');
    } else if (typeof fieldInfo.currentValue === 'boolean') {
        defaultValue = fieldInfo.currentValue ? 'true' : 'false';
    } else if (fieldInfo.currentValue !== null && typeof fieldInfo.currentValue !== 'undefined') {
        defaultValue = String(fieldInfo.currentValue);
    }
    defaultValue = String(defaultValue || '').slice(0, 4000);

    const input = new TextInputBuilder()
        .setCustomId(MANUAL_MODAL_INPUT_ID)
        .setLabel(truncateText(getManualInputHelp(fieldInfo), 45))
        .setStyle(fieldInfo.kind === 'json' || fieldInfo.kind.endsWith('List') ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(true)
        .setValue(defaultValue);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return modal;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Interactive setup wizard for bot configuration.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .addStringOption((option) =>
            option.setName('config')
                .setDescription('Which config file to edit')
                .setRequired(false)
                .addChoices(
                    { name: 'channel', value: 'channel' },
                    { name: 'role', value: 'role' },
                    { name: 'misc', value: 'misc' },
                    { name: 'automod', value: 'automod' },
                    { name: 'autoResponder', value: 'autoResponder' },
                    { name: 'leveling', value: 'leveling' },
                    { name: 'economy', value: 'economy' },
                    { name: 'rules', value: 'rules' },
                    { name: 'serverBackups', value: 'serverBackups' },
                    { name: 'blockedWords', value: 'blockedWords' },
                    { name: 'api', value: 'api' },
                    { name: 'credits', value: 'credits' }
                )
        )
        .addStringOption((option) =>
            option.setName('type')
                .setDescription('Legacy alias for channel or role setup')
                .setRequired(false)
                .addChoices(
                    { name: 'channel', value: 'channel' },
                    { name: 'role', value: 'role' }
                )
        )
        .addBooleanOption((option) =>
            option.setName('only-missing')
                .setDescription('Only walk through values that are currently empty or unset')
                .setRequired(false)
        )
        .addStringOption((option) =>
            option.setName('preset')
                .setDescription('Run a curated multi-config setup flow')
                .setRequired(false)
                .addChoices(
                    { name: 'core', value: 'core' },
                    { name: 'moderation', value: 'moderation' },
                    { name: 'onboarding', value: 'onboarding' },
                    { name: 'engagement', value: 'engagement' },
                    { name: 'security', value: 'security' }
                )
        )
        .addStringOption((option) =>
            option.setName('section')
                .setDescription('Optional dot-path within a config, for example verification.riskBased')
                .setRequired(false)
        ),
    category: 'Management',
    async execute(interaction) {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
        }

        const configKey = interaction.options.getString('config') || interaction.options.getString('type');
        const presetKey = interaction.options.getString('preset');
        const sectionInput = interaction.options.getString('section');
        const onlyMissing = Boolean(interaction.options.getBoolean('only-missing'));

        if (presetKey && configKey) {
            return interaction.reply({
                content: 'Use either `config` or `preset`, not both at the same time.',
                flags: MessageFlags.Ephemeral
            });
        }

        if (!presetKey && (!configKey || !CONFIG_DEFINITIONS[configKey])) {
            return interaction.reply({
                content: 'Choose a valid config with `/setup config:<name>` or a preset with `/setup preset:<name>`.',
                flags: MessageFlags.Ephemeral
            });
        }

        if (sectionInput && presetKey) {
            return interaction.reply({
                content: 'The `section` filter only applies to a single `config` run.',
                flags: MessageFlags.Ephemeral
            });
        }

        const sectionSegments = normalizePathPrefix(sectionInput);
        const plan = buildSetupPlan({ configKey, presetKey, onlyMissing, sectionSegments });
        if (plan.error) {
            return interaction.reply({ content: plan.error, flags: MessageFlags.Ephemeral });
        }

        const { fields, configs, title, description } = plan;
        if (fields.length === 0) {
            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Nothing To Configure')
                        .setDescription(onlyMissing
                            ? `No missing values were found for **${title}**.`
                            : `No editable values were found for **${title}**.`)
                        .setColor(0xFEE75C)
                ],
                flags: MessageFlags.Ephemeral
            });
        }

        const ownerKey = getOwnerKey(interaction.guildId, interaction.user.id);
        const existingSessionId = sessionIdsByOwnerKey.get(ownerKey);
        if (existingSessionId) {
            const existingSession = getSessionById(existingSessionId);
            if (existingSession) {
                await supersedeSession(existingSession, 'A newer `/setup` run replaced this panel.');
            }
        }

        const session = {
            id: createSessionId(),
            ownerKey,
            userId: interaction.user.id,
            guildId: interaction.guildId,
            configKey: configKey || presetKey,
            presetKey,
            title,
            description,
            configs,
            fields,
            index: 0,
            revision: 0,
            changedPaths: new Set(),
            createdAt: Date.now(),
            expiresAt: Date.now() + SETUP_SESSION_TTL_MS,
            onlyMissing,
            sectionSegments,
            webhook: interaction.webhook,
            messageId: null
        };

        storeSession(session);

        await interaction.reply({
            ...getSessionMessagePayload(session, interaction.guild, {
                type: 'info',
                message: 'Setup session started. This panel is the only active setup instance for you in this server.'
            }),
            flags: MessageFlags.Ephemeral
        });

        const replyMessage = await interaction.fetchReply().catch(() => null);
        if (replyMessage?.id) {
            session.messageId = replyMessage.id;
        }
    },
    async handleComponent(interaction) {
        if (!interaction.isButton() && !interaction.isStringSelectMenu()) {
            return false;
        }
        if (!String(interaction.customId || '').startsWith('setup:')) {
            return false;
        }

        const parts = String(interaction.customId).split(':');
        const type = parts[1];
        const sessionId = parts[parts.length - 2];
        const stepToken = parts[parts.length - 1];
        const validation = validateInteractiveAccess(interaction, sessionId, stepToken);
        if (validation.error) {
            await interaction.reply({ content: validation.error, flags: MessageFlags.Ephemeral }).catch(() => null);
            return true;
        }

        const session = validation.session;
        const guild = interaction.guild;
        const client = interaction.client;
        const field = getCurrentField(session);
        const configEntry = session.configs[field.configKey];
        const currentValue = getValueAtPath(configEntry.config, field.pathSegments);
        const fieldInfo = getFieldInfo(field.configKey, field, currentValue);

        if (interaction.isStringSelectMenu() && type === 'jump') {
            await interaction.deferUpdate();
            const targetIndex = Number(interaction.values[0]);
            if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= session.fields.length) {
                session.revision += 1;
                await editSessionMessage(session, getSessionMessagePayload(session, guild, {
                    type: 'error',
                    message: 'That jump target is no longer available.'
                }));
                return true;
            }

            session.index = targetIndex;
            session.revision += 1;
            await editSessionMessage(session, getSessionMessagePayload(session, guild, {
                type: 'info',
                message: `Jumped to step ${targetIndex + 1}.`
            }));
            return true;
        }

        if (interaction.isStringSelectMenu() && type === 'select') {
            await interaction.deferUpdate();
            const values = interaction.values;
            const shouldClear = values.includes(CLEAR_SELECTION_VALUE);
            const nextValue = shouldClear
                ? (field.kind.endsWith('Multi') ? [] : '')
                : (field.kind.endsWith('Multi') ? values.filter((value) => value !== CLEAR_SELECTION_VALUE) : values[0]);

            configEntry.config = setValueAtPath(configEntry.config, field.pathSegments, nextValue);
            markChanged(session, [field.configKey, ...field.pathSegments]);
            session.index += 1;
            await advanceSession(session, guild, client, {
                type: 'success',
                message: `Saved **${fieldInfo.label}** as ${formatValueSummary(field.kind, nextValue)}.`
            });
            return true;
        }

        if (!interaction.isButton() || type !== 'action') {
            return false;
        }

        const action = parts[2];
        if (action === 'edit') {
            await interaction.showModal(buildManualModal(session, fieldInfo));
            return true;
        }

        await interaction.deferUpdate();

        if (action === 'back') {
            session.index = Math.max(0, session.index - 1);
            session.revision += 1;
            await editSessionMessage(session, getSessionMessagePayload(session, guild, {
                type: 'info',
                message: 'Moved back to the previous field.'
            }));
            return true;
        }

        if (action === 'skip') {
            session.index += 1;
            await advanceSession(session, guild, client, {
                type: 'info',
                message: `Skipped **${fieldInfo.label}**.`
            });
            return true;
        }

        if (action === 'clear') {
            if (!supportsClear(field.kind, currentValue)) {
                session.revision += 1;
                await editSessionMessage(session, getSessionMessagePayload(session, guild, {
                    type: 'error',
                    message: 'This field type does not support the clear action.'
                }));
                return true;
            }

            const clearedValue = clearFieldValue(fieldInfo);
            configEntry.config = setValueAtPath(configEntry.config, field.pathSegments, clearedValue);
            markChanged(session, [field.configKey, ...field.pathSegments]);
            session.index += 1;
            await advanceSession(session, guild, client, {
                type: 'success',
                message: `Cleared **${fieldInfo.label}**.`
            });
            return true;
        }

        if (action === 'save') {
            await finalizeSession(session, guild, client, 'Setup Saved', '✅ Progress has been saved and the setup session is now closed.', 0x57F287);
            return true;
        }

        if (action === 'discard') {
            await discardSession(session, 'The setup session was closed without saving the in-memory changes.');
            return true;
        }

        if (action === 'review') {
            await interaction.followUp({ embeds: [buildReviewEmbed(session)], flags: MessageFlags.Ephemeral }).catch(() => null);
            return true;
        }

        if (action === 'validate') {
            const payload = await buildPreviewValidationPayload(session, guild, client).catch((error) => ({
                content: `Validator preview failed: ${error.message}`,
                flags: MessageFlags.Ephemeral
            }));
            await interaction.followUp(payload).catch(() => null);
            return true;
        }

        if (action === 'bool_true' || action === 'bool_false' || action === 'bool_toggle') {
            let nextValue = true;
            if (action === 'bool_false') nextValue = false;
            if (action === 'bool_toggle') nextValue = !Boolean(currentValue);

            configEntry.config = setValueAtPath(configEntry.config, field.pathSegments, nextValue);
            markChanged(session, [field.configKey, ...field.pathSegments]);
            session.index += 1;
            await advanceSession(session, guild, client, {
                type: 'success',
                message: `Saved **${fieldInfo.label}** as ${nextValue ? 'true' : 'false'}.`
            });
            return true;
        }

        return false;
    },
    async handleModal(interaction) {
        if (!interaction.isModalSubmit()) return false;
        if (!String(interaction.customId || '').startsWith('setup:modal:')) return false;

        const parts = String(interaction.customId).split(':');
        const sessionId = parts[2];
        const stepToken = parts[3];
        const session = getSessionById(sessionId);

        if (!session || interaction.user.id !== session.userId || interaction.guildId !== session.guildId || stepToken !== getStepToken(session)) {
            await interaction.reply({
                content: 'This setup modal is stale or belongs to another session. Use the latest setup panel.',
                flags: MessageFlags.Ephemeral
            }).catch(() => null);
            return true;
        }

        const guild = interaction.guild;
        const client = interaction.client;
        const field = getCurrentField(session);
        const configEntry = session.configs[field.configKey];
        const currentValue = getValueAtPath(configEntry.config, field.pathSegments);
        const fieldInfo = getFieldInfo(field.configKey, field, currentValue);
        const rawValue = interaction.fields.getTextInputValue(MANUAL_MODAL_INPUT_ID);
        const parsed = parseManualInput(guild, fieldInfo, rawValue);

        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => null);

        if (parsed.error) {
            session.revision += 1;
            await editSessionMessage(session, getSessionMessagePayload(session, guild, {
                type: 'error',
                message: parsed.error
            }));
            await interaction.deleteReply().catch(() => null);
            return true;
        }

        configEntry.config = setValueAtPath(configEntry.config, field.pathSegments, parsed.value);
        markChanged(session, [field.configKey, ...field.pathSegments]);
        session.index += 1;
        await advanceSession(session, guild, client, {
            type: 'success',
            message: `Saved **${fieldInfo.label}** as ${formatValueSummary(field.kind, parsed.value)}.`
        });
        await interaction.deleteReply().catch(() => null);
        return true;
    }
};