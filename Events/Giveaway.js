const { Collection } = require('discord.js');
const DatabaseManager = require('../Functions/MySQLDatabaseManager');
const { generateCaseId } = require('./caseId');
const { ROLES: { administratorRoleId }, CHANNELS: { giveawayChannelId } } = require('../Config/constants');

const activeGiveaways = new Collection();

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

function parseDuration(durationStr) {
    const regex = /^(\d+)([mhd])$/i;
    const match = String(durationStr || '').toLowerCase().match(regex);

    if (!match) return null;

    const value = parseInt(match[1], 10);
    const unit = match[2];

    if (!Number.isFinite(value) || value <= 0) return null;

    switch (unit) {
        case 'm': return value * 60;
        case 'h': return value * 3600;
        case 'd': return value * 86400;
        default: return null;
    }
}

function pickUniqueRandomEntries(entries, count) {
    const cloned = [...entries];
    for (let i = cloned.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [cloned[i], cloned[j]] = [cloned[j], cloned[i]];
    }
    return cloned.slice(0, Math.max(0, Math.min(count, cloned.length)));
}

async function findGiveawayByCaseId(caseId) {
    const giveawayDB = DatabaseManager.getGiveawaysDB();
    const allGiveawaysMap = await giveawayDB.all();
    const allGiveaways = Object.values(allGiveawaysMap || {});
    return allGiveaways.find((g) => g?.caseId === caseId) || null;
}

async function getEligibleParticipantIds(giveaway, guild) {
    const entries = Array.isArray(giveaway?.entries) ? giveaway.entries : [];
    const uniqueEntries = [...new Set(entries)];
    const requiredRoleId = giveaway?.requiredRoleId || null;

    if (!requiredRoleId) {
        return uniqueEntries;
    }

    const eligible = [];
    for (const userId of uniqueEntries) {
        try {
            const member = await guild.members.fetch(userId);
            if (member?.roles?.cache?.has(requiredRoleId)) {
                eligible.push(userId);
            }
        } catch (_) {
            // Ignore users that cannot be fetched.
        }
    }

    return eligible;
}

async function buildWinnerLines(message, winnerIds) {
    const lines = [];
    for (let i = 0; i < winnerIds.length; i++) {
        const winnerId = winnerIds[i];
        let winnerUsername = 'Unknown User';
        try {
            const winnerUser = await message.guild.members.fetch(winnerId);
            winnerUsername = winnerUser.user.username;
        } catch (_) {
            winnerUsername = `<@${winnerId}>`;
        }
        lines.push(`${i + 1}. **${winnerUsername}** (<@${winnerId}>)`);
    }
    return lines;
}

async function finalizeGiveaway(message, giveawayId, forcedByUserTag = null) {
    try {
        const giveawayDB = DatabaseManager.getGiveawaysDB();
        const giveaway = await giveawayDB.get(giveawayId);
        if (!giveaway) return { success: false, reason: 'MISSING' };

        if (giveaway.ended) {
            return { success: false, reason: 'ALREADY_ENDED', giveaway };
        }

        const caseId = giveaway.caseId || 'N/A';
        const winnerCount = Math.max(1, Number(giveaway.winnerCount || 1));
        const eligibleParticipants = await getEligibleParticipantIds(giveaway, message.guild);

        let endEmbed;
        let selectedWinnerIds = [];

        if (eligibleParticipants.length === 0) {
            endEmbed = {
                color: 16744171,
                title: '❌ No Winners',
                description: `No eligible entries were found for the **${giveaway.prize || '-'}** giveaway.`,
                fields: [
                    { name: '🎁 Prize', value: `**${giveaway.prize || '-'}**`, inline: true },
                    { name: '👥 Eligible Entries', value: '0', inline: true },
                    { name: '🆔 Case ID', value: `\`${caseId}\``, inline: true }
                ],
                footer: { text: `Giveaway Ended - No eligible participants | Case ID: ${caseId}` },
                timestamp: new Date()
            };
        } else {
            selectedWinnerIds = pickUniqueRandomEntries(eligibleParticipants, winnerCount);
            const winnerLines = await buildWinnerLines(message, selectedWinnerIds);

            endEmbed = {
                color: 65280,
                title: selectedWinnerIds.length > 1 ? '🏆 Giveaway Winners!' : '🏆 Giveaway Winner!',
                description: `🎉 Congratulations to the winner${selectedWinnerIds.length > 1 ? 's' : ''} of **${giveaway.prize || '-'}**!`,
                fields: [
                    { name: '🎁 Prize', value: `**${giveaway.prize || '-'}**`, inline: true },
                    { name: '🥇 Winner Count', value: `**${selectedWinnerIds.length}**`, inline: true },
                    { name: '👥 Eligible Entries', value: `**${eligibleParticipants.length}**`, inline: true },
                    { name: '🏅 Winners', value: winnerLines.join('\n').slice(0, 1024) || '-', inline: false },
                    { name: '🆔 Case ID', value: `\`${caseId}\``, inline: true }
                ],
                footer: {
                    text: forcedByUserTag
                        ? `Ended early by ${forcedByUserTag} | Case ID: ${caseId}`
                        : `🎊 Giveaway Ended | Case ID: ${caseId}`
                },
                timestamp: new Date()
            };
        }

        await message.edit({ embeds: [endEmbed] }).catch((err) => {
            console.error(`[Giveaway] Failed to update end embed: ${err.message}`);
        });

        giveaway.completed = true;
        giveaway.ended = true;
        giveaway.winnerIds = selectedWinnerIds;
        await giveawayDB.set(giveawayId, giveaway);
        activeGiveaways.delete(giveawayId);

        console.log(`[Giveaway] Finalized giveaway ${caseId} (${giveawayId}) with ${selectedWinnerIds.length} winner(s)`);
        return { success: true, giveaway, winnerIds: selectedWinnerIds };
    } catch (error) {
        console.error('[Giveaway] Error finalizing giveaway:', error);
        return { success: false, reason: 'ERROR', error };
    }
}

