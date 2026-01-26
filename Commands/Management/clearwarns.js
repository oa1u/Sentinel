const moment = require("moment");
const JSONDatabase = require('../../Functions/Database');
const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
require("moment-duration-format");
const { AdminRole } = require("../../Config/constants/roles.json");
const { channelLog } = require("../../Config/constants/channel.json")

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
        .setColor(0xF04747)
        .setTitle(`❌ No Permission`)
        .setDescription(`You need the Administrator role to use this command!`);
    
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
      .setTitle("🧹 Warnings Cleared")
      .setColor(0x43B581)
      .addFields(
        { name: "👮 Administrator", value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
        { name: "👤 User", value: `${user.tag} (${user.id})`, inline: true },
        { name: "🔓 Unbanned?", value: userBanned ? '✅ Yes' : '❌ No', inline: true }
      )
      .setFooter({ text: `Cleared by ${interaction.user.tag}` })
      .setTimestamp();
    
    await clearedWarnsLog.send({ embeds: [em] });
    
    const successEmbed = new EmbedBuilder()
      .setColor(0x43B581)
      .setTitle('✅ Warnings Cleared')
      .setDescription(`All warnings for **${user.tag}** have been removed!`);
    
    return interaction.reply({ embeds: [successEmbed], flags: MessageFlags.Ephemeral });
  }
}
