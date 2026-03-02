const DatabaseManager = require('../../Functions/MySQLDatabaseManager');
const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const { administratorRoleId } = require("../../Config/constants/roles.json");
const { serverLogChannelId } = require("../../Config/constants/channel.json")

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
    .setDefaultMemberPermissions(0x8),
  category: 'management',
  async execute(interaction) {
    const Prohibited = new EmbedBuilder()
      .setColor(0xF04747)
      .setTitle(`❌ No Permission`)
      .setDescription(`You need the Administrator role to use this command!`);

    if (!interaction.member.roles.cache.has(administratorRoleId)) {
      return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });
    }

    const caseIdOption = interaction.options.getString('caseid');
    const userOption = interaction.options.getUser('user');

    // Figure out who to unban—either by case ID or user.
    let targetUserId = userOption ? userOption.id : null;
    let resolvedCaseId = caseIdOption || null;

    if (caseIdOption) {
      // Look up the ban in MySQL user_bans table
      const dbManager = require('../../Functions/MySQLDatabaseManager');
      try {
        const [banRows] = await dbManager.connection.pool.query('SELECT user_id, ban_case_id FROM user_bans WHERE ban_case_id = ?', [caseIdOption]);
        if (banRows && banRows.length > 0) {
          targetUserId = banRows[0].user_id;
          resolvedCaseId = banRows[0].ban_case_id;
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
      // If only a user is given, grab their most recent ban case.
      const dbManager = require('../../Functions/MySQLDatabaseManager');
      try {
        const [banRows] = await dbManager.connection.pool.query('SELECT ban_case_id FROM user_bans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [userOption.id]);
        if (banRows && banRows.length > 0) {
          resolvedCaseId = banRows[0].ban_case_id;
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

    // Make a new case number for this unban event.
    const dbManager = require('../../Functions/MySQLDatabaseManager');
    // Generate a unique case ID for unban
    function generateCaseId(type) {
      const random = Math.random().toString(36).substring(2, 8).toUpperCase();
      return `${type}-${random}`;
    }
    const newUnbanCaseId = generateCaseId('UNBAN');
    const unbanReason = newUnbanCaseId;

    // Determine original ban case and reason from the database when possible.
    let originalBanCaseId = resolvedCaseId || null;
    let originalBanReason = null;

    if (originalBanCaseId) {
      try {
        const [rows] = await dbManager.connection.pool.query('SELECT ban_reason AS reason FROM user_bans WHERE ban_case_id = ? LIMIT 1', [originalBanCaseId]);
        if (rows && rows.length > 0) originalBanReason = rows[0].reason;
      } catch (e) {
        console.error('[unban] Failed to fetch original ban reason:', e);
      }
    } else if (targetUserId) {
      try {
        const [rows] = await dbManager.connection.pool.query('SELECT ban_case_id, ban_reason AS reason FROM user_bans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [targetUserId]);
        if (rows && rows.length > 0) {
          originalBanCaseId = rows[0].ban_case_id;
          originalBanReason = rows[0].reason;
        }
      } catch (e) {
        console.error('[unban] Error looking up latest ban for user:', e);
      }
    }

    // Save the unban event in the database for tracking.
    await dbManager.connection.query(
      `INSERT INTO unbans (user_id, unban_case_id, unbanned_at, unbanned_by, unbanned_by_name, unbanned_by_source, user_name, original_ban_case_id, original_ban_reason, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        targetUserId,
        newUnbanCaseId,
        new Date(),
        interaction.user.id,
        interaction.user.username,
        'discord',
        targetUser ? targetUser.username : null,
        originalBanCaseId,
        originalBanReason,
        unbanReason
      ]
    );

    await interaction.guild.members.unban(targetUserId, unbanReason).catch(err => {
      console.error('Error unbanning user:', err);
    });
    const clearedWarnsLog = interaction.client.channels.cache.get(serverLogChannelId);
    const em = new EmbedBuilder()
      .setTitle("🔓 User Unbanned")
      .setColor(0x43B581)
      .addFields(
        { name: '👮 Administrator', value: `${'```'}${interaction.user.username}${'```'}`, inline: true },
        { name: '👤 User', value: `${targetLabel}`, inline: true },
        { name: '🔑 Unban Case ID', value: `\t${'```'}${newUnbanCaseId}${'```'}`, inline: false },
        { name: '🔑 Original Ban Case ID', value: `${'```'}${originalBanCaseId || 'N/A'}${'```'}`, inline: true },
      )
      .setFooter({ text: `Unbanned by ${interaction.user.username}` })
      .setTimestamp();

    if (clearedWarnsLog) await clearedWarnsLog.send({ embeds: [em] });

    const successEmbed = new EmbedBuilder()
      .setColor(0x43B581)
      .setTitle('✅ Successfully Unbanned')
      .setDescription(`**${targetLabel}** has been unbanned!`)
      .addFields({ name: "🔑 Unban Case ID", value: `\`${newUnbanCaseId}\`` });

    return interaction.reply({ embeds: [successEmbed], flags: MessageFlags.Ephemeral });
  }
}