const moment = require("moment");
const DatabaseManager = require('../../Functions/DatabaseManager');
require("moment-duration-format");
const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const { moderatorRoleId } = require("../../Config/constants/roles.json");

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warning')
    .setDescription('Look up details about a warning case')
    .addStringOption(option =>
      option.setName('caseid')
        .setDescription('Case ID')
        .setRequired(true)
    )
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User ID (optional)')
        .setRequired(false)
    ),
  category: 'moderation',
  async execute(interaction) {
    let Prohibited = new EmbedBuilder()
      .setColor(0xFAA61A)
        .setTitle(`Prohibited User`)
        .setDescription(`You have to be a <@&${moderatorRoleId}> to be able to use this command!`);
    
    // Check for ModRole permission
    if(!interaction.member.roles.cache.has(moderatorRoleId)) return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });
    
    let caseidincorrect = new EmbedBuilder()
      .setColor(0xFAA61A)
        .setTitle(`Error`)
        .setDescription(`Invalid case ID`);
    
    const warnsDB = DatabaseManager.getWarnsDB();
    const caseID = interaction.options.getString('caseid');
    const userOption = interaction.options.getUser('user');

    // Try to resolve the warning entry either by the provided user or by scanning all stored users
    let targetUserId = userOption ? userOption.id : null;
    let warningEntry = null;

    if (targetUserId) {
      const userRecord = warnsDB.get(targetUserId);
      warningEntry = userRecord?.warns?.[caseID] || null;
    }

    if (!warningEntry) {
      const allWarns = warnsDB.all();
      for (const [userId, data] of Object.entries(allWarns)) {
        const entry = data?.warns?.[caseID];
        if (entry) {
          targetUserId = userId;
          warningEntry = entry;
          break;
        }
      }
    }

    if (!warningEntry || !targetUserId) return interaction.reply({ embeds: [caseidincorrect], flags: MessageFlags.Ephemeral });

    const targetUser = await interaction.client.users.fetch(targetUserId).catch(() => null);
    const userLabel = targetUser ? `${targetUser.tag} (${targetUserId})` : targetUserId;
    const moderatorLabel = warningEntry.moderator ? `<@${warningEntry.moderator}> (${warningEntry.moderator})` : 'Unknown';
    const totalWarns = Object.keys(warnsDB.get(targetUserId)?.warns || {}).length;

    const em = new EmbedBuilder()
      .setTitle(`Case ${caseID}`)
      .setColor(0xFAA61A)
      .addFields(
        { name: "User", value: userLabel },
        { name: "Reason", value: warningEntry.reason || 'No reason recorded' },
        { name: "Moderator", value: moderatorLabel },
        { name: "Date", value: warningEntry.date || 'No date recorded' },
        { name: "Total warnings for user", value: `${totalWarns}` }
      );
    
    await interaction.reply({ embeds: [em], flags: MessageFlags.Ephemeral });
  }
}