async function runGiveawayCountdown(message, giveawayId) {
    const giveawayDB = DatabaseManager.getGiveawaysDB();

    while (true) {
        const giveaway = await giveawayDB.get(giveawayId);
        if (!giveaway || giveaway.ended || giveaway.completed) {
            activeGiveaways.delete(giveawayId);
            return;
        }

        const timeRemainingMs = Math.max(0, Number(giveaway.endTime || 0) - Date.now());
        const timeRemainingSeconds = Math.ceil(timeRemainingMs / 1000);
        const caseId = giveaway.caseId || 'N/A';
        const participantCount = Array.isArray(giveaway.entries) ? giveaway.entries.length : 0;
        const winnerCount = Math.max(1, Number(giveaway.winnerCount || 1));
        const requiredRoleText = giveaway.requiredRoleId ? `<@&${giveaway.requiredRoleId}>` : 'None';

        if (timeRemainingSeconds <= 0) {
            await finalizeGiveaway(message, giveawayId);
            return;
        }

        const countdownEmbed = {
            color: 16766680,
            title: '🎉 Giveaway in Progress!',
            description: '⏳ **Giveaway is still running!**',
            fields: [
                { name: '🎁 Prize', value: `**${giveaway.prize || '-'}**`, inline: true },
                { name: '⏱️ Time Left', value: `**${toTime(timeRemainingSeconds)}**`, inline: true },
                { name: '🎪 Entries', value: `**${participantCount}**`, inline: true },
                { name: '🏆 Winners', value: `**${winnerCount}**`, inline: true },
                { name: '✅ Required Role', value: requiredRoleText, inline: true },
                { name: '🆔 Case ID', value: `\`${caseId}\``, inline: true }
            ],
            footer: { text: `⚡ React with 🎉 to enter! | Case ID: ${caseId}` },
            timestamp: new Date()
        };

        await message.edit({ embeds: [countdownEmbed] }).catch((err) => {
            console.error(`[Giveaway] Failed to update countdown: ${err.message}`);
        });

        const updateInterval = Math.min(30, Math.max(5, Math.floor(timeRemainingSeconds / 10)));
        await sleep(updateInterval * 1000);
    }
}

