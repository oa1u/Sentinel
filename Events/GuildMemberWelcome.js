const { EmbedBuilder } = require('discord.js');

module.exports = {
  name: 'guildMemberAdd',
  async execute(member) {
    try {
      const { welcomeChannelId } = require('../Config/constants/channel.json');
      
      // Skip if welcome channel not configured
      if (!welcomeChannelId || welcomeChannelId === '') {
        console.warn('[Welcome] Welcome channel not configured');
        return;
      }
      
      const channel = member.guild.channels.cache.get(welcomeChannelId);
      if (!channel) {
        console.warn(`[Welcome] Welcome channel ${welcomeChannelId} not found`);
        return;
      }
      
      // Create welcome embed
      const welcomeEmbed = new EmbedBuilder()
        .setColor(0x43B581)
        .setTitle('👋 Welcome to the Server!')
        .setDescription(`Welcome ${member}, we're happy to have you here!`)
        .addFields(
          { name: '👤 Member Name', value: `${member.user.tag}`, inline: true },
          { name: '🆔 User ID', value: `${member.id}`, inline: true },
          { name: '📅 Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
          { name: '👥 Total Members', value: `${member.guild.memberCount}`, inline: true }
        )
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
        .setFooter({ text: `User joined • ID: ${member.id}` })
        .setTimestamp();
      
      await channel.send({ embeds: [welcomeEmbed] }).catch((err) => {
        console.error(`[Welcome] Failed to send welcome message: ${err.message}`);
      });
      
      console.log(`[Welcome] Welcome message sent for ${member.user.tag}`);
    } catch (error) {
      console.error(`[Welcome] Error in welcome handler: ${error.message}`);
    }
  }
};
