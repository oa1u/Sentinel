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
    .setName('unban')
    .setDescription('Unban a user from the server')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to unban')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(0x8),
  category: 'management',
  async execute(interaction) {
    const Prohibited = new EmbedBuilder()
      .setColor(0xF04747)
      .setTitle(`❌ No Permission`)
      .setDescription(`You need the Administrator role to use this command!`);
    
    if(!interaction.member.roles.cache.has(AdminRole)) {
      return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });
    }
    
    const warnsDB = new JSONDatabase('warns');
    const user = interaction.options.getUser('user');
    
    warnsDB.ensure(user.id, {points: 0, warns: {}});
    await interaction.guild.members.unban(user.id, `unbanned by admin - ${interaction.user.tag}`).catch(err => {
      console.error('Error unbanning user:', err);
    });
    const clearedWarnsLog = interaction.client.channels.cache.get(channelLog);
    const em = new EmbedBuilder()
      .setTitle("🔓 User Unbanned")
      .setColor(0x43B581)
      .addFields(
        { name: "👮 Administrator", value: `${interaction.user.tag} (${interaction.user.id})` },
        { name: "👤 User", value: `${user.tag} (${user.id})` }
      )
      .setFooter({ text: `Unbanned by ${interaction.user.username}` })
      .setTimestamp();
    
    if (clearedWarnsLog) await clearedWarnsLog.send({ embeds: [em] });
    
    const successEmbed = new EmbedBuilder()
      .setColor(0x43B581)
      .setTitle('✅ Successfully Unbanned')
      .setDescription(`**${user.tag}** has been unbanned!`);
    
    return interaction.reply({ embeds: [successEmbed], flags: MessageFlags.Ephemeral });
  }
}