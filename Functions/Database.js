const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

class JSONDatabase {
    constructor(name) {
        this.name = name;
        this.filePath = path.join(DATA_DIR, `${name}.json`);
        this.data = this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.filePath)) {
                const fileData = fs.readFileSync(this.filePath, 'utf-8');
                return JSON.parse(fileData);
            }
        } catch (err) {
            console.error(`Error loading database ${this.name}:`, err);
        }
        return {};
    }

    save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
        } catch (err) {
            console.error(`Error saving database ${this.name}:`, err);
        }
    }

    set(key, value) {
        this.data[key] = value;
        this.save();
        return value;
    }

    get(key) {
        return this.data[key];
    }

    has(key) {
        return key in this.data;
    }

    delete(key) {
        delete this.data[key];
        this.save();
    }

    ensure(key, defaultValue) {
        if (!this.has(key)) {
            this.set(key, defaultValue);
        }
        return this.get(key);
    }

    all() {
        return this.data;
    }

    clear() {
        this.data = {};
        this.save();
    }

    size() {
        return Object.keys(this.data).length;
    }

    // Utility method to get all entries as array
    toArray() {
        return Object.entries(this.data).map(([key, value]) => ({ key, value }));
    }

    // Find entries matching a condition
    filter(predicate) {
        const results = [];
        for (const [key, value] of Object.entries(this.data)) {
            if (predicate(value, key)) {
                results.push({ key, value });
            }
        }
        return results;
    }

    // Update a nested property
    update(key, updates) {
        if (this.has(key)) {
            this.data[key] = { ...this.data[key], ...updates };
            this.save();
        }
        return this.get(key);
    }
}

module.exports = JSONDatabase;



