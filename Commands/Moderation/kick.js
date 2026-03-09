const moment = require("moment");
require("moment-duration-format");
const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const { generateCaseId } = require("../../Events/caseId");
const { sendErrorReply, sendSuccessReply, sendWarningReply, createModerationEmbed, createModerationDmEmbed } = require("../../Functions/EmbedBuilders");
const { canModerateMember, addCase, sendModerationDM, logModerationAction } = require("../../Functions/ModerationHelper");
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');
const AdminPanelHelper = require("../../Functions/AdminPanelHelper");

// Kicks a user from the server (they can come back with an invite)
module.exports = {
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a user from the server')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to kick')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for the kick')
        .setRequired(true)
    ),
  category: 'moderation',
  async execute(interaction) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
    }

    const targetUser = interaction.options.getUser('user');
    const reasonInput = interaction.options.getString('reason');

    // See if the reason is a preset or something custom
    const reason = DatabaseManager.getResolvedReason(reasonInput);

    if (!await canModerateMember(interaction, targetUser, 'kick')) {
      return;
    }

    // Make sure the user is still in the server
    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) {
      await sendWarningReply(
        interaction,
        'Invalid User',
        `**${targetUser.tag}** is not in this server!`
      );
      return;
    }

    // Make a new case ID for this kick
    const caseID = generateCaseId('KICK');

    // Put together the log message for this action
    const logEmbed = createModerationEmbed({
      action: '👢 Kick',
      target: targetUser,
      moderator: interaction.user,
      reason: reason,
      caseId: caseID,
      color: 0xFAA61A
    });

    // DM the user
    const dmEmbed = createModerationDmEmbed({
      actionTitle: 'Server Kick Notice',
      actionEmoji: '👢',
      color: 0xFAA61A,
      guildName: interaction.guild.name,
      description: `You have been removed from **${interaction.guild.name}**`,
      statusLabel: 'Action Type',
      statusValue: '**Kick**',
      effectiveDate: moment(Date.now()).format('dddd, D MMMM YYYY [at] HH:mm'),
      reason: reason,
      caseId: caseID,
      moderatorName: interaction.user.username
    });

    const dmSent = await sendModerationDM(targetUser, dmEmbed);

    // Log it in the mod log channel
    await logModerationAction(interaction, logEmbed);

    // Save to database for tracking
    addCase(targetUser.id, caseID, {
      moderator: interaction.user.id,
      moderatorTag: interaction.user.username,
      userTag: targetUser.username,
      reason: `(kicked) - ${reason}`,
      date: moment(Date.now()).format('LL'),
      type: 'KICK'
    });

    // Actually kick them now
    try {
      await targetMember.kick(reason);

      // Save kick to kicks table
      await AdminPanelHelper.addKick({
        userId: targetUser.id,
        caseId: caseID,
        username: targetUser.username,
        reason: reason,
        kickedBy: interaction.user.id,
        kickedByName: interaction.user.username,
        kickedBySource: 'discord',
        kickedAt: Date.now()
      });

      // Send success response
      await sendSuccessReply(
        interaction,
        'Member Kicked',
        `Successfully kicked **${targetUser.tag}**\n` +
        `Case ID: \`${caseID}\`\n` +
        `DM Sent: ${dmSent ? '✅' : '❌'}`
      );

      await interaction.followUp({
        content:
          `🧾 **Incident proof reminder**\n` +
          `Use this (ephemeral) command to attach evidence for this action:\n` +
          `\`/incident create caseid:${caseID} user:@${targetUser.username} action:KICK reason:<reason> proof:<proof details>\``,
        flags: MessageFlags.Ephemeral
      }).catch(() => { });
    } catch (err) {
      console.error(`Error kicking ${targetUser.tag}:`, err.message);
      await sendErrorReply(
        interaction,
        'Kick Failed',
        `Could not kick **${targetUser.tag}**\nError: ${err.message}`
      );
    }
  }
};