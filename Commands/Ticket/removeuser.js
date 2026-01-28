const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { ticketCategoryId } = require("../../Config/constants/channel.json");
const { supportTeamRoleId } = require("../../Config/constants/roles.json");
const { sendErrorReply, createSuccessEmbed } = require("../../Functions/EmbedBuilders");

module.exports = {
  data: new SlashCommandBuilder()
    .setName('removeuser')
    .setDescription('Remove a user from the current ticket')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to remove from the ticket')
        .setRequired(true)
    ),
  category: 'moderation',
  async execute(interaction) {
    // Verify this is a ticket channel
    if (interaction.channel.parentId !== ticketCategoryId) {
      return sendErrorReply(
        interaction,
        'Invalid Channel',
        'This command can only be used in a ticket channel!'
      );
    }

    const member = interaction.member;
    const targetUser = interaction.options.getUser('user');
    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (!targetMember) {
      return sendErrorReply(
        interaction,
        'User Not Found',
        'Could not find that user in this server!'
      );
    }

    // Check permissions (support role required)
    const hasSupport = member.roles.cache.has(supportTeamRoleId);
    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);

    if (!hasSupport && !isAdmin) {
      return sendErrorReply(
        interaction,
        'No Permission',
        'Only support staff can remove users from tickets!'
      );
    }

    // Prevent removing the ticket owner
    if (targetUser.username.toLowerCase() === ticketOwnerName.toLowerCase()) {
      return sendErrorReply(
        interaction,
        'Cannot Remove Owner',
        'You cannot remove the ticket owner from their own ticket!'
      );
    }

    // Remove permissions for the user
    await interaction.channel.permissionOverwrites.delete(targetMember);

    const successEmbed = createSuccessEmbed(
      'User Removed from Ticket',
      `**${targetUser}** has been removed from this ticket.`
    ).addFields(
      { name: '👤 Removed User', value: `${targetUser.tag}\n\`${targetUser.id}\``, inline: true },
      { name: '➖ Removed By', value: `${interaction.user.tag}\n\`${interaction.user.id}\``, inline: true },
      { name: '🔒 Access Revoked', value: 'User can no longer view or interact with this ticket', inline: false }
    ).setTimestamp();

    await interaction.reply({ embeds: [successEmbed] });
  }
};