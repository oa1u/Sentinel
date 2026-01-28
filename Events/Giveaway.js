const { Collection } = require('discord.js');
const DatabaseManager = require('../Functions/DatabaseManager');

const activeGiveaways = new Collection();

// Convert seconds to readable time
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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
        
        // Get the giveaway channel
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
        
        // Check permissions
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

        const maxDuration = 7 * 86400; // 7 days in seconds
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
            title: '🎉 New Giveaway Started!',
            description: '━━━━━━━━━━━━━━━━━━━━━\n\n✨ **React with 🎉 below to enter!**\n\n━━━━━━━━━━━━━━━━━━━━━',
            fields: [
                { name: '🎁 Prize', value: `**${prize}**`, inline: true },
                { name: '⏱️ Duration', value: `**${toTime(duration)}**`, inline: true },
                { name: '👤 Hosted by', value: `${interaction.user}`, inline: true },
                { name: '🎪 Current Participants', value: '0', inline: true },
                { name: '📋 How to Participate', value: 'Click the 🎉 reaction button below to enter the giveaway!', inline: false }
            ],
            footer: { text: '🍀 Good luck! Winner will be selected randomly.' },
            timestamp: new Date()
        };

        try {
            // Send giveaway message
            const giveawayMessage = await channel.send({ embeds: [startEmbed] });
            await giveawayMessage.react('🎉');

            // Store giveaway data (both in-memory and persistent database)
            const giveawayId = giveawayMessage.id;
            const giveawayData = {
                messageId: giveawayMessage.id,
                channelId: channel.id,
                guildId: interaction.guildId,
                hostId: interaction.user.id,
                hostName: interaction.user.username,
                prize: prize,
                endTime: Date.now() + (duration * 1000),
                participants: new Set(),
                duration: duration
            };
            
            activeGiveaways.set(giveawayId, giveawayData);
            
            // Save to database for persistence
            const giveawayDB = DatabaseManager.getGiveawaysDB();
            giveawayDB.set(giveawayId, {
              messageId: giveawayMessage.id,
              channelId: channel.id,
              guildId: interaction.guildId,
              hostId: interaction.user.id,
              hostName: interaction.user.username,
              prize: prize,
              endTime: Date.now() + (duration * 1000),
              duration: duration,
              createdAt: Date.now(),
              completed: false
            });

            // Confirm to user
            const successEmbed = {
                color: 65280,
                title: '✅ Giveaway Started Successfully!',
                description: `━━━━━━━━━━━━━━━━━━━━━\n\n🎉 Your giveaway has been posted to ${channel}!\n\n**The countdown has begun!**\n\n━━━━━━━━━━━━━━━━━━━━━`,
                fields: [
                    { name: '🎁 Prize', value: `**${prize}**`, inline: true },
                    { name: '⏱️ Duration', value: `**${toTime(duration)}**`, inline: true },
                    { name: '📊 Status', value: '**Active** 🟢', inline: true }
                ],
                footer: { text: 'Watch the giveaway progress in real-time!' },
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
    
    /**
     * Handle extending an active giveaway
     */
    async handleExtendGiveaway(interaction, client) {
        const { giveawayChannelId } = require('../Config/constants/channel.json');
        const messageId = interaction.options.getString('message-id');
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
            
            const message = await channel.messages.fetch(messageId).catch(() => null);
            if (!message) {
                const embed = {
                    color: 16711680,
                    title: '❌ Giveaway Not Found',
                    description: `No giveaway message found with ID \`${messageId}\`.`,
                    footer: { text: 'Check the message ID and try again' },
                    timestamp: new Date()
                };
                return await interaction.editReply({ embeds: [embed] });
            }
            
            // Get giveaway data
            const giveawayDB = DatabaseManager.getGiveawaysDB();
            const giveaway = giveawayDB.get(messageId);
            
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
            giveawayDB.set(messageId, giveaway);
            
            const successEmbed = {
                color: 65280,
                title: '✅ Giveaway Extended!',
                description: `🎉 The giveaway has been extended by **${toTime(seconds)}**.`,
                fields: [
                    { name: '🎁 Prize', value: giveaway.prize, inline: true },
                    { name: '⏱️ New End Time', value: `<t:${Math.floor(giveaway.endTime / 1000)}:F>`, inline: true }
                ],
                footer: { text: 'The countdown will update automatically' },
                timestamp: new Date()
            };
            
            await interaction.editReply({ embeds: [successEmbed] });
            console.log(`[Giveaway] Extended giveaway ${messageId} by ${seconds}s`);
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
    
    /**
     * Handle rerolling a giveaway winner
     */
    async handleRerollGiveaway(interaction, client) {
        const { giveawayChannelId } = require('../Config/constants/channel.json');
        const messageId = interaction.options.getString('message-id');
        
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
            
            const message = await channel.messages.fetch(messageId).catch(() => null);
            if (!message) {
                const embed = {
                    color: 16711680,
                    title: '❌ Giveaway Not Found',
                    description: `No giveaway message found with ID \`${messageId}\`.`,
                    footer: { text: 'Check the message ID and try again' },
                    timestamp: new Date()
                };
                return await interaction.editReply({ embeds: [embed] });
            }
            
            // Get giveaway data
            const giveawayDB = DatabaseManager.getGiveawaysDB();
            const giveaway = giveawayDB.get(messageId);
            
            if (!giveaway) {
                const embed = {
                    color: 16711680,
                    title: '❌ Giveaway Data Not Found',
                    description: `This message is not associated with a giveaway.`,
                    footer: { text: 'Try again with a valid giveaway message' },
                    timestamp: new Date()
                };
                return await interaction.editReply({ embeds: [embed] });
            }
            
            // Get reactions
            const reaction = await message.reactions.cache.get('🎉');
            const users = reaction ? await reaction.users.fetch() : new Map();
            const participants = users.filter(user => !user.bot).map(user => user.username);
            
            if (participants.length === 0) {
                const embed = {
                    color: 16744171,
                    title: '❌ No Participants',
                    description: 'There are no participants in this giveaway to select a winner from.',
                    timestamp: new Date()
                };
                return await interaction.editReply({ embeds: [embed] });
            }
            
            const winner = participants[Math.floor(Math.random() * participants.length)];
            
            const rerollEmbed = {
                color: 65280,
                title: '🎊 New Winner Selected!',
                description: `━━━━━━━━━━━━━━━━━━━━━\n\n🎉 **Congratulations ${winner}!** 🎉\n\nYou have won the **${giveaway.prize}** giveaway!\n\n━━━━━━━━━━━━━━━━━━━━━`,
                fields: [
                    { name: '🎁 Prize', value: `**${giveaway.prize}**`, inline: true },
                    { name: '🥇 New Winner', value: `**${winner}**`, inline: true },
                    { name: '👥 Total Participants', value: `**${participants.length}**`, inline: true },
                    { name: '📊 Winning Chance', value: `**${((1 / participants.length) * 100).toFixed(2)}%**`, inline: true },
                    { name: '🔄 Note', value: 'This is a reroll - a new winner was selected from all previous participants', inline: false }
                ],
                footer: { text: 'Giveaway Rerolled' },
                timestamp: new Date()
            };
            
            await message.edit({ embeds: [rerollEmbed] }).catch((err) => {
                console.error(`[Giveaway] Failed to update reroll embed: ${err.message}`);
            });
            
            const confirmEmbed = {
                color: 65280,
                title: '✅ Winner Rerolled',
                description: `A new winner was selected: **${winner}**`,
                footer: { text: 'The message has been updated' },
                timestamp: new Date()
            };
            
            await interaction.editReply({ embeds: [confirmEmbed] });
            console.log(`[Giveaway] Rerolled giveaway ${messageId}, new winner: ${winner}`);
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

async function runGiveawayCountdown(message, giveawayId, client, duration, prize, host) {
    let timeRemaining = duration;
    const updateInterval = Math.min(30, Math.max(5, Math.floor(duration / 10))); // Update every 30 secs or 10% of duration

    while (timeRemaining > 0) {
        await sleep(updateInterval * 1000);
        timeRemaining -= updateInterval;

        try {
            // Fetch fresh reaction count
            const reaction = message.reactions.cache.get('🎉');
            const participantCount = reaction ? reaction.count - 1 : 0; // -1 for bot reaction

            const countdownEmbed = {
                color: 16766680,
                title: '🎉 Giveaway in Progress!',
                description: '━━━━━━━━━━━━━━━━━━━━━\n\n⏳ **Giveaway is still running!**\n\n━━━━━━━━━━━━━━━━━━━━━',
                fields: [
                    { name: '🎁 Prize', value: `**${prize}**`, inline: true },
                    { name: '⏱️ Time Remaining', value: `**${toTime(timeRemaining)}**`, inline: true },
                    { name: '👤 Hosted by', value: host, inline: true },
                    { name: '🎪 Participants', value: `**${participantCount}** 🎯`, inline: true }
                ],
                footer: { text: '⚡ Keep reacting to participate! The winner will be selected when time runs out.' },
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

async function finalizeGiveaway(message, giveawayId, client, prize, host) {
    try {
        // Fetch final reactions
        const reaction = await message.reactions.cache.get('🎉');
        const users = reaction ? await reaction.users.fetch() : new Map();
        
        // Filter out bot
        const participants = users.filter(user => !user.bot).map(user => user.username);

        let endEmbed;

        if (participants.length === 0) {
            endEmbed = {
                color: 16744171,
                title: '❌ No Winners',
                description: `━━━━━━━━━━━━━━━━━━━━━\n\nUnfortunately, nobody reacted to the **${prize}** giveaway.\n\n**Better luck next time!** 🍀\n\n━━━━━━━━━━━━━━━━━━━━━`,
                fields: [
                    { name: '🎁 Prize', value: `**${prize}**`, inline: true },
                    { name: '👥 Total Reactions', value: '0', inline: true }
                ],
                footer: { text: 'Giveaway Ended - No participants' },
                timestamp: new Date()
            };
        } else {
            const winner = participants[Math.floor(Math.random() * participants.length)];
            endEmbed = {
                color: 65280,
                title: '🏆 Giveaway Winner Announced!',
                description: `━━━━━━━━━━━━━━━━━━━━━\n\n🎉 **Congratulations ${winner}!** 🎉\n\nYou have won the **${prize}** giveaway!\n\n━━━━━━━━━━━━━━━━━━━━━`,
                fields: [
                    { name: '🎁 Prize Won', value: `**${prize}**`, inline: true },
                    { name: '🥇 Winner', value: `**${winner}**`, inline: true },
                    { name: '👥 Total Participants', value: `**${participants.length}**`, inline: true },
                    { name: '📊 Winning Chance', value: `**${((1 / participants.length) * 100).toFixed(2)}%**`, inline: true }
                ],
                footer: { text: '🎊 Giveaway Ended - Congratulations to the winner!' },
                timestamp: new Date()
            };
        }

        await message.edit({ embeds: [endEmbed] }).catch((err) => {
            console.error(`[Giveaway] Failed to update end embed: ${err.message}`);
        });
        activeGiveaways.delete(giveawayId);
        
        // Mark as completed in database
        const giveawayDB = DatabaseManager.getGiveawaysDB();
        const giveaway = giveawayDB.get(giveawayId);
        if (giveaway) {
          giveaway.completed = true;
          giveawayDB.set(giveawayId, giveaway);
        }

    } catch (error) {
        console.error('Error finalizing giveaway:', error);
    }
}