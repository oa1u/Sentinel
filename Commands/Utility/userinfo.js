const moment = require("moment");
const JSONDatabase = require('../../Functions/Database');
const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
require("moment-duration-format");

module.exports = {
  data: new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Get information about a user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to get info about')
        .setRequired(false)
    ),
  category: 'utility',
  async execute(interaction) {
    const user = interaction.options.getUser('user') || interaction.user;
    const statusMoji = {
      dnd: '<:dnd:817030828290867231>',
      offline: '<:offline:817030793142337536>',
      online: '<:online:817030844584951879>',
      idle: '<:idle:817030811853389926>'
    }
    const statusName = {
      dnd: 'Do not Disturb',
      offline: 'Offline',
      online: 'Online',
      idle: 'Idle'
    }
    const device = {
      mobile: '<:mobile:817032273463476224>',
      browser: '<:browser:817032290731032597>',
      desktop: '<:desktopicon:817032252390899752>'
    }
    
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    
    if (member) {
      // Calculate account age
      const accountAge = moment.duration(Date.now() - member.user.createdTimestamp).format('Y [years], M [months], D [days]');
      const serverAge = moment.duration(Date.now() - member.joinedTimestamp).format('Y [years], M [months], D [days]');
      
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
      
      const em = new EmbedBuilder()
        .setAuthor({ name: `${member.displayName}'s information`, iconURL: member.user.displayAvatarURL() })
        .setThumbnail(member.user.displayAvatarURL())
        .setColor(member.displayHexColor !== '#000000' ? parseInt(member.displayHexColor.replace('#', ''), 16) : 0x5865F2)
        .addFields(
          { name: "Username", value: member.user.username, inline: true },
          { name: "Display Name", value: member.displayName, inline: true },
          { name: "ID", value: member.user.id, inline: true },
          { name: "Bot", value: member.user.bot ? 'Yes' : 'No', inline: true },
          { name: "Nickname", value: member.nickname || 'None', inline: true },
          { name: "Highest Role", value: member.roles.highest.toString(), inline: true },
          { name: `Account Created [${moment(member.user.createdTimestamp).fromNow()}]`, value: `${moment(member.user.createdTimestamp).format('LLL')}\n*${accountAge}*` },
          { name: `Joined Server [${moment(member.joinedTimestamp).fromNow()}]`, value: `${moment(member.joinedTimestamp).format('LLL')}\n*${serverAge}*` },
          { name: `Roles [${roles.length}]`, value: rolesDisplay },
          { name: "Key Permissions", value: permissionsDisplay }
        );
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
          em.addFields({ name: "Activity", value: `${member.presence.activities[0].type} ${member.presence.activities[0].name}` });
        }
      }
      if (interaction.user.id !== member.id) {
        em.setFooter({ text: `Requested by ${interaction.user.username}` });
      }
      await interaction.reply({ embeds: [em] });
    } else {
      const targetUser = user;
      const em = new EmbedBuilder()
        .setAuthor({ name: `${targetUser.username}'s information`, iconURL: targetUser.displayAvatarURL() })
        .setThumbnail(targetUser.displayAvatarURL())
        .addFields(
          { name: "Username", value: targetUser.username, inline: true },
          { name: "ID", value: targetUser.id, inline: true },
          { name: `Created At [${moment(targetUser.createdTimestamp).fromNow()}]`, value: moment(targetUser.createdTimestamp).format('LLL') }
        )
        .setFooter({ text: `Requested by ${interaction.member.displayName}` });
      await interaction.reply({ embeds: [em] });
    }
  }
}