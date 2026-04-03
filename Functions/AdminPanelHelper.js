const MySQLDatabaseManager = require('./MySQLDatabaseManager');
const { generateCaseId } = require('../Events/caseId');

class AdminPanelHelper {
    // Get admin user by username
    static async getAdminUser(username) {
        try {
            const query = 'SELECT * FROM admin_users WHERE username = ?';
            const [results] = await MySQLDatabaseManager.connection.pool.query(query, [username]);
            return results[0] || null;
        } catch (err) {
            console.error('[AdminPanelHelper] Error getting admin user:', err.message);
            return null;
        }
    }

    // Get admin user by ID
    static async getAdminUserById(userId) {
        try {
            const query = 'SELECT * FROM admin_users WHERE id = ?';
            const [results] = await MySQLDatabaseManager.connection.pool.query(query, [userId]);
            return results[0] || null;
        } catch (err) {
            console.error('[AdminPanelHelper] Error getting admin user by ID:', err.message);
            return null;
        }
    }

    // Get all admin users
    static async getAllAdminUsers() {
        try {
            const query = 'SELECT id, username, role, created_at, last_login, avatar_url, avatar_updated_at, discord_user_id, discord_username, discord_linked_at FROM admin_users';
            const [results] = await MySQLDatabaseManager.connection.pool.query(query);
            return results || [];
        } catch (err) {
            console.error('[AdminPanelHelper] Error getting all admin users:', err.message);
            return [];
        }
    }

    // Count admin users
    static async getAdminUsersCount() {
        try {
            const query = 'SELECT COUNT(*) as count FROM admin_users';
            const [results] = await MySQLDatabaseManager.connection.pool.query(query);
            return results[0]?.count || 0;
        } catch (err) {
            console.error('[AdminPanelHelper] Error counting admin users:', err.message);
            return 0;
        }
    }

    // Add warning to user
    static async addWarn(userId, reason, moderator, caseId, options = {}) {
        try {
            return await MySQLDatabaseManager.addCase(userId, caseId, {
                reason: reason,
                moderatorId: moderator,
                moderatorName: options.moderatorName || null,
                moderatorSource: options.moderatorSource || null,
                userName: options.userName || null,
                type: 'WARN',
                timestamp: Date.now()
            });
        } catch (err) {
            console.error('[AdminPanelHelper] Error adding warning:', err.message);
            return false;
        }
    }

    // Ban user
    static async banUser(userId, reason, moderator, caseId, options = {}) {
        try {
            const resolvedCaseId = caseId || generateCaseId('BAN');
            return await MySQLDatabaseManager.addCase(userId, resolvedCaseId, {
                reason: reason,
                moderatorId: moderator,
                moderatorName: options.moderatorName || null,
                moderatorSource: options.moderatorSource || null,
                userName: options.userName || null,
                type: 'BAN',
                guildId: options.guildId || null,
                source: options.source || 'panel',
                timestamp: Date.now()
            });
        } catch (err) {
            console.error('[AdminPanelHelper] Error banning user:', err.message);
            return false;
        }
    }

    // Unban user
    static async unbanUser(userId) {
        try {
            const query = 'UPDATE user_bans SET banned = FALSE WHERE user_id = ?';
            const result = await MySQLDatabaseManager.connection.pool.query(query, [userId]);

            const affectedRows = Array.isArray(result)
                ? (result[0]?.affectedRows ?? result[0]?.changedRows ?? 0)
                : (result?.affectedRows ?? result?.changedRows ?? 0);

            return affectedRows > 0;
        } catch (err) {
            console.error('[AdminPanelHelper] Error unbanning user:', err.message);
            return false;
        }
    }

    // Get all warnings
    static async getAllWarns() {
        try {
            const query = `
                SELECT 
                    mc.case_id,
                    mc.user_id,
                    mc.reason,
                    mc.moderator_id,
                    mc.moderator_name,
                    mc.status,
                    mc.created_at,
                    COALESCE(mc.user_name, u.username, ma.username, mc.user_id) as username
                FROM moderation_cases mc
                LEFT JOIN levels u ON u.user_id COLLATE utf8mb4_unicode_ci = mc.user_id COLLATE utf8mb4_unicode_ci
                LEFT JOIN (
                    SELECT ma1.user_id, ma1.username
                    FROM member_activity ma1
                    INNER JOIN (
                        SELECT user_id, MAX(timestamp) as max_ts
                        FROM member_activity
                        GROUP BY user_id
                    ) ma2 ON ma1.user_id = ma2.user_id AND ma1.timestamp = ma2.max_ts
                ) ma ON ma.user_id = mc.user_id
                WHERE mc.action_type = 'WARN' AND mc.status NOT IN ('cleared', 'reversed')
                ORDER BY mc.created_at DESC
                LIMIT 1000
            `;
            const [results] = await MySQLDatabaseManager.connection.pool.query(query);
            return results || [];
        } catch (err) {
            console.error('[AdminPanelHelper] Error getting all warnings:', err.message);
            return [];
        }
    }

