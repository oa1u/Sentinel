const { ActivityType, EmbedBuilder } = require('discord.js');
const presenceConfig = require('../Config/presence.json');
const MySQLDatabaseManager = require('../Functions/MySQLDatabaseManager');
const InviteTracker = require('../Functions/InviteTracker');
const { serverID } = require('../Config/main.json');
const { CHANNELS: { birthdayChannelId } } = require('../Config/constants');

// Fired when the bot is ready: set presence, start periodic tasks and background cleaners.
module.exports = {
    name: "clientReady",
    runOnce: true,
    call: async (client) => {
        console.log(`Ready! Logged in as ${client.user.username}`);

        updatePresence(client);

        // Rotate the bot's status periodically to keep the presence fresh.
        let currentIndex = 0;
        setInterval(() => {
            currentIndex = (currentIndex + 1) % presenceConfig.activities.length;
            updatePresence(client, currentIndex);
        }, presenceConfig.interval || 30000);

        // Start periodic cleanup for Join-to-Create temporary channels.
        startJoinToCreateCleanup(client);

        // Start the daily birthday announcer (runs hourly checks internally).
        startBirthdayAnnouncements(client);

        // Cache existing invites for invite tracking.
        InviteTracker.primeAllGuildInvites(client).catch(() => {});
    }
};

// This function keeps Join-to-Create temp channels tidy by deleting empty ones.
async function startJoinToCreateCleanup(client) {
    const guild = client.guilds.cache.get(serverID);
    if (!guild) {
        console.warn('[Ready] Server not found for JTC cleanup');
        return;
    }

    console.log('[JTC] Starting cleanup interval...');

    // Every 10 seconds, check for empty temp channels and remove them.
    setInterval(async () => {
        try {
            // Grab all active JTC channels from the database.
            const jtcChannels = await MySQLDatabaseManager.getActiveJTCChannels(guild.id).catch(() => []);

            for (const jtcData of jtcChannels) {
                const vc = guild.channels.cache.get(jtcData.channel_id);

                if (!vc) {
                    // If the channel got deleted, clean up the database.
                    await MySQLDatabaseManager.deleteJTCChannel(jtcData.channel_id).catch(() => { });
                    continue;
                }

                if (vc.members.size < 1) {
                    // If nobody's in the channel anymore, delete it.
                    await MySQLDatabaseManager.deleteJTCChannel(vc.id).catch(() => { });
                    vc.delete().catch((err) => {
                        console.error(`[JTC] Couldn't delete temp channel: ${err.message}`);
                    });
                }
            }

            // Also delete really old channels (24+ hours) - don't run this every time though
            if (Math.random() < 0.0833) { // ~1 in 12 chance (runs every 2 mins on average)
                await MySQLDatabaseManager.cleanupOldJTCChannels(24 * 60 * 60 * 1000).catch(() => { });
            }
        } catch (err) {
            console.error('[JTC] Cleanup error:', err.message);
        }
    }, 10000);
}

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

async function startBirthdayAnnouncements(client) {
    if (!birthdayChannelId) {
        console.log('[Birthday] birthdayChannelId not configured. Birthday announcements are disabled.');
        return;
    }

    const guild = client.guilds.cache.get(serverID);
    if (!guild) {
        console.warn('[Birthday] Server not found for birthday announcements');
        return;
    }

    const runBirthdayCheck = async () => {
        try {
            const dateKey = new Date().toISOString().slice(0, 10);

            const channel = guild.channels.cache.get(birthdayChannelId)
                || await guild.channels.fetch(birthdayChannelId).catch(() => null);

            if (!channel || !channel.isTextBased()) {
                console.warn('[Birthday] Configured birthdayChannelId is missing or not a text channel');
                return;
            }

            const todaysBirthdays = await MySQLDatabaseManager.getUpcomingBirthdays(guild.id, 1);
            const announcedUserIds = await MySQLDatabaseManager.getBirthdayAnnouncementUserIds(guild.id, dateKey);
            const announcedSet = new Set(announcedUserIds);
            const unannouncedBirthdays = todaysBirthdays.filter(entry => !announcedSet.has(String(entry.user_id)));

            if (unannouncedBirthdays.length > 0) {
                const lines = unannouncedBirthdays.map(entry => `🎉 Happy Birthday <@${entry.user_id}>!`).join('\n');

                const embed = new EmbedBuilder()
                    .setColor(0xF9A826)
                    .setTitle('🎂 Today\'s Birthdays')
                    .setDescription(lines)
                    .setFooter({ text: `Celebrating ${unannouncedBirthdays.length} birthday${unannouncedBirthdays.length === 1 ? '' : 's'} today` })
                    .setTimestamp();

                await channel.send({ embeds: [embed] }).catch((err) => {
                    console.error('[Birthday] Failed to send birthday embed:', err.message);
                });

                await MySQLDatabaseManager.markBirthdayAnnouncementsSent(
                    guild.id,
                    dateKey,
                    unannouncedBirthdays.map(entry => String(entry.user_id))
                );
            }
        } catch (error) {
            console.error('[Birthday] Announcement check failed:', error.message);
        }
    };

    // Run at startup and then every hour to catch date changes.
    await runBirthdayCheck();
    setInterval(runBirthdayCheck, 60 * 60 * 1000);
    console.log('[Birthday] Daily birthday announcer started (hourly checks)');
}