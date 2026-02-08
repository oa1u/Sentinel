const moment = require("moment");
require("moment-duration-format");
const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const { generateCaseId } = require("../../Events/caseId");
const { sendErrorReply, sendSuccessReply, createModerationEmbed } = require("../../Functions/EmbedBuilders");
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
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
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
      await sendErrorReply(
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
    const dmEmbed = new EmbedBuilder()
      .setTitle('👢 Server Kick Notice')
      .setColor(0xFAA61A)
      .setDescription(`You have been removed from **${interaction.guild.name}**`)
      .addFields(
        { name: 'Action Type', value: '**Kick**', inline: true },
        { name: 'Effective Date', value: `${moment(Date.now()).format('dddd, D MMMM YYYY [at] HH:mm')}`, inline: true },
        { name: 'Reason for Kick', value: `	${'```'}${reason}${'```'}`, inline: false },
        { name: 'Case ID', value: `${'```'}${caseID}${'```'}`, inline: true },
        { name: 'Moderator', value: `${'```'}${interaction.user.username}${'```'}`, inline: true },
      )
      .setFooter({ text: `${interaction.guild.name} • Moderation System` })
      .setTimestamp();

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