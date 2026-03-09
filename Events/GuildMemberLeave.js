const { EmbedBuilder } = require('discord.js');
const MySQLDatabaseManager = require('../Functions/MySQLDatabaseManager');
const { CHANNELS: { leaveChannelId } } = require('../Config/constants');
const AntiRaid = require('../Functions/AntiRaid');

// When someone leaves the server, log the event and send a polite goodbye message (if configured).
// We persist the leave event so admins can review member activity later.
module.exports = {
  name: 'guildMemberRemove',
  async execute(member) {
    try {
      await AntiRaid.handleMemberLeave(member).catch(() => { });
      // Log that this member left the server, so we can track activity.
      await MySQLDatabaseManager.logMemberActivity(
        member.id,
        member.user.tag,
        'leave',
        member.guild.id
      );

      // If no leave channel is configured, warn and skip sending a message.
      if (!leaveChannelId || leaveChannelId === '') {
        console.warn('[Leave] Channel not configured');
        return;
      }

      const channel = member.guild.channels.cache.get(leaveChannelId);
      if (!channel) {
        console.warn(`[Leave] Channel ${leaveChannelId} not found`);
        return;
      }

      // Calculate how long the member was in the server for context in the goodbye embed.
      const joinedTimestamp = member.joinedTimestamp;
      const memberAge = Date.now() - joinedTimestamp;
      const days = Math.floor(memberAge / (1000 * 60 * 60 * 24));
      const hours = Math.floor((memberAge % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

      let ageString = '';
      if (days > 0) ageString += `${days}d `;
      ageString += `${hours}h`;

      // Construct a friendly embed to announce the member's departure.
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

      // If the member had roles (excluding @everyone), include them in the embed for context.
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

    } catch (error) {
      console.error(`[Leave] Error: ${error.message}`);
    }
  }
};