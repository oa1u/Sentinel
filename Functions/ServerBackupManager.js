const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ChannelType } = require('discord.js');

const ROOT_DIR = path.join(__dirname, '..');
const SERVER_BACKUP_DIR = path.join(ROOT_DIR, 'backups', 'server');
const SERVER_BACKUP_CONFIG_PATH = path.join(ROOT_DIR, 'Config', 'constants', 'serverBackups.json');
const SERVER_BACKUP_MANIFEST_SECRET = String(process.env.SERVER_BACKUP_MANIFEST_SECRET || process.env.SERVER_BACKUP_SIGNING_SECRET || '').trim();
const DEFAULT_BACKUP_INCLUDES = Object.freeze({
    settings: true,
    roles: true,
    channels: true,
    emojis: true,
    stickers: true,
    permissionOverwrites: true
});
const DEFAULT_SERVER_BACKUP_CONFIG = Object.freeze({
    enabled: false,
    intervalMinutes: 1440,
    retentionCount: 10,
    includes: { ...DEFAULT_BACKUP_INCLUDES }
});
const DEFAULT_RESTORE_OPTIONS = Object.freeze({
    restoreSettings: true,
    restoreRoles: true,
    restoreChannels: true,
    restoreEmojis: false,
    restoreStickers: false,
    applyPermissionOverwrites: true
});

const CHANNEL_TYPE_NAMES = Object.entries(ChannelType).reduce((accumulator, [key, value]) => {
    if (typeof value === 'number') {
        accumulator[value] = key;
    }
    return accumulator;
}, {});

function ensureServerBackupDir() {
    fs.mkdirSync(SERVER_BACKUP_DIR, { recursive: true });
}

function normalizeBackupIncludes(rawIncludes = {}) {
    return {
        settings: rawIncludes?.settings !== false,
        roles: rawIncludes?.roles !== false,
        channels: rawIncludes?.channels !== false,
        emojis: rawIncludes?.emojis !== false,
        stickers: rawIncludes?.stickers !== false,
        permissionOverwrites: rawIncludes?.permissionOverwrites !== false
    };
}

function normalizeRestoreOptions(rawOptions = {}) {
    return {
        restoreSettings: rawOptions?.restoreSettings !== false,
        restoreRoles: rawOptions?.restoreRoles !== false,
        restoreChannels: rawOptions?.restoreChannels !== false,
        restoreEmojis: rawOptions?.restoreEmojis === true,
        restoreStickers: rawOptions?.restoreStickers === true,
        applyPermissionOverwrites: rawOptions?.applyPermissionOverwrites !== false
    };
}

function normalizeRestoreExclusions(rawExclusions = {}) {
    const toList = (value) => {
        if (Array.isArray(value)) {
            return value;
        }
        return String(value || '')
            .split(/[\n,]/)
            .map((entry) => entry.trim())
            .filter(Boolean);
    };

    return {
        roleNames: Array.from(new Set(toList(rawExclusions?.roleNames).map(normalizeRoleKey).filter(Boolean))),
        channelNames: Array.from(new Set(toList(rawExclusions?.channelNames).map(normalizeRoleKey).filter(Boolean)))
    };
}

function sanitizeBackupLabel(label) {
    const value = String(label || '').replace(/\s+/g, ' ').trim();
    return value.slice(0, 80);
}

function sanitizeBackupNotes(notes) {
    const value = String(notes || '').replace(/\r\n/g, '\n').trim();
    return value.slice(0, 500);
}

function formatBackupBytes(bytes) {
    const size = Math.max(0, Number(bytes) || 0);
    if (size < 1024) return `${size} B`;
    const kb = size / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    return `${(mb / 1024).toFixed(1)} GB`;
}

function getServerBackupManifestPath(fileName) {
    const filePath = getServerBackupFilePath(fileName);
    if (!filePath) {
        return null;
    }
    return `${filePath}.manifest.json`;
}

function cloneBackupPayloadWithoutIntegrity(payload) {
    if (!payload || typeof payload !== 'object') {
        return payload;
    }

    return {
        ...payload,
        metadata: {
            ...(payload.metadata || {}),
            integrity: undefined
        }
    };
}

function computeBackupPayloadHash(payload) {
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify(cloneBackupPayloadWithoutIntegrity(payload)));
    return hash.digest('hex');
}

function collectDuplicateLabels(items = [], selector) {
    const seen = new Map();
    const duplicates = [];

    items.forEach((item) => {
        const label = String(selector(item) || '').trim().toLowerCase();
        if (!label) return;
        if (seen.has(label)) {
            duplicates.push(label);
            return;
        }
        seen.set(label, true);
    });

    return Array.from(new Set(duplicates));
}

function validateServerBackupPayload(payload) {
    const errors = [];
    const warnings = [];

    if (!payload || typeof payload !== 'object') {
        return {
            valid: false,
            errors: ['Backup payload is missing or invalid.'],
            warnings: [],
            summary: null,
            integrity: { available: false, valid: false, algorithm: null, expectedHash: null, actualHash: null }
        };
    }

    if (payload.type !== 'sentinel-server-backup') {
        errors.push('Backup type is not recognized.');
    }

    if (!payload.guild?.id) {
        errors.push('Guild metadata is missing.');
    }

    const roles = Array.isArray(payload.roles) ? payload.roles : [];
    const channels = Array.isArray(payload.channels) ? payload.channels : [];
    const emojis = Array.isArray(payload.emojis) ? payload.emojis : [];
    const stickers = Array.isArray(payload.stickers) ? payload.stickers : [];
    const includes = normalizeBackupIncludes(payload?.metadata?.includes || {});
    const metadata = payload?.metadata || {};

    if (includes.roles && metadata.roleCount !== undefined && Number(metadata.roleCount) !== roles.length) {
        warnings.push('Role count metadata does not match the backup contents.');
    }
    if (includes.channels && metadata.channelCount !== undefined && Number(metadata.channelCount) !== channels.length) {
        warnings.push('Channel count metadata does not match the backup contents.');
    }
    if (includes.emojis && metadata.emojiCount !== undefined && Number(metadata.emojiCount) !== emojis.length) {
        warnings.push('Emoji count metadata does not match the backup contents.');
    }
    if (includes.stickers && metadata.stickerCount !== undefined && Number(metadata.stickerCount) !== stickers.length) {
        warnings.push('Sticker count metadata does not match the backup contents.');
    }

    const duplicateRoleNames = collectDuplicateLabels(roles, (role) => role?.name);
    const duplicateChannelNames = collectDuplicateLabels(channels, (channel) => `${channel?.type}:${channel?.name}`);
    if (duplicateRoleNames.length) {
        warnings.push(`Duplicate role names detected: ${duplicateRoleNames.slice(0, 5).join(', ')}`);
    }
    if (duplicateChannelNames.length) {
        warnings.push(`Duplicate channel identifiers detected: ${duplicateChannelNames.slice(0, 5).join(', ')}`);
    }

    const expectedHash = String(payload?.metadata?.integrity?.payloadHash || '').trim();
    const actualHash = computeBackupPayloadHash(payload);
    const integrity = {
        available: Boolean(expectedHash),
        valid: !expectedHash || expectedHash === actualHash,
        algorithm: payload?.metadata?.integrity?.algorithm || null,
        expectedHash: expectedHash || null,
        actualHash
    };

    if (!expectedHash) {
        warnings.push('Backup does not include an embedded integrity hash.');
    } else if (expectedHash !== actualHash) {
        errors.push('Backup integrity hash does not match the file contents.');
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        summary: {
            roles: roles.length,
            channels: channels.length,
            emojis: emojis.length,
            stickers: stickers.length,
            members: Number(metadata.memberCount || 0),
            generatedAt: payload.generatedAt || null,
            version: Number(payload.version || 0),
            includes
        },
        integrity
    };
}

