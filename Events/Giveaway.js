const { Collection } = require('discord.js');
const DatabaseManager = require('../Functions/MySQLDatabaseManager');
const { generateCaseId } = require('./caseId');

// Giveaway handler: starts giveaways, tracks entries, and picks winners.
// Each giveaway uses a unique case ID to make tracing and logs easy.

const activeGiveaways = new Collection();

// This function turns seconds into a friendly time string, like "2 hours, 5 minutes".
function toTime(seconds) {
    seconds = Number(seconds);
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    const dDisplay = d > 0 ? `${d}${d === 1 ? ' day' : ' days'}, ` : '';
    const hDisplay = h > 0 ? `${h}${h === 1 ? ' hour' : ' hours'}, ` : '';
    const mDisplay = m > 0 ? `${m}${m === 1 ? ' minute' : ' minutes'}, ` : '';
    const sDisplay = s > 0 ? `${s}${s === 1 ? ' second' : ' seconds'}` : '';

    const result = `${dDisplay}${hDisplay}${mDisplay}${sDisplay}`.replace(/, $/, '');
    return result || '0 seconds';
}

// Small utility to pause execution for a bit between updates.
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// This runs the countdown for a giveaway, updating the message as time ticks down.
async function runGiveawayCountdown(message, giveawayId, client, duration, prize, host) {
    let timeRemaining = duration;
    const updateInterval = Math.min(30, Math.max(5, Math.floor(duration / 10)));

    while (timeRemaining > 0) {
        await sleep(updateInterval * 1000);
        timeRemaining -= updateInterval;

        try {
            // Let's grab the case ID from the database so we can show it in the embed.
            const giveawayDB = DatabaseManager.getGiveawaysDB();
            const giveaway = await giveawayDB.get(giveawayId);
            const caseId = giveaway?.caseId || 'N/A';

            const reaction = message.reactions.cache.get('🎉');
            const participantCount = reaction ? reaction.count - 1 : 0;

            const countdownEmbed = {
                color: 16766680,
                title: '🎉 Giveaway in Progress!',
                description: '⏳ **Giveaway is still running!**',
                fields: [
                    { name: '🎁 Prize', value: `**${prize || '-'}**`, inline: true },
                    { name: '⏱️ Time Left', value: `**${toTime(timeRemaining) || '-'}**`, inline: true },
                    { name: '🎪 Participants', value: `**${participantCount != null ? participantCount : '-'}** 🎯`, inline: true },
                    { name: '👤 Host', value: host || '-', inline: true },
                    { name: '🆔 Case ID', value: `\`${caseId || '-'}\``, inline: true }
                ],
                footer: { text: `⚡ Keep reacting to participate! | Case ID: ${caseId || '-'}` },
                timestamp: new Date()
            };

            await message.edit({ embeds: [countdownEmbed] }).catch((err) => {
                console.error(`[Giveaway] Failed to update countdown: ${err.message}`);
            });
        } catch (error) {
            console.error('Error updating giveaway:', error);
        }
    }

    // Giveaway ended
    await finalizeGiveaway(message, giveawayId, client, prize, host);
}

