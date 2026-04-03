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

    getDatabaseName() {
        return this.connectionConfig?.database || process.env.MYSQL_DATABASE || 'discord_bot';
    }

    async ensureSchemaMetadataTable() {
        await this.pool.execute(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                migration_key VARCHAR(100) PRIMARY KEY,
                description VARCHAR(255) DEFAULT NULL,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                metadata JSON DEFAULT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
    }

    async hasColumn(tableName, columnName) {
        const [rows] = await this.pool.execute(
            `SELECT 1
             FROM information_schema.columns
             WHERE table_schema = ? AND table_name = ? AND column_name = ?
             LIMIT 1`,
            [this.getDatabaseName(), tableName, columnName]
        );
        return Array.isArray(rows) && rows.length > 0;
    }

    async hasIndex(tableName, indexName) {
        const [rows] = await this.pool.execute(
            `SELECT 1
             FROM information_schema.statistics
             WHERE table_schema = ? AND table_name = ? AND index_name = ?
             LIMIT 1`,
            [this.getDatabaseName(), tableName, indexName]
        );
        return Array.isArray(rows) && rows.length > 0;
    }

    async ensureColumn(tableName, columnName, columnDefinition) {
        if (await this.hasColumn(tableName, columnName)) {
            return false;
        }

        await this.pool.execute(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
        return true;
    }

    async ensureColumns(tableName, columns = []) {
        for (const column of columns) {
            try {
                await this.ensureColumn(tableName, column.name, column.type);
            } catch (error) {
                if (error.code !== 'ER_DUP_FIELDNAME') {
                    console.error(`Error adding column ${column.name} to ${tableName}:`, error.message);
                }
            }
        }
    }

    async ensureIndex(tableName, indexName, indexDefinition) {
        if (await this.hasIndex(tableName, indexName)) {
            return false;
        }

        await this.pool.execute(`CREATE INDEX ${indexName} ON ${tableName}(${indexDefinition})`);
        return true;
    }

    async ensureIndexes(tableName, indexes = []) {
        for (const index of indexes) {
            try {
                await this.ensureIndex(tableName, index.name, index.definition);
            } catch (error) {
                if (error.code !== 'ER_DUP_KEYNAME') {
                    console.error(`Error adding index ${index.name} to ${tableName}:`, error.message);
                }
            }
        }
    }

    async runSchemaMigration(migrationKey, description, handler) {
        if (typeof handler !== 'function') {
            throw new Error(`Migration ${migrationKey} is missing a handler`);
        }

        await this.ensureSchemaMetadataTable();
        const [existingRows] = await this.pool.execute(
            'SELECT migration_key FROM schema_migrations WHERE migration_key = ? LIMIT 1',
            [migrationKey]
        );
        if (Array.isArray(existingRows) && existingRows.length > 0) {
            return false;
        }

        await handler();
        await this.pool.execute(
            'INSERT INTO schema_migrations (migration_key, description) VALUES (?, ?)',
            [migrationKey, description || null]
        );
        return true;
    }

    async ensureTableDefaults(tableName) {
        try {
            await this.pool.execute(`ALTER TABLE ${tableName} ENGINE=InnoDB, CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        } catch (error) {
            console.error(`Error normalizing table options for ${tableName}:`, error.message);
        }
    }

    buildCreateTableSql(schema) {
        const lines = [];
        for (const column of schema.columns || []) {
            lines.push(column);
        }
        for (const constraint of schema.constraints || []) {
            lines.push(constraint);
        }
        for (const index of schema.indexes || []) {
            lines.push(`INDEX ${index.name} (${index.definition})`);
        }

        const tableOptions = schema.options || 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
        return `
            CREATE TABLE IF NOT EXISTS ${schema.name} (
                ${lines.join(',\n                ')}
            ) ${tableOptions}
        `;
    }

    getDeclarativeCoreSchemas() {
        return [
            {
                name: 'userinfo',
                columns: [
                    'user_id BIGINT UNSIGNED PRIMARY KEY',
                    'username VARCHAR(255)',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
                    'last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
                    'is_bot BOOLEAN DEFAULT FALSE'
                ],
                migrationColumns: [
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
                ],
                indexes: [
                    { name: 'idx_username', definition: 'username' }
                ]
            },
            {
                name: 'levels',
                columns: [
                    'user_id VARCHAR(20) PRIMARY KEY',
                    'username VARCHAR(32)',
                    'xp INT DEFAULT 0',
                    'level INT DEFAULT 1',
                    'messages INT DEFAULT 0',
                    'total_xp INT DEFAULT 0',
                    'last_message BIGINT DEFAULT 0',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
                    'updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
                ],
                migrationColumns: [
                    { name: 'username', type: 'VARCHAR(32) DEFAULT NULL' },
                    { name: 'total_xp', type: 'INT DEFAULT 0' }
                ]
            },
            {
                name: 'warns',
                columns: [
                    'id INT AUTO_INCREMENT PRIMARY KEY',
                    'user_id VARCHAR(20) NOT NULL',
                    'case_id VARCHAR(50) NOT NULL',
                    'reason TEXT',
                    'moderator_id VARCHAR(20)',
                    'user_name VARCHAR(100) DEFAULT NULL',
                    'moderator_name VARCHAR(100) DEFAULT NULL',
                    'moderator_source VARCHAR(20) DEFAULT NULL',
                    'type VARCHAR(50)',
                    'timestamp BIGINT',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
                ],
                constraints: [
                    'UNIQUE KEY unique_case (user_id, case_id)'
                ],
                migrationColumns: [
                    { name: 'user_name', type: 'VARCHAR(100) DEFAULT NULL' },
                    { name: 'moderator_name', type: 'VARCHAR(100) DEFAULT NULL' },
                    { name: 'moderator_source', type: 'VARCHAR(20) DEFAULT NULL' }
                ],
                indexes: [
                    { name: 'idx_user', definition: 'user_id' },
                    { name: 'idx_type', definition: 'type' },
                    { name: 'idx_warns_user_timestamp', definition: 'user_id, timestamp' }
                ]
            },
            {
                name: 'user_bans',
                columns: [
                    'user_id VARCHAR(20) PRIMARY KEY',
                    'banned BOOLEAN DEFAULT FALSE',
                    'ban_case_id VARCHAR(50) DEFAULT NULL',
                    'banned_at TIMESTAMP NULL',
                    'banned_by VARCHAR(20) DEFAULT NULL',
                    'ban_reason TEXT DEFAULT NULL',
                    'user_name VARCHAR(100) DEFAULT NULL',
                    'banned_by_name VARCHAR(100) DEFAULT NULL',
                    'banned_by_source VARCHAR(20) DEFAULT NULL',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
                    'updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
                ],
                migrationColumns: [
                    { name: 'user_name', type: 'VARCHAR(100) DEFAULT NULL' },
                    { name: 'banned_by_name', type: 'VARCHAR(100) DEFAULT NULL' },
                    { name: 'banned_by_source', type: 'VARCHAR(20) DEFAULT NULL' },
                    { name: 'ban_case_id', type: 'VARCHAR(50) DEFAULT NULL' },
                    { name: 'banned_at', type: 'TIMESTAMP NULL' },
                    { name: 'banned_by', type: 'VARCHAR(20) DEFAULT NULL' },
                    { name: 'ban_reason', type: 'TEXT DEFAULT NULL' }
                ],
                indexes: [
                    { name: 'idx_banned', definition: 'banned' },
                    { name: 'idx_banned_at', definition: 'banned_at' }
                ]
            },
            {
                name: 'unbans',
                columns: [
                    'id INT AUTO_INCREMENT PRIMARY KEY',
                    'user_id VARCHAR(20) NOT NULL',
                    'unban_case_id VARCHAR(50) NOT NULL',
                    'unbanned_at TIMESTAMP NULL',
                    'unbanned_by VARCHAR(255) DEFAULT NULL',
                    'unbanned_by_name VARCHAR(100) DEFAULT NULL',
                    'unbanned_by_source VARCHAR(20) DEFAULT NULL',
                    'user_name VARCHAR(100) DEFAULT NULL',
                    'original_ban_case_id VARCHAR(50) DEFAULT NULL',
                    'original_ban_reason TEXT DEFAULT NULL',
                    'reason TEXT DEFAULT NULL',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
                ],
                migrationColumns: [
                    { name: 'unbanned_by_name', type: 'VARCHAR(100) DEFAULT NULL' },
                    { name: 'unbanned_by_source', type: 'VARCHAR(20) DEFAULT NULL' },
                    { name: 'user_name', type: 'VARCHAR(100) DEFAULT NULL' }
                ],
                indexes: [
                    { name: 'idx_unbans_user', definition: 'user_id' },
                    { name: 'idx_unbans_case', definition: 'unban_case_id' },
                    { name: 'idx_unbans_time', definition: 'unbanned_at' }
                ]
            },
            {
                name: 'reminders',
                columns: [
                    'id VARCHAR(50) PRIMARY KEY',
                    'case_id VARCHAR(20) UNIQUE',
                    'user_id VARCHAR(20) NOT NULL',
                    'message TEXT',
                    'text TEXT',
                    'timestamp BIGINT',
                    'created_at BIGINT',
                    'trigger_at BIGINT',
                    'channel_id VARCHAR(20)',
                    'guild_id VARCHAR(20)',
                    'completed BOOLEAN DEFAULT FALSE',
                    'delivery_attempts INT DEFAULT 0',
                    'last_failure_reason TEXT',
                    'last_failure_time BIGINT'
                ],
                migrationColumns: [
                    { name: 'case_id', type: 'VARCHAR(20) UNIQUE' },
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
                ],
                indexes: [
                    { name: 'idx_user', definition: 'user_id' },
                    { name: 'idx_timestamp', definition: 'timestamp' },
                    { name: 'idx_trigger', definition: 'trigger_at' },
                    { name: 'idx_completed', definition: 'completed' }
                ]
            },
            {
                name: 'timeouts',
                columns: [
                    'id INT AUTO_INCREMENT PRIMARY KEY',
                    'user_id VARCHAR(20) NOT NULL',
                    'case_id VARCHAR(50) DEFAULT NULL',
                    'username VARCHAR(100)',
                    'reason TEXT',
                    'issued_by VARCHAR(20)',
                    'issued_by_name VARCHAR(100) DEFAULT NULL',
                    'issued_by_source VARCHAR(20) DEFAULT NULL',
                    'issued_at BIGINT',
                    'expires_at BIGINT',
                    'active BOOLEAN DEFAULT TRUE',
                    'cleared_at BIGINT DEFAULT NULL',
                    'cleared_by VARCHAR(20) DEFAULT NULL',
                    'cleared_case_id VARCHAR(50) DEFAULT NULL',
                    'cleared_reason TEXT'
                ],
                migrationColumns: [
                    { name: 'case_id', type: 'VARCHAR(50) DEFAULT NULL' },
                    { name: 'issued_by_name', type: 'VARCHAR(100) DEFAULT NULL' },
                    { name: 'issued_by_source', type: 'VARCHAR(20) DEFAULT NULL' },
                    { name: 'cleared_at', type: 'BIGINT DEFAULT NULL' },
                    { name: 'cleared_by', type: 'VARCHAR(20) DEFAULT NULL' },
                    { name: 'cleared_case_id', type: 'VARCHAR(50) DEFAULT NULL' },
                    { name: 'cleared_reason', type: 'TEXT' }
                ],
                indexes: [
                    { name: 'idx_user', definition: 'user_id' },
                    { name: 'idx_active', definition: 'active' },
                    { name: 'idx_expires', definition: 'expires_at' }
                ]
            },
            {
                name: 'kicks',
                columns: [
                    'id INT AUTO_INCREMENT PRIMARY KEY',
                    'case_id VARCHAR(50) DEFAULT NULL',
                    'user_id VARCHAR(20) NOT NULL',
                    'username VARCHAR(100)',
                    'reason TEXT',
                    'kicked_by VARCHAR(20)',
                    'kicked_by_name VARCHAR(100) DEFAULT NULL',
                    'kicked_by_source VARCHAR(20) DEFAULT NULL',
                    'kicked_at BIGINT'
                ],
                migrationColumns: [
                    { name: 'kicked_by_name', type: 'VARCHAR(100) DEFAULT NULL' },
                    { name: 'kicked_by_source', type: 'VARCHAR(20) DEFAULT NULL' }
                ],
                indexes: [
                    { name: 'idx_user', definition: 'user_id' },
                    { name: 'idx_kicked_at', definition: 'kicked_at' }
                ]
            },
            {
                name: 'moderation_cases',
                columns: [
                    'case_id VARCHAR(50) PRIMARY KEY',
                    'guild_id VARCHAR(20) DEFAULT NULL',
                    'user_id VARCHAR(20) NOT NULL',
                    'user_name VARCHAR(100) DEFAULT NULL',
                    'action_type VARCHAR(20) NOT NULL',
                    'status VARCHAR(20) NOT NULL DEFAULT \'open\'',
                    'reason TEXT',
                    'moderator_id VARCHAR(20) DEFAULT NULL',
                    'moderator_name VARCHAR(100) DEFAULT NULL',
                    'moderator_source VARCHAR(20) DEFAULT NULL',
                    'source VARCHAR(20) DEFAULT \'discord\'',
                    'related_case_id VARCHAR(50) DEFAULT NULL',
                    'root_case_id VARCHAR(50) DEFAULT NULL',
                    'expires_at BIGINT DEFAULT NULL',
                    'closed_at BIGINT DEFAULT NULL',
                    'metadata JSON DEFAULT NULL',
                    'created_at BIGINT NOT NULL',
                    'updated_at BIGINT NOT NULL'
                ],
                migrationColumns: [
                    { name: 'guild_id', type: 'VARCHAR(20) DEFAULT NULL' },
                    { name: 'user_name', type: 'VARCHAR(100) DEFAULT NULL' },
                    { name: 'status', type: "VARCHAR(20) NOT NULL DEFAULT 'open'" },
                    { name: 'moderator_name', type: 'VARCHAR(100) DEFAULT NULL' },
                    { name: 'moderator_source', type: 'VARCHAR(20) DEFAULT NULL' },
                    { name: 'source', type: "VARCHAR(20) DEFAULT 'discord'" },
                    { name: 'related_case_id', type: 'VARCHAR(50) DEFAULT NULL' },
                    { name: 'root_case_id', type: 'VARCHAR(50) DEFAULT NULL' },
                    { name: 'expires_at', type: 'BIGINT DEFAULT NULL' },
                    { name: 'closed_at', type: 'BIGINT DEFAULT NULL' },
                    { name: 'metadata', type: 'JSON DEFAULT NULL' },
                    { name: 'created_at', type: 'BIGINT NOT NULL DEFAULT 0' },
                    { name: 'updated_at', type: 'BIGINT NOT NULL DEFAULT 0' }
                ],
                indexes: [
                    { name: 'idx_moderation_cases_user', definition: 'user_id, created_at' },
                    { name: 'idx_moderation_cases_moderator', definition: 'moderator_id, created_at' },
                    { name: 'idx_moderation_cases_status', definition: 'status, created_at' },
                    { name: 'idx_moderation_cases_action', definition: 'action_type, created_at' },
                    { name: 'idx_moderation_cases_related', definition: 'related_case_id' },
                    { name: 'idx_moderation_cases_root', definition: 'root_case_id' },
                    { name: 'idx_moderation_cases_guild', definition: 'guild_id, created_at' }
                ]
            },
            {
                name: 'moderation_case_events',
                columns: [
                    'id BIGINT AUTO_INCREMENT PRIMARY KEY',
                    'case_id VARCHAR(50) NOT NULL',
                    'guild_id VARCHAR(20) DEFAULT NULL',
                    'event_type VARCHAR(30) NOT NULL',
                    'summary VARCHAR(255) DEFAULT NULL',
                    'details TEXT',
                    'actor_id VARCHAR(20) DEFAULT NULL',
                    'actor_name VARCHAR(100) DEFAULT NULL',
                    'related_case_id VARCHAR(50) DEFAULT NULL',
                    'metadata JSON DEFAULT NULL',
                    'created_at BIGINT NOT NULL'
                ],
                indexes: [
                    { name: 'idx_moderation_case_events_case', definition: 'case_id, created_at' },
                    { name: 'idx_moderation_case_events_type', definition: 'event_type, created_at' },
                    { name: 'idx_moderation_case_events_related', definition: 'related_case_id' }
                ]
            },
            {
                name: 'moderation_incidents',
                columns: [
                    'id BIGINT AUTO_INCREMENT PRIMARY KEY',
                    'case_id VARCHAR(50) NOT NULL',
                    'user_id VARCHAR(20) NOT NULL',
                    'action_type VARCHAR(20) NOT NULL DEFAULT \'OTHER\'',
                    'reason TEXT',
                    'proof_text TEXT',
                    'proof_url VARCHAR(1000) DEFAULT NULL',
                    'attachment_url VARCHAR(1000) DEFAULT NULL',
                    'message_link VARCHAR(500) DEFAULT NULL',
                    'moderator_id VARCHAR(20) NOT NULL',
                    'moderator_name VARCHAR(100) DEFAULT NULL',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
                    'updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
                ],
                constraints: [
                    'UNIQUE KEY uq_moderation_incident_case (case_id)'
                ],
                indexes: [
                    { name: 'idx_moderation_incident_user', definition: 'user_id' },
                    { name: 'idx_moderation_incident_action', definition: 'action_type' },
                    { name: 'idx_moderation_incident_created', definition: 'created_at' }
                ]
            },
            {
                name: 'sessions',
                columns: [
                    'session_id VARCHAR(128) PRIMARY KEY',
                    'expires INT UNSIGNED NOT NULL',
                    'data TEXT'
                ],
                indexes: [
                    { name: 'idx_expires', definition: 'expires' }
                ]
            },
            {
                name: 'user_interactions',
                columns: [
                    'id INT AUTO_INCREMENT PRIMARY KEY',
                    'user_id VARCHAR(20) NOT NULL',
                    'username VARCHAR(32) DEFAULT NULL',
                    'command_name VARCHAR(100) NOT NULL',
                    'command_category VARCHAR(50) DEFAULT NULL',
                    'guild_id VARCHAR(20) DEFAULT NULL',
                    'channel_id VARCHAR(20) DEFAULT NULL',
                    'status ENUM(\'SUCCESS\', \'ERROR\', \'RATE_LIMIT\', \'PERMISSION\') DEFAULT \'SUCCESS\'',
                    'error_message TEXT DEFAULT NULL',
                    'created_at BIGINT NOT NULL'
                ],
                migrationColumns: [
                    { name: 'status', type: "ENUM('SUCCESS', 'ERROR', 'RATE_LIMIT', 'PERMISSION') DEFAULT 'SUCCESS'" },
                    { name: 'error_message', type: 'TEXT DEFAULT NULL' },
                    { name: 'command_name', type: "VARCHAR(100) NOT NULL DEFAULT ''" },
                    { name: 'command_category', type: 'VARCHAR(50) DEFAULT NULL' },
                    { name: 'guild_id', type: 'VARCHAR(20) DEFAULT NULL' },
                    { name: 'channel_id', type: 'VARCHAR(20) DEFAULT NULL' },
                    { name: 'username', type: 'VARCHAR(32) DEFAULT NULL' },
                    { name: 'created_at', type: 'BIGINT NOT NULL DEFAULT 0' }
                ],
                indexes: [
                    { name: 'idx_user', definition: 'user_id' },
                    { name: 'idx_command', definition: 'command_name' },
                    { name: 'idx_created', definition: 'created_at' }
                ]
            }
        ];
    }

    async initializeDeclarativeCoreTables() {
        for (const schema of this.getDeclarativeCoreSchemas()) {
            await this.pool.execute(this.buildCreateTableSql(schema));
            await this.ensureColumns(schema.name, schema.migrationColumns || []);
            await this.ensureIndexes(schema.name, schema.indexes || []);
        }
    }

    getDeclarativeExtendedSchemas() {
        return [
            {
                name: 'invite_usage',
                columns: [
                    'guild_id BIGINT UNSIGNED NOT NULL',
                    'invite_code VARCHAR(32) NOT NULL',
                    'inviter_id VARCHAR(20) DEFAULT NULL',
                    'join_count INT NOT NULL DEFAULT 0',
                    'last_joined_at BIGINT DEFAULT NULL',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
                    'updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
                ],
                constraints: [
                    'PRIMARY KEY (guild_id, invite_code)'
                ],
                indexes: [
                    { name: 'idx_inviter', definition: 'guild_id, inviter_id' },
                    { name: 'idx_guild', definition: 'guild_id' }
                ]
            },
            {
                name: 'giveaways',
                columns: [
                    'id VARCHAR(50) PRIMARY KEY',
                    'case_id VARCHAR(20) UNIQUE',
                    'prize TEXT',
                    'title TEXT',
                    'channel_id VARCHAR(20)',
                    'message_id VARCHAR(20)',
                    'host_id VARCHAR(20)',
                    'end_time BIGINT',
                    'winner_count INT DEFAULT 1',
                    'required_role_id VARCHAR(20) DEFAULT NULL',
                    'winner_ids TEXT DEFAULT NULL',
                    'ended BOOLEAN DEFAULT FALSE',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
                    'updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
                ],
                migrationColumns: [
                    { name: 'guild_id', type: 'VARCHAR(20) NOT NULL' },
                    { name: 'required_role_id', type: 'VARCHAR(20) DEFAULT NULL' },
                    { name: 'winner_ids', type: 'TEXT DEFAULT NULL' }
                ]
            },
            {
                name: 'giveaway_entries',
                columns: [
                    'id INT AUTO_INCREMENT PRIMARY KEY',
                    'giveaway_id VARCHAR(50) NOT NULL',
                    'user_id VARCHAR(20) NOT NULL',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
                ],
                constraints: [
                    'UNIQUE KEY unique_entry (giveaway_id, user_id)',
                    'FOREIGN KEY (giveaway_id) REFERENCES giveaways(id) ON DELETE CASCADE'
                ]
            },
            {
                name: 'tickets',
                columns: [
                    'channel_id VARCHAR(20) PRIMARY KEY',
                    'user_id VARCHAR(20) NOT NULL',
                    'user_name VARCHAR(100) NOT NULL',
                    'reason TEXT',
                    "priority ENUM('low', 'medium', 'high') DEFAULT 'medium'",
                    'created_at BIGINT NOT NULL',
                    'claimed_by VARCHAR(20) DEFAULT NULL',
                    "status VARCHAR(32) DEFAULT 'open'",
                    'claimed_by_name VARCHAR(100) DEFAULT NULL',
                    'closed_at BIGINT DEFAULT NULL',
                    'closed_by VARCHAR(20) DEFAULT NULL',
                    'closed_by_name VARCHAR(100) DEFAULT NULL',
                    'close_reason TEXT DEFAULT NULL',
                    'transcript LONGTEXT DEFAULT NULL',
                    'transcript_created_at BIGINT DEFAULT NULL',
                    'updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
                ],
                indexes: [
                    { name: 'idx_user_id', definition: 'user_id' },
                    { name: 'idx_status', definition: 'status' },
                    { name: 'idx_priority', definition: 'priority' }
                ]
            },
            {
                name: 'join_to_create',
                columns: [
                    'channel_id VARCHAR(20) PRIMARY KEY',
                    'owner_id VARCHAR(20) NOT NULL',
                    'guild_id VARCHAR(20) NOT NULL',
                    'channel_name VARCHAR(100) NOT NULL',
                    'created_at BIGINT NOT NULL',
                    'is_active BOOLEAN DEFAULT TRUE'
                ],
                indexes: [
                    { name: 'idx_owner_id', definition: 'owner_id' },
                    { name: 'idx_guild_id', definition: 'guild_id' },
                    { name: 'idx_is_active', definition: 'is_active' }
                ]
            },
            {
                name: 'birthdays',
                columns: [
                    'id INT AUTO_INCREMENT PRIMARY KEY',
                    'guild_id VARCHAR(20) NOT NULL',
                    'user_id VARCHAR(20) NOT NULL',
                    'month TINYINT UNSIGNED NOT NULL',
                    'day TINYINT UNSIGNED NOT NULL',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
                    'updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
                ],
                constraints: ['UNIQUE KEY unique_guild_user (guild_id, user_id)'],
                indexes: [
                    { name: 'idx_guild_month_day', definition: 'guild_id, month, day' },
                    { name: 'idx_user_id', definition: 'user_id' }
                ]
            },
            {
                name: 'birthday_announcements',
                columns: [
                    'id INT AUTO_INCREMENT PRIMARY KEY',
                    'guild_id VARCHAR(20) NOT NULL',
                    'user_id VARCHAR(20) NOT NULL',
                    'date_key CHAR(10) NOT NULL',
                    'sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
                ],
                constraints: ['UNIQUE KEY unique_daily_announcement (guild_id, user_id, date_key)'],
                indexes: [
                    { name: 'idx_guild_date', definition: 'guild_id, date_key' },
                    { name: 'idx_sent_at', definition: 'sent_at' }
                ]
            },
            {
                name: 'reputation_points',
                columns: [
                    'id INT AUTO_INCREMENT PRIMARY KEY',
                    'guild_id VARCHAR(20) NOT NULL',
                    'user_id VARCHAR(20) NOT NULL',
                    'points INT UNSIGNED NOT NULL DEFAULT 0',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
                    'updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
                ],
                constraints: ['UNIQUE KEY unique_reputation_user (guild_id, user_id)'],
                indexes: [
                    { name: 'idx_reputation_guild_points', definition: 'guild_id, points' },
                    { name: 'idx_reputation_user', definition: 'user_id' }
                ]
            },
            {
                name: 'reputation_grants',
                columns: [
                    'id BIGINT AUTO_INCREMENT PRIMARY KEY',
                    'guild_id VARCHAR(20) NOT NULL',
                    'giver_id VARCHAR(20) NOT NULL',
                    'target_id VARCHAR(20) NOT NULL',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
                ],
                migrationColumns: [
                    { name: 'reason', type: 'VARCHAR(160) DEFAULT NULL' }
                ],
                indexes: [
                    { name: 'idx_rep_grants_guild_giver_time', definition: 'guild_id, giver_id, created_at' },
                    { name: 'idx_rep_grants_pair_time', definition: 'guild_id, giver_id, target_id, created_at' },
                    { name: 'idx_rep_grants_target_time', definition: 'guild_id, target_id, created_at' }
                ]
            },
            {
                name: 'economy_balances',
                columns: [
                    'id BIGINT AUTO_INCREMENT PRIMARY KEY',
                    'guild_id VARCHAR(20) NOT NULL',
                    'user_id VARCHAR(20) NOT NULL',
                    'wallet BIGINT UNSIGNED NOT NULL DEFAULT 0',
                    'bank BIGINT UNSIGNED NOT NULL DEFAULT 0',
                    'total_earned BIGINT UNSIGNED NOT NULL DEFAULT 0',
                    'total_spent BIGINT UNSIGNED NOT NULL DEFAULT 0',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
                    'updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
                ],
                constraints: ['UNIQUE KEY uq_economy_user (guild_id, user_id)'],
                indexes: [
                    { name: 'idx_economy_guild_wallet', definition: 'guild_id, wallet' },
                    { name: 'idx_economy_guild_bank', definition: 'guild_id, bank' },
                    { name: 'idx_economy_user', definition: 'user_id' }
                ]
            },
            {
                name: 'economy_transactions',
                columns: [
                    'id BIGINT AUTO_INCREMENT PRIMARY KEY',
                    'guild_id VARCHAR(20) NOT NULL',
                    'user_id VARCHAR(20) NOT NULL',
                    'tx_type VARCHAR(40) NOT NULL',
                    'amount BIGINT NOT NULL',
                    'source_user_id VARCHAR(20) DEFAULT NULL',
                    'note VARCHAR(255) DEFAULT NULL',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
                ],
                indexes: [
                    { name: 'idx_economy_tx_guild_user_time', definition: 'guild_id, user_id, created_at' },
                    { name: 'idx_economy_tx_guild_type_time', definition: 'guild_id, tx_type, created_at' },
                    { name: 'idx_economy_tx_source_user', definition: 'source_user_id' }
                ]
            },
            {
                name: 'economy_interest_runs',
                columns: [
                    'id BIGINT AUTO_INCREMENT PRIMARY KEY',
                    'guild_id VARCHAR(20) NOT NULL',
                    'run_date CHAR(10) NOT NULL',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
                ],
                constraints: ['UNIQUE KEY uq_economy_interest_run (guild_id, run_date)'],
                indexes: [{ name: 'idx_economy_interest_guild', definition: 'guild_id' }]
            },
            {
                name: 'economy_fraud_flags',
                columns: [
                    'id BIGINT AUTO_INCREMENT PRIMARY KEY',
                    'guild_id VARCHAR(20) NOT NULL',
                    'user_id VARCHAR(20) NOT NULL',
                    'flag_type VARCHAR(40) NOT NULL',
                    "severity ENUM('low', 'medium', 'high') DEFAULT 'medium'",
                    'details JSON DEFAULT NULL',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
                ],
                indexes: [
                    { name: 'idx_economy_fraud_guild', definition: 'guild_id, created_at' },
                    { name: 'idx_economy_fraud_user', definition: 'guild_id, user_id, created_at' },
                    { name: 'idx_economy_fraud_type', definition: 'flag_type' }
                ]
            },
            {
                name: 'economy_inventory',
                columns: [
                    'id BIGINT AUTO_INCREMENT PRIMARY KEY',
                    'guild_id VARCHAR(20) NOT NULL',
                    'user_id VARCHAR(20) NOT NULL',
                    'item_id VARCHAR(50) NOT NULL',
                    'quantity INT UNSIGNED NOT NULL DEFAULT 0',
                    'updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
                ],
                constraints: ['UNIQUE KEY uq_economy_inventory (guild_id, user_id, item_id)'],
                indexes: [{ name: 'idx_economy_inventory_user', definition: 'guild_id, user_id' }]
            },
            {
                name: 'economy_boosts',
                columns: [
                    'id BIGINT AUTO_INCREMENT PRIMARY KEY',
                    'guild_id VARCHAR(20) NOT NULL',
                    'user_id VARCHAR(20) NOT NULL',
                    'boost_type VARCHAR(40) NOT NULL',
                    'multiplier DECIMAL(6,2) NOT NULL DEFAULT 1.0',
                    'uses_remaining INT UNSIGNED NOT NULL DEFAULT 1',
                    'expires_at BIGINT NOT NULL DEFAULT 0',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
                ],
                indexes: [
                    { name: 'idx_economy_boosts_user', definition: 'guild_id, user_id' },
                    { name: 'idx_economy_boosts_type', definition: 'boost_type' },
                    { name: 'idx_economy_boosts_expires', definition: 'expires_at' }
                ]
            },
            {
                name: 'economy_quest_progress',
                columns: [
                    'id BIGINT AUTO_INCREMENT PRIMARY KEY',
                    'guild_id VARCHAR(20) NOT NULL',
                    'user_id VARCHAR(20) NOT NULL',
                    'quest_key VARCHAR(50) NOT NULL',
                    "cadence ENUM('daily', 'weekly') NOT NULL",
                    'period_start CHAR(10) NOT NULL',
                    'progress INT UNSIGNED NOT NULL DEFAULT 0',
                    'completed_at TIMESTAMP NULL DEFAULT NULL',
                    'claimed_at TIMESTAMP NULL DEFAULT NULL',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
                    'updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
                ],
                constraints: ['UNIQUE KEY uq_economy_quest (guild_id, user_id, quest_key, cadence, period_start)'],
                indexes: [
                    { name: 'idx_economy_quest_user', definition: 'guild_id, user_id' },
                    { name: 'idx_economy_quest_period', definition: 'guild_id, cadence, period_start' }
                ]
            },
            {
                name: 'economy_bounties',
                columns: [
                    'bounty_id BIGINT AUTO_INCREMENT PRIMARY KEY',
                    'guild_id VARCHAR(20) NOT NULL',
                    'created_by VARCHAR(20) NOT NULL',
                    'title VARCHAR(120) NOT NULL',
                    'description TEXT DEFAULT NULL',
                    'reward_amount BIGINT UNSIGNED NOT NULL',
                    "status ENUM('open', 'awarded', 'closed') DEFAULT 'open'",
                    'awarded_to VARCHAR(20) DEFAULT NULL',
                    'awarded_by VARCHAR(20) DEFAULT NULL',
                    'awarded_at TIMESTAMP NULL DEFAULT NULL',
                    'closed_at TIMESTAMP NULL DEFAULT NULL',
                    'close_reason VARCHAR(255) DEFAULT NULL',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
                ],
                indexes: [
                    { name: 'idx_economy_bounty_status', definition: 'guild_id, status' },
                    { name: 'idx_economy_bounty_created', definition: 'guild_id, created_at' }
                ]
            },
            {
                name: 'admin_users',
                columns: [
                    'id CHAR(36) PRIMARY KEY',
                    'username VARCHAR(50) UNIQUE NOT NULL',
                    'password_hash VARCHAR(255) NOT NULL',
                    "role ENUM('owner', 'admin', 'moderator') DEFAULT 'moderator'",
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
                    'last_login TIMESTAMP NULL DEFAULT NULL',
                    'active BOOLEAN DEFAULT TRUE'
                ],
                migrationColumns: [
                    { name: 'email', type: 'VARCHAR(254) DEFAULT NULL' },
                    { name: 'avatar_url', type: 'VARCHAR(1024) DEFAULT NULL' },
                    { name: 'avatar_updated_at', type: 'TIMESTAMP NULL DEFAULT NULL' },
                    { name: 'email_verified', type: 'BOOLEAN DEFAULT FALSE' },
                    { name: 'email_verification_token', type: 'VARCHAR(128) DEFAULT NULL' },
                    { name: 'email_verification_expires', type: 'TIMESTAMP NULL DEFAULT NULL' },
                    { name: 'password_reset_token', type: 'VARCHAR(128) DEFAULT NULL' },
                    { name: 'password_reset_expires', type: 'TIMESTAMP NULL DEFAULT NULL' },
                    { name: 'two_factor_enabled', type: 'BOOLEAN DEFAULT FALSE' },
                    { name: 'two_factor_secret', type: 'TEXT DEFAULT NULL' },
                    { name: 'two_factor_enabled_at', type: 'TIMESTAMP NULL DEFAULT NULL' },
                    { name: 'two_factor_last_counter', type: 'BIGINT DEFAULT NULL' },
                    { name: 'two_factor_last_verified_at', type: 'TIMESTAMP NULL DEFAULT NULL' },
                    { name: 'password_changed_at', type: 'TIMESTAMP NULL DEFAULT NULL' },
                    { name: 'recovery_code_hashes', type: 'TEXT DEFAULT NULL' },
                    { name: 'recovery_codes_generated_at', type: 'TIMESTAMP NULL DEFAULT NULL' },
                    { name: 'trusted_devices_json', type: 'TEXT DEFAULT NULL' },
                    { name: 'discord_user_id', type: 'VARCHAR(20) DEFAULT NULL' },
                    { name: 'discord_username', type: 'VARCHAR(100) DEFAULT NULL' },
                    { name: 'discord_linked_at', type: 'TIMESTAMP NULL DEFAULT NULL' },
                    { name: 'discord_last_verified_at', type: 'TIMESTAMP NULL DEFAULT NULL' },
                    { name: 'discord_guild_verified_at', type: 'TIMESTAMP NULL DEFAULT NULL' },
                    { name: 'discord_role_verified_at', type: 'TIMESTAMP NULL DEFAULT NULL' },
                    { name: 'discord_last_trusted_role', type: 'VARCHAR(20) DEFAULT NULL' },
                    { name: 'discord_last_role_sync_at', type: 'TIMESTAMP NULL DEFAULT NULL' }
                ],
                indexes: [
                    { name: 'idx_username', definition: 'username' },
                    { name: 'idx_active', definition: 'active' }
                ]
            },
            {
                name: 'admin_auth_events',
                columns: [
                    'id CHAR(36) PRIMARY KEY',
                    'username VARCHAR(50) NOT NULL',
                    "event_type ENUM('LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGIN_2FA_CHALLENGE', 'LOGIN_2FA_FAILED', 'LOGOUT', 'PASSWORD_CHANGED', 'TWO_FACTOR_ENABLED', 'TWO_FACTOR_DISABLED', 'SESSIONS_REVOKED', 'EMAIL_CHANGED', 'EMAIL_VERIFIED', 'PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED') NOT NULL",
                    'ip_address VARCHAR(64) DEFAULT NULL',
                    'user_agent VARCHAR(255) DEFAULT NULL',
                    'metadata JSON DEFAULT NULL',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
                ],
                indexes: [
                    { name: 'idx_admin_auth_username_created', definition: 'username, created_at' },
                    { name: 'idx_admin_auth_event_type', definition: 'event_type' }
                ]
            },
            {
                name: 'audit_logs',
                columns: [
                    'id INT AUTO_INCREMENT PRIMARY KEY',
                    'guild_id VARCHAR(20) NOT NULL',
                    "event_type ENUM('MESSAGE_DELETE', 'MESSAGE_EDIT', 'MEMBER_JOIN', 'MEMBER_LEAVE', 'MEMBER_BAN', 'MEMBER_UNBAN', 'MEMBER_KICK', 'ROLE_ADD', 'ROLE_REMOVE', 'CHANNEL_CREATE', 'CHANNEL_DELETE', 'VOICE_JOIN', 'VOICE_LEAVE', 'VOICE_MOVE', 'NICKNAME_CHANGE', 'USERNAME_CHANGE', 'WARN', 'TIMEOUT', 'OTHER') NOT NULL",
                    'user_id VARCHAR(20)',
                    'moderator_id VARCHAR(20)',
                    'channel_id VARCHAR(20)',
                    'before_content TEXT',
                    'after_content TEXT',
                    'reason TEXT',
                    'metadata JSON',
                    'timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
                ],
                indexes: [
                    { name: 'idx_event_type', definition: 'event_type' },
                    { name: 'idx_user_id', definition: 'user_id' },
                    { name: 'idx_guild_id', definition: 'guild_id' },
                    { name: 'idx_timestamp', definition: 'timestamp' }
                ]
            },
            {
                name: 'suggestions',
                columns: [
                    'suggestion_id INT AUTO_INCREMENT PRIMARY KEY',
                    'guild_id VARCHAR(20) NOT NULL',
                    'user_id VARCHAR(20) NOT NULL',
                    'title VARCHAR(100) NOT NULL',
                    'description TEXT NOT NULL',
                    'message_id VARCHAR(20)',
                    'case_id VARCHAR(32)',
                    "status ENUM('pending', 'approved', 'denied', 'implemented') DEFAULT 'pending'",
                    'upvotes INT DEFAULT 0',
                    'downvotes INT DEFAULT 0',
                    'admin_response TEXT',
                    'responded_by VARCHAR(20)',
                    'resolved_at TIMESTAMP NULL',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
                    'updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
                ],
                migrationColumns: [
                    { name: 'case_id', type: 'VARCHAR(32)' }
                ],
                indexes: [
                    { name: 'idx_status', definition: 'status' },
                    { name: 'idx_guild_id', definition: 'guild_id' },
                    { name: 'idx_user_id', definition: 'user_id' },
                    { name: 'idx_message_id', definition: 'message_id' },
                    { name: 'idx_case_id', definition: 'case_id' }
                ]
            },
            {
                name: 'suggestion_votes',
                columns: [
                    'id INT AUTO_INCREMENT PRIMARY KEY',
                    'suggestion_id VARCHAR(20) NOT NULL',
                    'user_id VARCHAR(20) NOT NULL',
                    "vote_type ENUM('upvote', 'downvote') NOT NULL",
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
                ],
                constraints: ['UNIQUE KEY unique_vote (suggestion_id, user_id)'],
                indexes: [{ name: 'idx_suggestion_id', definition: 'suggestion_id' }]
            },
            {
                name: 'automod_violations',
                columns: [
                    'id INT AUTO_INCREMENT PRIMARY KEY',
                    'user_id VARCHAR(20) NOT NULL',
                    'guild_id VARCHAR(20) NOT NULL',
                    "violation_type ENUM('spam', 'caps', 'links', 'invites', 'mentions', 'profanity', 'similarity', 'regex') NOT NULL",
                    'message_content TEXT',
                    'channel_id VARCHAR(20)',
                    "action_taken ENUM('delete', 'warn', 'timeout', 'kick', 'ban') NOT NULL",
                    'risk_score INT DEFAULT NULL',
                    "risk_level ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium'",
                    'signal_count INT DEFAULT 1',
                    'appeal_notified BOOLEAN DEFAULT FALSE',
                    'metadata_json JSON DEFAULT NULL',
                    'timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
                ],
                migrationColumns: [
                    { name: 'risk_score', type: 'INT DEFAULT NULL' },
                    { name: 'risk_level', type: "ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium'" },
                    { name: 'signal_count', type: 'INT DEFAULT 1' },
                    { name: 'appeal_notified', type: 'BOOLEAN DEFAULT FALSE' },
                    { name: 'metadata_json', type: 'JSON DEFAULT NULL' }
                ],
                indexes: [
                    { name: 'idx_user_id', definition: 'user_id' },
                    { name: 'idx_violation_type', definition: 'violation_type' },
                    { name: 'idx_timestamp', definition: 'timestamp' }
                ]
            },
            {
                name: 'anti_raid_events',
                columns: [
                    'id INT AUTO_INCREMENT PRIMARY KEY',
                    'guild_id VARCHAR(20) NOT NULL',
                    "event_type ENUM('lockdown_start', 'lockdown_end', 'manual_enable', 'manual_disable') NOT NULL",
                    'risk_score INT DEFAULT NULL',
                    'trigger_count INT DEFAULT NULL',
                    'details_json JSON DEFAULT NULL',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
                ],
                indexes: [
                    { name: 'idx_anti_raid_guild_created', definition: 'guild_id, created_at' },
                    { name: 'idx_anti_raid_type', definition: 'event_type' }
                ]
            },
            {
                name: 'manual_lockdowns',
                columns: [
                    'id INT AUTO_INCREMENT PRIMARY KEY',
                    'guild_id VARCHAR(20) NOT NULL',
                    "action_type ENUM('enable', 'disable') NOT NULL",
                    'case_id VARCHAR(32) NOT NULL',
                    'moderator_id VARCHAR(20) NOT NULL',
                    'moderator_name VARCHAR(100) DEFAULT NULL',
                    'reason TEXT NOT NULL',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
                ],
                indexes: [
                    { name: 'idx_manual_lockdowns_guild_created', definition: 'guild_id, created_at' },
                    { name: 'idx_manual_lockdowns_case', definition: 'case_id' },
                    { name: 'idx_manual_lockdowns_action', definition: 'action_type' }
                ]
            },
            {
                name: 'automod_violation_reviews',
                columns: [
                    'violation_id INT PRIMARY KEY',
                    "status ENUM('pending', 'approved', 'dismissed') NOT NULL DEFAULT 'pending'",
                    "severity ENUM('low', 'medium', 'high', 'critical') NOT NULL DEFAULT 'medium'",
                    'reviewer_username VARCHAR(100) DEFAULT NULL',
                    'reviewed_at TIMESTAMP NULL',
                    'note TEXT',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
                    'updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
                ],
                constraints: [
                    'CONSTRAINT fk_automod_review_violation FOREIGN KEY (violation_id) REFERENCES automod_violations(id) ON DELETE CASCADE'
                ],
                indexes: [
                    { name: 'idx_automod_review_status', definition: 'status' },
                    { name: 'idx_automod_review_severity', definition: 'severity' },
                    { name: 'idx_automod_review_reviewed_at', definition: 'reviewed_at' }
                ]
            },
            {
                name: 'polls',
                columns: [
                    'id INT AUTO_INCREMENT PRIMARY KEY',
                    'message_id VARCHAR(20) UNIQUE NOT NULL',
                    'guild_id VARCHAR(20) NOT NULL',
                    'user_id VARCHAR(20) NOT NULL',
                    'question TEXT NOT NULL',
                    'options JSON NOT NULL',
                    'ends_at TIMESTAMP NULL',
                    'ended BOOLEAN DEFAULT FALSE',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
                ],
                indexes: [
                    { name: 'idx_message_id', definition: 'message_id' },
                    { name: 'idx_guild_id', definition: 'guild_id' },
                    { name: 'idx_ended', definition: 'ended' }
                ]
            },
            {
                name: 'member_activity',
                columns: [
                    'id INT AUTO_INCREMENT PRIMARY KEY',
                    'user_id VARCHAR(20) NOT NULL',
                    'username VARCHAR(100)',
                    "event_type ENUM('join', 'leave') NOT NULL",
                    'guild_id VARCHAR(20) NOT NULL',
                    'timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
                ],
                indexes: [
                    { name: 'idx_event_type', definition: 'event_type' },
                    { name: 'idx_timestamp', definition: 'timestamp' },
                    { name: 'idx_guild_id', definition: 'guild_id' }
                ]
            },
            {
                name: 'user_channel_activity',
                columns: [
                    'id BIGINT AUTO_INCREMENT PRIMARY KEY',
                    'guild_id VARCHAR(20) NOT NULL',
                    'user_id VARCHAR(20) NOT NULL',
                    'channel_id VARCHAR(20) NOT NULL',
                    'username VARCHAR(100) NULL',
                    'message_count INT UNSIGNED NOT NULL DEFAULT 0',
                    'first_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
                    'last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
                ],
                constraints: ['UNIQUE KEY unique_user_channel (guild_id, user_id, channel_id)'],
                indexes: [
                    { name: 'idx_uca_user', definition: 'guild_id, user_id' },
                    { name: 'idx_uca_channel', definition: 'guild_id, channel_id' },
                    { name: 'idx_uca_message_count', definition: 'message_count' }
                ]
            },
            {
                name: 'admin_invite_codes',
                columns: [
                    'id INT AUTO_INCREMENT PRIMARY KEY',
                    'code VARCHAR(32) UNIQUE NOT NULL',
                    'created_by VARCHAR(50) NOT NULL',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
                    'expires_at TIMESTAMP NULL',
                    'used_by VARCHAR(50) DEFAULT NULL',
                    'used_at TIMESTAMP NULL DEFAULT NULL',
                    "role ENUM('owner', 'admin', 'moderator') DEFAULT 'moderator'",
                    'active BOOLEAN DEFAULT TRUE',
                    'max_uses INT DEFAULT 1',
                    'current_uses INT DEFAULT 0',
                    'description TEXT NULL',
                    'revoked_by VARCHAR(50) NULL',
                    'revoked_at TIMESTAMP NULL',
                    'last_view_at TIMESTAMP NULL',
                    'view_count INT DEFAULT 0'
                ],
                migrationColumns: [
                    { name: 'max_uses', type: 'INT DEFAULT 1' },
                    { name: 'current_uses', type: 'INT DEFAULT 0' },
                    { name: 'description', type: 'TEXT NULL' },
                    { name: 'revoked_by', type: 'VARCHAR(50) NULL' },
                    { name: 'revoked_at', type: 'TIMESTAMP NULL' }
                ],
                indexes: [
                    { name: 'idx_code', definition: 'code' },
                    { name: 'idx_active', definition: 'active' },
                    { name: 'idx_expires_at', definition: 'expires_at' },
                    { name: 'idx_created_by', definition: 'created_by' }
                ]
            },
            {
                name: 'ban_appeals',
                columns: [
                    'id INT AUTO_INCREMENT PRIMARY KEY',
                    'user_id VARCHAR(20) NOT NULL',
                    'user_tag VARCHAR(100)',
                    'ban_case_id VARCHAR(50)',
                    'reason TEXT NOT NULL',
                    "status VARCHAR(32) DEFAULT 'pending'",
                    "review_stage VARCHAR(32) DEFAULT 'submitted'",
                    'user_email VARCHAR(254) DEFAULT NULL',
                    'public_status_note TEXT',
                    'internal_note TEXT',
                    'evidence_json LONGTEXT',
                    'withdraw_reason TEXT',
                    'owner_response TEXT',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
                    'updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
                    'decided_at TIMESTAMP NULL',
                    'withdrawn_at TIMESTAMP NULL',
                    'decided_by_id VARCHAR(64) DEFAULT NULL',
                    'decided_by_name VARCHAR(100) DEFAULT NULL',
                    'review_updated_by_id VARCHAR(64) DEFAULT NULL',
                    'review_updated_by_name VARCHAR(100) DEFAULT NULL'
                ],
                migrationColumns: [
                    { name: 'review_stage', type: "VARCHAR(32) DEFAULT 'submitted'" },
                    { name: 'user_email', type: 'VARCHAR(254) DEFAULT NULL' },
                    { name: 'public_status_note', type: 'TEXT' },
                    { name: 'internal_note', type: 'TEXT' },
                    { name: 'evidence_json', type: 'LONGTEXT' },
                    { name: 'withdraw_reason', type: 'TEXT' },
                    { name: 'updated_at', type: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' },
                    { name: 'withdrawn_at', type: 'TIMESTAMP NULL DEFAULT NULL' },
                    { name: 'decided_by_id', type: 'VARCHAR(64) DEFAULT NULL' },
                    { name: 'decided_by_name', type: 'VARCHAR(100) DEFAULT NULL' },
                    { name: 'review_updated_by_id', type: 'VARCHAR(64) DEFAULT NULL' },
                    { name: 'review_updated_by_name', type: 'VARCHAR(100) DEFAULT NULL' }
                ],
                indexes: [
                    { name: 'idx_user', definition: 'user_id' },
                    { name: 'idx_status', definition: 'status' },
                    { name: 'idx_ban_case_id', definition: 'ban_case_id' },
                    { name: 'idx_ban_appeals_status_created', definition: 'status, created_at' }
                ]
            },
            {
                name: 'alert_settings',
                columns: [
                    'id INT AUTO_INCREMENT PRIMARY KEY',
                    "alert_type ENUM('cpu', 'memory', 'error_rate', 'rate_limit', 'database') NOT NULL UNIQUE",
                    'threshold FLOAT DEFAULT 80.0',
                    'enabled BOOLEAN DEFAULT TRUE',
                    'last_triggered TIMESTAMP NULL DEFAULT NULL',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
                    'updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
                ],
                migrationColumns: [
                    { name: 'last_triggered', type: 'TIMESTAMP NULL DEFAULT NULL' }
                ],
                indexes: [{ name: 'idx_type', definition: 'alert_type' }]
            },
            {
                name: 'active_alerts',
                columns: [
                    'id INT AUTO_INCREMENT PRIMARY KEY',
                    'alert_type VARCHAR(50) NOT NULL',
                    "severity ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium'",
                    'message TEXT NOT NULL',
                    'value FLOAT',
                    'threshold FLOAT',
                    'resolved BOOLEAN DEFAULT FALSE',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
                    'resolved_at TIMESTAMP NULL'
                ],
                indexes: [
                    { name: 'idx_type', definition: 'alert_type' },
                    { name: 'idx_resolved', definition: 'resolved' }
                ]
            },
            {
                name: 'email_delivery_logs',
                columns: [
                    'id BIGINT AUTO_INCREMENT PRIMARY KEY',
                    'recipient_email VARCHAR(254) NOT NULL',
                    'recipient_domain VARCHAR(255) NULL',
                    "template_name VARCHAR(100) DEFAULT 'generic'",
                    'subject VARCHAR(255) NULL',
                    "status ENUM('sent', 'failed', 'blocked') NOT NULL",
                    'error_message TEXT NULL',
                    'message_id VARCHAR(255) NULL',
                    'correlation_id VARCHAR(128) NULL',
                    'source VARCHAR(100) NULL',
                    'provider_response TEXT NULL',
                    'attempt_count INT DEFAULT 1',
                    'latency_ms INT DEFAULT NULL',
                    'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
                ],
                migrationColumns: [
                    { name: 'correlation_id', type: 'VARCHAR(128) DEFAULT NULL' },
                    { name: 'source', type: 'VARCHAR(100) DEFAULT NULL' },
                    { name: 'provider_response', type: 'TEXT' },
                    { name: 'attempt_count', type: 'INT DEFAULT 1' },
                    { name: 'latency_ms', type: 'INT DEFAULT NULL' }
                ],
                indexes: [
                    { name: 'idx_created', definition: 'created_at' },
                    { name: 'idx_status', definition: 'status' },
                    { name: 'idx_template', definition: 'template_name' },
                    { name: 'idx_recipient_domain', definition: 'recipient_domain' },
                    { name: 'idx_correlation_id', definition: 'correlation_id' }
                ]
            },
            {
                name: 'scheduled_jobs',
                columns: [
                    'id BIGINT AUTO_INCREMENT PRIMARY KEY',
                    'job_type VARCHAR(100) NOT NULL',
                    'payload JSON NULL',
                    "status ENUM('pending', 'running', 'completed', 'failed') DEFAULT 'pending'",
                    'run_at BIGINT NOT NULL',
                    'attempts INT DEFAULT 0',
                    'max_attempts INT DEFAULT 3',
                    'locked_by VARCHAR(100) DEFAULT NULL',
                    'locked_at BIGINT DEFAULT NULL',
                    'last_error TEXT DEFAULT NULL',
                    'created_at BIGINT NOT NULL',
                    'updated_at BIGINT NOT NULL',
                    'completed_at BIGINT DEFAULT NULL'
                ],
                indexes: [
                    { name: 'idx_jobs_status_run', definition: 'status, run_at' },
                    { name: 'idx_jobs_type', definition: 'job_type' },
                    { name: 'idx_jobs_lock', definition: 'locked_by, locked_at' }
                ]
            }
        ];
    }

    async initializeDeclarativeExtendedTables() {
        for (const schema of this.getDeclarativeExtendedSchemas()) {
            await this.pool.execute(this.buildCreateTableSql(schema));
            await this.ensureColumns(schema.name, schema.migrationColumns || []);
            await this.ensureIndexes(schema.name, schema.indexes || []);
        }
    }

    async getColumnMetadata(tableName, columnName) {
        const [rows] = await this.pool.execute(
            `SELECT data_type, column_type, is_nullable
             FROM information_schema.columns
             WHERE table_schema = ? AND table_name = ? AND column_name = ?
             LIMIT 1`,
            [this.getDatabaseName(), tableName, columnName]
        );
        return Array.isArray(rows) && rows[0] ? rows[0] : null;
    }

    async applySchemaImprovements() {
        await this.runSchemaMigration(
            '2026-03-core-table-defaults',
            'Normalize storage engine and charset for core bot tables',
            async () => {
                const tables = [
                    'userinfo',
                    'levels',
                    'warns',
                    'user_bans',
                    'unbans',
                    'reminders',
                    'timeouts',
                    'kicks',
                    'moderation_cases',
                    'moderation_case_events',
                    'moderation_incidents',
                    'member_activity',
                    'user_interactions',
                    'sessions',
                    'audit_logs',
                    'suggestions',
                    'suggestion_votes'
                ];

                for (const tableName of tables) {
                    await this.ensureTableDefaults(tableName);
                }
            }
        );

        await this.runSchemaMigration(
            '2026-03-query-path-indexes',
            'Add composite indexes for common moderation, reminder, and analytics query paths',
            async () => {
                await this.ensureIndexes('warns', [
                    { name: 'idx_warns_case_id', definition: 'case_id' },
                    { name: 'idx_warns_user_created', definition: 'user_id, created_at' }
                ]);

                await this.ensureIndexes('user_bans', [
                    { name: 'idx_user_bans_case_id', definition: 'ban_case_id' },
                    { name: 'idx_user_bans_banned_updated', definition: 'banned, updated_at' }
                ]);

                await this.ensureIndexes('timeouts', [
                    { name: 'idx_timeouts_case_id', definition: 'case_id' },
                    { name: 'idx_timeouts_active_expires', definition: 'active, expires_at' },
                    { name: 'idx_timeouts_user_active_issued', definition: 'user_id, active, issued_at' }
                ]);

                await this.ensureIndexes('kicks', [
                    { name: 'idx_kicks_case_id', definition: 'case_id' },
                    { name: 'idx_kicks_user_created', definition: 'user_id, kicked_at' }
                ]);

                await this.ensureIndexes('reminders', [
                    { name: 'idx_reminders_pending_trigger', definition: 'completed, trigger_at' },
                    { name: 'idx_reminders_user_pending_trigger', definition: 'user_id, completed, trigger_at' }
                ]);

                await this.ensureIndexes('member_activity', [
                    { name: 'idx_member_activity_user_timestamp', definition: 'user_id, timestamp' },
                    { name: 'idx_member_activity_guild_user_time', definition: 'guild_id, user_id, timestamp' }
                ]);

                await this.ensureIndexes('user_interactions', [
                    { name: 'idx_user_interactions_guild_created', definition: 'guild_id, created_at' },
                    { name: 'idx_user_interactions_status_created', definition: 'status, created_at' },
                    { name: 'idx_user_interactions_category_created', definition: 'command_category, created_at' }
                ]);

                await this.ensureIndexes('moderation_case_events', [
                    { name: 'idx_moderation_case_events_actor_time', definition: 'actor_id, created_at' }
                ]);

                await this.ensureIndexes('moderation_incidents', [
                    { name: 'idx_moderation_incident_moderator_created', definition: 'moderator_id, created_at' }
                ]);

                await this.ensureIndexes('sessions', [
                    { name: 'idx_sessions_expires_session', definition: 'expires, session_id' }
                ]);
            }
        );

        await this.runSchemaMigration(
            '2026-03-identifier-time-normalization',
            'Normalize discord identifier column widths and align key time-oriented indexes',
            async () => {
                const inviteUsageGuildId = await this.getColumnMetadata('invite_usage', 'guild_id');
                if (inviteUsageGuildId && String(inviteUsageGuildId.column_type || '').toLowerCase() !== 'varchar(20)') {
                    await this.pool.execute('ALTER TABLE invite_usage MODIFY COLUMN guild_id VARCHAR(20) NOT NULL');
                }

                const suggestionVoteId = await this.getColumnMetadata('suggestion_votes', 'suggestion_id');
                if (suggestionVoteId && String(suggestionVoteId.data_type || '').toLowerCase() !== 'int') {
                    await this.pool.execute('ALTER TABLE suggestion_votes MODIFY COLUMN suggestion_id INT NOT NULL');
                }

                const normalizationAlters = [
                    'ALTER TABLE suggestions MODIFY COLUMN case_id VARCHAR(50) NULL',
                    'ALTER TABLE giveaways MODIFY COLUMN case_id VARCHAR(50) NULL',
                    'ALTER TABLE manual_lockdowns MODIFY COLUMN case_id VARCHAR(50) NOT NULL',
                    'ALTER TABLE ban_appeals MODIFY COLUMN ban_case_id VARCHAR(50) NULL'
                ];

                for (const statement of normalizationAlters) {
                    await this.pool.execute(statement);
                }

                await this.ensureIndexes('giveaways', [
                    { name: 'idx_giveaways_end_state', definition: 'ended, end_time' }
                ]);
                await this.ensureIndexes('tickets', [
                    { name: 'idx_tickets_status_created', definition: 'status, created_at' }
                ]);
                await this.ensureIndexes('suggestions', [
                    { name: 'idx_suggestions_guild_created', definition: 'guild_id, created_at' }
                ]);
                await this.ensureIndexes('ban_appeals', [
                    { name: 'idx_ban_appeals_status_created', definition: 'status, created_at' }
                ]);
            }
        );

        await this.runSchemaMigration(
            '2026-03-ticket-lifecycle-statuses',
            'Expand ticket lifecycle statuses and persist assignee/closer labels',
            async () => {
                await this.ensureColumns('tickets', [
                    { name: 'claimed_by_name', type: 'VARCHAR(100) DEFAULT NULL' },
                    { name: 'closed_by_name', type: 'VARCHAR(100) DEFAULT NULL' }
                ]);

                const ticketStatusColumn = await this.getColumnMetadata('tickets', 'status');
                const statusType = String(ticketStatusColumn?.column_type || '').toLowerCase();
                if (statusType.startsWith('enum(')) {
                    await this.pool.execute("ALTER TABLE tickets MODIFY COLUMN status VARCHAR(32) DEFAULT 'open'");
                }
            }
        );

        await this.runSchemaMigration(
            '2026-03-ban-appeals-workflow',
            'Expand ban appeals to support review workflow, evidence, and withdrawals',
            async () => {
                await this.ensureColumns('ban_appeals', [
                    { name: 'review_stage', type: "VARCHAR(32) DEFAULT 'submitted'" },
                    { name: 'public_status_note', type: 'TEXT' },
                    { name: 'internal_note', type: 'TEXT' },
                    { name: 'evidence_json', type: 'LONGTEXT' },
                    { name: 'withdraw_reason', type: 'TEXT' },
                    { name: 'updated_at', type: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' },
                    { name: 'withdrawn_at', type: 'TIMESTAMP NULL DEFAULT NULL' },
                    { name: 'review_updated_by_id', type: 'VARCHAR(64) DEFAULT NULL' },
                    { name: 'review_updated_by_name', type: 'VARCHAR(100) DEFAULT NULL' }
                ]);

                const appealStatusColumn = await this.getColumnMetadata('ban_appeals', 'status');
                const appealStatusType = String(appealStatusColumn?.column_type || '').toLowerCase();
                if (appealStatusType.startsWith('enum(')) {
                    await this.pool.execute("ALTER TABLE ban_appeals MODIFY COLUMN status VARCHAR(32) DEFAULT 'pending'");
                }
            }
        );
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
            await this.ensureSchemaMetadataTable();
            await this.initializeDeclarativeCoreTables();
            await this.initializeDeclarativeExtendedTables();

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

            try {
                await this.pool.execute(`
                    ALTER TABLE admin_auth_events
                    MODIFY COLUMN event_type ENUM('LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGIN_2FA_CHALLENGE', 'LOGIN_2FA_FAILED', 'LOGOUT', 'PASSWORD_CHANGED', 'TWO_FACTOR_ENABLED', 'TWO_FACTOR_DISABLED', 'SESSIONS_REVOKED', 'EMAIL_CHANGED', 'EMAIL_VERIFIED', 'PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED') NOT NULL
                `);
            } catch (enumMigrationError) {
                console.error('Error updating admin_auth_events enum:', enumMigrationError.message);
            }

            try {
                await this.pool.execute(`
                    ALTER TABLE automod_violations
                    MODIFY COLUMN violation_type ENUM('spam', 'caps', 'links', 'invites', 'mentions', 'profanity', 'similarity', 'regex') NOT NULL
                `);
            } catch (err) {
                console.error('Error updating automod_violations.violation_type enum:', err.message);
            }

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

            await this.applySchemaImprovements();

            console.log('✅ MySQL Tables Initialized');
        } catch (error) {
            console.error('- Table Initialization Failed:', error.message);
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