const {
  SlashCommandBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags
} = require('discord.js');
const { ticketCategoryId, ticketLogChannelId } = require("../../Config/constants/channel.json");
const { administratorRoleId, supportTeamRoleId } = require("../../Config/constants/roles.json");
const { createErrorEmbed, createWarningEmbed, createSuccessEmbed, sendErrorReply } = require("../../Functions/EmbedBuilders");
const MySQLDatabaseManager = require('../../Functions/MySQLDatabaseManager');

// This is the ticket system for user support—create tickets, get help, and track everything.
// Creates private channels, logs transcripts, and keeps track of ticket status.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Open a support ticket to get help from staff')
    .addStringOption(option =>
      option
        .setName('reason')
        .setDescription('Why are you opening a ticket?')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('priority')
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
    return openTicket(interaction);
  }
};

function isTicketChannel(interaction) {
  return interaction.channel?.parentId === ticketCategoryId;
}

function hasSupportOrAdmin(member) {
  return member.roles.cache.has(supportTeamRoleId) || member.permissions.has(PermissionFlagsBits.Administrator);
}

async function openTicket(interaction) {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const reason = interaction.options.getString('reason');
    const priority = interaction.options.getString('priority');

    // Double check that the user actually wrote something before submitting.
    if (!reason || reason.trim().length === 0) {
      return await interaction.editReply({ embeds: [createErrorEmbed('Invalid Input', 'Please provide a reason for your ticket.')] });
    }

    const priorityEmoji = priority === 'high' ? '🔴' : priority === 'low' ? '🟢' : '🟡';
    const priorityLabel = priority.charAt(0).toUpperCase() + priority.slice(1);

    const categoryChannel = interaction.guild.channels.cache.get(ticketCategoryId);
    if (!categoryChannel) {
      const errorEmbed = createErrorEmbed(
        'Category Not Found',
        `Ticket category not configured! Contact an <@&${administratorRoleId}>.`
      );
      return await interaction.editReply({ embeds: [errorEmbed] });
    }

    // Check if the user already has a ticket open—only one at a time!
    try {
      const allTickets = await MySQLDatabaseManager.getAllTickets('open').catch(() => []);
      const existingTicket = allTickets.find(t => t.userId === interaction.user.id);

      if (existingTicket) {
        const ticketChannel = interaction.guild.channels.cache.get(existingTicket.channelId);
        if (ticketChannel) {
          const errorEmbed = createErrorEmbed(
            'Ticket Already Exists',
            `You already have a ticket open!`
          ).addFields(
            { name: '🎫 Your Ticket', value: `<#${ticketChannel.id}>`, inline: false },
            { name: '💡 Tip', value: 'Use your existing ticket or close it first.', inline: false }
          );

          return await interaction.editReply({ embeds: [errorEmbed] });
        }
      }
    } catch (err) {
      console.warn('[Ticket] Could not check existing tickets:', err.message);
    }

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

    const supportRole = interaction.guild.roles.cache.find(role => role.name === "Support");
    if (supportRole) {
      await ticketChannel.permissionOverwrites.create(supportRole, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true
      });
    }

    const welcomeEmbed = new EmbedBuilder()
      .setColor(priority === 'high' ? 0xF04747 : priority === 'low' ? 0x43B581 : 0x5865F2)
      .setTitle(`${priorityEmoji} Support Ticket Opened`)
      .setDescription(`Welcome, ${interaction.user}!\n\nYour support ticket has been created and assigned to our support team. Please provide as much detail as possible to help us assist you quickly.`)
      .addFields(
        { name: 'Status', value: '🟢 Open', inline: true },
        { name: 'Priority', value: `${priorityEmoji} ${priorityLabel}`, inline: true },
        { name: 'Created', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
        { name: 'Your Request', value: reason ? `\`\`\`${reason}\`\`\`` : 'No reason provided', inline: false },
        { name: 'How to Provide Info', value: '📝 Detailed description\n📸 Screenshots\n⏱️ Timing\n📎 Attach files', inline: true },
        { name: 'Support Actions', value: '✅ Review\n🔍 Clarify\n⚡ Solution\n📋 Document', inline: true },
        { name: 'Close Ticket', value: 'Use `/ticket close` or click ❌\nTranscript will be saved.', inline: false }
      )
      .setFooter({ text: '🎫 Support System • Case #' + Date.now().toString().slice(-6) })
      .setTimestamp();

    const ticketMessage = await ticketChannel.send({
      content: `${interaction.user}${supportRole ? ` | ${supportRole}` : ''}`,
      embeds: [welcomeEmbed]
    });

    await ticketMessage.react('❌').catch(console.error);

    await MySQLDatabaseManager.createTicket(ticketChannel.id, {
      userId: interaction.user.id,
      userName: interaction.user.tag,
      reason: reason,
      priority: priority,
      createdAt: Date.now(),
      claimedBy: null,
      status: 'open'
    });

    const logChannel = interaction.guild.channels.cache.get(ticketLogChannelId);
    if (logChannel) {
      const logEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🎫 New Support Ticket Created')
        .setDescription(`A new support ticket has been submitted for staff review.`)
        .addFields(
          { name: 'Ticket Creator', value: `${interaction.user.tag}\n\`ID: ${interaction.user.id}\``, inline: true },
          { name: 'Priority Level', value: `${priorityEmoji} **${priorityLabel}**`, inline: true },
          { name: 'Ticket Channel', value: `${ticketChannel}`, inline: false },
          { name: 'Issue Description', value: `\`\`\`${reason || 'No reason provided'}\`\`\``, inline: false },
          { name: 'Next Steps', value: '📌 Assign support staff\n💬 Provide initial response\n⚡ Resolve issue', inline: false }
        )
        .setFooter({ text: `Ticket ID: ${ticketChannel.id}` })
        .setTimestamp();

      await logChannel.send({ embeds: [logEmbed] });
    }

    const successEmbed = new EmbedBuilder()
      .setColor(0x43B581)
      .setTitle('✅ Ticket Created Successfully')
      .setDescription(`Your support request has been registered and assigned to our support team. Please provide as much detail as possible to help us assist you.\n\nYou will receive a response shortly.`)
      .addFields(
        { name: 'Status', value: '🟢 Open', inline: true },
        { name: 'Priority', value: `${priorityEmoji} ${priorityLabel}`, inline: true },
        { name: 'Channel', value: `${ticketChannel}`, inline: true },
        { name: 'Your Issue', value: reason ? `\`\`\`${reason}\`\`\`` : 'No reason provided', inline: false },
        { name: 'What You Can Do', value: '✅ Add details\n📎 Share files\n💬 Ask questions\n⏳ Wait for support', inline: true },
        { name: 'When Done', value: 'Use `/ticket close` or click ❌\nTranscript will be saved.', inline: true }
      )
      .setFooter({ text: 'Thank you for contacting support!' })
      .setTimestamp();

    await interaction.editReply({ embeds: [successEmbed] });
  } catch (error) {
    console.error('Error in ticket open:', error);

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

async function closeTicket(interaction) {
  if (!isTicketChannel(interaction)) {
    const errorEmbed = createWarningEmbed(
      'Invalid Channel',
      'This command can only be used in a ticket channel!'
    );
    return interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
  }

  const closeReason = interaction.options.getString('reason') || 'No reason provided';
  const ticketData = await MySQLDatabaseManager.getTicket(interaction.channel.id) || {};

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

  await MySQLDatabaseManager.updateTicket(interaction.channel.id, {
    status: 'closed',
    closedAt: Date.now(),
    closedBy: interaction.user.id,
    closeReason: closeReason
  });

  const channelId = interaction.channel.id;
  setTimeout(async () => {
    try {
      await interaction.channel.delete();
      await MySQLDatabaseManager.deleteTicket(channelId);
    } catch (err) {
      console.error(`Failed to delete ticket channel: ${err.message}`);
    }
  }, 5000);
}

async function addUserToTicket(interaction) {
  if (!isTicketChannel(interaction)) {
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

  if (!hasSupportOrAdmin(member)) {
    return sendErrorReply(
      interaction,
      'No Permission',
      'Only support staff can add users to tickets!'
    );
  }

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

  const notifyEmbed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎫 Added to Support Ticket')
    .setDescription(`${targetUser}\n\nYou have been added to this ticket by ${interaction.user}.\n\n**You can now:**\n> 📖 View the conversation history\n> 💬 Send messages and help resolve the issue\n> 📎 Share files and screenshots`)
    .setFooter({ text: 'Ticket System' })
    .setTimestamp();

  await interaction.channel.send({ embeds: [notifyEmbed] });
}

async function removeUserFromTicket(interaction) {
  if (!isTicketChannel(interaction)) {
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

  if (!hasSupportOrAdmin(member)) {
    return sendErrorReply(
      interaction,
      'No Permission',
      'Only support staff can remove users from tickets!'
    );
  }

  const ticketData = await MySQLDatabaseManager.getTicket(interaction.channel.id).catch(() => null);
  if (ticketData?.userId && ticketData.userId === targetUser.id) {
    return sendErrorReply(
      interaction,
      'Cannot Remove Owner',
      'You cannot remove the ticket owner from their own ticket!'
    );
  }

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

async function claimTicket(interaction) {
  if (!isTicketChannel(interaction)) {
    return sendErrorReply(
      interaction,
      'Invalid Channel',
      'This command can only be used in a ticket channel!'
    );
  }

  if (!hasSupportOrAdmin(interaction.member)) {
    return sendErrorReply(
      interaction,
      'No Permission',
      'Only support staff can claim tickets!'
    );
  }

  const ticketId = interaction.channel.id;
  const ticketData = await MySQLDatabaseManager.getTicket(ticketId) || {};

  if (ticketData.claimedBy && ticketData.claimedBy !== interaction.user.id) {
    const claimer = await interaction.client.users.fetch(ticketData.claimedBy).catch(() => null);
    return sendErrorReply(
      interaction,
      'Already Claimed',
      `This ticket has already been claimed by ${claimer ? claimer.tag : 'another support member'}!`
    );
  }

  await MySQLDatabaseManager.updateTicket(ticketId, {
    claimedBy: interaction.user.id,
    status: 'claimed'
  });

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

  const notifyEmbed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎫 Ticket Claimed')
    .setDescription(`**${interaction.user}** has claimed this ticket and will assist you.\n\n**What this means:**\n> ✅ A support member is now handling your case\n> 📞 They will respond to your questions\n> 🎯 Your issue will be resolved shortly`)
    .setFooter({ text: 'Support Team' })
    .setTimestamp();

  await interaction.channel.send({ embeds: [notifyEmbed] });
}

async function markHandled(interaction) {
  if (!interaction.member.roles.cache.has(supportTeamRoleId) && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return sendErrorReply(
      interaction,
      'No Permission',
      `You need the <@&${supportTeamRoleId}> role to mark tickets as handled!`
    );
  }

  if (!isTicketChannel(interaction)) {
    return sendErrorReply(
      interaction,
      'Invalid Channel',
      'This command can only be used in ticket channels!'
    );
  }

  await interaction.channel.setName(`${interaction.channel.name} - 🚩 - ${interaction.user.username}`);

  const successEmbed = createSuccessEmbed(
    'Ticket Marked as Handled',
    `This ticket has been flagged as resolved!`
  ).addFields(
    { name: '👤 Handler', value: `${interaction.user.tag}\n\`${interaction.user.id}\``, inline: true },
    { name: '🚩 Status', value: '**Handled**', inline: true },
    { name: '⏰ Marked At', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
    { name: '💡 Next Steps', value: 'The ticket owner can now close this ticket using `/ticket close` or ❌ reaction', inline: false }
  ).setTimestamp();

  return interaction.reply({ embeds: [successEmbed] });
}

module.exports.handlers = {
  openTicket,
  closeTicket,
  addUserToTicket,
  removeUserFromTicket,
  claimTicket,
  markHandled
};