const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');
const { moderatorRoleId, administratorRoleId } = require("../../Config/constants/roles.json");

module.exports = {
  data: new SlashCommandBuilder()
    .setName('checkban')
    .setDescription('Look up ban info by case ID')
    .addStringOption(option =>
      option.setName('caseid')
        .setDescription('The case ID to look up')
        .setRequired(true)
    ),
  category: 'management',
  async execute(interaction) {
    const moderator = interaction.member;
    const caseID = interaction.options.getString('caseid');

    // Make sure the user running this command is a mod or admin.
    if (!moderator.roles.cache.has(moderatorRoleId) && !moderator.roles.cache.has(administratorRoleId)) {
      const noPermEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('❌ No Permission')
        .setDescription('You need mod or admin role!');
      return interaction.reply({ embeds: [noPermEmbed], flags: MessageFlags.Ephemeral });
    }

    // Only look in user_bans table for the case ID
    const dbManager = require('../../Functions/MySQLDatabaseManager');
    const rows = await dbManager.connection.query('SELECT * FROM user_bans WHERE ban_case_id = ?', [caseID]);
    if (!rows || rows.length === 0) {
      const notFoundEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Case Not Found')
        .setDescription(`No ban record found with case ID: \`${caseID}\``)
        .setTimestamp();
      return interaction.reply({ embeds: [notFoundEmbed], flags: MessageFlags.Ephemeral });
    }
    const ban = rows[0];
    // Try to fetch user and moderator details from Discord for more info.
    let targetUser = null;
    let moderatorUser = null;
    try {
      targetUser = await interaction.client.users.fetch(ban.user_id).catch(() => null);
      moderatorUser = ban.banned_by ? await interaction.client.users.fetch(ban.banned_by).catch(() => null) : null;
    } catch (err) {
      console.error('Error fetching users:', err);
    }
    // Prefer Discord user, but show DB name if available
    let moderatorDisplay = 'Unknown Moderator';
    if (moderatorUser) {
      moderatorDisplay = `${moderatorUser.tag}\n\`${ban.banned_by}\``;
    } else if (ban.banned_by_name) {
      moderatorDisplay = `${ban.banned_by_name}\n\`${ban.banned_by || 'N/A'}\``;
    } else if (ban.banned_by) {
      moderatorDisplay = `Unknown Moderator\n\`${ban.banned_by}\``;
    }
    // Prefer banned_at, fallback to created_at
    let dateDisplay = ban.banned_at ? new Date(ban.banned_at).toLocaleString() : (ban.created_at ? new Date(ban.created_at).toLocaleString() : 'Unknown');
    // Prefer ban_reason
    let reasonDisplay = ban.ban_reason || 'No reason provided';
    const caseEmbed = new EmbedBuilder()
      .setTitle(`🔨 Ban - Case ${caseID}`)
      .setColor(0xF04747)
      .addFields(
        {
          name: '👤 User',
          value: targetUser
            ? `${targetUser.tag}\n\`${ban.user_id}\``
            : `Unknown User\n\`${ban.user_id}\``,
          inline: true
        },
        {
          name: '👮 Moderator',
          value: moderatorDisplay,
          inline: true
        },
        {
          name: '📅 Date',
          value: dateDisplay,
          inline: true
        },
        {
          name: '📝 Reason',
          value: reasonDisplay,
          inline: false
        }
      )
      .setFooter({ text: `Case ID: ${caseID}` })
      .setTimestamp();
    if (targetUser) {
      caseEmbed.setThumbnail(targetUser.displayAvatarURL({ size: 128 }));
    }
    // Check if the user is still banned at this moment.
    try {
      const banInfo = await interaction.guild.bans.fetch(ban.user_id).catch(() => null);
      caseEmbed.addFields({
        name: '🔍 Current Status',
        value: banInfo ? '🔴 Currently Banned' : '🟢 No Longer Banned (Unbanned)',
        inline: true
      });
    } catch (err) {
      caseEmbed.addFields({
        name: '🔍 Current Status',
        value: '🟢 No Longer Banned',
        inline: true
      });
    }
    await interaction.reply({ embeds: [caseEmbed] });
  }
};