    static async getWarnsCount() {
        try {
            return await MySQLDatabaseManager.getWarnsCount();
        } catch (err) {
            console.error('[AdminPanelHelper] Error getting warnings count:', err.message);
            return 0;
        }
    }

    // Gets all levels from the database.
    static async getAllLevels(limit = 500, offset = 0) {
        try {
            const query = 'SELECT * FROM levels ORDER BY xp DESC LIMIT ? OFFSET ?';
            const [results] = await MySQLDatabaseManager.connection.pool.query(query, [limit, offset]);
            return results || [];
        } catch (err) {
            console.error('[AdminPanelHelper] Error getting all levels:', err.message);
            return [];
        }
    }

    // Reset all users' levels
    static async resetAllUsersLevels() {
        try {
            const query = 'UPDATE levels SET level = 1, xp = 0, total_xp = 0';
            const [result] = await MySQLDatabaseManager.connection.pool.query(query);
            return result.affectedRows;
        } catch (err) {
            console.error('[AdminPanelHelper] Error resetting levels:', err.message);
            throw err;
        }
    }

    // Gets all banned users from the database.
    static async getAllBannedUsers() {
        try {
            const query = `
                SELECT ub.*, l.username, m.username as banned_by_username
                FROM user_bans ub
                LEFT JOIN levels l ON ub.user_id = l.user_id
                LEFT JOIN levels m ON ub.banned_by = m.user_id
                WHERE ub.banned = TRUE
            `;
            const [results] = await MySQLDatabaseManager.connection.pool.query(query);
            return results || [];
        } catch (err) {
            console.error('[AdminPanelHelper] Error getting banned users:', err.message);
            return [];
        }
    }

    // Gets all reminders from the database.
    static async getAllReminders() {
        try {
            const query = 'SELECT * FROM reminders WHERE completed = FALSE ORDER BY trigger_at ASC LIMIT 100';
            const results = await MySQLDatabaseManager.connection.query(query);
            return results || [];
        } catch (err) {
            console.error('[AdminPanelHelper] Error getting reminders:', err.message);
            return [];
        }
    }

    // Adds a timeout record to the database.
    static async addTimeout({ userId, caseId, username, reason, issuedBy, issuedByName, issuedBySource, issuedAt, expiresAt }) {
        try {
            await MySQLDatabaseManager.upsertModerationCase({
                caseId,
                guildId: null,
                userId,
                userName: username || null,
                actionType: 'TIMEOUT',
                status: 'active',
                reason: reason || null,
                moderatorId: issuedBy || null,
                moderatorName: issuedByName || null,
                moderatorSource: issuedBySource || null,
                source: issuedBySource || 'panel',
                expiresAt: expiresAt || null,
                createdAt: issuedAt || Date.now(),
                updatedAt: issuedAt || Date.now(),
                eventSummary: 'Timeout case recorded'
            });
            MySQLDatabaseManager.invalidateModerationUserCaches(userId);
            return true;
        } catch (err) {
            console.error('[AdminPanelHelper] Error adding timeout:', err.message);
            return false;
        }
    }

    // Adds a kick record to the database.
    static async addKick({ userId, caseId, username, reason, kickedBy, kickedByName, kickedBySource, kickedAt }) {
        try {
            await MySQLDatabaseManager.upsertModerationCase({
                caseId,
                guildId: null,
                userId,
                userName: username || null,
                actionType: 'KICK',
                status: 'closed',
                reason: reason || null,
                moderatorId: kickedBy || null,
                moderatorName: kickedByName || null,
                moderatorSource: kickedBySource || null,
                source: kickedBySource || 'panel',
                createdAt: kickedAt || Date.now(),
                updatedAt: kickedAt || Date.now(),
                eventSummary: 'Kick case recorded'
            });
            MySQLDatabaseManager.invalidateModerationUserCaches(userId);
            return true;
        } catch (err) {
            console.error('[AdminPanelHelper] Error adding kick:', err.message);
            return false;
        }
    }

