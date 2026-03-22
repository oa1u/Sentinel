const moment = require("moment");
require("moment-duration-format");
const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const { generateCaseId } = require("../../Events/caseId");
const { sendErrorReply, sendSuccessReply, sendWarningReply, createModerationEmbed, createModerationDmEmbed } = require("../../Functions/EmbedBuilders");
const { canModerateMember, sendModerationDM, logModerationAction } = require("../../Functions/ModerationHelper");
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');

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
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
    }

    const targetUser = interaction.options.getUser('user');
    const reasonInput = interaction.options.getString('reason');

    if (!await canModerateMember(interaction, targetUser, 'warn')) {
      return;
    }

    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) {
      await sendWarningReply(
        interaction,
        'Invalid User',
        `**${targetUser.tag}** is not in this server!`
      );
      return;
    }

    const caseId = generateCaseId('WARN');

    const logEmbed = createModerationEmbed({
      action: 'Warning',
      target: targetUser,
      moderator: interaction.user,
      reason: reasonInput,
      caseId: caseId,
      color: 0xFAA61A
    });

    const dmEmbed = createModerationDmEmbed({
      actionTitle: 'Warning Notice',
      actionEmoji: '⚠️',
      color: 0xFAA61A,
      guildName: interaction.guild.name,
      description: `⚠️ You've received a warning in **${interaction.guild.name}**. Please follow the server rules to avoid further action.`,
      statusLabel: 'Warning Status',
      statusValue: '🛡️ **Active**',
      effectiveDate: moment(Date.now()).format('dddd, D MMMM YYYY [at] HH:mm'),
      effectiveLabel: 'Issued At',
      reason: reasonInput,
      caseId: caseId,
      moderatorName: interaction.user.username
    });

    const dmSent = await sendModerationDM(targetUser, dmEmbed);

    await logModerationAction(interaction, logEmbed);

    try {
      const createdAt = Date.now();
      await DatabaseManager.upsertModerationCase({
        caseId,
        guildId: interaction.guild.id,
        userId: targetUser.id,
        userName: targetUser.username,
        actionType: 'WARN',
        status: 'open',
        reason: reasonInput,
        moderatorId: interaction.user.id,
        moderatorName: interaction.user.username,
        moderatorSource: 'discord',
        source: 'discord',
        createdAt,
        updatedAt: createdAt,
        eventSummary: 'Warning case recorded'
      });
      DatabaseManager.invalidateModerationUserCaches(targetUser.id);
    } catch (err) {
      console.error('[warn] Failed to add warning case to database:', err.message);
    }

    await sendSuccessReply(
      interaction,
      '✅ Warning Issued',
      `**${targetUser.tag}** has been warned\n\n` +
      `**🔑 Case ID:** \`${caseId}\`\n` +
      `**📬 DM Status:** ${dmSent ? '✅ Sent' : '❌ Failed'}`
    );

    await interaction.followUp({
      content:
        `🧾 **Incident proof reminder**\n` +
        `Use this (ephemeral) command to attach evidence for this action:\n` +
        `\`/incident create caseid:${caseId} user:@${targetUser.username} action:WARN reason:<reason> proof:<proof details>\``,
      flags: MessageFlags.Ephemeral
    }).catch(() => { });
  }
};