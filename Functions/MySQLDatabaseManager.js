const mysqlConnection = require('./MySQLConnection');
const { MISC: miscConfig, ECONOMY: economyConfigFile } = require('../Config/constants');

// MySQL Database Manager
// A centralized place for all database operations: users, moderation cases,
// levels, bans, and more. This class wraps queries, handles basic validation
// and migrations, and keeps DB logic out of command handlers.

class MySQLDatabaseManager {
    // Makes sure joined_at and created_at are valid ISO date strings for a user.
    // If they're missing or invalid, sets them to fallback values and updates the database.
    // userId: Discord user ID
    // userData: Object with possible joined_at and created_at
    // fallbackJoinedAt: Fallback date string for joined_at
    // fallbackCreatedAt: Fallback date string for created_at
    // Returns updated user info or null.
    async ensureUserDates(userId, userData, fallbackJoinedAt, fallbackCreatedAt) {
        const validId = this.validateDiscordId(userId);
        if (!validId) return null;
        // Helper to check date validity
        function isValidDate(dateStr) {
            if (!dateStr) return false;
            const d = new Date(dateStr);
            return !isNaN(d.getTime());
        }
        // Get current info
        let info = await this.getUserInfo(validId) || {};
        // Use provided data or fallback
        const joinedAt = userData.joined_at || info.joined_at || fallbackJoinedAt;
        const createdAt = userData.created_at || info.created_at || fallbackCreatedAt;
        let updated = false;
        // Validate and update if needed
        if (!isValidDate(joinedAt)) {
            info.joined_at = fallbackJoinedAt;
            updated = true;
        } else {
            info.joined_at = joinedAt;
        }
        if (!isValidDate(createdAt)) {
            info.created_at = fallbackCreatedAt;
            updated = true;
        } else {
            info.created_at = createdAt;
        }
        // Copy other info
        info = { ...info, ...userData };
        // Update DB if changed
        if (updated) {
            await this.connection.query(
                `UPDATE userinfo SET joined_at = ?, created_at = ? WHERE user_id = ?`,
                [info.joined_at, info.created_at, validId]
            );
        }
        return info;
    }
    constructor() {
        this.connection = mysqlConnection;
        this.tempDatabases = new Map();
        this._profileSyncColumnsEnsured = false;
        this._resultCache = new Map();
        this._defaultCacheTtlMs = Math.max(0, parseInt(process.env.MYSQL_MANAGER_CACHE_TTL_MS || '15000'));
    }

    getCacheKey(namespace, identifier) {
        return `${String(namespace || 'global')}::${String(identifier || '')}`;
    }

    getCachedValue(cacheKey) {
        const entry = this._resultCache.get(cacheKey);
        if (!entry) return null;
        if (!entry.expiresAt || Date.now() > entry.expiresAt) {
            this._resultCache.delete(cacheKey);
            return null;
        }
        return entry.value;
    }

    setCachedValue(cacheKey, value, ttlMs = this._defaultCacheTtlMs) {
        const safeTtl = Number.isFinite(Number(ttlMs)) ? Math.max(0, Number(ttlMs)) : this._defaultCacheTtlMs;
        if (safeTtl <= 0) return value;
        this._resultCache.set(cacheKey, {
            value,
            expiresAt: Date.now() + safeTtl
        });
        return value;
    }

    invalidateCacheByPrefix(prefix) {
        const safePrefix = String(prefix || '');
        if (!safePrefix) return;
        for (const key of this._resultCache.keys()) {
            if (key.startsWith(safePrefix)) {
                this._resultCache.delete(key);
            }
        }
    }

    // Validates and sanitizes a Discord ID.
    // Returns a valid ID string or null.
    validateDiscordId(id) {
        if (!id) return null;
        const idStr = String(id).trim();
        // Discord IDs are numeric strings of 17-19 digits
        if (!/^\d{17,19}$/.test(idStr)) {
            console.warn(`[MySQLDatabaseManager] Invalid Discord ID format: ${idStr}`);
            return null;
        }
        return idStr;
    }

    // Validates and sanitizes text input.
    // Returns valid text or null.
    validateTextInput(text, maxLength = 5000) {
        if (typeof text !== 'string') return null;
        const trimmed = text.trim();
        if (trimmed.length === 0 || trimmed.length > maxLength) return null;
        return trimmed;
    }

    normalizeMemberNotesText(notes) {
        if (typeof notes !== 'string' || !notes) return '';
        return notes
            .replace(/^\[(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?\s+UTC\]\s*/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    async initialize() {
        const connected = await this.connection.connect();
        if (connected) {
            await this.ensureAvatarColumn();
            await this.createGhostPingTable();
            await this.createSnipeTable();
        }
        return connected;
    }

    async createGhostPingTable() {
        const query = `
            CREATE TABLE IF NOT EXISTS ghost_pings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(20) NOT NULL,
                user_tag VARCHAR(100),
                content TEXT,
                mentions TEXT,
                channel_id VARCHAR(20),
                channel_name VARCHAR(100) NULL,
                type VARCHAR(20) DEFAULT 'GHOST_PING',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
        `;
        try {
            await this.connection.query(query);

            // Check for existing columns to avoid duplicate column errors logging
            const columnsResult = await this.connection.query("SHOW COLUMNS FROM ghost_pings");
            // Some mysql drivers return [rows, fields], others just rows. Account for both:
            const columns = Array.isArray(columnsResult) && Array.isArray(columnsResult[0]) ? columnsResult[0] : columnsResult;
            const columnNames = Array.isArray(columns) ? columns.map(col => col.Field) : [];

            // Add channel_name column if missing
            if (columnNames.length > 0 && !columnNames.includes('channel_name')) {
                try {
                    await this.connection.query("ALTER TABLE ghost_pings ADD COLUMN channel_name VARCHAR(100) NULL");
                } catch (err) {
                    if (err.code !== 'ER_DUP_FIELDNAME') console.error('Error adding channel_name column:', err);
                }
            }

            // Add type column if missing
            if (columnNames.length > 0 && !columnNames.includes('type')) {
                try {
                    await this.connection.query("ALTER TABLE ghost_pings ADD COLUMN type VARCHAR(20) DEFAULT 'GHOST_PING'");
                } catch (err) {
                    if (err.code !== 'ER_DUP_FIELDNAME') console.error('Error adding type column:', err);
                }
            }

            console.log('Ghost ping table ensured.');
        } catch (error) {
            console.error('Error creating ghost_pings table:', error);
        }
    }

    async createSnipeTable() {
        const query = `
            CREATE TABLE IF NOT EXISTS snipes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(20) NOT NULL,
                user_tag VARCHAR(100),
                content TEXT,
                channel_id VARCHAR(20),
                channel_name VARCHAR(100) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
        `;
        try {
            await this.connection.query(query);
            console.log('Snipe table ensured.');
        } catch (error) {
            console.error('Error creating snipes table:', error);
        }
    }

    async ensureGhostPingChannelName() {
        // Redundant, now handled cleanly in createGhostPingTable
    }

    async logGhostPing(userId, userTag, content, mentions, channelId, channelName = null, type = 'GHOST_PING') {
        try {
            const query = `
                INSERT INTO ghost_pings (user_id, user_tag, content, mentions, channel_id, channel_name, type)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `;
            await this.connection.query(query, [userId, userTag, content, mentions, channelId, channelName, type]);
            return true;
        } catch (error) {
            console.error('Error logging ghost ping:', error);
            return false;
        }
    }

    async getAllGhostPings(limit = 50) {
        try {
            const query = `
                SELECT id, user_id, user_tag, content, mentions, channel_id, channel_name, type, created_at
                FROM ghost_pings
                ORDER BY created_at DESC
                LIMIT ?
            `;
            const rows = await this.query(query, [limit]);
            return rows.map(r => ({
                id: r.id,
                userId: r.user_id,
                userTag: r.user_tag,
                content: r.content,
                mentions: r.mentions, // Assuming simple string or JSON string
                channelId: r.channel_id,
                channelName: r.channel_name,
                type: r.type,
                createdAt: r.created_at
            }));
        } catch (error) {
            console.error('Error fetching ghost pings:', error);
            return [];
        }
    }

    async clearGhostPings() {
        try {
            await this.connection.query('TRUNCATE TABLE ghost_pings');
            return true;
        } catch (error) {
            console.error('Error clearing ghost pings:', error);
            return false;
        }
    }

    async logSnipe(userId, userTag, content, channelId, channelName = null) {
        try {
            const query = `
                INSERT INTO snipes (user_id, user_tag, content, channel_id, channel_name)
                VALUES (?, ?, ?, ?, ?)
            `;
            await this.connection.query(query, [userId, userTag, content, channelId, channelName]);
            return true;
        } catch (error) {
            console.error('Error logging snipe:', error);
            return false;
        }
    }

    async getAllSnipes(limit = 50) {
        try {
            const query = `
                SELECT id, user_id, user_tag, content, channel_id, channel_name, created_at
                FROM snipes
                ORDER BY created_at DESC
                LIMIT ?
            `;
            const rows = await this.query(query, [limit]);
            return rows.map(r => ({
                id: r.id,
                userId: r.user_id,
                userTag: r.user_tag,
                content: r.content,
                channelId: r.channel_id,
                channelName: r.channel_name,
                createdAt: r.created_at
            }));
        } catch (error) {
            console.error('Error fetching snipes:', error);
            return [];
        }
    }

    async clearSnipes() {
        try {
            await this.connection.query('TRUNCATE TABLE snipes');
            return true;
        } catch (error) {
            console.error('Error clearing snipes:', error);
            return false;
        }
    }


    async query(sql, params = [], options = {}) {
        const {
            useCache = false,
            cacheNamespace = 'query',
            cacheKey = null,
            cacheTtlMs = this._defaultCacheTtlMs,
            suppressError = false,
            fallbackValue = null,
            logLabel = 'query'
        } = options;

        const resolvedCacheKey = useCache
            ? this.getCacheKey(cacheNamespace, cacheKey || `${sql}::${JSON.stringify(params || [])}`)
            : null;

        if (resolvedCacheKey) {
            const cached = this.getCachedValue(resolvedCacheKey);
            if (cached !== null) return cached;
        }

        try {
            const rows = await this.connection.query(sql, params);
            if (resolvedCacheKey) {
                this.setCachedValue(resolvedCacheKey, rows, cacheTtlMs);
            }
            return rows;
        } catch (error) {
            if (!suppressError) {
                console.error(`[MySQLDatabaseManager] ${logLabel} failed: ${error.message}`);
            }
            if (suppressError) return fallbackValue;
            throw error;
        }
    }

    async queryOne(sql, params = [], options = {}) {
        const rows = await this.query(sql, params, options);
        return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    }

    async queryValue(sql, params = [], columnName = null, options = {}) {
        const row = await this.queryOne(sql, params, options);
        if (!row || typeof row !== 'object') return null;
        if (columnName && Object.prototype.hasOwnProperty.call(row, columnName)) {
            return row[columnName];
        }
        const [firstValue] = Object.values(row);
        return firstValue ?? null;
    }

    async withTransaction(handler) {
        return await this.connection.transaction(handler);
    }

    async paginatedQuery(baseSql, params = [], { page = 1, pageSize = 25, maxPageSize = 200 } = {}) {
        const safePage = Math.max(1, parseInt(page) || 1);
        const safePageSize = Math.max(1, Math.min(parseInt(pageSize) || 25, parseInt(maxPageSize) || 200));
        const offset = (safePage - 1) * safePageSize;

        const sql = `${baseSql} LIMIT ? OFFSET ?`;
        const rows = await this.query(sql, [...params, safePageSize, offset]);

        return {
            rows,
            pagination: {
                page: safePage,
                pageSize: safePageSize,
                offset,
                hasResults: Array.isArray(rows) && rows.length > 0
            }
        };
    }

    async getDatabaseHealth() {
        if (typeof this.connection.healthCheck === 'function') {
            return await this.connection.healthCheck();
        }

        try {
            const startedAt = Date.now();
            await this.connection.query('SELECT 1');
            return {
                ok: true,
                isConnected: true,
                latencyMs: Date.now() - startedAt,
                lastHealthCheckAt: Date.now(),
                lastHealthCheckLatencyMs: Date.now() - startedAt,
                error: null
            };
        } catch (error) {
            return {
                ok: false,
                isConnected: false,
                latencyMs: null,
                lastHealthCheckAt: Date.now(),
                lastHealthCheckLatencyMs: null,
                error: error?.message || 'Health check failed'
            };
        }
    }

    // USERINFO section: handles user info in the database.

    // Adds or updates a user in the userinfo table.
    // userId: Discord user ID
    // username: Discord username
    // isBot: Whether the user is a bot
    // avatar: Optional avatar URL (default: null)
    // Returns true if successful.
    async addUserInfo(userId, username, isBot = false, avatar = null) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId) {
                console.warn('[MySQLDatabaseManager] addUserInfo called with invalid userId');
                return false;
            }
            const safeUsername = username ? this.validateTextInput(String(username), 255) : null;
            const safeAvatar = avatar ? this.validateTextInput(String(avatar), 512) : null;

            const performQuery = async () => {
                if (safeAvatar) {
                    await this.connection.query(
                        `INSERT INTO userinfo (user_id, username, is_bot, avatar)
                         VALUES (?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE username = ?, avatar = ?, last_seen = NOW()`,
                        [validId, safeUsername, isBot ? 1 : 0, safeAvatar, safeUsername, safeAvatar]
                    );
                } else {
                    await this.connection.query(
                        `INSERT INTO userinfo (user_id, username, is_bot)
                         VALUES (?, ?, ?)
                         ON DUPLICATE KEY UPDATE username = ?, last_seen = NOW()`,
                        [validId, safeUsername, isBot ? 1 : 0, safeUsername]
                    );
                }
            };

            try {
                await performQuery();
            } catch (queryError) {
                if (String(queryError.message).includes("Unknown column 'avatar'")) {
                    await this.ensureAvatarColumn();
                    await performQuery();
                } else {
                    throw queryError;
                }
            }

            this.invalidateCacheByPrefix(this.getCacheKey('userinfo', `${validId}:`));
            return true;
        } catch (error) {
            // If table doesn't exist, just log and return false
            if (error.message.includes("Table 'userinfo'")) {
                console.log('[MySQLDatabaseManager] userinfo table not yet created. Run migration script.');
                return false;
            }
            console.error(`[MySQLDatabaseManager] Error adding user to userinfo: ${error.message}`);
            return false;
        }
    }

    async ensureAvatarColumn() {
        try {
            await this.connection.pool.execute(`
                ALTER TABLE userinfo 
                ADD COLUMN IF NOT EXISTS avatar VARCHAR(512) NULL
            `);
            return true;
        } catch (error) {
            if (error.code === 'ER_DUP_FIELDNAME' || String(error.message || '').includes('Duplicate column')) {
                return true;
            }
            console.error(`[MySQLDatabaseManager] Error ensuring avatar column: ${error.message}`);
            return false;
        }
    }