    // Gets all active timeouts from the database.
    static async getActiveTimeouts() {
        try {
            const results = await MySQLDatabaseManager.getActiveTimeoutCases({ limit: 200 });
            return (results || []).map((row) => ({
                ...row,
                username: row.user_name || null,
                issued_by: row.moderator_id || null,
                issued_by_name: row.moderator_name || null,
                issued_by_username: row.moderator_name || null,
                active: row.effective_status === 'active'
            }));
        } catch (err) {
            console.error('[AdminPanelHelper] Error getting timeouts:', err.message);
            return [];
        }
    }

    // Clears a timeout for a user in the database.
    static async clearTimeout(userId, { caseId, clearedBy, clearedAt, reason } = {}) {
        try {
            const originalCase = await MySQLDatabaseManager.getLatestActiveTimeoutCaseForUser(userId);
            const originalCaseId = originalCase?.case_id ? String(originalCase.case_id) : null;
            if (originalCaseId) {
                await MySQLDatabaseManager.updateModerationCaseStatus(originalCaseId, 'cleared', {
                    actorId: clearedBy || null,
                    relatedCaseId: caseId || null,
                    details: reason || 'Timeout cleared',
                    updatedAt: clearedAt || Date.now()
                });
            }

            if (caseId) {
                await MySQLDatabaseManager.upsertModerationCase({
                    caseId,
                    guildId: originalCase?.guild_id || null,
                    userId,
                    userName: originalCase?.user_name || null,
                    actionType: 'UNTIMEOUT',
                    status: 'closed',
                    reason: reason || null,
                    moderatorId: clearedBy || null,
                    moderatorName: typeof clearedBy === 'string' ? clearedBy : null,
                    moderatorSource: 'panel',
                    source: 'panel',
                    relatedCaseId: originalCaseId,
                    rootCaseId: originalCaseId || caseId,
                    createdAt: clearedAt || Date.now(),
                    updatedAt: clearedAt || Date.now(),
                    eventSummary: 'Untimeout case recorded'
                });
            }
            MySQLDatabaseManager.invalidateModerationUserCaches(userId);
            return true;
        } catch (err) {
            console.error('[AdminPanelHelper] Error clearing timeout:', err.message);
            return false;
        }
    }

    static async getActiveTimeoutsCount() {
        try {
            const query = `
                SELECT COUNT(*) as count
                FROM moderation_cases
                WHERE action_type = 'TIMEOUT'
                  AND status = 'active'
                  AND (expires_at IS NULL OR expires_at > ?)
            `;
            const [results] = await MySQLDatabaseManager.connection.pool.query(query, [Date.now()]);
            return results?.[0]?.count || 0;
        } catch (err) {
            console.error('[AdminPanelHelper] Error counting timeouts:', err.message);
            return 0;
        }
    }

    // Gets recent moderation actions from the database.
    static async getRecentModerationActions(limit = 15) {
        try {
            const query = `
                SELECT 
                    mc.user_id,
                    mc.reason,
                    mc.created_at as timestamp,
                    mc.moderator_id,
                    COALESCE(mc.user_name, ui.username, u.username, mc.user_id) as user_name,
                    COALESCE(mc.moderator_name, m_ui.username, m.username, mc.moderator_id, 'System') as moderator_name,
                    COALESCE(mc.moderator_source, mc.source, 'discord') as moderator_source,
                    mc.action_type as action,
                    mc.case_id,
                    ui.avatar as user_avatar
                FROM moderation_cases mc
                LEFT JOIN userinfo ui ON ui.user_id = CAST(mc.user_id AS UNSIGNED)
                LEFT JOIN levels u ON u.user_id COLLATE utf8mb4_unicode_ci = mc.user_id COLLATE utf8mb4_unicode_ci
                LEFT JOIN userinfo m_ui ON m_ui.user_id = CAST(mc.moderator_id AS UNSIGNED)
                LEFT JOIN levels m ON m.user_id COLLATE utf8mb4_unicode_ci = mc.moderator_id COLLATE utf8mb4_unicode_ci
                ORDER BY mc.created_at DESC
                LIMIT ?
            `;
            const [rows] = await MySQLDatabaseManager.connection.pool.query(query, [limit]);

            // Map results to normalized action objects with both snake_case and camelCase keys
            // so older/newer callers remain compatible.
            const actions = (rows || []).map((row) => {
                let timestampMs = null;
                if (row.timestamp instanceof Date) {
                    timestampMs = row.timestamp.getTime();
                } else {
                    const raw = row.timestamp;
                    const numeric = Number(raw);
                    if (Number.isFinite(numeric) && numeric > 0) {
                        timestampMs = numeric > 10_000_000_000 ? numeric : numeric * 1000;
                    } else {
                        const parsed = Date.parse(raw);
                        timestampMs = Number.isNaN(parsed) ? null : parsed;
                    }
                }

                const action = {
                    action: row.action,
                    reason: row.reason,
                    case_id: row.case_id,
                    caseId: row.case_id,
                    timestamp: timestampMs || row.timestamp || null,
                    timestamp_ms: timestampMs,

                    user_id: row.user_id,
                    user_name: row.user_name,
                    moderator_id: row.moderator_id,
                    moderator_name: row.moderator_name,
                    moderator_source: row.moderator_source,

                    userId: row.user_id,
                    username: row.user_name,
                    moderatorId: row.moderator_id,
                    moderatorName: row.moderator_name,
                    moderatorSource: row.moderator_source,

                    userAvatar: row.user_avatar,
                    user_avatar: row.user_avatar
                };

                return action;
            });


            return actions;
        } catch (err) {
            console.error('[AdminPanelHelper] Error getting recent actions:', err.message);
            return [];
        }
    }

