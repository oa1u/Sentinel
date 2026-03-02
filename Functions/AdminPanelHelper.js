// Admin panel helpers
// Thin wrappers around the database for admin-panel-related operations
// (bans, timeouts, warnings, kicks, etc.). Keeps API handlers small and
// focused by centralizing DB logic here.

const MySQLDatabaseManager = require('./MySQLDatabaseManager');

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
            const query = 'SELECT id, username, role, created_at, last_login FROM admin_users';
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
            const resolvedCaseId = caseId || `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            return await MySQLDatabaseManager.addCase(userId, resolvedCaseId, {
                reason: reason,
                moderatorId: moderator,
                moderatorName: options.moderatorName || null,
                moderatorSource: options.moderatorSource || null,
                userName: options.userName || null,
                type: 'BAN',
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
                    w.id,
                    w.user_id,
                    w.case_id,
                    w.reason,
                    w.moderator_id,
                    w.created_at,
                    COALESCE(u.username, ma.username) as username
                FROM warns w 
                LEFT JOIN levels u ON w.user_id = u.user_id
                LEFT JOIN (
                    SELECT ma1.user_id, ma1.username
                    FROM member_activity ma1
                    INNER JOIN (
                        SELECT user_id, MAX(timestamp) as max_ts
                        FROM member_activity
                        GROUP BY user_id
                    ) ma2 ON ma1.user_id = ma2.user_id AND ma1.timestamp = ma2.max_ts
                ) ma ON w.user_id = ma.user_id
                WHERE w.type = 'WARN'
                ORDER BY w.created_at DESC
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
            const query = "SELECT COUNT(*) as count FROM warns WHERE (type IS NULL OR type = 'WARN')";
            const [results] = await MySQLDatabaseManager.connection.pool.query(query);
            const row = Array.isArray(results) ? results[0] : null;
            return row?.count || 0;
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
            const query = `
                INSERT INTO timeouts (user_id, case_id, username, reason, issued_by, issued_by_name, issued_by_source, issued_at, expires_at, active)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)
            `;
            await MySQLDatabaseManager.connection.pool.query(query, [
                userId,
                caseId || null,
                username || null,
                reason || null,
                issuedBy || null,
                issuedByName || null,
                issuedBySource || null,
                issuedAt || Date.now(),
                expiresAt || null
            ]);
            return true;
        } catch (err) {
            console.error('[AdminPanelHelper] Error adding timeout:', err.message);
            return false;
        }
    }

    // Adds a kick record to the database.
    static async addKick({ userId, caseId, username, reason, kickedBy, kickedByName, kickedBySource, kickedAt }) {
        try {
            const query = `
                INSERT INTO kicks (user_id, case_id, username, reason, kicked_by, kicked_by_name, kicked_by_source, kicked_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `;
            await MySQLDatabaseManager.connection.pool.query(query, [
                userId,
                caseId || null,
                username || null,
                reason || null,
                kickedBy || null,
                kickedByName || null,
                kickedBySource || null,
                kickedAt || Date.now()
            ]);
            return true;
        } catch (err) {
            console.error('[AdminPanelHelper] Error adding kick:', err.message);
            return false;
        }
    }

    // Gets all active timeouts from the database.
    static async getActiveTimeouts() {
        try {
            const now = Date.now();
            const query = `
                SELECT t.*, u.username, m.username as issued_by_username
                FROM timeouts t
                LEFT JOIN levels u ON t.user_id = u.user_id
                LEFT JOIN levels m ON t.issued_by = m.user_id
                WHERE t.active = TRUE AND (t.expires_at IS NULL OR t.expires_at > ?)
                ORDER BY t.expires_at ASC
                LIMIT 200
            `;
            const [results] = await MySQLDatabaseManager.connection.pool.query(query, [now]);
            return results || [];
        } catch (err) {
            console.error('[AdminPanelHelper] Error getting timeouts:', err.message);
            return [];
        }
    }

    // Clears a timeout for a user in the database.
    static async clearTimeout(userId, { caseId, clearedBy, clearedAt, reason } = {}) {
        try {
            const query = `
                UPDATE timeouts
                SET active = FALSE,
                    cleared_at = ?,
                    cleared_by = ?,
                    cleared_case_id = ?,
                    cleared_reason = ?
                WHERE user_id = ? AND active = TRUE
            `;
            await MySQLDatabaseManager.connection.pool.query(query, [
                clearedAt || Date.now(),
                clearedBy || null,
                caseId || null,
                reason || null,
                userId
            ]);
            return true;
        } catch (err) {
            console.error('[AdminPanelHelper] Error clearing timeout:', err.message);
            return false;
        }
    }

    static async getActiveTimeoutsCount() {
        try {
            const now = Date.now();
            const query = 'SELECT COUNT(*) as count FROM timeouts WHERE active = TRUE AND (expires_at IS NULL OR expires_at > ?)';
            const [results] = await MySQLDatabaseManager.connection.pool.query(query, [now]);
            return results?.[0]?.count || 0;
        } catch (err) {
            console.error('[AdminPanelHelper] Error counting timeouts:', err.message);
            return 0;
        }
    }

    // Gets recent moderation actions from the database.
    static async getRecentModerationActions(limit = 15) {
        try {
            // Use UNION to combine all moderation actions and get the most recent ones
            const query = `
                SELECT 
                    user_id,
                    reason,
                    timestamp,
                    moderator_id,
                    user_name,
                    moderator_name,
                    moderator_source,
                    action,
                    case_id
                FROM (
                    SELECT 
                        CONVERT(CAST(w.user_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as user_id,
                        CONVERT(CAST(w.reason AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as reason,
                        CAST(FROM_UNIXTIME(w.timestamp/1000) AS DATETIME) as timestamp,
                        CONVERT(CAST(w.moderator_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_id,
                        CONVERT(CAST(COALESCE(w.user_name, ui.username, u.username, w.user_id) AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as user_name,
                        CONVERT(CAST(CASE WHEN w.moderator_source = 'panel' THEN w.moderator_name ELSE COALESCE(m_ui.username, m.username, w.moderator_id, 'System') END AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_name,
                        CONVERT(COALESCE(w.moderator_source, 'discord') USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_source,
                        CONVERT('WARN' USING utf8mb4) COLLATE utf8mb4_unicode_ci as action,
                        CONVERT(CAST(w.case_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as case_id
                    FROM warns w
                    LEFT JOIN userinfo ui ON ui.user_id = CAST(w.user_id AS UNSIGNED)
                    LEFT JOIN levels u ON u.user_id COLLATE utf8mb4_unicode_ci = w.user_id COLLATE utf8mb4_unicode_ci
                    LEFT JOIN userinfo m_ui ON m_ui.user_id = CAST(w.moderator_id AS UNSIGNED)
                    LEFT JOIN levels m ON m.user_id COLLATE utf8mb4_unicode_ci = w.moderator_id COLLATE utf8mb4_unicode_ci
                    WHERE (w.type IS NULL OR w.type = 'WARN')
                        AND w.reason NOT LIKE '%(timeout%'
                        AND w.reason NOT LIKE '%(untimeout)%'
                    
                    UNION ALL
                    
                    SELECT 
                        CONVERT(CAST(b.user_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as user_id,
                        CONVERT(CAST(b.ban_reason AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as reason,
                        CAST(b.banned_at AS DATETIME) as timestamp,
                        CONVERT(CAST(b.banned_by AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_id,
                        CONVERT(CAST(COALESCE(b.user_name, ui.username, u.username, b.user_id) AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as user_name,
                        CONVERT(CAST(CASE WHEN b.banned_by_source = 'panel' THEN b.banned_by_name ELSE COALESCE(m_ui.username, m.username, b.banned_by, 'System') END AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_name,
                        CONVERT(COALESCE(b.banned_by_source, 'discord') USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_source,
                        CONVERT('BAN' USING utf8mb4) COLLATE utf8mb4_unicode_ci as action,
                        CONVERT(CAST(b.ban_case_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as case_id
                    FROM user_bans b
                    LEFT JOIN userinfo ui ON ui.user_id = CAST(b.user_id AS UNSIGNED)
                    LEFT JOIN levels u ON u.user_id COLLATE utf8mb4_unicode_ci = b.user_id COLLATE utf8mb4_unicode_ci
                    LEFT JOIN userinfo m_ui ON m_ui.user_id = CAST(b.banned_by AS UNSIGNED)
                    LEFT JOIN levels m ON m.user_id COLLATE utf8mb4_unicode_ci = b.banned_by COLLATE utf8mb4_unicode_ci
                    WHERE b.ban_case_id IS NOT NULL
                    
                    UNION ALL

                    SELECT 
                        CONVERT(CAST(ub.user_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as user_id,
                        CONVERT(CAST(COALESCE(ub.reason, ub.original_ban_reason, 'Unbanned') AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as reason,
                        CAST(ub.unbanned_at AS DATETIME) as timestamp,
                        CONVERT(CAST(ub.unbanned_by AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_id,
                        CONVERT(CAST(COALESCE(ub.user_name, ui.username, u.username, ub.user_id) AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as user_name,
                        CONVERT(CAST(CASE WHEN ub.unbanned_by_source = 'panel' THEN ub.unbanned_by_name ELSE COALESCE(ub.unbanned_by, 'System') END AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_name,
                        CONVERT(COALESCE(ub.unbanned_by_source, 'discord') USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_source,
                        CONVERT('UNBAN' USING utf8mb4) COLLATE utf8mb4_unicode_ci as action,
                        CONVERT(CAST(ub.unban_case_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as case_id
                    FROM unbans ub
                    LEFT JOIN userinfo ui ON ui.user_id = CAST(ub.user_id AS UNSIGNED)
                    LEFT JOIN levels u ON u.user_id COLLATE utf8mb4_unicode_ci = ub.user_id COLLATE utf8mb4_unicode_ci

                    UNION ALL
                    
                    SELECT 
                        CONVERT(CAST(t.user_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as user_id,
                        CONVERT(CAST(t.reason AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as reason,
                        CAST(FROM_UNIXTIME(t.issued_at/1000) AS DATETIME) as timestamp,
                        CONVERT(CAST(t.issued_by AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_id,
                        CONVERT(CAST(COALESCE(t.username, ui.username, u.username, t.user_id) AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as user_name,
                        CONVERT(CAST(CASE WHEN t.issued_by_source = 'panel' THEN t.issued_by_name ELSE COALESCE(m_ui.username, m.username, t.issued_by, 'System') END AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_name,
                        CONVERT(COALESCE(t.issued_by_source, 'discord') USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_source,
                        CONVERT('TIMEOUT' USING utf8mb4) COLLATE utf8mb4_unicode_ci as action,
                        CONVERT(CAST(t.case_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as case_id
                    FROM timeouts t
                    LEFT JOIN userinfo ui ON ui.user_id = CAST(t.user_id AS UNSIGNED)
                    LEFT JOIN levels u ON u.user_id COLLATE utf8mb4_unicode_ci = t.user_id COLLATE utf8mb4_unicode_ci
                    LEFT JOIN userinfo m_ui ON m_ui.user_id = CAST(t.issued_by AS UNSIGNED)
                    LEFT JOIN levels m ON m.user_id COLLATE utf8mb4_unicode_ci = t.issued_by COLLATE utf8mb4_unicode_ci
                    
                    UNION ALL
                    
                    SELECT 
                        CONVERT(CAST(w.user_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as user_id,
                        CONVERT(CAST(w.reason AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as reason,
                        CAST(FROM_UNIXTIME(w.timestamp/1000) AS DATETIME) as timestamp,
                        CONVERT(CAST(w.moderator_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_id,
                        CONVERT(CAST(COALESCE(w.user_name, ui.username, u.username, w.user_id) AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as user_name,
                        CONVERT(CAST(CASE WHEN w.moderator_source = 'panel' THEN w.moderator_name ELSE COALESCE(m_ui.username, m.username, w.moderator_id, 'System') END AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_name,
                        CONVERT(COALESCE(w.moderator_source, 'discord') USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_source,
                        CONVERT('UNTIMEOUT' USING utf8mb4) COLLATE utf8mb4_unicode_ci as action,
                        CONVERT(CAST(w.case_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as case_id
                    FROM warns w
                    LEFT JOIN userinfo ui ON ui.user_id = CAST(w.user_id AS UNSIGNED)
                    LEFT JOIN levels u ON u.user_id COLLATE utf8mb4_unicode_ci = w.user_id COLLATE utf8mb4_unicode_ci
                    LEFT JOIN userinfo m_ui ON m_ui.user_id = CAST(w.moderator_id AS UNSIGNED)
                    LEFT JOIN levels m ON m.user_id COLLATE utf8mb4_unicode_ci = w.moderator_id COLLATE utf8mb4_unicode_ci
                    WHERE w.reason LIKE '%(untimeout)%'

                    UNION ALL

                    SELECT 
                        CONVERT(CAST(k.user_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as user_id,
                        CONVERT(CAST(k.reason AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as reason,
                        CAST(FROM_UNIXTIME(k.kicked_at/1000) AS DATETIME) as timestamp,
                        CONVERT(CAST(k.kicked_by AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_id,
                        CONVERT(CAST(COALESCE(k.username, ui.username, u.username, k.user_id) AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as user_name,
                        CONVERT(CAST(CASE WHEN k.kicked_by_source = 'panel' THEN k.kicked_by_name ELSE COALESCE(m_ui.username, m.username, k.kicked_by, 'System') END AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_name,
                        CONVERT(COALESCE(k.kicked_by_source, 'discord') USING utf8mb4) COLLATE utf8mb4_unicode_ci as moderator_source,
                        CONVERT('KICK' USING utf8mb4) COLLATE utf8mb4_unicode_ci as action,
                        CONVERT(CAST(k.case_id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci as case_id
                    FROM kicks k
                    LEFT JOIN userinfo ui ON ui.user_id = CAST(k.user_id AS UNSIGNED)
                    LEFT JOIN levels u ON u.user_id COLLATE utf8mb4_unicode_ci = k.user_id COLLATE utf8mb4_unicode_ci
                    LEFT JOIN userinfo m_ui ON m_ui.user_id = CAST(k.kicked_by AS UNSIGNED)
                    LEFT JOIN levels m ON m.user_id COLLATE utf8mb4_unicode_ci = k.kicked_by COLLATE utf8mb4_unicode_ci
                ) combined
                ORDER BY timestamp DESC
                LIMIT ?
            `;
            const [rows] = await MySQLDatabaseManager.connection.pool.query(query, [limit]);

            // Map results to action objects
            const actions = (rows || []).map(row => ({
                timestamp: row.timestamp,
                action: row.action,
                userId: row.user_id,
                username: row.user_name,
                moderatorId: row.moderator_id,
                moderatorName: row.moderator_name,
                moderatorSource: row.moderator_source,
                reason: row.reason,
                caseId: row.case_id
            }));

            // Results are already sorted by timestamp DESC and limited, return as-is
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

            if (status) {
                query += ' WHERE status = ?';
                params.push(status);
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
    static async claimTicket(channelId, claimedBy) {
        try {
            if (!channelId) return false;
            const updates = {
                claimedBy: claimedBy || null,
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
            const query = `
                SELECT * FROM warns 
                WHERE user_id = ? AND type = "WARN"
                ORDER BY created_at DESC
            `;
            const [results] = await MySQLDatabaseManager.connection.pool.query(query, [userId]);
            return results || [];
        } catch (err) {
            console.error('[AdminPanelHelper] Error getting user warnings:', err.message);
            return [];
        }
    }

    // Clears user warnings from the database.
    static async clearUserWarns(userId) {
        try {
            const query = 'DELETE FROM warns WHERE user_id = ?';
            await MySQLDatabaseManager.connection.pool.query(query, [userId]);
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

    // Exposes MySQL connection for direct queries (owner-only operations).
    static get connection() {
        return MySQLDatabaseManager.connection;
    }
}

module.exports = AdminPanelHelper;