// Pick winner and update giveaway message
async function finalizeGiveaway(message, giveawayId, client, prize, host) {
    try {
        // Let's grab the case ID from the database so we can show it in the embed.
        const giveawayDB = DatabaseManager.getGiveawaysDB();
        const giveaway = await giveawayDB.get(giveawayId);
        const caseId = giveaway?.caseId || 'N/A';

        // Get participants from database (more reliable than reactions)
        const participants = giveaway?.entries || [];

        // Also get usernames from reactions as fallback
        const reaction = await message.reactions.cache.get('🎉');
        const users = reaction ? await reaction.users.fetch() : new Map();
        const reactionUsernames = users.filter(user => !user.bot).map(user => user.username);

        let endEmbed;

        if (participants.length === 0) {
            endEmbed = {
                color: 16744171,
                title: '❌ No Winners',
                description: `No one entered the **${prize || '-'}** giveaway. Better luck next time! 🍀`,
                fields: [
                    { name: '🎁 Prize', value: `**${prize || '-'}**`, inline: true },
                    { name: '👥 Total Reactions', value: '0', inline: true },
                    { name: '🆔 Case ID', value: `\`${caseId || '-'}\``, inline: true }
                ],
                footer: { text: `Giveaway Ended - No participants | Case ID: ${caseId || '-'}` },
                timestamp: new Date()
            };
        } else {
            // Pick random winner from participants
            const winnerId = participants[Math.floor(Math.random() * participants.length)];

            // Try to get winner's username
            let winnerUsername = 'Unknown User';
            try {
                const winnerUser = await message.guild.members.fetch(winnerId);
                winnerUsername = winnerUser.user.username;
            } catch (error) {
                // Fallback to ID if user not found
                winnerUsername = `<@${winnerId}>`;
            }

            endEmbed = {
                color: 65280,
                title: '🏆 Giveaway Winner!',
                description: `🎉 **Congratulations ${winnerUsername || '-'}!** You won the **${prize || '-'}** giveaway!`,
                fields: [
                    { name: '🎁 Prize', value: `**${prize || '-'}**`, inline: true },
                    { name: '🥇 Winner', value: `**${winnerUsername || '-'}**\n<@${winnerId || '-'}>`, inline: true },
                    { name: '👥 Participants', value: `**${participants.length || '-'}**`, inline: true },
                    { name: '📊 Chance', value: `**${participants.length ? ((1 / participants.length) * 100).toFixed(2) : '-'}%**`, inline: true },
                    { name: '🆔 Case ID', value: `\`${caseId || '-'}\``, inline: true }
                ],
                footer: { text: `🎊 Giveaway Ended | Case ID: ${caseId || '-'}` },
                timestamp: new Date()
            };
        }

        await message.edit({ embeds: [endEmbed] }).catch((err) => {
            console.error(`[Giveaway] Failed to update end embed: ${err.message}`);
        });

        // Mark as ended in database
        if (giveaway) {
            giveaway.completed = true;
            giveaway.ended = true; // Mark as ended for MySQL database
            await giveawayDB.set(giveawayId, giveaway);
            console.log(`[Giveaway] Marked giveaway ${caseId} as ended in database`);
        }

    } catch (error) {
        console.error('Error finalizing giveaway:', error);
    }
}

