const mysqlConnection = require('./MySQLConnection');

// This is the MySQL Database Manager.
// It handles all database operations for users, moderation, levels, and more.
// Handles queries, validation, and errors so you don't have to worry.
// TODO: Add connection pooling to make things faster.

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

    async initialize() {
        return await this.connection.connect();
    }

    // USERINFO section: handles user info in the database.

    // Adds or updates a user in the userinfo table.
    // userId: Discord user ID
    // username: Discord username
    // isBot: Whether the user is a bot
    // Returns true if successful.
    async addUserInfo(userId, username, isBot = false) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId) {
                console.warn('[MySQLDatabaseManager] addUserInfo called with invalid userId');
                return false;
            }
            const safeUsername = username ? this.validateTextInput(String(username), 255) : null;

            await this.connection.query(
                `INSERT INTO userinfo (user_id, username, is_bot)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE username = ?, last_seen = NOW()`,
                [validId, safeUsername, isBot ? 1 : 0, safeUsername]
            );
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
            const results = await this.connection.query(
                'SELECT * FROM userinfo WHERE user_id = ?',
                [validId]
            );
            return results[0] || null;
        } catch (error) {
            if (error.message.includes("Table 'userinfo'")) {
                return null; // Table doesn't exist yet
            }
            console.error(`[MySQLDatabaseManager] Error getting user info for ${userId}: ${error.message}`);
            return null;
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
            return results[0]?.notes || '';
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
            
            // Ensure notes column exists
            await this.ensureNotesColumn();
            
            // Ensure user exists in userinfo table first
            await this.connection.query(
                `INSERT INTO userinfo (user_id, notes) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE notes = ?`,
                [validId, notes, notes]
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

    // ========== LEVELS ==========
    
    async getUserLevel(userId) {
        try {
            const validId = this.validateDiscordId(userId);
            if (!validId) {
                console.warn('[MySQLDatabaseManager] getUserLevel called with invalid userId');
                return null;
            }
            const results = await this.connection.query(
                'SELECT * FROM levels WHERE user_id = ?',
                [validId]
            );
            return results[0] || null;
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
            return true;
        } catch (error) {
            console.error(`[MySQLDatabaseManager] Error setting level for user ${userId}: ${error.message}`);
            return false;
        }
    }

    async getAllLevels(limit = 100, offset = 0) {
        try {
            const results = await this.connection.query(
                'SELECT * FROM levels ORDER BY xp DESC LIMIT ? OFFSET ?',
                [limit, offset]
            );
            return results;
        } catch (error) {
            console.error(`[MySQLDatabaseManager] Error fetching all levels: ${error.message}`);
            return [];
        }
    }

    async getLevelsCount() {
        try {
            const results = await this.connection.query(
                'SELECT COUNT(*) as count FROM levels'
            );
            return results[0]?.count || 0;
        } catch (error) {
            console.error('Error getting levels count:', error);
            return 0;
        }
    }

    async deleteUserLevel(userId) {
        try {
            await this.connection.query('DELETE FROM levels WHERE user_id = ?', [userId]);
            return true;
        } catch (error) {
            console.error('Error deleting user level:', error);
            return false;
        }
    }

    async updateLevel(userId, level = 1, xp = 0) {
        try {
            await this.connection.query(
                'UPDATE levels SET level = ?, xp = ? WHERE user_id = ?',
                [level, xp, userId]
            );
            return true;
        } catch (error) {
            console.error('Error updating level:', error);
            return false;
        }
    }

    // ========== WARNS ==========
    
    async addCase(userId, caseId, caseData) {
        try {
            // Handle both old format (moderator, date) and new format (moderatorId, timestamp)
            const moderatorId = caseData.moderatorId || caseData.moderator || null;
            const reason = caseData.reason || null;
            const type = caseData.type || 'WARN';
            const timestamp = caseData.timestamp || Date.now();
            const duration = caseData.duration || null;
            const expiresAt = caseData.expiresAt || null;
            const userName = caseData.userName || caseData.userTag || null;
            const moderatorName = caseData.moderatorName || caseData.moderatorTag || null;
            const moderatorSource = caseData.moderatorSource || (moderatorId ? 'discord' : null);
            
            // Only insert into warns table for actual warnings (not timeouts/bans/kicks/automod)
            // AutoMod violations are logged separately to automod_violations table
            if (type === 'WARN') {
                await this.connection.query(
                    `INSERT INTO warns (user_id, case_id, reason, moderator_id, user_name, moderator_name, moderator_source, type, timestamp) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) 
                     ON DUPLICATE KEY UPDATE reason = ?, moderator_id = ?, user_name = ?, moderator_name = ?, moderator_source = ?, type = ?, timestamp = ?`,
                    [userId, caseId, reason, moderatorId, userName, moderatorName, moderatorSource, type, timestamp, reason, moderatorId, userName, moderatorName, moderatorSource, type, timestamp]
                );
            }
            
            // Update user_bans table only for ban actions
            if (type === 'BAN' || type === 'ban') {
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
            }
            
            return true;
        } catch (error) {
            console.error('Error adding case:', error);
            return false;
        }
    }

    async getUserWarns(userId) {
        try {
            const warns = await this.connection.query(
                'SELECT * FROM warns WHERE user_id = ? AND type = "WARN" ORDER BY created_at DESC',
                [userId]
            );
            
            const banInfo = await this.connection.query(
                'SELECT * FROM user_bans WHERE user_id = ?',
                [userId]
            );
            
            // Convert to old format
            const warnsObj = {};
            let lastWarn = null;
            warns.forEach(warn => {
                warnsObj[warn.case_id] = {
                    reason: warn.reason,
                    moderatorId: warn.moderator_id,
                    type: warn.type,
                    timestamp: warn.timestamp
                };
                if (!lastWarn || (warn.timestamp || 0) > (lastWarn.timestamp || 0)) {
                    lastWarn = warn;
                }
            });
            
            return {
                warns: warnsObj,
                banned: banInfo[0]?.banned || false,
                lastWarned: lastWarn?.timestamp || null,
                lastReason: lastWarn?.reason || null
            };
        } catch (error) {
            console.error('Error getting user warns:', error);
            return { warns: {} };
        }
    }

    async getUserWarnsCount(userId) {
        try {
            const results = await this.connection.query(
                'SELECT COUNT(*) as count FROM warns WHERE user_id = ? AND type = "WARN"',
                [userId]
            );
            return results[0]?.count || 0;
        } catch (error) {
            console.error('Error getting user warns count:', error);
            return 0;
        }
    }

    async clearUserWarns(userId) {
        try {
            await this.connection.query(
                'DELETE FROM warns WHERE user_id = ?',
                [userId]
            );
            return true;
        } catch (error) {
            console.error('Error clearing user warns:', error);
            return false;
        }
    }

    async deleteWarn(userId, caseId) {
        try {
            await this.connection.query(
                'DELETE FROM warns WHERE user_id = ? AND case_id = ?',
                [userId, caseId]
            );
            return true;
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
            return true;
        } catch (error) {
            console.error('Error unbanning user:', error);
            return false;
        }
    }

    async getAllWarns() {
        try {
            const query = `
                SELECT w.user_id, 
                       COUNT(*) as warn_count,
                       COALESCE(ub.banned, FALSE) as banned,
                       lw.last_warned,
                       lw.last_reason
                FROM warns w
                LEFT JOIN user_bans ub ON w.user_id = ub.user_id
                LEFT JOIN (
                    SELECT w1.user_id, w1.timestamp AS last_warned, w1.reason AS last_reason
                    FROM warns w1
                    INNER JOIN (
                        SELECT user_id, MAX(timestamp) AS max_ts
                        FROM warns
                        GROUP BY user_id
                    ) latest ON latest.user_id = w1.user_id AND latest.max_ts = w1.timestamp
                ) lw ON w.user_id = lw.user_id
                GROUP BY w.user_id, ub.banned, lw.last_warned, lw.last_reason
            `;
            const results = await this.connection.query(query);
            return results;
        } catch (error) {
            console.error('Error getting all warns:', error);
            return [];
        }
    }

    async getWarnsCount() {
        try {
            const results = await this.connection.query(
                'SELECT COUNT(DISTINCT user_id) as count FROM warns WHERE type = "WARN"'
            );
            return results[0]?.count || 0;
        } catch (error) {
            console.error('Error getting warns count:', error);
            return 0;
        }
    }

    async getBannedCount() {
        try {
            const results = await this.connection.query(
                'SELECT COUNT(*) as count FROM user_bans WHERE banned = TRUE'
            );
            return results[0]?.count || 0;
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
            const results = await this.connection.query(query);
            return results.map(r => ({
                userId: r.user_id,
                bannedAt: r.banned_at,
                bannedBy: r.banned_by,
                banReason: r.ban_reason,
                warnCount: r.warn_count
            }));
        } catch (error) {
            console.error('Error getting all banned users:', error);
            return [];
        }
    }

    // ========== REMINDERS ==========
    
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
            return reminderId;
        } catch (error) {
            console.error('Error adding reminder:', error);
            return null;
        }
    }

    async getUserReminders(userId) {
        try {
            const results = await this.connection.query(
                'SELECT * FROM reminders WHERE user_id = ? AND completed = FALSE ORDER BY trigger_at ASC',
                [userId]
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
            await this.connection.query(
                'DELETE FROM reminders WHERE user_id = ? AND id = ?',
                [userId, reminderId]
            );
            return true;
        } catch (error) {
            console.error('Error removing reminder:', error);
            return false;
        }
    }

    async getAllReminders() {
        try {
            const results = await this.connection.query(
                'SELECT * FROM reminders ORDER BY trigger_at ASC'
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
            const results = await this.connection.query(
                'SELECT COUNT(*) as count FROM reminders'
            );
            return results[0]?.count || 0;
        } catch (error) {
            console.error('Error getting reminders count:', error);
            return 0;
        }
    }

    // ========== GIVEAWAYS ==========
    
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
                ended,
                caseId
            } = data;

            await this.connection.query(
                `INSERT INTO giveaways (id, case_id, prize, title, channel_id, message_id, host_id, guild_id, end_time, winner_count, ended) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                    ended ? 1 : 0
                ]
            );
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
            
            const results = await this.connection.query(
                'SELECT * FROM giveaways WHERE id = ?',
                [id]
            );
            
            if (results.length === 0) return null;
            
            // Get entries
            const entries = await this.connection.query(
                'SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?',
                [id]
            );
            
            const giveaway = results[0];
            return {
                id: giveaway.id,
                caseId: giveaway.case_id,
                prize: giveaway.prize,
                title: giveaway.title,
                channelId: giveaway.channel_id,
                messageId: giveaway.message_id,
                hostId: giveaway.host_id,
                endTime: giveaway.end_time,
                winnerCount: giveaway.winner_count,
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
                values.push(data.ended);
            }
            if (data.endTime !== undefined) {
                fields.push('end_time = ?');
                values.push(data.endTime);
            }
            
            if (fields.length > 0) {
                values.push(id);
                await this.connection.query(
                    `UPDATE giveaways SET ${fields.join(', ')} WHERE id = ?`,
                    values
                );
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
            return true;
        } catch (error) {
            console.error('Error adding giveaway entry:', error);
            return false;
        }
    }

    async getAllGiveaways() {
        try {
            const giveaways = await this.connection.query(
                'SELECT * FROM giveaways ORDER BY created_at DESC'
            );
            
            // Get entries for each giveaway
            const result = await Promise.all(giveaways.map(async (g) => {
                const entries = await this.connection.query(
                    'SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?',
                    [g.id]
                );
                
                return {
                    id: g.id,
                    prize: g.prize,
                    title: g.title,
                    channelId: g.channel_id,
                    messageId: g.message_id,
                    hostId: g.host_id,
                    guildId: g.guild_id,
                    endTime: g.end_time,
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
            const results = await this.connection.query(
                'SELECT COUNT(*) as count FROM giveaways'
            );
            return results[0]?.count || 0;
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
            return true;
        } catch (error) {
            console.error('Error deleting giveaway:', error);
            return false;
        }
    }

    // ========== TICKETS ==========
    
    async createTicket(channelId, ticketData) {
        try {
            const { userId, userName, reason, priority, createdAt, claimedBy, status } = ticketData;
            await this.connection.query(
                `INSERT INTO tickets (channel_id, user_id, user_name, reason, priority, created_at, claimed_by, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [channelId, userId, userName, reason || null, priority || 'medium', createdAt || Date.now(), claimedBy || null, status || 'open']
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
                    status: ticket.status,
                    closedAt: ticket.closed_at,
                    closedBy: ticket.closed_by,
                    closeReason: ticket.close_reason
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
            if (updates.closeReason !== undefined) {
                fields.push('close_reason = ?');
                values.push(updates.closeReason);
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
                status: ticket.status,
                closedAt: ticket.closed_at,
                closedBy: ticket.closed_by,
                closeReason: ticket.close_reason
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
                status: ticket.status
            }));
        } catch (error) {
            console.error('Error getting user tickets:', error);
            return [];
        }
    }

    // ========== JOIN TO CREATE ==========
    
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
            await this.connection.query(
                'INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)',
                [username, passwordHash, role]
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
            const result = await this.connection.query(
                `INSERT INTO suggestions (guild_id, user_id, title, description) 
                 VALUES (?, ?, ?, ?)`,
                [guildId, userId, title, description]
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
                 WHERE suggestion_id = ?`,
                [status, adminResponse, respondedBy, suggestionId]
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

    // ===== AUTOMOD VIOLATIONS =====
    async logAutomodViolation(userId, guildId, violationType, messageContent, channelId, actionTaken) {
        try {
            await this.connection.query(
                `INSERT INTO automod_violations (user_id, guild_id, violation_type, message_content, 
                 channel_id, action_taken) VALUES (?, ?, ?, ?, ?, ?)`,
                [userId, guildId, violationType, messageContent, channelId, actionTaken]
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

    // ===== USER SEARCH & PROFILE =====
    // ===== POLL METHODS =====
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

    // ===== SEARCH & FILTER METHODS =====
    async searchUsers(query, limit = 20) {
        try {
            const results = await this.connection.query(
                `SELECT l.user_id, l.username, l.level, l.xp, l.messages,
                        (SELECT COUNT(*) FROM warns w WHERE w.user_id = l.user_id AND w.type = "WARN") as warn_count,
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
            // Validate userId - Discord IDs are strings of 17-20 digits
            if (!userId || typeof userId !== 'string' || !/^\d{17,20}$/.test(userId)) {
                console.error('Invalid userId format:', userId);
                return null;
            }

            // Get user basic info
            const userInfo = await this.connection.query(
                'SELECT * FROM levels WHERE user_id = ?',
                [userId]
            );

            // Get all warnings
            const warnings = await this.connection.query(
                'SELECT * FROM warns WHERE user_id = ? AND type = "WARN" ORDER BY timestamp DESC',
                [userId]
            );

            // Get ban info
            const banInfo = await this.connection.query(
                'SELECT * FROM user_bans WHERE user_id = ?',
                [userId]
            );

            // Get audit log entries
            const auditLogs = await this.connection.query(
                'SELECT * FROM audit_logs WHERE user_id = ? ORDER BY timestamp DESC LIMIT 50',
                [userId]
            );

            // Get automod violations
            const violations = await this.connection.query(
                'SELECT * FROM automod_violations WHERE user_id = ? ORDER BY timestamp DESC LIMIT 20',
                [userId]
            );

            return {
                user: Array.isArray(userInfo) ? userInfo[0] : userInfo,
                warnings: Array.isArray(warnings) ? warnings : [],
                ban: Array.isArray(banInfo) ? banInfo[0] : null,
                auditLogs: Array.isArray(auditLogs) ? auditLogs : [],
                violations: Array.isArray(violations) ? violations : []
            };
        } catch (error) {
            console.error('Error getting user profile:', error);
            return null;
        }
    }

    // ========== COMPATIBILITY WRAPPERS (Legacy API) ==========

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
            }
        };
    }

    getDatabase(name) {
        if (!this.tempDatabases.has(name)) {
            const data = new Map();
            const db = {
                data,
                get: function(key) { return this.data.get(key); },
                set: function(key, value) { this.data.set(key, value); return value; },
                has: function(key) { return this.data.has(key); },
                delete: function(key) { return this.data.delete(key); },
                ensure: function(key, defaultValue) {
                    if (!this.has(key)) {
                        this.set(key, defaultValue);
                    }
                    return this.get(key);
                },
                all: function() {
                    const obj = {};
                    this.data.forEach((value, key) => obj[key] = value);
                    return obj;
                },
                size: function() { return this.data.size; }
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
        // No cache to clear with MySQL
    }

    async close() {
        await this.connection.close();
    }
}

module.exports = new MySQLDatabaseManager();