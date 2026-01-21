const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const { Color } = require("../../Config/constants/misc.json");
const { supportrole } = require("../../Config/constants/roles.json");
const { ticketCategory } = require("../../Config/constants/channel.json");

// Convert hex color to integer
const colorInt = parseInt(Color.replace('#', ''), 16);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('markhandled')
    .setDescription('Mark a ticket as handled')
    .setDefaultMemberPermissions(0x2000),
  category: 'ticket',
  async execute(interaction) {
    let Prohibited = new EmbedBuilder()
        .setColor(colorInt)
        .setTitle(`Error`)
        .setDescription(`You don't have enough permission to do that!`);
    
    if(!interaction.member.roles.cache.has(supportrole)) {
      return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });
    }

    if(interaction.channel.parentId !== ticketCategory) {
      return interaction.reply({ content: ":x: You can't do that here!", flags: MessageFlags.Ephemeral });
    }

    await interaction.channel.setName(interaction.channel.name + " - 🚩 - " + interaction.user.username);
    return interaction.reply({ content: "Ticket marked as handled!", flags: MessageFlags.Ephemeral });
  }
}