module.exports = {
    name: 'giveaway',
    description: 'Manage giveaways in your server',

    async execute(...args) {
        // Default to handleGiveaway for compatibility
        return this.handleGiveaway(...args);
    },

    async handleGiveaway(interaction, client) {
        const channel = interaction.guild.channels.cache.get(giveawayChannelId);
        if (!channel) {
            return await interaction.reply({
                embeds: [{
                    color: 16711680,
                    title: '⚠️ Config Error',
                    description: 'Giveaway channel isn\'t set up properly.',
                    footer: { text: 'Setup Required' },
                    timestamp: new Date()
                }],
                flags: 64
            });
        }

        if (!interaction.member.roles.cache.has(administratorRoleId)) {
            return await interaction.reply({
                embeds: [{
                    color: 16711680,
                    title: '🚫 No Permission',
                    description: `You need the <@&${administratorRoleId}> role to start giveaways.`,
                    footer: { text: 'Permission Required' },
                    timestamp: new Date()
                }],
                flags: 64
            });
        }

        const durationInput = interaction.options.getString('duration');
        const duration = parseDuration(durationInput);
        const prize = interaction.options.getString('prize');
        const winners = interaction.options.getInteger('winners') || 1;
        const requiredRole = interaction.options.getRole('required-role');

        if (!duration || duration < 60 || duration > (7 * 86400)) {
            return await interaction.reply({
                embeds: [{
                    color: 16744171,
                    title: '⏳ Invalid Duration',
                    description: 'Duration must be between **1m** and **7d** (examples: `10m`, `2h`, `1d`).',
                    footer: { text: 'Use correct format' },
                    timestamp: new Date()
                }],
                flags: 64
            });
        }

        if (!prize || prize.length < 2 || prize.length > 100) {
            return await interaction.reply({
                embeds: [{
                    color: 16744171,
                    title: '🎁 Invalid Prize',
                    description: 'Prize must be 2-100 characters.',
                    footer: { text: 'Check prize name' },
                    timestamp: new Date()
                }],
                flags: 64
            });
        }

        await interaction.deferReply();

        try {
            const caseId = generateCaseId('GIVE', 10);

            const startEmbed = {
                color: 16766680,
                title: '🎉 Giveaway Started!',
                description: 'React with 🎉 to enter!',
                fields: [
                    { name: '🎁 Prize', value: `**${prize}**`, inline: true },
                    { name: '⏱️ Duration', value: `**${toTime(duration)}**`, inline: true },
                    { name: '🏆 Winners', value: `**${winners}**`, inline: true },
                    { name: '✅ Required Role', value: requiredRole ? `<@&${requiredRole.id}>` : 'None', inline: true },
                    { name: '👤 Host', value: `${interaction.user}`, inline: true },
                    { name: '🆔 Case ID', value: `\`${caseId}\``, inline: true }
                ],
                footer: { text: `🎊 Good luck! | Case ID: ${caseId}` },
                timestamp: new Date()
            };

            const giveawayMessage = await channel.send({ embeds: [startEmbed] });
            await giveawayMessage.react('🎉');

            const giveawayId = giveawayMessage.id;
            const endTime = Date.now() + (duration * 1000);

            activeGiveaways.set(giveawayId, {
                caseId,
                messageId: giveawayMessage.id,
                channelId: channel.id,
                guildId: interaction.guildId,
                hostId: interaction.user.id,
                hostName: interaction.user.username,
                prize,
                endTime,
                winnerCount: winners,
                requiredRoleId: requiredRole?.id || null,
                duration
            });

            const giveawayDB = DatabaseManager.getGiveawaysDB();
            await giveawayDB.set(giveawayId, {
                caseId,
                prize,
                title: prize,
                channelId: channel.id,
                messageId: giveawayMessage.id,
                hostId: interaction.user.id,
                guildId: interaction.guildId,
                endTime,
                winnerCount: winners,
                requiredRoleId: requiredRole?.id || null,
                ended: false
            });

            await interaction.editReply({
                embeds: [{
                    color: 65280,
                    title: '✅ Giveaway Created!',
                    description: `Giveaway posted in ${channel} and is now live.`,
                    fields: [
                        { name: '🆔 Case ID', value: `\`${caseId}\``, inline: true },
                        { name: '🏆 Winners', value: `**${winners}**`, inline: true },
                        { name: '✅ Required Role', value: requiredRole ? `<@&${requiredRole.id}>` : 'None', inline: true }
                    ],
                    footer: { text: 'Use /giveaway end, /giveaway extend, or /giveaway reroll for management.' },
                    timestamp: new Date()
                }]
            });

            runGiveawayCountdown(giveawayMessage, giveawayId).catch((error) => {
                console.error(`[Giveaway] Countdown crashed for ${giveawayId}: ${error.message}`);
            });
        } catch (error) {
            console.error('Error starting giveaway:', error);
            await interaction.editReply({
                embeds: [{
                    color: 16711680,
                    title: '❌ Error Creating Giveaway',
                    description: `An error occurred while trying to start the giveaway.\n\n\`${error.message}\``,
                    timestamp: new Date()
                }]
            });
        }
    },

    async handleExtendGiveaway(interaction) {
        const caseId = interaction.options.getString('message-id');
        const durationInput = interaction.options.getString('duration');
        const seconds = parseDuration(durationInput);

        if (!seconds) {
            return await interaction.reply({
                embeds: [{
                    color: 16744171,
                    title: '⏳ Invalid Duration Format',
                    description: 'Use format like `10m`, `2h`, or `1d`.',
                    timestamp: new Date()
                }],
                flags: 64
            });
        }

        if (!String(caseId || '').startsWith('GIVE-')) {
            return await interaction.reply({
                embeds: [{
                    color: 16711680,
                    title: '❌ Invalid Case ID',
                    description: 'Please provide a valid giveaway Case ID (`GIVE-...`).',
                    timestamp: new Date()
                }],
                flags: 64
            });
        }

        await interaction.deferReply();

        try {
            const giveaway = await findGiveawayByCaseId(caseId);
            if (!giveaway) {
                return await interaction.editReply({
                    embeds: [{ color: 16711680, title: '❌ Giveaway Not Found', description: `No giveaway found with Case ID \`${caseId}\`.`, timestamp: new Date() }]
                });
            }

            if (giveaway.ended || giveaway.completed) {
                return await interaction.editReply({
                    embeds: [{ color: 16711680, title: '❌ Giveaway Already Ended', description: 'This giveaway is already ended.', timestamp: new Date() }]
                });
            }

            const giveawayDB = DatabaseManager.getGiveawaysDB();
            const oldEndTime = Number(giveaway.endTime || Date.now());
            giveaway.endTime = oldEndTime + (seconds * 1000);
            await giveawayDB.set(giveaway.messageId, giveaway);

            await interaction.editReply({
                embeds: [{
                    color: 65280,
                    title: '✅ Giveaway Extended!',
                    fields: [
                        { name: '🆔 Case ID', value: `\`${giveaway.caseId || 'N/A'}\``, inline: true },
                        { name: '➕ Added Time', value: `**${toTime(seconds)}**`, inline: true },
                        { name: '⏱️ New End Time', value: `<t:${Math.floor(giveaway.endTime / 1000)}:F>`, inline: true }
                    ],
                    timestamp: new Date()
                }]
            });
        } catch (error) {
            console.error('[Giveaway] Error extending giveaway:', error);
            await interaction.editReply({
                embeds: [{ color: 16711680, title: '❌ Error', description: `\`${error.message}\``, timestamp: new Date() }]
            });
        }
    },

    async handleRerollGiveaway(interaction) {
        const caseId = interaction.options.getString('message-id');
        const overrideWinners = interaction.options.getInteger('winners');

        if (!String(caseId || '').startsWith('GIVE-')) {
            return await interaction.reply({
                embeds: [{
                    color: 16711680,
                    title: '❌ Invalid Case ID',
                    description: 'Please provide a valid giveaway Case ID (`GIVE-...`).',
                    timestamp: new Date()
                }],
                flags: 64
            });
        }

        await interaction.deferReply();

        try {
            const giveaway = await findGiveawayByCaseId(caseId);
            if (!giveaway) {
                return await interaction.editReply({
                    embeds: [{ color: 16711680, title: '❌ Giveaway Not Found', description: `No giveaway found with Case ID \`${caseId}\`.`, timestamp: new Date() }]
                });
            }

            const channel = interaction.guild.channels.cache.get(giveaway.channelId);
            const message = channel ? await channel.messages.fetch(giveaway.messageId).catch(() => null) : null;
            if (!message) {
                return await interaction.editReply({
                    embeds: [{ color: 16711680, title: '❌ Message Not Found', description: 'The giveaway message was not found.', timestamp: new Date() }]
                });
            }

            const eligibleParticipants = await getEligibleParticipantIds(giveaway, message.guild);
            if (eligibleParticipants.length === 0) {
                return await interaction.editReply({
                    embeds: [{ color: 16744171, title: '❌ No Eligible Participants', description: 'No eligible participants are available for a reroll.', timestamp: new Date() }]
                });
            }

            const winnersToPick = Math.max(1, Number(overrideWinners || giveaway.winnerCount || 1));
            const selectedWinnerIds = pickUniqueRandomEntries(eligibleParticipants, winnersToPick);
            const winnerLines = await buildWinnerLines(message, selectedWinnerIds);

            await message.edit({
                embeds: [{
                    color: 65280,
                    title: selectedWinnerIds.length > 1 ? '🎊 New Winners!' : '🎊 New Winner!',
                    description: `A reroll has been completed for **${giveaway.prize || '-'}**.`,
                    fields: [
                        { name: '🎁 Prize', value: `**${giveaway.prize || '-'}**`, inline: true },
                        { name: '🏆 Winners Picked', value: `**${selectedWinnerIds.length}**`, inline: true },
                        { name: '👥 Eligible Entries', value: `**${eligibleParticipants.length}**`, inline: true },
                        { name: '🏅 Winners', value: winnerLines.join('\n').slice(0, 1024) || '-', inline: false },
                        { name: '🆔 Case ID', value: `\`${giveaway.caseId || 'N/A'}\``, inline: true }
                    ],
                    footer: { text: `Giveaway Rerolled | Case ID: ${giveaway.caseId || 'N/A'}` },
                    timestamp: new Date()
                }]
            }).catch((err) => {
                console.error(`[Giveaway] Failed to update reroll embed: ${err.message}`);
            });

            const giveawayDB = DatabaseManager.getGiveawaysDB();
            giveaway.winnerIds = selectedWinnerIds;
            giveaway.winnerCount = winnersToPick;
            await giveawayDB.set(giveaway.messageId, giveaway);

            await interaction.editReply({
                embeds: [{
                    color: 65280,
                    title: '✅ Giveaway Rerolled',
                    description: `Selected **${selectedWinnerIds.length}** new winner(s).`,
                    fields: [{ name: '🆔 Case ID', value: `\`${giveaway.caseId || 'N/A'}\``, inline: true }],
                    timestamp: new Date()
                }]
            });
        } catch (error) {
            console.error('[Giveaway] Error rerolling giveaway:', error);
            await interaction.editReply({
                embeds: [{ color: 16711680, title: '❌ Error', description: `\`${error.message}\``, timestamp: new Date() }]
            });
        }
    },

    async handleEndGiveaway(interaction) {
        const caseId = interaction.options.getString('message-id');

        if (!String(caseId || '').startsWith('GIVE-')) {
            return await interaction.reply({
                embeds: [{
                    color: 16711680,
                    title: '❌ Invalid Case ID',
                    description: 'Please provide a valid giveaway Case ID (`GIVE-...`).',
                    timestamp: new Date()
                }],
                flags: 64
            });
        }

        await interaction.deferReply();

        try {
            const giveaway = await findGiveawayByCaseId(caseId);
            if (!giveaway) {
                return await interaction.editReply({
                    embeds: [{ color: 16711680, title: '❌ Giveaway Not Found', description: `No giveaway found with Case ID \`${caseId}\`.`, timestamp: new Date() }]
                });
            }

            if (giveaway.ended || giveaway.completed) {
                return await interaction.editReply({
                    embeds: [{ color: 16744171, title: 'ℹ️ Giveaway Already Ended', description: 'This giveaway has already ended.', timestamp: new Date() }]
                });
            }

            const channel = interaction.guild.channels.cache.get(giveaway.channelId);
            const message = channel ? await channel.messages.fetch(giveaway.messageId).catch(() => null) : null;

            if (!message) {
                const giveawayDB = DatabaseManager.getGiveawaysDB();
                giveaway.ended = true;
                giveaway.completed = true;
                await giveawayDB.set(giveaway.messageId, giveaway);

                return await interaction.editReply({
                    embeds: [{
                        color: 16744171,
                        title: '⚠️ Giveaway Marked Ended',
                        description: 'The giveaway message is missing, but the giveaway was marked as ended in the database.',
                        fields: [{ name: '🆔 Case ID', value: `\`${caseId}\``, inline: true }],
                        timestamp: new Date()
                    }]
                });
            }

            const result = await finalizeGiveaway(message, giveaway.messageId, interaction.user.tag);
            if (!result.success && result.reason === 'ALREADY_ENDED') {
                return await interaction.editReply({
                    embeds: [{ color: 16744171, title: 'ℹ️ Giveaway Already Ended', description: 'This giveaway has already ended.', timestamp: new Date() }]
                });
            }

            return await interaction.editReply({
                embeds: [{
                    color: 65280,
                    title: '✅ Giveaway Ended',
                    description: 'The giveaway was ended immediately and winners were finalized.',
                    fields: [{ name: '🆔 Case ID', value: `\`${caseId}\``, inline: true }],
                    timestamp: new Date()
                }]
            });
        } catch (error) {
            console.error('[Giveaway] Error ending giveaway:', error);
            await interaction.editReply({
                embeds: [{ color: 16711680, title: '❌ Error', description: `\`${error.message}\``, timestamp: new Date() }]
            });
        }
    }
};