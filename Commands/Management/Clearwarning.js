const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const DatabaseManager = require('../../Functions/DatabaseManager');
const { administratorRoleId } = require("../../Config/constants/roles.json");
const { serverLogChannelId } = require("../../Config/constants/channel.json");

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clearwarn')
    .setDescription('Remove a specific warning from a user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to clear warning from')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('caseid')
        .setDescription('Case ID to clear')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(0x8),
  category: 'management',
  async execute(interaction) {
    const Prohibited = new EmbedBuilder()
      .setColor(0xF04747)
      .setTitle(`❌ No Permission`)
      .setDescription(`You need the Administrator role to use this command!`);
    
    if (!interaction.member.roles.cache.has(administratorRoleId)) {
      return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });
    }
    
    const user = interaction.options.getUser('user');
    const caseID = interaction.options.getString('caseid');
    const warnsDB = DatabaseManager.getWarnsDB();
    warnsDB.ensure(user.id, {points: 0, warns: {}});
    
    if (!warnsDB.get(user.id).warns[caseID]) {
      const notFoundEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Case Not Found')
        .setDescription(`No warning found with case ID: \`${caseID}\``);
      return interaction.reply({
        embeds: [notFoundEmbed],
        flags: MessageFlags.Ephemeral
      });
    }
    const caseReason = warnsDB.get(user.id).warns[caseID].reason;
    warnsDB.delete(user.id, `warns.${caseID}`);
    
    const clearedWarnsLog = interaction.client.channels.cache.get(serverLogChannelId);
    const em = new EmbedBuilder()
      .setTitle("🗑️ Warning Cleared")
      .setColor(0x43B581)
      .addFields(
        { name: "👮 Administrator", value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
        { name: "👤 User", value: `${user.tag} (${user.id})`, inline: true },
        { name: "🔑 Case ID", value: `\`${caseID}\``, inline: true },
        { name: "📝 Reason", value: `\`${caseReason}\`` }
      )
      .setFooter({ text: `Cleared by ${interaction.user.tag}` })
      .setTimestamp();
    
    if (clearedWarnsLog) await clearedWarnsLog.send({ embeds: [em] });
    
    const successEmbed = new EmbedBuilder()
      .setColor(0x43B581)
      .setTitle('✅ Warning Cleared')
      .setDescription(`Warning **\`${caseID}\`** has been removed from **${user.tag}**!`);
    
    return interaction.reply({
      embeds: [successEmbed],
      flags: MessageFlags.Ephemeral
    });
  }
}