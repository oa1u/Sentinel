const DatabaseManager = require('../../Functions/MySQLDatabaseManager');
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

    // Try to find the warning by user or by searching all users
    let targetUserId = userOption ? userOption.id : null;
    let warningEntry = null;

    if (targetUserId) {
      const userRecord = await warnsDB.get(targetUserId);
      warningEntry = userRecord?.warns?.[caseID] || null;
    }

    if (!warningEntry) {
      const allWarns = await warnsDB.all();
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
    // Try new format first
    let moderatorLabel = 'Unknown';
    if (warningEntry.moderatorId) {
      const modUser = await interaction.client.users.fetch(warningEntry.moderatorId).catch(() => null);
      moderatorLabel = modUser ? `${modUser.tag} (${modUser.id})` : warningEntry.moderatorId;
    } else if (warningEntry.moderator) {
      const modUser = await interaction.client.users.fetch(warningEntry.moderator).catch(() => null);
      moderatorLabel = modUser ? `${modUser.tag} (${modUser.id})` : warningEntry.moderator;
    }
    // Date: prefer timestamp, fallback to date
    let dateLabel = warningEntry.timestamp ? `<t:${Math.floor(warningEntry.timestamp / 1000)}:F>` : (warningEntry.date || 'No date recorded');
    const userData = await warnsDB.get(targetUserId);
    const totalWarns = Object.keys(userData?.warns || {}).length;

    const em = new EmbedBuilder()
      .setTitle(`Case ${caseID}`)
      .setColor(0xFAA61A)
      .addFields(
        { name: "User", value: userLabel },
        { name: "Reason", value: warningEntry.reason || 'No reason recorded' },
        { name: "Moderator", value: moderatorLabel },
        { name: "Date", value: dateLabel },
        { name: "Total warnings for user", value: `${totalWarns}` }
      );
    
    await interaction.reply({ embeds: [em], flags: MessageFlags.Ephemeral });
  }
}