// Get member from mention, ID, or username
async function getMemberFromMention(guild, input) {
    if (!guild) {
        throw new Error('Guild is required');
    }
    if (!input || typeof input !== 'string') {
        return null;
    }

    // Try mention format: <@!123456> or <@123456>
    const mentionMatch = input.match(/^<@!?(\d+)>$/);
    if (mentionMatch) {
        const id = mentionMatch[1];
        try {
            return await guild.members.fetch(id);
        } catch (err) {
            return null;
        }
    }

    // Try raw ID
    if (/^\d+$/.test(input)) {
        try {
            return await guild.members.fetch(input);
        } catch (err) {
            return null;
        }
    }

    // Try username or display name
    const lowerInput = input.toLowerCase();
    let member = guild.members.cache.find(m => 
        m.user.username.toLowerCase() === lowerInput ||
        m.displayName.toLowerCase() === lowerInput
    );

    if (member) return member;

    // Try fuzzy search (username contains input)
    member = guild.members.cache.find(m =>
        m.user.username.toLowerCase().includes(lowerInput) ||
        m.displayName.toLowerCase().includes(lowerInput)
    );

    return member || null;
}

// Get user from mention or ID
async function getUserFromInput(client, input) {
    if (!client) {
        throw new Error('Client is required');
    }
    if (!input || typeof input !== 'string') {
        return null;
    }

    // Try mention format
    const mentionMatch = input.match(/^<@!?(\d+)>$/);
    if (mentionMatch) {
        try {
            return await client.users.fetch(mentionMatch[1]);
        } catch (err) {
            return null;
        }
    }

    // Try raw ID
    if (/^\d+$/.test(input)) {
        try {
            return await client.users.fetch(input);
        } catch (err) {
            return null;
        }
    }

    return null;
}

// Check if member has a role
function memberHasRole(member, roleInput) {
    if (!member) return false;
    
    const roleId = typeof roleInput === 'string' ? roleInput : roleInput?.id;
    return member.roles.cache.has(roleId);
}

// Get all members with a role
function getMembersWithRole(guild, roleInput) {
    if (!guild) {
        throw new Error('Guild is required');
    }
    
    const roleId = typeof roleInput === 'string' ? roleInput : roleInput?.id;
    return guild.members.cache.filter(m => m.roles.cache.has(roleId));
}

/**
 * Add role to a member
 * @param {GuildMember} member - The member
 * @param {string|Role} roleInput - Role ID or Role object
 * @param {string} reason - Audit log reason
 * @returns {Promise<GuildMember|null>} Updated member or null if failed
 */
async function addRoleToMember(member, roleInput, reason = 'No reason provided') {
    if (!member) return null;
    
    try {
        const role = typeof roleInput === 'string' ? member.guild.roles.cache.get(roleInput) : roleInput;
        if (!role) return null;
        
        await member.roles.add(role, reason);
        return member;
    } catch (err) {
        console.error(`Failed to add role to member: ${err.message}`);
        return null;
    }
}

/**
 * Remove role from a member
 * @param {GuildMember} member - The member
 * @param {string|Role} roleInput - Role ID or Role object
 * @param {string} reason - Audit log reason
 * @returns {Promise<GuildMember|null>} Updated member or null if failed
 */
async function removeRoleFromMember(member, roleInput, reason = 'No reason provided') {
    if (!member) return null;
    
    try {
        const role = typeof roleInput === 'string' ? member.guild.roles.cache.get(roleInput) : roleInput;
        if (!role) return null;
        
        await member.roles.remove(role, reason);
        return member;
    } catch (err) {
        console.error(`Failed to remove role from member: ${err.message}`);
        return null;
    }
}

/**
 * Check if a member has elevated permissions in the guild
 * @param {GuildMember} member - The member to check
 * @returns {boolean} True if member is mod/admin
 */
function isModOrAdmin(member) {
    if (!member) return false;
    return member.permissions.has('ModerateMembers') || member.permissions.has('Administrator');
}

module.exports = {
    getMemberFromMention,
    getUserFromInput,
    memberHasRole,
    getMembersWithRole,
    addRoleToMember,
    removeRoleFromMember,
    isModOrAdmin
};