// General helper utilities used throughout the bot.
// Small, focused helpers for common tasks like resolving channels/roles/members,
// safely performing channel/role operations, and formatting values for display.

// Return the channel object if it exists and is accessible, otherwise null.
function getChannel(guild, channelId) {
    if (!channelId || !guild) return null;

    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
        console.warn(`[Helper] Channel not found or not accessible: ${channelId}`);
        return null;
    }
    return channel;
}

// Return the role object by ID or null if it doesn't exist.
function getRole(guild, roleId) {
    if (!roleId || !guild) return null;

    const role = guild.roles.cache.get(roleId);
    if (!role) {
        console.warn(`[Helper] Role not found or not accessible: ${roleId}`);
        return null;
    }
    return role;
}

// Retrieve a guild member. Check cache first (fast), then fetch from Discord
// with a timeout to avoid hanging if the API is slow or unresponsive.
async function getMember(guild, userId) {
    if (!userId || !guild) return null;

    // Try cache first, it's way faster than fetching from Discord.
    let member = guild.members?.cache.get(userId);
    if (member) return member;

    // If not cached, fetch from API with a timeout so we don't hang forever.
    const fetchTimeout = (() => {
        try {
            const misc = require('../Config/constants/misc.json');
            return misc.timeouts?.memberFetchTimeout || 5000;
        } catch {
            return 5000; // fallback to 5 seconds
        }
    })();

    try {
        member = await Promise.race([
            guild.members.fetch(userId),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Fetch timeout')), fetchTimeout))
        ]);

        return member || null;
    } catch (err) {
        console.warn(`[Helper] Could not fetch member ${userId}: ${err.message}`);
        return null;
    }
}

// Retrieve a User object from cache or fetch it from the API with a timeout.
async function getUser(client, userId) {
    if (!userId || !client) return null;

    // Check cache first
    let user = client.users?.cache.get(userId);
    if (user) return user;

    // Fetch from Discord API if not cached with timeout (5 second max)
    try {
        user = await Promise.race([
            client.users.fetch(userId),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Fetch timeout')), 5000))
        ]);
        return user || null;
    } catch (err) {
        console.warn(`[Helper] Could not fetch user ${userId}: ${err.message}`);
        return null;
    }
}

// Run a channel-related operation safely and log any error.
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

// Safely add/remove a role from a member and log on failure.
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

// Format large numbers into a short human-friendly string (e.g., 1.2B).
function formatLargeNumber(value) {
    if (value >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
    if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
    return value.toString();
}

// Convert milliseconds into a concise human-readable duration string.
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

// Basic input validation for string length; returns `{valid, error}`.
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

// Escape markdown characters so text renders literally in Discord messages.
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