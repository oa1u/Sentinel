const DatabaseManager = require('../../Functions/MySQLDatabaseManager');
const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const { administratorRoleId } = require("../../Config/constants/roles.json");
const { serverLogChannelId } = require("../../Config/constants/channel.json")

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Unban a user by ID or case ID')
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
    
    if(!interaction.member.roles.cache.has(administratorRoleId)) {
      return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });
    }
    
    const warnsDB = DatabaseManager.getWarnsDB();
    const caseIdOption = interaction.options.getString('caseid');
    const userOption = interaction.options.getUser('user');

    // Figure out who to unban—either by case ID or user.
    let targetUserId = userOption ? userOption.id : null;
    let resolvedCaseId = caseIdOption || null;
    let banEntry = null;

    if (caseIdOption) {
      const allWarns = await warnsDB.all();
      for (const [userId, data] of Object.entries(allWarns)) {
        const entry = data?.warns?.[caseIdOption];
        if (entry && entry.reason && entry.reason.toLowerCase().includes('(banned)')) {
          targetUserId = userId;
          banEntry = entry;
          break;
        }
      }
      // If we can't find the ban in warnsDB, check the user_bans table in MySQL for more info.
      if (!targetUserId || !banEntry) {
        const dbManager = require('../../Functions/MySQLDatabaseManager');
        const banRows = await dbManager.connection.query('SELECT user_id FROM user_bans WHERE ban_case_id = ?', [caseIdOption]);
        if (banRows && banRows.length > 0) {
          targetUserId = banRows[0].user_id;
        } else {
          const notFound = new EmbedBuilder()
            .setColor(0xF04747)
            .setTitle('❌ Invalid Case')
            .setDescription('No ban found for that case ID.');
          return interaction.reply({ embeds: [notFound], flags: MessageFlags.Ephemeral });
        }
      }
    } else if (userOption) {
      // If only a user is given, grab their most recent ban case.
      const dbManager = require('../../Functions/MySQLDatabaseManager');
      const banRows = await dbManager.connection.query('SELECT ban_case_id FROM user_bans WHERE user_id = ? ORDER BY ban_case_id DESC LIMIT 1', [userOption.id]);
      if (banRows && banRows.length > 0) {
        resolvedCaseId = banRows[0].ban_case_id;
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

    // If we only have a user ID, try to get their latest ban info from the database.
    let originalBanCaseId = resolvedCaseId || null;
    let originalBanReason = banEntry?.reason || null;
    if (!originalBanCaseId && targetUserId) {
      // Try to get the latest ban for the user.
      const banRows = await dbManager.connection.query('SELECT ban_case_id, reason FROM user_bans WHERE user_id = ? ORDER BY ban_case_id DESC LIMIT 1', [targetUserId]);
      if (banRows && banRows.length > 0) {
        originalBanCaseId = banRows[0].ban_case_id;
        originalBanReason = banRows[0].reason;
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