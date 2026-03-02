const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const moment = require("moment");
require("moment-duration-format");
const { generateCaseId } = require("../../Events/caseId");
const { sendErrorReply, sendSuccessReply, createModerationEmbed, createModerationDmEmbed } = require("../../Functions/EmbedBuilders");
const { canModerateMember, addCase, sendModerationDM, logModerationAction } = require("../../Functions/ModerationHelper");
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');
const AdminPanelHelper = require('../../Functions/AdminPanelHelper');

// Lets you end a user's timeout early
// Also updates the admin panel
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
    // Respond right away so Discord doesn't time out while we process
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
    }

    let targetUser = interaction.options.getUser('user');
    const caseId = interaction.options.getString('caseid');
    const reason = interaction.options.getString('reason') || 'No reason provided';

    // You have to give either a user or a case ID
    if (!targetUser && !caseId) {
      return sendErrorReply(
        interaction,
        'Missing Parameter',
        'You must provide either a **user** or a **case ID**!'
      );
    }

    // If a case ID is given, try to find the user in the database
    if (caseId) {
      try {
        // Query MySQL timeouts table for the case ID
        const query = 'SELECT user_id, case_id, reason, issued_at, expires_at, active FROM timeouts WHERE case_id = ? LIMIT 1';
        const [rows] = await DatabaseManager.connection.pool.query(query, [caseId]);

        if (!rows || rows.length === 0) {
          return sendErrorReply(
            interaction,
            'Case Not Found',
            `No timeout case found with ID \`${caseId}\``
          );
        }

        const foundCase = rows[0];
        const foundUserId = foundCase.user_id;

        // Fetch the user
        try {
          targetUser = await interaction.client.users.fetch(foundUserId);
        } catch (err) {
          return sendErrorReply(
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

    // Check permissions and hierarchy
    if (!await canModerateMember(interaction, targetUser, 'remove timeout from')) {
      return;
    }

    // Fetch member to verify they exist in guild
    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) {
      await sendErrorReply(
        interaction,
        'Invalid User',
        `**${targetUser.tag}** is not in this server!`
      );
      return;
    }

    // Check if member is actually timed out
    if (!targetMember.isCommunicationDisabled()) {
      await sendErrorReply(
        interaction,
        'Not Timed Out',
        `**${targetUser.tag}** is not currently timed out!`
      );
      return;
    }

    // Generate case ID
    const newCaseID = generateCaseId('UNTIMEOUT');

    // Create logging embed
    const logEmbed = createModerationEmbed({
      action: '✅ Untimeout',
      target: targetUser,
      moderator: interaction.user,
      reason: reason,
      caseId: newCaseID,
      color: 0x43B581
    });

    if (caseId) {
      logEmbed.addFields({ name: '📋 Original Case', value: `\`${caseId}\``, inline: true });
    }

    // Send DM to user
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

    // Log the action
    await logModerationAction(interaction, logEmbed);

    // Add to database
    addCase(targetUser.id, newCaseID, {
      moderator: interaction.user.id,
      moderatorTag: interaction.user.username,
      userTag: targetUser.username,
      reason: `(untimeout) - ${reason}`,
      date: moment(Date.now()).format('LL'),
      type: 'UNTIMEOUT',
      originalCase: caseId || null
    });

    // Remove from timeouts tracking table
    try {
      await AdminPanelHelper.clearTimeout(targetUser.id, {
        caseId: newCaseID,
        clearedBy: interaction.user.id,
        clearedAt: Date.now(),
        reason: reason
      });
    } catch (err) {
      console.error('[untimeout] Failed to remove timeout from database:', err.message);
    }

    // Remove the timeout
    try {
      await targetMember.timeout(null, reason);

      // Send success response
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