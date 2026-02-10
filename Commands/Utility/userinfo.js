const moment = require("moment");
const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
require("moment-duration-format");
const MySQLDatabaseManager = require('../../Functions/MySQLDatabaseManager');

// Displays detailed user information
// Includes roles, join date, account age, etc.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Get info about a user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to get info about')
        .setRequired(false)
    ),
  category: 'utility',
  async execute(interaction) {
    const user = interaction.options.getUser('user') || interaction.user;
    const statusMoji = {
      dnd: '🔴',
      offline: '⚫',
      online: '🟢',
      idle: '🟡'
    }
    const statusName = {
      dnd: 'Do not Disturb',
      offline: 'Offline',
      online: 'Online',
      idle: 'Idle'
    }
    const device = {
      mobile: '📱',
      browser: '🌐',
      desktop: '💻'
    }
    
    const activityType = {
      0: 'Playing',
      1: 'Streaming',
      2: 'Listening to',
      3: 'Watching',
      5: 'Competing in'
    }
    
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    // Example: Fetch custom user data from database
    let customUserData = null;
    try {
      // Replace 'users' and 'userId' with your actual table/column names
      const [results] = await MySQLDatabaseManager.connection.pool.query('SELECT * FROM userinfo WHERE user_id = ?', [user.id]);
      customUserData = results[0] || null;
    } catch (err) {
      console.error('Database error in userinfo:', err);
    }
    
    if (member) {
      const accountAge = moment.duration(Date.now() - member.user.createdTimestamp).format('Y [years], M [months], D [days]');
      const serverAge = moment.duration(Date.now() - member.joinedTimestamp).format('Y [years], M [months], D [days]');
      
      const flags = member.user.flags ? member.user.flags.toArray() : [];
      const badgeEmojis = {
        Staff: '👮',
        Partner: '🤝',
        Hypesquad: '🎉',
        HypeSquadOnlineHouse1: '🟣',
        HypeSquadOnlineHouse2: '🔴',
        HypeSquadOnlineHouse3: '🟢',
        BugHunterLevel1: '🐛',
        BugHunterLevel2: '🐛',
        PremiumEarlySupporter: '⭐',
        VerifiedDeveloper: '✅',
        CertifiedModerator: '🛡️',
        ActiveDeveloper: '⚡'
      };
      const userBadges = flags.map(flag => badgeEmojis[flag] || flag).join(' ');
      
      // Get voice state
      const voiceChannel = member.voice.channel;
      const voiceState = voiceChannel ? `${voiceChannel.toString()} ${member.voice.serverMute ? '🔇' : ''}${member.voice.serverDeaf ? '🔈' : ''}${member.voice.selfMute ? '🎤' : ''}${member.voice.selfDeaf ? '🔊' : ''}${member.voice.streaming ? '📹' : ''}` : 'Not in voice';
      
      // Get roles (excluding @everyone)
      const roles = member.roles.cache
        .filter(role => role.id !== interaction.guild.id)
        .sort((a, b) => b.position - a.position)
        .map(role => role.toString())
        .slice(0, 20);
      const rolesDisplay = roles.length > 0 ? roles.join(', ') : 'None';
      
      // Get permissions
      const keyPermissions = [];
      if (member.permissions.has('Administrator')) keyPermissions.push('Administrator');
      if (member.permissions.has('ManageGuild')) keyPermissions.push('Manage Server');
      if (member.permissions.has('ManageRoles')) keyPermissions.push('Manage Roles');
      if (member.permissions.has('ManageChannels')) keyPermissions.push('Manage Channels');
      if (member.permissions.has('KickMembers')) keyPermissions.push('Kick Members');
      if (member.permissions.has('BanMembers')) keyPermissions.push('Ban Members');
      if (member.permissions.has('ModerateMembers')) keyPermissions.push('Timeout Members');
      const permissionsDisplay = keyPermissions.length > 0 ? keyPermissions.join(', ') : 'None';
      
      // Check if user is timed out
      const isTimedOut = member.communicationDisabledUntil && member.communicationDisabledUntil > Date.now();
      const timeoutEnds = isTimedOut ? moment(member.communicationDisabledUntil).fromNow() : null;
      
      // Check for server boost
      const isBoosting = member.premiumSince !== null;
      const boostingSince = isBoosting ? moment(member.premiumSince).format('LLL') : null;
      const boostDuration = isBoosting ? moment.duration(Date.now() - member.premiumSince).format('Y [years], M [months], D [days]') : null;
      
      const em = new EmbedBuilder()
        .setAuthor({ name: `${member.displayName}'s Profile`, iconURL: member.user.displayAvatarURL() })
        .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
        .setColor(member.displayHexColor !== '#000000' ? parseInt(member.displayHexColor.replace('#', ''), 16) : 0x5865F2)
        .addFields(
          { name: "👤 Username", value: member.user.username, inline: true },
          { name: "📝 Display Name", value: member.displayName, inline: true },
          { name: "🆔 ID", value: `\`${member.user.id}\``, inline: true },
          { name: "🤖 Bot", value: member.user.bot ? '✅ Yes' : '❌ No', inline: true },
          { name: "🏷️ Nickname", value: member.nickname || 'None', inline: true },
          { name: "🎭 Highest Role", value: member.roles.highest.toString(), inline: true },
          { name: `⏰ Account Created`, value: `${moment(member.user.createdTimestamp).format('LLL')}\n*${moment(member.user.createdTimestamp).fromNow()}*\n**${accountAge}**` },
          { name: `📍 Joined Server`, value: `${moment(member.joinedTimestamp).format('LLL')}\n*${moment(member.joinedTimestamp).fromNow()}*\n**${serverAge}**` },
          { name: `🎪 Roles [${roles.length}]`, value: rolesDisplay || '`None`' },
          { name: "⚔️ Key Permissions", value: permissionsDisplay || '`None`' }
        );
      
      // Add badges if present
      if (userBadges) {
        em.addFields({ name: "🏆 Badges", value: userBadges || 'None', inline: false });
      }
      
      // Add boost info if boosting
      if (isBoosting) {
        em.addFields({ name: "💎 Server Booster", value: `Boosting since: **${boostingSince}**\n⏱️ Duration: *${boostDuration}*`, inline: false });
      }
      
      // Add timeout info if timed out
      if (isTimedOut) {
        em.addFields({ name: "⏱️ Timeout Status", value: `🚫 Timed out\n⌛ Ends ${timeoutEnds}`, inline: true });
      }
      
      // Add voice state
      em.addFields({ name: "🎤 Voice Channel", value: voiceState, inline: false });
      if (member.presence) {
        em.addFields(
          { name: "Status", value: `${statusMoji[member.presence.status]} ${statusName[member.presence.status]}`, inline: true }
        );
        if (member.presence.clientStatus && Object.keys(member.presence.clientStatus).length > 0) {
          em.addFields(
            { name: "Main Device", value: `${device[Object.keys(member.presence.clientStatus)[0]]} ${Object.keys(member.presence.clientStatus)[0]}`, inline: true }
          );
        }
        if (member.presence.activities && member.presence.activities[0] && member.presence.activities[0].name !== 'Custom Status') {
          const activity = member.presence.activities[0];
          const activityText = activityType[activity.type] || 'Playing';
          em.addFields({ name: "🎮 Activity", value: `**${activityText}** ${activity.name}`, inline: true });
        } else if (!member.presence.activities || member.presence.activities.length === 0) {
          em.addFields({ name: "🎮 Activity", value: '`No status`', inline: true });
        }
      }
      
      // Add banner if available
      const fetchedUser = await member.user.fetch();
      if (fetchedUser.banner) {
        em.setImage(fetchedUser.bannerURL({ size: 512 }));
      }
      
      if (interaction.user.id !== member.id) {
        em.setFooter({ text: `📊 Requested by ${interaction.user.username}` });
      }
      await interaction.reply({ embeds: [em] });
    } else {
      const targetUser = user;
      const em = new EmbedBuilder()
        .setAuthor({ name: `${targetUser.username}'s Profile`, iconURL: targetUser.displayAvatarURL() })
        .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
        .setColor(0x5865F2)
        .addFields(
          { name: "👤 Username", value: targetUser.username, inline: true },
          { name: "🆔 ID", value: `\`${targetUser.id}\``, inline: true },
          { name: "⏰ Account Created", value: `${moment(targetUser.createdTimestamp).format('LLL')}\n*${moment(targetUser.createdTimestamp).fromNow()}*` }
        )
        .setFooter({ text: `📊 Requested by ${interaction.member.displayName}` });
      await interaction.reply({ embeds: [em] });
    }
  }
}