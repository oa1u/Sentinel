const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const moment = require("moment");
require("moment-duration-format");
const { generateCaseId } = require("../../Events/caseId");
const { sendErrorReply, sendSuccessReply, sendWarningReply, createModerationEmbed, createModerationDmEmbed } = require("../../Functions/EmbedBuilders");
const { canModerateMember, addCase, sendModerationDM, logModerationAction } = require("../../Functions/ModerationHelper");
const { AppealLink } = require("../../Config/main.json");
const { formatErrorMessage } = require("../../Functions/ErrorFormatter");

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
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
      }

      const targetUser = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'No reason provided';

      if (!targetUser) {
        return await sendWarningReply(interaction, 'Invalid User', 'Please specify a valid user to ban');
      }

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

      const dmEmbed = createModerationDmEmbed({
        actionTitle: 'Server Ban Notice',
        actionEmoji: '🔨',
        color: 0xF04747,
        guildName: interaction.guild.name,
        description: `⚠️ You have been permanently removed from **${interaction.guild.name}**.`,
        statusLabel: 'Ban Status',
        statusValue: '🛡️ **Permanent**',
        effectiveDate: moment(Date.now()).format('dddd, D MMMM YYYY [at] HH:mm'),
        reason: reason,
        caseId: caseID,
        moderatorName: interaction.user.username,
        appealLink: AppealLink
      });

      const dmSent = await sendModerationDM(targetUser, dmEmbed);

      await logModerationAction(interaction, logEmbed).catch(err => {
        console.error('[ban] Failed to log action:', err.message);
      });

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

      try {
        await interaction.guild.members.ban(targetUser, { reason });

        await sendSuccessReply(
          interaction,
          'Member Banned',
          `Banned **${targetUser.tag}**\n` +
          `Case ID: \`${caseID}\`\n` +
          `DM: ${dmSent ? '✅' : '❌'}`
        );

        await interaction.followUp({
          content:
            `🧾 **Incident proof reminder**\n` +
            `Use this (ephemeral) command to attach evidence for this action:\n` +
            `\`/incident create caseid:${caseID} user:@${targetUser.username} action:BAN reason:<reason> proof:<proof details>\``,
          flags: MessageFlags.Ephemeral
        }).catch(() => { });
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