function inspectServerBackupFile(fileName) {
    const filePath = getServerBackupFilePath(fileName);
    if (!filePath || !fs.existsSync(filePath)) {
        throw new Error('Backup file not found.');
    }

    const stat = fs.statSync(filePath);
    const payload = readServerBackupFile(fileName);
    const validation = validateServerBackupPayload(payload);
    const manifest = readServerBackupManifest(fileName);

    return {
        file: {
            name: fileName,
            path: filePath,
            size: stat.size,
            createdAt: stat.mtimeMs
        },
        guild: payload.guild || null,
        metadata: payload.metadata || {},
        summary: validation.summary,
        validation,
        label: payload?.metadata?.label || null,
        notes: payload?.metadata?.notes || null,
        requestedBy: payload?.metadata?.requestedBy || null,
        manifest,
        generatedAt: payload.generatedAt || null,
        trigger: payload.trigger || null,
        version: Number(payload.version || 0)
    };
}

function signBackupManifest(manifestPayload) {
    if (!SERVER_BACKUP_MANIFEST_SECRET) {
        return null;
    }

    const hmac = crypto.createHmac('sha256', SERVER_BACKUP_MANIFEST_SECRET);
    hmac.update(JSON.stringify(manifestPayload));
    return hmac.digest('hex');
}

function buildBackupManifest({ fileName, payload, size }) {
    const manifestPayload = {
        schema: 'sentinel-server-backup-manifest',
        version: 1,
        fileName,
        generatedAt: payload.generatedAt || new Date().toISOString(),
        guildId: payload?.guild?.id || null,
        guildName: payload?.guild?.name || null,
        label: payload?.metadata?.label || null,
        payloadHash: payload?.metadata?.integrity?.payloadHash || computeBackupPayloadHash(payload),
        size: Number(size || 0)
    };

    return {
        ...manifestPayload,
        signature: signBackupManifest(manifestPayload),
        signatureAlgorithm: SERVER_BACKUP_MANIFEST_SECRET ? 'hmac-sha256' : null,
        signed: Boolean(SERVER_BACKUP_MANIFEST_SECRET)
    };
}

