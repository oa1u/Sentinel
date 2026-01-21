const moment = require("moment");
const JSONDatabase = require('../../Functions/Database');
const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
require("moment-duration-format");
const { AdminRole } = require("../../Config/constants/roles.json");
const { channelLog } = require("../../Config/constants/channel.json")
const { Color } = require("../../Config/constants/misc.json")

const colorInt = parseInt(Color.replace('#', ''), 16);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clearwarns')
    .setDescription('Clear all warnings of a user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to clear warnings from')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(0x8),
  category: 'management',
  async execute(interaction) {
    let Prohibited = new EmbedBuilder()
        .setColor(colorInt)
        .setTitle(`Prohibited User`)
        .setDescription(`You have to be an administrator to use this command!`);
    
    const user = interaction.options.getUser('user');
    
    if(!interaction.member.roles.cache.has(AdminRole)) return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });
    
    const warnsDB = new JSONDatabase('warns');
    
    warnsDB.ensure(user.id, {points: 0, warns: {}});
    const userBanned = warnsDB.get(user.id).points >= 5;
    if (userBanned) {
      await interaction.guild.members.unban(user.id, `${interaction.user.tag} - warnings cleared`).catch(err => {
        console.error('Error unbanning user:', err);
      });
    }
    warnsDB.delete(user.id);
    const clearedWarnsLog = interaction.client.channels.cache.get(channelLog);
    const em = new EmbedBuilder()
      .setTitle("Warnings cleared")
      .setColor(colorInt)
      .addFields(
        { name: "Administrator", value: `${interaction.user.tag} (${interaction.user.id})` },
        { name: "User", value: `${user.tag} (${user.id})` },
        { name: "Unbanned?", value: userBanned ? 'Yes' : 'No' }
      )
      .setFooter({ text: `By: ${interaction.user.tag}` });
    
    await clearedWarnsLog.send({ embeds: [em] });
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(colorInt).setDescription(`I have successfully cleared all warnings on **${user.tag}**!`)], flags: MessageFlags.Ephemeral });
  }
}








