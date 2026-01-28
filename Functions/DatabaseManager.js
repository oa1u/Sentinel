const JSONDatabase = require('./Database');

// Manages all database instances and batches writes
class DatabaseManager {
    constructor() {
        this.databases = new Map();
        this.pendingWrites = new Map();
        this.writeDelay = 500; // batch writes every 500ms
        this.writeTimers = new Map();
        this.isShuttingDown = false;
        
        const shutdownHandler = () => {
            this.flushAll();
        };
        process.on('SIGINT', shutdownHandler);
        process.on('SIGTERM', shutdownHandler);
        process.on('beforeExit', shutdownHandler);
    }

    // Get or create database instance
    getDatabase(name) {
        if (!this.databases.has(name)) {
            this.databases.set(name, new JSONDatabase(name));
        }
        return this.databases.get(name);
    }

    // Queue an operation for batching
    async queueOperation(dbName, operation) {
        return new Promise((resolve, reject) => {
            if (!this.pendingWrites.has(dbName)) {
                this.pendingWrites.set(dbName, []);
                
                // Clear existing timer if any
                if (this.writeTimers.has(dbName)) {
                    clearTimeout(this.writeTimers.get(dbName));
                }
                
                // Schedule batch write
                const timer = setTimeout(() => {
                    this.flushDatabase(dbName);
                }, this.writeDelay);
                
                this.writeTimers.set(dbName, timer);
            }
            
            // Add operation with resolve/reject callbacks
            this.pendingWrites.get(dbName).push({ operation, resolve, reject });
        });
    }
    
    // Write pending operations for a database
    flushDatabase(dbName) {
        const operations = this.pendingWrites.get(dbName) || [];
        if (operations.length > 0) {
            const db = this.getDatabase(dbName);
            operations.forEach(({ operation, resolve, reject }) => {
                try {
                    operation(db);
                    resolve();
                } catch (err) {
                    console.error(`[DatabaseManager] Error executing operation for ${dbName}:`, err);
                    reject(err);
                }
            });
            this.pendingWrites.delete(dbName);
            this.writeTimers.delete(dbName);
        }
    }
    
    // Write all pending operations on shutdown
    flushAll() {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;
        
        console.log('[DatabaseManager] Flushing pending writes...');
        this.writeTimers.forEach((timer) => clearTimeout(timer));
        this.writeTimers.clear();
        
        this.pendingWrites.forEach((_, dbName) => {
            this.flushDatabase(dbName);
        });
        
        console.log('[DatabaseManager] All writes flushed successfully');
    }

    getWarnsDB() {
        return this.getDatabase('warns');
    }

    getCannedMsgsDB() {
        return this.getDatabase('cannedMsgs');
    }

    /**
     * Get reminders database
     * @returns {JSONDatabase} Reminders database
     */
    getRemindersDB() {
        return this.getDatabase('reminders');
    }

    /**
     * Get giveaways database
     * @returns {JSONDatabase} Giveaways database
     */
    getGiveawaysDB() {
        return this.getDatabase('giveaways');
    }

    /**
     * Add or update a case in warns database
     * @param {string} userId - User ID
     * @param {string} caseId - Case ID
     * @param {Object} caseData - Case data
     */
    addCase(userId, caseId, caseData) {
        const warnsDB = this.getWarnsDB();
        const userData = warnsDB.ensure(userId, { warns: {} });
        userData.warns[caseId] = caseData;
        userData.lastWarned = new Date().toISOString();
        warnsDB.set(userId, userData);
    }

    /**
     * Get user warns
     * @param {string} userId - User ID
     * @returns {Object} User warns data
     */
    getUserWarns(userId) {
        const warnsDB = this.getWarnsDB();
        return warnsDB.ensure(userId, { warns: {} });
    }

    /**
     * Get all warns for a user (count)
     * @param {string} userId - User ID
     * @returns {number} Total warns count
     */
    getUserWarnsCount(userId) {
        const userData = this.getUserWarns(userId);
        return Object.keys(userData.warns || {}).length;
    }

    /**
     * Clear warns for a user
     * @param {string} userId - User ID
     */
    clearUserWarns(userId) {
        const warnsDB = this.getWarnsDB();
        warnsDB.set(userId, { warns: {} });
    }

    /**
     * Check if user is banned (in warns database)
     * @param {string} userId - User ID
     * @returns {boolean} True if user is marked as banned
     */
    isUserBanned(userId) {
        const warnsDB = this.getWarnsDB();
        const userData = warnsDB.get(userId) || {};
        return userData.banned === true;
    }

    /**
     * Mark user as banned
     * @param {string} userId - User ID
     */
    markUserBanned(userId) {
        const warnsDB = this.getWarnsDB();
        const userData = warnsDB.ensure(userId, { warns: {} });
        userData.banned = true;
        warnsDB.set(userId, userData);
    }

    /**
     * Mark user as unbanned
     * @param {string} userId - User ID
     */
    unbanUser(userId) {
        const warnsDB = this.getWarnsDB();
        const userData = warnsDB.ensure(userId, { warns: {} });
        userData.banned = false;
        warnsDB.set(userId, userData);
    }

    /**
     * Get canned message
     * @param {string} alias - Message alias
     * @returns {string|null} Canned message or null
     */
    getCannedMessage(alias) {
        const cannedDB = this.getCannedMsgsDB();
        return cannedDB.has(alias) ? cannedDB.get(alias) : null;
    }

    /**
     * Get resolved reason (canned or original)
     * @param {string} reasonInput - Reason input
     * @returns {string} Resolved reason
     */
    getResolvedReason(reasonInput) {
        const canned = this.getCannedMessage(reasonInput);
        return canned || reasonInput;
    }

    /**
     * Add reminder
     * @param {string} userId - User ID
     * @param {Object} reminderData - Reminder data
     * @returns {string} Reminder ID
     */
    addReminder(userId, reminderData) {
        const remindersDB = this.getRemindersDB();
        const reminderId = `${userId}-${Date.now()}`;
        const userReminders = remindersDB.ensure(userId, []);
        userReminders.push({ id: reminderId, ...reminderData });
        remindersDB.set(userId, userReminders);
        return reminderId;
    }

    /**
     * Get user reminders
     * @param {string} userId - User ID
     * @returns {Array} User reminders
     */
    getUserReminders(userId) {
        const remindersDB = this.getRemindersDB();
        return remindersDB.ensure(userId, []);
    }

    /**
     * Remove reminder
     * @param {string} userId - User ID
     * @param {string} reminderId - Reminder ID
     */
    removeReminder(userId, reminderId) {
        const remindersDB = this.getRemindersDB();
        const userReminders = remindersDB.ensure(userId, []);
        const filtered = userReminders.filter(r => r.id !== reminderId);
        remindersDB.set(userId, filtered);
    }

    /**
     * Get all databases info for debugging
     * @returns {Object} Database stats
     */
    getStats() {
        const stats = {};
        this.databases.forEach((db, name) => {
            stats[name] = {
                size: db.size(),
                entries: db.size(),
                filePath: db.filePath
            };
        });
        return stats;
    }

    /**
     * Clear all cached instances (for testing)
     */
    clearCache() {
        this.databases.clear();
        this.pendingWrites.clear();
    }
}

// Export singleton instance
module.exports = new DatabaseManager();