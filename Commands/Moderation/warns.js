const DatabaseManager = require('../../Functions/MySQLDatabaseManager');
const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const { ROLES: { moderatorRoleId } } = require("../../Config/constants");

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warns')
    .setDescription('View all warnings for a user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User (optional)')
        .setRequired(false)
    ),
  category: 'moderation',
  async execute(interaction) {
    let Prohibited = new EmbedBuilder()
      .setColor(0xFAA61A)
      .setTitle(`Prohibited User`)
      .setDescription(`You have to be in the moderation team to look at other people's warnings`);

    // Check for Mod role permission
    if (!interaction.member.roles.cache.has(moderatorRoleId)) return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });

    const userOption = interaction.options.getUser('user');

    // Use the user ID given, or default to the person running the command
    const targetUserId = userOption ? userOption.id : interaction.user.id;
    const viewingSelf = targetUserId === interaction.user.id;

    const targetUserObj = await interaction.client.users.fetch(targetUserId).catch(() => null);
    const userLabel = targetUserObj ? `${targetUserObj.tag} (${targetUserId})` : `${targetUserId}`;

    // Fetch warnings from MySQL
    let warns = [];
    try {
      const [rows] = await DatabaseManager.connection.pool.query(
        'SELECT case_id, reason, type, timestamp, created_at FROM warns WHERE user_id = ? ORDER BY timestamp DESC',
        [targetUserId]
      );
      warns = rows || [];
    } catch (err) {
      console.error('[warns] Error fetching warnings:', err);
      const errorEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Error')
        .setDescription(`Failed to fetch warnings: ${err.message}`);
      return interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
    }

    const noneMsg = viewingSelf ? 'You have not been warned before' : 'User has not been warned before';
    const list = warns.length ? warns.map((w, idx) => `${idx + 1}. ${w.case_id}`).join('\n') : noneMsg;

    const em = new EmbedBuilder()
      .setTitle("Warnings")
      .setColor(0xFAA61A)
      .addFields(
        { name: "User", value: userLabel },
        { name: "Total warnings", value: `${warns.length}` },
        { name: "Cases", value: `\`${list}\`` }
      );

    await interaction.reply({ embeds: [em], flags: MessageFlags.Ephemeral });
  }
}