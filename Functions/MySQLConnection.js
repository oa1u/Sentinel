const mysql = require('mysql2/promise');
const path = require('path');

// Load MySQL credentials from `Config/credentials.env` so the DB connection
// can be created using environment variables. This keeps secrets out of
// source control and makes local/dev setups easier.
require('dotenv').config({
    path: path.join(__dirname, '..', 'Config', 'credentials.env'),
    override: false,
    debug: false,
    quiet: true
});

class MySQLConnection {
    constructor() {
        this.pool = null;
        this.isConnected = false;
        this.maxConnectRetries = Math.max(0, parseInt(process.env.MYSQL_CONNECT_RETRIES || '2'));
        this.connectRetryDelayMs = Math.max(250, parseInt(process.env.MYSQL_CONNECT_RETRY_DELAY_MS || '1500'));
        this.queryRetryAttempts = Math.max(0, parseInt(process.env.MYSQL_QUERY_RETRY_ATTEMPTS || '1'));
        this.queryRetryDelayMs = Math.max(100, parseInt(process.env.MYSQL_QUERY_RETRY_DELAY_MS || '250'));
        this.slowQueryThresholdMs = Math.max(0, parseInt(process.env.MYSQL_SLOW_QUERY_MS || '1500'));
        this.lastHealthCheckAt = null;
        this.lastHealthCheckLatencyMs = null;
        this.connectionConfig = {
            host: process.env.MYSQL_HOST || 'localhost',
            port: parseInt(process.env.MYSQL_PORT) || 3306,
            user: process.env.MYSQL_USER || 'root',
            password: process.env.MYSQL_PASSWORD || '',
            database: process.env.MYSQL_DATABASE || 'discord_bot',
            connectionLimit: parseInt(process.env.MYSQL_CONNECTION_LIMIT) || 10,
            queueLimit: parseInt(process.env.MYSQL_QUEUE_LIMIT) || 0,
            waitForConnections: true,
            enableKeepAlive: true,
            keepAliveInitialDelay: 0,
            connectTimeout: 10000
        };
    }

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    isTransientMySQLError(error) {
        const transientCodes = new Set([
            'PROTOCOL_CONNECTION_LOST',
            'ECONNRESET',
            'ECONNREFUSED',
            'ETIMEDOUT',
            'ER_LOCK_DEADLOCK',
            'ER_LOCK_WAIT_TIMEOUT'
        ]);

        const code = error?.code;
        const message = String(error?.message || '').toLowerCase();
        if (code && transientCodes.has(code)) return true;
        return message.includes('deadlock') || message.includes('lock wait timeout') || message.includes('connection lost');
    }

