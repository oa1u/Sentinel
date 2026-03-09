const DatabaseManager = require('../../Functions/MySQLDatabaseManager');
const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const { ROLES: { moderatorRoleId } } = require("../../Config/constants");

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warning')
    .setDescription('Look up details about a warning case')
    .addStringOption(option =>
      option.setName('caseid')
        .setDescription('Case ID')
        .setRequired(true)
    )
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User ID (optional)')
        .setRequired(false)
    ),
  category: 'moderation',
  async execute(interaction) {
    let Prohibited = new EmbedBuilder()
      .setColor(0xFAA61A)
      .setTitle(`Prohibited User`)
      .setDescription(`You have to be a <@&${moderatorRoleId}> to be able to use this command!`);

    // Check for ModRole permission
    if (!interaction.member.roles.cache.has(moderatorRoleId)) return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });

    let caseidincorrect = new EmbedBuilder()
      .setColor(0xFAA61A)
      .setTitle(`Error`)
      .setDescription(`Invalid case ID`);

    const warnsDB = DatabaseManager.getWarnsDB();
    const caseID = interaction.options.getString('caseid');
    const userOption = interaction.options.getUser('user');

    // Try to find the warning in MySQL database
    let warningEntry = null;
    let targetUserId = null;

    try {
      const query = 'SELECT user_id, case_id, reason, moderator_id, moderator_name, type, timestamp, created_at FROM warns WHERE case_id = ? LIMIT 1';
      const [rows] = await DatabaseManager.connection.pool.query(query, [caseID]);

      if (rows && rows.length > 0) {
        const row = rows[0];
        targetUserId = row.user_id;
        warningEntry = {
          caseId: row.case_id,
          reason: row.reason,
          moderatorId: row.moderator_id,
          moderatorName: row.moderator_name,
          type: row.type,
          timestamp: row.timestamp,
          date: row.created_at
        };
      }
    } catch (err) {
      console.error('[warning] Error looking up case:', err);
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0xFAA61A)
          .setTitle('Error')
          .setDescription(`Failed to look up case \`${caseID}\`: ${err.message}`)
        ],
        flags: MessageFlags.Ephemeral
      });
    }

    if (!warningEntry || !targetUserId) return interaction.reply({ embeds: [caseidincorrect], flags: MessageFlags.Ephemeral });

    const targetUser = await interaction.client.users.fetch(targetUserId).catch(() => null);
    const userLabel = targetUser ? `${targetUser.tag} (${targetUserId})` : targetUserId;
    // Try new format first
    let moderatorLabel = 'Unknown';
    if (warningEntry.moderatorId) {
      const modUser = await interaction.client.users.fetch(warningEntry.moderatorId).catch(() => null);
      moderatorLabel = modUser ? `${modUser.tag} (${modUser.id})` : warningEntry.moderatorId;
    } else if (warningEntry.moderator) {
      const modUser = await interaction.client.users.fetch(warningEntry.moderator).catch(() => null);
      moderatorLabel = modUser ? `${modUser.tag} (${modUser.id})` : warningEntry.moderator;
    }
    // Date: prefer timestamp, fallback to date
    let dateLabel = warningEntry.timestamp ? `<t:${Math.floor(warningEntry.timestamp / 1000)}:F>` : (warningEntry.date || 'No date recorded');

    // Count total warnings for this user from MySQL
    let totalWarns = 0;
    try {
      const [countRows] = await DatabaseManager.connection.pool.query('SELECT COUNT(*) as count FROM warns WHERE user_id = ?', [targetUserId]);
      totalWarns = countRows[0]?.count || 0;
    } catch (err) {
      console.error('[warning] Error counting warns:', err);
    }

    const em = new EmbedBuilder()
      .setTitle(`Case ${caseID}`)
      .setColor(0xFAA61A)
      .addFields(
        { name: "User", value: userLabel },
        { name: "Reason", value: warningEntry.reason || 'No reason recorded' },
        { name: "Moderator", value: moderatorLabel },
        { name: "Date", value: dateLabel },
        { name: "Total warnings for user", value: `${totalWarns}` }
      );

    await interaction.reply({ embeds: [em], flags: MessageFlags.Ephemeral });
  }
}