    // Gets the count of active giveaways.
    static async getGiveawaysCount() {
        try {
            // Count giveaways that haven't ended
            const query = 'SELECT COUNT(*) as count FROM giveaways WHERE ended = FALSE';
            const [results] = await MySQLDatabaseManager.connection.pool.query(query).catch(() => [null]);
            return results?.[0]?.count || 0;
        } catch (err) {
            console.warn('[AdminPanelHelper] Giveaways table may not exist:', err.message);
            return 0;
        }
    }

    // Gets the total count of giveaways.
    static async getTotalGiveawaysCount() {
        try {
            const query = 'SELECT COUNT(*) as count FROM giveaways';
            const [results] = await MySQLDatabaseManager.connection.pool.query(query).catch(() => [null]);
            return results?.[0]?.count || 0;
        } catch (err) {
            console.warn('[AdminPanelHelper] Giveaways table may not exist:', err.message);
            return 0;
        }
    }

    // Gets all tickets from the database.
    static async getAllTickets(status = null) {
        try {
            let query = 'SELECT * FROM tickets';
            const params = [];
            const normalizedStatus = status && status !== 'all' ? status : null;

            if (normalizedStatus) {
                query += ' WHERE status = ?';
                params.push(normalizedStatus);
            }

            query += ' ORDER BY created_at DESC LIMIT 100';
            const [results] = await MySQLDatabaseManager.connection.pool.query(query, params);
            return results || [];
        } catch (err) {
            console.warn('[AdminPanelHelper] Tickets table may not exist:', err.message);
            return [];
        }
    }

    // Gets all active tickets (open or claimed, but not closed).
    static async getActiveTickets() {
        try {
            const query = 'SELECT * FROM tickets WHERE status != ? ORDER BY created_at DESC LIMIT 100';
            const [results] = await MySQLDatabaseManager.connection.pool.query(query, ['closed']);
            return results || [];
        } catch (err) {
            console.warn('[AdminPanelHelper] Tickets table may not exist:', err.message);
            return [];
        }
    }

    // Claims a ticket in the database.
    static async claimTicket(channelId, claimedBy, claimedByName = null) {
        try {
            if (!channelId) return false;
            const updates = {
                claimedBy: claimedBy || null,
                claimedByName: claimedByName || claimedBy || null,
                status: 'claimed'
            };
            return await MySQLDatabaseManager.updateTicket(channelId, updates);
        } catch (err) {
            console.error('[AdminPanelHelper] Error claiming ticket:', err.message);
            return false;
        }
    }

    // Updates an admin user in the database.
    static async updateAdminUser(userId, updates) {
        try {
            const fields = [];
            const values = [];

            if (updates.username) {
                fields.push('username = ?');
                values.push(updates.username);
            }
            if (updates.role) {
                fields.push('role = ?');
                values.push(updates.role);
            }

            if (fields.length === 0) return true;

            values.push(userId);
            const query = `UPDATE admin_users SET ${fields.join(', ')} WHERE id = ?`;
            await MySQLDatabaseManager.connection.pool.query(query, values);
            return true;
        } catch (err) {
            console.error('[AdminPanelHelper] Error updating admin user:', err.message);
            return false;
        }
    }

