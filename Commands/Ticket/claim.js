const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { ticketCategoryId } = require("../../Config/constants/channel.json");
const { supportTeamRoleId } = require("../../Config/constants/roles.json");
const { sendErrorReply, createSuccessEmbed } = require("../../Functions/EmbedBuilders");
const DatabaseManager = require('../../Functions/DatabaseManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('claim')
    .setDescription('Claim this ticket as yours'),
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

    // Check if user has support role
    if (!interaction.member.roles.cache.has(supportTeamRoleId) && !interaction.member.permissions.has('Administrator')) {
      return sendErrorReply(
        interaction,
        'No Permission',
        'Only support staff can claim tickets!'
      );
    }

    const ticketsDB = DatabaseManager.getDatabase('tickets');
    const ticketId = interaction.channel.id;
    
    // Check if ticket is already claimed
    const ticketData = ticketsDB.get(ticketId) || {};
    
    if (ticketData.claimedBy && ticketData.claimedBy !== interaction.user.id) {
      const claimer = await interaction.client.users.fetch(ticketData.claimedBy).catch(() => null);
      return sendErrorReply(
        interaction,
        'Already Claimed',
        `This ticket has already been claimed by ${claimer ? claimer.tag : 'another support member'}!`
      );
    }

    // Claim the ticket
    ticketsDB.set(ticketId, {
      ...ticketData,
      claimedBy: interaction.user.id,
      claimedAt: Date.now()
    });

    // Update channel name
    const channelName = interaction.channel.name.split(' - ')[0];
    await interaction.channel.setName(`${channelName} - 👤 ${interaction.user.username}`);

    const successEmbed = createSuccessEmbed(
      'Ticket Claimed Successfully',
      `You have claimed this ticket!`
    ).addFields(
      { name: '👤 Support Member', value: `${interaction.user.tag}\n\`${interaction.user.id}\``, inline: true },
      { name: '⏰ Claimed At', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
      { name: '📌 Responsibility', value: 'This ticket is now assigned to you. Please provide assistance to the user.', inline: false }
    ).setTimestamp();

    await interaction.reply({ embeds: [successEmbed] });

    // Notify in channel
    const notifyEmbed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('🎫 Ticket Claimed')
      .setDescription(`**${interaction.user}** has claimed this ticket and will assist you.\n\n**What this means:**\n> ✅ A support member is now handling your case\n> 📞 They will respond to your questions\n> 🎯 Your issue will be resolved shortly`)
      .setFooter({ text: 'Support Team' })
      .setTimestamp();

    await interaction.channel.send({ embeds: [notifyEmbed] });
  }
};