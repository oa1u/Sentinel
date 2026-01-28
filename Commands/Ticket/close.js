const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const { ticketCategoryId, ticketLogChannelId } = require("../../Config/constants/channel.json");
const { createWarningEmbed } = require("../../Functions/EmbedBuilders");
const DatabaseManager = require('../../Functions/DatabaseManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close this ticket and save transcript')
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for closing the ticket')
        .setRequired(false)
    ),
  category: 'ticket',
  async execute(interaction) {
    // Verify this is a ticket channel
    if (interaction.channel.parentId !== ticketCategoryId) {
      const errorEmbed = createWarningEmbed(
        'Invalid Channel',
        'This command can only be used in a ticket channel!'
      );
      return interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
    }

    const closeReason = interaction.options.getString('reason') || 'No reason provided';
    const ticketsDB = DatabaseManager.getDatabase('tickets');
    const ticketData = ticketsDB.get(interaction.channel.id) || {};

    // Create transcript
    let transcript = `📋 Ticket Transcript - ${interaction.channel.name}\n`;
    transcript += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    transcript += `🎫 Ticket Information:\n`;
    transcript += `   • Ticket Owner: ${ticketData.userName || 'Unknown'} (${ticketData.userId || 'N/A'})\n`;
    transcript += `   • Created: ${ticketData.createdAt ? new Date(ticketData.createdAt).toLocaleString() : 'Unknown'}\n`;
    transcript += `   • Closed: ${new Date().toLocaleString()}\n`;
    transcript += `   • Closed By: ${interaction.user.tag} (${interaction.user.id})\n`;
    transcript += `   • Close Reason: ${closeReason}\n`;
    transcript += `   • Priority: ${ticketData.priority || 'medium'}\n`;
    transcript += `   • Reason: ${ticketData.reason || 'No reason'}\n`;
    if (ticketData.claimedBy) {
      const claimer = await interaction.client.users.fetch(ticketData.claimedBy).catch(() => null);
      transcript += `   • Claimed By: ${claimer ? claimer.tag : 'Unknown'}\n`;
    }
    transcript += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    transcript += `💬 Message History:\n\n`;

    try {
      // Fetch all messages in the ticket
      const messages = await interaction.channel.messages.fetch({ limit: 100 });
      const sortedMessages = Array.from(messages.values()).reverse();

      for (const message of sortedMessages) {
        const timestamp = message.createdAt.toLocaleString();
        transcript += `[${timestamp}] ${message.author.tag}:\n`;
        if (message.content) {
          transcript += `   ${message.content}\n`;
        }
        if (message.embeds.length > 0) {
          transcript += `   [Embed: ${message.embeds[0].title || 'No title'}]\n`;
        }
        if (message.attachments.size > 0) {
          message.attachments.forEach(att => {
            transcript += `   [Attachment: ${att.name} - ${att.url}]\n`;
          });
        }
        transcript += `\n`;
      }

      transcript += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      transcript += `End of transcript - Total Messages: ${sortedMessages.length}\n`;

    } catch (err) {
      console.error('Error generating transcript:', err);
      transcript += `\n⚠️ Error fetching message history\n`;
    }

    // Create closing message
    const closingEmbed = new EmbedBuilder()
      .setColor(0xF04747)
      .setTitle('🔒 Ticket Closing')
      .setDescription(`This ticket is being closed and will be deleted shortly.\n\n**Closure Details:**`)
      .addFields(
        { name: '⏱️ Time Remaining', value: '\`5 seconds\`', inline: true },
        { name: '💾 Transcript', value: '✅ Saved to logs', inline: true },
        { name: '\u200b', value: '\u200b', inline: true },
        { name: '🔒 Closed By', value: `${interaction.user}\n\`${interaction.user.tag}\``, inline: true },
        { name: '📝 Close Reason', value: `\`\`\`${closeReason}\`\`\``, inline: false }
      )
      .setFooter({ text: 'Thank you for using our support system!' })
      .setTimestamp();
    
    await interaction.reply({ embeds: [closingEmbed] });

    // Log to ticket log channel with transcript
    const logChannel = interaction.guild.channels.cache.get(ticketLogChannelId);
    if (logChannel) {
      const logEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('🔒 Ticket Closed & Archived')
        .setDescription(`━━━━━━━━━━━━━━━━━━━━━`)
        .addFields(
          { name: '🎫 Ticket Name', value: `\`${interaction.channel.name}\``, inline: false },
          { name: '👤 Ticket Owner', value: `${ticketData.userName || 'Unknown'}\n\`${ticketData.userId || 'N/A'}\``, inline: true },
          { name: '🔒 Closed By', value: `${interaction.user.tag}\n\`${interaction.user.id}\``, inline: true },
          { name: '⚡ Priority', value: `${ticketData.priority === 'high' ? '🔴 High' : ticketData.priority === 'low' ? '🟢 Low' : '🟡 Medium'}`, inline: true },
          { name: '📝 Close Reason', value: `\`\`\`${closeReason}\`\`\``, inline: false },
          { name: '🕐 Opened', value: ticketData.createdAt ? `<t:${Math.floor(ticketData.createdAt / 1000)}:F>` : 'Unknown', inline: true },
          { name: '🔒 Closed', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
          { name: '⏱️ Duration', value: ticketData.createdAt ? `<t:${Math.floor(ticketData.createdAt / 1000)}:R>` : 'Unknown', inline: true }
        )
        .setFooter({ text: '💾 Full transcript attached below' })
        .setTimestamp();

      const transcriptBuffer = Buffer.from(transcript, 'utf-8');
      const attachment = new AttachmentBuilder(transcriptBuffer, { 
        name: `transcript-${interaction.channel.name}-${Date.now()}.txt` 
      });

      await logChannel.send({ embeds: [logEmbed], files: [attachment] });

      // Also send to user's DMs if possible
      try {
        const dmChannel = await interaction.user.createDM().catch(() => null);
        if (dmChannel) {
          await dmChannel.send({ embeds: [logEmbed], files: [attachment] }).catch((err) => {
            console.error(`Failed to send ticket log to user DMs: ${err.message}`);
          });
        }
      } catch (err) {
        console.error(`Could not open DM with user: ${err.message}`);
      }
    }

    // Update database
    ticketsDB.set(interaction.channel.id, {
      ...ticketData,
      status: 'closed',
      closedAt: Date.now(),
      closedBy: interaction.user.id,
      closeReason: closeReason
    });
    
    // Delete channel after 5 seconds
    const channelId = interaction.channel.id;
    setTimeout(async () => {
      try {
        await interaction.channel.delete();
        // Clean up database after deletion
        ticketsDB.delete(channelId);
      } catch (err) {
        console.error(`Failed to delete ticket channel: ${err.message}`);
      }
    }, 5000);
  }
};