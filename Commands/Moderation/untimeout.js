const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const moment = require("moment");
require("moment-duration-format");
const { generateCaseId } = require("../../Events/caseId");
const { sendErrorReply, sendSuccessReply, createModerationEmbed } = require("../../Functions/EmbedBuilders");
const { canModerateMember, addCase, sendModerationDM, logModerationAction } = require("../../Functions/ModerationHelper");
const DatabaseManager = require('../../Functions/DatabaseManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription('Remove a timeout from a member')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to remove timeout from')
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName('caseid')
        .setDescription('Case ID of the timeout to remove')
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for removing the timeout')
        .setRequired(false)
    ),
  category: 'moderation',
  async execute(interaction) {
      // Acknowledge early to prevent interaction expiry
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
      }

    let targetUser = interaction.options.getUser('user');
    const caseId = interaction.options.getString('caseid');
    const reason = interaction.options.getString('reason') || 'No reason provided';

    // Must provide either user or case ID
    if (!targetUser && !caseId) {
      return sendErrorReply(
        interaction,
        'Missing Parameter',
        'You must provide either a **user** or a **case ID**!'
      );
    }

    // If case ID provided, look up the user from database
    if (caseId) {
      const warnsDB = DatabaseManager.getWarnsDB();
      let foundUserId = null;
      let foundCase = null;

      // Search all users for the case ID
      for (const [userId, userData] of Object.entries(warnsDB.all())) {
        if (userData.warns && userData.warns[caseId]) {
          foundUserId = userId;
          foundCase = userData.warns[caseId];
          break;
        }
      }

      if (!foundUserId || !foundCase) {
        return sendErrorReply(
          interaction,
          'Case Not Found',
          `No case found with ID \`${caseId}\``
        );
      }

      // Check if it's a timeout case
      if (foundCase.type !== 'TIMEOUT') {
        return sendErrorReply(
          interaction,
          'Invalid Case Type',
          `Case \`${caseId}\` is not a timeout case (Type: ${foundCase.type})`
        );
      }

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
    const dmEmbed = new EmbedBuilder()
      .setTitle('✅ Your Timeout Has Been Removed')
      .setColor(0x43B581)
      .setDescription(`Your timeout in **${interaction.guild.name}** has been removed\n\n━━━━━━━━━━━━━━━━━━━━━━`)
      .addFields(
        { name: '📝 Reason', value: `\`\`\`${reason}\`\`\``, inline: false },
        { name: '🔑 Case ID', value: `\`${newCaseID}\``, inline: true },
        { name: '👮 Moderator', value: `${interaction.user}`, inline: true }
      )
      .setFooter({ text: '✅ You can now send messages and join voice channels again!' })
      .setTimestamp();

    if (caseId) {
      dmEmbed.addFields({ name: '📋 Original Timeout Case', value: `\`${caseId}\``, inline: true });
    }

    const dmSent = await sendModerationDM(targetUser, dmEmbed);

    // Log the action
    await logModerationAction(interaction, logEmbed);

    // Add to database
    addCase(targetUser.id, newCaseID, {
      moderator: interaction.user.id,
      reason: `(untimeout) - ${reason}`,
      date: moment(Date.now()).format('LL'),
      type: 'UNTIMEOUT',
      originalCase: caseId || null
    });

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