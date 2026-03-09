const moment = require("moment");
require("moment-duration-format");
const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const { generateCaseId } = require("../../Events/caseId");
const { sendErrorReply, sendSuccessReply, sendWarningReply, createModerationEmbed, createModerationDmEmbed } = require("../../Functions/EmbedBuilders");
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
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
    }

    const targetUser = interaction.options.getUser('user');
    const reasonInput = interaction.options.getString('reason');

    // Check permissions and hierarchy
    if (!await canModerateMember(interaction, targetUser, 'warn')) {
      return;
    }

    // Fetch member to verify they exist in guild
    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) {
      await sendWarningReply(
        interaction,
        'Invalid User',
        `**${targetUser.tag}** is not in this server!`
      );
      return;
    }

    // Generate case ID
    const caseId = generateCaseId('WARN');

    // Create logging embed
    const logEmbed = createModerationEmbed({
      action: '⚠️ Warning',
      target: targetUser,
      moderator: interaction.user,
      reason: reasonInput,
      caseId: caseId,
      color: 0xFAA61A
    });

    // Send DM to user
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

    // Log the action
    await logModerationAction(interaction, logEmbed);

    // Add to database
    addCase(targetUser.id, caseId, {
      moderator: interaction.user.id,
      moderatorTag: interaction.user.username,
      userTag: targetUser.username,
      reason: reasonInput,
      date: moment(Date.now()).format('LL'),
      type: 'WARN'
    });

    // Add warning to MySQL database
    try {
      const query = `
        INSERT INTO warns (user_id, case_id, reason, moderator_id, moderator_name, type, timestamp, created_at)
        VALUES (?, ?, ?, ?, ?, 'WARN', ?, NOW())
      `;
      await DatabaseManager.connection.pool.query(query, [
        targetUser.id,
        caseId,
        reasonInput,
        interaction.user.id,
        interaction.user.username,
        Date.now()
      ]);
    } catch (err) {
      console.error('[warn] Failed to add warning to database:', err.message);
    }

    // Send success response
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