// Rate limiter
// Lightweight in-memory rate limiter to help prevent command spam. It tracks
// usage per-user and per-command and exposes helpers to check limits and
// record usage.
const misc = require('../Config/constants/misc.json');

class RateLimiter {
    constructor() {
        this.usages = new Map();
        // Grab rate limit settings from the config, or use defaults if missing.
        const rateLimitConfig = misc.rateLimit || {};
        const limitsConfig = misc.limits || {};

        this.limits = {
            global: {
                max: rateLimitConfig.globalMax || 10,
                window: rateLimitConfig.globalWindow || 10000
            },
            perCommand: {
                max: rateLimitConfig.perCommandMax || 3,
                window: rateLimitConfig.perCommandWindow || 5000
            }
        };
        this.maxTrackedUsers = limitsConfig.maxTrackedRateLimitUsers || 5000;

        // Clean up old usage records every minute so things stay tidy.
        setInterval(() => this.cleanup(), 60000);
    }

    // Checks if a user has hit their rate limit for a command.
    checkLimit(userId, commandName) {
        const now = Date.now();

        // Make sure we have a usage tracker for this user.
        if (!this.usages.has(userId)) {
            this.usages.set(userId, new Map());
        }

        const userUsages = this.usages.get(userId);

        // Count all commands used by this user.
        let globalUsage = [];
        userUsages.forEach(timestamps => {
            globalUsage.push(...timestamps);
        });

        // Only look at commands used recently.
        globalUsage = globalUsage.filter(
            timestamp => now - timestamp < this.limits.global.window
        );

        // If they've used too many commands globally, block them for a bit.
        if (globalUsage.length >= this.limits.global.max) {
            const oldestTimestamp = Math.min(...globalUsage);
            const retryAfter = Math.ceil((oldestTimestamp + this.limits.global.window - now) / 1000);
            return { limited: true, retryAfter, type: 'global' };
        }

        // Track usage for the specific command.
        if (!userUsages.has(commandName)) {
            userUsages.set(commandName, []);
        }

        const commandUsage = userUsages.get(commandName);

        // Filter to recent command usage
        const recentUsage = commandUsage.filter(
            timestamp => now - timestamp < this.limits.perCommand.window
        );

        // Check command-specific rate limit
        if (recentUsage.length >= this.limits.perCommand.max) {
            const oldestTimestamp = Math.min(...recentUsage);
            const retryAfter = Math.ceil((oldestTimestamp + this.limits.perCommand.window - now) / 1000);
            return { limited: true, retryAfter, type: 'command' };
        }

        return { limited: false };
    }

    // Records that a user used a command, so we can enforce limits.
    recordUsage(userId, commandName) {
        // If we're tracking too many users, clean up to avoid memory issues.
        if (!this.usages.has(userId) && this.usages.size >= this.maxTrackedUsers) {
            console.warn(`[RateLimiter] Max tracked users reached (${this.maxTrackedUsers}), forcing cleanup`);
            this.cleanup();

            // If still at max after cleanup, remove oldest user
            if (this.usages.size >= this.maxTrackedUsers) {
                const firstKey = this.usages.keys().next().value;
                this.usages.delete(firstKey);
            }
        }

        if (!this.usages.has(userId)) {
            this.usages.set(userId, new Map());
        }

        const userUsages = this.usages.get(userId);

        if (!userUsages.has(commandName)) {
            userUsages.set(commandName, []);
        }

        userUsages.get(commandName).push(Date.now());
    }

    // Checks if a user should bypass rate limits (like admins or special roles).
    isExempt(member, exemptRoleIds = []) {
        if (!member) return false;

        // Admins don't get rate limited.
        if (member.permissions?.has('Administrator')) return true;

        // Some roles can be exempt from rate limits too.
        if (exemptRoleIds.length > 0) {
            return exemptRoleIds.some(roleId => member.roles.cache.has(roleId));
        }

        return false;
    }

    // Cleans up old usage records so we don't waste memory.
    cleanup() {
        const now = Date.now();
        const maxWindow = Math.max(this.limits.global.window, this.limits.perCommand.window);
        const cutoff = now - maxWindow - 60000; // Extra 60s buffer

        let cleanedRecords = 0;
        let cleanedUsers = 0;

        // Go through all users and commands, and remove old records.
        for (const [userId, userUsages] of this.usages.entries()) {
            for (const [commandName, timestamps] of userUsages.entries()) {
                // Filter out expired timestamps
                const validTimestamps = timestamps.filter(ts => ts > cutoff);

                if (validTimestamps.length === 0) {
                    userUsages.delete(commandName);
                    cleanedRecords++;
                } else if (validTimestamps.length !== timestamps.length) {
                    userUsages.set(commandName, validTimestamps);
                    cleanedRecords++;
                }
            }

            // If a user has no commands left, remove them from tracking.
            if (userUsages.size === 0) {
                this.usages.delete(userId);
                cleanedUsers++;
            }
        }

        if (cleanedRecords > 0 || cleanedUsers > 0) {
            console.log(`[RateLimiter] Cleanup: ${cleanedRecords} records cleaned, ${cleanedUsers} users removed (${this.usages.size} users remaining)`);
        }
    }

    // Returns stats about how many users and records we're tracking.
    getStats() {
        return {
            trackedUsers: this.usages.size,
            totalRecords: Array.from(this.usages.values()).reduce(
                (sum, userUsages) => sum + userUsages.size, 0
            )
        };
    }

    // Clears all usage records and resets the limiter.
    reset() {
        this.usages.clear();
    }
}

// Export a single instance so the whole bot uses the same limiter.
module.exports = new RateLimiter();