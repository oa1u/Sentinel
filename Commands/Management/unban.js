const moment = require("moment");
const DatabaseManager = require('../../Functions/DatabaseManager');
const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
require("moment-duration-format");
const { administratorRoleId } = require("../../Config/constants/roles.json");
const { serverLogChannelId } = require("../../Config/constants/channel.json")

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Unban a user by ID or case ID')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to unban')
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName('caseid')
        .setDescription('Case ID of the ban')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(0x8),
  category: 'management',
  async execute(interaction) {
    const Prohibited = new EmbedBuilder()
      .setColor(0xF04747)
      .setTitle(`❌ No Permission`)
      .setDescription(`You need the Administrator role to use this command!`);
    
    if(!interaction.member.roles.cache.has(administratorRoleId)) {
      return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });
    }
    
    const warnsDB = DatabaseManager.getWarnsDB();
    const caseIdOption = interaction.options.getString('caseid');
    const userOption = interaction.options.getUser('user');

    // Resolve target user by case ID if provided, else by user option
    let targetUserId = userOption ? userOption.id : null;
    let resolvedCaseId = caseIdOption || null;
    let banEntry = null;

    if (caseIdOption) {
      const allWarns = warnsDB.all();
      for (const [userId, data] of Object.entries(allWarns)) {
        const entry = data?.warns?.[caseIdOption];
        if (entry && entry.reason && entry.reason.toLowerCase().includes('(banned)')) {
          targetUserId = userId;
          banEntry = entry;
          break;
        }
      }
      if (!targetUserId || !banEntry) {
        const notFound = new EmbedBuilder()
          .setColor(0xF04747)
          .setTitle('❌ Invalid Case')
          .setDescription('No ban found for that case ID.');
        return interaction.reply({ embeds: [notFound], flags: MessageFlags.Ephemeral });
      }
    }

    if (!targetUserId) {
      const needParam = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Missing Input')
        .setDescription('Provide a user or case ID.');
      return interaction.reply({ embeds: [needParam], flags: MessageFlags.Ephemeral });
    }

    const targetUser = await interaction.client.users.fetch(targetUserId).catch(() => null);
    const targetLabel = targetUser ? `${targetUser.tag} (${targetUser.id})` : targetUserId;

    const unbanReason = `unbanned by admin - ${interaction.user.tag}${resolvedCaseId ? ` - case ${resolvedCaseId}` : ''}`;

    await interaction.guild.members.unban(targetUserId, unbanReason).catch(err => {
      console.error('Error unbanning user:', err);
    });
    const clearedWarnsLog = interaction.client.channels.cache.get(serverLogChannelId);
    const em = new EmbedBuilder()
      .setTitle("🔓 User Unbanned")
      .setColor(0x43B581)
      .addFields(
        { name: "👮 Administrator", value: `${interaction.user.tag} (${interaction.user.id})` },
        { name: "👤 User", value: targetLabel },
        { name: "🔑 Case ID", value: resolvedCaseId ? `\`${resolvedCaseId}\`` : 'N/A' }
      )
      .setFooter({ text: `Unbanned by ${interaction.user.username}` })
      .setTimestamp();
    
    if (clearedWarnsLog) await clearedWarnsLog.send({ embeds: [em] });
    
    const successEmbed = new EmbedBuilder()
      .setColor(0x43B581)
      .setTitle('✅ Successfully Unbanned')
      .setDescription(`**${targetLabel}** has been unbanned!`)
      .addFields({ name: "🔑 Case ID", value: resolvedCaseId ? `\`${resolvedCaseId}\`` : 'N/A' });
    
    return interaction.reply({ embeds: [successEmbed], flags: MessageFlags.Ephemeral });
  }
}