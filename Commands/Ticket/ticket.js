const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { ticketCategory } = require("../../Config/constants/channel.json");


module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Create a support ticket')
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Why are you opening a ticket?')
        .setRequired(true)
    ),
  category: 'ticket',
  async execute(interaction) {
    try {
      // Defer the reply immediately
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      
      const reason = interaction.options.getString('reason');
      
      // Verify ticket category exists
      const categoryChannel = interaction.guild.channels.cache.get(ticketCategory);
      if (!categoryChannel) {
        return await interaction.editReply({
          content: `❌ Ticket category not found! Please contact an administrator.`
        });
      }
      
      // Check if user already has an open ticket
      const existingTicket = interaction.guild.channels.cache.find(
        ch => ch.name === `ticket-${interaction.user.username.toLowerCase()}` && 
              ch.parentId === categoryChannel.id
      );
      
      if (existingTicket) {
        const errorEmbed = new EmbedBuilder()
          .setColor(0xF04747)
          .setTitle('❌ Ticket Already Exists')
          .setDescription(`You already have an open ticket in this category!`)
          .addFields(
            { name: '🎫 Your Ticket', value: `<#${existingTicket.id}>`, inline: false },
            { name: '💡 Note', value: 'Please use your existing ticket or close it first.', inline: false }
          )
          .setTimestamp();
        
        return await interaction.editReply({ embeds: [errorEmbed] });
      }

      // Create the ticket channel
      const ticketChannel = await interaction.guild.channels.create({
        name: `ticket-${interaction.user.username.toLowerCase()}`,
        type: ChannelType.GuildText,
        parent: ticketCategory,
        permissionOverwrites: [
          {
            id: interaction.guild.id,
            deny: [PermissionFlagsBits.ViewChannel]
          },
          {
            id: interaction.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.AttachFiles
            ]
          },
          {
            id: interaction.client.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ManageChannels
            ]
          }
        ]
      });

      // Add support role permissions if it exists
      const supportRole = interaction.guild.roles.cache.find(role => role.name === "Support");
      if (supportRole) {
        await ticketChannel.permissionOverwrites.create(supportRole, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true
        });
      }

      // Send welcome message in ticket channel
      const welcomeEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🎫 Support Ticket Created')
        .setDescription(`Welcome ${interaction.user}!\n\nOur support team will be with you shortly. Please describe your issue in detail.`)
        .addFields(
          { name: '📝 Reason', value: reason, inline: false },
          { name: '❌ Close Ticket', value: 'Use `/close` or react with ❌ below', inline: false }
        )
        .setFooter({ text: 'Support Team' })
        .setTimestamp();

      const ticketMessage = await ticketChannel.send({
        content: `${interaction.user}${supportRole ? ` | ${supportRole}` : ''}`,
        embeds: [welcomeEmbed]
      });

      // Add close reaction
      await ticketMessage.react('❌').catch(console.error);

      // Send confirmation to user
      const successEmbed = new EmbedBuilder()
        .setColor(0x43B581)
        .setTitle('✅ Ticket Created Successfully')
        .setDescription(`Your support ticket has been created!`)
        .addFields(
          { name: '🎫 Ticket Channel', value: `${ticketChannel}`, inline: false },
          { name: '📝 Reason', value: reason, inline: false }
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [successEmbed] });

    } catch (error) {
      console.error('Error in ticket command:', error);
      
      const errorMessage = 'An error occurred while creating your ticket. Please try again or contact an administrator.';
      
      if (interaction.deferred && !interaction.replied) {
        await interaction.editReply({ content: errorMessage }).catch(console.error);
      } else if (!interaction.replied) {
        await interaction.reply({ content: errorMessage, flags: MessageFlags.Ephemeral }).catch(console.error);
      }
    }
  }
};