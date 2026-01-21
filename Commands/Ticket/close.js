const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const { Color } = require("../../Config/constants/misc.json");
const { ticketCategory } = require("../../Config/constants/channel.json");

// Convert hex color to integer
const colorInt = parseInt(Color.replace('#', ''), 16);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close a ticket'),
  category: 'ticket',
  async execute(interaction) {
    const delete1 = new EmbedBuilder()
        .setColor(colorInt)
        .setTitle(`Deletion`)
        .setDescription(`Ticket Will be deleted in 5 seconds`);
    
    if(interaction.channel.parentId !== ticketCategory) {
      return interaction.reply({ content: 'This command can only be used in a ticket channel!', flags: MessageFlags.Ephemeral });
    }

    await interaction.reply({ embeds: [delete1], flags: MessageFlags.Ephemeral });
    
    setTimeout(() => {
      interaction.channel.delete().catch(() => {});
    }, 5000);
  }
}