    // Updates the last login for an admin user.
    static async updateLastLogin(username) {
        try {
            const query = 'UPDATE admin_users SET last_login = NOW() WHERE username = ?';
            await MySQLDatabaseManager.connection.pool.query(query, [username]);
            return true;
        } catch (err) {
            console.error('[AdminPanelHelper] Error updating last login:', err.message);
            return false;
        }
    }

    // Creates an admin user account.
    static async createAdminUser(username, passwordHash, role = 'moderator', email = null) {
        try {
            const query = `
                INSERT INTO admin_users (username, email, password_hash, role, created_at, password_changed_at)
                VALUES (?, ?, ?, ?, NOW(), NOW())
            `;
            await MySQLDatabaseManager.connection.pool.query(query, [username, email, passwordHash, role]);
            return true;
        } catch (err) {
            console.error('[AdminPanelHelper] Error creating admin user:', err.message);
            return false;
        }
    }

    // Deletes an admin user from the database.
    static async deleteAdminUser(userId) {
        try {
            const query = 'DELETE FROM admin_users WHERE id = ?';
            await MySQLDatabaseManager.connection.pool.query(query, [userId]);
            return true;
        } catch (err) {
            console.error('[AdminPanelHelper] Error deleting admin user:', err.message);
            return false;
        }
    }

    // Gets user warnings with details.
    static async getUserWarns(userId) {
        try {
            return await MySQLDatabaseManager.getUserModerationCases(userId, {
                actionTypes: ['WARN'],
                excludeStatuses: ['cleared', 'reversed'],
                limit: 200
            });
        } catch (err) {
            console.error('[AdminPanelHelper] Error getting user warnings:', err.message);
            return [];
        }
    }

    // Clears user warnings from the database.
    static async clearUserWarns(userId) {
        try {
            await MySQLDatabaseManager.clearAllWarningCases(userId, {
                actorName: 'Admin Panel',
                details: 'Warnings cleared via admin panel',
                updatedAt: Date.now()
            });
            return true;
        } catch (err) {
            console.error('[AdminPanelHelper] Error clearing user warnings:', err.message);
            return false;
        }
    }

    // Gets server statistics from the database.
    static async getServerStats() {
        try {
            const results = await Promise.all([
                this.getAllLevels().then(l => l.length),
                this.getAllWarns().then(w => w.length),
                this.getAllBannedUsers().then(b => b.length),
                this.getAllReminders().then(r => r.length)
            ]);

            return {
                totalUsers: results[0],
                totalWarnings: results[1],
                bannedUsers: results[2],
                activeReminders: results[3]
            };
        } catch (err) {
            console.error('[AdminPanelHelper] Error getting server stats:', err.message);
            return {
                totalUsers: 0,
                totalWarnings: 0,
                bannedUsers: 0,
                activeReminders: 0
            };
        }
    }

    // Gets user level data from the database.
    static async getUserLevel(userId) {
        try {
            if (!userId) return null;
            const levels = await this.getAllLevels();
            return levels.find(l => l.user_id === userId) || { xp: 0, level: 1 };
        } catch (err) {
            console.error('[AdminPanelHelper] Error getting user level:', err.message);
            return { xp: 0, level: 1 };
        }
    }

    // Gets user reminders from the database.
    static async getUserReminders(userId) {
        try {
            if (!userId) return [];
            const reminders = await this.getAllReminders();
            return reminders.filter(r => r.user_id === userId) || [];
        } catch (err) {
            console.error('[AdminPanelHelper] Error getting user reminders:', err.message);
            return [];
        }
    }

    // Gets all suggestions from the database.
    static async getAllSuggestions(limit = 50) {
        try {
            return await MySQLDatabaseManager.getAllSuggestions(limit);
        } catch (err) {
            console.error('[AdminPanelHelper] Error getting suggestions:', err.message);
            return [];
        }
    }

    // Gets all ghost pings from the database.
    static async getAllGhostPings(limit = 50) {
        try {
            return await MySQLDatabaseManager.getAllGhostPings(limit);
        } catch (err) {
            console.error('[AdminPanelHelper] Error getting ghost pings:', err.message);
            return [];
        }
    }


    static get connection() {
        return MySQLDatabaseManager.connection;
    }
}

module.exports = AdminPanelHelper;