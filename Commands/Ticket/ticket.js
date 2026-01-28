const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { ticketCategoryId, ticketLogChannelId } = require("../../Config/constants/channel.json");
const { administratorRoleId } = require("../../Config/constants/roles.json");
const { createErrorEmbed, createInfoEmbed } = require("../../Functions/EmbedBuilders");
const DatabaseManager = require('../../Functions/DatabaseManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Open a support ticket to get help from staff')
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Why are you opening a ticket?')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('priority')
        .setDescription('Ticket priority level')
        .setRequired(true)
        .addChoices(
          { name: '🟢 Low', value: 'low' },
          { name: '🟡 Medium', value: 'medium' },
          { name: '🔴 High', value: 'high' }
        )
    ),
  category: 'ticket',
  async execute(interaction) {
    try {
      // Defer the reply immediately
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      
      const reason = interaction.options.getString('reason');
      const priority = interaction.options.getString('priority');
      const priorityEmoji = priority === 'high' ? '🔴' : priority === 'low' ? '🟢' : '🟡';
      const priorityLabel = priority.charAt(0).toUpperCase() + priority.slice(1);
      
      // Check ticket category
      const categoryChannel = interaction.guild.channels.cache.get(ticketCategoryId);
      if (!categoryChannel) {
        const errorEmbed = createErrorEmbed(
          'Category Not Found',
          `Ticket category not configured! Contact an <@&${administratorRoleId}>.`
        );
        return await interaction.editReply({ embeds: [errorEmbed] });
      }
      
      // Check for existing ticket
      const existingTicket = interaction.guild.channels.cache.find(
        ch => ch.name.startsWith(`ticket-${interaction.user.username.toLowerCase()}`) && 
              ch.parentId === categoryChannel.id
      );
      
      if (existingTicket) {
        const errorEmbed = createErrorEmbed(
          'Ticket Already Exists',
          `You already have a ticket open!`
        ).addFields(
          { name: '🎫 Your Ticket', value: `<#${existingTicket.id}>`, inline: false },
          { name: '💡 Tip', value: 'Use your existing ticket or close it first.', inline: false }
        );
        
        return await interaction.editReply({ embeds: [errorEmbed] });
      }

      // Create the ticket channel
      const ticketChannel = await interaction.guild.channels.create({
        name: `${priorityEmoji}-ticket-${interaction.user.username.toLowerCase()}`,
        type: ChannelType.GuildText,
        parent: ticketCategoryId,
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
        .setColor(priority === 'high' ? 0xF04747 : priority === 'low' ? 0x43B581 : 0x5865F2)
        .setTitle(`${priorityEmoji} Support Ticket Created`)
        .setDescription(`**Welcome ${interaction.user}!**\n\nThank you for opening a support ticket. Our team will be with you shortly.\n\n**Please provide:**\n> 📖 A detailed description of your issue\n> 📸 Any relevant screenshots or evidence\n> ⏱️ When the issue started occurring`)
        .addFields(
          { name: '📝 Ticket Reason', value: `\`\`\`${reason || 'No reason provided'}\`\`\``, inline: false },
          { name: '⚡ Priority Level', value: `${priorityEmoji} **${priorityLabel}**`, inline: true },
          { name: '🕐 Created', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
          { name: '\u200b', value: '\u200b', inline: true },
          { name: '🚫 Close Ticket', value: '> Use `/close` command\n> React with ❌ below\n> A transcript will be saved', inline: false }
        )
        .setFooter({ text: '🎫 Support Team • We\'re here to help!' })
        .setTimestamp();

      const ticketMessage = await ticketChannel.send({
        content: `${interaction.user}${supportRole ? ` | ${supportRole}` : ''}`,
        embeds: [welcomeEmbed]
      });

      // Add close reaction
      await ticketMessage.react('❌').catch(console.error);

      // Store ticket data in database
      const ticketsDB = DatabaseManager.getDatabase('tickets');
      ticketsDB.set(ticketChannel.id, {
        userId: interaction.user.id,
        userName: interaction.user.tag,
        reason: reason,
        priority: priority,
        createdAt: Date.now(),
        channelId: ticketChannel.id,
        claimedBy: null,
        status: 'open'
      });

      // Log ticket creation to logging channel
      const logChannel = interaction.guild.channels.cache.get(ticketLogChannelId);
      if (logChannel) {
        const logEmbed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle('🎫 New Ticket Created')
          .addFields(
            { name: '👤 User', value: `${interaction.user.tag}\n\`${interaction.user.id}\``, inline: true },
            { name: '🎫 Channel', value: `${ticketChannel}`, inline: true },
            { name: '⚡ Priority', value: `${priorityEmoji} ${priorityLabel}`, inline: true },
            { name: '📝 Reason', value: reason || 'No reason provided', inline: false }
          )
          .setTimestamp();
        
        await logChannel.send({ embeds: [logEmbed] });
      }

      // Send confirmation to user with info embed
      const successEmbed = new EmbedBuilder()
        .setColor(0x43B581)
        .setTitle('✅ Ticket Created Successfully')
        .setDescription(`Your support ticket has been created!\n\n**What happens next:**\n> 👥 Our support team has been notified\n> 📨 Check ${ticketChannel} for updates\n> ⏱️ Average response time: 5-15 minutes`)
        .addFields(
          { name: '🎫 Your Ticket', value: `${ticketChannel}`, inline: false },
          { name: '📝 Reason', value: `\`${reason || 'No reason provided'}\``, inline: false },
          { name: '⚡ Priority', value: `${priorityEmoji} **${priorityLabel}**`, inline: true },
          { name: '🔔 Status', value: '🟢 **Open**', inline: true },
          { name: '\u200b', value: '\u200b', inline: true }
        )
        .setFooter({ text: 'Thank you for your patience!' })
        .setTimestamp();

      await interaction.editReply({ embeds: [successEmbed] });

    } catch (error) {
      console.error('Error in ticket command:', error);
      
      const errorEmbed = createErrorEmbed(
        'Ticket Creation Failed',
        `An error occurred while creating your ticket. Please try again or contact an <@&${administratorRoleId}>.`
      );
      
      if (interaction.deferred && !interaction.replied) {
        await interaction.editReply({ embeds: [errorEmbed] }).catch(console.error);
      } else if (!interaction.replied) {
        await interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral }).catch(console.error);
      }
    }
  }
};