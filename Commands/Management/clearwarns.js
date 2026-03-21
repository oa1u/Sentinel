const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');
const { ROLES: { administratorRoleId }, CHANNELS: { serverLogChannelId } } = require("../../Config/constants");

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clearwarns')
    .setDescription('Clear warnings from a user')
    .addSubcommand(subcommand =>
      subcommand
        .setName('single')
        .setDescription('Remove a specific warning from a user')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('User to clear warning from')
            .setRequired(true)
        )
        .addStringOption(option =>
          option.setName('caseid')
            .setDescription('Case ID to clear')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('all')
        .setDescription('Clear all warnings from a user')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('User to clear all warnings from')
            .setRequired(true)
        )
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

    const subcommand = interaction.options.getSubcommand();
    const user = interaction.options.getUser('user');

    switch (subcommand) {
      case 'single':
        return await this.clearSingleWarning(interaction, user);
      case 'all':
        return await this.clearAllWarnings(interaction, user);
    }
  },

  async clearSingleWarning(interaction, user) {
    const caseID = interaction.options.getString('caseid');

    try {
      const [rows] = await DatabaseManager.connection.pool.query(
        'SELECT reason FROM warns WHERE case_id = ? AND user_id = ?',
        [caseID, user.id]
      );

      if (!rows || rows.length === 0) {
        const notFoundEmbed = new EmbedBuilder()
          .setColor(0xF04747)
          .setTitle('❌ Case Not Found')
          .setDescription(`No warning found with case ID: \`${caseID}\``);
        return interaction.reply({
          embeds: [notFoundEmbed],
          flags: MessageFlags.Ephemeral
        });
      }

      const caseReason = rows[0].reason;

      await DatabaseManager.connection.pool.query(
        'DELETE FROM warns WHERE case_id = ?',
        [caseID]
      );

      const clearedWarnsLog = interaction.client.channels.cache.get(serverLogChannelId);
      const em = new EmbedBuilder()
        .setTitle('✅ Warning Cleared')
        .setColor(0x43B581)
        .addFields(
          { name: "👮 Administrator", value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
          { name: "👤 User", value: `${user.tag} (${user.id})`, inline: true },
          { name: "🔑 Case ID", value: `\`${caseID}\``, inline: true },
          { name: "📝 Reason", value: `\`${caseReason}\`` }
        )
        .setFooter({ text: `Cleared by ${interaction.user.tag}` })
        .setTimestamp();

      if (clearedWarnsLog) await clearedWarnsLog.send({ embeds: [em] });

      const successEmbed = new EmbedBuilder()
        .setColor(0x43B581)
        .setTitle('✅ Warning Cleared')
        .setDescription(`Warning **\`${caseID}\`** has been removed from **${user.tag}**!`);

      return interaction.reply({
        embeds: [successEmbed],
        flags: MessageFlags.Ephemeral
      });
    } catch (err) {
      console.error('[clearwarns] Error clearing warning:', err);
      const errorEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Error')
        .setDescription(`Failed to clear warning: ${err.message}`);
      return interaction.reply({
        embeds: [errorEmbed],
        flags: MessageFlags.Ephemeral
      });
    }
  },

  async clearAllWarnings(interaction, user) {
    const userBanned = await DatabaseManager.isUserBanned(user.id);
    if (userBanned) {
      await interaction.guild.members.unban(user.id, `${interaction.user.tag} - warnings cleared`).catch(err => {
        console.error('Error unbanning user:', err);
      });
    }
    await DatabaseManager.clearUserWarns(user.id);

    const clearedWarnsLog = interaction.client.channels.cache.get(serverLogChannelId);
    const em = new EmbedBuilder()
      .setTitle("🧹 Warnings Cleared")
      .setColor(0x43B581)
      .addFields(
        { name: "👮 Administrator", value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
        { name: "👤 User", value: `${user.tag} (${user.id})`, inline: true },
        { name: "🔓 Unbanned?", value: userBanned ? '✅ Yes' : '❌ No', inline: true }
      )
      .setFooter({ text: `Cleared by ${interaction.user.tag}` })
      .setTimestamp();

    if (clearedWarnsLog) await clearedWarnsLog.send({ embeds: [em] });

    const successEmbed = new EmbedBuilder()
      .setColor(0x43B581)
      .setTitle('✅ Warnings Cleared')
      .setDescription(`All warnings for **${user.tag}** have been removed!`);

    return interaction.reply({ embeds: [successEmbed], flags: MessageFlags.Ephemeral });
  }
}