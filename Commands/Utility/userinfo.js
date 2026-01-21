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
      const em = new EmbedBuilder()
        .setAuthor({ name: `${member.displayName}'s information`, iconURL: member.user.displayAvatarURL({ format: 'png', dynamic: true }) })
        .setThumbnail(member.user.displayAvatarURL({ format: 'png', dynamic: true }))
        .addFields(
          { name: "Username", value: member.user.username, inline: true },
          { name: "Tag", value: member.user.tag, inline: true },
          { name: `Created At [${moment(member.user.createdTimestamp).fromNow()}]`, value: moment(member.user.createdTimestamp).format('LLL') },
          { name: `Joined Server At [${moment(member.joinedTimestamp).fromNow()}]`, value: moment(member.joinedTimestamp).format('LLL') }
        );
      if (member.user.presence) {
        em.addFields(
          { name: "Status", value: `${statusMoji[member.user.presence.status]} ${statusName[member.user.presence.status]}`, inline: true },
          { name: "Main Device", value: `${device[Object.keys(member.user.presence.clientStatus)[0]]} ${Object.keys(member.user.presence.clientStatus)[0]}`, inline: true }
        );
        if (member.user.presence.activities[0] && member.user.presence.activities[0].name !== 'Custom Status') {
          em.addFields({ name: "Activity", value: `${member.user.presence.activities[0].type} ${member.user.presence.activities[0].name}` });
        }
      }
      if (interaction.user.id !== member.id) {
        em.setFooter({ text: `Requested by ${interaction.member.displayName}` });
      }
      await interaction.reply({ embeds: [em] });
    } else {
      const targetUser = user;
      const em = new EmbedBuilder()
        .setAuthor({ name: `${targetUser.username}'s information`, iconURL: targetUser.displayAvatarURL({ format: 'png', dynamic: true }) })
        .setThumbnail(targetUser.displayAvatarURL({ format: 'png', dynamic: true }))
        .addFields(
          { name: "Username", value: targetUser.username, inline: true },
          { name: "Tag", value: targetUser.tag, inline: true },
          { name: `Created At [${moment(targetUser.createdTimestamp).fromNow()}]`, value: moment(targetUser.createdTimestamp).format('LLL') }
        )
        .setFooter({ text: `Requested by ${interaction.member.displayName}` });
      await interaction.reply({ embeds: [em] });
    }
  }
}