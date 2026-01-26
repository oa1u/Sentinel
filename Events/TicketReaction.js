const { EmbedBuilder } = require('discord.js');
const { ticketCategory } = require("../Config/constants/channel.json");
const { SupportRole } = require("../Config/constants/roles.json");

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
        if (channel.parentId !== ticketCategory) return;
        
        // Check if channel name starts with 'ticket-'
        if (!channel.name.startsWith('ticket-')) return;
        
        // Get the member who reacted
        const member = await channel.guild.members.fetch(user.id).catch(() => null);
        if (!member) return;
        
        // Extract ticket owner from channel name (ticket-username)
        const ticketOwnerName = channel.name.replace('ticket-', '');
        
        // Check if user has permission to close (ticket owner or support role)
        const isTicketOwner = user.username.toLowerCase() === ticketOwnerName.toLowerCase();
        const hasSupport = member.roles.cache.has(SupportRole);
        const isAdmin = member.permissions.has('Administrator');
        
        if (!isTicketOwner && !hasSupport && !isAdmin) {
            // Remove reaction if user doesn't have permission
            await reaction.users.remove(user.id).catch(() => {});
            return;
        }
        
        // Close the ticket
        const closeEmbed = new EmbedBuilder()
            .setColor('#F04747')
            .setTitle('🔒 Ticket Closing')
            .setDescription(`Ticket closed by ${user}\n⏱️ This channel will be deleted in 5 seconds...`)
            .setTimestamp();
        
        await channel.send({ embeds: [closeEmbed] }).catch(console.error);
        
        setTimeout(async () => {
            await channel.delete().catch(console.error);
        }, 5000);
    }
};
