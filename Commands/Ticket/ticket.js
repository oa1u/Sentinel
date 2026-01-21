const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { Color } = require("../../Config/constants/misc.json");
const { ticketCategory } = require("../../Config/constants/channel.json");

// Convert hex color to integer
const colorInt = parseInt(Color.replace('#', ''), 16);

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
          .setColor(colorInt)
          .setTitle('❌ Ticket Already Exists')
          .setDescription(`You already have an open ticket: <#${existingTicket.id}>`);
        
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
        .setColor(colorInt)
        .setTitle('🎫 Support Ticket')
        .setDescription(`Welcome ${interaction.user}!\n\nSupport will be with you shortly.\nTo close this ticket, use the /close command or react with ❌.`)
        .addFields({ name: 'Reason', value: reason, inline: false })
        .setTimestamp();

      const ticketMessage = await ticketChannel.send({
        content: `${interaction.user}${supportRole ? ` | ${supportRole}` : ''}`,
        embeds: [welcomeEmbed]
      });

      // Add close reaction
      await ticketMessage.react('❌').catch(console.error);

      // Set up reaction collector for closing
      const collector = ticketMessage.createReactionCollector({
        filter: (reaction, user) => reaction.emoji.name === '❌' && !user.bot,
        time: 7 * 24 * 60 * 60 * 1000 // 7 days
      });

      collector.on('collect', async (reaction, user) => {
        // Only allow ticket creator or support staff to close
        const canClose = user.id === interaction.user.id || 
                        (supportRole && interaction.guild.members.cache.get(user.id)?.roles.cache.has(supportRole.id));
        
        if (canClose) {
          const closeEmbed = new EmbedBuilder()
            .setColor('Red')
            .setDescription('⏱️ Ticket will be deleted in 5 seconds...');
          
          await ticketChannel.send({ embeds: [closeEmbed] });
          
          setTimeout(async () => {
            await ticketChannel.delete().catch(console.error);
          }, 5000);
          
          collector.stop();
        }
      });

      // Send confirmation to user
      const successEmbed = new EmbedBuilder()
        .setColor(colorInt)
        .setTitle('✅ Ticket Created')
        .setDescription(`Your ticket has been created: ${ticketChannel}`);

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









