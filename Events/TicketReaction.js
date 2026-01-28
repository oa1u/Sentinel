const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { ticketCategoryId, ticketLogChannelId } = require("../Config/constants/channel.json");
const { supportTeamRoleId } = require("../Config/constants/roles.json");
const DatabaseManager = require('../Functions/DatabaseManager');

module.exports = {
    name: "messageReactionAdd",
    runOnce: false,
    call: async (client, args) => {
        if (!args || !args[0] || !args[1]) return;
        
        const reaction = args[0];
        const user = args[1];
        
        // Ignore bot reactions
        if (user.bot) return;
        
        // Check if reaction is ❌
        if (reaction.emoji.name !== '❌') return;
        
        // Fetch partial messages if needed
        if (reaction.partial) {
            try {
                await reaction.fetch();
            } catch (error) {
                console.error('Error fetching reaction:', error);
                return;
            }
        }
        
        const channel = reaction.message.channel;
        
        // Check if this is a ticket channel
        if (channel.parentId !== ticketCategoryId) return;
        
        // Check if channel name contains 'ticket-' (accounts for emoji prefix)
        if (!channel.name.includes('-ticket-')) return;
        
        // Get the member who reacted
        const member = await channel.guild.members.fetch(user.id).catch(() => null);
        if (!member) return;
        
        // Extract ticket owner from channel name (emoji-ticket-username)
        const ticketOwnerName = channel.name.split('-ticket-')[1];
        
        // Check if user has permission to close (ticket owner or support role)
        const isTicketOwner = user.username.toLowerCase() === ticketOwnerName.toLowerCase();
        const hasSupport = member.roles.cache.has(supportTeamRoleId);
        const isAdmin = member.permissions.has('Administrator');
        
        if (!isTicketOwner && !hasSupport && !isAdmin) {
            // Remove reaction if no permission
            await reaction.users.remove(user.id).catch((err) => {
                console.error(`[Ticket] Couldn't remove reaction: ${err.message}`);
            });
            return;
        }
        
        // Get ticket data from database
        const ticketsDB = DatabaseManager.getDatabase('tickets');
        const ticketData = ticketsDB.get(channel.id) || {};
        
        // Create transcript
        let transcript = `📋 Ticket Transcript - ${channel.name}\n`;
        transcript += `─────────────────\n\n`;
        transcript += `🎫 Info:\n`;
        transcript += `   • Ticket Owner: ${ticketData.userName || 'Unknown'} (${ticketData.userId || 'N/A'})\n`;
        transcript += `   • Created: ${ticketData.createdAt ? new Date(ticketData.createdAt).toLocaleString() : 'Unknown'}\n`;
        transcript += `   • Closed: ${new Date().toLocaleString()}\n`;
        transcript += `   • Closed By: ${user.tag} (${user.id}) [Via Reaction]\n`;
        transcript += `   • Close Reason: Closed via ❌ reaction\n`;
        transcript += `   • Priority: ${ticketData.priority || 'medium'}\n`;
        transcript += `   • Reason: ${ticketData.reason || 'No reason'}\n`;
        if (ticketData.claimedBy) {
            try {
                const claimer = await client.users.fetch(ticketData.claimedBy);
                transcript += `   • Claimed By: ${claimer.tag}\n`;
            } catch (err) {
                transcript += `   • Claimed By: Unknown\n`;
            }
        }
        transcript += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        transcript += `💬 Message History:\n\n`;

        try {
            // Fetch all messages in the ticket
            const messages = await channel.messages.fetch({ limit: 100 });
            const sortedMessages = Array.from(messages.values()).reverse();

            for (const message of sortedMessages) {
                const timestamp = message.createdAt.toLocaleString();
                transcript += `[${timestamp}] ${message.author.tag}:\n`;
                if (message.content) {
                    transcript += `   ${message.content}\n`;
                }
                if (message.embeds.length > 0) {
                    transcript += `   [Embed: ${message.embeds[0].title || 'No title'}]\n`;
                }
                if (message.attachments.size > 0) {
                    message.attachments.forEach(att => {
                        transcript += `   [Attachment: ${att.name} - ${att.url}]\n`;
                    });
                }
                transcript += `\n`;
            }

            transcript += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
            transcript += `End of transcript - Total Messages: ${sortedMessages.length}\n`;

        } catch (err) {
            console.error('Error generating transcript:', err);
            transcript += `\n⚠️ Error fetching message history\n`;
        }
        
        // Send transcript to log channel
        const logChannel = channel.guild.channels.cache.get(ticketLogChannelId);
        if (logChannel) {
            const logEmbed = new EmbedBuilder()
                .setColor(0xF04747)
                .setTitle('🔒 Ticket Closed & Archived')
                .setDescription(`━━━━━━━━━━━━━━━━━━━━━`)
                .addFields(
                    { name: '🎫 Ticket Name', value: `\`${channel.name}\``, inline: false },
                    { name: '👤 Ticket Owner', value: `${ticketData.userName || 'Unknown'}\n\`${ticketData.userId || 'N/A'}\``, inline: true },
                    { name: '🔒 Closed By', value: `${user.tag}\n\`${user.id}\``, inline: true },
                    { name: '⚡ Priority', value: `${ticketData.priority === 'high' ? '🔴 High' : ticketData.priority === 'low' ? '🟢 Low' : '🟡 Medium'}`, inline: true },
                    { name: '📝 Close Reason', value: `\`\`\`Closed via ❌ reaction\`\`\``, inline: false },
                    { name: '🕐 Opened', value: ticketData.createdAt ? `<t:${Math.floor(ticketData.createdAt / 1000)}:F>` : 'Unknown', inline: true },
                    { name: '🔒 Closed', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
                    { name: '⏱️ Duration', value: ticketData.createdAt ? `<t:${Math.floor(ticketData.createdAt / 1000)}:R>` : 'Unknown', inline: true }
                )
                .setFooter({ text: '💾 Full transcript attached below' })
                .setTimestamp();

            const transcriptBuffer = Buffer.from(transcript, 'utf-8');
            const attachment = new AttachmentBuilder(transcriptBuffer, { 
                name: `transcript-${channel.name}-${Date.now()}.txt` 
            });

            await logChannel.send({ embeds: [logEmbed], files: [attachment] }).catch(err => {
                console.error('[TicketReaction] Failed to send transcript:', err);
            });

            // Also send to user's DMs if possible
            try {
                const dmChannel = await user.createDM().catch(() => null);
                if (dmChannel) {
                    await dmChannel.send({ embeds: [logEmbed], files: [attachment] }).catch((err) => {
                        console.error(`[TicketReaction] Failed to send ticket log to user DMs: ${err.message}`);
                    });
                }
            } catch (err) {
                console.error(`[TicketReaction] Could not open DM with user: ${err.message}`);
            }
        }
        
        // Update database
        ticketsDB.set(channel.id, {
            ...ticketData,
            status: 'closed',
            closedAt: Date.now(),
            closedBy: user.id,
            closeReason: 'Closed via ❌ reaction'
        });
        
        // Close the ticket
        const closeEmbed = new EmbedBuilder()
            .setColor('#F04747')
            .setTitle('🔒 Ticket Closing')
            .setDescription(`Ticket closed by ${user}\n⏱️ This channel will be deleted in 5 seconds...`)
            .setTimestamp();
        
        await channel.send({ embeds: [closeEmbed] }).catch((err) => {
            console.error(`[TicketReaction] Failed to send close message: ${err.message}`);
        });
        
        // Store channel ID before deletion
        const channelId = channel.id;
        
        setTimeout(async () => {
            await channel.delete().catch((err) => {
                console.error(`[TicketReaction] Failed to delete ticket channel: ${err.message}`);
            });
            // Clean up database after deletion
            ticketsDB.delete(channelId);
        }, 5000);
    }
};