const moment = require("moment");
require("moment-duration-format");
const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const { generateCaseId } = require("../../Events/caseId");
const { sendErrorReply, sendSuccessReply, createModerationEmbed } = require("../../Functions/EmbedBuilders");
const { canModerateMember, addCase, sendModerationDM, logModerationAction } = require("../../Functions/ModerationHelper");
const DatabaseManager = require('../../Functions/DatabaseManager');

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
    
    const reason = DatabaseManager.getResolvedReason(reasonInput);

    if (!await canModerateMember(interaction, targetUser, 'warn')) {
      return;
    }

    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) {
      await sendErrorReply(
        interaction,
        'Invalid User',
        `**${targetUser.tag}** is not in this server!`
      );
      return;
    }

    // Generate case ID
    const caseID = generateCaseId('WARN');

    // Create logging embed
    const logEmbed = createModerationEmbed({
      action: '⚠️ Warn',
      target: targetUser,
      moderator: interaction.user,
      reason: reason,
      caseId: caseID,
      color: 0xFAA61A
    });

    // DM the user
    const dmEmbed = new EmbedBuilder()
      .setTitle('⚠️ Warning')
      .setColor(0xFAA61A)
      .setDescription(`You received a warning in **${interaction.guild.name}**`)
      .addFields(
        { name: '📝 Reason', value: reason, inline: false },
        { name: '🔑 Case ID', value: `\`${caseID}\``, inline: true },
        { name: '⚡ Note', value: 'Avoid this behavior in the future!', inline: true }
      )
      .setTimestamp();

    const dmSent = await sendModerationDM(targetUser, dmEmbed);

    // Log the action
    await logModerationAction(interaction, logEmbed);

    // Add to database
    addCase(targetUser.id, caseID, {
      moderator: interaction.user.id,
      reason: `(warned) - ${reason}`,
      date: moment(Date.now()).format('LL'),
      type: 'WARN'
    });

    // Get total warns for user
    const totalWarns = DatabaseManager.getUserWarnsCount(targetUser.id) + 1;

    await sendSuccessReply(
      interaction,
      'Warning Issued',
      `Warned **${targetUser.tag}**\n` +
      `Case: \`${caseID}\`\n` +
      `Total: **${totalWarns}**\n` +
      `DM: ${dmSent ? '✅' : '❌'}`
    );
  }
};