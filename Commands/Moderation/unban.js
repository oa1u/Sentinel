const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const { generateCaseId } = require('../../Events/caseId');
const dbManager = require('../../Functions/MySQLDatabaseManager');
const {
  ROLES: { moderatorRoleId, administratorRoleId },
  CHANNELS: { serverLogChannelId }
} = require("../../Config/constants");

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Unban a user by ID or case ID')
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for unbanning the user')
        .setRequired(true)
    )
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to unban')
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName('caseid')
        .setDescription('Case ID of the ban')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  category: 'moderation',
  async execute(interaction) {
    const prohibited = new EmbedBuilder()
      .setColor(0xF04747)
      .setTitle('❌ No Permission')
      .setDescription('You need the Moderator or Administrator role to use this command!');

    if (!interaction.member.roles.cache.has(moderatorRoleId) && !interaction.member.roles.cache.has(administratorRoleId)) {
      return interaction.reply({ embeds: [prohibited], flags: MessageFlags.Ephemeral });
    }

    const caseIdOption = interaction.options.getString('caseid');
    const userOption = interaction.options.getUser('user');

    let targetUserId = userOption ? userOption.id : null;
    let resolvedCaseId = caseIdOption || null;
    let originalBanCase = null;

    if (caseIdOption) {
      try {
        originalBanCase = await dbManager.getModerationCaseById(caseIdOption);
        if (originalBanCase && String(originalBanCase.action_type || '').toUpperCase() === 'BAN') {
          targetUserId = originalBanCase.user_id;
          resolvedCaseId = originalBanCase.case_id;
        } else {
          const notFound = new EmbedBuilder()
            .setColor(0xF04747)
            .setTitle('❌ Invalid Case')
            .setDescription('No ban found for that case ID.');
          return interaction.reply({ embeds: [notFound], flags: MessageFlags.Ephemeral });
        }
      } catch (err) {
        console.error('[unban] Error looking up case ID:', err);
        const errorEmbed = new EmbedBuilder()
          .setColor(0xF04747)
          .setTitle('❌ Error')
          .setDescription(`Failed to look up case \`${caseIdOption}\`: ${err.message}`);
        return interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
      }
    } else if (userOption) {
      try {
        originalBanCase = await dbManager.getLatestActiveBanCaseForUser(userOption.id, interaction.guild.id);
        if (originalBanCase?.case_id) {
          resolvedCaseId = originalBanCase.case_id;
        }
      } catch (err) {
        console.error('[unban] Error looking up user bans:', err);
      }
    }

    if (!targetUserId) {
      const needParam = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Missing Input')
        .setDescription('Provide a user or case ID.');
      return interaction.reply({ embeds: [needParam], flags: MessageFlags.Ephemeral });
    }

    const targetUser = await interaction.client.users.fetch(targetUserId).catch(() => null);
    const targetLabel = targetUser ? `${targetUser.tag} (${targetUser.id})` : targetUserId;

    const newUnbanCaseId = generateCaseId('UNBAN');
    const providedReason = interaction.options.getString('reason', true);

    let originalBanCaseId = resolvedCaseId || null;
    let originalBanReason = null;

    if (!originalBanCase && originalBanCaseId) {
      originalBanCase = await dbManager.getModerationCaseById(originalBanCaseId);
    }

    if (!originalBanCase && targetUserId) {
      originalBanCase = await dbManager.getLatestActiveBanCaseForUser(targetUserId, interaction.guild.id);
    }

    originalBanCaseId = originalBanCase?.case_id || originalBanCaseId || null;
    originalBanReason = originalBanCase?.reason || null;

    const unbanCreatedAt = Date.now();
    const unbanResult = await interaction.guild.members.unban(targetUserId, providedReason).catch(err => {
      console.error('Error unbanning user:', err);
      return null;
    });

    if (!unbanResult) {
      const errorEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Unban Failed')
        .setDescription('Discord did not confirm the unban. Please check the user ID or try again.');
      return interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
    }

    await dbManager.upsertModerationCase({
      caseId: newUnbanCaseId,
      guildId: interaction.guild.id,
      userId: targetUserId,
      userName: targetUser ? targetUser.username : null,
      actionType: 'UNBAN',
      status: 'closed',
      reason: providedReason,
      moderatorId: interaction.user.id,
      moderatorName: interaction.user.username,
      moderatorSource: 'discord',
      source: 'discord',
      relatedCaseId: originalBanCaseId,
      rootCaseId: originalBanCase?.root_case_id || originalBanCaseId || newUnbanCaseId,
      metadata: originalBanReason ? { originalBanReason } : null,
      createdAt: unbanCreatedAt,
      updatedAt: unbanCreatedAt,
      eventSummary: 'Unban case recorded'
    });

    if (originalBanCaseId) {
      await dbManager.updateModerationCaseStatus(originalBanCaseId, 'reversed', {
        guildId: interaction.guild.id,
        actorId: interaction.user.id,
        actorName: interaction.user.username,
        relatedCaseId: newUnbanCaseId,
        details: `Reversed by unban case ${newUnbanCaseId}`,
        updatedAt: unbanCreatedAt
      });
    }

    await dbManager.unbanUser(targetUserId);
    dbManager.invalidateModerationUserCaches(targetUserId);

    const logChannel = interaction.client.channels.cache.get(serverLogChannelId);
    const em = new EmbedBuilder()
      .setTitle('🔓 User Unbanned')
      .setColor(0x43B581)
      .addFields(
        { name: '👮 Moderator', value: `${'```'}${interaction.user.username}${'```'}`, inline: true },
        { name: '👤 User', value: `${targetLabel}`, inline: true },
        { name: '📝 Reason', value: `${'```'}${providedReason}${'```'}`, inline: false },
        { name: '🔑 Unban Case ID', value: `${'```'}${newUnbanCaseId}${'```'}`, inline: false },
        { name: '🔑 Original Ban Case ID', value: `${'```'}${originalBanCaseId || 'N/A'}${'```'}`, inline: true }
      )
      .setFooter({ text: `Unbanned by ${interaction.user.username}` })
      .setTimestamp();

    if (logChannel) await logChannel.send({ embeds: [em] });

    const successEmbed = new EmbedBuilder()
      .setColor(0x43B581)
      .setTitle('✅ Successfully Unbanned')
      .setDescription(`**${targetLabel}** has been unbanned!`)
      .addFields({ name: '🔑 Unban Case ID', value: `\`${newUnbanCaseId}\`` });

    return interaction.reply({ embeds: [successEmbed], flags: MessageFlags.Ephemeral });
  }
};