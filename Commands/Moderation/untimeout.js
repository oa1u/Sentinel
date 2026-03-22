const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const moment = require("moment");
require("moment-duration-format");
const { generateCaseId } = require("../../Events/caseId");
const { sendErrorReply, sendSuccessReply, sendWarningReply, sendInfoReply, createModerationEmbed, createModerationDmEmbed } = require("../../Functions/EmbedBuilders");
const { canModerateMember, sendModerationDM, logModerationAction } = require("../../Functions/ModerationHelper");
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription('Remove a timeout from a member')
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for removing the timeout')
        .setRequired(true)
    )
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to remove timeout from')
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName('caseid')
        .setDescription('Case ID of the timeout to remove')
        .setRequired(false)
    ),
  category: 'moderation',
  async execute(interaction) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
    }

    let targetUser = interaction.options.getUser('user');
    const caseId = interaction.options.getString('caseid');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    let originalTimeoutCase = null;

    if (!targetUser && !caseId) {
      return sendWarningReply(
        interaction,
        'Missing Parameter',
        'You must provide either a **user** or a **case ID**!'
      );
    }

    if (caseId) {
      try {
        const foundCase = await DatabaseManager.getModerationCaseById(caseId);

        if (!foundCase || String(foundCase.action_type || '').toUpperCase() !== 'TIMEOUT') {
          return sendInfoReply(
            interaction,
            'Case Not Found',
            `No timeout case found with ID \`${caseId}\``
          );
        }

        originalTimeoutCase = foundCase;
        const foundUserId = foundCase.user_id;

        try {
          targetUser = await interaction.client.users.fetch(foundUserId);
        } catch (err) {
          return sendInfoReply(
            interaction,
            'User Not Found',
            `Could not fetch user from case \`${caseId}\``
          );
        }
      } catch (err) {
        console.error('[untimeout] Error looking up case ID:', err);
        return sendErrorReply(
          interaction,
          'Database Error',
          `Failed to look up case \`${caseId}\`: ${err.message}`
        );
      }
    }

    if (!await canModerateMember(interaction, targetUser, 'remove timeout from')) {
      return;
    }

    if (!originalTimeoutCase && targetUser) {
      originalTimeoutCase = await DatabaseManager.getLatestActiveTimeoutCaseForUser(targetUser.id, interaction.guild.id);
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

    if (!targetMember.isCommunicationDisabled()) {
      await sendInfoReply(
        interaction,
        'Not Timed Out',
        `**${targetUser.tag}** is not currently timed out!`
      );
      return;
    }

    const newCaseID = generateCaseId('UNTIMEOUT');

    const logEmbed = createModerationEmbed({
      action: 'Untimeout',
      target: targetUser,
      moderator: interaction.user,
      reason: reason,
      caseId: newCaseID,
      color: 0x43B581
    });

    if (caseId) {
      logEmbed.addFields({ name: '📋 Original Case', value: `\`${caseId}\``, inline: true });
    }

    const dmEmbed = createModerationDmEmbed({
      actionTitle: 'Timeout Removed',
      actionEmoji: '✅',
      color: 0x43B581,
      guildName: interaction.guild.name,
      description: `Your timeout in **${interaction.guild.name}** has been removed! You can now send messages and join voice channels again.`,
      statusLabel: 'Status',
      statusValue: '✅ **Removed**',
      effectiveDate: moment(Date.now()).format('dddd, D MMMM YYYY [at] HH:mm'),
      reason: reason,
      caseId: newCaseID,
      moderatorName: interaction.user.username,
      extraFields: caseId
        ? [{ name: 'Original Timeout Case', value: `${'```'}${caseId}${'```'}`, inline: true }]
        : []
    });

    const dmSent = await sendModerationDM(targetUser, dmEmbed);

    await logModerationAction(interaction, logEmbed);

    try {
      await targetMember.timeout(null, reason);

      const updatedAt = Date.now();

      if (originalTimeoutCase?.case_id) {
        await DatabaseManager.updateModerationCaseStatus(originalTimeoutCase.case_id, 'cleared', {
          guildId: interaction.guild.id,
          actorId: interaction.user.id,
          actorName: interaction.user.username,
          relatedCaseId: newCaseID,
          details: reason,
          updatedAt
        });
      }

      await DatabaseManager.upsertModerationCase({
        caseId: newCaseID,
        guildId: interaction.guild.id,
        userId: targetUser.id,
        userName: targetUser.username,
        actionType: 'UNTIMEOUT',
        status: 'closed',
        reason,
        moderatorId: interaction.user.id,
        moderatorName: interaction.user.username,
        moderatorSource: 'discord',
        source: 'discord',
        relatedCaseId: originalTimeoutCase?.case_id || null,
        rootCaseId: originalTimeoutCase?.root_case_id || originalTimeoutCase?.case_id || newCaseID,
        createdAt: updatedAt,
        updatedAt,
        eventSummary: 'Untimeout case recorded'
      });
      DatabaseManager.invalidateModerationUserCaches(targetUser.id);

      await sendSuccessReply(
        interaction,
        '✅ Timeout Removed',
        `**${targetUser.tag}** is no longer timed out\n\n` +
        (caseId ? `**📋 Original Case:** \`${caseId}\`\n` : '') +
        `**🔑 New Case ID:** \`${newCaseID}\`\n` +
        `**📬 DM Status:** ${dmSent ? '✅ Sent' : '❌ Failed'}`
      );
    } catch (err) {
      console.error(`Error removing timeout from ${targetUser.tag}:`, err.message);
      await sendErrorReply(
        interaction,
        'Untimeout Failed',
        `Could not remove timeout from **${targetUser.tag}**\nError: ${err.message}`
      );
    }
  }
};