    // Gets user info from the userinfo table.
    // userId: Discord user ID
    // Returns user info object or null.
    async getUserInfo(userId) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId) {
                console.warn('[MySQLDatabaseManager] getUserInfo called with invalid userId');
                return null;
            }

            const row = await this.queryOne(
                'SELECT * FROM userinfo WHERE user_id = ?',
                [validId],
                {
                    useCache: true,
                    cacheNamespace: 'userinfo',
                    cacheKey: `${validId}:full`,
                    cacheTtlMs: 10000,
                    logLabel: 'getUserInfo'
                }
            );
            return row || null;
        } catch (error) {
            if (error.message.includes("Table 'userinfo'")) {
                return null; // Table doesn't exist yet
            }
            console.error(`[MySQLDatabaseManager] Error getting user info for ${userId}: ${error.message}`);
            return null;
        }
    }

    async ensureUserProfileSyncColumns() {
        try {
            if (this._profileSyncColumnsEnsured) return true;

            const columnMigrations = [
                'ALTER TABLE userinfo ADD COLUMN nickname VARCHAR(255) NULL',
                'ALTER TABLE userinfo ADD COLUMN bio TEXT NULL',
                'ALTER TABLE userinfo ADD COLUMN profile_sync_enabled TINYINT(1) NOT NULL DEFAULT 0',
                'ALTER TABLE userinfo ADD COLUMN profile_last_selected_at BIGINT NULL',
                'ALTER TABLE userinfo ADD COLUMN profile_last_synced_at BIGINT NULL'
            ];

            for (const statement of columnMigrations) {
                try {
                    await this.connection.pool.execute(statement);
                } catch (migrationError) {
                    const duplicateColumn = migrationError?.code === 'ER_DUP_FIELDNAME'
                        || String(migrationError?.message || '').toLowerCase().includes('duplicate column');
                    if (!duplicateColumn) {
                        throw migrationError;
                    }
                }
            }

            this._profileSyncColumnsEnsured = true;
            return true;
        } catch (error) {
            console.error(`[MySQLDatabaseManager] Error ensuring user profile sync columns: ${error.message}`);
            return false;
        }
    }

    async upsertUserProfileSnapshot(userId, { username = null, nickname = null, bio = null, selectedAt = null, syncedAt = null, enableSync = true } = {}) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId) return false;

            const columnsEnsured = await this.ensureUserProfileSyncColumns();

            const safeUsername = username ? this.validateTextInput(String(username), 255) : null;
            const safeNickname = nickname ? this.validateTextInput(String(nickname), 255) : null;
            const safeBio = bio ? this.validateTextInput(String(bio), 4000) : null;
            const selectedAtMs = Number.isFinite(Number(selectedAt)) ? Number(selectedAt) : null;
            const syncedAtMs = Number.isFinite(Number(syncedAt)) ? Number(syncedAt) : null;

            if (!columnsEnsured) {
                await this.connection.query(
                    `INSERT INTO userinfo (user_id, username, bio, last_seen)
                     VALUES (?, ?, ?, NOW())
                     ON DUPLICATE KEY UPDATE
                        username = COALESCE(VALUES(username), username),
                        bio = COALESCE(VALUES(bio), bio),
                        last_seen = NOW()`,
                    [validId, safeUsername, safeBio]
                );
                return true;
            }

            await this.connection.query(
                `INSERT INTO userinfo (
                    user_id,
                    username,
                    nickname,
                    bio,
                    profile_sync_enabled,
                    profile_last_selected_at,
                    profile_last_synced_at,
                    last_seen
                ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
                ON DUPLICATE KEY UPDATE
                    username = COALESCE(VALUES(username), username),
                    nickname = COALESCE(VALUES(nickname), nickname),
                    bio = COALESCE(VALUES(bio), bio),
                    profile_sync_enabled = VALUES(profile_sync_enabled),
                    profile_last_selected_at = COALESCE(GREATEST(COALESCE(profile_last_selected_at, 0), VALUES(profile_last_selected_at)), profile_last_selected_at),
                    profile_last_synced_at = COALESCE(VALUES(profile_last_synced_at), profile_last_synced_at),
                    last_seen = NOW()`,
                [
                    validId,
                    safeUsername,
                    safeNickname,
                    safeBio,
                    enableSync ? 1 : 0,
                    selectedAtMs,
                    syncedAtMs
                ]
            );

            return true;
        } catch (error) {
            console.error(`[MySQLDatabaseManager] Error upserting user profile snapshot: ${error.message}`);
            return false;
        }
    }

    async markUserProfileSynced(userId, syncedAt = Date.now()) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId) return false;

            await this.ensureUserProfileSyncColumns();

            const syncedAtMs = Number.isFinite(Number(syncedAt)) ? Number(syncedAt) : Date.now();
            await this.connection.query(
                `UPDATE userinfo
                 SET profile_last_synced_at = ?, profile_sync_enabled = 1, last_seen = NOW()
                 WHERE user_id = ?`,
                [syncedAtMs, validId]
            );
            return true;
        } catch (error) {
            console.error(`[MySQLDatabaseManager] Error marking user profile sync timestamp: ${error.message}`);
            return false;
        }
    }

    async getUsersDueForProfileSync(limit = 25, staleMs = 6 * 60 * 60 * 1000) {
        try {
            await this.ensureUserProfileSyncColumns();

            const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
            const cutoff = Date.now() - Math.max(60 * 1000, Number(staleMs) || 6 * 60 * 60 * 1000);

            const rows = await this.connection.query(
                `SELECT user_id, username, profile_last_selected_at, profile_last_synced_at
                 FROM userinfo
                 WHERE profile_sync_enabled = 1
                   AND profile_last_selected_at IS NOT NULL
                   AND (
                     profile_last_synced_at IS NULL
                     OR profile_last_synced_at < ?
                   )
                 ORDER BY profile_last_selected_at DESC
                 LIMIT ?`,
                [cutoff, safeLimit]
            );

            return Array.isArray(rows) ? rows : [];
        } catch (error) {
            console.error(`[MySQLDatabaseManager] Error getting users due for profile sync: ${error.message}`);
            return [];
        }
    }

    // Gets member notes from the database.
    // userId: Discord user ID
    // Returns notes text.
    async getMemberNotes(userId) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId) return '';

            // First ensure the notes column exists
            await this.ensureNotesColumn();

            const results = await this.connection.query(
                'SELECT notes FROM userinfo WHERE user_id = ?',
                [validId]
            );
            return this.normalizeMemberNotesText(results[0]?.notes || '');
        } catch (error) {
            console.error(`[MySQLDatabaseManager] Error getting member notes: ${error.message}`);
            return '';
        }
    }

    // Update member notes
    async updateMemberNotes(userId, notes) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId) return false;
            const normalizedNotes = this.normalizeMemberNotesText(typeof notes === 'string' ? notes : '');

            // Ensure notes column exists
            await this.ensureNotesColumn();

            // Ensure user exists in userinfo table first
            await this.connection.query(
                `INSERT INTO userinfo (user_id, notes) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE notes = ?`,
                [validId, normalizedNotes, normalizedNotes]
            );
            return true;
        } catch (error) {
            console.error(`[MySQLDatabaseManager] Error updating member notes: ${error.message}`);
            return false;
        }
    }

    // Ensures notes column exists in userinfo table.
    async ensureNotesColumn() {
        try {
            // Check if column exists, if not add it
            await this.connection.pool.execute(`
                ALTER TABLE userinfo 
                ADD COLUMN IF NOT EXISTS notes TEXT
            `);
            return true;
        } catch (error) {
            // Column might already exist
            if (error.code === 'ER_DUP_FIELDNAME' || error.message.includes('Duplicate column')) {
                return true;
            }
            console.error(`[MySQLDatabaseManager] Error ensuring notes column: ${error.message}`);
            return false;
        }
    }

    async ensureTimezoneColumn() {
        try {
            await this.connection.pool.execute(`
                ALTER TABLE userinfo
                ADD COLUMN IF NOT EXISTS timezone VARCHAR(64)
            `);
            return true;
        } catch (error) {
            if (error.code === 'ER_DUP_FIELDNAME' || String(error.message || '').includes('Duplicate column')) {
                return true;
            }
            console.error(`[MySQLDatabaseManager] Error ensuring timezone column: ${error.message}`);
            return false;
        }
    }

    async getUserTimezone(userId) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId) return null;

            await this.ensureTimezoneColumn();

            const row = await this.queryOne(
                'SELECT timezone FROM userinfo WHERE user_id = ? LIMIT 1',
                [validId],
                {
                    useCache: true,
                    cacheNamespace: 'userinfo',
                    cacheKey: `${validId}:timezone`,
                    cacheTtlMs: 10000,
                    logLabel: 'getUserTimezone'
                }
            );

            return row?.timezone ? String(row.timezone) : null;
        } catch (error) {
            console.error(`[MySQLDatabaseManager] Error getting user timezone: ${error.message}`);
            return null;
        }
    }

    async setUserTimezone(userId, timezone) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId) return false;

            await this.ensureTimezoneColumn();

            const safeTimezone = timezone ? this.validateTextInput(String(timezone), 64) : null;

            await this.connection.query(
                `INSERT INTO userinfo (user_id, timezone)
                 VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE timezone = ?, last_seen = NOW()`,
                [validId, safeTimezone, safeTimezone]
            );

            this.invalidateCacheByPrefix(this.getCacheKey('userinfo', `${validId}:`));
            return true;
        } catch (error) {
            console.error(`[MySQLDatabaseManager] Error setting user timezone: ${error.message}`);
            return false;
        }
    }

    async ensureMessageStreakColumns() {
        try {
            await this.connection.pool.execute(`
                ALTER TABLE userinfo
                ADD COLUMN IF NOT EXISTS message_streak INT NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS message_streak_best INT NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS message_streak_last_day BIGINT DEFAULT NULL
            `);
            return true;
        } catch (error) {
            if (error.code === 'ER_DUP_FIELDNAME' || String(error.message || '').includes('Duplicate column')) {
                return true;
            }
            console.error(`[MySQLDatabaseManager] Error ensuring message streak columns: ${error.message}`);
            return false;
        }
    }

    async updateUserMessageStreak(userId, username = null) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId) return null;

            await this.ensureMessageStreakColumns();

            const now = new Date();
            const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
            const yesterdayStart = todayStart - 86400000;

            const row = await this.queryOne(
                'SELECT message_streak, message_streak_best, message_streak_last_day FROM userinfo WHERE user_id = ? LIMIT 1',
                [validId],
                { logLabel: 'updateUserMessageStreak' }
            );

            const currentStreak = Number(row?.message_streak || 0);
            const currentBest = Number(row?.message_streak_best || 0);
            const lastDay = row?.message_streak_last_day ? Number(row.message_streak_last_day) : null;

            if (lastDay === todayStart) {
                return { streak: currentStreak, best: currentBest, changed: false };
            }

            let nextStreak = 1;
            if (lastDay === yesterdayStart) {
                nextStreak = currentStreak + 1;
            }

            const nextBest = Math.max(currentBest, nextStreak);
            const safeUsername = username ? this.validateTextInput(String(username), 255) : null;

            await this.connection.query(
                `INSERT INTO userinfo (user_id, username, message_streak, message_streak_best, message_streak_last_day)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    username = COALESCE(VALUES(username), username),
                    message_streak = VALUES(message_streak),
                    message_streak_best = VALUES(message_streak_best),
                    message_streak_last_day = VALUES(message_streak_last_day),
                    last_seen = NOW()`,
                [validId, safeUsername, nextStreak, nextBest, todayStart]
            );

            return { streak: nextStreak, best: nextBest, changed: true };
        } catch (error) {
            console.error(`[MySQLDatabaseManager] Error updating message streak: ${error.message}`);
            return null;
        }
    }

    async moderationCaseExists(caseId) {
        try {
            const normalizedCaseId = this.validateTextInput(String(caseId || '').trim().toUpperCase(), 50);
            if (!normalizedCaseId) return false;

            const ledgerRow = await this.queryOne(
                'SELECT case_id FROM moderation_cases WHERE case_id = ? LIMIT 1',
                [normalizedCaseId],
                { suppressError: true, fallbackValue: null, logLabel: 'moderationCaseExists.ledger' }
            );
            if (ledgerRow) return true;

            const checks = await Promise.all([
                this.queryOne(
                    'SELECT 1 AS found FROM warns WHERE case_id = ? LIMIT 1',
                    [normalizedCaseId],
                    { suppressError: true, fallbackValue: null, logLabel: 'moderationCaseExists.warns' }
                ),
                this.queryOne(
                    'SELECT 1 AS found FROM timeouts WHERE case_id = ? LIMIT 1',
                    [normalizedCaseId],
                    { suppressError: true, fallbackValue: null, logLabel: 'moderationCaseExists.timeouts' }
                ),
                this.queryOne(
                    'SELECT 1 AS found FROM user_bans WHERE ban_case_id = ? LIMIT 1',
                    [normalizedCaseId],
                    { suppressError: true, fallbackValue: null, logLabel: 'moderationCaseExists.user_bans' }
                ),
                this.queryOne(
                    'SELECT 1 AS found FROM kicks WHERE case_id = ? LIMIT 1',
                    [normalizedCaseId],
                    { suppressError: true, fallbackValue: null, logLabel: 'moderationCaseExists.kicks' }
                ),
                this.queryOne(
                    'SELECT 1 AS found FROM unbans WHERE unban_case_id = ? LIMIT 1',
                    [normalizedCaseId],
                    { suppressError: true, fallbackValue: null, logLabel: 'moderationCaseExists.unbans' }
                ),
                this.queryOne(
                    'SELECT 1 AS found FROM manual_lockdowns WHERE case_id = ? LIMIT 1',
                    [normalizedCaseId],
                    { suppressError: true, fallbackValue: null, logLabel: 'moderationCaseExists.manual_lockdowns' }
                )
            ]);

            return checks.some((row) => !!row);
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error checking moderation case existence:', error.message);
            return false;
        }
    }

    normalizeModerationActionType(actionType = 'OTHER') {
        const normalized = String(actionType || 'OTHER').trim().toUpperCase();
        const aliases = {
            LOCKDOWN_ENABLE: 'LOCKDOWN',
            LOCKDOWN_DISABLE: 'LOCKDOWN',
            CLEAR_TIMEOUT: 'UNTIMEOUT'
        };
        return aliases[normalized] || normalized || 'OTHER';
    }

    getDefaultModerationCaseStatus(actionType, expiresAt = null) {
        const normalized = this.normalizeModerationActionType(actionType);
        switch (normalized) {
            case 'BAN':
            case 'TIMEOUT':
            case 'LOCKDOWN':
                return expiresAt ? 'active' : 'active';
            case 'WARN':
                return 'open';
            case 'KICK':
            case 'UNBAN':
            case 'UNTIMEOUT':
                return 'closed';
            default:
                return 'open';
        }
    }

    normalizeModerationCaseStatus(status, actionType = 'OTHER', expiresAt = null) {
        const normalized = String(status || '').trim().toLowerCase();
        const allowed = new Set(['open', 'active', 'closed', 'cleared', 'reversed', 'expired', 'appealed']);
        if (allowed.has(normalized)) {
            if (normalized === 'active' && expiresAt && Number(expiresAt) > 0 && Number(expiresAt) <= Date.now()) {
                return 'expired';
            }
            return normalized;
        }
        return this.getDefaultModerationCaseStatus(actionType, expiresAt);
    }

    resolveEffectiveModerationCaseStatus(caseRow = null) {
        if (!caseRow || typeof caseRow !== 'object') return 'open';
        const expiresAt = Number(caseRow.expires_at || caseRow.expiresAt || 0) || null;
        return this.normalizeModerationCaseStatus(caseRow.status, caseRow.action_type || caseRow.actionType, expiresAt);
    }

    safeJsonStringify(value) {
        if (value == null) return null;
        try {
            return JSON.stringify(value);
        } catch {
            return null;
        }
    }

    async appendModerationCaseEvent({
        caseId,
        guildId = null,
        eventType,
        summary = null,
        details = null,
        actorId = null,
        actorName = null,
        relatedCaseId = null,
        metadata = null,
        createdAt = Date.now()
    }) {
        try {
            const safeCaseId = this.validateTextInput(String(caseId || '').trim().toUpperCase(), 50);
            const safeEventType = this.validateTextInput(String(eventType || '').trim().toUpperCase(), 30);
            if (!safeCaseId || !safeEventType) return false;

            await this.connection.query(
                `INSERT INTO moderation_case_events
                    (case_id, guild_id, event_type, summary, details, actor_id, actor_name, related_case_id, metadata, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    safeCaseId,
                    guildId ? this.validateDiscordId(guildId) : null,
                    safeEventType,
                    this.validateTextInput(String(summary || ''), 255) || null,
                    this.validateTextInput(String(details || ''), 8000) || null,
                    actorId ? this.validateDiscordId(actorId) : null,
                    this.validateTextInput(String(actorName || ''), 100) || null,
                    relatedCaseId ? this.validateTextInput(String(relatedCaseId || '').trim().toUpperCase(), 50) : null,
                    this.safeJsonStringify(metadata),
                    Number(createdAt) || Date.now()
                ]
            );
            return true;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error appending moderation case event:', error.message);
            return false;
        }
    }

    async upsertModerationCase({
        caseId,
        guildId = null,
        userId,
        userName = null,
        actionType,
        status = null,
        reason = null,
        moderatorId = null,
        moderatorName = null,
        moderatorSource = null,
        source = 'discord',
        relatedCaseId = null,
        rootCaseId = null,
        expiresAt = null,
        closedAt = null,
        metadata = null,
        createdAt = Date.now(),
        updatedAt = Date.now(),
        createEvent = true,
        eventType = 'CREATED',
        eventSummary = null,
        eventDetails = null
    }) {
        try {
            const safeCaseId = this.validateTextInput(String(caseId || '').trim().toUpperCase(), 50);
            const safeUserId = this.validateDiscordId(userId);
            const safeActionType = this.normalizeModerationActionType(actionType);
            if (!safeCaseId || !safeUserId || !safeActionType) return false;

            const normalizedExpiresAt = Number(expiresAt) || null;
            const normalizedCreatedAt = Number(createdAt) || Date.now();
            const normalizedUpdatedAt = Number(updatedAt) || normalizedCreatedAt;
            const normalizedStatus = this.normalizeModerationCaseStatus(status, safeActionType, normalizedExpiresAt);
            const normalizedClosedAt = Number(closedAt) || (['closed', 'cleared', 'reversed', 'expired'].includes(normalizedStatus) ? normalizedUpdatedAt : null);
            const safeRootCaseId = this.validateTextInput(String(rootCaseId || relatedCaseId || safeCaseId).trim().toUpperCase(), 50) || safeCaseId;

            const existing = await this.queryOne(
                'SELECT case_id FROM moderation_cases WHERE case_id = ? LIMIT 1',
                [safeCaseId],
                { suppressError: true, fallbackValue: null, logLabel: 'upsertModerationCase.existing' }
            );

            await this.connection.query(
                `INSERT INTO moderation_cases
                    (case_id, guild_id, user_id, user_name, action_type, status, reason, moderator_id, moderator_name, moderator_source, source, related_case_id, root_case_id, expires_at, closed_at, metadata, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    guild_id = COALESCE(VALUES(guild_id), guild_id),
                    user_id = VALUES(user_id),
                    user_name = COALESCE(VALUES(user_name), user_name),
                    action_type = VALUES(action_type),
                    status = VALUES(status),
                    reason = COALESCE(VALUES(reason), reason),
                    moderator_id = COALESCE(VALUES(moderator_id), moderator_id),
                    moderator_name = COALESCE(VALUES(moderator_name), moderator_name),
                    moderator_source = COALESCE(VALUES(moderator_source), moderator_source),
                    source = COALESCE(VALUES(source), source),
                    related_case_id = COALESCE(VALUES(related_case_id), related_case_id),
                    root_case_id = COALESCE(VALUES(root_case_id), root_case_id),
                    expires_at = COALESCE(VALUES(expires_at), expires_at),
                    closed_at = COALESCE(VALUES(closed_at), closed_at),
                    metadata = COALESCE(VALUES(metadata), metadata),
                    updated_at = VALUES(updated_at)`,
                [
                    safeCaseId,
                    guildId ? this.validateDiscordId(guildId) : null,
                    safeUserId,
                    this.validateTextInput(String(userName || ''), 100) || null,
                    safeActionType,
                    normalizedStatus,
                    this.validateTextInput(String(reason || ''), 8000) || null,
                    moderatorId ? this.validateDiscordId(moderatorId) : null,
                    this.validateTextInput(String(moderatorName || ''), 100) || null,
                    this.validateTextInput(String(moderatorSource || ''), 20) || null,
                    this.validateTextInput(String(source || ''), 20) || 'discord',
                    relatedCaseId ? this.validateTextInput(String(relatedCaseId || '').trim().toUpperCase(), 50) : null,
                    safeRootCaseId,
                    normalizedExpiresAt,
                    normalizedClosedAt,
                    this.safeJsonStringify(metadata),
                    normalizedCreatedAt,
                    normalizedUpdatedAt
                ]
            );

            if (createEvent) {
                await this.appendModerationCaseEvent({
                    caseId: safeCaseId,
                    guildId,
                    eventType,
                    summary: eventSummary || (existing ? 'Case updated' : 'Case created'),
                    details: eventDetails || reason || null,
                    actorId: moderatorId,
                    actorName: moderatorName,
                    relatedCaseId,
                    metadata,
                    createdAt: normalizedUpdatedAt
                });
            }

            return true;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error upserting moderation case:', error.message);
            return false;
        }
    }

    async updateModerationCaseStatus(caseId, status, options = {}) {
        try {
            const safeCaseId = this.validateTextInput(String(caseId || '').trim().toUpperCase(), 50);
            if (!safeCaseId) return false;

            const current = await this.queryOne('SELECT case_id, action_type, status FROM moderation_cases WHERE case_id = ? LIMIT 1', [safeCaseId], {
                suppressError: true,
                fallbackValue: null,
                logLabel: 'updateModerationCaseStatus.current'
            });
            if (!current) return false;

            const updatedAt = Number(options.updatedAt) || Date.now();
            const normalizedStatus = this.normalizeModerationCaseStatus(status, current.action_type, options.expiresAt);
            const closedAt = ['closed', 'cleared', 'reversed', 'expired'].includes(normalizedStatus)
                ? (Number(options.closedAt) || updatedAt)
                : null;

            await this.connection.query(
                `UPDATE moderation_cases SET status = ?, closed_at = ?, updated_at = ? WHERE case_id = ?`,
                [normalizedStatus, closedAt, updatedAt, safeCaseId]
            );

            await this.appendModerationCaseEvent({
                caseId: safeCaseId,
                guildId: options.guildId || null,
                eventType: 'STATUS_CHANGED',
                summary: `Status changed to ${normalizedStatus}`,
                details: options.details || null,
                actorId: options.actorId || null,
                actorName: options.actorName || null,
                relatedCaseId: options.relatedCaseId || null,
                metadata: { previousStatus: current.status, nextStatus: normalizedStatus },
                createdAt: updatedAt
            });

            return true;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error updating moderation case status:', error.message);
            return false;
        }
    }

    async syncLegacyModerationCase(caseId) {
        try {
            const safeCaseId = this.validateTextInput(String(caseId || '').trim().toUpperCase(), 50);
            if (!safeCaseId) return null;

            const existing = await this.queryOne('SELECT * FROM moderation_cases WHERE case_id = ? LIMIT 1', [safeCaseId], {
                suppressError: true,
                fallbackValue: null,
                logLabel: 'syncLegacyModerationCase.existing'
            });
            if (existing) return existing;

            const warn = await this.queryOne(
                `SELECT user_id, user_name, moderator_id, moderator_name, moderator_source, reason, timestamp
                 FROM warns WHERE case_id = ? LIMIT 1`,
                [safeCaseId],
                { suppressError: true, fallbackValue: null, logLabel: 'syncLegacyModerationCase.warn' }
            );
            if (warn) {
                await this.upsertModerationCase({
                    caseId: safeCaseId,
                    userId: warn.user_id,
                    userName: warn.user_name,
                    actionType: 'WARN',
                    status: 'open',
                    reason: warn.reason,
                    moderatorId: warn.moderator_id,
                    moderatorName: warn.moderator_name,
                    moderatorSource: warn.moderator_source,
                    source: warn.moderator_source || 'legacy',
                    createdAt: Number(warn.timestamp) || Date.now(),
                    updatedAt: Number(warn.timestamp) || Date.now(),
                    createEvent: true,
                    eventSummary: 'Legacy warning synced'
                });
                return await this.queryOne('SELECT * FROM moderation_cases WHERE case_id = ? LIMIT 1', [safeCaseId]);
            }

            const timeout = await this.queryOne(
                `SELECT user_id, username, reason, issued_by, issued_by_name, issued_by_source, issued_at, expires_at, active
                 FROM timeouts WHERE case_id = ? LIMIT 1`,
                [safeCaseId],
                { suppressError: true, fallbackValue: null, logLabel: 'syncLegacyModerationCase.timeout' }
            );
            if (timeout) {
                await this.upsertModerationCase({
                    caseId: safeCaseId,
                    userId: timeout.user_id,
                    userName: timeout.username,
                    actionType: 'TIMEOUT',
                    status: timeout.active ? 'active' : 'cleared',
                    reason: timeout.reason,
                    moderatorId: timeout.issued_by,
                    moderatorName: timeout.issued_by_name,
                    moderatorSource: timeout.issued_by_source,
                    source: timeout.issued_by_source || 'legacy',
                    expiresAt: Number(timeout.expires_at) || null,
                    createdAt: Number(timeout.issued_at) || Date.now(),
                    updatedAt: Number(timeout.issued_at) || Date.now(),
                    createEvent: true,
                    eventSummary: 'Legacy timeout synced'
                });
                return await this.queryOne('SELECT * FROM moderation_cases WHERE case_id = ? LIMIT 1', [safeCaseId]);
            }

            const ban = await this.queryOne(
                `SELECT user_id, user_name, banned_by, banned_by_name, banned_by_source, ban_reason, UNIX_TIMESTAMP(banned_at) * 1000 AS banned_at_ms, banned
                 FROM user_bans WHERE ban_case_id = ? LIMIT 1`,
                [safeCaseId],
                { suppressError: true, fallbackValue: null, logLabel: 'syncLegacyModerationCase.ban' }
            );
            if (ban) {
                await this.upsertModerationCase({
                    caseId: safeCaseId,
                    userId: ban.user_id,
                    userName: ban.user_name,
                    actionType: 'BAN',
                    status: ban.banned ? 'active' : 'reversed',
                    reason: ban.ban_reason,
                    moderatorId: ban.banned_by,
                    moderatorName: ban.banned_by_name,
                    moderatorSource: ban.banned_by_source,
                    source: ban.banned_by_source || 'legacy',
                    createdAt: Number(ban.banned_at_ms) || Date.now(),
                    updatedAt: Number(ban.banned_at_ms) || Date.now(),
                    createEvent: true,
                    eventSummary: 'Legacy ban synced'
                });
                return await this.queryOne('SELECT * FROM moderation_cases WHERE case_id = ? LIMIT 1', [safeCaseId]);
            }

            const kick = await this.queryOne(
                `SELECT user_id, username, reason, kicked_by, kicked_by_name, kicked_by_source, kicked_at
                 FROM kicks WHERE case_id = ? LIMIT 1`,
                [safeCaseId],
                { suppressError: true, fallbackValue: null, logLabel: 'syncLegacyModerationCase.kick' }
            );
            if (kick) {
                await this.upsertModerationCase({
                    caseId: safeCaseId,
                    userId: kick.user_id,
                    userName: kick.username,
                    actionType: 'KICK',
                    status: 'closed',
                    reason: kick.reason,
                    moderatorId: kick.kicked_by,
                    moderatorName: kick.kicked_by_name,
                    moderatorSource: kick.kicked_by_source,
                    source: kick.kicked_by_source || 'legacy',
                    createdAt: Number(kick.kicked_at) || Date.now(),
                    updatedAt: Number(kick.kicked_at) || Date.now(),
                    createEvent: true,
                    eventSummary: 'Legacy kick synced'
                });
                return await this.queryOne('SELECT * FROM moderation_cases WHERE case_id = ? LIMIT 1', [safeCaseId]);
            }

            const unban = await this.queryOne(
                `SELECT user_id, user_name, unbanned_by, unbanned_by_name, unbanned_by_source, reason, original_ban_case_id, UNIX_TIMESTAMP(unbanned_at) * 1000 AS unbanned_at_ms
                 FROM unbans WHERE unban_case_id = ? LIMIT 1`,
                [safeCaseId],
                { suppressError: true, fallbackValue: null, logLabel: 'syncLegacyModerationCase.unban' }
            );
            if (unban) {
                await this.upsertModerationCase({
                    caseId: safeCaseId,
                    userId: unban.user_id,
                    userName: unban.user_name,
                    actionType: 'UNBAN',
                    status: 'closed',
                    reason: unban.reason,
                    moderatorId: unban.unbanned_by,
                    moderatorName: unban.unbanned_by_name,
                    moderatorSource: unban.unbanned_by_source,
                    source: unban.unbanned_by_source || 'legacy',
                    relatedCaseId: unban.original_ban_case_id,
                    rootCaseId: unban.original_ban_case_id || safeCaseId,
                    createdAt: Number(unban.unbanned_at_ms) || Date.now(),
                    updatedAt: Number(unban.unbanned_at_ms) || Date.now(),
                    createEvent: true,
                    eventSummary: 'Legacy unban synced'
                });
                if (unban.original_ban_case_id) {
                    await this.updateModerationCaseStatus(unban.original_ban_case_id, 'reversed', {
                        actorId: unban.unbanned_by,
                        actorName: unban.unbanned_by_name,
                        relatedCaseId: safeCaseId,
                        details: `Linked unban case ${safeCaseId}`,
                        updatedAt: Number(unban.unbanned_at_ms) || Date.now()
                    });
                }
                return await this.queryOne('SELECT * FROM moderation_cases WHERE case_id = ? LIMIT 1', [safeCaseId]);
            }

            const lockdown = await this.queryOne(
                `SELECT guild_id, action_type, moderator_id, moderator_name, reason, UNIX_TIMESTAMP(created_at) * 1000 AS created_at_ms
                 FROM manual_lockdowns WHERE case_id = ? LIMIT 1`,
                [safeCaseId],
                { suppressError: true, fallbackValue: null, logLabel: 'syncLegacyModerationCase.lockdown' }
            );
            if (lockdown) {
                await this.upsertModerationCase({
                    caseId: safeCaseId,
                    guildId: lockdown.guild_id,
                    userId: lockdown.moderator_id || '00000000000000000',
                    userName: 'Server',
                    actionType: 'LOCKDOWN',
                    status: String(lockdown.action_type || '').toLowerCase() === 'enable' ? 'active' : 'closed',
                    reason: lockdown.reason,
                    moderatorId: lockdown.moderator_id,
                    moderatorName: lockdown.moderator_name,
                    moderatorSource: 'discord',
                    source: 'legacy',
                    createdAt: Number(lockdown.created_at_ms) || Date.now(),
                    updatedAt: Number(lockdown.created_at_ms) || Date.now(),
                    createEvent: true,
                    eventSummary: 'Legacy lockdown synced'
                });
                return await this.queryOne('SELECT * FROM moderation_cases WHERE case_id = ? LIMIT 1', [safeCaseId]);
            }

            return null;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error syncing legacy moderation case:', error.message);
            return null;
        }
    }

    async getModerationCaseById(caseId) {
        try {
            const safeCaseId = this.validateTextInput(String(caseId || '').trim().toUpperCase(), 50);
            if (!safeCaseId) return null;

            let row = await this.queryOne('SELECT * FROM moderation_cases WHERE case_id = ? LIMIT 1', [safeCaseId], {
                suppressError: true,
                fallbackValue: null,
                logLabel: 'getModerationCaseById.primary'
            });
            if (!row) {
                row = await this.syncLegacyModerationCase(safeCaseId);
            }
            if (!row) return null;

            const incident = await this.getModerationIncidentByCaseId(safeCaseId);
            const timeline = await this.getModerationCaseTimeline(safeCaseId);
            const relatedCases = await this.query(
                `SELECT case_id, action_type, status, reason, related_case_id, created_at
                 FROM moderation_cases
                 WHERE related_case_id = ? OR case_id = ? OR root_case_id = ?
                 ORDER BY created_at ASC`,
                [safeCaseId, row.related_case_id || '', row.root_case_id || safeCaseId],
                { suppressError: true, fallbackValue: [], logLabel: 'getModerationCaseById.related' }
            );

            return {
                ...row,
                effective_status: this.resolveEffectiveModerationCaseStatus(row),
                incident,
                timeline,
                relatedCases: Array.isArray(relatedCases)
                    ? relatedCases.filter((entry) => String(entry.case_id) !== String(safeCaseId))
                    : []
            };
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error getting moderation case by ID:', error.message);
            return null;
        }
    }

    async getModerationCaseTimeline(caseId) {
        try {
            const safeCaseId = this.validateTextInput(String(caseId || '').trim().toUpperCase(), 50);
            if (!safeCaseId) return [];

            const events = await this.query(
                `SELECT id, case_id, guild_id, event_type, summary, details, actor_id, actor_name, related_case_id, metadata, created_at
                 FROM moderation_case_events
                 WHERE case_id = ?
                 ORDER BY created_at ASC, id ASC`,
                [safeCaseId],
                { suppressError: true, fallbackValue: [], logLabel: 'getModerationCaseTimeline.events' }
            );

            const incident = await this.getModerationIncidentByCaseId(safeCaseId);
            const timeline = Array.isArray(events) ? [...events] : [];
            if (incident) {
                timeline.push({
                    id: `incident-${safeCaseId}`,
                    case_id: safeCaseId,
                    event_type: 'INCIDENT',
                    summary: 'Incident proof attached',
                    details: incident.proof_text || incident.reason || null,
                    actor_id: incident.moderator_id || null,
                    actor_name: incident.moderator_name || null,
                    related_case_id: null,
                    metadata: this.safeJsonStringify({
                        proofUrl: incident.proof_url || null,
                        attachmentUrl: incident.attachment_url || null,
                        messageLink: incident.message_link || null
                    }),
                    created_at: incident.updated_at ? new Date(incident.updated_at).getTime() : (incident.created_at ? new Date(incident.created_at).getTime() : Date.now())
                });
            }

            return timeline.sort((left, right) => Number(left.created_at || 0) - Number(right.created_at || 0));
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error getting moderation case timeline:', error.message);
            return [];
        }
    }

    async searchModerationCases({ query = '', userId = null, moderatorId = null, status = null, limit = 10 } = {}) {
        try {
            const clauses = [];
            const params = [];
            const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
            const safeQuery = this.validateTextInput(String(query || '').trim(), 120);
            const safeUserId = userId ? this.validateDiscordId(userId) : null;
            const safeModeratorId = moderatorId ? this.validateDiscordId(moderatorId) : null;
            const safeStatus = status ? this.normalizeModerationCaseStatus(status) : null;

            if (safeQuery) {
                clauses.push('(case_id LIKE ? OR reason LIKE ? OR user_name LIKE ? OR moderator_name LIKE ?)');
                params.push(`%${safeQuery}%`, `%${safeQuery}%`, `%${safeQuery}%`, `%${safeQuery}%`);
            }
            if (safeUserId) {
                clauses.push('user_id = ?');
                params.push(safeUserId);
            }
            if (safeModeratorId) {
                clauses.push('moderator_id = ?');
                params.push(safeModeratorId);
            }
            const sql = `
                SELECT case_id, guild_id, user_id, user_name, action_type, status, reason, moderator_id, moderator_name, related_case_id, root_case_id, expires_at, closed_at, created_at, updated_at
                FROM moderation_cases
                ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
                ORDER BY created_at DESC
                LIMIT ?`;
            params.push(safeLimit);

            let rows = await this.query(sql, params, {
                suppressError: true,
                fallbackValue: [],
                logLabel: 'searchModerationCases.search'
            });

            rows = Array.isArray(rows) ? rows.map((row) => ({ ...row, effective_status: this.resolveEffectiveModerationCaseStatus(row) })) : [];
            if (safeStatus) {
                rows = rows.filter((row) => row.effective_status === safeStatus);
            }
            return rows;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error searching moderation cases:', error.message);
            return [];
        }
    }

    invalidateModerationUserCaches(userId = null) {
        const validId = userId ? this.validateDiscordId(userId) : null;
        if (validId) {
            this.invalidateCacheByPrefix(this.getCacheKey('warns', `${validId}:`));
            this.invalidateCacheByPrefix(this.getCacheKey('userprofile', `${validId}:`));
        }
        this.invalidateCacheByPrefix(this.getCacheKey('warns', 'list:'));
        this.invalidateCacheByPrefix(this.getCacheKey('warns', 'count'));
    }

    async getUserModerationCases(userId, { actionTypes = ['WARN'], includeStatuses = null, excludeStatuses = [], limit = 50 } = {}) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId) return [];

            const safeActionTypes = Array.isArray(actionTypes)
                ? actionTypes
                    .map((type) => this.normalizeModerationActionType(type))
                    .filter(Boolean)
                : [];

            if (!safeActionTypes.length) return [];

            const placeholders = safeActionTypes.map(() => '?').join(', ');
            const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));

            let rows = await this.query(
                `SELECT case_id, guild_id, user_id, user_name, action_type, status, reason, moderator_id, moderator_name, related_case_id, root_case_id, expires_at, closed_at, created_at, updated_at
                 FROM moderation_cases
                 WHERE user_id = ? AND action_type IN (${placeholders})
                 ORDER BY created_at DESC
                 LIMIT ?`,
                [validId, ...safeActionTypes, safeLimit],
                {
                    suppressError: true,
                    fallbackValue: [],
                    logLabel: 'getUserModerationCases'
                }
            );

            const includeSet = Array.isArray(includeStatuses) && includeStatuses.length
                ? new Set(includeStatuses.map((entry) => this.normalizeModerationCaseStatus(entry)))
                : null;
            const excludeSet = new Set(
                Array.isArray(excludeStatuses)
                    ? excludeStatuses.map((entry) => this.normalizeModerationCaseStatus(entry))
                    : []
            );

            rows = Array.isArray(rows)
                ? rows.map((row) => ({ ...row, effective_status: this.resolveEffectiveModerationCaseStatus(row) }))
                : [];

            return rows.filter((row) => {
                if (includeSet && !includeSet.has(row.effective_status)) return false;
                if (excludeSet.has(row.effective_status)) return false;
                return true;
            });
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error getting user moderation cases:', error.message);
            return [];
        }
    }

    async getActiveTimeoutCases({ guildId = null, limit = 200 } = {}) {
        try {
            const safeGuildId = guildId ? this.validateDiscordId(guildId) : null;
            const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
            const params = ['TIMEOUT', Date.now()];
            let sql = `SELECT case_id, guild_id, user_id, user_name, reason, moderator_id, moderator_name, expires_at, created_at, updated_at, status
                       FROM moderation_cases
                       WHERE action_type = ?
                         AND (expires_at IS NULL OR expires_at > ?)`;

            if (safeGuildId) {
                sql += ' AND guild_id = ?';
                params.push(safeGuildId);
            }

            sql += ' ORDER BY COALESCE(expires_at, 9223372036854775807) ASC, created_at ASC LIMIT ?';
            params.push(safeLimit);

            let rows = await this.query(sql, params, {
                suppressError: true,
                fallbackValue: [],
                logLabel: 'getActiveTimeoutCases'
            });

            rows = Array.isArray(rows)
                ? rows.map((row) => ({ ...row, effective_status: this.resolveEffectiveModerationCaseStatus(row) }))
                : [];

            return rows.filter((row) => row.effective_status === 'active');
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error getting active timeout cases:', error.message);
            return [];
        }
    }

    async getLatestActiveTimeoutCaseForUser(userId, guildId = null) {
        const rows = await this.getUserModerationCases(userId, {
            actionTypes: ['TIMEOUT'],
            includeStatuses: ['active'],
            limit: 25
        });

        if (!guildId) {
            return rows[0] || null;
        }

        const safeGuildId = this.validateDiscordId(guildId);
        return rows.find((row) => !safeGuildId || String(row.guild_id || '') === safeGuildId) || null;
    }

    async getLatestActiveBanCaseForUser(userId, guildId = null) {
        const rows = await this.getUserModerationCases(userId, {
            actionTypes: ['BAN'],
            includeStatuses: ['active'],
            limit: 25
        });

        if (!guildId) {
            return rows[0] || null;
        }

        const safeGuildId = this.validateDiscordId(guildId);
        return rows.find((row) => !safeGuildId || String(row.guild_id || '') === safeGuildId) || null;
    }

    async clearWarningCase(userId, caseId, options = {}) {
        try {
            const validId = this.validateDiscordId(userId);
            const safeCaseId = this.validateTextInput(String(caseId || '').trim().toUpperCase(), 50);
            if (!validId || !safeCaseId) return null;

            let row = await this.queryOne(
                `SELECT case_id, user_id, action_type, reason, status, created_at, updated_at
                 FROM moderation_cases
                 WHERE case_id = ? AND user_id = ? AND action_type = 'WARN'
                 LIMIT 1`,
                [safeCaseId, validId],
                { suppressError: true, fallbackValue: null, logLabel: 'clearWarningCase.current' }
            );

            if (!row) {
                row = await this.syncLegacyModerationCase(safeCaseId);
            }

            if (!row || String(row.user_id) !== validId || String(row.action_type || '').toUpperCase() !== 'WARN') {
                return null;
            }

            await this.updateModerationCaseStatus(safeCaseId, 'cleared', {
                guildId: options.guildId || row.guild_id || null,
                actorId: options.actorId || null,
                actorName: options.actorName || null,
                details: options.details || 'Warning cleared',
                updatedAt: options.updatedAt || Date.now()
            });

            this.invalidateModerationUserCaches(validId);
            return row;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error clearing warning case:', error.message);
            return null;
        }
    }

    async clearAllWarningCases(userId, options = {}) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId) return 0;

            const rows = await this.getUserModerationCases(validId, {
                actionTypes: ['WARN'],
                excludeStatuses: ['cleared', 'reversed'],
                limit: 500
            });

            for (const row of rows) {
                await this.updateModerationCaseStatus(row.case_id, 'cleared', {
                    guildId: options.guildId || row.guild_id || null,
                    actorId: options.actorId || null,
                    actorName: options.actorName || null,
                    details: options.details || 'Warnings cleared in bulk',
                    updatedAt: options.updatedAt || Date.now()
                });
            }

            this.invalidateModerationUserCaches(validId);
            return rows.length;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error clearing all warning cases:', error.message);
            return 0;
        }
    }

    async getLockdownHistory(guildId, limit = 5) {
        try {
            const safeGuildId = this.validateDiscordId(guildId);
            if (!safeGuildId) return [];

            const safeLimit = Math.max(1, Math.min(25, Number(limit) || 5));
            const rows = await this.query(
                `SELECT case_id, status, moderator_name, reason, metadata, created_at
                 FROM moderation_cases
                 WHERE guild_id = ? AND action_type = 'LOCKDOWN'
                 ORDER BY created_at DESC
                 LIMIT ?`,
                [safeGuildId, safeLimit],
                {
                    suppressError: true,
                    fallbackValue: [],
                    logLabel: 'getLockdownHistory'
                }
            );

            return Array.isArray(rows) ? rows.map((row) => {
                let metadata = row.metadata;
                if (typeof metadata === 'string') {
                    try {
                        metadata = JSON.parse(metadata);
                    } catch {
                        metadata = null;
                    }
                }

                const action = String(metadata?.lockdownAction || '').toLowerCase() === 'disable'
                    ? 'disable'
                    : (String(metadata?.lockdownAction || '').toLowerCase() === 'enable'
                        ? 'enable'
                        : (this.resolveEffectiveModerationCaseStatus(row) === 'active' ? 'enable' : 'disable'));

                return {
                    ...row,
                    action_type: action,
                    effective_status: this.resolveEffectiveModerationCaseStatus(row)
                };
            }) : [];
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error getting lockdown history:', error.message);
            return [];
        }
    }

    async createModerationIncident({
        caseId,
        userId,
        actionType,
        reason,
        proofText,
        proofUrl,
        attachmentUrl,
        messageLink,
        moderatorId,
        moderatorName
    }) {
        try {
            const safeCaseId = this.validateTextInput(String(caseId || '').trim(), 50);
            const safeUserId = this.validateDiscordId(userId);
            const safeModeratorId = this.validateDiscordId(moderatorId);
            const safeActionType = this.validateTextInput(String(actionType || 'OTHER').toUpperCase(), 20) || 'OTHER';
            const safeReason = this.validateTextInput(String(reason || ''), 4000) || null;
            const safeProofText = this.validateTextInput(String(proofText || ''), 8000) || null;
            const safeProofUrl = this.validateTextInput(String(proofUrl || ''), 1000) || null;
            const safeAttachmentUrl = this.validateTextInput(String(attachmentUrl || ''), 1000) || null;
            const safeMessageLink = this.validateTextInput(String(messageLink || ''), 500) || null;
            const safeModeratorName = this.validateTextInput(String(moderatorName || ''), 100) || null;

            if (!safeCaseId || !safeUserId || !safeModeratorId) {
                return { success: false, error: 'Invalid incident payload' };
            }

            const normalizedCaseId = safeCaseId.toUpperCase();
            await this.connection.query(
                `INSERT INTO moderation_incidents
                    (case_id, user_id, action_type, reason, proof_text, proof_url, attachment_url, message_link, moderator_id, moderator_name)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    user_id = VALUES(user_id),
                    action_type = VALUES(action_type),
                    reason = VALUES(reason),
                    proof_text = VALUES(proof_text),
                    proof_url = VALUES(proof_url),
                    attachment_url = VALUES(attachment_url),
                    message_link = VALUES(message_link),
                    moderator_id = VALUES(moderator_id),
                    moderator_name = VALUES(moderator_name)`,
                [
                    normalizedCaseId,
                    safeUserId,
                    safeActionType,
                    safeReason,
                    safeProofText,
                    safeProofUrl,
                    safeAttachmentUrl,
                    safeMessageLink,
                    safeModeratorId,
                    safeModeratorName
                ]
            );

            await this.appendModerationCaseEvent({
                caseId: normalizedCaseId,
                eventType: 'INCIDENT',
                summary: 'Incident proof attached',
                details: safeProofText || safeReason || null,
                actorId: safeModeratorId,
                actorName: safeModeratorName,
                metadata: {
                    proofUrl: safeProofUrl,
                    attachmentUrl: safeAttachmentUrl,
                    messageLink: safeMessageLink,
                    actionType: safeActionType
                },
                createdAt: Date.now()
            });

            return { success: true };
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error creating moderation incident:', error.message);
            return { success: false, error: error.message };
        }
    }

    async getModerationIncidentByCaseId(caseId) {
        try {
            const safeCaseId = this.validateTextInput(String(caseId || '').trim(), 50);
            if (!safeCaseId) return null;

            const rows = await this.connection.query(
                `SELECT id, case_id, user_id, action_type, reason, proof_text, proof_url, attachment_url, message_link, moderator_id, moderator_name, created_at, updated_at
                 FROM moderation_incidents
                 WHERE case_id = ?
                 LIMIT 1`,
                [safeCaseId]
            );

            return rows?.[0] || null;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error getting moderation incident by case ID:', error.message);
            return null;
        }
    }

    async getModerationIncidentsByUser(userId, limit = 10) {
        try {
            const safeUserId = this.validateDiscordId(userId);
            if (!safeUserId) return [];
            const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));

            const rows = await this.connection.query(
                `SELECT id, case_id, user_id, action_type, reason, proof_text, proof_url, attachment_url, message_link, moderator_id, moderator_name, created_at, updated_at
                 FROM moderation_incidents
                 WHERE user_id = ?
                 ORDER BY created_at DESC
                 LIMIT ?`,
                [safeUserId, safeLimit]
            );

            return Array.isArray(rows) ? rows : [];
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error getting moderation incidents by user:', error.message);
            return [];
        }
    }

    async logUserInteraction({ userId, username, commandName, commandCategory, guildId, channelId, status = 'SUCCESS', errorMessage = null, createdAt = Date.now() }) {
        try {
            const validUserId = this.validateDiscordId(userId);
            if (!validUserId) return false;

            const safeUsername = username ? this.validateTextInput(String(username), 32) : null;
            const safeCommand = this.validateTextInput(String(commandName || ''), 100);
            if (!safeCommand) return false;

            const safeCategory = commandCategory ? this.validateTextInput(String(commandCategory), 50) : null;
            const safeGuildId = guildId ? this.validateDiscordId(guildId) : null;
            const safeChannelId = channelId ? this.validateDiscordId(channelId) : null;
            const safeStatus = ['SUCCESS', 'ERROR', 'RATE_LIMIT', 'PERMISSION'].includes(status) ? status : 'SUCCESS';
            const safeError = errorMessage ? this.validateTextInput(String(errorMessage), 2000) : null;
            const safeCreatedAt = Number(createdAt) || Date.now();

            await this.connection.query(
                `INSERT INTO user_interactions (user_id, username, command_name, command_category, guild_id, channel_id, status, error_message, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [validUserId, safeUsername, safeCommand, safeCategory, safeGuildId, safeChannelId, safeStatus, safeError, safeCreatedAt]
            );
            return true;
        } catch (error) {
            console.error(`[MySQLDatabaseManager] Error logging user interaction: ${error.message}`);
            return false;
        }
    }

    async getUserCommandUsageSummary(guildId, userId, days = 30, topLimit = 3) {
        try {
            const validUserId = this.validateDiscordId(userId);
            const safeGuildId = guildId ? this.validateDiscordId(guildId) : null;
            if (!validUserId) {
                return {
                    total: 0,
                    success: 0,
                    failed: 0,
                    successRate: 0,
                    topCommands: []
                };
            }

            const safeDays = Number.isFinite(Number(days))
                ? Math.max(1, Math.min(3650, Number(days)))
                : null;
            const sinceMs = safeDays ? Date.now() - (safeDays * 24 * 60 * 60 * 1000) : null;
            const safeTopLimit = Math.max(1, Math.min(10, Number(topLimit) || 3));

            const whereParts = ['user_id = ?'];
            const baseParams = [validUserId];

            if (safeGuildId) {
                whereParts.push('guild_id = ?');
                baseParams.push(safeGuildId);
            }

            if (sinceMs) {
                whereParts.push('created_at >= ?');
                baseParams.push(sinceMs);
            }

            const whereClause = whereParts.join(' AND ');

            const totalsRows = await this.connection.query(
                `SELECT 
                    COUNT(*) AS total,
                    SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) AS success,
                    SUM(CASE WHEN status != 'SUCCESS' THEN 1 ELSE 0 END) AS failed
                 FROM user_interactions
                 WHERE ${whereClause}`,
                baseParams
            );

            const topRows = await this.connection.query(
                `SELECT command_name, COUNT(*) AS uses
                 FROM user_interactions
                 WHERE ${whereClause}
                 GROUP BY command_name
                 ORDER BY uses DESC, command_name ASC
                 LIMIT ?`,
                [...baseParams, safeTopLimit]
            );

            const total = Number(totalsRows?.[0]?.total || 0);
            const success = Number(totalsRows?.[0]?.success || 0);
            const failed = Number(totalsRows?.[0]?.failed || 0);
            const successRate = total > 0 ? Math.round((success / total) * 100) : 0;

            return {
                total,
                success,
                failed,
                successRate,
                topCommands: (topRows || []).map((row) => ({
                    command: String(row.command_name || 'unknown'),
                    uses: Number(row.uses || 0)
                }))
            };
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error getting user command usage summary:', error.message);
            return {
                total: 0,
                success: 0,
                failed: 0,
                successRate: 0,
                topCommands: []
            };
        }
    }


    async getUserLevel(userId) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId) {
                console.warn('[MySQLDatabaseManager] getUserLevel called with invalid userId');
                return null;
            }
            const row = await this.queryOne(
                'SELECT * FROM levels WHERE user_id = ?',
                [validId],
                {
                    useCache: true,
                    cacheNamespace: 'levels',
                    cacheKey: `${validId}:profile`,
                    cacheTtlMs: 10000,
                    logLabel: 'getUserLevel'
                }
            );
            return row || null;
        } catch (error) {
            console.error(`[MySQLDatabaseManager] Error getting level for user ${userId}: ${error.message}`);
            return null;
        }
    }

    async setUserLevel(userId, data) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId || !data || typeof data !== 'object') {
                console.warn('[MySQLDatabaseManager] setUserLevel called with invalid parameters');
                return false;
            }
            const { xp = 0, level = 1, messages = 0, total_xp = 0, last_message = 0, username = null } = data;

            // Validate numeric inputs
            const validXp = Math.max(0, Math.floor(Number(xp)) || 0);
            const validLevel = Math.max(1, Math.floor(Number(level)) || 1);
            const validMessages = Math.max(0, Math.floor(Number(messages)) || 0);
            const validTotalXp = Math.max(0, Math.floor(Number(total_xp)) || 0);
            const validLastMessage = Math.max(0, Math.floor(Number(last_message)) || 0);
            const validUsername = username ? this.validateTextInput(String(username), 32) : null;

            await this.connection.query(
                `INSERT INTO levels (user_id, username, xp, level, messages, total_xp, last_message) 
                 VALUES (?, ?, ?, ?, ?, ?, ?) 
                 ON DUPLICATE KEY UPDATE username = ?, xp = ?, level = ?, messages = messages + ?, total_xp = ?, last_message = ?`,
                [validId, validUsername, validXp, validLevel, validMessages, validTotalXp, validLastMessage, validUsername, validXp, validLevel, 1, validTotalXp, validLastMessage]
            );
            this.invalidateCacheByPrefix(this.getCacheKey('levels', `${validId}:`));
            this.invalidateCacheByPrefix(this.getCacheKey('levels', 'list:'));
            this.invalidateCacheByPrefix(this.getCacheKey('levels', 'count'));
            this.invalidateCacheByPrefix(this.getCacheKey('userprofile', `${validId}:`));
            return true;
        } catch (error) {
            console.error(`[MySQLDatabaseManager] Error setting level for user ${userId}: ${error.message}`);
            return false;
        }
    }

    async getAllLevels(limit = 100, offset = 0) {
        try {
            const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
            const safeOffset = Math.max(0, Number(offset) || 0);

            const results = await this.query(
                'SELECT * FROM levels ORDER BY xp DESC LIMIT ? OFFSET ?',
                [safeLimit, safeOffset],
                {
                    useCache: true,
                    cacheNamespace: 'levels',
                    cacheKey: `list:${safeLimit}:${safeOffset}`,
                    cacheTtlMs: 12000,
                    logLabel: 'getAllLevels'
                }
            );
            return results;
        } catch (error) {
            console.error(`[MySQLDatabaseManager] Error fetching all levels: ${error.message}`);
            return [];
        }
    }

    async getLevelsCount() {
        try {
            const count = await this.queryValue(
                'SELECT COUNT(*) as count FROM levels',
                [],
                'count',
                {
                    useCache: true,
                    cacheNamespace: 'levels',
                    cacheKey: 'count',
                    cacheTtlMs: 20000,
                    logLabel: 'getLevelsCount'
                }
            );
            return Number(count || 0);
        } catch (error) {
            console.error('Error getting levels count:', error);
            return 0;
        }
    }

    async deleteUserLevel(userId) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId) return false;

            await this.connection.query('DELETE FROM levels WHERE user_id = ?', [validId]);
            this.invalidateCacheByPrefix(this.getCacheKey('levels', `${validId}:`));
            this.invalidateCacheByPrefix(this.getCacheKey('levels', 'list:'));
            this.invalidateCacheByPrefix(this.getCacheKey('levels', 'count'));
            this.invalidateCacheByPrefix(this.getCacheKey('userprofile', `${validId}:`));
            return true;
        } catch (error) {
            console.error('Error deleting user level:', error);
            return false;
        }
    }

    async updateLevel(userId, level = 1, xp = 0) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId) return false;

            await this.connection.query(
                'UPDATE levels SET level = ?, xp = ? WHERE user_id = ?',
                [level, xp, validId]
            );
            this.invalidateCacheByPrefix(this.getCacheKey('levels', `${validId}:`));
            this.invalidateCacheByPrefix(this.getCacheKey('levels', 'list:'));
            this.invalidateCacheByPrefix(this.getCacheKey('userprofile', `${validId}:`));
            return true;
        } catch (error) {
            console.error('Error updating level:', error);
            return false;
        }
    }

    async trackUserChannelActivity(guildId, userId, channelId, username = null) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            const validChannelId = this.validateDiscordId(channelId);
            if (!validGuildId || !validUserId || !validChannelId) return false;

            const safeUsername = username ? this.validateTextInput(String(username), 100) : null;

            await this.connection.query(
                `INSERT INTO user_channel_activity (guild_id, user_id, channel_id, username, message_count)
                 VALUES (?, ?, ?, ?, 1)
                 ON DUPLICATE KEY UPDATE
                    username = COALESCE(VALUES(username), username),
                    message_count = message_count + 1,
                    last_message_at = CURRENT_TIMESTAMP`,
                [validGuildId, validUserId, validChannelId, safeUsername]
            );
            return true;
        } catch (error) {
            console.error('Error tracking user channel activity:', error);
            return false;
        }
    }

    async getTopUserChannels(guildId, userId, limit = 3) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            if (!validGuildId || !validUserId) return [];

            const safeLimit = Math.max(1, Math.min(10, Number(limit) || 3));
            const rows = await this.connection.query(
                `SELECT channel_id, message_count, last_message_at
                 FROM user_channel_activity
                 WHERE guild_id = ? AND user_id = ?
                 ORDER BY message_count DESC, last_message_at DESC
                 LIMIT ?`,
                [validGuildId, validUserId, safeLimit]
            );

            return (rows || []).map((row) => ({
                channelId: String(row.channel_id),
                messageCount: Number(row.message_count || 0),
                lastMessageAt: row.last_message_at || null
            }));
        } catch (error) {
            console.error('Error getting top user channels:', error);
            return [];
        }
    }

    async getUserChannelMessageTotal(guildId, userId) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            if (!validGuildId || !validUserId) return 0;

            const rows = await this.connection.query(
                `SELECT SUM(message_count) AS total_messages
                 FROM user_channel_activity
                 WHERE guild_id = ? AND user_id = ?`,
                [validGuildId, validUserId]
            );

            return Number(rows?.[0]?.total_messages || 0);
        } catch (error) {
            console.error('Error getting user channel message total:', error);
            return 0;
        }
    }


    async addCase(userId, caseId, caseData) {
        try {
            // Handle both old format (moderator, date) and new format (moderatorId, timestamp)
            const moderatorId = caseData.moderatorId || caseData.moderator || null;
            const reason = caseData.reason || null;
            const type = this.normalizeModerationActionType(caseData.type || 'WARN');
            const timestamp = caseData.timestamp || Date.now();
            const duration = caseData.duration || null;
            const expiresAt = caseData.expiresAt || null;
            const guildId = caseData.guildId || null;
            const userName = caseData.userName || caseData.userTag || null;
            const moderatorName = caseData.moderatorName || caseData.moderatorTag || null;
            const moderatorSource = caseData.moderatorSource || (moderatorId ? 'discord' : null);
            const relatedCaseId = caseData.relatedCaseId || caseData.originalCase || null;

            await this.upsertModerationCase({
                caseId,
                guildId,
                userId,
                userName,
                actionType: type,
                reason,
                moderatorId,
                moderatorName,
                moderatorSource,
                source: caseData.source || moderatorSource || 'discord',
                relatedCaseId,
                rootCaseId: relatedCaseId || caseId,
                expiresAt,
                status: caseData.status || this.getDefaultModerationCaseStatus(type, expiresAt),
                metadata: {
                    duration,
                    durationString: caseData.durationString || null,
                    originalCase: relatedCaseId || null
                },
                createdAt: timestamp,
                updatedAt: timestamp,
                eventSummary: `${type} case recorded`
            });

            if (type === 'UNBAN' && relatedCaseId) {
                await this.updateModerationCaseStatus(relatedCaseId, 'reversed', {
                    guildId,
                    actorId: moderatorId,
                    actorName: moderatorName,
                    relatedCaseId: caseId,
                    details: `Reversed by unban case ${caseId}`,
                    updatedAt: timestamp
                });
            }

            if (type === 'UNTIMEOUT' && relatedCaseId) {
                await this.updateModerationCaseStatus(relatedCaseId, 'cleared', {
                    guildId,
                    actorId: moderatorId,
                    actorName: moderatorName,
                    relatedCaseId: caseId,
                    details: `Cleared by untimeout case ${caseId}`,
                    updatedAt: timestamp
                });
            }

            // Update user_bans table only for ban actions
            if (type === 'BAN') {
                await this.connection.query(
                    `INSERT INTO user_bans (user_id, banned, ban_case_id, banned_at, banned_by, ban_reason, user_name, banned_by_name, banned_by_source) 
                     VALUES (?, TRUE, ?, NOW(), ?, ?, ?, ?, ?) 
                     ON DUPLICATE KEY UPDATE 
                        banned = TRUE, 
                        ban_case_id = ?, 
                        banned_at = NOW(), 
                        banned_by = ?,
                        ban_reason = ?,
                        user_name = ?,
                        banned_by_name = ?,
                        banned_by_source = ?`,
                    [userId, caseId, moderatorId, reason, userName, moderatorName, moderatorSource, caseId, moderatorId, reason, userName, moderatorName, moderatorSource]
                );
                this.invalidateCacheByPrefix(this.getCacheKey('warns', `${userId}:`));
                this.invalidateCacheByPrefix(this.getCacheKey('warns', 'list:'));
                this.invalidateCacheByPrefix(this.getCacheKey('banned', 'list:'));
                this.invalidateCacheByPrefix(this.getCacheKey('banned', 'count'));
            }

            this.invalidateModerationUserCaches(userId);

            return true;
        } catch (error) {
            console.error('Error adding case:', error);
            return false;
        }
    }

    async getUserWarns(userId) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId) {
                return { warns: {}, banned: false, lastWarned: null, lastReason: null };
            }

            const warns = await this.getUserModerationCases(validId, {
                actionTypes: ['WARN'],
                excludeStatuses: ['cleared', 'reversed'],
                limit: 500
            });

            const banInfo = await this.query(
                'SELECT * FROM user_bans WHERE user_id = ?',
                [validId],
                {
                    useCache: true,
                    cacheNamespace: 'warns',
                    cacheKey: `${validId}:banInfo`,
                    cacheTtlMs: 10000,
                    logLabel: 'getUserWarns.banInfo'
                }
            );

            // Convert to old format
            const warnsObj = {};
            let lastWarn = null;
            warns.forEach(warn => {
                warnsObj[warn.case_id] = {
                    reason: warn.reason,
                    moderatorId: warn.moderator_id,
                    type: warn.action_type,
                    timestamp: Number(warn.created_at || warn.updated_at || 0) || null
                };
                const warnTimestamp = Number(warn.created_at || warn.updated_at || 0) || 0;
                const lastWarnTimestamp = Number(lastWarn?.created_at || lastWarn?.updated_at || 0) || 0;
                if (!lastWarn || warnTimestamp > lastWarnTimestamp) {
                    lastWarn = warn;
                }
            });

            return {
                warns: warnsObj,
                banned: banInfo[0]?.banned || false,
                lastWarned: Number(lastWarn?.created_at || lastWarn?.updated_at || 0) || null,
                lastReason: lastWarn?.reason || null
            };
        } catch (error) {
            console.error('Error getting user warns:', error);
            return { warns: {} };
        }
    }

    async getUserWarnsCount(userId) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId) return 0;

            const count = await this.queryValue(
                `SELECT COUNT(*) as count
                 FROM moderation_cases
                 WHERE user_id = ? AND action_type = 'WARN' AND status NOT IN ('cleared', 'reversed')`,
                [validId],
                'count',
                {
                    useCache: true,
                    cacheNamespace: 'warns',
                    cacheKey: `${validId}:count`,
                    cacheTtlMs: 10000,
                    logLabel: 'getUserWarnsCount'
                }
            );
            return Number(count || 0);
        } catch (error) {
            console.error('Error getting user warns count:', error);
            return 0;
        }
    }

    async clearUserWarns(userId) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId) return false;

            const clearedCount = await this.clearAllWarningCases(validId);
            return clearedCount >= 0;
        } catch (error) {
            console.error('Error clearing user warns:', error);
            return false;
        }
    }

    async deleteWarn(userId, caseId) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId || !caseId) return false;

            return !!(await this.clearWarningCase(validId, caseId));
        } catch (error) {
            console.error('Error deleting warn:', error);
            return false;
        }
    }

    async isUserBanned(userId) {
        try {
            const results = await this.connection.query(
                'SELECT banned FROM user_bans WHERE user_id = ?',
                [userId]
            );
            return results[0]?.banned || false;
        } catch (error) {
            console.error('Error checking if user banned:', error);
            return false;
        }
    }

    async markUserBanned(userId) {
        try {
            await this.connection.query(
                `INSERT INTO user_bans (user_id, banned) 
                 VALUES (?, TRUE) 
                 ON DUPLICATE KEY UPDATE banned = TRUE`,
                [userId]
            );
            this.invalidateCacheByPrefix(this.getCacheKey('warns', `${userId}:`));
            this.invalidateCacheByPrefix(this.getCacheKey('warns', 'list:'));
            this.invalidateCacheByPrefix(this.getCacheKey('banned', 'list:'));
            this.invalidateCacheByPrefix(this.getCacheKey('banned', 'count'));
            this.invalidateCacheByPrefix(this.getCacheKey('userprofile', `${userId}:`));
            return true;
        } catch (error) {
            console.error('Error marking user banned:', error);
            return false;
        }
    }

    async unbanUser(userId) {
        try {
            await this.connection.query(
                `INSERT INTO user_bans (user_id, banned) 
                 VALUES (?, FALSE) 
                 ON DUPLICATE KEY UPDATE banned = FALSE`,
                [userId]
            );
            this.invalidateCacheByPrefix(this.getCacheKey('warns', `${userId}:`));
            this.invalidateCacheByPrefix(this.getCacheKey('warns', 'list:'));
            this.invalidateCacheByPrefix(this.getCacheKey('banned', 'list:'));
            this.invalidateCacheByPrefix(this.getCacheKey('banned', 'count'));
            this.invalidateCacheByPrefix(this.getCacheKey('userprofile', `${userId}:`));
            return true;
        } catch (error) {
            console.error('Error unbanning user:', error);
            return false;
        }
    }

    async getAllWarns() {
        try {
            const query = `
                SELECT mc.user_id,
                       COUNT(*) as warn_count,
                       COALESCE(ub.banned, FALSE) as banned,
                       latest.last_warned,
                       latest.last_reason
                FROM moderation_cases mc
                LEFT JOIN user_bans ub ON mc.user_id = ub.user_id
                LEFT JOIN (
                    SELECT mc1.user_id, mc1.created_at AS last_warned, mc1.reason AS last_reason
                    FROM moderation_cases mc1
                    INNER JOIN (
                        SELECT user_id, MAX(created_at) AS max_ts
                        FROM moderation_cases
                        WHERE action_type = 'WARN' AND status NOT IN ('cleared', 'reversed')
                        GROUP BY user_id
                    ) latest_inner ON latest_inner.user_id = mc1.user_id AND latest_inner.max_ts = mc1.created_at
                    WHERE mc1.action_type = 'WARN' AND mc1.status NOT IN ('cleared', 'reversed')
                ) latest ON mc.user_id = latest.user_id
                WHERE mc.action_type = 'WARN' AND mc.status NOT IN ('cleared', 'reversed')
                GROUP BY mc.user_id, ub.banned, latest.last_warned, latest.last_reason
            `;
            const results = await this.query(query, [], {
                useCache: true,
                cacheNamespace: 'warns',
                cacheKey: 'list:all',
                cacheTtlMs: 12000,
                logLabel: 'getAllWarns'
            });
            return results;
        } catch (error) {
            console.error('Error getting all warns:', error);
            return [];
        }
    }

    async getWarnsCount() {
        try {
            const count = await this.queryValue(
                `SELECT COUNT(DISTINCT user_id) as count
                 FROM moderation_cases
                 WHERE action_type = 'WARN' AND status NOT IN ('cleared', 'reversed')`,
                [],
                'count',
                {
                    useCache: true,
                    cacheNamespace: 'warns',
                    cacheKey: 'count',
                    cacheTtlMs: 20000,
                    logLabel: 'getWarnsCount'
                }
            );
            return Number(count || 0);
        } catch (error) {
            console.error('Error getting warns count:', error);
            return 0;
        }
    }

    async getBannedCount() {
        try {
            const count = await this.queryValue(
                'SELECT COUNT(*) as count FROM user_bans WHERE banned = TRUE',
                [],
                'count',
                {
                    useCache: true,
                    cacheNamespace: 'banned',
                    cacheKey: 'count',
                    cacheTtlMs: 20000,
                    logLabel: 'getBannedCount'
                }
            );
            return Number(count || 0);
        } catch (error) {
            console.error('Error getting banned count:', error);
            return 0;
        }
    }

    async getAllBannedUsers() {
        try {
            const query = `
                SELECT ub.user_id,
                       UNIX_TIMESTAMP(ub.banned_at) * 1000 as banned_at,
                       ub.banned_by,
                       ub.ban_reason,
                       COUNT(w.case_id) as warn_count
                FROM user_bans ub
                LEFT JOIN warns w ON ub.user_id = w.user_id
                WHERE ub.banned = TRUE
                GROUP BY ub.user_id, ub.banned_at, ub.banned_by, ub.ban_reason
                ORDER BY ub.banned_at DESC
            `;
            const results = await this.query(query, [], {
                useCache: true,
                cacheNamespace: 'banned',
                cacheKey: 'list:all',
                cacheTtlMs: 12000,
                logLabel: 'getAllBannedUsers'
            });
            return results.map(r => ({
                userId: r.user_id,
                bannedAt: r.banned_at,
                bannedBy: r.banned_by,
                banReason: r.ban_reason,
                warnCount: Number(r.warn_count || 0)
            }));
        } catch (error) {
            console.error('Error getting all banned users:', error);
            return [];
        }
    }

    async addReminder(userId, reminderData) {
        try {
            const reminderId = reminderData.id || `${userId}-${Date.now()}`;
            const {
                caseId,
                message,
                text,
                timestamp,
                createdAt,
                triggerAt,
                channelId,
                guildId,
                completed,
                deliveryAttempts,
                lastFailureReason,
                lastFailureTime
            } = reminderData;

            // Use REPLACE to handle both insert and update
            await this.connection.query(
                `REPLACE INTO reminders 
                (id, case_id, user_id, message, text, timestamp, created_at, trigger_at, channel_id, guild_id, completed, delivery_attempts, last_failure_reason, last_failure_time) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    reminderId,
                    caseId || null,
                    userId,
                    message,
                    text || message,
                    timestamp || triggerAt || Date.now(),
                    createdAt || Date.now(),
                    triggerAt || timestamp || Date.now(),
                    channelId,
                    guildId,
                    completed || false,
                    deliveryAttempts || 0,
                    lastFailureReason,
                    lastFailureTime
                ]
            );
            this.invalidateCacheByPrefix(this.getCacheKey('reminders', `${userId}:`));
            this.invalidateCacheByPrefix(this.getCacheKey('reminders', 'list:'));
            this.invalidateCacheByPrefix(this.getCacheKey('reminders', 'count'));
            return reminderId;
        } catch (error) {
            console.error('Error adding reminder:', error);
            return null;
        }
    }

    async getUserReminders(userId) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId) return [];

            const results = await this.query(
                'SELECT * FROM reminders WHERE user_id = ? AND completed = FALSE ORDER BY trigger_at ASC',
                [validId],
                {
                    useCache: true,
                    cacheNamespace: 'reminders',
                    cacheKey: `${validId}:active`,
                    cacheTtlMs: 8000,
                    logLabel: 'getUserReminders'
                }
            );
            return results.map(r => ({
                id: r.id,
                caseId: r.case_id,
                userId: r.user_id,
                message: r.message,
                text: r.text || r.message,
                timestamp: r.timestamp,
                createdAt: r.created_at,
                triggerAt: r.trigger_at,
                channelId: r.channel_id,
                guildId: r.guild_id,
                completed: r.completed || false,
                deliveryAttempts: r.delivery_attempts || 0,
                lastFailureReason: r.last_failure_reason,
                lastFailureTime: r.last_failure_time
            }));
        } catch (error) {
            console.error('Error getting user reminders:', error);
            return [];
        }
    }

    async removeReminder(userId, reminderId) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId || !reminderId) return false;

            await this.connection.query(
                'DELETE FROM reminders WHERE user_id = ? AND id = ?',
                [validId, reminderId]
            );
            this.invalidateCacheByPrefix(this.getCacheKey('reminders', `${validId}:`));
            this.invalidateCacheByPrefix(this.getCacheKey('reminders', 'list:'));
            this.invalidateCacheByPrefix(this.getCacheKey('reminders', 'count'));
            return true;
        } catch (error) {
            console.error('Error removing reminder:', error);
            return false;
        }
    }

    async getAllReminders() {
        try {
            const results = await this.query(
                'SELECT * FROM reminders ORDER BY trigger_at ASC',
                [],
                {
                    useCache: true,
                    cacheNamespace: 'reminders',
                    cacheKey: 'list:all',
                    cacheTtlMs: 10000,
                    logLabel: 'getAllReminders'
                }
            );
            return results.map(r => ({
                id: r.id,
                caseId: r.case_id,
                user_id: r.user_id,
                userId: r.user_id,
                message: r.message,
                text: r.text || r.message,
                timestamp: r.timestamp,
                created_at: r.created_at,
                createdAt: r.created_at,
                trigger_at: r.trigger_at,
                triggerAt: r.trigger_at,
                channel_id: r.channel_id,
                channelId: r.channel_id,
                guild_id: r.guild_id,
                guildId: r.guild_id,
                completed: r.completed || false,
                delivery_attempts: r.delivery_attempts || 0,
                deliveryAttempts: r.delivery_attempts || 0,
                last_failure_reason: r.last_failure_reason,
                lastFailureReason: r.last_failure_reason,
                last_failure_time: r.last_failure_time,
                lastFailureTime: r.last_failure_time
            }));
        } catch (error) {
            console.error('Error getting all reminders:', error);
            return [];
        }
    }

    async getRemindersCount() {
        try {
            const count = await this.queryValue(
                'SELECT COUNT(*) as count FROM reminders',
                [],
                'count',
                {
                    useCache: true,
                    cacheNamespace: 'reminders',
                    cacheKey: 'count',
                    cacheTtlMs: 20000,
                    logLabel: 'getRemindersCount'
                }
            );
            return Number(count || 0);
        } catch (error) {
            console.error('Error getting reminders count:', error);
            return 0;
        }
    }



    async createGiveaway(id, data) {
        try {
            if (!id) {
                console.error('[MySQL] Cannot create giveaway - id is null/undefined');
                return false;
            }

            // Only use columns that exist in the giveaways table
            const {
                prize,
                title,
                channelId,
                messageId,
                hostId,
                guildId,
                endTime,
                winnerCount,
                requiredRoleId,
                winnerIds,
                ended,
                caseId
            } = data;

            const serializedWinnerIds = Array.isArray(winnerIds)
                ? JSON.stringify(winnerIds)
                : (winnerIds ? JSON.stringify(winnerIds) : null);

            await this.connection.query(
                `INSERT INTO giveaways (id, case_id, prize, title, channel_id, message_id, host_id, guild_id, end_time, winner_count, required_role_id, winner_ids, ended) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    id,
                    caseId || null,
                    prize || null,
                    title || null,
                    channelId || null,
                    messageId || null,
                    hostId || null,
                    guildId || null,
                    endTime || null,
                    winnerCount || 1,
                    requiredRoleId || null,
                    serializedWinnerIds,
                    ended ? 1 : 0
                ]
            );
            this.invalidateCacheByPrefix(this.getCacheKey('giveaways', `${id}:`));
            this.invalidateCacheByPrefix(this.getCacheKey('giveaways', 'list:'));
            this.invalidateCacheByPrefix(this.getCacheKey('giveaways', 'count'));
            return true;
        } catch (error) {
            console.error('Error creating giveaway:', error);
            return false;
        }
    }

    async getGiveaway(id) {
        try {
            if (!id) {
                console.warn('[MySQL] getGiveaway called with null/undefined id');
                return null;
            }

            const results = await this.query(
                'SELECT * FROM giveaways WHERE id = ?',
                [id],
                {
                    useCache: true,
                    cacheNamespace: 'giveaways',
                    cacheKey: `${id}:base`,
                    cacheTtlMs: 10000,
                    logLabel: 'getGiveaway.base'
                }
            );

            if (results.length === 0) return null;

            // Get entries
            const entries = await this.query(
                'SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?',
                [id],
                {
                    useCache: true,
                    cacheNamespace: 'giveaways',
                    cacheKey: `${id}:entries`,
                    cacheTtlMs: 8000,
                    logLabel: 'getGiveaway.entries'
                }
            );

            const giveaway = results[0];
            let parsedWinnerIds = [];
            try {
                parsedWinnerIds = giveaway.winner_ids ? JSON.parse(giveaway.winner_ids) : [];
            } catch (_) {
                parsedWinnerIds = [];
            }

            return {
                id: giveaway.id,
                caseId: giveaway.case_id,
                prize: giveaway.prize,
                title: giveaway.title,
                channelId: giveaway.channel_id,
                messageId: giveaway.message_id,
                hostId: giveaway.host_id,
                guildId: giveaway.guild_id,
                endTime: giveaway.end_time,
                winnerCount: giveaway.winner_count,
                requiredRoleId: giveaway.required_role_id,
                winnerIds: Array.isArray(parsedWinnerIds) ? parsedWinnerIds : [],
                ended: giveaway.ended,
                entries: entries.map(e => e.user_id)
            };
        } catch (error) {
            console.error('Error getting giveaway:', error);
            return null;
        }
    }

    async updateGiveaway(id, data) {
        try {
            const fields = [];
            const values = [];

            if (data.ended !== undefined) {
                fields.push('ended = ?');
                values.push(data.ended ? 1 : 0);
            }
            if (data.endTime !== undefined) {
                fields.push('end_time = ?');
                values.push(data.endTime);
            }
            if (data.winnerCount !== undefined) {
                fields.push('winner_count = ?');
                values.push(Math.max(1, Number(data.winnerCount) || 1));
            }
            if (Object.prototype.hasOwnProperty.call(data, 'requiredRoleId')) {
                fields.push('required_role_id = ?');
                values.push(data.requiredRoleId || null);
            }
            if (Object.prototype.hasOwnProperty.call(data, 'winnerIds')) {
                fields.push('winner_ids = ?');
                values.push(Array.isArray(data.winnerIds) ? JSON.stringify(data.winnerIds) : null);
            }

            if (fields.length > 0) {
                values.push(id);
                await this.connection.query(
                    `UPDATE giveaways SET ${fields.join(', ')} WHERE id = ?`,
                    values
                );
                this.invalidateCacheByPrefix(this.getCacheKey('giveaways', `${id}:`));
                this.invalidateCacheByPrefix(this.getCacheKey('giveaways', 'list:'));
            }
            return true;
        } catch (error) {
            console.error('Error updating giveaway:', error);
            return false;
        }
    }

    async addGiveawayEntry(giveawayId, userId) {
        try {
            await this.connection.query(
                'INSERT IGNORE INTO giveaway_entries (giveaway_id, user_id) VALUES (?, ?)',
                [giveawayId, userId]
            );
            this.invalidateCacheByPrefix(this.getCacheKey('giveaways', `${giveawayId}:`));
            this.invalidateCacheByPrefix(this.getCacheKey('giveaways', 'list:'));
            return true;
        } catch (error) {
            console.error('Error adding giveaway entry:', error);
            return false;
        }
    }

    async removeGiveawayEntry(giveawayId, userId) {
        try {
            await this.connection.query(
                'DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?',
                [giveawayId, userId]
            );
            this.invalidateCacheByPrefix(this.getCacheKey('giveaways', `${giveawayId}:`));
            this.invalidateCacheByPrefix(this.getCacheKey('giveaways', 'list:'));
            return true;
        } catch (error) {
            console.error('Error removing giveaway entry:', error);
            return false;
        }
    }

    async getAllGiveaways() {
        try {
            const giveaways = await this.query(
                'SELECT * FROM giveaways ORDER BY created_at DESC',
                [],
                {
                    useCache: true,
                    cacheNamespace: 'giveaways',
                    cacheKey: 'list:all:base',
                    cacheTtlMs: 10000,
                    logLabel: 'getAllGiveaways.base'
                }
            );

            // Get entries for each giveaway
            const result = await Promise.all(giveaways.map(async (g) => {
                const entries = await this.query(
                    'SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?',
                    [g.id],
                    {
                        useCache: true,
                        cacheNamespace: 'giveaways',
                        cacheKey: `${g.id}:entries`,
                        cacheTtlMs: 8000,
                        logLabel: 'getAllGiveaways.entries'
                    }
                );

                return {
                    id: g.id,
                    caseId: g.case_id,
                    prize: g.prize,
                    title: g.title,
                    channelId: g.channel_id,
                    messageId: g.message_id,
                    hostId: g.host_id,
                    guildId: g.guild_id,
                    endTime: g.end_time,
                    winnerCount: g.winner_count,
                    requiredRoleId: g.required_role_id,
                    winnerIds: (() => {
                        try {
                            return g.winner_ids ? JSON.parse(g.winner_ids) : [];
                        } catch (_) {
                            return [];
                        }
                    })(),
                    ended: g.ended,
                    entries: entries.map(e => e.user_id)
                };
            }));

            return result;
        } catch (error) {
            console.error('Error getting all giveaways:', error);
            return [];
        }
    }

    async getGiveawaysCount() {
        try {
            const count = await this.queryValue(
                'SELECT COUNT(*) as count FROM giveaways',
                [],
                'count',
                {
                    useCache: true,
                    cacheNamespace: 'giveaways',
                    cacheKey: 'count',
                    cacheTtlMs: 20000,
                    logLabel: 'getGiveawaysCount'
                }
            );
            return Number(count || 0);
        } catch (error) {
            console.error('Error getting giveaways count:', error);
            return 0;
        }
    }

    async deleteGiveaway(id) {
        try {
            if (!id) {
                console.warn('[MySQL] deleteGiveaway called with null/undefined id');
                return false;
            }

            await this.connection.query(
                'DELETE FROM giveaway_entries WHERE giveaway_id = ?',
                [id]
            );

            await this.connection.query(
                'DELETE FROM giveaways WHERE id = ?',
                [id]
            );
            this.invalidateCacheByPrefix(this.getCacheKey('giveaways', `${id}:`));
            this.invalidateCacheByPrefix(this.getCacheKey('giveaways', 'list:'));
            this.invalidateCacheByPrefix(this.getCacheKey('giveaways', 'count'));
            return true;
        } catch (error) {
            console.error('Error deleting giveaway:', error);
            return false;
        }
    }

    async createTicket(channelId, ticketData) {
        try {
            const { userId, userName, reason, priority, createdAt, claimedBy, claimedByName, status } = ticketData;
            await this.connection.query(
                `INSERT INTO tickets (channel_id, user_id, user_name, reason, priority, created_at, claimed_by, claimed_by_name, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [channelId, userId, userName, reason || null, priority || 'medium', createdAt || Date.now(), claimedBy || null, claimedByName || null, status || 'open']
            );
            return true;
        } catch (error) {
            console.error('Error creating ticket:', error);
            return false;
        }
    }

    async getTicket(channelId) {
        try {
            const results = await this.connection.query(
                'SELECT * FROM tickets WHERE channel_id = ?',
                [channelId]
            );
            if (results && results.length > 0) {
                const ticket = results[0];
                return {
                    channelId: ticket.channel_id,
                    userId: ticket.user_id,
                    userName: ticket.user_name,
                    reason: ticket.reason,
                    priority: ticket.priority,
                    createdAt: ticket.created_at,
                    claimedBy: ticket.claimed_by,
                    claimedByName: ticket.claimed_by_name,
                    status: ticket.status,
                    closedAt: ticket.closed_at,
                    closedBy: ticket.closed_by,
                    closedByName: ticket.closed_by_name,
                    closeReason: ticket.close_reason,
                    transcript: ticket.transcript,
                    transcriptCreatedAt: ticket.transcript_created_at
                };
            }
            return null;
        } catch (error) {
            console.error('Error getting ticket:', error);
            return null;
        }
    }

    async updateTicket(channelId, updates) {
        try {
            const fields = [];
            const values = [];

            if (updates.claimedBy !== undefined) {
                fields.push('claimed_by = ?');
                values.push(updates.claimedBy);
            }
            if (updates.claimedByName !== undefined) {
                fields.push('claimed_by_name = ?');
                values.push(updates.claimedByName);
            }
            if (updates.status !== undefined) {
                fields.push('status = ?');
                values.push(updates.status);
            }
            if (updates.closedAt !== undefined) {
                fields.push('closed_at = ?');
                values.push(updates.closedAt);
            }
            if (updates.closedBy !== undefined) {
                fields.push('closed_by = ?');
                values.push(updates.closedBy);
            }
            if (updates.closedByName !== undefined) {
                fields.push('closed_by_name = ?');
                values.push(updates.closedByName);
            }
            if (updates.closeReason !== undefined) {
                fields.push('close_reason = ?');
                values.push(updates.closeReason);
            }
            if (updates.transcript !== undefined) {
                fields.push('transcript = ?');
                values.push(updates.transcript);
            }
            if (updates.transcriptCreatedAt !== undefined) {
                fields.push('transcript_created_at = ?');
                values.push(updates.transcriptCreatedAt);
            }

            if (fields.length === 0) return false;

            values.push(channelId);
            await this.connection.query(
                `UPDATE tickets SET ${fields.join(', ')} WHERE channel_id = ?`,
                values
            );
            return true;
        } catch (error) {
            console.error('Error updating ticket:', error);
            return false;
        }
    }

    async deleteTicket(channelId) {
        try {
            await this.connection.query('DELETE FROM tickets WHERE channel_id = ?', [channelId]);
            return true;
        } catch (error) {
            console.error('Error deleting ticket:', error);
            return false;
        }
    }

    async getAllTickets(status = null) {
        try {
            let query = 'SELECT * FROM tickets';
            let params = [];

            if (status) {
                query += ' WHERE status = ?';
                params.push(status);
            }

            query += ' ORDER BY created_at DESC';

            const results = await this.connection.query(query, params);
            return results.map(ticket => ({
                channelId: ticket.channel_id,
                userId: ticket.user_id,
                userName: ticket.user_name,
                reason: ticket.reason,
                priority: ticket.priority,
                createdAt: ticket.created_at,
                claimedBy: ticket.claimed_by,
                claimedByName: ticket.claimed_by_name,
                status: ticket.status,
                closedAt: ticket.closed_at,
                closedBy: ticket.closed_by,
                closedByName: ticket.closed_by_name,
                closeReason: ticket.close_reason,
                transcriptCreatedAt: ticket.transcript_created_at
            }));
        } catch (error) {
            console.error('Error getting all tickets:', error);
            return [];
        }
    }

    async getUserTickets(userId) {
        try {
            const results = await this.connection.query(
                'SELECT * FROM tickets WHERE user_id = ? ORDER BY created_at DESC',
                [userId]
            );
            return results.map(ticket => ({
                channelId: ticket.channel_id,
                userName: ticket.user_name,
                reason: ticket.reason,
                priority: ticket.priority,
                createdAt: ticket.created_at,
                claimedBy: ticket.claimed_by,
                claimedByName: ticket.claimed_by_name,
                status: ticket.status,
                closedAt: ticket.closed_at,
                closedBy: ticket.closed_by,
                closedByName: ticket.closed_by_name,
                closeReason: ticket.close_reason
            }));
        } catch (error) {
            console.error('Error getting user tickets:', error);
            return [];
        }
    }

    async createJTCChannel(channelId, ownerId, guildId, channelName) {
        try {
            await this.connection.query(
                `INSERT INTO join_to_create (channel_id, owner_id, guild_id, channel_name, created_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE is_active = TRUE`,
                [channelId, ownerId, guildId, channelName, Date.now()]
            );
            return true;
        } catch (error) {
            console.error('Error creating JTC channel:', error);
            return false;
        }
    }

    async getJTCChannel(channelId) {
        try {
            const results = await this.connection.query(
                'SELECT * FROM join_to_create WHERE channel_id = ? AND is_active = TRUE',
                [channelId]
            );
            return results && results.length > 0 ? results[0] : null;
        } catch (error) {
            console.error('Error getting JTC channel:', error);
            return null;
        }
    }

    async deleteJTCChannel(channelId) {
        try {
            await this.connection.query(
                'UPDATE join_to_create SET is_active = FALSE WHERE channel_id = ?',
                [channelId]
            );
            return true;
        } catch (error) {
            console.error('Error deleting JTC channel:', error);
            return false;
        }
    }

    async transferJTCOwner(channelId, newOwnerId, channelName = null) {
        try {
            const updates = ['owner_id = ?'];
            const params = [newOwnerId];

            if (channelName && typeof channelName === 'string') {
                updates.push('channel_name = ?');
                params.push(channelName.slice(0, 100));
            }

            updates.push('is_active = TRUE');
            params.push(channelId);

            await this.connection.query(
                `UPDATE join_to_create SET ${updates.join(', ')} WHERE channel_id = ?`,
                params
            );
            return true;
        } catch (error) {
            console.error('Error transferring JTC owner:', error);
            return false;
        }
    }

    async getActiveJTCChannels(guildId) {
        try {
            const results = await this.connection.query(
                'SELECT * FROM join_to_create WHERE guild_id = ? AND is_active = TRUE',
                [guildId]
            );
            return results || [];
        } catch (error) {
            console.error('Error getting active JTC channels:', error);
            return [];
        }
    }

    async cleanupOldJTCChannels(maxAgeMs = 24 * 60 * 60 * 1000) {
        try {
            const cutoffTime = Date.now() - maxAgeMs;
            await this.connection.query(
                'UPDATE join_to_create SET is_active = FALSE WHERE created_at < ?',
                [cutoffTime]
            );
            return true;
        } catch (error) {
            console.error('Error cleaning up old JTC channels:', error);
            return false;
        }
    }

    // ========== BIRTHDAYS ==========

    isValidBirthday(month, day) {
        const m = Number(month);
        const d = Number(day);
        if (!Number.isInteger(m) || !Number.isInteger(d)) return false;
        if (m < 1 || m > 12 || d < 1 || d > 31) return false;

        const testDate = new Date(Date.UTC(2000, m - 1, d));
        return testDate.getUTCMonth() === (m - 1) && testDate.getUTCDate() === d;
    }

    getNextBirthdayDate(month, day, fromDate = new Date()) {
        const m = Number(month);
        const d = Number(day);
        if (!this.isValidBirthday(m, d)) return null;

        const base = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate()));
        let year = base.getUTCFullYear();

        for (let i = 0; i < 8; i++) {
            const candidate = new Date(Date.UTC(year, m - 1, d));
            if (candidate.getUTCMonth() !== (m - 1) || candidate.getUTCDate() !== d) {
                year++;
                continue;
            }
            if (candidate >= base) {
                return candidate;
            }
            year++;
        }

        return null;
    }

    async setBirthday(guildId, userId, month, day) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            if (!validGuildId || !validUserId) return false;
            if (!this.isValidBirthday(month, day)) return false;

            const safeMonth = Number(month);
            const safeDay = Number(day);

            await this.connection.query(
                `INSERT INTO birthdays (guild_id, user_id, month, day)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE month = VALUES(month), day = VALUES(day), updated_at = CURRENT_TIMESTAMP`,
                [validGuildId, validUserId, safeMonth, safeDay]
            );
            return true;
        } catch (error) {
            console.error('Error setting birthday:', error);
            return false;
        }
    }

    async getBirthday(guildId, userId) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            if (!validGuildId || !validUserId) return null;

            const results = await this.connection.query(
                'SELECT guild_id, user_id, month, day, created_at, updated_at FROM birthdays WHERE guild_id = ? AND user_id = ? LIMIT 1',
                [validGuildId, validUserId]
            );

            if (!results || results.length === 0) return null;
            return results[0];
        } catch (error) {
            console.error('Error getting birthday:', error);
            return null;
        }
    }

    async removeBirthday(guildId, userId) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            if (!validGuildId || !validUserId) return false;

            const result = await this.connection.query(
                'DELETE FROM birthdays WHERE guild_id = ? AND user_id = ?',
                [validGuildId, validUserId]
            );

            return (result?.affectedRows || 0) > 0;
        } catch (error) {
            console.error('Error removing birthday:', error);
            return false;
        }
    }

    async getUpcomingBirthdays(guildId, daysAhead = 7) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            if (!validGuildId) return [];

            const windowDays = Math.max(1, Math.min(31, Number(daysAhead) || 7));
            const today = new Date();
            const startUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

            const rows = await this.connection.query(
                'SELECT guild_id, user_id, month, day, created_at, updated_at FROM birthdays WHERE guild_id = ?',
                [validGuildId]
            );

            const results = [];
            for (const row of rows || []) {
                const nextDate = this.getNextBirthdayDate(row.month, row.day, startUtc);
                if (!nextDate) continue;

                const daysUntil = Math.floor((nextDate.getTime() - startUtc.getTime()) / (24 * 60 * 60 * 1000));
                if (daysUntil < 0 || daysUntil >= windowDays) continue;

                results.push({
                    ...row,
                    daysUntil,
                    nextDate: nextDate.toISOString()
                });
            }

            results.sort((a, b) => a.daysUntil - b.daysUntil || Number(a.month) - Number(b.month) || Number(a.day) - Number(b.day));
            return results;
        } catch (error) {
            console.error('Error getting upcoming birthdays:', error);
            return [];
        }
    }

    async getBirthdayAnnouncementUserIds(guildId, dateKey) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const safeDateKey = typeof dateKey === 'string' ? dateKey.trim() : '';
            if (!validGuildId || !/^\d{4}-\d{2}-\d{2}$/.test(safeDateKey)) return [];

            const rows = await this.connection.query(
                'SELECT user_id FROM birthday_announcements WHERE guild_id = ? AND date_key = ?',
                [validGuildId, safeDateKey]
            );

            return (rows || []).map(row => String(row.user_id));
        } catch (error) {
            console.error('Error getting birthday announcement user IDs:', error);
            return [];
        }
    }

    async markBirthdayAnnouncementsSent(guildId, dateKey, userIds = []) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const safeDateKey = typeof dateKey === 'string' ? dateKey.trim() : '';
            if (!validGuildId || !/^\d{4}-\d{2}-\d{2}$/.test(safeDateKey)) return false;

            const uniqueUserIds = [...new Set(
                (Array.isArray(userIds) ? userIds : [])
                    .map(id => this.validateDiscordId(id))
                    .filter(Boolean)
            )];

            if (!uniqueUserIds.length) return true;

            for (const userId of uniqueUserIds) {
                await this.connection.query(
                    `INSERT INTO birthday_announcements (guild_id, user_id, date_key)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE sent_at = sent_at`,
                    [validGuildId, userId, safeDateKey]
                );
            }

            return true;
        } catch (error) {
            console.error('Error marking birthday announcements as sent:', error);
            return false;
        }
    }


    async addReputationPoint(guildId, userId) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            if (!validGuildId || !validUserId) return null;

            await this.connection.query(
                `INSERT INTO reputation_points (guild_id, user_id, points)
                 VALUES (?, ?, 1)
                 ON DUPLICATE KEY UPDATE points = points + 1, updated_at = CURRENT_TIMESTAMP`,
                [validGuildId, validUserId]
            );

            const rows = await this.connection.query(
                'SELECT points FROM reputation_points WHERE guild_id = ? AND user_id = ? LIMIT 1',
                [validGuildId, validUserId]
            );

            return Number(rows?.[0]?.points || 0);
        } catch (error) {
            console.error('Error adding reputation point:', error);
            return null;
        }
    }

    async getReputation(guildId, userId) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            if (!validGuildId || !validUserId) return 0;

            const rows = await this.connection.query(
                'SELECT points FROM reputation_points WHERE guild_id = ? AND user_id = ? LIMIT 1',
                [validGuildId, validUserId]
            );

            return Number(rows?.[0]?.points || 0);
        } catch (error) {
            console.error('Error getting reputation:', error);
            return 0;
        }
    }

    async giveReputationPoint(guildId, giverId, targetId, options = {}) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validGiverId = this.validateDiscordId(giverId);
            const validTargetId = this.validateDiscordId(targetId);
            if (!validGuildId || !validGiverId || !validTargetId || validGiverId === validTargetId) {
                return { ok: false, code: 'invalid_input' };
            }

            const now = Date.now();
            const safeCooldownMs = Math.max(60_000, Math.min(7 * 24 * 60 * 60 * 1000, Number(options.cooldownMs) || 12 * 60 * 60 * 1000));
            const safeDailyLimit = Math.max(1, Math.min(100, Number(options.dailyLimit) || 3));
            const safeReason = this.validateTextInput(options.reason, 160);

            const dayStart = new Date(now);
            dayStart.setUTCHours(0, 0, 0, 0);

            const dailyRows = await this.connection.query(
                `SELECT COUNT(*) AS grant_count
                 FROM reputation_grants
                 WHERE guild_id = ? AND giver_id = ? AND created_at >= ?`,
                [validGuildId, validGiverId, dayStart]
            );

            const dailyCount = Number(dailyRows?.[0]?.grant_count || 0);
            if (dailyCount >= safeDailyLimit) {
                return {
                    ok: false,
                    code: 'daily_limit',
                    dailyLimit: safeDailyLimit,
                    grantsToday: dailyCount
                };
            }

            const pairRows = await this.connection.query(
                `SELECT UNIX_TIMESTAMP(created_at) AS created_unix
                 FROM reputation_grants
                 WHERE guild_id = ? AND giver_id = ? AND target_id = ?
                 ORDER BY id DESC
                 LIMIT 1`,
                [validGuildId, validGiverId, validTargetId]
            );

            const lastGivenUnix = Number(pairRows?.[0]?.created_unix || 0);
            if (lastGivenUnix > 0) {
                const lastGivenAtMs = lastGivenUnix * 1000;
                const elapsedMs = now - lastGivenAtMs;
                if (elapsedMs < safeCooldownMs) {
                    return {
                        ok: false,
                        code: 'cooldown',
                        retryAfterMs: safeCooldownMs - elapsedMs
                    };
                }
            }

            await this.connection.query(
                `INSERT INTO reputation_grants (guild_id, giver_id, target_id, reason)
                 VALUES (?, ?, ?, ?)`,
                [validGuildId, validGiverId, validTargetId, safeReason]
            );

            await this.connection.query(
                `INSERT INTO reputation_points (guild_id, user_id, points)
                 VALUES (?, ?, 1)
                 ON DUPLICATE KEY UPDATE points = points + 1, updated_at = CURRENT_TIMESTAMP`,
                [validGuildId, validTargetId]
            );

            const totalRep = await this.getReputation(validGuildId, validTargetId);
            return {
                ok: true,
                totalRep,
                grantsToday: dailyCount + 1,
                dailyLimit: safeDailyLimit,
                reason: safeReason
            };
        } catch (error) {
            console.error('Error giving reputation point:', error);
            return { ok: false, code: 'db_error' };
        }
    }

    async getReputationLeaderboard(guildId, limit = 10, timeframe = 'all') {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            if (!validGuildId) return [];

            const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
            let rows = [];

            if (timeframe === 'week' || timeframe === 'month') {
                const startDate = new Date();
                startDate.setUTCDate(startDate.getUTCDate() - (timeframe === 'week' ? 7 : 30));

                rows = await this.connection.query(
                    `SELECT target_id AS user_id, COUNT(*) AS points
                     FROM reputation_grants
                     WHERE guild_id = ? AND created_at >= ?
                     GROUP BY target_id
                     ORDER BY points DESC, target_id ASC
                     LIMIT ?`,
                    [validGuildId, startDate, safeLimit]
                );
            } else {
                rows = await this.connection.query(
                    `SELECT user_id, points
                     FROM reputation_points
                     WHERE guild_id = ?
                     ORDER BY points DESC, updated_at ASC
                     LIMIT ?`,
                    [validGuildId, safeLimit]
                );
            }

            return (rows || []).map(row => ({
                user_id: String(row.user_id),
                points: Number(row.points || 0)
            }));
        } catch (error) {
            console.error('Error getting reputation leaderboard:', error);
            return [];
        }
    }

    async getReputationRank(guildId, userId, timeframe = 'all') {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            if (!validGuildId || !validUserId) return null;

            let points = 0;
            let rows = [];

            if (timeframe === 'week' || timeframe === 'month') {
                const startDate = new Date();
                startDate.setUTCDate(startDate.getUTCDate() - (timeframe === 'week' ? 7 : 30));

                const pointRows = await this.connection.query(
                    `SELECT COUNT(*) AS points
                     FROM reputation_grants
                     WHERE guild_id = ? AND target_id = ? AND created_at >= ?`,
                    [validGuildId, validUserId, startDate]
                );
                points = Number(pointRows?.[0]?.points || 0);
                if (points <= 0) return null;

                rows = await this.connection.query(
                    `SELECT COUNT(*) AS higher_count
                     FROM (
                        SELECT target_id, COUNT(*) AS total_points
                        FROM reputation_grants
                        WHERE guild_id = ? AND created_at >= ?
                        GROUP BY target_id
                     ) ranked
                     WHERE total_points > ?`,
                    [validGuildId, startDate, points]
                );
            } else {
                points = await this.getReputation(validGuildId, validUserId);
                if (points <= 0) return null;

                rows = await this.connection.query(
                    `SELECT COUNT(*) AS higher_count
                     FROM reputation_points
                     WHERE guild_id = ? AND points > ?`,
                    [validGuildId, points]
                );
            }

            const higherCount = Number(rows?.[0]?.higher_count || 0);
            return {
                points,
                rank: higherCount + 1
            };
        } catch (error) {
            console.error('Error getting reputation rank:', error);
            return null;
        }
    }

    async getReputationProfile(guildId, userId) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            if (!validGuildId || !validUserId) return null;

            const dayStart = new Date();
            dayStart.setUTCHours(0, 0, 0, 0);

            const [points, rankInfo, receivedRows, givenRows, receivedTodayRows, givenTodayRows, lastReceivedRows, lastGivenRows, recentReasonRows] = await Promise.all([
                this.getReputation(validGuildId, validUserId),
                this.getReputationRank(validGuildId, validUserId),
                this.connection.query(
                    `SELECT COUNT(*) AS total
                     FROM reputation_grants
                     WHERE guild_id = ? AND target_id = ?`,
                    [validGuildId, validUserId]
                ),
                this.connection.query(
                    `SELECT COUNT(*) AS total
                     FROM reputation_grants
                     WHERE guild_id = ? AND giver_id = ?`,
                    [validGuildId, validUserId]
                ),
                this.connection.query(
                    `SELECT COUNT(*) AS total
                     FROM reputation_grants
                     WHERE guild_id = ? AND target_id = ? AND created_at >= ?`,
                    [validGuildId, validUserId, dayStart]
                ),
                this.connection.query(
                    `SELECT COUNT(*) AS total
                     FROM reputation_grants
                     WHERE guild_id = ? AND giver_id = ? AND created_at >= ?`,
                    [validGuildId, validUserId, dayStart]
                ),
                this.connection.query(
                    `SELECT UNIX_TIMESTAMP(MAX(created_at)) AS created_unix
                     FROM reputation_grants
                     WHERE guild_id = ? AND target_id = ?`,
                    [validGuildId, validUserId]
                ),
                this.connection.query(
                    `SELECT UNIX_TIMESTAMP(MAX(created_at)) AS created_unix
                     FROM reputation_grants
                     WHERE guild_id = ? AND giver_id = ?`,
                    [validGuildId, validUserId]
                ),
                this.connection.query(
                    `SELECT giver_id, reason, UNIX_TIMESTAMP(created_at) AS created_unix
                     FROM reputation_grants
                     WHERE guild_id = ? AND target_id = ?
                     ORDER BY id DESC
                     LIMIT 3`,
                    [validGuildId, validUserId]
                )
            ]);

            return {
                points: Number(points || 0),
                rank: Number(rankInfo?.rank || 0) || null,
                receivedCount: Number(receivedRows?.[0]?.total || 0),
                givenCount: Number(givenRows?.[0]?.total || 0),
                receivedToday: Number(receivedTodayRows?.[0]?.total || 0),
                givenToday: Number(givenTodayRows?.[0]?.total || 0),
                lastReceivedAt: Number(lastReceivedRows?.[0]?.created_unix || 0) > 0
                    ? new Date(Number(lastReceivedRows[0].created_unix) * 1000)
                    : null,
                lastGivenAt: Number(lastGivenRows?.[0]?.created_unix || 0) > 0
                    ? new Date(Number(lastGivenRows[0].created_unix) * 1000)
                    : null,
                recentReasons: (recentReasonRows || []).map((row) => ({
                    giverId: String(row.giver_id),
                    reason: this.validateTextInput(row.reason, 160) || null,
                    createdAt: Number(row.created_unix || 0) > 0 ? new Date(Number(row.created_unix) * 1000) : null
                }))
            };
        } catch (error) {
            console.error('Error getting reputation profile:', error);
            return null;
        }
    }

    async getReputationServerStats(guildId) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            if (!validGuildId) return null;

            const dayStart = new Date();
            dayStart.setUTCHours(0, 0, 0, 0);

            const [summaryRows, totalGrantsRows, todayRows, topReceiverRows, topGiverRows] = await Promise.all([
                this.connection.query(
                    `SELECT COUNT(*) AS tracked_users, COALESCE(SUM(points), 0) AS total_points
                     FROM reputation_points
                     WHERE guild_id = ?`,
                    [validGuildId]
                ),
                this.connection.query(
                    `SELECT COUNT(*) AS total_grants
                     FROM reputation_grants
                     WHERE guild_id = ?`,
                    [validGuildId]
                ),
                this.connection.query(
                    `SELECT COUNT(*) AS total_grants_today
                     FROM reputation_grants
                     WHERE guild_id = ? AND created_at >= ?`,
                    [validGuildId, dayStart]
                ),
                this.connection.query(
                    `SELECT target_id AS user_id, COUNT(*) AS total
                     FROM reputation_grants
                     WHERE guild_id = ?
                     GROUP BY target_id
                     ORDER BY total DESC, target_id ASC
                     LIMIT 1`,
                    [validGuildId]
                ),
                this.connection.query(
                    `SELECT giver_id AS user_id, COUNT(*) AS total
                     FROM reputation_grants
                     WHERE guild_id = ?
                     GROUP BY giver_id
                     ORDER BY total DESC, giver_id ASC
                     LIMIT 1`,
                    [validGuildId]
                )
            ]);

            return {
                trackedUsers: Number(summaryRows?.[0]?.tracked_users || 0),
                totalPoints: Number(summaryRows?.[0]?.total_points || 0),
                totalGrants: Number(totalGrantsRows?.[0]?.total_grants || 0),
                grantsToday: Number(todayRows?.[0]?.total_grants_today || 0),
                topReceiver: topReceiverRows?.[0]
                    ? {
                        userId: String(topReceiverRows[0].user_id),
                        total: Number(topReceiverRows[0].total || 0)
                    }
                    : null,
                topGiver: topGiverRows?.[0]
                    ? {
                        userId: String(topGiverRows[0].user_id),
                        total: Number(topGiverRows[0].total || 0)
                    }
                    : null
            };
        } catch (error) {
            console.error('Error getting reputation server stats:', error);
            return null;
        }
    }



    async ensureEconomyProfile(guildId, userId) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            if (!validGuildId || !validUserId) return false;

            await this.connection.query(
                `INSERT INTO economy_balances (guild_id, user_id)
                 VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE updated_at = updated_at`,
                [validGuildId, validUserId]
            );

            return true;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error ensuring economy profile:', error.message);
            return false;
        }
    }

    async getEconomyBalance(guildId, userId) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            if (!validGuildId || !validUserId) {
                return { wallet: 0, bank: 0, total: 0, totalEarned: 0, totalSpent: 0 };
            }

            await this.ensureEconomyProfile(validGuildId, validUserId);

            const rows = await this.connection.query(
                `SELECT wallet, bank, total_earned, total_spent
                 FROM economy_balances
                 WHERE guild_id = ? AND user_id = ?
                 LIMIT 1`,
                [validGuildId, validUserId]
            );

            const wallet = Number(rows?.[0]?.wallet || 0);
            const bank = Number(rows?.[0]?.bank || 0);
            const totalEarned = Number(rows?.[0]?.total_earned || 0);
            const totalSpent = Number(rows?.[0]?.total_spent || 0);

            return {
                wallet,
                bank,
                total: wallet + bank,
                totalEarned,
                totalSpent
            };
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error getting economy balance:', error.message);
            return { wallet: 0, bank: 0, total: 0, totalEarned: 0, totalSpent: 0 };
        }
    }

    async listEconomyGuilds() {
        try {
            const rows = await this.connection.query(
                `SELECT DISTINCT guild_id FROM economy_balances`
            );
            return Array.isArray(rows)
                ? rows.map((row) => String(row.guild_id)).filter(Boolean)
                : [];
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error listing economy guilds:', error.message);
            return [];
        }
    }

    async applyBankInterest(guildId) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            if (!validGuildId) return { ok: false, code: 'invalid_guild' };

            const config = economyConfigFile?.bankInterest || {};
            if (config.enabled === false) return { ok: false, code: 'disabled' };

            const minBalance = Math.max(0, Number(config.minBalance) || 0);
            const maxInterest = Math.max(0, Number(config.maxInterestPerRun) || 0);
            const tiers = Array.isArray(config.tiers) ? config.tiers : [];
            if (!tiers.length) return { ok: false, code: 'no_tiers' };

            const runDate = this.getEconomyDateKey();
            const existing = await this.connection.query(
                `SELECT id FROM economy_interest_runs WHERE guild_id = ? AND run_date = ? LIMIT 1`,
                [validGuildId, runDate]
            );
            if (existing?.length) return { ok: false, code: 'already_run' };

            await this.connection.query(
                `INSERT INTO economy_interest_runs (guild_id, run_date) VALUES (?, ?)`,
                [validGuildId, runDate]
            );

            const rows = await this.connection.query(
                `SELECT user_id, bank
                 FROM economy_balances
                 WHERE guild_id = ? AND bank >= ?`,
                [validGuildId, minBalance]
            );

            const sortedTiers = [...tiers]
                .map((tier) => ({
                    min: Math.max(0, Number(tier.min) || 0),
                    rate: Math.max(0, Number(tier.rate) || 0)
                }))
                .sort((a, b) => a.min - b.min);

            let totalPaid = 0;
            let paidCount = 0;

            for (const row of rows || []) {
                const bank = Number(row.bank || 0);
                if (bank <= 0) continue;

                let rate = 0;
                for (const tier of sortedTiers) {
                    if (bank >= tier.min) {
                        rate = tier.rate;
                    }
                }

                const rawInterest = Math.floor(bank * rate);
                const interest = maxInterest > 0 ? Math.min(maxInterest, rawInterest) : rawInterest;
                if (interest <= 0) continue;

                await this.connection.query(
                    `UPDATE economy_balances
                     SET bank = bank + ?, total_earned = total_earned + ?, updated_at = CURRENT_TIMESTAMP
                     WHERE guild_id = ? AND user_id = ?`,
                    [interest, interest, validGuildId, row.user_id]
                );

                const ratePercent = Math.round(rate * 10000) / 100;
                await this.connection.query(
                    `INSERT INTO economy_transactions (guild_id, user_id, tx_type, amount, note)
                     VALUES (?, ?, 'bank_interest', ?, ?)`,
                    [validGuildId, row.user_id, interest, `Bank interest (${ratePercent}% rate)`]
                );

                totalPaid += interest;
                paidCount += 1;
            }

            return { ok: true, paidCount, totalPaid };
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error applying bank interest:', error.message);
            return { ok: false, code: 'db_error' };
        }
    }

    async recordEconomyFraudFlag(guildId, userId, flagType, details = {}, severity = 'medium') {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            const safeType = this.validateTextInput(String(flagType || ''), 40);
            const safeSeverity = ['low', 'medium', 'high'].includes(String(severity)) ? String(severity) : 'medium';
            if (!validGuildId || !validUserId || !safeType) return false;

            const cooldownMs = Math.max(0, Number(economyConfigFile?.fraud?.flagCooldownMs) || 0);
            if (cooldownMs > 0) {
                const rows = await this.connection.query(
                    `SELECT UNIX_TIMESTAMP(created_at) AS created_unix
                     FROM economy_fraud_flags
                     WHERE guild_id = ? AND user_id = ? AND flag_type = ?
                     ORDER BY id DESC
                     LIMIT 1`,
                    [validGuildId, validUserId, safeType]
                );

                const lastUnix = Number(rows?.[0]?.created_unix || 0);
                if (lastUnix > 0 && (Date.now() - (lastUnix * 1000)) < cooldownMs) {
                    return false;
                }
            }

            await this.connection.query(
                `INSERT INTO economy_fraud_flags (guild_id, user_id, flag_type, severity, details)
                 VALUES (?, ?, ?, ?, ?)`,
                [validGuildId, validUserId, safeType, safeSeverity, JSON.stringify(details || {})]
            );

            return true;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error recording economy fraud flag:', error.message);
            return false;
        }
    }

    async checkEconomyTransferFraud(guildId, fromUserId, toUserId, amount) {
        try {
            const config = economyConfigFile?.fraud || {};
            if (config.enabled === false) return;

            const validGuildId = this.validateDiscordId(guildId);
            const validFrom = this.validateDiscordId(fromUserId);
            const validTo = this.validateDiscordId(toUserId);
            const safeAmount = Math.max(0, Number(amount) || 0);
            if (!validGuildId || !validFrom || !validTo || !safeAmount) return;

            const largeThreshold = Math.max(1, Number(config.largeTransferAmount) || 0);
            if (largeThreshold > 0 && safeAmount >= largeThreshold) {
                await this.recordEconomyFraudFlag(validGuildId, validFrom, 'large_transfer', {
                    amount: safeAmount,
                    targetUserId: validTo
                }, 'high');
            }

            const windowMs = Math.max(60 * 1000, Number(config.rapidTransferWindowMs) || 0);
            const countThreshold = Math.max(2, Number(config.rapidTransferCount) || 0);
            if (windowMs > 0 && countThreshold > 0) {
                const windowSeconds = Math.max(60, Math.floor(windowMs / 1000));
                const rows = await this.connection.query(
                    `SELECT COUNT(*) AS tx_count
                     FROM economy_transactions
                     WHERE guild_id = ? AND user_id = ? AND tx_type = 'transfer_out'
                       AND created_at >= (NOW() - INTERVAL ? SECOND)`,
                    [validGuildId, validFrom, windowSeconds]
                );

                const txCount = Number(rows?.[0]?.tx_count || 0);
                if (txCount >= countThreshold) {
                    await this.recordEconomyFraudFlag(validGuildId, validFrom, 'rapid_transfers', {
                        windowSeconds,
                        txCount
                    }, 'medium');
                }
            }
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error checking economy fraud signals:', error.message);
        }
    }

    async getLastEconomyTransaction(guildId, userId, txType) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            const safeType = this.validateTextInput(String(txType || ''), 40);
            if (!validGuildId || !validUserId || !safeType) return null;

            const rows = await this.connection.query(
                `SELECT UNIX_TIMESTAMP(created_at) AS created_unix
                 FROM economy_transactions
                 WHERE guild_id = ? AND user_id = ? AND tx_type = ?
                 ORDER BY id DESC
                 LIMIT 1`,
                [validGuildId, validUserId, safeType]
            );

            const unix = Number(rows?.[0]?.created_unix || 0);
            return unix > 0 ? unix * 1000 : null;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error getting last economy transaction:', error.message);
            return null;
        }
    }

    async claimEconomyReward(guildId, userId, options = {}) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            if (!validGuildId || !validUserId) return { ok: false, code: 'invalid_input' };

            const rewardType = this.validateTextInput(String(options.rewardType || ''), 40);
            if (!rewardType) return { ok: false, code: 'invalid_type' };

            const minReward = Math.max(1, Math.min(1_000_000, Number(options.minReward) || 50));
            const maxReward = Math.max(minReward, Math.min(5_000_000, Number(options.maxReward) || 150));
            const cooldownMs = Math.max(60_000, Math.min(7 * 24 * 60 * 60 * 1000, Number(options.cooldownMs) || 60 * 60 * 1000));
            const now = Date.now();

            const lastClaimMs = await this.getLastEconomyTransaction(validGuildId, validUserId, rewardType);
            if (lastClaimMs && (now - lastClaimMs) < cooldownMs) {
                return {
                    ok: false,
                    code: 'cooldown',
                    retryAfterMs: cooldownMs - (now - lastClaimMs)
                };
            }

            const amount = Math.floor(Math.random() * (maxReward - minReward + 1)) + minReward;

            await this.ensureEconomyProfile(validGuildId, validUserId);

            await this.connection.query(
                `UPDATE economy_balances
                 SET wallet = wallet + ?, total_earned = total_earned + ?, updated_at = CURRENT_TIMESTAMP
                 WHERE guild_id = ? AND user_id = ?`,
                [amount, amount, validGuildId, validUserId]
            );

            await this.connection.query(
                `INSERT INTO economy_transactions (guild_id, user_id, tx_type, amount, note)
                 VALUES (?, ?, ?, ?, ?)`,
                [validGuildId, validUserId, rewardType, amount, options.note || null]
            );

            const balance = await this.getEconomyBalance(validGuildId, validUserId);

            return {
                ok: true,
                amount,
                balance
            };
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error claiming economy reward:', error.message);
            return { ok: false, code: 'db_error' };
        }
    }

    async awardEconomyActivity(guildId, userId, amount, options = {}) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            const safeAmount = Math.max(1, Math.min(250_000, Number(amount) || 0));

            if (!validGuildId || !validUserId || !safeAmount) {
                return { ok: false, code: 'invalid_input' };
            }

            const txType = this.validateTextInput(String(options.txType || 'activity_reward'), 40) || 'activity_reward';
            const note = this.validateTextInput(String(options.note || 'Message activity reward'), 255);

            await this.ensureEconomyProfile(validGuildId, validUserId);

            await this.connection.query(
                `UPDATE economy_balances
                 SET wallet = wallet + ?, total_earned = total_earned + ?, updated_at = CURRENT_TIMESTAMP
                 WHERE guild_id = ? AND user_id = ?`,
                [safeAmount, safeAmount, validGuildId, validUserId]
            );

            await this.connection.query(
                `INSERT INTO economy_transactions (guild_id, user_id, tx_type, amount, note)
                 VALUES (?, ?, ?, ?, ?)`,
                [validGuildId, validUserId, txType, safeAmount, note || null]
            );

            const balance = await this.getEconomyBalance(validGuildId, validUserId);
            return { ok: true, amount: safeAmount, balance };
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error awarding economy activity:', error.message);
            return { ok: false, code: 'db_error' };
        }
    }

    async getEconomyStats(guildId, userId, options = {}) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            if (!validGuildId || !validUserId) return null;

            const txLimit = Math.max(5, Math.min(100, Number(options.recentTxLimit) || 25));
            const daysWindow = Math.max(1, Math.min(90, Number(options.daysWindow) || 7));

            const [recentRows, totalsRows, flowRows, typeRows, streakRows, weeklyRows] = await Promise.all([
                this.connection.query(
                    `SELECT tx_type, amount, UNIX_TIMESTAMP(created_at) AS created_unix
                     FROM economy_transactions
                     WHERE guild_id = ? AND user_id = ?
                     ORDER BY id DESC
                     LIMIT ?`,
                    [validGuildId, validUserId, txLimit]
                ),
                this.connection.query(
                    `SELECT COUNT(*) AS tx_count,
                            SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS total_in,
                            SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) AS total_out
                     FROM economy_transactions
                     WHERE guild_id = ? AND user_id = ?`,
                    [validGuildId, validUserId]
                ),
                this.connection.query(
                    `SELECT SUM(amount) AS net_flow
                     FROM economy_transactions
                     WHERE guild_id = ? AND user_id = ?
                       AND created_at >= (NOW() - INTERVAL ? DAY)`,
                    [validGuildId, validUserId, daysWindow]
                ),
                this.connection.query(
                    `SELECT tx_type, COUNT(*) AS tx_count
                     FROM economy_transactions
                     WHERE guild_id = ? AND user_id = ?
                     GROUP BY tx_type
                     ORDER BY tx_count DESC
                     LIMIT 5`,
                    [validGuildId, validUserId]
                ),
                this.connection.query(
                    `SELECT DATE(created_at) AS claim_date
                     FROM economy_transactions
                     WHERE guild_id = ? AND user_id = ? AND tx_type = 'daily_reward'
                     GROUP BY DATE(created_at)
                     ORDER BY claim_date DESC
                     LIMIT 90`,
                    [validGuildId, validUserId]
                ),
                this.connection.query(
                    `SELECT DATE(created_at) AS claim_date
                     FROM economy_transactions
                     WHERE guild_id = ? AND user_id = ? AND tx_type = 'weekly_reward'
                     GROUP BY DATE(created_at)
                     ORDER BY claim_date DESC
                     LIMIT 52`,
                    [validGuildId, validUserId]
                )
            ]);

            const totals = totalsRows?.[0] || {};
            const flow = flowRows?.[0] || {};

            const dailyDates = Array.isArray(streakRows)
                ? streakRows
                    .map((row) => row?.claim_date ? new Date(row.claim_date) : null)
                    .filter(Boolean)
                    .map((date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).getTime())
                : [];

            const oneDayMs = 24 * 60 * 60 * 1000;
            const today = new Date();
            const todayUtcMidnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
            const yesterdayUtcMidnight = todayUtcMidnight - oneDayMs;

            let currentStreak = 0;
            if (dailyDates.length > 0 && (dailyDates[0] === todayUtcMidnight || dailyDates[0] === yesterdayUtcMidnight)) {
                currentStreak = 1;
                for (let i = 1; i < dailyDates.length; i++) {
                    if (dailyDates[i] === dailyDates[i - 1] - oneDayMs) {
                        currentStreak++;
                    } else {
                        break;
                    }
                }
            }

            let bestStreak = 0;
            let runningStreak = 0;
            for (let i = 0; i < dailyDates.length; i++) {
                if (i === 0) {
                    runningStreak = 1;
                } else if (dailyDates[i] === dailyDates[i - 1] - oneDayMs) {
                    runningStreak++;
                } else {
                    runningStreak = 1;
                }
                if (runningStreak > bestStreak) bestStreak = runningStreak;
            }

            const weeklyDates = Array.isArray(weeklyRows)
                ? weeklyRows
                    .map((row) => row?.claim_date ? new Date(row.claim_date) : null)
                    .filter(Boolean)
                    .map((date) => {
                        const day = date.getUTCDay();
                        const diff = (day + 6) % 7;
                        const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
                        start.setUTCDate(start.getUTCDate() - diff);
                        return start.getTime();
                    })
                : [];

            const oneWeekMs = 7 * oneDayMs;
            const todayWeekStart = (() => {
                const now = new Date();
                const day = now.getUTCDay();
                const diff = (day + 6) % 7;
                const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
                start.setUTCDate(start.getUTCDate() - diff);
                return start.getTime();
            })();

            let currentWeeklyStreak = 0;
            if (weeklyDates.length > 0 && (weeklyDates[0] === todayWeekStart || weeklyDates[0] === todayWeekStart - oneWeekMs)) {
                currentWeeklyStreak = 1;
                for (let i = 1; i < weeklyDates.length; i++) {
                    if (weeklyDates[i] === weeklyDates[i - 1] - oneWeekMs) {
                        currentWeeklyStreak++;
                    } else {
                        break;
                    }
                }
            }

            let bestWeeklyStreak = 0;
            let runningWeekly = 0;
            for (let i = 0; i < weeklyDates.length; i++) {
                if (i === 0) {
                    runningWeekly = 1;
                } else if (weeklyDates[i] === weeklyDates[i - 1] - oneWeekMs) {
                    runningWeekly++;
                } else {
                    runningWeekly = 1;
                }
                if (runningWeekly > bestWeeklyStreak) bestWeeklyStreak = runningWeekly;
            }

            return {
                txCount: Number(totals.tx_count || 0),
                totalIn: Number(totals.total_in || 0),
                totalOut: Number(totals.total_out || 0),
                netFlowWindow: Number(flow.net_flow || 0),
                netFlowWindowDays: daysWindow,
                topTypes: (typeRows || []).map((row) => ({
                    type: String(row.tx_type || 'unknown'),
                    count: Number(row.tx_count || 0)
                })),
                currentDailyStreak: currentStreak,
                bestDailyStreak: bestStreak,
                currentWeeklyStreak,
                bestWeeklyStreak,
                recentTransactions: (recentRows || []).map((row) => ({
                    type: String(row.tx_type || 'unknown'),
                    amount: Number(row.amount || 0),
                    createdAtMs: Number(row.created_unix || 0) * 1000
                }))
            };
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error getting economy stats:', error.message);
            return null;
        }
    }

    getEconomyDateKey(date = new Date()) {
        const safeDate = date instanceof Date ? date : new Date();
        const year = safeDate.getUTCFullYear();
        const month = String(safeDate.getUTCMonth() + 1).padStart(2, '0');
        const day = String(safeDate.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    getEconomyWeekStartKey(date = new Date()) {
        const safeDate = date instanceof Date ? date : new Date();
        const day = safeDate.getUTCDay();
        const diff = (day + 6) % 7;
        const start = new Date(Date.UTC(safeDate.getUTCFullYear(), safeDate.getUTCMonth(), safeDate.getUTCDate()));
        start.setUTCDate(start.getUTCDate() - diff);
        return this.getEconomyDateKey(start);
    }

    async getEconomyClaimDates(guildId, userId, txType, limit = 90) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            const safeType = this.validateTextInput(String(txType || ''), 40);
            const safeLimit = Math.max(1, Math.min(180, Number(limit) || 90));
            if (!validGuildId || !validUserId || !safeType) return [];

            const rows = await this.connection.query(
                `SELECT DATE(created_at) AS claim_date
                 FROM economy_transactions
                 WHERE guild_id = ? AND user_id = ? AND tx_type = ?
                 GROUP BY DATE(created_at)
                 ORDER BY claim_date DESC
                 LIMIT ?`,
                [validGuildId, validUserId, safeType, safeLimit]
            );

            return Array.isArray(rows)
                ? rows
                    .map((row) => row?.claim_date ? new Date(row.claim_date) : null)
                    .filter(Boolean)
                    .map((date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).getTime())
                : [];
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error getting economy claim dates:', error.message);
            return [];
        }
    }

    getEconomyQuestDefinitions(cadence) {
        const quests = economyConfigFile?.quests || {};
        const list = cadence === 'weekly' ? quests.weekly : quests.daily;
        return Array.isArray(list) ? list : [];
    }

    async getEconomyQuestProgress(guildId, userId, cadence) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            if (!validGuildId || !validUserId) return [];

            const safeCadence = cadence === 'weekly' ? 'weekly' : 'daily';
            const periodStart = safeCadence === 'weekly'
                ? this.getEconomyWeekStartKey()
                : this.getEconomyDateKey();

            return await this.connection.query(
                `SELECT quest_key, progress, completed_at, claimed_at
                 FROM economy_quest_progress
                 WHERE guild_id = ? AND user_id = ? AND cadence = ? AND period_start = ?`,
                [validGuildId, validUserId, safeCadence, periodStart]
            );
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error getting economy quest progress:', error.message);
            return [];
        }
    }

    async updateEconomyQuestProgress(guildId, userId, eventType, amount = 1) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            const safeType = this.validateTextInput(String(eventType || ''), 40);
            if (!validGuildId || !validUserId || !safeType) return false;

            const targetAmount = Math.max(1, Number(amount) || 1);
            const cadences = ['daily', 'weekly'];
            const now = new Date();

            for (const cadence of cadences) {
                const quests = this.getEconomyQuestDefinitions(cadence);
                if (!quests.length) continue;

                const periodStart = cadence === 'weekly'
                    ? this.getEconomyWeekStartKey(now)
                    : this.getEconomyDateKey(now);

                for (const quest of quests) {
                    if (!quest || quest.type !== safeType) continue;
                    const questKey = this.validateTextInput(String(quest.key || ''), 50);
                    if (!questKey) continue;

                    const increment = ['gamble_wager', 'pay_amount'].includes(safeType)
                        ? targetAmount
                        : 1;
                    const target = Math.max(1, Number(quest.target) || 1);

                    const rows = await this.connection.query(
                        `SELECT progress, completed_at
                         FROM economy_quest_progress
                         WHERE guild_id = ? AND user_id = ? AND quest_key = ? AND cadence = ? AND period_start = ?
                         LIMIT 1`,
                        [validGuildId, validUserId, questKey, cadence, periodStart]
                    );

                    const currentProgress = Number(rows?.[0]?.progress || 0);
                    const newProgress = Math.min(target, currentProgress + increment);
                    const completedAt = rows?.[0]?.completed_at || (newProgress >= target ? new Date() : null);

                    if (rows?.length) {
                        await this.connection.query(
                            `UPDATE economy_quest_progress
                             SET progress = ?, completed_at = COALESCE(?, completed_at), updated_at = CURRENT_TIMESTAMP
                             WHERE guild_id = ? AND user_id = ? AND quest_key = ? AND cadence = ? AND period_start = ?`,
                            [newProgress, completedAt, validGuildId, validUserId, questKey, cadence, periodStart]
                        );
                    } else {
                        await this.connection.query(
                            `INSERT INTO economy_quest_progress (guild_id, user_id, quest_key, cadence, period_start, progress, completed_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`,
                            [validGuildId, validUserId, questKey, cadence, periodStart, newProgress, completedAt]
                        );
                    }
                }
            }

            return true;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error updating economy quest progress:', error.message);
            return false;
        }
    }

    async claimEconomyQuest(guildId, userId, questKey) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            const safeKey = this.validateTextInput(String(questKey || ''), 50);
            if (!validGuildId || !validUserId || !safeKey) return { ok: false, code: 'invalid_input' };

            const dailyQuest = this.getEconomyQuestDefinitions('daily').find((quest) => quest.key === safeKey);
            const weeklyQuest = this.getEconomyQuestDefinitions('weekly').find((quest) => quest.key === safeKey);
            const quest = dailyQuest || weeklyQuest;
            if (!quest) return { ok: false, code: 'unknown_quest' };

            const cadence = dailyQuest ? 'daily' : 'weekly';
            const periodStart = cadence === 'weekly'
                ? this.getEconomyWeekStartKey()
                : this.getEconomyDateKey();
            const target = Math.max(1, Number(quest.target) || 1);
            const reward = Math.max(1, Number(quest.reward) || 1);

            const rows = await this.connection.query(
                `SELECT progress, claimed_at
                 FROM economy_quest_progress
                 WHERE guild_id = ? AND user_id = ? AND quest_key = ? AND cadence = ? AND period_start = ?
                 LIMIT 1`,
                [validGuildId, validUserId, safeKey, cadence, periodStart]
            );

            const progress = Number(rows?.[0]?.progress || 0);
            const claimedAt = rows?.[0]?.claimed_at || null;

            if (claimedAt) return { ok: false, code: 'already_claimed' };
            if (progress < target) return { ok: false, code: 'incomplete' };

            await this.ensureEconomyProfile(validGuildId, validUserId);

            await this.connection.query(
                `UPDATE economy_balances
                 SET wallet = wallet + ?, total_earned = total_earned + ?, updated_at = CURRENT_TIMESTAMP
                 WHERE guild_id = ? AND user_id = ?`,
                [reward, reward, validGuildId, validUserId]
            );

            await this.connection.query(
                `INSERT INTO economy_transactions (guild_id, user_id, tx_type, amount, note)
                 VALUES (?, ?, 'quest_reward', ?, ?)`,
                [validGuildId, validUserId, reward, `Quest reward: ${safeKey}`]
            );

            await this.connection.query(
                `UPDATE economy_quest_progress
                 SET claimed_at = CURRENT_TIMESTAMP
                 WHERE guild_id = ? AND user_id = ? AND quest_key = ? AND cadence = ? AND period_start = ?`,
                [validGuildId, validUserId, safeKey, cadence, periodStart]
            );

            const balance = await this.getEconomyBalance(validGuildId, validUserId);
            return { ok: true, reward, balance };
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error claiming economy quest:', error.message);
            return { ok: false, code: 'db_error' };
        }
    }

    async getEconomyInventory(guildId, userId) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            if (!validGuildId || !validUserId) return [];

            return await this.connection.query(
                `SELECT item_id, quantity
                 FROM economy_inventory
                 WHERE guild_id = ? AND user_id = ? AND quantity > 0`,
                [validGuildId, validUserId]
            );
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error getting economy inventory:', error.message);
            return [];
        }
    }

    async addEconomyInventoryItem(guildId, userId, itemId, quantity) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            const safeItemId = this.validateTextInput(String(itemId || ''), 50);
            const safeQuantity = Math.max(1, Math.min(1000, Number(quantity) || 1));
            if (!validGuildId || !validUserId || !safeItemId) return false;

            await this.connection.query(
                `INSERT INTO economy_inventory (guild_id, user_id, item_id, quantity)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity), updated_at = CURRENT_TIMESTAMP`,
                [validGuildId, validUserId, safeItemId, safeQuantity]
            );

            return true;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error adding economy inventory item:', error.message);
            return false;
        }
    }

    async consumeEconomyInventoryItem(guildId, userId, itemId, quantity) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            const safeItemId = this.validateTextInput(String(itemId || ''), 50);
            const safeQuantity = Math.max(1, Math.min(1000, Number(quantity) || 1));
            if (!validGuildId || !validUserId || !safeItemId) return { ok: false, code: 'invalid_input' };

            const rows = await this.connection.query(
                `SELECT quantity
                 FROM economy_inventory
                 WHERE guild_id = ? AND user_id = ? AND item_id = ?
                 LIMIT 1`,
                [validGuildId, validUserId, safeItemId]
            );

            const currentQty = Number(rows?.[0]?.quantity || 0);
            if (currentQty < safeQuantity) return { ok: false, code: 'insufficient_items', available: currentQty };

            await this.connection.query(
                `UPDATE economy_inventory
                 SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP
                 WHERE guild_id = ? AND user_id = ? AND item_id = ?`,
                [safeQuantity, validGuildId, validUserId, safeItemId]
            );

            return { ok: true, remaining: currentQty - safeQuantity };
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error consuming economy inventory item:', error.message);
            return { ok: false, code: 'db_error' };
        }
    }

    async spendEconomyFunds(guildId, userId, amount, txType = 'economy_spend', note = null) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            const safeAmount = Math.max(1, Math.min(100_000_000, Number(amount) || 0));
            const safeType = this.validateTextInput(String(txType || ''), 40) || 'economy_spend';
            const safeNote = this.validateTextInput(String(note || ''), 255) || null;
            if (!validGuildId || !validUserId || !safeAmount) return { ok: false, code: 'invalid_input' };

            const result = await this.connection.transaction(async (conn) => {
                await conn.query(
                    `INSERT INTO economy_balances (guild_id, user_id)
                     VALUES (?, ?)
                     ON DUPLICATE KEY UPDATE updated_at = updated_at`,
                    [validGuildId, validUserId]
                );

                const [debitResult] = await conn.query(
                    `UPDATE economy_balances
                     SET wallet = wallet - ?, total_spent = total_spent + ?, updated_at = CURRENT_TIMESTAMP
                     WHERE guild_id = ? AND user_id = ? AND wallet >= ?`,
                    [safeAmount, safeAmount, validGuildId, validUserId, safeAmount]
                );

                if (!debitResult || Number(debitResult.affectedRows || 0) === 0) {
                    return { ok: false, code: 'insufficient_funds' };
                }

                await conn.query(
                    `INSERT INTO economy_transactions (guild_id, user_id, tx_type, amount, note)
                     VALUES (?, ?, ?, ?, ?)`,
                    [validGuildId, validUserId, safeType, -safeAmount, safeNote]
                );

                return { ok: true };
            });

            if (!result?.ok) return result || { ok: false, code: 'spend_failed' };

            const balance = await this.getEconomyBalance(validGuildId, validUserId);
            return { ok: true, balance, amount: safeAmount };
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error spending economy funds:', error.message);
            return { ok: false, code: 'db_error' };
        }
    }

    async addEconomyBoost(guildId, userId, boostType, multiplier, usesRemaining, expiresAt) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            const safeType = this.validateTextInput(String(boostType || ''), 40);
            const safeMultiplier = Math.max(1, Math.min(10, Number(multiplier) || 1));
            const safeUses = Math.max(1, Math.min(100, Number(usesRemaining) || 1));
            const safeExpires = Math.max(0, Number(expiresAt) || 0);
            if (!validGuildId || !validUserId || !safeType) return false;

            await this.connection.query(
                `INSERT INTO economy_boosts (guild_id, user_id, boost_type, multiplier, uses_remaining, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [validGuildId, validUserId, safeType, safeMultiplier, safeUses, safeExpires]
            );

            return true;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error adding economy boost:', error.message);
            return false;
        }
    }

    async consumeEconomyBoost(guildId, userId, boostType) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            const safeType = this.validateTextInput(String(boostType || ''), 40);
            if (!validGuildId || !validUserId || !safeType) return null;

            const now = Date.now();
            await this.connection.query(
                `DELETE FROM economy_boosts
                 WHERE guild_id = ? AND user_id = ? AND expires_at > 0 AND expires_at < ?`,
                [validGuildId, validUserId, now]
            );

            const rows = await this.connection.query(
                `SELECT id, multiplier, uses_remaining
                 FROM economy_boosts
                 WHERE guild_id = ? AND user_id = ? AND boost_type = ?
                 ORDER BY id ASC
                 LIMIT 1`,
                [validGuildId, validUserId, safeType]
            );

            const row = rows?.[0];
            if (!row) return null;

            const usesRemaining = Math.max(0, Number(row.uses_remaining || 0));
            const nextUses = Math.max(0, usesRemaining - 1);

            if (nextUses <= 0) {
                await this.connection.query(
                    `DELETE FROM economy_boosts WHERE id = ?`,
                    [row.id]
                );
            } else {
                await this.connection.query(
                    `UPDATE economy_boosts SET uses_remaining = ? WHERE id = ?`,
                    [nextUses, row.id]
                );
            }

            return Number(row.multiplier || 1);
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error consuming economy boost:', error.message);
            return null;
        }
    }

    async listEconomyBounties(guildId, status = 'open', limit = 10) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const safeStatus = ['open', 'awarded', 'closed'].includes(status) ? status : 'open';
            const safeLimit = Math.max(1, Math.min(25, Number(limit) || 10));
            if (!validGuildId) return [];

            return await this.connection.query(
                `SELECT * FROM economy_bounties
                 WHERE guild_id = ? AND status = ?
                 ORDER BY created_at DESC
                 LIMIT ?`,
                [validGuildId, safeStatus, safeLimit]
            );
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error listing economy bounties:', error.message);
            return [];
        }
    }

    async createEconomyBounty(guildId, createdBy, title, description, rewardAmount) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validCreator = this.validateDiscordId(createdBy);
            const safeTitle = this.validateTextInput(String(title || ''), 120);
            const safeDescription = this.validateTextInput(String(description || ''), 1000) || null;
            const safeReward = Math.max(1, Math.min(100_000_000, Number(rewardAmount) || 0));
            if (!validGuildId || !validCreator || !safeTitle || !safeReward) return null;

            const result = await this.connection.query(
                `INSERT INTO economy_bounties (guild_id, created_by, title, description, reward_amount)
                 VALUES (?, ?, ?, ?, ?)`,
                [validGuildId, validCreator, safeTitle, safeDescription, safeReward]
            );

            return result?.insertId || null;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error creating economy bounty:', error.message);
            return null;
        }
    }

    async awardEconomyBounty(guildId, bountyId, awardedTo, awardedBy, note = null) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validAwardedTo = this.validateDiscordId(awardedTo);
            const validAwardedBy = this.validateDiscordId(awardedBy);
            const safeId = Number(bountyId);
            const safeNote = this.validateTextInput(String(note || ''), 255) || null;
            if (!validGuildId || !validAwardedTo || !validAwardedBy || !Number.isFinite(safeId) || safeId <= 0) {
                return { ok: false, code: 'invalid_input' };
            }

            const rows = await this.connection.query(
                `SELECT reward_amount, status
                 FROM economy_bounties
                 WHERE bounty_id = ? AND guild_id = ?
                 LIMIT 1`,
                [safeId, validGuildId]
            );

            const bounty = rows?.[0];
            if (!bounty) return { ok: false, code: 'not_found' };
            if (bounty.status !== 'open') return { ok: false, code: 'not_open' };

            const reward = Math.max(1, Number(bounty.reward_amount || 0));
            await this.ensureEconomyProfile(validGuildId, validAwardedTo);

            await this.connection.query(
                `UPDATE economy_balances
                 SET wallet = wallet + ?, total_earned = total_earned + ?, updated_at = CURRENT_TIMESTAMP
                 WHERE guild_id = ? AND user_id = ?`,
                [reward, reward, validGuildId, validAwardedTo]
            );

            await this.connection.query(
                `INSERT INTO economy_transactions (guild_id, user_id, tx_type, amount, note, source_user_id)
                 VALUES (?, ?, 'bounty_reward', ?, ?, ?)`,
                [validGuildId, validAwardedTo, reward, safeNote || `Bounty reward #${safeId}`, validAwardedBy]
            );

            await this.connection.query(
                `UPDATE economy_bounties
                 SET status = 'awarded', awarded_to = ?, awarded_by = ?, awarded_at = CURRENT_TIMESTAMP
                 WHERE bounty_id = ? AND guild_id = ?`,
                [validAwardedTo, validAwardedBy, safeId, validGuildId]
            );

            const balance = await this.getEconomyBalance(validGuildId, validAwardedTo);
            return { ok: true, reward, balance };
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error awarding economy bounty:', error.message);
            return { ok: false, code: 'db_error' };
        }
    }

    async closeEconomyBounty(guildId, bountyId, closedBy, reason = null) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validClosedBy = this.validateDiscordId(closedBy);
            const safeId = Number(bountyId);
            const safeReason = this.validateTextInput(String(reason || ''), 255) || null;
            if (!validGuildId || !validClosedBy || !Number.isFinite(safeId) || safeId <= 0) {
                return { ok: false, code: 'invalid_input' };
            }

            const result = await this.connection.query(
                `UPDATE economy_bounties
                 SET status = 'closed', closed_at = CURRENT_TIMESTAMP, close_reason = ?
                 WHERE bounty_id = ? AND guild_id = ? AND status = 'open'`,
                [safeReason, safeId, validGuildId]
            );

            return { ok: (result?.affectedRows || 0) > 0 };
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error closing economy bounty:', error.message);
            return { ok: false, code: 'db_error' };
        }
    }

    async adminAdjustEconomyBalance(guildId, userId, amount, options = {}) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            const actorId = this.validateDiscordId(options.actorId) || null;
            const scope = ['wallet', 'bank'].includes(String(options.scope || '').toLowerCase())
                ? String(options.scope).toLowerCase()
                : null;
            const mode = ['set', 'add', 'remove'].includes(String(options.mode || '').toLowerCase())
                ? String(options.mode).toLowerCase()
                : null;
            const safeAmount = Math.max(0, Math.min(100_000_000, Number(amount) || 0));
            const reason = this.validateTextInput(String(options.reason || ''), 255) || null;

            if (!validGuildId || !validUserId || !scope || !mode || !Number.isFinite(safeAmount)) {
                return { ok: false, code: 'invalid_input' };
            }

            const result = await this.connection.transaction(async (conn) => {
                await conn.query(
                    `INSERT INTO economy_balances (guild_id, user_id)
                     VALUES (?, ?)
                     ON DUPLICATE KEY UPDATE updated_at = updated_at`,
                    [validGuildId, validUserId]
                );

                const [rows] = await conn.query(
                    `SELECT wallet, bank
                     FROM economy_balances
                     WHERE guild_id = ? AND user_id = ?
                     LIMIT 1`,
                    [validGuildId, validUserId]
                );

                const currentWallet = Number(rows?.[0]?.wallet || 0);
                const currentBank = Number(rows?.[0]?.bank || 0);
                const currentValue = scope === 'wallet' ? currentWallet : currentBank;

                let nextValue = currentValue;
                if (mode === 'set') {
                    nextValue = safeAmount;
                } else if (mode === 'add') {
                    nextValue = currentValue + safeAmount;
                } else if (mode === 'remove') {
                    if (currentValue < safeAmount) {
                        return { ok: false, code: 'insufficient_funds', currentValue };
                    }
                    nextValue = currentValue - safeAmount;
                }

                const delta = nextValue - currentValue;
                const txAmount = delta;

                if (scope === 'wallet') {
                    await conn.query(
                        `UPDATE economy_balances
                         SET wallet = ?,
                             total_earned = total_earned + ?,
                             total_spent = total_spent + ?,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE guild_id = ? AND user_id = ?`,
                        [
                            nextValue,
                            delta > 0 ? delta : 0,
                            delta < 0 ? Math.abs(delta) : 0,
                            validGuildId,
                            validUserId
                        ]
                    );
                } else {
                    await conn.query(
                        `UPDATE economy_balances
                         SET bank = ?,
                             total_earned = total_earned + ?,
                             total_spent = total_spent + ?,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE guild_id = ? AND user_id = ?`,
                        [
                            nextValue,
                            delta > 0 ? delta : 0,
                            delta < 0 ? Math.abs(delta) : 0,
                            validGuildId,
                            validUserId
                        ]
                    );
                }

                const txType = `admin_${mode}_${scope}`;
                await conn.query(
                    `INSERT INTO economy_transactions (guild_id, user_id, tx_type, amount, source_user_id, note)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [
                        validGuildId,
                        validUserId,
                        txType,
                        txAmount,
                        actorId,
                        reason || `Admin ${mode} ${scope}: ${currentValue} -> ${nextValue}`
                    ]
                );

                return { ok: true, previous: currentValue, current: nextValue, delta };
            });

            if (!result?.ok) return result || { ok: false, code: 'adjust_failed' };

            const balance = await this.getEconomyBalance(validGuildId, validUserId);
            return {
                ok: true,
                scope,
                mode,
                previous: result.previous,
                current: result.current,
                delta: result.delta,
                balance
            };
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error in admin economy adjustment:', error.message);
            return { ok: false, code: 'db_error' };
        }
    }

    async transferEconomy(guildId, fromUserId, toUserId, amount) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validFromUserId = this.validateDiscordId(fromUserId);
            const validToUserId = this.validateDiscordId(toUserId);
            const safeAmount = Math.max(1, Math.min(5_000_000, Number(amount) || 0));

            if (!validGuildId || !validFromUserId || !validToUserId || validFromUserId === validToUserId || !safeAmount) {
                return { ok: false, code: 'invalid_input' };
            }

            const result = await this.connection.transaction(async (conn) => {
                await conn.query(
                    `INSERT INTO economy_balances (guild_id, user_id)
                     VALUES (?, ?)
                     ON DUPLICATE KEY UPDATE updated_at = updated_at`,
                    [validGuildId, validFromUserId]
                );

                await conn.query(
                    `INSERT INTO economy_balances (guild_id, user_id)
                     VALUES (?, ?)
                     ON DUPLICATE KEY UPDATE updated_at = updated_at`,
                    [validGuildId, validToUserId]
                );

                const [debitResult] = await conn.query(
                    `UPDATE economy_balances
                     SET wallet = wallet - ?, total_spent = total_spent + ?, updated_at = CURRENT_TIMESTAMP
                     WHERE guild_id = ? AND user_id = ? AND wallet >= ?`,
                    [safeAmount, safeAmount, validGuildId, validFromUserId, safeAmount]
                );

                if (!debitResult || Number(debitResult.affectedRows || 0) === 0) {
                    return { ok: false, code: 'insufficient_funds' };
                }

                await conn.query(
                    `UPDATE economy_balances
                     SET wallet = wallet + ?, total_earned = total_earned + ?, updated_at = CURRENT_TIMESTAMP
                     WHERE guild_id = ? AND user_id = ?`,
                    [safeAmount, safeAmount, validGuildId, validToUserId]
                );

                await conn.query(
                    `INSERT INTO economy_transactions (guild_id, user_id, tx_type, amount, source_user_id, note)
                     VALUES (?, ?, 'transfer_out', ?, ?, ?)`,
                    [validGuildId, validFromUserId, -safeAmount, validToUserId, 'User transfer sent']
                );

                await conn.query(
                    `INSERT INTO economy_transactions (guild_id, user_id, tx_type, amount, source_user_id, note)
                     VALUES (?, ?, 'transfer_in', ?, ?, ?)`,
                    [validGuildId, validToUserId, safeAmount, validFromUserId, 'User transfer received']
                );

                return { ok: true };
            });

            if (!result?.ok) return result || { ok: false, code: 'transfer_failed' };

            const fromBalance = await this.getEconomyBalance(validGuildId, validFromUserId);
            const toBalance = await this.getEconomyBalance(validGuildId, validToUserId);

            this.checkEconomyTransferFraud(validGuildId, validFromUserId, validToUserId, safeAmount).catch(() => { });

            return {
                ok: true,
                amount: safeAmount,
                fromBalance,
                toBalance
            };
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error transferring economy funds:', error.message);
            return { ok: false, code: 'db_error' };
        }
    }

    async moveEconomyFunds(guildId, userId, amount, direction = 'deposit') {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            const safeAmount = Math.max(1, Math.min(5_000_000, Number(amount) || 0));
            const safeDirection = ['deposit', 'withdraw'].includes(String(direction || '').toLowerCase())
                ? String(direction).toLowerCase()
                : null;

            if (!validGuildId || !validUserId || !safeAmount || !safeDirection) {
                return { ok: false, code: 'invalid_input' };
            }

            const result = await this.connection.transaction(async (conn) => {
                await conn.query(
                    `INSERT INTO economy_balances (guild_id, user_id)
                     VALUES (?, ?)
                     ON DUPLICATE KEY UPDATE updated_at = updated_at`,
                    [validGuildId, validUserId]
                );

                if (safeDirection === 'deposit') {
                    const [moveResult] = await conn.query(
                        `UPDATE economy_balances
                         SET wallet = wallet - ?, bank = bank + ?, updated_at = CURRENT_TIMESTAMP
                         WHERE guild_id = ? AND user_id = ? AND wallet >= ?`,
                        [safeAmount, safeAmount, validGuildId, validUserId, safeAmount]
                    );

                    if (!moveResult || Number(moveResult.affectedRows || 0) === 0) {
                        return { ok: false, code: 'insufficient_wallet' };
                    }
                } else {
                    const [moveResult] = await conn.query(
                        `UPDATE economy_balances
                         SET bank = bank - ?, wallet = wallet + ?, updated_at = CURRENT_TIMESTAMP
                         WHERE guild_id = ? AND user_id = ? AND bank >= ?`,
                        [safeAmount, safeAmount, validGuildId, validUserId, safeAmount]
                    );

                    if (!moveResult || Number(moveResult.affectedRows || 0) === 0) {
                        return { ok: false, code: 'insufficient_bank' };
                    }
                }

                await conn.query(
                    `INSERT INTO economy_transactions (guild_id, user_id, tx_type, amount, note)
                     VALUES (?, ?, ?, ?, ?)`,
                    [
                        validGuildId,
                        validUserId,
                        safeDirection === 'deposit' ? 'deposit_to_bank' : 'withdraw_from_bank',
                        safeAmount,
                        safeDirection === 'deposit' ? 'Moved wallet -> bank' : 'Moved bank -> wallet'
                    ]
                );

                return { ok: true };
            });

            if (!result?.ok) return result || { ok: false, code: 'move_failed' };

            const balance = await this.getEconomyBalance(validGuildId, validUserId);
            return { ok: true, amount: safeAmount, direction: safeDirection, balance };
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error moving economy funds:', error.message);
            return { ok: false, code: 'db_error' };
        }
    }

    async gambleEconomy(guildId, userId, wager, options = {}) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            const validUserId = this.validateDiscordId(userId);
            const safeWager = Math.max(1, Math.min(5_000_000, Number(wager) || 0));
            if (!validGuildId || !validUserId || !safeWager) {
                return { ok: false, code: 'invalid_input' };
            }

            const winChanceRaw = Number(options.winChance);
            const safeWinChance = Number.isFinite(winChanceRaw)
                ? Math.min(Math.max(winChanceRaw, 0.05), 0.95)
                : 0.45;
            const multiplierRaw = Number(options.multiplier);
            const safeMultiplier = Number.isFinite(multiplierRaw)
                ? Math.min(Math.max(multiplierRaw, 1.1), 10)
                : 2;
            const cooldownMs = Math.max(10_000, Math.min(24 * 60 * 60 * 1000, Number(options.cooldownMs) || 120_000));

            const lastPlayMs = await this.getLastEconomyTransaction(validGuildId, validUserId, 'gamble_play');
            if (lastPlayMs && (Date.now() - lastPlayMs) < cooldownMs) {
                return {
                    ok: false,
                    code: 'cooldown',
                    retryAfterMs: cooldownMs - (Date.now() - lastPlayMs)
                };
            }

            const isWin = Math.random() < safeWinChance;
            const payout = isWin ? Math.max(1, Math.floor(safeWager * safeMultiplier)) : 0;
            const netChange = payout - safeWager;

            const result = await this.connection.transaction(async (conn) => {
                await conn.query(
                    `INSERT INTO economy_balances (guild_id, user_id)
                     VALUES (?, ?)
                     ON DUPLICATE KEY UPDATE updated_at = updated_at`,
                    [validGuildId, validUserId]
                );

                const [updateResult] = await conn.query(
                    `UPDATE economy_balances
                     SET wallet = wallet + ?,
                         total_spent = total_spent + ?,
                         total_earned = total_earned + ?,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE guild_id = ? AND user_id = ? AND wallet >= ?`,
                    [netChange, safeWager, payout, validGuildId, validUserId, safeWager]
                );

                if (!updateResult || Number(updateResult.affectedRows || 0) === 0) {
                    return { ok: false, code: 'insufficient_funds' };
                }

                await conn.query(
                    `INSERT INTO economy_transactions (guild_id, user_id, tx_type, amount, note)
                     VALUES (?, ?, 'gamble_play', ?, ?)`,
                    [
                        validGuildId,
                        validUserId,
                        netChange,
                        isWin
                            ? `Gamble win: wager ${safeWager}, payout ${payout}`
                            : `Gamble loss: wager ${safeWager}`
                    ]
                );

                return { ok: true };
            });

            if (!result?.ok) return result || { ok: false, code: 'gamble_failed' };

            const balance = await this.getEconomyBalance(validGuildId, validUserId);
            return {
                ok: true,
                isWin,
                wager: safeWager,
                payout,
                netChange,
                winChance: safeWinChance,
                multiplier: safeMultiplier,
                balance
            };
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error in economy gamble:', error.message);
            return { ok: false, code: 'db_error' };
        }
    }

    async getEconomyLeaderboard(guildId, limit = 10) {
        try {
            const validGuildId = this.validateDiscordId(guildId);
            if (!validGuildId) return [];

            const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
            const rows = await this.connection.query(
                `SELECT user_id, wallet, bank, (wallet + bank) AS total
                 FROM economy_balances
                 WHERE guild_id = ?
                 ORDER BY total DESC, updated_at ASC
                 LIMIT ?`,
                [validGuildId, safeLimit]
            );

            return (rows || []).map((row) => ({
                user_id: String(row.user_id),
                wallet: Number(row.wallet || 0),
                bank: Number(row.bank || 0),
                total: Number(row.total || 0)
            }));
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error getting economy leaderboard:', error.message);
            return [];
        }
    }

    async getLinkedAdminUsersDueForDiscordRoleSync(limit = 25, staleMs = 5 * 60 * 1000) {
        try {
            const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
            const safeStaleMs = Math.max(60 * 1000, Number(staleMs) || 5 * 60 * 1000);
            const cutoff = new Date(Date.now() - safeStaleMs);

            const rows = await this.connection.query(
                `SELECT id, username, role, active,
                        discord_user_id, discord_username, discord_linked_at,
                        discord_last_verified_at, discord_guild_verified_at,
                        discord_role_verified_at, discord_last_trusted_role,
                        discord_last_role_sync_at
                 FROM admin_users
                 WHERE active = 1
                   AND discord_user_id IS NOT NULL
                   AND discord_user_id <> ''
                   AND (
                     discord_last_role_sync_at IS NULL
                     OR discord_last_role_sync_at < ?
                   )
                 ORDER BY COALESCE(discord_last_role_sync_at, discord_linked_at, created_at) ASC
                 LIMIT ?`,
                [cutoff, safeLimit]
            );

            return Array.isArray(rows) ? rows : [];
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error getting linked admin users due for Discord role sync:', error.message);
            return [];
        }
    }

    async markAdminUserDiscordRoleSyncChecked(adminUserId, checkedAt = new Date()) {
        try {
            const safeId = this.validateTextInput(String(adminUserId || ''), 36);
            if (!safeId) return false;

            const result = await this.connection.query(
                `UPDATE admin_users
                 SET discord_last_role_sync_at = ?
                 WHERE id = ?`,
                [checkedAt instanceof Date ? checkedAt : new Date(checkedAt || Date.now()), safeId]
            );

            return (result?.affectedRows || 0) > 0;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error marking Discord role sync check:', error.message);
            return false;
        }
    }

    // ========== SCHEDULED JOBS ==========

    async enqueueJob(jobType, payload = {}, runAt = Date.now(), maxAttempts = 3) {
        try {
            const safeType = this.validateTextInput(String(jobType || ''), 100);
            if (!safeType) return null;

            const safeRunAt = Number(runAt) || Date.now();
            const safeAttempts = Math.max(1, Math.min(10, Number(maxAttempts) || 3));
            const now = Date.now();

            const result = await this.connection.query(
                `INSERT INTO scheduled_jobs (job_type, payload, status, run_at, attempts, max_attempts, created_at, updated_at)
                 VALUES (?, ?, 'pending', ?, 0, ?, ?, ?)`,
                [safeType, JSON.stringify(payload || {}), safeRunAt, safeAttempts, now, now]
            );

            return result?.insertId || null;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error enqueueing job:', error.message);
            return null;
        }
    }

    async claimDueJobs(workerId, limit = 10) {
        try {
            const safeWorker = this.validateTextInput(String(workerId || ''), 100) || 'default-worker';
            const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
            const now = Date.now();

            const candidates = await this.connection.query(
                `SELECT id
                 FROM scheduled_jobs
                 WHERE status = 'pending' AND run_at <= ?
                 ORDER BY run_at ASC
                 LIMIT ?`,
                [now, safeLimit]
            );

            const claimedIds = [];
            for (const candidate of candidates || []) {
                const updateResult = await this.connection.query(
                    `UPDATE scheduled_jobs
                     SET status = 'running', locked_by = ?, locked_at = ?, updated_at = ?, attempts = attempts + 1
                     WHERE id = ? AND status = 'pending'`,
                    [safeWorker, now, now, candidate.id]
                );

                if ((updateResult?.affectedRows || 0) > 0) {
                    claimedIds.push(candidate.id);
                }
            }

            if (!claimedIds.length) return [];

            const placeholders = claimedIds.map(() => '?').join(',');
            const rows = await this.connection.query(
                `SELECT * FROM scheduled_jobs WHERE id IN (${placeholders}) ORDER BY run_at ASC`,
                claimedIds
            );

            return rows || [];
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error claiming due jobs:', error.message);
            return [];
        }
    }

    async completeJob(jobId) {
        try {
            const id = Number(jobId);
            if (!Number.isFinite(id) || id <= 0) return false;
            const now = Date.now();

            const result = await this.connection.query(
                `UPDATE scheduled_jobs
                 SET status = 'completed', completed_at = ?, updated_at = ?, locked_by = NULL, locked_at = NULL
                 WHERE id = ? AND status = 'running'`,
                [now, now, id]
            );

            return (result?.affectedRows || 0) > 0;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error completing job:', error.message);
            return false;
        }
    }

    async failJob(jobId, errorMessage = 'Unknown job error') {
        try {
            const id = Number(jobId);
            if (!Number.isFinite(id) || id <= 0) return false;

            const safeError = this.validateTextInput(String(errorMessage || ''), 2000) || 'Unknown job error';
            const now = Date.now();

            const rows = await this.connection.query('SELECT attempts, max_attempts FROM scheduled_jobs WHERE id = ? LIMIT 1', [id]);
            const row = rows?.[0];
            if (!row) return false;

            const attempts = Number(row.attempts) || 0;
            const maxAttempts = Number(row.max_attempts) || 3;
            const shouldRetry = attempts < maxAttempts;
            const nextRunAt = now + Math.min(30 * 60 * 1000, Math.max(10 * 1000, attempts * 10 * 1000));

            const result = await this.connection.query(
                `UPDATE scheduled_jobs
                 SET status = ?, run_at = ?, last_error = ?, updated_at = ?, locked_by = NULL, locked_at = NULL
                 WHERE id = ?`,
                [shouldRetry ? 'pending' : 'failed', shouldRetry ? nextRunAt : now, safeError, now, id]
            );

            return (result?.affectedRows || 0) > 0;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error failing job:', error.message);
            return false;
        }
    }

    async releaseStaleRunningJobs(staleAfterMs = 10 * 60 * 1000) {
        try {
            const threshold = Date.now() - Math.max(60 * 1000, Number(staleAfterMs) || 10 * 60 * 1000);
            const result = await this.connection.query(
                `UPDATE scheduled_jobs
                 SET status = 'pending', locked_by = NULL, locked_at = NULL, updated_at = ?
                 WHERE status = 'running' AND (locked_at IS NULL OR locked_at < ?)`,
                [Date.now(), threshold]
            );
            return result?.affectedRows || 0;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error releasing stale jobs:', error.message);
            return 0;
        }
    }

    async getScheduledJobs({ status = null, limit = 50 } = {}) {
        try {
            const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
            const allowedStatuses = ['pending', 'running', 'completed', 'failed'];

            if (status && allowedStatuses.includes(status)) {
                return await this.connection.query(
                    `SELECT * FROM scheduled_jobs WHERE status = ? ORDER BY run_at ASC LIMIT ?`,
                    [status, safeLimit]
                );
            }

            return await this.connection.query(
                `SELECT * FROM scheduled_jobs ORDER BY run_at ASC LIMIT ?`,
                [safeLimit]
            );
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error getting scheduled jobs:', error.message);
            return [];
        }
    }

    async retryScheduledJob(jobId) {
        try {
            const id = Number(jobId);
            if (!Number.isFinite(id) || id <= 0) return false;
            const now = Date.now();

            const result = await this.connection.query(
                `UPDATE scheduled_jobs
                 SET status = 'pending', run_at = ?, locked_by = NULL, locked_at = NULL, updated_at = ?, last_error = NULL
                 WHERE id = ?`,
                [now, now, id]
            );

            return (result?.affectedRows || 0) > 0;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error retrying scheduled job:', error.message);
            return false;
        }
    }

    // ========== STATS ==========

    async getStats() {
        try {
            const stats = {
                levels: await this.getLevelsCount(),
                warns: await this.getWarnsCount(),
                reminders: await this.getRemindersCount(),
                giveaways: await this.getGiveawaysCount()
            };
            return stats;
        } catch (error) {
            console.error('Error getting stats:', error);
            return { levels: 0, warns: 0, reminders: 0, giveaways: 0 };
        }
    }

    // ========== ADMIN USERS ==========

    async getAdminUser(username) {
        try {
            const results = await this.connection.query(
                'SELECT * FROM admin_users WHERE username = ? AND active = TRUE',
                [username]
            );
            return results[0] || null;
        } catch (error) {
            console.error('Error getting admin user:', error);
            return null;
        }
    }
    async getAdminUserById(userId) {
        try {
            const results = await this.connection.query(
                'SELECT * FROM admin_users WHERE id = ?',
                [userId]
            );
            return results[0] || null;
        } catch (error) {
            console.error('Error getting admin user by ID:', error);
            return null;
        }
    }
    async getAllAdminUsers() {
        try {
            return await this.connection.query('SELECT id, username, role, created_at, last_login, active FROM admin_users');
        } catch (error) {
            console.error('Error getting all admin users:', error);
            return [];
        }
    }

    async createAdminUser(username, passwordHash, role = 'moderator') {
        try {
            const { v7: uuidv7 } = require('uuid');
            const id = uuidv7();
            await this.connection.query(
                'INSERT INTO admin_users (id, username, password_hash, role) VALUES (?, ?, ?, ?)',
                [id, username, passwordHash, role]
            );
            return true;
        } catch (error) {
            console.error('Error creating admin user:', error);
            return false;
        }
    }

    async updateAdminUser(userId, updates) {
        try {
            const { username, passwordHash, role, active } = updates;
            const fields = [];
            const values = [];

            if (username !== undefined) {
                fields.push('username = ?');
                values.push(username);
            }
            if (passwordHash !== undefined) {
                fields.push('password_hash = ?');
                values.push(passwordHash);
            }
            if (role !== undefined) {
                fields.push('role = ?');
                values.push(role);
            }
            if (active !== undefined) {
                fields.push('active = ?');
                values.push(active);
            }

            if (fields.length === 0) return false;

            values.push(userId);
            await this.connection.query(
                `UPDATE admin_users SET ${fields.join(', ')} WHERE id = ?`,
                values
            );
            return true;
        } catch (error) {
            console.error('Error updating admin user:', error);
            return false;
        }
    }

    async updateLastLogin(username) {
        try {
            await this.connection.query(
                'UPDATE admin_users SET last_login = NOW() WHERE username = ?',
                [username]
            );
            return true;
        } catch (error) {
            console.error('Error updating last login:', error);
            return false;
        }
    }

    async deleteAdminUser(userId) {
        try {
            await this.connection.query('DELETE FROM admin_users WHERE id = ?', [userId]);
            return true;
        } catch (error) {
            console.error('Error deleting admin user:', error);
            return false;
        }
    }

    // ========== ADMIN INVITE CODES ==========

    async createAdminInvite(createdBy, role = 'moderator', expiresInDays = 7) {
        try {
            const crypto = require('crypto');
            const code = crypto.randomBytes(16).toString('hex');
            const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

            await this.connection.query(
                `INSERT INTO admin_invite_codes (code, created_by, expires_at, role) 
                 VALUES (?, ?, ?, ?)`,
                [code, createdBy, expiresAt, role]
            );
            return { code, expiresAt, role };
        } catch (error) {
            console.error('Error creating admin invite:', error);
            return null;
        }
    }

    async getAdminInvite(code) {
        try {
            const results = await this.connection.query(
                `SELECT * FROM admin_invite_codes WHERE code = ? AND active = TRUE 
                 AND (expires_at IS NULL OR expires_at > NOW()) AND used_by IS NULL`,
                [code]
            );
            return results[0] || null;
        } catch (error) {
            console.error('Error getting admin invite:', error);
            return null;
        }
    }

    async useAdminInvite(code, newUsername) {
        try {
            const result = await this.connection.query(
                `UPDATE admin_invite_codes SET used_by = ?, used_at = NOW(), active = FALSE 
                 WHERE code = ? AND active = TRUE AND used_by IS NULL 
                 AND (expires_at IS NULL OR expires_at > NOW())`,
                [newUsername, code]
            );
            return result.affectedRows > 0;
        } catch (error) {
            console.error('Error using admin invite:', error);
            return false;
        }
    }

    async listActiveInvites(createdBy) {
        try {
            const results = await this.connection.query(
                `SELECT id, code, created_at, expires_at, used_by, used_at, role, active 
                 FROM admin_invite_codes WHERE created_by = ? AND active = TRUE 
                 ORDER BY created_at DESC`,
                [createdBy]
            );
            return results;
        } catch (error) {
            console.error('Error listing active invites:', error);
            return [];
        }
    }

    async revokeInviteCode(code, createdBy) {
        try {
            const result = await this.connection.query(
                `UPDATE admin_invite_codes SET active = FALSE 
                 WHERE code = ? AND created_by = ? AND used_by IS NULL`,
                [code, createdBy]
            );
            return result.affectedRows > 0;
        } catch (error) {
            console.error('Error revoking invite code:', error);
            return false;
        }
    }

    async deleteExpiredInvites() {
        try {
            await this.connection.query(
                `DELETE FROM admin_invite_codes WHERE expires_at < NOW()`
            );
            return true;
        } catch (error) {
            console.error('Error deleting expired invites:', error);
            return false;
        }
    }

    async deleteInactiveJoinToCreate(inactiveDaysThreshold = 7) {
        try {
            // Delete entries that became inactive more than X days ago
            const result = await this.connection.query(
                `DELETE FROM join_to_create WHERE is_active = FALSE AND created_at < ? LIMIT 100`,
                [Date.now() - (inactiveDaysThreshold * 24 * 60 * 60 * 1000)]
            );
            if (result.affectedRows > 0) {
                console.log(`✅ Cleaned up ${result.affectedRows} inactive join_to_create entries`);
            }
            return result.affectedRows;
        } catch (error) {
            console.error('Error deleting inactive join_to_create entries:', error);
            return 0;
        }
    }
    async getAdminUsersCount() {
        try {
            const results = await this.connection.query('SELECT COUNT(*) as count FROM admin_users WHERE active = 1 AND role = ?', ['admin']);
            return results[0]?.count || 0;
        } catch (error) {
            console.error('Error getting admin users count:', error);
            return 0;
        }
    }

    async logMemberActivity(userId, username, eventType, guildId) {
        try {
            await this.connection.query(
                'INSERT INTO member_activity (user_id, username, event_type, guild_id) VALUES (?, ?, ?, ?)',
                [userId, username, eventType, guildId]
            );
        } catch (error) {
            console.error('Error logging member activity:', error);
        }
    }

    async getMemberActivityToday() {
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const results = await this.connection.query(
                `SELECT event_type, COUNT(*) as count 
                 FROM member_activity 
                 WHERE timestamp >= ? 
                 GROUP BY event_type`,
                [today]
            );

            const activity = { joins: 0, leaves: 0 };
            if (results && results.length > 0) {
                results.forEach(row => {
                    if (row.event_type === 'join') activity.joins = parseInt(row.count) || 0;
                    if (row.event_type === 'leave') activity.leaves = parseInt(row.count) || 0;
                });
            }

            return activity;
        } catch (error) {
            console.error('Error getting member activity today:', error);
            return { joins: 0, leaves: 0 };
        }
    }

    // ===== AUDIT LOGS =====
    async logAuditEvent(guildId, eventType, data = {}) {
        try {
            await this.connection.query(
                `INSERT INTO audit_logs (guild_id, event_type, user_id, moderator_id, channel_id, 
                 before_content, after_content, reason, metadata) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    guildId,
                    eventType,
                    data.userId || null,
                    data.moderatorId || null,
                    data.channelId || null,
                    data.beforeContent || null,
                    data.afterContent || null,
                    data.reason || null,
                    data.metadata ? JSON.stringify(data.metadata) : null
                ]
            );
        } catch (error) {
            console.error('Error logging audit event:', error);
        }
    }

    async getAuditLogs(filters = {}) {
        try {
            let query = 'SELECT * FROM audit_logs WHERE 1=1';
            const params = [];

            if (filters.guildId) {
                query += ' AND guild_id = ?';
                params.push(filters.guildId);
            }
            if (filters.eventType) {
                query += ' AND event_type = ?';
                params.push(filters.eventType);
            }
            if (filters.userId) {
                query += ' AND user_id = ?';
                params.push(filters.userId);
            }
            if (filters.startDate) {
                query += ' AND timestamp >= ?';
                params.push(filters.startDate);
            }
            if (filters.endDate) {
                query += ' AND timestamp <= ?';
                params.push(filters.endDate);
            }

            query += ' ORDER BY timestamp DESC LIMIT ?';
            params.push(filters.limit || 100);

            const results = await this.connection.query(query, params);
            return results || [];
        } catch (error) {
            console.error('Error getting audit logs:', error);
            return [];
        }
    }

    // ===== SUGGESTIONS =====
    async createSuggestion(guildId, userId, title, description) {
        try {
            // Accepts an optional 5th argument: caseId
            let caseId = arguments[4];
            if (!caseId) caseId = null;
            const result = await this.connection.query(
                `INSERT INTO suggestions (guild_id, user_id, title, description, case_id) 
                 VALUES (?, ?, ?, ?, ?)`,
                [guildId, userId, title, description, caseId]
            );
            return result.insertId;
        } catch (error) {
            console.error('Error creating suggestion:', error);
            return null;
        }
    }

    async getSuggestion(suggestionId) {
        try {
            const results = await this.connection.query(
                'SELECT * FROM suggestions WHERE suggestion_id = ?',
                [suggestionId]
            );
            return results.length > 0 ? results[0] : null;
        } catch (error) {
            console.error('Error getting suggestion:', error);
            return null;
        }
    }

    async getAllSuggestions(limit = 50) {
        try {
            // Updated query to include reaction counts
            const query = `
                SELECT s.*, 
                   (SELECT COUNT(*) FROM suggestion_reactions WHERE suggestion_id = s.suggestion_id AND vote = 'upvote') AS upvotes,
                   (SELECT COUNT(*) FROM suggestion_reactions WHERE suggestion_id = s.suggestion_id AND vote = 'downvote') AS downvotes
                FROM suggestions s
                ORDER BY s.created_at DESC
                LIMIT ?
            `;
            const results = await this.connection.query(query, [limit]);
            return results;
        } catch (error) {
            console.error('Error getting all suggestions:', error);
            return [];
        }
    }

    async getSuggestionByCaseId(caseId) {
        try {
            const results = await this.connection.query(
                'SELECT * FROM suggestions WHERE case_id = ?',
                [caseId]
            );
            return results.length > 0 ? results[0] : null;
        } catch (error) {
            console.error('Error getting suggestion by case id:', error);
            return null;
        }
    }

    async getSuggestionByMessageId(messageId) {
        try {
            const results = await this.connection.query(
                'SELECT * FROM suggestions WHERE message_id = ?',
                [messageId]
            );
            return results.length > 0 ? results[0] : null;
        } catch (error) {
            console.error('Error getting suggestion by message:', error);
            return null;
        }
    }

    async updateSuggestionMessageId(suggestionId, messageId) {
        try {
            await this.connection.query(
                'UPDATE suggestions SET message_id = ? WHERE suggestion_id = ?',
                [messageId, suggestionId]
            );
        } catch (error) {
            console.error('Error updating suggestion message ID:', error);
        }
    }

    async updateSuggestionStatus(suggestionId, status, respondedBy, adminResponse = null) {
        try {
            await this.connection.query(
                `UPDATE suggestions SET status = ?, admin_response = ?, responded_by = ?, resolved_at = NOW()
                 WHERE suggestion_id = ? OR case_id = ?`,
                [status, adminResponse, respondedBy, suggestionId, suggestionId]
            );
            return true;
        } catch (error) {
            console.error('Error updating suggestion:', error);
            return false;
        }
    }

    async getAllSuggestions(filters = {}) {
        try {
            let query = 'SELECT * FROM suggestions WHERE 1=1';
            const params = [];

            if (filters.status) {
                query += ' AND status = ?';
                params.push(filters.status);
            }
            if (filters.guildId) {
                query += ' AND guild_id = ?';
                params.push(filters.guildId);
            }

            query += ' ORDER BY created_at DESC LIMIT ?';
            params.push(filters.limit || 50);

            const results = await this.connection.query(query, params);
            return results || [];
        } catch (error) {
            console.error('Error getting suggestions:', error);
            return [];
        }
    }

    async voteSuggestion(suggestionId, userId, voteType) {
        try {
            // Remove existing vote if any
            await this.connection.query(
                'DELETE FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?',
                [suggestionId, userId]
            );

            // Add new vote
            await this.connection.query(
                'INSERT INTO suggestion_votes (suggestion_id, user_id, vote_type) VALUES (?, ?, ?)',
                [suggestionId, userId, voteType]
            );

            // Update vote counts
            const upvotes = await this.connection.query(
                'SELECT COUNT(*) as count FROM suggestion_votes WHERE suggestion_id = ? AND vote_type = "upvote"',
                [suggestionId]
            );
            const downvotes = await this.connection.query(
                'SELECT COUNT(*) as count FROM suggestion_votes WHERE suggestion_id = ? AND vote_type = "downvote"',
                [suggestionId]
            );

            await this.connection.query(
                'UPDATE suggestions SET upvotes = ?, downvotes = ? WHERE suggestion_id = ?',
                [upvotes[0]?.count || 0, downvotes[0]?.count || 0, suggestionId]
            );

            return true;
        } catch (error) {
            console.error('Error voting on suggestion:', error);
            return false;
        }
    }

    // ===== INVITE TRACKING =====
    async incrementInviteUsage({ guildId, inviteCode, inviterId = null, joinedAt = Date.now() } = {}) {
        try {
            if (!guildId || !inviteCode) return false;

            await this.connection.query(
                `INSERT INTO invite_usage (guild_id, invite_code, inviter_id, join_count, last_joined_at)
                 VALUES (?, ?, ?, 1, ?)
                 ON DUPLICATE KEY UPDATE
                     join_count = join_count + 1,
                     last_joined_at = VALUES(last_joined_at),
                     inviter_id = COALESCE(invite_usage.inviter_id, VALUES(inviter_id))`,
                [String(guildId), String(inviteCode), inviterId ? String(inviterId) : null, Number(joinedAt) || Date.now()]
            );

            return true;
        } catch (error) {
            console.error('[InviteTracker] Failed to increment invite usage:', error.message);
            return false;
        }
    }

    async getInviteStatsByUser(guildId, inviterId) {
        try {
            if (!guildId || !inviterId) {
                return { total: 0, perInvite: [] };
            }

            const rows = await this.connection.query(
                `SELECT invite_code, join_count, last_joined_at
                 FROM invite_usage
                 WHERE guild_id = ? AND inviter_id = ?
                 ORDER BY join_count DESC`,
                [String(guildId), String(inviterId)]
            );

            const perInvite = Array.isArray(rows)
                ? rows.map((row) => ({
                    code: row.invite_code,
                    joins: Number(row.join_count || 0),
                    lastJoinedAt: row.last_joined_at ? Number(row.last_joined_at) : null
                }))
                : [];

            const total = perInvite.reduce((sum, entry) => sum + Number(entry.joins || 0), 0);

            return { total, perInvite };
        } catch (error) {
            console.error('[InviteTracker] Failed to fetch invite stats:', error.message);
            return { total: 0, perInvite: [] };
        }
    }

    async getInviteStatsByCode(guildId, inviteCode) {
        try {
            if (!guildId || !inviteCode) return null;

            const row = await this.queryOne(
                `SELECT invite_code, inviter_id, join_count, last_joined_at
                 FROM invite_usage
                 WHERE guild_id = ? AND invite_code = ?
                 LIMIT 1`,
                [String(guildId), String(inviteCode)]
            );

            if (!row) return null;

            return {
                code: row.invite_code,
                inviterId: row.inviter_id ? String(row.inviter_id) : null,
                joins: Number(row.join_count || 0),
                lastJoinedAt: row.last_joined_at ? Number(row.last_joined_at) : null
            };
        } catch (error) {
            console.error('[InviteTracker] Failed to fetch invite stats by code:', error.message);
            return null;
        }
    }

    async getInviteLeaderboard(guildId, limit = 10) {
        try {
            if (!guildId) return [];
            const safeLimit = Math.max(1, Math.min(20, Number(limit) || 10));

            const rows = await this.connection.query(
                `SELECT inviter_id, SUM(join_count) AS joins
                 FROM invite_usage
                 WHERE guild_id = ? AND inviter_id IS NOT NULL
                 GROUP BY inviter_id
                 ORDER BY joins DESC
                 LIMIT ?`,
                [String(guildId), safeLimit]
            );

            return Array.isArray(rows)
                ? rows.map((row) => ({
                    inviterId: String(row.inviter_id),
                    joins: Number(row.joins || 0)
                }))
                : [];
        } catch (error) {
            console.error('[InviteTracker] Failed to fetch invite leaderboard:', error.message);
            return [];
        }
    }

    // ===== AUTOMOD VIOLATIONS =====
    async logAutomodViolation(userId, guildId, violationType, messageContent, channelId, actionTaken, context = {}) {
        try {
            const safeRiskScore = Number.isFinite(Number(context?.riskScore)) ? Number(context.riskScore) : null;
            const safeRiskLevel = ['low', 'medium', 'high', 'critical'].includes(String(context?.riskLevel || '').toLowerCase())
                ? String(context.riskLevel).toLowerCase()
                : null;
            const safeSignalCount = Number.isFinite(Number(context?.signalCount))
                ? Math.max(1, Math.round(Number(context.signalCount)))
                : null;
            const appealNotified = context?.appealNotified === true;
            let metadataJson = null;
            if (context?.metadata && typeof context.metadata === 'object') {
                try {
                    metadataJson = JSON.stringify(context.metadata);
                } catch (_) {
                    metadataJson = null;
                }
            }

            await this.connection.query(
                `INSERT INTO automod_violations (user_id, guild_id, violation_type, message_content, 
                 channel_id, action_taken, risk_score, risk_level, signal_count, appeal_notified, metadata_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, guildId, violationType, messageContent, channelId, actionTaken, safeRiskScore, safeRiskLevel, safeSignalCount, appealNotified, metadataJson]
            );
        } catch (error) {
            console.error('Error logging automod violation:', error);
        }
    }

    async getAutomodViolations(userId, hours = 24) {
        try {
            const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
            const results = await this.connection.query(
                'SELECT * FROM automod_violations WHERE user_id = ? AND timestamp >= ? ORDER BY timestamp DESC',
                [userId, cutoff]
            );
            return results || [];
        } catch (error) {
            console.error('Error getting automod violations:', error);
            return [];
        }
    }

    // ===== ANTI-RAID EVENTS =====
    async logAntiRaidEvent(guildId, eventType, riskScore = null, triggerCount = null, details = null) {
        try {
            if (!guildId || !eventType) return false;
            const safeRisk = Number.isFinite(Number(riskScore)) ? Math.max(0, Math.round(Number(riskScore))) : null;
            const safeTriggerCount = Number.isFinite(Number(triggerCount)) ? Math.max(0, Math.round(Number(triggerCount))) : null;
            let detailsJson = null;
            if (details && typeof details === 'object') {
                try {
                    detailsJson = JSON.stringify(details);
                } catch (_) {
                    detailsJson = null;
                }
            }

            await this.connection.query(
                `INSERT INTO anti_raid_events (guild_id, event_type, risk_score, trigger_count, details_json)
                 VALUES (?, ?, ?, ?, ?)`
                , [String(guildId), String(eventType), safeRisk, safeTriggerCount, detailsJson]
            );
            return true;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error logging anti-raid event:', error.message);
            return false;
        }
    }

    async logManualLockdown({ guildId, actionType, caseId, moderatorId, moderatorName, reason }) {
        try {
            if (!guildId || !actionType || !caseId || !moderatorId || !reason) return false;
            const safeAction = String(actionType).toLowerCase() === 'disable' ? 'disable' : 'enable';
            const safeCaseId = String(caseId).trim();
            const safeReason = String(reason).trim();
            if (!safeCaseId || !safeReason) return false;

            await this.upsertModerationCase({
                caseId: safeCaseId,
                guildId,
                userId: moderatorId,
                userName: 'Server',
                actionType: 'LOCKDOWN',
                status: safeAction === 'enable' ? 'active' : 'closed',
                reason: safeReason,
                moderatorId,
                moderatorName: moderatorName || null,
                moderatorSource: 'panel',
                source: 'panel',
                metadata: { lockdownAction: safeAction },
                createdAt: Date.now(),
                updatedAt: Date.now(),
                eventSummary: `Lockdown ${safeAction === 'enable' ? 'enabled' : 'disabled'}`
            });
            return true;
        } catch (error) {
            console.error('[MySQLDatabaseManager] Error logging manual lockdown:', error.message);
            return false;
        }
    }

    async createPoll(messageId, guildId, userId, question, optionsJson, endsAt = null) {
        try {
            await this.connection.query(
                'INSERT INTO polls (message_id, guild_id, user_id, question, options, ends_at) VALUES (?, ?, ?, ?, ?, ?)',
                [messageId, guildId, userId, question, optionsJson, endsAt]
            );
            return true;
        } catch (error) {
            console.error('Error creating poll:', error);
            return false;
        }
    }

    async getPoll(messageId) {
        try {
            const results = await this.connection.query(
                'SELECT * FROM polls WHERE message_id = ?',
                [messageId]
            );
            if (results.length > 0) {
                const poll = results[0];
                poll.options = JSON.parse(poll.options);
                return poll;
            }
            return null;
        } catch (error) {
            console.error('Error getting poll:', error);
            return null;
        }
    }

    async endPoll(messageId) {
        try {
            await this.connection.query(
                'UPDATE polls SET ended = TRUE WHERE message_id = ?',
                [messageId]
            );
            return true;
        } catch (error) {
            console.error('Error ending poll:', error);
            return false;
        }
    }

    async searchUsers(query, limit = 20) {
        try {
            const results = await this.connection.query(
                `SELECT l.user_id, l.username, l.level, l.xp, l.messages,
                        (SELECT COUNT(*) FROM moderation_cases mc WHERE mc.user_id = l.user_id AND mc.action_type = 'WARN' AND mc.status NOT IN ('cleared', 'reversed')) as warn_count,
                        (SELECT banned FROM user_bans WHERE user_id = l.user_id LIMIT 1) as banned
                 FROM levels l
                 WHERE l.username LIKE ? OR l.user_id LIKE ?
                 ORDER BY l.level DESC
                 LIMIT ?`,
                [`%${query}%`, `%${query}%`, limit]
            );
            return results || [];
        } catch (error) {
            console.error('Error searching users:', error);
            return [];
        }
    }

    async getUserProfile(userId) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId) {
                console.error('Invalid userId format:', userId);
                return null;
            }

            const [profileUser, warnings, banInfo, auditLogs, violations] = await Promise.all([
                this.queryOne(
                    'SELECT * FROM levels WHERE user_id = ?',
                    [validId],
                    {
                        useCache: true,
                        cacheNamespace: 'userprofile',
                        cacheKey: `${validId}:user`,
                        cacheTtlMs: 10000,
                        suppressError: true,
                        fallbackValue: null,
                        logLabel: 'getUserProfile.user'
                    }
                ),
                this.query(
                    `SELECT case_id, user_id, user_name AS username, reason, moderator_id, moderator_name, action_type AS type, created_at AS timestamp, created_at, updated_at, status
                     FROM moderation_cases
                     WHERE user_id = ? AND action_type = 'WARN' AND status NOT IN ('cleared', 'reversed')
                     ORDER BY created_at DESC`,
                    [validId],
                    {
                        useCache: true,
                        cacheNamespace: 'userprofile',
                        cacheKey: `${validId}:warnings`,
                        cacheTtlMs: 10000,
                        suppressError: true,
                        fallbackValue: [],
                        logLabel: 'getUserProfile.warnings'
                    }
                ),
                this.queryOne(
                    'SELECT * FROM user_bans WHERE user_id = ?',
                    [validId],
                    {
                        useCache: true,
                        cacheNamespace: 'userprofile',
                        cacheKey: `${validId}:ban`,
                        cacheTtlMs: 10000,
                        suppressError: true,
                        fallbackValue: null,
                        logLabel: 'getUserProfile.ban'
                    }
                ),
                this.query(
                    'SELECT * FROM audit_logs WHERE user_id = ? ORDER BY timestamp DESC LIMIT 50',
                    [validId],
                    {
                        useCache: true,
                        cacheNamespace: 'userprofile',
                        cacheKey: `${validId}:audit`,
                        cacheTtlMs: 8000,
                        suppressError: true,
                        fallbackValue: [],
                        logLabel: 'getUserProfile.audit'
                    }
                ),
                this.query(
                    'SELECT * FROM automod_violations WHERE user_id = ? ORDER BY timestamp DESC LIMIT 20',
                    [validId],
                    {
                        useCache: true,
                        cacheNamespace: 'userprofile',
                        cacheKey: `${validId}:violations`,
                        cacheTtlMs: 8000,
                        suppressError: true,
                        fallbackValue: [],
                        logLabel: 'getUserProfile.violations'
                    }
                )
            ]);

            return {
                user: profileUser || null,
                warnings: Array.isArray(warnings) ? warnings : [],
                ban: banInfo || null,
                auditLogs: Array.isArray(auditLogs) ? auditLogs : [],
                violations: Array.isArray(violations) ? violations : []
            };
        } catch (error) {
            console.error('Error getting user profile:', error);
            return null;
        }
    }

    getWarnsDB() {
        const db = this;
        return {
            ensure: async (userId, defaultValue) => {
                const warns = await db.getUserWarns(userId);
                return warns || defaultValue;
            },
            get: async (userId) => {
                return await db.getUserWarns(userId);
            },
            set: async (userId, data) => {
                if (data?.warns) {
                    await db.clearUserWarns(userId);
                    for (const [caseId, caseData] of Object.entries(data.warns)) {
                        await db.addCase(userId, caseId, caseData);
                    }
                }
                if (data?.banned !== undefined) {
                    if (data.banned) {
                        await db.markUserBanned(userId);
                    } else {
                        await db.unbanUser(userId);
                    }
                }
            },
            delete: async (userId, key) => {
                if (typeof key === 'string' && key.startsWith('warns.')) {
                    const caseId = key.split('.').slice(1).join('.');
                    if (caseId) {
                        await db.deleteWarn(userId, caseId);
                    }
                }
            },
            all: async () => {
                const warns = await db.getAllWarns();
                const result = {};

                for (const warn of warns) {
                    const userWarns = await db.getUserWarns(warn.user_id);
                    result[warn.user_id] = {
                        warns: userWarns?.warns || {},
                        banned: warn.banned || false,
                        lastWarned: warn.last_warned
                    };
                }
                return result;
            },
            size: async () => {
                return await db.getWarnsCount();
            }
        };
    }

    getRemindersDB() {
        const db = this;
        return {
            ensure: async (userId, defaultValue) => {
                const reminders = await db.getUserReminders(userId);
                return reminders.length > 0 ? reminders : defaultValue;
            },
            get: async (key) => {
                if (typeof key === 'string' && key.includes('-')) {
                    const allReminders = await db.getAllReminders();
                    return allReminders.find(r => r.id === key) || null;
                }
                const reminders = await db.getUserReminders(key);
                return reminders.length > 0 ? reminders : null;
            },
            set: async (reminderId, reminderData) => {
                if (typeof reminderId === 'string' && reminderId.includes('-')) {
                    const userId = reminderData.userId || reminderId.split('-')[0];
                    await db.addReminder(userId, reminderData);
                } else {
                    const userId = reminderId;
                    const reminders = Array.isArray(reminderData) ? reminderData : [reminderData];
                    const existing = await db.getUserReminders(userId);
                    for (const reminder of existing) {
                        await db.removeReminder(userId, reminder.id);
                    }
                    for (const reminder of reminders) {
                        await db.addReminder(userId, reminder);
                    }
                }
            },
            delete: async (reminderId) => {
                if (typeof reminderId === 'string' && reminderId.includes('-')) {
                    const userId = reminderId.split('-')[0];
                    await db.removeReminder(userId, reminderId);
                }
            },
            all: async () => {
                return await db.getAllReminders();
            },
            size: async () => {
                return await db.getRemindersCount();
            }
        };
    }

    getGiveawaysDB() {
        const db = this;
        return {
            get: async (id) => {
                return await db.getGiveaway(id);
            },
            set: async (id, data) => {
                const existing = await db.getGiveaway(id);
                if (existing) {
                    await db.updateGiveaway(id, data);
                } else {
                    await db.createGiveaway(id, data);
                }
            },
            delete: async (id) => {
                return await db.deleteGiveaway(id);
            },
            all: async () => {
                const giveaways = await db.getAllGiveaways();
                const result = {};
                for (const g of giveaways) {
                    result[g.id] = g;
                }
                return result;
            },
            size: async () => {
                return await db.getGiveawaysCount();
            },
            addEntry: async (giveawayId, userId) => {
                return await db.addGiveawayEntry(giveawayId, userId);
            },
            removeEntry: async (giveawayId, userId) => {
                return await db.removeGiveawayEntry(giveawayId, userId);
            }
        };
    }

    getDatabase(name) {
        if (!this.tempDatabases.has(name)) {
            const data = new Map();
            const db = {
                data,
                get: function (key) { return this.data.get(key); },
                set: function (key, value) { this.data.set(key, value); return value; },
                has: function (key) { return this.data.has(key); },
                delete: function (key) { return this.data.delete(key); },
                ensure: function (key, defaultValue) {
                    if (!this.has(key)) {
                        this.set(key, defaultValue);
                    }
                    return this.get(key);
                },
                all: function () {
                    const obj = {};
                    this.data.forEach((value, key) => obj[key] = value);
                    return obj;
                },
                size: function () { return this.data.size; }
            };
            this.tempDatabases.set(name, db);
        }

        return this.tempDatabases.get(name);
    }

    getCannedMsgsDB() {
        return this.getDatabase('cannedMsgs');
    }

    getCannedMessage(alias) {
        const cannedDB = this.getCannedMsgsDB();
        return cannedDB.has(alias) ? cannedDB.get(alias) : null;
    }

    getResolvedReason(reasonInput) {
        const canned = this.getCannedMessage(reasonInput);
        return canned || reasonInput;
    }

    flushAll() {
        console.log('[MySQLDatabaseManager] MySQL connections managed automatically');
    }

    clearCache() {
        this._resultCache.clear();
    }

    async close() {
        await this.connection.close();
    }
}

module.exports = new MySQLDatabaseManager();