    async connect() {
        if (this.isConnected && this.pool) {
            return true;
        }

        const maxAttempts = this.maxConnectRetries + 1;
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                this.pool = mysql.createPool(this.connectionConfig);

                const connection = await this.pool.getConnection();
                await connection.ping();
                connection.release();

                this.isConnected = true;
                await this.initializeTables();
                console.log(`✅ MySQL Connected Successfully${attempt > 1 ? ` (attempt ${attempt}/${maxAttempts})` : ''}`);
                return true;
            } catch (error) {
                lastError = error;
                this.isConnected = false;
                console.error(`❌ MySQL Connection Failed (attempt ${attempt}/${maxAttempts}):`, error.message);

                if (this.pool) {
                    try {
                        await this.pool.end();
                    } catch {
                    }
                }
                this.pool = null;

                if (attempt < maxAttempts) {
                    await this.delay(this.connectRetryDelayMs * attempt);
                }
            }
        }

        console.error('❌ MySQL Connection Failed:', lastError?.message || 'Unknown error');
        return false;
    }

    async initializeTables() {
        try {
            // Create the userinfo table for storing user data if it doesn't exist yet.
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS userinfo (
                    user_id BIGINT UNSIGNED PRIMARY KEY,
                    username VARCHAR(255),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    is_bot BOOLEAN DEFAULT FALSE,
                    INDEX idx_username (username)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            // Add missing userinfo profile columns (migration)
            const userInfoColumnsToAdd = [
                { name: 'nickname', type: 'VARCHAR(255) DEFAULT NULL' },
                { name: 'bio', type: 'TEXT DEFAULT NULL' },
                { name: 'avatar', type: 'VARCHAR(512) DEFAULT NULL' },
                { name: 'message_streak', type: 'INT NOT NULL DEFAULT 0' },
                { name: 'message_streak_best', type: 'INT NOT NULL DEFAULT 0' },
                { name: 'message_streak_last_day', type: 'BIGINT DEFAULT NULL' },
                { name: 'timezone', type: 'VARCHAR(64) DEFAULT NULL' },
                { name: 'profile_sync_enabled', type: 'TINYINT(1) NOT NULL DEFAULT 0' },
                { name: 'profile_last_selected_at', type: 'BIGINT DEFAULT NULL' },
                { name: 'profile_last_synced_at', type: 'BIGINT DEFAULT NULL' }
            ];
            for (const col of userInfoColumnsToAdd) {
                try {
                    await this.pool.execute(`
                        ALTER TABLE userinfo ADD COLUMN ${col.name} ${col.type}
                    `);
                } catch (err) {
                    if (err.code === 'ER_DUP_FIELDNAME') {
                        // Column already exists, skip
                    } else {
                        console.error(`Error adding column ${col.name} to userinfo:`, err.message);
                    }
                }
            }

            // Create levels table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS levels (
                    user_id VARCHAR(20) PRIMARY KEY,
                    username VARCHAR(32),
                    xp INT DEFAULT 0,
                    level INT DEFAULT 1,
                    messages INT DEFAULT 0,
                    total_xp INT DEFAULT 0,
                    last_message BIGINT DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )
            `);

            // Add total_xp column to levels table if it doesn't exist
            try {
                await this.pool.execute(`
                    ALTER TABLE levels ADD COLUMN total_xp INT DEFAULT 0
                `);
            } catch (err) {
                // Column already exists, ignore error
                if (!err.message.includes('Duplicate column')) {
                    console.warn('[MySQL] Could not add total_xp column:', err.message);
                }
            }

            // Create warns table (legacy - keeping for compatibility)
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS warns (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id VARCHAR(20) NOT NULL,
                    case_id VARCHAR(50) NOT NULL,
                    reason TEXT,
                    moderator_id VARCHAR(20),
                    user_name VARCHAR(100) DEFAULT NULL,
                    moderator_name VARCHAR(100) DEFAULT NULL,
                    moderator_source VARCHAR(20) DEFAULT NULL,
                    type VARCHAR(50),
                    timestamp BIGINT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY unique_case (user_id, case_id),
                    INDEX idx_user (user_id),
                    INDEX idx_type (type)
                )
            `);

            // Create invite usage table for persistent invite tracking
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS invite_usage (
                    guild_id BIGINT UNSIGNED NOT NULL,
                    invite_code VARCHAR(32) NOT NULL,
                    inviter_id VARCHAR(20) DEFAULT NULL,
                    join_count INT NOT NULL DEFAULT 0,
                    last_joined_at BIGINT DEFAULT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    PRIMARY KEY (guild_id, invite_code),
                    INDEX idx_inviter (guild_id, inviter_id),
                    INDEX idx_guild (guild_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            // Add missing warns columns (migration)
            const warnsColumnsToAdd = [
                { name: 'user_name', type: 'VARCHAR(100) DEFAULT NULL' },
                { name: 'moderator_name', type: 'VARCHAR(100) DEFAULT NULL' },
                { name: 'moderator_source', type: 'VARCHAR(20) DEFAULT NULL' }
            ];
            for (const col of warnsColumnsToAdd) {
                try {
                    await this.pool.execute(`
                        ALTER TABLE warns ADD COLUMN ${col.name} ${col.type}
                    `);
                } catch (err) {
                    if (err.code === 'ER_DUP_FIELDNAME') {
                        // Column already exists, skip
                    } else {
                        console.error(`Error adding column ${col.name} to warns:`, err.message);
                    }
                }
            }

            // Add index to speed up latest-warning lookups
            try {
                await this.pool.execute(
                    'CREATE INDEX idx_warns_user_timestamp ON warns(user_id, timestamp)'
                );
                console.log("✅ Added index 'idx_warns_user_timestamp' to warns table");
            } catch (err) {
                if (err.code === 'ER_DUP_KEYNAME') {
                    // Index already exists, skip
                } else {
                    console.error("Error adding index idx_warns_user_timestamp:", err.message);
                }
            }

            // Create user_bans table (only for ban status tracking)
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS user_bans (
                    user_id VARCHAR(20) PRIMARY KEY,
                    banned BOOLEAN DEFAULT FALSE,
                    ban_case_id VARCHAR(50) DEFAULT NULL,
                    banned_at TIMESTAMP NULL,
                    banned_by VARCHAR(20) DEFAULT NULL,
                    ban_reason TEXT DEFAULT NULL,
                    user_name VARCHAR(100) DEFAULT NULL,
                    banned_by_name VARCHAR(100) DEFAULT NULL,
                    banned_by_source VARCHAR(20) DEFAULT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_banned (banned),
                    INDEX idx_banned_at (banned_at)
                )
            `);

            // Add missing user_bans columns (migration)
            const userBansColumnsToAdd = [
                { name: 'user_name', type: 'VARCHAR(100) DEFAULT NULL' },
                { name: 'banned_by_name', type: 'VARCHAR(100) DEFAULT NULL' },
                { name: 'banned_by_source', type: 'VARCHAR(20) DEFAULT NULL' }
            ];
            for (const col of userBansColumnsToAdd) {
                try {
                    await this.pool.execute(`
                        ALTER TABLE user_bans ADD COLUMN ${col.name} ${col.type}
                    `);
                } catch (err) {
                    if (err.code === 'ER_DUP_FIELDNAME') {
                        // Column already exists, skip
                    } else {
                        console.error(`Error adding column ${col.name} to user_bans:`, err.message);
                    }
                }
            }

            // Create unbans table (tracks unban actions and case IDs)
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS unbans (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id VARCHAR(20) NOT NULL,
                    unban_case_id VARCHAR(50) NOT NULL,
                    unbanned_at TIMESTAMP NULL,
                    unbanned_by VARCHAR(255) DEFAULT NULL,
                    unbanned_by_name VARCHAR(100) DEFAULT NULL,
                    unbanned_by_source VARCHAR(20) DEFAULT NULL,
                    user_name VARCHAR(100) DEFAULT NULL,
                    original_ban_case_id VARCHAR(50) DEFAULT NULL,
                    original_ban_reason TEXT DEFAULT NULL,
                    reason TEXT DEFAULT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_unbans_user (user_id),
                    INDEX idx_unbans_case (unban_case_id),
                    INDEX idx_unbans_time (unbanned_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            // Add missing unbans columns (migration)
            const unbansColumnsToAdd = [
                { name: 'unbanned_by_name', type: 'VARCHAR(100) DEFAULT NULL' },
                { name: 'unbanned_by_source', type: 'VARCHAR(20) DEFAULT NULL' },
                { name: 'user_name', type: 'VARCHAR(100) DEFAULT NULL' }
            ];
            for (const col of unbansColumnsToAdd) {
                try {
                    await this.pool.execute(`
                        ALTER TABLE unbans ADD COLUMN ${col.name} ${col.type}
                    `);
                } catch (err) {
                    if (err.code === 'ER_DUP_FIELDNAME') {
                        // Column already exists, skip
                    } else {
                        console.error(`Error adding column ${col.name} to unbans:`, err.message);
                    }
                }
            }

            // Create reminders table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS reminders (
                    id VARCHAR(50) PRIMARY KEY,
                    case_id VARCHAR(20) UNIQUE,
                    user_id VARCHAR(20) NOT NULL,
                    message TEXT,
                    text TEXT,
                    timestamp BIGINT,
                    created_at BIGINT,
                    trigger_at BIGINT,
                    channel_id VARCHAR(20),
                    guild_id VARCHAR(20),
                    completed BOOLEAN DEFAULT FALSE,
                    delivery_attempts INT DEFAULT 0,
                    last_failure_reason TEXT,
                    last_failure_time BIGINT,
                    INDEX idx_user (user_id),
                    INDEX idx_timestamp (timestamp),
                    INDEX idx_trigger (trigger_at),
                    INDEX idx_completed (completed)
                )
            `);

            // Add case_id column if it doesn't exist (migration)
            try {
                await this.pool.execute(`
                    ALTER TABLE reminders 
                    ADD COLUMN IF NOT EXISTS case_id VARCHAR(20) UNIQUE
                `);
            } catch (err) {
                // Column might already exist, ignore error
                if (!err.message.includes('Duplicate column')) {
                    console.error(`Note: case_id column migration:`, err.message);
                }
            }

            const columnsToAdd = [
                { name: 'message', type: 'TEXT' },
                { name: 'text', type: 'TEXT' },
                { name: 'timestamp', type: 'BIGINT' },
                { name: 'created_at', type: 'BIGINT' },
                { name: 'trigger_at', type: 'BIGINT' },
                { name: 'channel_id', type: 'VARCHAR(20)' },
                { name: 'guild_id', type: 'VARCHAR(20)' },
                { name: 'completed', type: 'BOOLEAN DEFAULT FALSE' },
                { name: 'delivery_attempts', type: 'INT DEFAULT 0' },
                { name: 'last_failure_reason', type: 'TEXT' },
                { name: 'last_failure_time', type: 'BIGINT' }
            ];

            for (const col of columnsToAdd) {
                try {
                    await this.pool.execute(`
                        ALTER TABLE reminders ADD COLUMN ${col.name} ${col.type}
                    `);
                    console.log(`✅ Added column '${col.name}' to reminders table`);
                } catch (err) {
                    if (err.code === 'ER_DUP_FIELDNAME') {
                        // Column already exists, skip
                    } else {
                        console.error(`Error adding column ${col.name}:`, err.message);
                    }
                }
            }

            // Add indexes if they don't exist
            const indexesToAdd = [
                { name: 'idx_trigger', column: 'trigger_at' },
                { name: 'idx_completed', column: 'completed' }
            ];

            for (const idx of indexesToAdd) {
                try {
                    await this.pool.execute(`
                        CREATE INDEX ${idx.name} ON reminders(${idx.column})
                    `);
                    console.log(`✅ Added index '${idx.name}' to reminders table`);
                } catch (err) {
                    if (err.code === 'ER_DUP_KEYNAME') {
                        // Index already exists, skip
                    } else {
                        console.error(`Error adding index ${idx.name}:`, err.message);
                    }
                }
            }

            // Migrate user_bans table to add missing columns
            const banColumnsToAdd = [
                { name: 'ban_case_id', type: 'VARCHAR(50) DEFAULT NULL' },
                { name: 'banned_at', type: 'TIMESTAMP NULL' },
                { name: 'banned_by', type: 'VARCHAR(20) DEFAULT NULL' },
                { name: 'ban_reason', type: 'TEXT DEFAULT NULL' }
            ];

            for (const col of banColumnsToAdd) {
                try {
                    await this.pool.execute(`
                        ALTER TABLE user_bans ADD COLUMN ${col.name} ${col.type}
                    `);
                    console.log(`✅ Added column '${col.name}' to user_bans table`);
                } catch (err) {
                    if (err.code === 'ER_DUP_FIELDNAME') {
                        // Column already exists, skip
                    } else {
                        console.error(`Error adding column ${col.name}:`, err.message);
                    }
                }
            }

            // Add indexes to user_bans if they don't exist
            const banIndexesToAdd = [
                { name: 'idx_banned_at', column: 'banned_at' }
            ];

            for (const idx of banIndexesToAdd) {
                try {
                    await this.pool.execute(`
                        CREATE INDEX ${idx.name} ON user_bans(${idx.column})
                    `);
                    console.log(`✅ Added index '${idx.name}' to user_bans table`);
                } catch (err) {
                    if (err.code === 'ER_DUP_KEYNAME') {
                        // Index already exists, skip
                    } else {
                        console.error(`Error adding index ${idx.name}:`, err.message);
                    }
                }
            }

            // Migrate levels table to add username column
            try {
                await this.pool.execute(`
                    ALTER TABLE levels ADD COLUMN username VARCHAR(32) DEFAULT NULL
                `);
                console.log(`✅ Added username column to levels table`);
            } catch (err) {
                if (err.code === 'ER_DUP_FIELDNAME') {
                    // Column already exists, skip
                } else {
                    console.error(`Error adding username column:`, err.message);
                }
            }

            // Migrate admin_users table to update role enum
            try {
                await this.pool.execute(`
                    ALTER TABLE admin_users MODIFY COLUMN role ENUM('owner', 'admin', 'moderator') DEFAULT 'moderator'
                `);
                console.log(`✅ Updated role enum in admin_users table`);
            } catch (err) {
                if (err.code === 'ER_DUP_FIELDNAME') {
                    // Column doesn't exist, skip
                } else {
                    console.error(`Error updating role enum:`, err.message);
                }
            }

            // Create giveaways table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS giveaways (
                    id VARCHAR(50) PRIMARY KEY,
                    case_id VARCHAR(20) UNIQUE,
                    prize TEXT,
                    title TEXT,
                    channel_id VARCHAR(20),
                    message_id VARCHAR(20),
                    host_id VARCHAR(20),
                    end_time BIGINT,
                    winner_count INT DEFAULT 1,
                    required_role_id VARCHAR(20) DEFAULT NULL,
                    winner_ids TEXT DEFAULT NULL,
                    ended BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )
            `);

            // Add case_id column if it doesn't exist (migration)
            try {
                await this.pool.execute(`
                    ALTER TABLE giveaways 
                    ADD COLUMN IF NOT EXISTS case_id VARCHAR(20) UNIQUE
                `);
            } catch (err) {
                // Column might already exist, ignore error
                if (!err.message.includes('Duplicate column')) {
                    console.error(`Note: case_id column migration:`, err.message);
                }
            }

            // Add guild_id column if it doesn't exist (migration)
            try {
                await this.pool.execute(`
                    ALTER TABLE giveaways 
                    ADD COLUMN IF NOT EXISTS guild_id VARCHAR(20) NOT NULL AFTER host_id
                `);
            } catch (err) {
                // Column might already exist, ignore error
                if (!err.message.includes('Duplicate column')) {
                    console.error(`Note: guild_id column migration:`, err.message);
                }
            }

            // Add required_role_id column if it doesn't exist (migration)
            try {
                await this.pool.execute(`
                    ALTER TABLE giveaways
                    ADD COLUMN IF NOT EXISTS required_role_id VARCHAR(20) DEFAULT NULL AFTER winner_count
                `);
            } catch (err) {
                if (!err.message.includes('Duplicate column')) {
                    console.error(`Note: required_role_id column migration:`, err.message);
                }
            }

            // Add winner_ids column if it doesn't exist (migration)
            try {
                await this.pool.execute(`
                    ALTER TABLE giveaways
                    ADD COLUMN IF NOT EXISTS winner_ids TEXT DEFAULT NULL AFTER required_role_id
                `);
            } catch (err) {
                if (!err.message.includes('Duplicate column')) {
                    console.error(`Note: winner_ids column migration:`, err.message);
                }
            }

            // Create giveaway_entries table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS giveaway_entries (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    giveaway_id VARCHAR(50) NOT NULL,
                    user_id VARCHAR(20) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY unique_entry (giveaway_id, user_id),
                    FOREIGN KEY (giveaway_id) REFERENCES giveaways(id) ON DELETE CASCADE
                )
            `);

            // Create tickets table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS tickets (
                    channel_id VARCHAR(20) PRIMARY KEY,
                    user_id VARCHAR(20) NOT NULL,
                    user_name VARCHAR(100) NOT NULL,
                    reason TEXT,
                    priority ENUM('low', 'medium', 'high') DEFAULT 'medium',
                    created_at BIGINT NOT NULL,
                    claimed_by VARCHAR(20) DEFAULT NULL,
                    status ENUM('open', 'claimed', 'closed') DEFAULT 'open',
                    closed_at BIGINT DEFAULT NULL,
                    closed_by VARCHAR(20) DEFAULT NULL,
                    close_reason TEXT DEFAULT NULL,
                    transcript LONGTEXT DEFAULT NULL,
                    transcript_created_at BIGINT DEFAULT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_user_id (user_id),
                    INDEX idx_status (status),
                    INDEX idx_priority (priority)
                )
            `);

            try {
                await this.pool.execute('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS transcript LONGTEXT DEFAULT NULL');
                await this.pool.execute('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS transcript_created_at BIGINT DEFAULT NULL');
            } catch (err) {
                if (!err.message.includes('Duplicate column')) {
                    console.error('Ticket transcript column migration failed:', err.message);
                }
            }

            // Create join_to_create table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS join_to_create (
                    channel_id VARCHAR(20) PRIMARY KEY,
                    owner_id VARCHAR(20) NOT NULL,
                    guild_id VARCHAR(20) NOT NULL,
                    channel_name VARCHAR(100) NOT NULL,
                    created_at BIGINT NOT NULL,
                    is_active BOOLEAN DEFAULT TRUE,
                    INDEX idx_owner_id (owner_id),
                    INDEX idx_guild_id (guild_id),
                    INDEX idx_is_active (is_active)
                )
            `);

            // Create birthdays table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS birthdays (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(20) NOT NULL,
                    user_id VARCHAR(20) NOT NULL,
                    month TINYINT UNSIGNED NOT NULL,
                    day TINYINT UNSIGNED NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY unique_guild_user (guild_id, user_id),
                    INDEX idx_guild_month_day (guild_id, month, day),
                    INDEX idx_user_id (user_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            // Create birthday announcements log table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS birthday_announcements (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(20) NOT NULL,
                    user_id VARCHAR(20) NOT NULL,
                    date_key CHAR(10) NOT NULL,
                    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY unique_daily_announcement (guild_id, user_id, date_key),
                    INDEX idx_guild_date (guild_id, date_key),
                    INDEX idx_sent_at (sent_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            // Create reputation points table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS reputation_points (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(20) NOT NULL,
                    user_id VARCHAR(20) NOT NULL,
                    points INT UNSIGNED NOT NULL DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY unique_reputation_user (guild_id, user_id),
                    INDEX idx_reputation_guild_points (guild_id, points),
                    INDEX idx_reputation_user (user_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS reputation_grants (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(20) NOT NULL,
                    giver_id VARCHAR(20) NOT NULL,
                    target_id VARCHAR(20) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_rep_grants_guild_giver_time (guild_id, giver_id, created_at),
                    INDEX idx_rep_grants_pair_time (guild_id, giver_id, target_id, created_at),
                    INDEX idx_rep_grants_target_time (guild_id, target_id, created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            // Create economy balances table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS economy_balances (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(20) NOT NULL,
                    user_id VARCHAR(20) NOT NULL,
                    wallet BIGINT UNSIGNED NOT NULL DEFAULT 0,
                    bank BIGINT UNSIGNED NOT NULL DEFAULT 0,
                    total_earned BIGINT UNSIGNED NOT NULL DEFAULT 0,
                    total_spent BIGINT UNSIGNED NOT NULL DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY uq_economy_user (guild_id, user_id),
                    INDEX idx_economy_guild_wallet (guild_id, wallet),
                    INDEX idx_economy_guild_bank (guild_id, bank),
                    INDEX idx_economy_user (user_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            // Create economy transaction table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS economy_transactions (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(20) NOT NULL,
                    user_id VARCHAR(20) NOT NULL,
                    tx_type VARCHAR(40) NOT NULL,
                    amount BIGINT NOT NULL,
                    source_user_id VARCHAR(20) DEFAULT NULL,
                    note VARCHAR(255) DEFAULT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_economy_tx_guild_user_time (guild_id, user_id, created_at),
                    INDEX idx_economy_tx_guild_type_time (guild_id, tx_type, created_at),
                    INDEX idx_economy_tx_source_user (source_user_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            // Track daily bank interest runs to avoid double payouts
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS economy_interest_runs (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(20) NOT NULL,
                    run_date CHAR(10) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY uq_economy_interest_run (guild_id, run_date),
                    INDEX idx_economy_interest_guild (guild_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            // Economy fraud flag tracking
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS economy_fraud_flags (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(20) NOT NULL,
                    user_id VARCHAR(20) NOT NULL,
                    flag_type VARCHAR(40) NOT NULL,
                    severity ENUM('low', 'medium', 'high') DEFAULT 'medium',
                    details JSON DEFAULT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_economy_fraud_guild (guild_id, created_at),
                    INDEX idx_economy_fraud_user (guild_id, user_id, created_at),
                    INDEX idx_economy_fraud_type (flag_type)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            // Create economy inventory table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS economy_inventory (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(20) NOT NULL,
                    user_id VARCHAR(20) NOT NULL,
                    item_id VARCHAR(50) NOT NULL,
                    quantity INT UNSIGNED NOT NULL DEFAULT 0,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY uq_economy_inventory (guild_id, user_id, item_id),
                    INDEX idx_economy_inventory_user (guild_id, user_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            // Create economy boosts table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS economy_boosts (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(20) NOT NULL,
                    user_id VARCHAR(20) NOT NULL,
                    boost_type VARCHAR(40) NOT NULL,
                    multiplier DECIMAL(6,2) NOT NULL DEFAULT 1.0,
                    uses_remaining INT UNSIGNED NOT NULL DEFAULT 1,
                    expires_at BIGINT NOT NULL DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_economy_boosts_user (guild_id, user_id),
                    INDEX idx_economy_boosts_type (boost_type),
                    INDEX idx_economy_boosts_expires (expires_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            // Create economy quest progress table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS economy_quest_progress (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(20) NOT NULL,
                    user_id VARCHAR(20) NOT NULL,
                    quest_key VARCHAR(50) NOT NULL,
                    cadence ENUM('daily', 'weekly') NOT NULL,
                    period_start CHAR(10) NOT NULL,
                    progress INT UNSIGNED NOT NULL DEFAULT 0,
                    completed_at TIMESTAMP NULL DEFAULT NULL,
                    claimed_at TIMESTAMP NULL DEFAULT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY uq_economy_quest (guild_id, user_id, quest_key, cadence, period_start),
                    INDEX idx_economy_quest_user (guild_id, user_id),
                    INDEX idx_economy_quest_period (guild_id, cadence, period_start)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            // Create economy bounty table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS economy_bounties (
                    bounty_id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(20) NOT NULL,
                    created_by VARCHAR(20) NOT NULL,
                    title VARCHAR(120) NOT NULL,
                    description TEXT DEFAULT NULL,
                    reward_amount BIGINT UNSIGNED NOT NULL,
                    status ENUM('open', 'awarded', 'closed') DEFAULT 'open',
                    awarded_to VARCHAR(20) DEFAULT NULL,
                    awarded_by VARCHAR(20) DEFAULT NULL,
                    awarded_at TIMESTAMP NULL DEFAULT NULL,
                    closed_at TIMESTAMP NULL DEFAULT NULL,
                    close_reason VARCHAR(255) DEFAULT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_economy_bounty_status (guild_id, status),
                    INDEX idx_economy_bounty_created (guild_id, created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            // Create admin_users table for panel authentication
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS admin_users (
                    id CHAR(36) PRIMARY KEY,
                    username VARCHAR(50) UNIQUE NOT NULL,
                    password_hash VARCHAR(255) NOT NULL,
                    role ENUM('owner', 'admin', 'moderator') DEFAULT 'moderator',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_login TIMESTAMP NULL DEFAULT NULL,
                    active BOOLEAN DEFAULT TRUE,
                    INDEX idx_username (username),
                    INDEX idx_active (active)
                )
            `);

            const adminUserColumnsToAdd = [
                { name: 'email', type: 'VARCHAR(254) DEFAULT NULL' },
                { name: 'email_verified', type: 'BOOLEAN DEFAULT FALSE' },
                { name: 'email_verification_token', type: 'VARCHAR(128) DEFAULT NULL' },
                { name: 'email_verification_expires', type: 'TIMESTAMP NULL DEFAULT NULL' },
                { name: 'password_reset_token', type: 'VARCHAR(128) DEFAULT NULL' },
                { name: 'password_reset_expires', type: 'TIMESTAMP NULL DEFAULT NULL' },
                { name: 'two_factor_enabled', type: 'BOOLEAN DEFAULT FALSE' },
                { name: 'two_factor_secret', type: 'TEXT DEFAULT NULL' },
                { name: 'two_factor_enabled_at', type: 'TIMESTAMP NULL DEFAULT NULL' },
                { name: 'password_changed_at', type: 'TIMESTAMP NULL DEFAULT NULL' },
                { name: 'recovery_code_hashes', type: 'TEXT DEFAULT NULL' },
                { name: 'recovery_codes_generated_at', type: 'TIMESTAMP NULL DEFAULT NULL' },
                { name: 'trusted_devices_json', type: 'TEXT DEFAULT NULL' },
                { name: 'discord_user_id', type: 'VARCHAR(20) DEFAULT NULL' },
                { name: 'discord_username', type: 'VARCHAR(100) DEFAULT NULL' },
                { name: 'discord_linked_at', type: 'TIMESTAMP NULL DEFAULT NULL' }
            ];

            for (const col of adminUserColumnsToAdd) {
                try {
                    await this.pool.execute(`
                        ALTER TABLE admin_users ADD COLUMN ${col.name} ${col.type}
                    `);
                } catch (err) {
                    if (err.code !== 'ER_DUP_FIELDNAME') {
                        console.error(`Error adding column ${col.name} to admin_users:`, err.message);
                    }
                }
            }

            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS admin_auth_events (
                    id CHAR(36) PRIMARY KEY,
                    username VARCHAR(50) NOT NULL,
                    event_type ENUM('LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGIN_2FA_CHALLENGE', 'LOGIN_2FA_FAILED', 'LOGOUT', 'PASSWORD_CHANGED', 'TWO_FACTOR_ENABLED', 'TWO_FACTOR_DISABLED', 'SESSIONS_REVOKED', 'EMAIL_CHANGED', 'EMAIL_VERIFIED', 'PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED') NOT NULL,
                    ip_address VARCHAR(64) DEFAULT NULL,
                    user_agent VARCHAR(255) DEFAULT NULL,
                    metadata JSON DEFAULT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_admin_auth_username_created (username, created_at),
                    INDEX idx_admin_auth_event_type (event_type)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            try {
                await this.pool.execute(`
                    ALTER TABLE admin_auth_events
                    MODIFY COLUMN event_type ENUM('LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGIN_2FA_CHALLENGE', 'LOGIN_2FA_FAILED', 'LOGOUT', 'PASSWORD_CHANGED', 'TWO_FACTOR_ENABLED', 'TWO_FACTOR_DISABLED', 'SESSIONS_REVOKED', 'EMAIL_CHANGED', 'EMAIL_VERIFIED', 'PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED') NOT NULL
                `);
            } catch (enumMigrationError) {
                console.error('Error updating admin_auth_events enum:', enumMigrationError.message);
            }

            // Create advanced logging table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS audit_logs (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(20) NOT NULL,
                    event_type ENUM('MESSAGE_DELETE', 'MESSAGE_EDIT', 'MEMBER_JOIN', 'MEMBER_LEAVE', 
                                   'MEMBER_BAN', 'MEMBER_UNBAN', 'MEMBER_KICK', 'ROLE_ADD', 'ROLE_REMOVE',
                                   'CHANNEL_CREATE', 'CHANNEL_DELETE', 'VOICE_JOIN', 'VOICE_LEAVE', 'VOICE_MOVE',
                                   'NICKNAME_CHANGE', 'USERNAME_CHANGE', 'WARN', 'TIMEOUT', 'OTHER') NOT NULL,
                    user_id VARCHAR(20),
                    moderator_id VARCHAR(20),
                    channel_id VARCHAR(20),
                    before_content TEXT,
                    after_content TEXT,
                    reason TEXT,
                    metadata JSON,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_event_type (event_type),
                    INDEX idx_user_id (user_id),
                    INDEX idx_guild_id (guild_id),
                    INDEX idx_timestamp (timestamp)
                )
            `);

            // Create suggestions table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS suggestions (
                    suggestion_id INT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(20) NOT NULL,
                    user_id VARCHAR(20) NOT NULL,
                    title VARCHAR(100) NOT NULL,
                    description TEXT NOT NULL,
                    message_id VARCHAR(20),
                    case_id VARCHAR(32),
                    status ENUM('pending', 'approved', 'denied', 'implemented') DEFAULT 'pending',
                    upvotes INT DEFAULT 0,
                    downvotes INT DEFAULT 0,
                    admin_response TEXT,
                    responded_by VARCHAR(20),
                    resolved_at TIMESTAMP NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_status (status),
                    INDEX idx_guild_id (guild_id),
                    INDEX idx_user_id (user_id),
                    INDEX idx_message_id (message_id),
                    INDEX idx_case_id (case_id)
                )
            `);

            // Add case_id column if it doesn't exist (migration)
            try {
                await this.pool.execute(`
                    ALTER TABLE suggestions 
                    ADD COLUMN IF NOT EXISTS case_id VARCHAR(32) AFTER message_id
                `);
            } catch (err) {
                // Column might already exist, ignore error
                if (!err.message.includes('Duplicate column')) {
                    console.error(`Note: case_id column migration (suggestions):`, err.message);
                }
            }

            // Create suggestion votes table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS suggestion_votes (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    suggestion_id VARCHAR(20) NOT NULL,
                    user_id VARCHAR(20) NOT NULL,
                    vote_type ENUM('upvote', 'downvote') NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY unique_vote (suggestion_id, user_id),
                    INDEX idx_suggestion_id (suggestion_id)
                )
            `);

            // Create automod violations table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS automod_violations (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id VARCHAR(20) NOT NULL,
                    guild_id VARCHAR(20) NOT NULL,
                    violation_type ENUM('spam', 'caps', 'links', 'invites', 'mentions', 'profanity', 'similarity', 'regex') NOT NULL,
                    message_content TEXT,
                    channel_id VARCHAR(20),
                    action_taken ENUM('delete', 'warn', 'timeout', 'kick', 'ban') NOT NULL,
                    risk_score INT DEFAULT NULL,
                    risk_level ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium',
                    signal_count INT DEFAULT 1,
                    appeal_notified BOOLEAN DEFAULT FALSE,
                    metadata_json JSON DEFAULT NULL,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_user_id (user_id),
                    INDEX idx_violation_type (violation_type),
                    INDEX idx_timestamp (timestamp)
                )
            `);

            // Create anti-raid events table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS anti_raid_events (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(20) NOT NULL,
                    event_type ENUM('lockdown_start', 'lockdown_end', 'manual_enable', 'manual_disable') NOT NULL,
                    risk_score INT DEFAULT NULL,
                    trigger_count INT DEFAULT NULL,
                    details_json JSON DEFAULT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_anti_raid_guild_created (guild_id, created_at),
                    INDEX idx_anti_raid_type (event_type)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            // Create manual lockdown audit table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS manual_lockdowns (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(20) NOT NULL,
                    action_type ENUM('enable', 'disable') NOT NULL,
                    case_id VARCHAR(32) NOT NULL,
                    moderator_id VARCHAR(20) NOT NULL,
                    moderator_name VARCHAR(100) DEFAULT NULL,
                    reason TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_manual_lockdowns_guild_created (guild_id, created_at),
                    INDEX idx_manual_lockdowns_case (case_id),
                    INDEX idx_manual_lockdowns_action (action_type)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            const automodColumnsToAdd = [
                { name: 'risk_score', type: 'INT DEFAULT NULL' },
                { name: 'risk_level', type: "ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium'" },
                { name: 'signal_count', type: 'INT DEFAULT 1' },
                { name: 'appeal_notified', type: 'BOOLEAN DEFAULT FALSE' },
                { name: 'metadata_json', type: 'JSON DEFAULT NULL' }
            ];

            for (const col of automodColumnsToAdd) {
                try {
                    await this.pool.execute(`
                        ALTER TABLE automod_violations ADD COLUMN ${col.name} ${col.type}
                    `);
                    console.log(`✅ Added column '${col.name}' to automod_violations table`);
                } catch (err) {
                    if (err.code !== 'ER_DUP_FIELDNAME') {
                        console.error(`Error adding column ${col.name} to automod_violations:`, err.message);
                    }
                }
            }

            try {
                await this.pool.execute(`
                    ALTER TABLE automod_violations
                    MODIFY COLUMN violation_type ENUM('spam', 'caps', 'links', 'invites', 'mentions', 'profanity', 'similarity', 'regex') NOT NULL
                `);
            } catch (err) {
                console.error('Error updating automod_violations.violation_type enum:', err.message);
            }

            // Create automod review state table (workflow queue status + reviewer notes)
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS automod_violation_reviews (
                    violation_id INT PRIMARY KEY,
                    status ENUM('pending', 'approved', 'dismissed') NOT NULL DEFAULT 'pending',
                    severity ENUM('low', 'medium', 'high', 'critical') NOT NULL DEFAULT 'medium',
                    reviewer_username VARCHAR(100) DEFAULT NULL,
                    reviewed_at TIMESTAMP NULL,
                    note TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    CONSTRAINT fk_automod_review_violation
                        FOREIGN KEY (violation_id)
                        REFERENCES automod_violations(id)
                        ON DELETE CASCADE,
                    INDEX idx_automod_review_status (status),
                    INDEX idx_automod_review_severity (severity),
                    INDEX idx_automod_review_reviewed_at (reviewed_at)
                )
            `);

            // Create timeouts table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS timeouts (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id VARCHAR(20) NOT NULL,
                    case_id VARCHAR(50) DEFAULT NULL,
                    username VARCHAR(100),
                    reason TEXT,
                    issued_by VARCHAR(20),
                    issued_by_name VARCHAR(100) DEFAULT NULL,
                    issued_by_source VARCHAR(20) DEFAULT NULL,
                    issued_at BIGINT,
                    expires_at BIGINT,
                    active BOOLEAN DEFAULT TRUE,
                    cleared_at BIGINT DEFAULT NULL,
                    cleared_by VARCHAR(20) DEFAULT NULL,
                    cleared_case_id VARCHAR(50) DEFAULT NULL,
                    cleared_reason TEXT,
                    INDEX idx_user (user_id),
                    INDEX idx_active (active),
                    INDEX idx_expires (expires_at)
                )
            `);

            // Add missing timeouts columns (migration)
            const timeoutColumnsToAdd = [
                { name: 'case_id', type: 'VARCHAR(50) DEFAULT NULL' },
                { name: 'issued_by_name', type: 'VARCHAR(100) DEFAULT NULL' },
                { name: 'issued_by_source', type: 'VARCHAR(20) DEFAULT NULL' },
                { name: 'cleared_at', type: 'BIGINT DEFAULT NULL' },
                { name: 'cleared_by', type: 'VARCHAR(20) DEFAULT NULL' },
                { name: 'cleared_case_id', type: 'VARCHAR(50) DEFAULT NULL' },
                { name: 'cleared_reason', type: 'TEXT' }
            ];
            for (const col of timeoutColumnsToAdd) {
                try {
                    await this.pool.execute(`
                        ALTER TABLE timeouts ADD COLUMN ${col.name} ${col.type}
                    `);
                    console.log(`✅ Added column '${col.name}' to timeouts table`);
                } catch (err) {
                    if (err.code === 'ER_DUP_FIELDNAME') {
                        // Column already exists, skip
                    } else {
                        console.error(`Error adding column ${col.name} to timeouts:`, err.message);
                    }
                }
            }

            // Create kicks table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS kicks (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    case_id VARCHAR(50) DEFAULT NULL,
                    user_id VARCHAR(20) NOT NULL,
                    username VARCHAR(100),
                    reason TEXT,
                    kicked_by VARCHAR(20),
                    kicked_by_name VARCHAR(100) DEFAULT NULL,
                    kicked_by_source VARCHAR(20) DEFAULT NULL,
                    kicked_at BIGINT,
                    INDEX idx_user (user_id),
                    INDEX idx_kicked_at (kicked_at)
                )
            `);

            // Add missing kicks columns (migration)
            const kicksColumnsToAdd = [
                { name: 'kicked_by_name', type: 'VARCHAR(100) DEFAULT NULL' },
                { name: 'kicked_by_source', type: 'VARCHAR(20) DEFAULT NULL' }
            ];
            for (const col of kicksColumnsToAdd) {
                try {
                    await this.pool.execute(`
                        ALTER TABLE kicks ADD COLUMN ${col.name} ${col.type}
                    `);
                } catch (err) {
                    if (err.code === 'ER_DUP_FIELDNAME') {
                        // Column already exists, skip
                    } else {
                        console.error(`Error adding column ${col.name} to kicks:`, err.message);
                    }
                }
            }

            // Create moderation incidents table (proof/evidence linked to moderation actions)
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS moderation_incidents (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    case_id VARCHAR(50) NOT NULL,
                    user_id VARCHAR(20) NOT NULL,
                    action_type VARCHAR(20) NOT NULL DEFAULT 'OTHER',
                    reason TEXT,
                    proof_text TEXT,
                    proof_url VARCHAR(1000) DEFAULT NULL,
                    attachment_url VARCHAR(1000) DEFAULT NULL,
                    message_link VARCHAR(500) DEFAULT NULL,
                    moderator_id VARCHAR(20) NOT NULL,
                    moderator_name VARCHAR(100) DEFAULT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY uq_moderation_incident_case (case_id),
                    INDEX idx_moderation_incident_user (user_id),
                    INDEX idx_moderation_incident_action (action_type),
                    INDEX idx_moderation_incident_created (created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            // Create polls table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS polls (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    message_id VARCHAR(20) UNIQUE NOT NULL,
                    guild_id VARCHAR(20) NOT NULL,
                    user_id VARCHAR(20) NOT NULL,
                    question TEXT NOT NULL,
                    options JSON NOT NULL,
                    ends_at TIMESTAMP NULL,
                    ended BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_message_id (message_id),
                    INDEX idx_guild_id (guild_id),
                    INDEX idx_ended (ended)
                )
            `);

            // Create member activity tracking table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS member_activity (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id VARCHAR(20) NOT NULL,
                    username VARCHAR(100),
                    event_type ENUM('join', 'leave') NOT NULL,
                    guild_id VARCHAR(20) NOT NULL,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_event_type (event_type),
                    INDEX idx_timestamp (timestamp),
                    INDEX idx_guild_id (guild_id)
                )
            `);

            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS user_channel_activity (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(20) NOT NULL,
                    user_id VARCHAR(20) NOT NULL,
                    channel_id VARCHAR(20) NOT NULL,
                    username VARCHAR(100) NULL,
                    message_count INT UNSIGNED NOT NULL DEFAULT 0,
                    first_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY unique_user_channel (guild_id, user_id, channel_id),
                    INDEX idx_uca_user (guild_id, user_id),
                    INDEX idx_uca_channel (guild_id, channel_id),
                    INDEX idx_uca_message_count (message_count)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            // Create sessions table for express-session
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id VARCHAR(128) PRIMARY KEY,
                    expires INT UNSIGNED NOT NULL,
                    data TEXT,
                    INDEX idx_expires (expires)
                )
            `);

            // Create invite codes table for admin registration
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS admin_invite_codes (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    code VARCHAR(32) UNIQUE NOT NULL,
                    created_by VARCHAR(50) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    expires_at TIMESTAMP NULL,
                    used_by VARCHAR(50) DEFAULT NULL,
                    used_at TIMESTAMP NULL DEFAULT NULL,
                    role ENUM('owner', 'admin', 'moderator') DEFAULT 'moderator',
                    active BOOLEAN DEFAULT TRUE,
                    max_uses INT DEFAULT 1,
                    current_uses INT DEFAULT 0,
                    description TEXT NULL,
                    revoked_by VARCHAR(50) NULL,
                    revoked_at TIMESTAMP NULL,
                    last_view_at TIMESTAMP NULL,
                    view_count INT DEFAULT 0,
                    INDEX idx_code (code),
                    INDEX idx_active (active),
                    INDEX idx_expires_at (expires_at),
                    INDEX idx_created_by (created_by)
                )
            `);

            // Add new columns if they don't exist (migration for existing installations)
            const newColumns = [
                ['max_uses', 'INT DEFAULT 1 AFTER active'],
                ['current_uses', 'INT DEFAULT 0 AFTER max_uses'],
                ['description', 'TEXT NULL AFTER current_uses'],
                ['revoked_by', 'VARCHAR(50) NULL AFTER description'],
                ['revoked_at', 'TIMESTAMP NULL AFTER revoked_by']
            ];

            for (const [columnName, columnDef] of newColumns) {
                try {
                    await this.pool.execute(`
                        ALTER TABLE admin_invite_codes 
                        ADD COLUMN IF NOT EXISTS ${columnName} ${columnDef}
                    `);
                } catch (err) {
                    if (!err.message.includes('Duplicate column')) {
                        console.warn(`[MySQLConnection] Warning adding column ${columnName} to admin_invite_codes:`, err.message);
                    }
                }
            }

            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS user_interactions (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id VARCHAR(20) NOT NULL,
                    username VARCHAR(32) DEFAULT NULL,
                    command_name VARCHAR(100) NOT NULL,
                    command_category VARCHAR(50) DEFAULT NULL,
                    guild_id VARCHAR(20) DEFAULT NULL,
                    channel_id VARCHAR(20) DEFAULT NULL,
                    status ENUM('SUCCESS', 'ERROR', 'RATE_LIMIT', 'PERMISSION') DEFAULT 'SUCCESS',
                    error_message TEXT DEFAULT NULL,
                    created_at BIGINT NOT NULL,
                    INDEX idx_user (user_id),
                    INDEX idx_command (command_name),
                    INDEX idx_created (created_at)
                )
            `);

            // Add status column if it doesn't exist
            try {
                await this.pool.execute(`
                    ALTER TABLE user_interactions ADD COLUMN status ENUM('SUCCESS', 'ERROR', 'RATE_LIMIT', 'PERMISSION') DEFAULT 'SUCCESS'
                `);
                console.log("✅ Added status column to user_interactions table");
            } catch (err) {
                if (err.code === 'ER_DUP_FIELDNAME') {
                    // Column already exists, skip
                } else {
                    console.error("Error adding status column:", err.message);
                }
            }

            // Add error_message column if it doesn't exist
            try {
                await this.pool.execute(`
                    ALTER TABLE user_interactions ADD COLUMN error_message TEXT DEFAULT NULL
                `);
                console.log("✅ Added error_message column to user_interactions table");
            } catch (err) {
                if (err.code === 'ER_DUP_FIELDNAME') {
                    // Column already exists, skip
                } else {
                    console.error("Error adding error_message column:", err.message);
                }
            }

            // Add command_name column if it doesn't exist
            try {
                await this.pool.execute(`
                    ALTER TABLE user_interactions ADD COLUMN command_name VARCHAR(100) NOT NULL DEFAULT ''
                `);
                console.log("✅ Added command_name column to user_interactions table");
            } catch (err) {
                if (err.code === 'ER_DUP_FIELDNAME') {
                    // Column already exists, skip
                } else {
                    console.error("Error adding command_name column:", err.message);
                }
            }

            // Add command_category column if it doesn't exist
            try {
                await this.pool.execute(`
                    ALTER TABLE user_interactions ADD COLUMN command_category VARCHAR(50) DEFAULT NULL
                `);
                console.log("✅ Added command_category column to user_interactions table");
            } catch (err) {
                if (err.code === 'ER_DUP_FIELDNAME') {
                    // Column already exists, skip
                } else {
                    console.error("Error adding command_category column:", err.message);
                }
            }

            // Add guild_id column if it doesn't exist
            try {
                await this.pool.execute(`
                    ALTER TABLE user_interactions ADD COLUMN guild_id VARCHAR(20) DEFAULT NULL
                `);
                console.log("✅ Added guild_id column to user_interactions table");
            } catch (err) {
                if (err.code === 'ER_DUP_FIELDNAME') {
                    // Column already exists, skip
                } else {
                    console.error("Error adding guild_id column:", err.message);
                }
            }

            // Add channel_id column if it doesn't exist
            try {
                await this.pool.execute(`
                    ALTER TABLE user_interactions ADD COLUMN channel_id VARCHAR(20) DEFAULT NULL
                `);
                console.log("✅ Added channel_id column to user_interactions table");
            } catch (err) {
                if (err.code === 'ER_DUP_FIELDNAME') {
                    // Column already exists, skip
                } else {
                    console.error("Error adding channel_id column:", err.message);
                }
            }

            // Add username column if it doesn't exist
            try {
                await this.pool.execute(`
                    ALTER TABLE user_interactions ADD COLUMN username VARCHAR(32) DEFAULT NULL
                `);
                console.log("✅ Added username column to user_interactions table");
            } catch (err) {
                if (err.code === 'ER_DUP_FIELDNAME') {
                    // Column already exists, skip
                } else {
                    console.error("Error adding username column:", err.message);
                }
            }

            // Add created_at column if it doesn't exist
            try {
                await this.pool.execute(`
                    ALTER TABLE user_interactions ADD COLUMN created_at BIGINT NOT NULL DEFAULT 0
                `);
                console.log("✅ Added created_at column to user_interactions table");
            } catch (err) {
                if (err.code === 'ER_DUP_FIELDNAME') {
                    // Column already exists, skip
                } else {
                    console.error("Error adding created_at column:", err.message);
                }
            }

            // Create ban appeals table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS ban_appeals (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id VARCHAR(20) NOT NULL,
                    user_tag VARCHAR(100),
                    ban_case_id VARCHAR(20),
                    reason TEXT NOT NULL,
                    status ENUM('pending', 'accepted', 'denied') DEFAULT 'pending',
                    owner_response TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    decided_at TIMESTAMP NULL,
                    INDEX idx_user (user_id),
                    INDEX idx_status (status),
                    INDEX idx_ban_case_id (ban_case_id)
                )
            `);;
            console.log('✅ Ban Appeals table initialized');

            try {
                await this.pool.execute(`
                    ALTER TABLE ban_appeals ADD COLUMN user_email VARCHAR(254) DEFAULT NULL
                `);
                console.log('✅ Added user_email column to ban_appeals table');
            } catch (err) {
                if (err.code !== 'ER_DUP_FIELDNAME') {
                    console.error('Error adding user_email column to ban_appeals:', err.message);
                }
            }

            try {
                await this.pool.execute(`
                    ALTER TABLE ban_appeals ADD COLUMN decided_by_id VARCHAR(64) DEFAULT NULL
                `);
                console.log('✅ Added decided_by_id column to ban_appeals table');
            } catch (err) {
                if (err.code !== 'ER_DUP_FIELDNAME') {
                    console.error('Error adding decided_by_id column to ban_appeals:', err.message);
                }
            }

            try {
                await this.pool.execute(`
                    ALTER TABLE ban_appeals ADD COLUMN decided_by_name VARCHAR(100) DEFAULT NULL
                `);
                console.log('✅ Added decided_by_name column to ban_appeals table');
            } catch (err) {
                if (err.code !== 'ER_DUP_FIELDNAME') {
                    console.error('Error adding decided_by_name column to ban_appeals:', err.message);
                }
            }

            // Create alert settings table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS alert_settings (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    alert_type ENUM('cpu', 'memory', 'error_rate', 'rate_limit', 'database') NOT NULL UNIQUE,
                    threshold FLOAT DEFAULT 80.0,
                    enabled BOOLEAN DEFAULT TRUE,
                    last_triggered TIMESTAMP NULL DEFAULT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_type (alert_type)
                )
            `);
            console.log('✅ Alert Settings table initialized');

            try {
                await this.pool.execute(`
                    ALTER TABLE alert_settings ADD COLUMN last_triggered TIMESTAMP NULL DEFAULT NULL
                `);
                console.log('✅ Added last_triggered column to alert_settings table');
            } catch (err) {
                if (err.code !== 'ER_DUP_FIELDNAME') {
                    console.error('Error adding last_triggered column to alert_settings:', err.message);
                }
            }

            // Create active alerts table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS active_alerts (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    alert_type VARCHAR(50) NOT NULL,
                    severity ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium',
                    message TEXT NOT NULL,
                    value FLOAT,
                    threshold FLOAT,
                    resolved BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    resolved_at TIMESTAMP NULL,
                    INDEX idx_type (alert_type),
                    INDEX idx_resolved (resolved)
                )
            `);
            console.log('✅ Active Alerts table initialized');

            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS email_delivery_logs (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    recipient_email VARCHAR(254) NOT NULL,
                    recipient_domain VARCHAR(255) NULL,
                    template_name VARCHAR(100) DEFAULT 'generic',
                    subject VARCHAR(255) NULL,
                    status ENUM('sent', 'failed', 'blocked') NOT NULL,
                    error_message TEXT NULL,
                    message_id VARCHAR(255) NULL,
                    correlation_id VARCHAR(128) NULL,
                    source VARCHAR(100) NULL,
                    provider_response TEXT NULL,
                    attempt_count INT DEFAULT 1,
                    latency_ms INT DEFAULT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_created (created_at),
                    INDEX idx_status (status),
                    INDEX idx_template (template_name),
                    INDEX idx_recipient_domain (recipient_domain),
                    INDEX idx_correlation_id (correlation_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            console.log('✅ Email Delivery Logs table initialized');

            const emailDeliveryColumnsToAdd = [
                { name: 'correlation_id', type: 'VARCHAR(128) DEFAULT NULL' },
                { name: 'source', type: 'VARCHAR(100) DEFAULT NULL' },
                { name: 'provider_response', type: 'TEXT' },
                { name: 'attempt_count', type: 'INT DEFAULT 1' },
                { name: 'latency_ms', type: 'INT DEFAULT NULL' }
            ];

            for (const col of emailDeliveryColumnsToAdd) {
                try {
                    await this.pool.execute(`
                        ALTER TABLE email_delivery_logs ADD COLUMN ${col.name} ${col.type}
                    `);
                    console.log(`✅ Added column '${col.name}' to email_delivery_logs table`);
                } catch (err) {
                    if (err.code !== 'ER_DUP_FIELDNAME') {
                        console.error(`Error adding column ${col.name} to email_delivery_logs:`, err.message);
                    }
                }
            }

            // Create persistent scheduled jobs table
            await this.pool.execute(`
                CREATE TABLE IF NOT EXISTS scheduled_jobs (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    job_type VARCHAR(100) NOT NULL,
                    payload JSON NULL,
                    status ENUM('pending', 'running', 'completed', 'failed') DEFAULT 'pending',
                    run_at BIGINT NOT NULL,
                    attempts INT DEFAULT 0,
                    max_attempts INT DEFAULT 3,
                    locked_by VARCHAR(100) DEFAULT NULL,
                    locked_at BIGINT DEFAULT NULL,
                    last_error TEXT DEFAULT NULL,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL,
                    completed_at BIGINT DEFAULT NULL,
                    INDEX idx_jobs_status_run (status, run_at),
                    INDEX idx_jobs_type (job_type),
                    INDEX idx_jobs_lock (locked_by, locked_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            console.log('✅ Scheduled Jobs table initialized');

            // Initialize default alert settings if they don't exist
            try {
                const [existing] = await this.pool.execute('SELECT COUNT(*) as count FROM alert_settings');
                if (existing[0].count === 0) {
                    await this.pool.execute(`
                        INSERT INTO alert_settings (alert_type, threshold, enabled) VALUES
                        ('cpu', 80.0, TRUE),
                        ('memory', 85.0, TRUE),
                        ('error_rate', 10.0, TRUE),
                        ('rate_limit', 75.0, TRUE),
                        ('database', 90.0, TRUE)
                    `);
                    console.log('✅ Initialized default alert settings');
                }
            } catch (err) {
                console.error("Error initializing alert settings:", err.message);
            }

            console.log('✅ MySQL Tables Initialized');
        } catch (error) {
            console.error('❌ Table Initialization Failed:', error.message);
            throw error;
        }
    }

    async query(sql, params = []) {
        if (!this.isConnected || !this.pool) {
            const connected = await this.connect();
            if (!connected) {
                throw new Error('MySQL not connected');
            }
        }

        const maxAttempts = this.queryRetryAttempts + 1;
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const startedAt = Date.now();
                const [results] = await this.pool.execute(sql, params);
                const durationMs = Date.now() - startedAt;

                if (durationMs >= this.slowQueryThresholdMs) {
                    console.warn(`[MySQL] Slow query (${durationMs}ms)`);
                }

                return results;
            } catch (error) {
                lastError = error;
                const isRetryable = this.isTransientMySQLError(error) && attempt < maxAttempts;

                if (isRetryable) {
                    await this.delay(this.queryRetryDelayMs * attempt);
                    continue;
                }

                if (!error.message || !error.message.includes('Unknown column')) {
                    console.error('MySQL Query Error:', error.message);
                }
                throw error;
            }
        }

        throw lastError || new Error('MySQL query failed');
    }

    async transaction(handler) {
        if (typeof handler !== 'function') {
            throw new Error('MySQL transaction handler must be a function');
        }

        if (!this.isConnected || !this.pool) {
            const connected = await this.connect();
            if (!connected) {
                throw new Error('MySQL not connected');
            }
        }

        const connection = await this.pool.getConnection();
        try {
            await connection.beginTransaction();
            const result = await handler(connection);
            await connection.commit();
            return result;
        } catch (error) {
            try {
                await connection.rollback();
            } catch {
            }
            throw error;
        } finally {
            connection.release();
        }
    }

    async healthCheck() {
        if (!this.pool || !this.isConnected) {
            return {
                ok: false,
                isConnected: false,
                latencyMs: null,
                lastHealthCheckAt: this.lastHealthCheckAt,
                lastHealthCheckLatencyMs: this.lastHealthCheckLatencyMs,
                error: 'MySQL not connected'
            };
        }

        try {
            const startedAt = Date.now();
            await this.pool.query('SELECT 1 AS ok');
            const latencyMs = Date.now() - startedAt;

            this.lastHealthCheckAt = Date.now();
            this.lastHealthCheckLatencyMs = latencyMs;

            return {
                ok: true,
                isConnected: this.isConnected,
                latencyMs,
                lastHealthCheckAt: this.lastHealthCheckAt,
                lastHealthCheckLatencyMs: this.lastHealthCheckLatencyMs,
                error: null
            };
        } catch (error) {
            return {
                ok: false,
                isConnected: this.isConnected,
                latencyMs: null,
                lastHealthCheckAt: this.lastHealthCheckAt,
                lastHealthCheckLatencyMs: this.lastHealthCheckLatencyMs,
                error: error.message
            };
        }
    }

    async getConnection() {
        if (!this.isConnected || !this.pool) {
            throw new Error('MySQL not connected');
        }
        return await this.pool.getConnection();
    }

    async close() {
        if (this.pool) {
            await this.pool.end();
            this.isConnected = false;
            console.log('✅ MySQL Connection Closed');
        }
    }
}

// Export singleton instance
module.exports = new MySQLConnection();