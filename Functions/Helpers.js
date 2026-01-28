// Helper functions used throughout the bot

// Check if a channel exists
function getChannel(guild, channelId) {
    if (!channelId || !guild) return null;
    
    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
        console.warn(`[Helper] Channel not found or not accessible: ${channelId}`);
        return null;
    }
    return channel;
}

// Check if a role exists
function getRole(guild, roleId) {
    if (!roleId || !guild) return null;
    
    const role = guild.roles.cache.get(roleId);
    if (!role) {
        console.warn(`[Helper] Role not found or not accessible: ${roleId}`);
        return null;
    }
    return role;
}

// Get member (checks cache first)
async function getMember(guild, userId) {
    if (!userId || !guild) return null;
    
    // Check cache first
    let member = guild.members.cache.get(userId);
    if (member) return member;
    
    // Fetch from Discord API if not cached
    try {
        member = await guild.members.fetch(userId);
        return member || null;
    } catch (err) {
        console.warn(`[Helper] Could not fetch member ${userId}: ${err.message}`);
        return null;
    }
}

// Get user from cache or fetch
async function getUser(client, userId) {
    if (!userId || !client) return null;
    
    // Check cache first
    let user = client.users.cache.get(userId);
    if (user) return user;
    
    // Fetch from Discord API if not cached
    try {
        user = await client.users.fetch(userId);
        return user || null;
    } catch (err) {
        console.warn(`[Helper] Could not fetch user ${userId}: ${err.message}`);
        return null;
    }
}

// Do channel operation safely with error logging
async function safeChannelOp(channel, operation, callback) {
    if (!channel) {
        console.error(`[Helper] Cannot perform ${operation}: channel is null`);
        return null;
    }
    
    try {
        return await callback(channel);
    } catch (err) {
        console.error(`[Helper] Error during ${operation}: ${err.message}`);
        return null;
    }
}

/**
 * Safe role operation with error logging
 * @param {GuildMember} member - Discord member object
 * @param {Role} role - Discord role object
 * @param {string} operation - 'add' or 'remove'
 * @returns {Promise<boolean>} True if successful, false otherwise
 */
async function safeRoleOp(member, role, operation = 'add') {
    if (!member || !role) {
        console.error(`[Helper] Cannot perform role ${operation}: missing member or role`);
        return false;
    }
    
    try {
        if (operation === 'add') {
            await member.roles.add(role);
            return true;
        } else if (operation === 'remove') {
            await member.roles.remove(role);
            return true;
        }
        return false;
    } catch (err) {
        console.error(`[Helper] Error during role ${operation}: ${err.message}`);
        return false;
    }
}

/**
 * Format large numbers (e.g., 1.2B, 500M)
 * @param {number} value - Number to format
 * @returns {string} Formatted string
 */
function formatLargeNumber(value) {
    if (value >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
    if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
    return value.toString();
}

/**
 * Format duration in milliseconds to readable string
 * @param {number} ms - Milliseconds
 * @returns {string} Formatted duration string
 */
function formatDuration(ms) {
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
    const days = Math.floor(ms / (1000 * 60 * 60 * 24));
    
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
    
    return parts.join(' ');
}

/**
 * Validate user input (check length, special chars)
 * @param {string} input - Input to validate
 * @param {number} minLength - Minimum length
 * @param {number} maxLength - Maximum length
 * @returns {Object} { valid: boolean, error: string|null }
 */
function validateInput(input, minLength = 1, maxLength = 2000) {
    if (!input || typeof input !== 'string') {
        return { valid: false, error: 'Input must be a non-empty string' };
    }
    
    if (input.length < minLength) {
        return { valid: false, error: `Input must be at least ${minLength} characters` };
    }
    
    if (input.length > maxLength) {
        return { valid: false, error: `Input cannot exceed ${maxLength} characters` };
    }
    
    return { valid: true, error: null };
}

/**
 * Escape markdown in text
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeMarkdown(text) {
    return text.replace(/([*_`\\~])/g, '\\$1');
}

module.exports = {
    getChannel,
    getRole,
    getMember,
    getUser,
    safeChannelOp,
    safeRoleOp,
    formatLargeNumber,
    formatDuration,
    validateInput,
    escapeMarkdown
};