function writeServerBackupManifest(fileName, manifest) {
    const manifestPath = getServerBackupManifestPath(fileName);
    if (!manifestPath) {
        return null;
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifestPath;
}

function readServerBackupManifest(fileName) {
    const manifestPath = getServerBackupManifestPath(fileName);
    if (!manifestPath || !fs.existsSync(manifestPath)) {
        return {
            available: false,
            valid: false,
            signed: false,
            path: manifestPath
        };
    }

    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    const payload = {
        schema: parsed?.schema,
        version: parsed?.version,
        fileName: parsed?.fileName,
        generatedAt: parsed?.generatedAt,
        guildId: parsed?.guildId,
        guildName: parsed?.guildName,
        label: parsed?.label,
        payloadHash: parsed?.payloadHash,
        size: parsed?.size
    };
    const expectedSignature = signBackupManifest(payload);
    const valid = !parsed?.signed || !expectedSignature ? true : expectedSignature === parsed.signature;

    return {
        ...parsed,
        available: true,
        valid,
        path: manifestPath
    };
}

function buildRestorePreflightReport(sourcePayload, targetPayload) {
    const diff = buildSnapshotDiff(sourcePayload, targetPayload, {
        sourceLabel: sourcePayload?.metadata?.label || sourcePayload?.guild?.name || 'Selected Backup',
        targetLabel: targetPayload?.guild?.name || 'Current Server'
    });
    const validation = validateServerBackupPayload(sourcePayload);
    const summary = diff.summary || {};
    let score = 0;

    score += Number(summary.settingsChanged || 0) * 4;
    score += Number(summary.rolesAdded || 0) * 2;
    score += Number(summary.rolesChanged || 0) * 3;
    score += Number(summary.rolesRemoved || 0) * 5;
    score += Number(summary.channelsAdded || 0) * 2;
    score += Number(summary.channelsChanged || 0) * 4;
    score += Number(summary.channelsRemoved || 0) * 6;
    score += Number(summary.emojisAdded || 0) * 1;
    score += Number(summary.emojisChanged || 0) * 1;
    score += Number(summary.emojisRemoved || 0) * 2;
    score += Number(summary.stickersAdded || 0) * 1;
    score += Number(summary.stickersChanged || 0) * 1;
    score += Number(summary.stickersRemoved || 0) * 2;
    score += (validation.warnings || []).length * 4;
    score += (validation.errors || []).length * 18;

    const level = score >= 50
        ? 'critical'
        : score >= 28
            ? 'high'
            : score >= 12
                ? 'medium'
                : 'low';

    const reasons = [];
    const validationErrors = Array.isArray(validation.errors) ? validation.errors : [];
    const validationWarnings = Array.isArray(validation.warnings) ? validation.warnings : [];

    if (validationErrors.length) {
        reasons.push(`Validation errors: ${validationErrors.join(' | ')}`);
    }
    if (validationWarnings.length) {
        reasons.push(`Validation warnings: ${validationWarnings.join(' | ')}`);
    }
    if (Number(summary.channelsRemoved || 0) > 0) reasons.push(`Restore may diverge from ${summary.channelsRemoved} live channel(s).`);
    if (Number(summary.rolesRemoved || 0) > 0) reasons.push(`Restore may diverge from ${summary.rolesRemoved} live role(s).`);
    if (Number(summary.channelsChanged || 0) + Number(summary.rolesChanged || 0) >= 8) reasons.push('Large structural drift exists between the snapshot and live server.');
    if (Number(summary.settingsChanged || 0) > 0) reasons.push('Guild-level settings differ from the selected backup.');
    if (!reasons.length) reasons.push('The snapshot is close to the current server state.');

    return {
        score,
        level,
        reasons,
        validation,
        warnings: validationWarnings,
        errors: validationErrors,
        diffSummary: summary
    };
}

function applyRestoreExclusionsToPayload(payload, rawExclusions = {}) {
    const exclusions = normalizeRestoreExclusions(rawExclusions);
    if (!payload || (!exclusions.roleNames.length && !exclusions.channelNames.length)) {
        return payload;
    }

    const cloned = JSON.parse(JSON.stringify(payload));
    if (Array.isArray(cloned.roles) && exclusions.roleNames.length) {
        cloned.roles = cloned.roles.filter((role) => !exclusions.roleNames.includes(normalizeRoleKey(role?.name)));
    }
    if (Array.isArray(cloned.channels) && exclusions.channelNames.length) {
        cloned.channels = cloned.channels.filter((channel) => !exclusions.channelNames.includes(normalizeRoleKey(channel?.name)));
    }

    if (cloned.metadata && typeof cloned.metadata === 'object') {
        cloned.metadata.restoreExclusions = exclusions;
        if (cloned.metadata.integrity && typeof cloned.metadata.integrity === 'object') {
            cloned.metadata.integrity = {
                ...cloned.metadata.integrity,
                payloadHash: computeBackupPayloadHash(cloned)
            };
        }
    }

    return cloned;
}

function buildBackupTimeline({ guildId = null, limit = 6 } = {}) {
    const files = listServerBackupFiles({ guildId }).slice(0, Math.max(2, Number(limit) || 6));
    const entries = [];

    for (let index = 0; index < files.length - 1; index += 1) {
        try {
            const newer = inspectServerBackupFile(files[index].name);
            const older = inspectServerBackupFile(files[index + 1].name);
            const diff = buildSnapshotDiff(readServerBackupFile(files[index].name), readServerBackupFile(files[index + 1].name), {
                sourceLabel: newer.label || newer.file.name,
                targetLabel: older.label || older.file.name
            });
            const totalChanges = Object.values(diff.summary || {}).reduce((sum, value) => sum + Number(value || 0), 0);

            entries.push({
                currentFile: newer.file.name,
                previousFile: older.file.name,
                currentLabel: newer.label || null,
                previousLabel: older.label || null,
                currentCreatedAt: newer.file.createdAt,
                previousCreatedAt: older.file.createdAt,
                totalChanges,
                summary: diff.summary
            });
        } catch {
            // Ignore invalid timeline entries.
        }
    }

    return entries;
}

function buildServerBackupAnalytics({ guildId = null, limit = 20 } = {}) {
    const files = listServerBackupFiles({ guildId }).slice(0, Math.max(1, Number(limit) || 20));
    const inspections = files.map((file) => {
        try {
            return inspectServerBackupFile(file.name);
        } catch {
            return null;
        }
    }).filter(Boolean);

    const snapshotCount = inspections.length;
    const healthyCount = inspections.filter((entry) => entry.validation?.valid).length;
    const warningCount = inspections.filter((entry) => (entry.validation?.warnings || []).length > 0).length;
    const totalSize = inspections.reduce((accumulator, entry) => accumulator + Number(entry.file?.size || 0), 0);
    const averageSize = snapshotCount ? Math.round(totalSize / snapshotCount) : 0;
    const latest = inspections[0] || null;

    const triggerBreakdown = inspections.reduce((accumulator, entry) => {
        const trigger = String(entry.trigger || 'unknown');
        const key = trigger.startsWith('command:')
            ? 'command'
            : trigger.startsWith('scheduled')
                ? 'scheduled'
                : trigger.startsWith('manual')
                    ? 'manual'
                    : 'other';
        accumulator[key] = Number(accumulator[key] || 0) + 1;
        return accumulator;
    }, { manual: 0, scheduled: 0, command: 0, other: 0 });

    const signedCount = inspections.filter((entry) => entry.manifest?.available && entry.manifest?.signed).length;

    return {
        snapshotCount,
        healthyCount,
        warningCount,
        averageSize,
        latestLabel: latest?.label || null,
        latestGeneratedAt: latest?.generatedAt || latest?.file?.createdAt || null,
        triggerBreakdown,
        signedCount
    };
}

function loadServerBackupConfig() {
    try {
        if (!fs.existsSync(SERVER_BACKUP_CONFIG_PATH)) {
            fs.writeFileSync(
                SERVER_BACKUP_CONFIG_PATH,
                `${JSON.stringify(DEFAULT_SERVER_BACKUP_CONFIG, null, '\t')}\n`,
                'utf8'
            );
            return { ...DEFAULT_SERVER_BACKUP_CONFIG, includes: { ...DEFAULT_BACKUP_INCLUDES } };
        }

        const raw = fs.readFileSync(SERVER_BACKUP_CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return {
            ...DEFAULT_SERVER_BACKUP_CONFIG,
            ...(parsed && typeof parsed === 'object' ? parsed : {}),
            includes: normalizeBackupIncludes(parsed?.includes || {})
        };
    } catch (error) {
        console.error('[ServerBackup] Failed to load config:', error.message);
        return { ...DEFAULT_SERVER_BACKUP_CONFIG, includes: { ...DEFAULT_BACKUP_INCLUDES } };
    }
}

function saveServerBackupConfig(config) {
    const nextConfig = {
        ...DEFAULT_SERVER_BACKUP_CONFIG,
        ...(config && typeof config === 'object' ? config : {}),
        includes: normalizeBackupIncludes(config?.includes || {})
    };
    fs.writeFileSync(SERVER_BACKUP_CONFIG_PATH, `${JSON.stringify(nextConfig, null, '\t')}\n`, 'utf8');
    return nextConfig;
}

function getServerBackupFilePath(fileName) {
    const safeName = path.basename(String(fileName || '').trim());
    if (safeName.endsWith('.manifest.json') || !/^server-backup-\d{17,19}-.+\.json$/i.test(safeName)) {
        return null;
    }
    return path.join(SERVER_BACKUP_DIR, safeName);
}

function listServerBackupFiles({ guildId = null } = {}) {
    try {
        ensureServerBackupDir();
        const safeGuildId = guildId ? String(guildId).trim() : '';
        const filePrefix = safeGuildId ? `server-backup-${safeGuildId}-` : 'server-backup-';

        return fs.readdirSync(SERVER_BACKUP_DIR)
            .filter((fileName) => fileName.endsWith('.json') && !fileName.endsWith('.manifest.json') && fileName.startsWith(filePrefix))
            .map((fileName) => {
                const fullPath = path.join(SERVER_BACKUP_DIR, fileName);
                const stat = fs.statSync(fullPath);
                return {
                    name: fileName,
                    size: stat.size,
                    createdAt: stat.mtimeMs
                };
            })
            .sort((left, right) => right.createdAt - left.createdAt);
    } catch (error) {
        console.error('[ServerBackup] Failed to list files:', error.message);
        return [];
    }
}

function pruneServerBackups({ guildId, retentionCount }) {
    const safeRetention = Math.max(1, Number(retentionCount) || DEFAULT_SERVER_BACKUP_CONFIG.retentionCount);
    const oldFiles = listServerBackupFiles({ guildId }).slice(safeRetention);

    oldFiles.forEach((file) => {
        try {
            fs.unlinkSync(path.join(SERVER_BACKUP_DIR, file.name));
        } catch (error) {
            console.warn('[ServerBackup] Failed to prune backup:', error.message);
        }

        try {
            const manifestPath = getServerBackupManifestPath(file.name);
            if (manifestPath && fs.existsSync(manifestPath)) {
                fs.unlinkSync(manifestPath);
            }
        } catch (error) {
            console.warn('[ServerBackup] Failed to prune backup manifest:', error.message);
        }
    });
}

function readServerBackupFile(fileName) {
    const filePath = getServerBackupFilePath(fileName);
    if (!filePath || !fs.existsSync(filePath)) {
        throw new Error('Backup file not found.');
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
        ...parsed,
        metadata: {
            ...(parsed?.metadata || {}),
            includes: normalizeBackupIncludes(parsed?.metadata?.includes || {})
        },
        roles: Array.isArray(parsed?.roles) ? parsed.roles : [],
        channels: Array.isArray(parsed?.channels) ? parsed.channels : [],
        emojis: Array.isArray(parsed?.emojis) ? parsed.emojis : [],
        stickers: Array.isArray(parsed?.stickers) ? parsed.stickers : []
    };
}

function serializePermissionOverwrites(channel) {
    if (!channel?.permissionOverwrites?.cache) {
        return [];
    }

    return Array.from(channel.permissionOverwrites.cache.values())
        .sort((left, right) => String(left.id).localeCompare(String(right.id)))
        .map((overwrite) => ({
            id: overwrite.id,
            type: overwrite.type,
            allow: overwrite.allow?.bitfield?.toString?.() || '0',
            deny: overwrite.deny?.bitfield?.toString?.() || '0'
        }));
}

function serializeChannel(channel, includes) {
    const serialized = {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        typeName: CHANNEL_TYPE_NAMES[channel.type] || String(channel.type),
        position: Number(channel.rawPosition ?? channel.position ?? 0),
        parentId: channel.parentId || null,
        nsfw: Boolean(channel.nsfw)
    };

    if (includes.permissionOverwrites) {
        serialized.permissionOverwrites = serializePermissionOverwrites(channel);
    }

    if ('topic' in channel) serialized.topic = channel.topic || null;
    if ('rateLimitPerUser' in channel) serialized.rateLimitPerUser = Number(channel.rateLimitPerUser || 0);
    if ('defaultAutoArchiveDuration' in channel) serialized.defaultAutoArchiveDuration = Number(channel.defaultAutoArchiveDuration || 0);
    if ('defaultThreadRateLimitPerUser' in channel) serialized.defaultThreadRateLimitPerUser = Number(channel.defaultThreadRateLimitPerUser || 0);
    if ('bitrate' in channel) serialized.bitrate = Number(channel.bitrate || 0);
    if ('userLimit' in channel) serialized.userLimit = Number(channel.userLimit || 0);
    if ('rtcRegion' in channel) serialized.rtcRegion = channel.rtcRegion || null;
    if ('videoQualityMode' in channel) serialized.videoQualityMode = Number(channel.videoQualityMode || 0);
    if ('defaultForumLayout' in channel) serialized.defaultForumLayout = Number(channel.defaultForumLayout || 0);
    if ('defaultSortOrder' in channel) serialized.defaultSortOrder = channel.defaultSortOrder ?? null;

    if (Array.isArray(channel.availableTags)) {
        serialized.availableTags = channel.availableTags.map((tag) => ({
            id: tag.id,
            name: tag.name,
            moderated: Boolean(tag.moderated),
            emojiId: tag.emojiId || null,
            emojiName: tag.emojiName || null
        }));
    }

    if (channel.defaultReactionEmoji) {
        serialized.defaultReactionEmoji = {
            emojiId: channel.defaultReactionEmoji.emojiId || null,
            emojiName: channel.defaultReactionEmoji.emojiName || null
        };
    }

    return serialized;
}

function serializeRole(role) {
    return {
        id: role.id,
        name: role.name,
        color: role.hexColor,
        hoist: Boolean(role.hoist),
        mentionable: Boolean(role.mentionable),
        managed: Boolean(role.managed),
        permissions: role.permissions?.bitfield?.toString?.() || '0',
        position: Number(role.position || 0),
        iconURL: role.iconURL?.() || null,
        unicodeEmoji: role.unicodeEmoji || null,
        tags: role.tags
            ? {
                botId: role.tags.botId || null,
                integrationId: role.tags.integrationId || null,
                subscriptionListingId: role.tags.subscriptionListingId || null,
                premiumSubscriberRole: Boolean(role.tags.premiumSubscriberRole),
                availableForPurchase: Boolean(role.tags.availableForPurchase),
                guildConnections: Boolean(role.tags.guildConnections)
            }
            : null
    };
}

function serializeEmoji(emoji) {
    return {
        id: emoji.id,
        name: emoji.name,
        animated: Boolean(emoji.animated),
        managed: Boolean(emoji.managed),
        available: emoji.available !== false,
        url: emoji.imageURL() || null
    };
}

function serializeSticker(sticker) {
    return {
        id: sticker.id,
        name: sticker.name,
        description: sticker.description || null,
        format: Number(sticker.format || 0),
        type: Number(sticker.type || 0),
        tags: sticker.tags || null,
        available: sticker.available !== false,
        url: sticker.url || null
    };
}

async function buildGuildBackupPayload(guild, { trigger = 'manual', includes = DEFAULT_BACKUP_INCLUDES } = {}) {
    const normalizedIncludes = normalizeBackupIncludes(includes);
    await guild.fetch().catch(() => null);

    const fetchTasks = [];
    if (normalizedIncludes.channels) fetchTasks.push(guild.channels.fetch());
    if (normalizedIncludes.roles) fetchTasks.push(guild.roles.fetch());
    if (normalizedIncludes.emojis) fetchTasks.push(guild.emojis.fetch());
    if (normalizedIncludes.stickers) fetchTasks.push(guild.stickers.fetch());
    await Promise.allSettled(fetchTasks);

    const channels = normalizedIncludes.channels
        ? Array.from(guild.channels.cache.values())
            .filter((channel) => !channel.isThread?.())
            .sort((left, right) => {
                const positionDiff = Number(left.rawPosition ?? 0) - Number(right.rawPosition ?? 0);
                return positionDiff || String(left.id).localeCompare(String(right.id));
            })
            .map((channel) => serializeChannel(channel, normalizedIncludes))
        : [];

    const roles = normalizedIncludes.roles
        ? Array.from(guild.roles.cache.values())
            .sort((left, right) => {
                const positionDiff = Number(left.position || 0) - Number(right.position || 0);
                return positionDiff || String(left.id).localeCompare(String(right.id));
            })
            .map(serializeRole)
        : [];

    const emojis = normalizedIncludes.emojis
        ? Array.from(guild.emojis.cache.values())
            .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')))
            .map(serializeEmoji)
        : [];

    const stickers = normalizedIncludes.stickers
        ? Array.from(guild.stickers.cache.values())
            .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')))
            .map(serializeSticker)
        : [];

    return {
        type: 'sentinel-server-backup',
        version: 2,
        generatedAt: new Date().toISOString(),
        trigger,
        guild: normalizedIncludes.settings
            ? {
                id: guild.id,
                name: guild.name,
                description: guild.description || null,
                iconURL: guild.iconURL({ size: 1024 }) || null,
                bannerURL: guild.bannerURL({ size: 1024 }) || null,
                splashURL: guild.splashURL({ size: 1024 }) || null,
                preferredLocale: guild.preferredLocale || null,
                verificationLevel: Number(guild.verificationLevel || 0),
                explicitContentFilter: Number(guild.explicitContentFilter || 0),
                defaultMessageNotifications: Number(guild.defaultMessageNotifications || 0),
                mfaLevel: Number(guild.mfaLevel || 0),
                afkChannelId: guild.afkChannelId || null,
                afkTimeout: Number(guild.afkTimeout || 0),
                systemChannelId: guild.systemChannelId || null,
                systemChannelFlags: guild.systemChannelFlags?.bitfield?.toString?.() || '0',
                rulesChannelId: guild.rulesChannelId || null,
                publicUpdatesChannelId: guild.publicUpdatesChannelId || null,
                premiumTier: Number(guild.premiumTier || 0),
                nsfwLevel: Number(guild.nsfwLevel || 0),
                ownerId: guild.ownerId || null,
                features: Array.isArray(guild.features) ? [...guild.features].sort() : []
            }
            : { id: guild.id, name: guild.name },
        metadata: {
            channelCount: channels.length,
            roleCount: roles.length,
            emojiCount: emojis.length,
            stickerCount: stickers.length,
            memberCount: Number(guild.memberCount || 0),
            includes: normalizedIncludes
        },
        roles,
        channels,
        emojis,
        stickers
    };
}

function normalizeRoleKey(name) {
    return String(name || '').trim().toLowerCase();
}

function getChannelRestoreKey(channel) {
    return `${Number(channel?.type || 0)}:${String(channel?.name || '').trim().toLowerCase()}`;
}

function simplifyRoleForDiff(role) {
    return JSON.stringify({
        name: role?.name || '',
        color: role?.color || '#000000',
        hoist: Boolean(role?.hoist),
        mentionable: Boolean(role?.mentionable),
        managed: Boolean(role?.managed),
        permissions: String(role?.permissions || '0'),
        unicodeEmoji: role?.unicodeEmoji || null
    });
}

function simplifyChannelForDiff(channel) {
    return JSON.stringify({
        name: channel?.name || '',
        type: Number(channel?.type || 0),
        parentId: channel?.parentId || null,
        topic: channel?.topic || null,
        nsfw: Boolean(channel?.nsfw),
        rateLimitPerUser: Number(channel?.rateLimitPerUser || 0),
        bitrate: Number(channel?.bitrate || 0),
        userLimit: Number(channel?.userLimit || 0),
        defaultAutoArchiveDuration: Number(channel?.defaultAutoArchiveDuration || 0),
        defaultThreadRateLimitPerUser: Number(channel?.defaultThreadRateLimitPerUser || 0),
        overwriteCount: Array.isArray(channel?.permissionOverwrites) ? channel.permissionOverwrites.length : 0,
        tagCount: Array.isArray(channel?.availableTags) ? channel.availableTags.length : 0
    });
}

function simplifyEmojiForDiff(emoji) {
    return JSON.stringify({
        name: emoji?.name || '',
        animated: Boolean(emoji?.animated),
        available: emoji?.available !== false
    });
}

function simplifyStickerForDiff(sticker) {
    return JSON.stringify({
        name: sticker?.name || '',
        description: sticker?.description || null,
        format: Number(sticker?.format || 0),
        tags: sticker?.tags || null,
        available: sticker?.available !== false
    });
}

function diffCollections(sourceItems, targetItems, getKey, simplify, formatter) {
    const sourceMap = new Map(sourceItems.map((item) => [getKey(item), item]));
    const targetMap = new Map(targetItems.map((item) => [getKey(item), item]));
    const added = [];
    const removed = [];
    const changed = [];

    for (const [key, sourceItem] of sourceMap.entries()) {
        if (!targetMap.has(key)) {
            added.push(formatter(sourceItem));
            continue;
        }
        const targetItem = targetMap.get(key);
        if (simplify(sourceItem) !== simplify(targetItem)) {
            changed.push(formatter(sourceItem));
        }
    }

    for (const [key, targetItem] of targetMap.entries()) {
        if (!sourceMap.has(key)) {
            removed.push(formatter(targetItem));
        }
    }

    return { added, removed, changed };
}

function formatDiffItem(label, extra = '') {
    return extra ? `${label} (${extra})` : label;
}

function buildSnapshotDiff(sourcePayload, targetPayload, { sourceLabel = 'Selected Backup', targetLabel = 'Current State' } = {}) {
    const sourceRoles = Array.isArray(sourcePayload?.roles) ? sourcePayload.roles : [];
    const targetRoles = Array.isArray(targetPayload?.roles) ? targetPayload.roles : [];
    const sourceChannels = Array.isArray(sourcePayload?.channels) ? sourcePayload.channels : [];
    const targetChannels = Array.isArray(targetPayload?.channels) ? targetPayload.channels : [];
    const sourceEmojis = Array.isArray(sourcePayload?.emojis) ? sourcePayload.emojis : [];
    const targetEmojis = Array.isArray(targetPayload?.emojis) ? targetPayload.emojis : [];
    const sourceStickers = Array.isArray(sourcePayload?.stickers) ? sourcePayload.stickers : [];
    const targetStickers = Array.isArray(targetPayload?.stickers) ? targetPayload.stickers : [];

    const roleDiff = diffCollections(
        sourceRoles,
        targetRoles,
        (role) => normalizeRoleKey(role?.name),
        simplifyRoleForDiff,
        (role) => formatDiffItem(role?.name || 'Unnamed Role')
    );

    const channelDiff = diffCollections(
        sourceChannels,
        targetChannels,
        getChannelRestoreKey,
        simplifyChannelForDiff,
        (channel) => formatDiffItem(channel?.name || 'Unnamed Channel', channel?.typeName || String(channel?.type || 0))
    );

    const emojiDiff = diffCollections(
        sourceEmojis,
        targetEmojis,
        (emoji) => normalizeRoleKey(emoji?.name),
        simplifyEmojiForDiff,
        (emoji) => formatDiffItem(emoji?.name || 'Unnamed Emoji')
    );

    const stickerDiff = diffCollections(
        sourceStickers,
        targetStickers,
        (sticker) => normalizeRoleKey(sticker?.name),
        simplifyStickerForDiff,
        (sticker) => formatDiffItem(sticker?.name || 'Unnamed Sticker')
    );

    const settingChanges = [];
    const sourceSettings = sourcePayload?.guild || {};
    const targetSettings = targetPayload?.guild || {};
    [
        ['description', 'Description'],
        ['preferredLocale', 'Preferred Locale'],
        ['verificationLevel', 'Verification Level'],
        ['explicitContentFilter', 'Explicit Content Filter'],
        ['defaultMessageNotifications', 'Default Message Notifications'],
        ['afkTimeout', 'AFK Timeout'],
        ['rulesChannelId', 'Rules Channel'],
        ['systemChannelId', 'System Channel'],
        ['publicUpdatesChannelId', 'Public Updates Channel']
    ].forEach(([key, label]) => {
        if ((sourceSettings?.[key] ?? null) !== (targetSettings?.[key] ?? null)) {
            settingChanges.push(label);
        }
    });

    return {
        sourceLabel,
        targetLabel,
        summary: {
            settingsChanged: settingChanges.length,
            rolesAdded: roleDiff.added.length,
            rolesRemoved: roleDiff.removed.length,
            rolesChanged: roleDiff.changed.length,
            channelsAdded: channelDiff.added.length,
            channelsRemoved: channelDiff.removed.length,
            channelsChanged: channelDiff.changed.length,
            emojisAdded: emojiDiff.added.length,
            emojisRemoved: emojiDiff.removed.length,
            emojisChanged: emojiDiff.changed.length,
            stickersAdded: stickerDiff.added.length,
            stickersRemoved: stickerDiff.removed.length,
            stickersChanged: stickerDiff.changed.length
        },
        details: {
            settingsChanged: settingChanges,
            roles: roleDiff,
            channels: channelDiff,
            emojis: emojiDiff,
            stickers: stickerDiff
        }
    };
}

function buildChannelOptions(snapshotChannel, parentId, permissionOverwrites) {
    const options = {
        name: snapshotChannel.name,
        type: snapshotChannel.type
    };

    if (parentId && snapshotChannel.type !== ChannelType.GuildCategory) {
        options.parent = parentId;
    }
    if (typeof snapshotChannel.nsfw === 'boolean') options.nsfw = snapshotChannel.nsfw;
    if (permissionOverwrites.length) options.permissionOverwrites = permissionOverwrites;

    if ([ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(snapshotChannel.type)) {
        options.topic = snapshotChannel.topic || null;
        options.rateLimitPerUser = Number(snapshotChannel.rateLimitPerUser || 0);
        options.defaultAutoArchiveDuration = Number(snapshotChannel.defaultAutoArchiveDuration || 0);
        options.defaultThreadRateLimitPerUser = Number(snapshotChannel.defaultThreadRateLimitPerUser || 0);
    }

    if ([ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(snapshotChannel.type)) {
        options.bitrate = Number(snapshotChannel.bitrate || 0);
        options.userLimit = Number(snapshotChannel.userLimit || 0);
        options.rtcRegion = snapshotChannel.rtcRegion || null;
        options.videoQualityMode = Number(snapshotChannel.videoQualityMode || 0);
    }

    if (snapshotChannel.type === ChannelType.GuildForum) {
        options.topic = snapshotChannel.topic || null;
        options.defaultAutoArchiveDuration = Number(snapshotChannel.defaultAutoArchiveDuration || 0);
        options.defaultThreadRateLimitPerUser = Number(snapshotChannel.defaultThreadRateLimitPerUser || 0);
        options.defaultForumLayout = Number(snapshotChannel.defaultForumLayout || 0);
        options.defaultSortOrder = snapshotChannel.defaultSortOrder ?? null;
        options.availableTags = Array.isArray(snapshotChannel.availableTags)
            ? snapshotChannel.availableTags.map((tag) => ({
                name: tag.name,
                moderated: Boolean(tag.moderated),
                emojiId: tag.emojiId || undefined,
                emojiName: tag.emojiName || undefined
            }))
            : [];
        if (snapshotChannel.defaultReactionEmoji) {
            options.defaultReactionEmoji = {
                emojiId: snapshotChannel.defaultReactionEmoji.emojiId || undefined,
                emojiName: snapshotChannel.defaultReactionEmoji.emojiName || undefined
            };
        }
    }

    return options;
}

function buildOverwritePayload(guild, snapshotChannel, roleIdMap) {
    const overwrites = Array.isArray(snapshotChannel.permissionOverwrites) ? snapshotChannel.permissionOverwrites : [];
    return overwrites
        .map((overwrite) => {
            let resolvedId = null;
            if (overwrite.id === snapshotChannel.guildId || overwrite.id === guild.id) {
                resolvedId = guild.id;
            } else if (roleIdMap.has(overwrite.id)) {
                resolvedId = roleIdMap.get(overwrite.id);
            }

            if (!resolvedId) return null;
            return {
                id: resolvedId,
                allow: overwrite.allow || '0',
                deny: overwrite.deny || '0',
                type: overwrite.type
            };
        })
        .filter(Boolean);
}

function emitRestoreProgress(onProgress, progress = {}) {
    if (typeof onProgress !== 'function') {
        return;
    }

    try {
        onProgress({
            ...progress,
            timestamp: Date.now()
        });
    } catch (_error) {
        // Progress reporting must never interrupt the restore itself.
    }
}

async function restoreRolesFromBackup(guild, payloadRoles, exclusions = normalizeRestoreExclusions(), onProgress = null) {
    const roleIdMap = new Map();
    const stats = { created: 0, updated: 0, skipped: 0, failed: 0 };
    const warnings = [];
    await guild.roles.fetch();

    const usableRoles = payloadRoles
        .filter((role) => role?.name && role.name !== '@everyone' && !role.managed)
        .sort((left, right) => Number(left.position || 0) - Number(right.position || 0));
    const totalRoles = usableRoles.length;
    let processedRoles = 0;

    emitRestoreProgress(onProgress, {
        phase: 'roles',
        stage: 'started',
        processed: 0,
        total: totalRoles,
        message: totalRoles
            ? `Restoring ${totalRoles} role${totalRoles === 1 ? '' : 's'}.`
            : 'No roles were included in this restore.'
    });

    for (const snapshotRole of usableRoles) {
        if (exclusions.roleNames.includes(normalizeRoleKey(snapshotRole.name))) {
            stats.skipped += 1;
            processedRoles += 1;
            emitRestoreProgress(onProgress, {
                phase: 'roles',
                stage: 'processing',
                currentLabel: snapshotRole.name,
                processed: processedRoles,
                total: totalRoles,
                message: `Skipped excluded role ${snapshotRole.name}.`
            });
            continue;
        }
        const existing = guild.roles.cache.find((role) => !role.managed && normalizeRoleKey(role.name) === normalizeRoleKey(snapshotRole.name));
        const roleData = {
            name: snapshotRole.name,
            colors: snapshotRole.color || '#000000',
            hoist: Boolean(snapshotRole.hoist),
            mentionable: Boolean(snapshotRole.mentionable),
            permissions: snapshotRole.permissions || '0',
            unicodeEmoji: snapshotRole.unicodeEmoji || undefined
        };

        let liveRole = existing;
        if (existing) {
            const updatedRole = await existing.edit(roleData).catch((error) => {
                stats.failed += 1;
                warnings.push(`Failed to update role ${snapshotRole.name}: ${error.message || error}`);
                return null;
            });
            if (updatedRole) {
                liveRole = updatedRole;
                stats.updated += 1;
            }
        } else {
            liveRole = await guild.roles.create(roleData).catch((error) => {
                stats.failed += 1;
                warnings.push(`Failed to create role ${snapshotRole.name}: ${error.message || error}`);
                return null;
            });
            if (liveRole) stats.created += 1;
        }

        if (liveRole) {
            roleIdMap.set(snapshotRole.id, liveRole.id);
            if (typeof liveRole.setPosition === 'function') {
                await liveRole.setPosition(Math.max(1, Number(snapshotRole.position || 1))).catch((error) => {
                    warnings.push(`Failed to position role ${snapshotRole.name}: ${error.message || error}`);
                });
            }
        }

        processedRoles += 1;
        emitRestoreProgress(onProgress, {
            phase: 'roles',
            stage: 'processing',
            currentLabel: snapshotRole.name,
            processed: processedRoles,
            total: totalRoles,
            message: liveRole
                ? `${existing ? 'Updated' : 'Created'} role ${snapshotRole.name}.`
                : `Processed role ${snapshotRole.name} with warnings.`
        });
    }

    emitRestoreProgress(onProgress, {
        phase: 'roles',
        stage: 'completed',
        processed: processedRoles,
        total: totalRoles,
        message: `Roles complete: ${stats.created} created, ${stats.updated} updated, ${stats.skipped} skipped, ${stats.failed} failed.`
    });

    return { roleIdMap, stats, warnings };
}

async function restoreChannelsFromBackup(guild, payloadChannels, roleIdMap, applyPermissionOverwrites, exclusions = normalizeRestoreExclusions(), onProgress = null) {
    const channelIdMap = new Map();
    const stats = { created: 0, updated: 0, overwriteSyncs: 0, skipped: 0, failed: 0 };
    const warnings = [];
    await guild.channels.fetch();

    const totalChannels = Array.isArray(payloadChannels) ? payloadChannels.length : 0;
    let processedChannels = 0;

    emitRestoreProgress(onProgress, {
        phase: 'channels',
        stage: 'started',
        processed: 0,
        total: totalChannels,
        message: totalChannels
            ? `Restoring ${totalChannels} channel${totalChannels === 1 ? '' : 's'} and categor${totalChannels === 1 ? 'y' : 'ies'}.`
            : 'No channels were included in this restore.'
    });

    const categories = payloadChannels
        .filter((channel) => channel.type === ChannelType.GuildCategory)
        .sort((left, right) => Number(left.position || 0) - Number(right.position || 0));

    for (const snapshotCategory of categories) {
        if (exclusions.channelNames.includes(normalizeRoleKey(snapshotCategory.name))) {
            stats.skipped += 1;
            processedChannels += 1;
            emitRestoreProgress(onProgress, {
                phase: 'channels',
                stage: 'processing',
                currentLabel: snapshotCategory.name,
                processed: processedChannels,
                total: totalChannels,
                message: `Skipped excluded category ${snapshotCategory.name}.`
            });
            continue;
        }
        const existing = guild.channels.cache.find((channel) => channel.type === ChannelType.GuildCategory && normalizeRoleKey(channel.name) === normalizeRoleKey(snapshotCategory.name));
        const overwritePayload = applyPermissionOverwrites ? buildOverwritePayload(guild, snapshotCategory, roleIdMap) : [];
        const options = buildChannelOptions(snapshotCategory, null, overwritePayload);
        let liveChannel = existing;

        if (existing) {
            const updatedChannel = await existing.edit(options).catch((error) => {
                stats.failed += 1;
                warnings.push(`Failed to update category ${snapshotCategory.name}: ${error.message || error}`);
                return null;
            });
            if (updatedChannel) {
                liveChannel = updatedChannel;
                stats.updated += 1;
            }
        } else {
            liveChannel = await guild.channels.create(options).catch((error) => {
                stats.failed += 1;
                warnings.push(`Failed to create category ${snapshotCategory.name}: ${error.message || error}`);
                return null;
            });
            if (liveChannel) stats.created += 1;
        }

        if (liveChannel) {
            channelIdMap.set(snapshotCategory.id, liveChannel.id);
            if (overwritePayload.length) stats.overwriteSyncs += 1;
            if (typeof liveChannel.setPosition === 'function') {
                await liveChannel.setPosition(Number(snapshotCategory.position || 0)).catch((error) => {
                    warnings.push(`Failed to position category ${snapshotCategory.name}: ${error.message || error}`);
                });
            }
        }

        processedChannels += 1;
        emitRestoreProgress(onProgress, {
            phase: 'channels',
            stage: 'processing',
            currentLabel: snapshotCategory.name,
            processed: processedChannels,
            total: totalChannels,
            message: liveChannel
                ? `${existing ? 'Updated' : 'Created'} category ${snapshotCategory.name}.`
                : `Processed category ${snapshotCategory.name} with warnings.`
        });
    }

    const remainingChannels = payloadChannels
        .filter((channel) => channel.type !== ChannelType.GuildCategory)
        .sort((left, right) => Number(left.position || 0) - Number(right.position || 0));

    for (const snapshotChannel of remainingChannels) {
        if (exclusions.channelNames.includes(normalizeRoleKey(snapshotChannel.name))) {
            stats.skipped += 1;
            processedChannels += 1;
            emitRestoreProgress(onProgress, {
                phase: 'channels',
                stage: 'processing',
                currentLabel: snapshotChannel.name,
                processed: processedChannels,
                total: totalChannels,
                message: `Skipped excluded channel ${snapshotChannel.name}.`
            });
            continue;
        }
        const parentId = snapshotChannel.parentId ? channelIdMap.get(snapshotChannel.parentId) || null : null;
        const overwritePayload = applyPermissionOverwrites ? buildOverwritePayload(guild, snapshotChannel, roleIdMap) : [];
        const options = buildChannelOptions(snapshotChannel, parentId, overwritePayload);
        const exactMatch = guild.channels.cache.find((channel) => (
            !channel.isThread?.()
            && channel.type === snapshotChannel.type
            && normalizeRoleKey(channel.name) === normalizeRoleKey(snapshotChannel.name)
            && (parentId ? channel.parentId === parentId : true)
        ));
        const fallbackMatch = guild.channels.cache.find((channel) => (
            !channel.isThread?.()
            && channel.type === snapshotChannel.type
            && normalizeRoleKey(channel.name) === normalizeRoleKey(snapshotChannel.name)
        ));
        let liveChannel = exactMatch || fallbackMatch || null;

        if (liveChannel) {
            const updatedChannel = await liveChannel.edit(options).catch((error) => {
                stats.failed += 1;
                warnings.push(`Failed to update channel ${snapshotChannel.name}: ${error.message || error}`);
                return null;
            });
            if (updatedChannel) {
                liveChannel = updatedChannel;
                stats.updated += 1;
            }
        } else {
            liveChannel = await guild.channels.create(options).catch((error) => {
                stats.failed += 1;
                warnings.push(`Failed to create channel ${snapshotChannel.name}: ${error.message || error}`);
                return null;
            });
            if (liveChannel) stats.created += 1;
        }

        if (liveChannel) {
            channelIdMap.set(snapshotChannel.id, liveChannel.id);
            if (overwritePayload.length) stats.overwriteSyncs += 1;
            if (typeof liveChannel.setPosition === 'function') {
                await liveChannel.setPosition(Number(snapshotChannel.position || 0)).catch((error) => {
                    warnings.push(`Failed to position channel ${snapshotChannel.name}: ${error.message || error}`);
                });
            }
        }

        processedChannels += 1;
        emitRestoreProgress(onProgress, {
            phase: 'channels',
            stage: 'processing',
            currentLabel: snapshotChannel.name,
            processed: processedChannels,
            total: totalChannels,
            message: liveChannel
                ? `${exactMatch || fallbackMatch ? 'Updated' : 'Created'} channel ${snapshotChannel.name}.`
                : `Processed channel ${snapshotChannel.name} with warnings.`
        });
    }

    emitRestoreProgress(onProgress, {
        phase: 'channels',
        stage: 'completed',
        processed: processedChannels,
        total: totalChannels,
        message: `Channels complete: ${stats.created} created, ${stats.updated} updated, ${stats.skipped} skipped, ${stats.failed} failed.`
    });

    return { channelIdMap, stats, warnings };
}

async function restoreSettingsFromBackup(guild, snapshotGuild, channelIdMap, onProgress = null) {
    emitRestoreProgress(onProgress, {
        phase: 'settings',
        stage: 'started',
        processed: 0,
        total: 1,
        message: 'Applying guild settings.'
    });

    if (!snapshotGuild || typeof snapshotGuild !== 'object') {
        emitRestoreProgress(onProgress, {
            phase: 'settings',
            stage: 'completed',
            processed: 0,
            total: 1,
            message: 'No guild settings were included in this restore.'
        });
        return 0;
    }

    const patch = {
        description: snapshotGuild.description || null,
        preferredLocale: snapshotGuild.preferredLocale || undefined,
        verificationLevel: Number(snapshotGuild.verificationLevel || 0),
        explicitContentFilter: Number(snapshotGuild.explicitContentFilter || 0),
        defaultMessageNotifications: Number(snapshotGuild.defaultMessageNotifications || 0),
        afkTimeout: Number(snapshotGuild.afkTimeout || 0),
        afkChannel: snapshotGuild.afkChannelId ? channelIdMap.get(snapshotGuild.afkChannelId) || null : null,
        systemChannel: snapshotGuild.systemChannelId ? channelIdMap.get(snapshotGuild.systemChannelId) || null : null,
        rulesChannel: snapshotGuild.rulesChannelId ? channelIdMap.get(snapshotGuild.rulesChannelId) || null : null,
        publicUpdatesChannel: snapshotGuild.publicUpdatesChannelId ? channelIdMap.get(snapshotGuild.publicUpdatesChannelId) || null : null
    };

    await guild.edit(patch).catch(() => null);
    emitRestoreProgress(onProgress, {
        phase: 'settings',
        stage: 'completed',
        processed: 1,
        total: 1,
        message: 'Guild settings restored.'
    });
    return 1;
}

async function restoreEmojisFromBackup(guild, snapshotEmojis, onProgress = null) {
    const stats = { created: 0, failed: 0 };
    const warnings = [];
    await guild.emojis.fetch().catch(() => null);

    const totalEmojis = Array.isArray(snapshotEmojis) ? snapshotEmojis.length : 0;
    let processedEmojis = 0;

    emitRestoreProgress(onProgress, {
        phase: 'emojis',
        stage: 'started',
        processed: 0,
        total: totalEmojis,
        message: totalEmojis
            ? `Restoring ${totalEmojis} emoji${totalEmojis === 1 ? '' : 's'}.`
            : 'No emojis were included in this restore.'
    });

    for (const snapshotEmoji of snapshotEmojis) {
        if (!snapshotEmoji?.name || !snapshotEmoji?.url) continue;
        const exists = guild.emojis.cache.find((emoji) => normalizeRoleKey(emoji.name) === normalizeRoleKey(snapshotEmoji.name));
        if (exists) {
            processedEmojis += 1;
            emitRestoreProgress(onProgress, {
                phase: 'emojis',
                stage: 'processing',
                currentLabel: snapshotEmoji.name,
                processed: processedEmojis,
                total: totalEmojis,
                message: `Skipped existing emoji ${snapshotEmoji.name}.`
            });
            continue;
        }
        const created = await guild.emojis.create({ attachment: snapshotEmoji.url, name: snapshotEmoji.name }).catch((error) => {
            stats.failed += 1;
            warnings.push(`Failed to create emoji ${snapshotEmoji.name}: ${error.message || error}`);
            return null;
        });
        if (created) stats.created += 1;
        processedEmojis += 1;
        emitRestoreProgress(onProgress, {
            phase: 'emojis',
            stage: 'processing',
            currentLabel: snapshotEmoji.name,
            processed: processedEmojis,
            total: totalEmojis,
            message: created
                ? `Created emoji ${snapshotEmoji.name}.`
                : `Processed emoji ${snapshotEmoji.name} with warnings.`
        });
    }

    emitRestoreProgress(onProgress, {
        phase: 'emojis',
        stage: 'completed',
        processed: processedEmojis,
        total: totalEmojis,
        message: `Emojis complete: ${stats.created} created, ${stats.failed} failed.`
    });

    return { stats, warnings };
}

async function restoreStickersFromBackup(guild, snapshotStickers, onProgress = null) {
    const stats = { created: 0, failed: 0 };
    const warnings = [];
    await guild.stickers.fetch().catch(() => null);

    const totalStickers = Array.isArray(snapshotStickers) ? snapshotStickers.length : 0;
    let processedStickers = 0;

    emitRestoreProgress(onProgress, {
        phase: 'stickers',
        stage: 'started',
        processed: 0,
        total: totalStickers,
        message: totalStickers
            ? `Restoring ${totalStickers} sticker${totalStickers === 1 ? '' : 's'}.`
            : 'No stickers were included in this restore.'
    });

    for (const snapshotSticker of snapshotStickers) {
        if (!snapshotSticker?.name || !snapshotSticker?.url) continue;
        const exists = guild.stickers.cache.find((sticker) => normalizeRoleKey(sticker.name) === normalizeRoleKey(snapshotSticker.name));
        if (exists) {
            processedStickers += 1;
            emitRestoreProgress(onProgress, {
                phase: 'stickers',
                stage: 'processing',
                currentLabel: snapshotSticker.name,
                processed: processedStickers,
                total: totalStickers,
                message: `Skipped existing sticker ${snapshotSticker.name}.`
            });
            continue;
        }
        const created = await guild.stickers.create({
            file: snapshotSticker.url,
            name: snapshotSticker.name,
            description: snapshotSticker.description || '',
            tags: snapshotSticker.tags || 'backup'
        }).catch((error) => {
            stats.failed += 1;
            warnings.push(`Failed to create sticker ${snapshotSticker.name}: ${error.message || error}`);
            return null;
        });
        if (created) stats.created += 1;
        processedStickers += 1;
        emitRestoreProgress(onProgress, {
            phase: 'stickers',
            stage: 'processing',
            currentLabel: snapshotSticker.name,
            processed: processedStickers,
            total: totalStickers,
            message: created
                ? `Created sticker ${snapshotSticker.name}.`
                : `Processed sticker ${snapshotSticker.name} with warnings.`
        });
    }

    emitRestoreProgress(onProgress, {
        phase: 'stickers',
        stage: 'completed',
        processed: processedStickers,
        total: totalStickers,
        message: `Stickers complete: ${stats.created} created, ${stats.failed} failed.`
    });

    return { stats, warnings };
}

async function restoreBackupToGuild(guild, payload, options = {}) {
    const restoreOptions = normalizeRestoreOptions(options);
    const exclusions = normalizeRestoreExclusions(options?.exclusions || options);
    const onProgress = typeof options?.onProgress === 'function' ? options.onProgress : null;
    const summary = {
        settingsUpdated: 0,
        rolesCreated: 0,
        rolesUpdated: 0,
        rolesSkipped: 0,
        rolesFailed: 0,
        channelsCreated: 0,
        channelsUpdated: 0,
        channelsSkipped: 0,
        channelsFailed: 0,
        overwriteSyncs: 0,
        emojisCreated: 0,
        emojisFailed: 0,
        stickersCreated: 0,
        stickersFailed: 0,
        warnings: []
    };

    let roleIdMap = new Map();
    let channelIdMap = new Map();

    emitRestoreProgress(onProgress, {
        phase: 'preparing',
        stage: 'started',
        message: 'Preparing server backup restore.'
    });

    if (restoreOptions.restoreRoles && Array.isArray(payload?.roles)) {
        const roleResult = await restoreRolesFromBackup(guild, payload.roles, exclusions, onProgress);
        roleIdMap = roleResult.roleIdMap;
        summary.rolesCreated = roleResult.stats.created;
        summary.rolesUpdated = roleResult.stats.updated;
        summary.rolesSkipped = roleResult.stats.skipped;
        summary.rolesFailed = roleResult.stats.failed;
        summary.warnings.push(...(roleResult.warnings || []));
    }

    if (restoreOptions.restoreChannels && Array.isArray(payload?.channels)) {
        const channelResult = await restoreChannelsFromBackup(
            guild,
            payload.channels,
            roleIdMap,
            restoreOptions.applyPermissionOverwrites,
            exclusions,
            onProgress
        );
        channelIdMap = channelResult.channelIdMap;
        summary.channelsCreated = channelResult.stats.created;
        summary.channelsUpdated = channelResult.stats.updated;
        summary.channelsSkipped = channelResult.stats.skipped;
        summary.channelsFailed = channelResult.stats.failed;
        summary.overwriteSyncs = channelResult.stats.overwriteSyncs;
        summary.warnings.push(...(channelResult.warnings || []));
    }

    if (restoreOptions.restoreSettings && payload?.guild) {
        summary.settingsUpdated = await restoreSettingsFromBackup(guild, payload.guild, channelIdMap, onProgress);
    }

    if (restoreOptions.restoreEmojis && Array.isArray(payload?.emojis)) {
        const emojiResult = await restoreEmojisFromBackup(guild, payload.emojis, onProgress);
        summary.emojisCreated = emojiResult.stats.created;
        summary.emojisFailed = emojiResult.stats.failed;
        summary.warnings.push(...(emojiResult.warnings || []));
    }

    if (restoreOptions.restoreStickers && Array.isArray(payload?.stickers)) {
        const stickerResult = await restoreStickersFromBackup(guild, payload.stickers, onProgress);
        summary.stickersCreated = stickerResult.stats.created;
        summary.stickersFailed = stickerResult.stats.failed;
        summary.warnings.push(...(stickerResult.warnings || []));
    }

    emitRestoreProgress(onProgress, {
        phase: 'completed',
        stage: 'completed',
        message: summary.warnings.length
            ? 'Restore completed with warnings.'
            : 'Restore completed successfully.'
    });

    return summary;
}

async function createServerBackupFromGuild(guild, {
    trigger = 'manual',
    retentionCount = DEFAULT_SERVER_BACKUP_CONFIG.retentionCount,
    includes = DEFAULT_BACKUP_INCLUDES,
    label = '',
    notes = '',
    requestedBy = null
} = {}) {
    if (!guild?.id) {
        throw new Error('A valid guild is required to create a server backup.');
    }

    ensureServerBackupDir();
    const normalizedIncludes = normalizeBackupIncludes(includes);
    const safeLabel = sanitizeBackupLabel(label);
    const safeNotes = sanitizeBackupNotes(notes);
    const payload = await buildGuildBackupPayload(guild, { trigger, includes: normalizedIncludes });
    payload.version = 3;
    payload.metadata = {
        ...(payload.metadata || {}),
        label: safeLabel || null,
        notes: safeNotes || null,
        requestedBy: requestedBy || null,
        integrity: {
            algorithm: 'sha256',
            payloadHash: computeBackupPayloadHash(payload)
        }
    };
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `server-backup-${guild.id}-${timestamp}.json`;
    const filePath = path.join(SERVER_BACKUP_DIR, fileName);
    const fileBody = JSON.stringify(payload, null, 2);
    fs.writeFileSync(filePath, fileBody, 'utf8');
    const manifest = buildBackupManifest({ fileName, payload, size: Buffer.byteLength(fileBody, 'utf8') });
    writeServerBackupManifest(fileName, manifest);
    pruneServerBackups({ guildId: guild.id, retentionCount });

    return {
        fileName,
        filePath,
        size: Buffer.byteLength(fileBody, 'utf8'),
        createdAt: Date.now(),
        summary: payload.metadata,
        guild: {
            id: payload.guild.id,
            name: payload.guild.name
        },
        includes: normalizedIncludes,
        label: safeLabel || null,
        notes: safeNotes || null,
        manifest
    };
}

module.exports = {
    SERVER_BACKUP_DIR,
    SERVER_BACKUP_CONFIG_PATH,
    DEFAULT_BACKUP_INCLUDES,
    DEFAULT_SERVER_BACKUP_CONFIG,
    DEFAULT_RESTORE_OPTIONS,
    formatBackupBytes,
    ensureServerBackupDir,
    normalizeBackupIncludes,
    normalizeRestoreOptions,
    sanitizeBackupLabel,
    sanitizeBackupNotes,
    normalizeRestoreExclusions,
    applyRestoreExclusionsToPayload,
    loadServerBackupConfig,
    saveServerBackupConfig,
    listServerBackupFiles,
    getServerBackupFilePath,
    getServerBackupManifestPath,
    readServerBackupFile,
    readServerBackupManifest,
    buildGuildBackupPayload,
    buildSnapshotDiff,
    buildRestorePreflightReport,
    buildBackupTimeline,
    buildServerBackupAnalytics,
    validateServerBackupPayload,
    inspectServerBackupFile,
    createServerBackupFromGuild,
    restoreBackupToGuild,
    pruneServerBackups
};