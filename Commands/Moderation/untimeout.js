const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const moment = require("moment");
require("moment-duration-format");
const { generateCaseId } = require("../../Events/caseId");
const { sendErrorReply, sendSuccessReply, sendWarningReply, sendInfoReply, createModerationEmbed, createModerationDmEmbed } = require("../../Functions/EmbedBuilders");
const { canModerateMember, addCase, sendModerationDM, logModerationAction } = require("../../Functions/ModerationHelper");
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');
const AdminPanelHelper = require('../../Functions/AdminPanelHelper');

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

    if (!targetUser && !caseId) {
      return sendWarningReply(
        interaction,
        'Missing Parameter',
        'You must provide either a **user** or a **case ID**!'
      );
    }

    if (caseId) {
      try {
        const query = 'SELECT user_id, case_id, reason, issued_at, expires_at, active FROM timeouts WHERE case_id = ? LIMIT 1';
        const [rows] = await DatabaseManager.connection.pool.query(query, [caseId]);

        if (!rows || rows.length === 0) {
          return sendInfoReply(
            interaction,
            'Case Not Found',
            `No timeout case found with ID \`${caseId}\``
          );
        }

        const foundCase = rows[0];
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

    addCase(targetUser.id, newCaseID, {
      moderator: interaction.user.id,
      moderatorTag: interaction.user.username,
      userTag: targetUser.username,
      reason: `(untimeout) - ${reason}`,
      date: moment(Date.now()).format('LL'),
      type: 'UNTIMEOUT',
      originalCase: caseId || null
    });

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

    try {
      await targetMember.timeout(null, reason);

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