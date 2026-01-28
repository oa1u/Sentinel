const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { ticketCategoryId } = require("../../Config/constants/channel.json");
const { supportTeamRoleId } = require("../../Config/constants/roles.json");
const { sendErrorReply, createSuccessEmbed } = require("../../Functions/EmbedBuilders");

module.exports = {
  data: new SlashCommandBuilder()
    .setName('adduser')
    .setDescription('Add a user to the current ticket')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to add to the ticket')
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
        'Only support staff can add users to tickets!'
      );
    }

    // Add permissions for the user
    await interaction.channel.permissionOverwrites.create(targetMember, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true
    });

    const successEmbed = createSuccessEmbed(
      'User Added to Ticket',
      `**${targetUser}** has been added to this ticket!`
    ).addFields(
      { name: '👤 Added User', value: `${targetUser.tag}\n\`${targetUser.id}\``, inline: true },
      { name: '➕ Added By', value: `${interaction.user.tag}\n\`${interaction.user.id}\``, inline: true },
      { name: '🔓 Permissions Granted', value: '> View Channel\n> Send Messages\n> Read History\n> Attach Files', inline: false }
    ).setTimestamp();

    await interaction.reply({ embeds: [successEmbed] });

    // Notify the added user
    const notifyEmbed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('🎫 Added to Support Ticket')
      .setDescription(`${targetUser}\n\nYou have been added to this ticket by ${interaction.user}.\n\n**You can now:**\n> 📖 View the conversation history\n> 💬 Send messages and help resolve the issue\n> 📎 Share files and screenshots`)
      .setFooter({ text: 'Ticket System' })
      .setTimestamp();

    await interaction.channel.send({ embeds: [notifyEmbed] });
  }
};