module.exports = {
    name: 'giveaway',
    description: 'Manage giveaways in your server',

    async handleGiveaway(interaction, client) {
        const { administratorRoleId } = require('../Config/constants/roles.json');
        const { giveawayChannelId } = require('../Config/constants/channel.json');

        // Parse duration string (e.g., "10m", "1h", "2d")
        function parseDuration(durationStr) {
            const regex = /^(\d+)([mhd])$/i;
            const match = durationStr.toLowerCase().match(regex);

            if (!match) return null;

            const value = parseInt(match[1]);
            const unit = match[2];

            let seconds = 0;
            switch (unit) {
                case 'm': seconds = value * 60; break;
                case 'h': seconds = value * 3600; break;
                case 'd': seconds = value * 86400; break;
                default: return null;
            }

            return seconds;
        }

        // Find the giveaway channel from config
        const channel = interaction.guild.channels.cache.get(giveawayChannelId);
        if (!channel) {
            const embed = {
                color: 16711680,
                title: '⚠️ Config Error',
                description: 'Giveaway channel isn\'t set up properly.',
                footer: { text: 'Setup Required' },
                timestamp: new Date()
            };
            return await interaction.reply({ embeds: [embed], flags: 64 });
        }

        // Make sure they have permission to start giveaways
        if (!interaction.member.roles.cache.has(administratorRoleId)) {
            const embed = {
                color: 16711680,
                title: '🚫 No Permission',
                description: `You need the <@&${administratorRoleId}> role to start giveaways.`,
                footer: { text: 'Permission Required' },
                timestamp: new Date()
            };
            return await interaction.reply({ embeds: [embed], flags: 64 });
        }

        const durationInput = interaction.options.getString('duration');
        const duration = parseDuration(durationInput);
        const prize = interaction.options.getString('prize');

        if (!duration) {
            const embed = {
                color: 16744171,
                title: '⏳ Invalid Duration',
                description: 'Duration format is wrong.\n\n**Valid:**\n• Minutes: `10m`, `30m`\n• Hours: `1h`, `2h`\n• Days: `1d`, `2d`\n\n**Examples:**\n• `/giveaway 10m Nitro`\n• `/giveaway 1h Discord Boost`',
                footer: { text: 'Use correct format' },
                timestamp: new Date()
            };
            return await interaction.reply({ embeds: [embed], flags: 64 });
        }

        const maxDuration = 7 * 86400; // 7 days max
        if (duration < 60 || duration > maxDuration) {
            const embed = {
                color: 16744171,
                title: '⏳ Invalid Duration',
                description: 'Duration must be 1 minute to 7 days.\n\n• Min: `1m`\n• Max: `7d`',
                footer: { text: 'Check duration' },
                timestamp: new Date()
            };
            return await interaction.reply({ embeds: [embed], flags: 64 });
        }

        if (!prize || prize.length < 2 || prize.length > 100) {
            const embed = {
                color: 16744171,
                title: '🎁 Invalid Prize',
                description: 'Prize must be 2-100 characters.',
                footer: { text: 'Check prize name' },
                timestamp: new Date()
            };
            return await interaction.reply({ embeds: [embed], flags: 64 });
        }

        await interaction.deferReply();

        // Create giveaway embed
        const startEmbed = {
            color: 16766680,
            title: '🎉 Giveaway Started!',
            description: `React with 🎉 to enter!`,
            fields: [
                { name: '🎁 Prize', value: `**${prize}**`, inline: true },
                { name: '⏱️ Duration', value: `**${toTime(duration)}**`, inline: true },
                { name: '👤 Host', value: `${interaction.user}`, inline: true },
                { name: 'How to Enter', value: 'React with 🎉\nStay in the server\nWait for winner', inline: false },
                { name: 'Participants', value: '**0**', inline: true },
                { name: 'Status', value: '**Active** 🟢', inline: true }
            ],
            footer: { text: '🎊 Good luck! Only one winner will be selected.' },
            timestamp: new Date()
        };

        try {
            // Generate unique case ID for this giveaway (longer format)
            const caseId = generateCaseId('GIVE', 10);

            // Send giveaway message
            const giveawayMessage = await channel.send({ embeds: [startEmbed] });
            await giveawayMessage.react('🎉');

            // Store giveaway data (both in-memory and persistent database)
            const giveawayId = giveawayMessage.id;
            const giveawayData = {
                caseId: caseId,
                messageId: giveawayMessage.id,
                channelId: channel.id,
                guildId: interaction.guildId,
                hostId: interaction.user.id,
                hostName: interaction.user.username,
                prize: prize,
                title: prize, // Use prize as title
                endTime: Date.now() + (duration * 1000),
                participants: new Set(),
                duration: duration
            };

            activeGiveaways.set(giveawayId, giveawayData);

            // Save to database using proper MySQL fields
            const dbData = {
                caseId: caseId,
                prize: prize,
                title: prize, // Use prize as title for the giveaway
                channelId: channel.id,
                messageId: giveawayMessage.id,
                hostId: interaction.user.id,
                guildId: interaction.guildId,
                endTime: Date.now() + (duration * 1000),
                winnerCount: 1,
                ended: false
            };

            // Validate before storing
            if (!dbData.messageId || !dbData.channelId || !dbData.endTime || !dbData.prize || !dbData.caseId) {
                console.error('[Giveaway] Cannot save giveaway - missing required fields:', dbData);
                throw new Error('Failed to create giveaway - missing required data');
            }

            // Save to MySQL database
            const giveawayDB = DatabaseManager.getGiveawaysDB();
            await giveawayDB.set(giveawayId, dbData);

            console.log(`[Giveaway] Created giveaway with Case ID: ${caseId}, Message ID: ${giveawayId}`);

            // Update the embed to include the case ID
            const updatedEmbed = {
                ...startEmbed,
                footer: { text: `🎊 Good luck! Only one winner will be selected. | Case ID: ${caseId}` },
                fields: [
                    ...startEmbed.fields,
                    { name: '🆔 Case ID', value: `\`${caseId}\``, inline: true }
                ]
            };
            await giveawayMessage.edit({ embeds: [updatedEmbed] });

            // Confirm to user
            const successEmbed = {
                color: 65280,
                title: '✅ Giveaway Created!',
                description: `Giveaway posted in ${channel} and is now live! React with 🎉 to enter.`,
                fields: [
                    { name: '🆔 Case ID', value: `\`${caseId}\``, inline: true },
                    { name: '🎁 Prize', value: `**${prize}**`, inline: true },
                    { name: '⏱️ Duration', value: `**${toTime(duration)}**`, inline: true },
                    { name: 'Status', value: '**ACTIVE** 🟢', inline: true }
                ],
                footer: { text: 'Monitor the giveaway for live participant updates!' },
                timestamp: new Date()
            };
            await interaction.editReply({ embeds: [successEmbed] });

            // Run countdown
            await runGiveawayCountdown(giveawayMessage, giveawayId, client, duration, prize, interaction.user.username);

        } catch (error) {
            console.error('Error starting giveaway:', error);
            const errorEmbed = {
                color: 16711680,
                title: '❌ Error Creating Giveaway',
                description: 'An error occurred while trying to start the giveaway.\n\n**Please try again later or contact an administrator if the problem persists.**',
                fields: [
                    { name: '🔍 Error Details', value: `\`${error.message}\``, inline: false }
                ],
                footer: { text: 'If this issue continues, check your configuration' },
                timestamp: new Date()
            };
            return await interaction.editReply({ embeds: [errorEmbed] });
        }
    },

    // Handle extending an active giveaway
    async handleExtendGiveaway(interaction, client) {
        const { giveawayChannelId } = require('../Config/constants/channel.json');
        const identifier = interaction.options.getString('message-id'); // Case ID only
        const durationInput = interaction.options.getString('duration');

        // Parse duration
        const regex = /^(\d+)([mhd])$/i;
        const match = durationInput.toLowerCase().match(regex);

        if (!match) {
            const embed = {
                color: 16744171,
                title: '⏳ Invalid Duration Format',
                description: 'Duration format is invalid.\n\n**Valid Formats:**\n• **Minutes:** `10m`, `30m`\n• **Hours:** `1h`, `2h`\n• **Days:** `1d`',
                footer: { text: 'Use the correct format and try again' },
                timestamp: new Date()
            };
            return await interaction.reply({ embeds: [embed], flags: 64 });
        }

        const value = parseInt(match[1], 10);
        const unit = match[2];

        let seconds = 0;
        switch (unit) {
            case 'm': seconds = value * 60; break;
            case 'h': seconds = value * 3600; break;
            case 'd': seconds = value * 86400; break;
        }

        try {
            await interaction.deferReply();

            const channel = interaction.guild.channels.cache.get(giveawayChannelId);
            if (!channel) {
                const embed = {
                    color: 16711680,
                    title: '⚠️ Configuration Error',
                    description: 'The giveaway channel is not properly configured.',
                    footer: { text: 'Setup Required' },
                    timestamp: new Date()
                };
                return await interaction.editReply({ embeds: [embed] });
            }

            // Get giveaway data using case ID only
            const giveawayDB = DatabaseManager.getGiveawaysDB();

            // Verify identifier is a case ID (format: GIVE-XXXXXXXXXX)
            if (!identifier.startsWith('GIVE-')) {
                const embed = {
                    color: 16711680,
                    title: '❌ Invalid Format',
                    description: `Please use the Case ID format: \`GIVE-XXXXXXXXXX\`\n\nExample: \`/giveaway extend GIVE-kX7mP9qL2n 30m\``,
                    footer: { text: 'Case IDs only - no message IDs' },
                    timestamp: new Date()
                };
                return await interaction.editReply({ embeds: [embed] });
            }

            const allGiveaways = await giveawayDB.all();
            const foundGiveaway = allGiveaways.find(g => g.value.caseId === identifier);

            if (!foundGiveaway) {
                const embed = {
                    color: 16711680,
                    title: '❌ Giveaway Not Found',
                    description: `No giveaway found with Case ID \`${identifier}\`.`,
                    footer: { text: 'Check the Case ID and try again' },
                    timestamp: new Date()
                };
                return await interaction.editReply({ embeds: [embed] });
            }

            const giveaway = foundGiveaway.value;
            const messageId = giveaway.messageId;

            const message = await channel.messages.fetch(messageId).catch(() => null);
            if (!message) {
                const embed = {
                    color: 16711680,
                    title: '❌ Message Not Found',
                    description: `The giveaway message no longer exists.`,
                    footer: { text: 'The message may have been deleted' },
                    timestamp: new Date()
                };
                return await interaction.editReply({ embeds: [embed] });
            }

            if (!giveaway) {
                const embed = {
                    color: 16711680,
                    title: '❌ Giveaway Data Not Found',
                    description: `This message is not associated with an active giveaway.`,
                    footer: { text: 'Try again with a valid giveaway message' },
                    timestamp: new Date()
                };
                return await interaction.editReply({ embeds: [embed] });
            }

            if (giveaway.completed) {
                const embed = {
                    color: 16711680,
                    title: '❌ Giveaway Already Ended',
                    description: `This giveaway has already been completed.`,
                    footer: { text: 'You can use /giveaway reroll to pick a new winner instead' },
                    timestamp: new Date()
                };
                return await interaction.editReply({ embeds: [embed] });
            }

            // Extend the giveaway
            const oldEndTime = giveaway.endTime;
            giveaway.endTime += seconds * 1000;
            await giveawayDB.set(messageId, giveaway);

            const successEmbed = {
                color: 65280,
                title: '✅ Giveaway Extended!',
                description: `🎉 The giveaway has been extended by **${toTime(seconds)}**.`,
                fields: [
                    { name: '🆔 Case ID', value: `\`${giveaway.caseId || 'N/A'}\``, inline: true },
                    { name: '🎁 Prize', value: giveaway.prize, inline: true },
                    { name: '⏱️ New End Time', value: `<t:${Math.floor(giveaway.endTime / 1000)}:F>`, inline: true }
                ],
                footer: { text: 'The countdown will update automatically' },
                timestamp: new Date()
            };

            await interaction.editReply({ embeds: [successEmbed] });
            console.log(`[Giveaway] Extended giveaway ${giveaway.caseId || messageId} by ${seconds}s`);
        } catch (error) {
            console.error('[Giveaway] Error extending giveaway:', error);
            const embed = {
                color: 16711680,
                title: '❌ Error',
                description: `An error occurred while extending the giveaway.\n\n\`${error.message}\``,
                timestamp: new Date()
            };
            await interaction.editReply({ embeds: [embed] });
        }
    },

    // Handle rerolling a giveaway winner
    async handleRerollGiveaway(interaction, client) {
        const { giveawayChannelId } = require('../Config/constants/channel.json');
        const identifier = interaction.options.getString('message-id'); // Case ID only now

        try {
            await interaction.deferReply();

            const channel = interaction.guild.channels.cache.get(giveawayChannelId);
            if (!channel) {
                const embed = {
                    color: 16711680,
                    title: '⚠️ Configuration Error',
                    description: 'The giveaway channel is not properly configured.',
                    footer: { text: 'Setup Required' },
                    timestamp: new Date()
                };
                return await interaction.editReply({ embeds: [embed] });
            }

            // Verify identifier is a case ID (format: GIVE-XXXXXXXXXX)
            if (!identifier.startsWith('GIVE-')) {
                const embed = {
                    color: 16711680,
                    title: '❌ Invalid Format',
                    description: `Please use the Case ID format: \`GIVE-XXXXXXXXXX\`\n\nExample: \`/giveaway reroll GIVE-kX7mP9qL2n\``,
                    footer: { text: 'Case IDs only - no message IDs' },
                    timestamp: new Date()
                };
                return await interaction.editReply({ embeds: [embed] });
            }

            // Get giveaway data using case ID only
            const giveawayDB = DatabaseManager.getGiveawaysDB();
            const allGiveaways = await giveawayDB.all();
            const foundGiveaway = allGiveaways.find(g => g.value.caseId === identifier);

            if (!foundGiveaway) {
                const embed = {
                    color: 16711680,
                    title: '❌ Giveaway Not Found',
                    description: `No giveaway found with Case ID \`${identifier}\`.`,
                    footer: { text: 'Check the Case ID and try again' },
                    timestamp: new Date()
                };
                return await interaction.editReply({ embeds: [embed] });
            }

            const giveaway = foundGiveaway.value;
            const messageId = giveaway.messageId;

            const message = await channel.messages.fetch(messageId).catch(() => null);
            if (!message) {
                const embed = {
                    color: 16711680,
                    title: '❌ Message Not Found',
                    description: `The giveaway message no longer exists.`,
                    footer: { text: 'The message may have been deleted' },
                    timestamp: new Date()
                };
                return await interaction.editReply({ embeds: [embed] });
            }

            // Get participants from database
            const participants = giveaway.entries || [];

            if (participants.length === 0) {
                const embed = {
                    color: 16744171,
                    title: '❌ No Participants',
                    description: 'There are no participants in this giveaway to select a winner from.',
                    timestamp: new Date()
                };
                return await interaction.editReply({ embeds: [embed] });
            }

            // Pick random winner from participant IDs
            const winnerId = participants[Math.floor(Math.random() * participants.length)];

            // Try to get winner's username
            let winnerUsername = 'Unknown User';
            try {
                const winnerUser = await message.guild.members.fetch(winnerId);
                winnerUsername = winnerUser.user.username;
            } catch (error) {
                // Fallback to ID if user not found
                winnerUsername = `<@${winnerId}>`;
            }

            const rerollEmbed = {
                color: 65280,
                title: '🎊 New Winner!',
                description: `🎉 **Congratulations ${winnerUsername}!** You won the **${giveaway.prize}** giveaway!`,
                fields: [
                    { name: '🎁 Prize', value: `**${giveaway.prize}**`, inline: true },
                    { name: '🥇 Winner', value: `**${winnerUsername}**\n<@${winnerId}>`, inline: true },
                    { name: '👥 Participants', value: `**${participants.length}**`, inline: true },
                    { name: '📊 Chance', value: `**${((1 / participants.length) * 100).toFixed(2)}%**`, inline: true },
                    { name: '🔄 Note', value: 'This is a reroll - a new winner was selected from all previous participants', inline: false },
                    { name: '🆔 Case ID', value: `\`${giveaway.caseId || 'N/A'}\``, inline: true }
                ],
                footer: { text: 'Giveaway Rerolled | Case ID: ' + (giveaway.caseId || 'N/A') },
                timestamp: new Date()
            };

            await message.edit({ embeds: [rerollEmbed] }).catch((err) => {
                console.error(`[Giveaway] Failed to update reroll embed: ${err.message}`);
            });

            const confirmEmbed = {
                color: 65280,
                title: '✅ Winner Rerolled',
                description: `A new winner was selected: **${winner}**`,
                fields: [
                    { name: '🆔 Case ID', value: `\`${giveaway.caseId || 'N/A'}\``, inline: true }
                ],
                footer: { text: 'The message has been updated' },
                timestamp: new Date()
            };

            await interaction.editReply({ embeds: [confirmEmbed] });
            console.log(`[Giveaway] Rerolled giveaway ${giveaway.caseId}, new winner: ${winner}`);
        } catch (error) {
            console.error('[Giveaway] Error rerolling giveaway:', error);
            const embed = {
                color: 16711680,
                title: '❌ Error',
                description: `An error occurred while rerolling the giveaway.\n\n\`${error.message}\``,
                timestamp: new Date()
            };
            await interaction.editReply({ embeds: [embed] });
        }
    }
};