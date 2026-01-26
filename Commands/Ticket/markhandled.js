const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const { Color } = require("../../Config/constants/misc.json");
const { SupportRole } = require("../../Config/constants/roles.json");
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
        .setColor(0xF04747)
        .setTitle(`❌ No Permission`)
        .setDescription(`You need the Support role to mark tickets as handled!`);
    
    if(!interaction.member.roles.cache.has(SupportRole)) {
      return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });
    }

    if(interaction.channel.parentId !== ticketCategory) {
      const errorEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Invalid Channel')
        .setDescription('This command can only be used in ticket channels!');
      return interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
    }

    await interaction.channel.setName(interaction.channel.name + " - 🚩 - " + interaction.user.username);
    
    const successEmbed = new EmbedBuilder()
      .setColor(0x43B581)
      .setTitle('✅ Ticket Marked as Handled')
      .setDescription(`This ticket has been flagged as handled by ${interaction.user}`)
      .addFields(
        { name: '👤 Handler', value: interaction.user.username, inline: true },
        { name: '🚩 Status', value: 'Handled', inline: true }
      )
      .setTimestamp();
    
    return interaction.reply({ embeds: [successEmbed], flags: MessageFlags.Ephemeral });
  }
}