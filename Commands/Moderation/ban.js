const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const moment = require("moment");
require("moment-duration-format");
const { generateCaseId } = require("../../Events/caseId");
const { sendErrorReply, sendSuccessReply, createModerationEmbed } = require("../../Functions/EmbedBuilders");
const { canModerateMember, addCase, sendModerationDM, logModerationAction } = require("../../Functions/ModerationHelper");
const { AppealLink } = require("../../Config/main.json");
const { formatErrorMessage } = require("../../Functions/ErrorFormatter");

// This command bans users, logs the action, sends DM notifications, and tracks bans in the admin panel.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a user from the server')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to ban')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for the ban')
        .setRequired(true)
    ),
  category: 'moderation',
  async execute(interaction) {
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
      }

      const targetUser = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'No reason provided';

      // Double check that someone was actually specified for the ban.
      if (!targetUser) {
        return await sendErrorReply(interaction, 'Invalid User', 'Please specify a valid user to ban');
      }

      // Make sure the person running the command is allowed to ban this user (role hierarchy and all).
      if (!await canModerateMember(interaction, targetUser, 'ban')) {
        return;
      }

      const caseID = generateCaseId('BAN');
      const logEmbed = createModerationEmbed({
        action: '🔨 Ban',
        target: targetUser,
        moderator: interaction.user,
        reason: reason,
        caseId: caseID,
        color: 0xF04747
      });

      // Try to send the user a DM first so they know why they're getting banned.
      const dmEmbed = new EmbedBuilder()
        .setTitle('🔨 Server Ban Notice')
        .setColor(0xF04747)
        .setDescription(`⚠️ You have been permanently removed from **${interaction.guild.name}**.`)
        .addFields(
          { name: 'Ban Status', value: '🛡️ **Permanent**', inline: true },
          { name: 'Effective Date', value: `${moment(Date.now()).format('dddd, D MMMM YYYY [at] HH:mm')}`, inline: true },
          { name: 'Reason for Ban', value: `	${'```'}${reason}${'```'}`, inline: false },
          { name: 'Case ID', value: `${'```'}${caseID}${'```'}`, inline: true },
          { name: 'Moderator', value: `${'```'}${interaction.user.username}${'```'}`, inline: true },
          { name: 'Appeal Process', value: `[Submit Ban Appeal](${AppealLink})`, inline: false }
        )
        .setFooter({ text: `${interaction.guild.name} • Moderation System • ${moment(Date.now()).format('HH:mm')}` })
        .setTimestamp();

      const dmSent = await sendModerationDM(targetUser, dmEmbed);

      await logModerationAction(interaction, logEmbed).catch(err => {
        console.error('[ban] Failed to log action:', err.message);
      });

      // Store the ban case in our database for tracking.
      try {
        addCase(targetUser.id, caseID, {
          moderator: interaction.user.id,
          moderatorTag: interaction.user.username,
          userTag: targetUser.username,
          reason: reason,
          date: moment(Date.now()).format('LL'),
          type: 'BAN'
        });
      } catch (dbErr) {
        console.error('[ban] Failed to save case:', dbErr.message);
      }

      // Actually ban the user now.
      try {
        await interaction.guild.members.ban(targetUser, { reason });
        
        await sendSuccessReply(
          interaction,
          'Member Banned',
          `Banned **${targetUser.tag}**\n` +
          `Case ID: \`${caseID}\`\n` +
          `DM: ${dmSent ? '✅' : '❌'}`
        );
      } catch (err) {
        console.error(`[ban] Couldn't ban ${targetUser.tag}:`, err.message);
        await sendErrorReply(
          interaction,
          'Ban Failed',
          `Couldn't ban **${targetUser.tag}**\n\nError: ${formatErrorMessage(err)}`
        );
      }
    } catch (error) {
      console.error('[ban.js] Unexpected error:', error);
      try {
        await sendErrorReply(interaction, 'Error', 'An unexpected error occurred. Please try again.');
      } catch (err) {
        console.error('[ban.js] Failed to send error message:', err.message);
      }
    }
  }
};