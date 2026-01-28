const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

// Ensure data directories exist
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

class JSONDatabase {
    constructor(name, options = {}) {
        this.name = name;
        this.filePath = path.join(DATA_DIR, `${name}.json`);
        this.backupPath = path.join(BACKUP_DIR, `${name}.backup.json`);
        this.data = {};
        this.saveTimeout = null;
        this.writeInterval = options.writeInterval || 1000; // Debounce writes
        this.autoBackup = options.autoBackup !== false; // Default true
        this.loadSync(); // Initial load is synchronous
    }

    /**
     * Synchronously load data from file (used only on initialization)
     */
    loadSync() {
        try {
            if (fs.existsSync(this.filePath)) {
                const fileData = fs.readFileSync(this.filePath, 'utf-8');
                this.data = JSON.parse(fileData);
                console.log(`✅ Loaded ${this.name}: ${this.size()} entries`);
                return this.data;
            }
        } catch (err) {
            console.error(`❌ Couldn't load ${this.name}: ${err.message}`);
            console.warn(`⚠️  Using empty database for ${this.name}`);
        }
        return this.data;
    }

    // Create backup before writing
    createBackup() {
        if (!this.autoBackup) return;
        try {
            if (fs.existsSync(this.filePath)) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
                const rotatedBackupPath = path.join(BACKUP_DIR, `${this.name}.backup.${timestamp}.json`);
                fs.copyFileSync(this.filePath, rotatedBackupPath);
                
                // Keep only last 10 backups
                this.rotateBackups();
            }
        } catch (err) {
            console.warn(`⚠️  Failed to create backup for ${this.name}: ${err.message}`);
        }
    }

    // Keep only last 10 backups
    rotateBackups() {
        try {
            const files = fs.readdirSync(BACKUP_DIR)
                .filter(file => file.startsWith(this.name) && file.endsWith('.json'))
                .map(file => ({
                    name: file,
                    path: path.join(BACKUP_DIR, file),
                    time: fs.statSync(path.join(BACKUP_DIR, file)).mtime.getTime()
                }))
                .sort((a, b) => b.time - a.time);
            
            // Delete files beyond the 10 most recent
            for (let i = 10; i < files.length; i++) {
                try {
                    fs.unlinkSync(files[i].path);
                    console.log(`[Database] Removed old backup: ${files[i].name}`);
                } catch (err) {
                    console.warn(`[Database] Could not delete backup ${files[i].name}: ${err.message}`);
                }
            }
        } catch (err) {
            console.warn(`[Database] Error rotating backups: ${err.message}`);
        }
    }

    // Save with debouncing
    save() {
        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        
        this.saveTimeout = setTimeout(async () => {
            try {
                this.createBackup();
                const jsonString = JSON.stringify(this.data, null, 2);
                await fs.promises.writeFile(this.filePath, jsonString, 'utf-8');
            } catch (err) {
                console.error(`❌ Couldn't save ${this.name}: ${err.message}`);
            }
        }, this.writeInterval);
    }

    validateKey(key) {
        if (typeof key !== 'string' || key.length === 0) {
            throw new TypeError(`Key must be a non-empty string, got ${typeof key}`);
        }
    }

    set(key, value) {
        this.validateKey(key);
        this.data[key] = value;
        this.save();
        return value;
    }

    get(key) {
        this.validateKey(key);
        return this.data[key];
    }

    has(key) {
        this.validateKey(key);
        return key in this.data;
    }

    delete(key) {
        this.validateKey(key);
        delete this.data[key];
        this.save();
        return true;
    }

    /**
     * Get or set default value
     */
    ensure(key, defaultValue) {
        this.validateKey(key);
        if (!this.has(key)) {
            this.set(key, defaultValue);
        }
        return this.get(key);
    }

    /**
     * Get all data
     */
    all() {
        return { ...this.data };
    }

    /**
     * Clear all data
     */
    clear() {
        this.data = {};
        this.save();
        return true;
    }

    /**
     * Get number of entries
     */
    size() {
        return Object.keys(this.data).length;
    }

    /**
     * Convert to array format
     */
    toArray() {
        return Object.entries(this.data).map(([key, value]) => ({ key, value }));
    }

    /**
     * Filter entries by predicate
     */
    filter(predicate) {
        const results = [];
        for (const [key, value] of Object.entries(this.data)) {
            if (predicate(value, key)) {
                results.push({ key, value });
            }
        }
        return results;
    }

    /**
     * Update nested properties
     */
    update(key, updates) {
        this.validateKey(key);
        if (this.has(key) && typeof this.data[key] === 'object' && !Array.isArray(this.data[key])) {
            this.data[key] = { ...this.data[key], ...updates };
            this.save();
            return this.get(key);
        }
        return null;
    }

    /**
     * Increment a numeric value
     */
    increment(key, amount = 1) {
        this.validateKey(key);
        const current = this.get(key) || 0;
        if (typeof current !== 'number') {
            throw new TypeError(`Cannot increment non-numeric value at key: ${key}`);
        }
        return this.set(key, current + amount);
    }

    /**
     * Decrement a numeric value
     */
    decrement(key, amount = 1) {
        return this.increment(key, -amount);
    }

    /**
     * Push value to array
     */
    push(key, value) {
        this.validateKey(key);
        const current = this.get(key) || [];
        if (!Array.isArray(current)) {
            throw new TypeError(`Cannot push to non-array value at key: ${key}`);
        }
        current.push(value);
        return this.set(key, current);
    }

    /**
     * Remove value from array
     */
    pull(key, value) {
        this.validateKey(key);
        const current = this.get(key) || [];
        if (!Array.isArray(current)) {
            throw new TypeError(`Cannot pull from non-array value at key: ${key}`);
        }
        const filtered = current.filter(v => v !== value);
        return this.set(key, filtered);
    }

    /**
     * Check if array contains value
     */
    includes(key, value) {
        this.validateKey(key);
        const current = this.get(key);
        if (!Array.isArray(current)) {
            throw new TypeError(`Cannot check includes on non-array value at key: ${key}`);
        }
        return current.includes(value);
    }

    /**
     * Get keys matching pattern
     */
    findKeys(pattern) {
        const regex = new RegExp(pattern);
        return Object.keys(this.data).filter(key => regex.test(key));
    }

    /**
     * Restore from backup
     */
    restoreBackup() {
        try {
            if (fs.existsSync(this.backupPath)) {
                fs.copyFileSync(this.backupPath, this.filePath);
                this.loadSync();
                console.log(`✅ Database restored from backup: ${this.name}`);
                return true;
            }
            console.warn(`⚠️  No backup found for ${this.name}`);
            return false;
        } catch (err) {
            console.error(`❌ Error restoring backup for ${this.name}: ${err.message}`);
            return false;
        }
    }
}

module.exports = JSONDatabase;