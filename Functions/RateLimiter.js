// Prevents command spam
class RateLimiter {
    constructor() {
        this.usages = new Map();
        this.limits = {
            global: { max: 10, window: 10000 }, // 10 commands per 10s
            perCommand: { max: 3, window: 5000 } // 3 of same command per 5s
        };
        
        setInterval(() => this.cleanup(), 60000); // cleanup every minute
    }

    // Check if user hit rate limit
    checkLimit(userId, commandName) {
        const now = Date.now();
        
        // Get or create user usage tracking
        if (!this.usages.has(userId)) {
            this.usages.set(userId, new Map());
        }
        
        const userUsages = this.usages.get(userId);
        
        // Get global command usage (all commands)
        let globalUsage = [];
        userUsages.forEach(timestamps => {
            globalUsage.push(...timestamps);
        });
        
        // Filter to recent global usage
        globalUsage = globalUsage.filter(
            timestamp => now - timestamp < this.limits.global.window
        );
        
        // Check global rate limit
        if (globalUsage.length >= this.limits.global.max) {
            const oldestTimestamp = Math.min(...globalUsage);
            const retryAfter = Math.ceil((oldestTimestamp + this.limits.global.window - now) / 1000);
            return { limited: true, retryAfter, type: 'global' };
        }
        
        // Get command-specific usage
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

    // Track command usage
    recordUsage(userId, commandName) {
        if (!this.usages.has(userId)) {
            this.usages.set(userId, new Map());
        }
        
        const userUsages = this.usages.get(userId);
        
        if (!userUsages.has(commandName)) {
            userUsages.set(commandName, []);
        }
        
        userUsages.get(commandName).push(Date.now());
    }

    // Check if user bypasses rate limits
    isExempt(member, exemptRoleIds = []) {
        if (!member) return false;
        
        // Admins are exempt
        if (member.permissions?.has('Administrator')) return true;
        
        // Check for specific exempt roles
        if (exemptRoleIds.length > 0) {
            return exemptRoleIds.some(roleId => member.roles.cache.has(roleId));
        }
        
        return false;
    }

    // Remove old usage records
    cleanup() {
        const now = Date.now();
        const cutoff = now - Math.max(this.limits.global.window, this.limits.perCommand.window) - 60000;
        
        let cleaned = 0;
        
        this.usages.forEach((userUsages, userId) => {
            userUsages.forEach((timestamps, commandName) => {
                const filtered = timestamps.filter(timestamp => timestamp > cutoff);
                
                if (filtered.length === 0) {
                    userUsages.delete(commandName);
                    cleaned++;
                } else if (filtered.length !== timestamps.length) {
                    userUsages.set(commandName, filtered);
                }
            });
            
            // Remove user if no commands tracked
            if (userUsages.size === 0) {
                this.usages.delete(userId);
            }
        });
        
        if (cleaned > 0) {
            console.log(`[RateLimiter] Cleaned up ${cleaned} expired usage records`);
        }
    }

    /**
     * Get current usage stats
     * @returns {Object} Usage statistics
     */
    getStats() {
        return {
            trackedUsers: this.usages.size,
            totalRecords: Array.from(this.usages.values()).reduce(
                (sum, userUsages) => sum + userUsages.size, 0
            )
        };
    }

    /**
     * Clear all rate limit data (for testing)
     */
    reset() {
        this.usages.clear();
    }
}

// Export singleton instance
module.exports = new RateLimiter();
