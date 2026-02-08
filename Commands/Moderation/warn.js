const moment = require("moment");
require("moment-duration-format");
const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const { generateCaseId } = require("../../Events/caseId");
const { sendErrorReply, sendSuccessReply, createModerationEmbed } = require("../../Functions/EmbedBuilders");
const { canModerateMember, addCase, sendModerationDM, logModerationAction } = require("../../Functions/ModerationHelper");
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');

// Warns a user and keeps track in the database
// Too many warnings can trigger auto-punishments
module.exports = {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Warn a user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to warn')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for the warning')
        .setRequired(true)
    ),
  category: 'moderation',
  async execute(interaction) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    }

    const targetUser = interaction.options.getUser('user');
    const reasonInput = interaction.options.getString('reason');
    const caseIdInput = interaction.options.getString('caseid');

    // If caseid is provided, fetch warning details
    if (caseIdInput) {
      const warnsDB = DatabaseManager.getWarnsDB();
      let foundUserId = targetUser ? targetUser.id : interaction.user.id;
      const userData = await warnsDB.get(foundUserId);
      const warn = userData?.warns?.[caseIdInput];
      if (!warn) {
        await sendErrorReply(
          interaction,
          'Case Not Found',
          `No warning found for Case ID: \`${caseIdInput}\``
        );
        return;
      }
      // Fetch moderator info
      let moderatorTag = warn.moderatorId ? (await interaction.client.users.fetch(warn.moderatorId).catch(() => null))?.tag || warn.moderatorId : 'Unknown';
      let issuedAt = warn.timestamp ? `<t:${Math.floor(warn.timestamp / 1000)}:F>` : 'Unknown';
      const embed = new EmbedBuilder()
        .setTitle('⚠️ Warning Details')
        .setColor(0xFAA61A)
        .setDescription(`Case ID: \`${caseIdInput}\``)
        .addFields(
          { name: 'Reason', value: `\`\`\`${warn.reason}\`\`\``, inline: false },
          { name: 'Moderator', value: `\`${moderatorTag}\``, inline: true },
          { name: 'Issued At', value: issuedAt, inline: true }
        )
        .setFooter({ text: `${interaction.guild.name} • Moderation System` })
        .setTimestamp();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
  }
};