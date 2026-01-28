const { ActivityType } = require('discord.js');
const presenceConfig = require('../Config/presence.json');

module.exports = {
    name: "clientReady",
    runOnce: true,
    call: async (client) => {
        console.log(`Ready! Logged in as ${client.user.username}`);
        
        updatePresence(client);
        
        let currentIndex = 0;
        setInterval(() => {
            currentIndex = (currentIndex + 1) % presenceConfig.activities.length;
            updatePresence(client, currentIndex);
        }, presenceConfig.interval || 30000);
    }
};

function updatePresence(client, index = 0) {
    try {
        const activity = presenceConfig.activities[index];
        if (!activity) return;
        
        let activityName = activity.name
            .replace('{servers}', client.guilds.cache.size)
            .replace('{members}', client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0))
            .replace('{users}', client.users.cache.size)
            .replace('{channels}', client.channels.cache.size);
        
        const activityTypes = {
            0: ActivityType.Playing,
            1: ActivityType.Streaming,
            2: ActivityType.Listening,
            3: ActivityType.Watching,
            5: ActivityType.Competing
        };
        
        client.user.setPresence({
            activities: [{
                name: activityName,
                type: activityTypes[activity.type] || ActivityType.Playing
            }],
            status: activity.status || presenceConfig.defaultStatus || 'online'
        });
    } catch (error) {
        console.error('Error updating presence:', error);
    }
}