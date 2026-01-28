const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const moment = require("moment");
require("moment-duration-format");
const { generateCaseId } = require("../../Events/caseId");
const { sendErrorReply, sendSuccessReply, createModerationEmbed } = require("../../Functions/EmbedBuilders");
const { canModerateMember, addCase, sendModerationDM, logModerationAction } = require("../../Functions/ModerationHelper");
const { AppealLink } = require("../../Config/main.json");

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
        .setRequired(false)
    ),
  category: 'moderation',
  async execute(interaction) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
      }

    const targetUser = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';

    // Check permissions
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

    // DM the user
    const dmEmbed = new EmbedBuilder()
      .setTitle('🔨 You\'ve Been Banned')
      .setColor(0xF04747)
      .setDescription(`You were banned from **${interaction.guild.name}**`)
      .addFields(
        { name: '📝 Reason', value: reason, inline: false },
        { name: '🔑 Case ID', value: `\`${caseID}\``, inline: true },
        { name: '📬 Ban Appeal', value: `[How to Appeal](${AppealLink})`, inline: true }
      )
      .setTimestamp();

    const dmSent = await sendModerationDM(targetUser, dmEmbed);

    await logModerationAction(interaction, logEmbed);

    // Save to database
    addCase(targetUser.id, caseID, {
      moderator: interaction.user.id,
      reason: `(banned) - ${reason}`,
      date: moment(Date.now()).format('LL'),
      type: 'BAN'
    });

    // Do the ban
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
      console.error(`Couldn't ban ${targetUser.tag}:`, err.message);
      await sendErrorReply(
        interaction,
        'Ban Failed',
        `Couldn't ban **${targetUser.tag}**\nError: ${err.message}`
      );
    }
  }
};