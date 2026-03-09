const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const { ROLES: { moderatorRoleId, administratorRoleId } } = require("../../Config/constants");

module.exports = {
  data: new SlashCommandBuilder()
    .setName('checkban')
    .setDescription('Look up ban info by case ID')
    .addStringOption(option =>
      option.setName('caseid')
        .setDescription('The case ID to look up')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  category: 'moderation',
  async execute(interaction) {
    const moderator = interaction.member;
    const caseID = interaction.options.getString('caseid');

    if (!moderator.roles.cache.has(moderatorRoleId) && !moderator.roles.cache.has(administratorRoleId)) {
      const noPermEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('❌ No Permission')
        .setDescription('You need mod or admin role!');
      return interaction.reply({ embeds: [noPermEmbed], flags: MessageFlags.Ephemeral });
    }

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
    let targetUser = null;
    let moderatorUser = null;
    try {
      targetUser = await interaction.client.users.fetch(ban.user_id).catch(() => null);
      moderatorUser = ban.banned_by ? await interaction.client.users.fetch(ban.banned_by).catch(() => null) : null;
    } catch (err) {
      console.error('Error fetching users:', err);
    }

    let moderatorDisplay = 'Unknown Moderator';
    if (moderatorUser) {
      moderatorDisplay = `${moderatorUser.tag}\n\`${ban.banned_by}\``;
    } else if (ban.banned_by_name) {
      moderatorDisplay = `${ban.banned_by_name}\n\`${ban.banned_by || 'N/A'}\``;
    } else if (ban.banned_by) {
      moderatorDisplay = `Unknown Moderator\n\`${ban.banned_by}\``;
    }

    const dateDisplay = ban.banned_at ? new Date(ban.banned_at).toLocaleString() : (ban.created_at ? new Date(ban.created_at).toLocaleString() : 'Unknown');
    const reasonDisplay = ban.ban_reason || 'No reason provided';

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
