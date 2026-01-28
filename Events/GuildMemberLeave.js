const { EmbedBuilder } = require('discord.js');

module.exports = {
  name: 'guildMemberRemove',
  async execute(member) {
    try {
      const { leaveChannelId } = require('../Config/constants/channel.json');
      
      // Skip if leave channel not configured
      if (!leaveChannelId || leaveChannelId === '') {
        console.warn('[Leave] Channel not configured');
        return;
      }
      
      const channel = member.guild.channels.cache.get(leaveChannelId);
      if (!channel) {
        console.warn(`[Leave] Channel ${leaveChannelId} not found`);
        return;
      }
      
      // Calculate member age
      const joinedTimestamp = member.joinedTimestamp;
      const memberAge = Date.now() - joinedTimestamp;
      const days = Math.floor(memberAge / (1000 * 60 * 60 * 24));
      const hours = Math.floor((memberAge % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      
      let ageString = '';
      if (days > 0) ageString += `${days}d `;
      ageString += `${hours}h`;
      
      // Create leave embed
      const leaveEmbed = new EmbedBuilder()
        .setColor(0xFF6B6B)
        .setTitle('👋 Member Left')
        .setDescription(`${member.user.tag} left the server.`)
        .addFields(
          { name: '👤 Member Name', value: `${member.user.tag}`, inline: true },
          { name: '🆔 User ID', value: `${member.id}`, inline: true },
          { name: '⏱️ Time in Server', value: ageString, inline: true },
          { name: '📅 Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
          { name: '👥 Members Remaining', value: `${member.guild.memberCount}`, inline: true }
        )
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
        .setFooter({ text: `User left • ID: ${member.id}` })
        .setTimestamp();
      
      // Add roles if member had any (excluding @everyone)
      if (member.roles.cache.size > 1) {
        const roleList = member.roles.cache
          .filter(role => !role.isEveryone)
          .map(role => `<@&${role.id}>`)
          .join(', ');
        
        if (roleList) {
          leaveEmbed.addFields({
            name: '🏷️ Roles',
            value: roleList,
            inline: false
          });
        }
      }
      
      await channel.send({ embeds: [leaveEmbed] }).catch((err) => {
        console.error(`[Leave] Couldn't send message: ${err.message}`);
      });
      
      console.log(`[Leave] Message sent for ${member.user.tag}`);
    } catch (error) {
      console.error(`[Leave] Error: ${error.message}`);
    }
  }
};