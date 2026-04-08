const {
  ActionRowBuilder,
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags
} = require('discord.js');
const { CHANNELS: { ticketCategoryId, ticketLogChannelId }, ROLES: { administratorRoleId, supportTeamRoleId } } = require("../../Config/constants");
const { createErrorEmbed, createWarningEmbed, createSuccessEmbed, sendWarningReply, sendInfoReply } = require("../../Functions/EmbedBuilders");
const MySQLDatabaseManager = require('../../Functions/MySQLDatabaseManager');
const {
  closeTicketChannel,
  getTicketRecordForChannel,
  hasSupportOrAdmin,
  isTicketChannel,
  updateTicketChannelAssigneeName
} = require('../../Functions/TicketLifecycle');

const TICKET_OPEN_WINDOW_MS = 10 * 60 * 1000;
const TICKET_OPEN_MAX_ATTEMPTS = 4;
const TICKET_CREATION_COOLDOWN_MS = 2 * 60 * 1000;
const DUPLICATE_REASON_WINDOW_MS = 15 * 60 * 1000;
const AUTO_TICKET_BUTTON_ID = 'ticket:auto_open';
const TICKET_CATEGORY_BUTTON_PREFIX = 'ticket:category:';
const AUTO_TICKET_MODAL_PREFIX = 'ticket:auto_open_modal:';
const AUTO_TICKET_REASON_FIELD_ID = 'ticket_reason';

const TICKET_CATEGORIES = Object.freeze([
  {
    key: 'billing_info',
    label: 'Billing Info',
    emoji: '💳',
    color: 0x4C9AFF,
    channelTag: 'billing',
    buttonStyle: ButtonStyle.Primary,
    description: 'Payments, invoices, refunds, and subscription questions.'
  },
  {
    key: 'sales_question',
    label: 'Sales Question',
    emoji: '🛍️',
    color: 0x2ECC71,
    channelTag: 'sales',
    buttonStyle: ButtonStyle.Success,
    description: 'Product details, pricing, upgrades, and pre-purchase questions.'
  },
  {
    key: 'technical_support',
    label: 'Technical Support',
    emoji: '🛠️',
    color: 0x5865F2,
    channelTag: 'tech',
    buttonStyle: ButtonStyle.Secondary,
    description: 'Bot issues, broken features, setup problems, and troubleshooting.'
  },
  {
    key: 'account_help',
    label: 'Account Help',
    emoji: '👤',
    color: 0xF1C40F,
    channelTag: 'account',
    buttonStyle: ButtonStyle.Secondary,
    description: 'Login problems, permissions, account access, and profile help.'
  },
  {
    key: 'report_issue',
    label: 'Report Issue',
    emoji: '🚨',
    color: 0xE74C3C,
    channelTag: 'report',
    buttonStyle: ButtonStyle.Danger,
    description: 'Abuse reports, suspicious behavior, or urgent server issues.'
  },
  {
    key: 'other',
    label: 'Other',
    emoji: '📌',
    color: 0x95A5A6,
    channelTag: 'other',
    buttonStyle: ButtonStyle.Secondary,
    description: 'Anything that does not fit the other support categories.'
  }
]);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Choose a ticket category and open a support ticket'),
  category: 'ticket',
  async execute(interaction) {
    await showTicketCategoryPicker(interaction, 'Choose the type of support request you want to open.');
    return true;
  },
  async handleComponent(interaction) {
    if (!interaction.isButton()) {
      return false;
    }

    if (interaction.customId === AUTO_TICKET_BUTTON_ID) {
      await showTicketCategoryPicker(interaction, 'Choose the category that best matches your request.');
      return true;
    }

    if (!interaction.customId.startsWith(TICKET_CATEGORY_BUTTON_PREFIX)) {
      return false;
    }

    const ticketCategory = getTicketCategory(interaction.customId.slice(TICKET_CATEGORY_BUTTON_PREFIX.length));
    if (!ticketCategory) {
      await interaction.reply({
        embeds: [createWarningEmbed('Unknown Category', 'That ticket category is no longer available. Please try again.')],
        flags: MessageFlags.Ephemeral
      });
      return true;
    }

    const modal = new ModalBuilder()
      .setCustomId(`${AUTO_TICKET_MODAL_PREFIX}${ticketCategory.key}`)
      .setTitle(`Open ${ticketCategory.label} Ticket`);

    const reasonInput = new TextInputBuilder()
      .setCustomId(AUTO_TICKET_REASON_FIELD_ID)
      .setLabel('What do you need help with?')
      .setStyle(TextInputStyle.Paragraph)
      .setMinLength(8)
      .setMaxLength(1000)
      .setPlaceholder(`Describe your ${ticketCategory.label.toLowerCase()} request clearly so staff can help faster.`)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));

    await interaction.showModal(modal);
    return true;
  },
  async handleModal(interaction) {
    if (!interaction.isModalSubmit() || !interaction.customId.startsWith(AUTO_TICKET_MODAL_PREFIX)) {
      return false;
    }

    await openTicket(interaction);
    return true;
  }
};

function getTicketRequestData(interaction) {
  if (typeof interaction.options?.getString === 'function') {
    return {
      reason: interaction.options.getString('reason'),
      categoryKey: interaction.options.getString('category')
    };
  }

  if (typeof interaction.fields?.getTextInputValue === 'function') {
    const categoryKey = String(interaction.customId || '').startsWith(AUTO_TICKET_MODAL_PREFIX)
      ? interaction.customId.slice(AUTO_TICKET_MODAL_PREFIX.length)
      : null;

    return {
      reason: interaction.fields.getTextInputValue(AUTO_TICKET_REASON_FIELD_ID),
      categoryKey
    };
  }

  return { reason: null, categoryKey: null };
}

function getTicketCategory(categoryKey) {
  const normalized = String(categoryKey || '').trim().toLowerCase();
  return TICKET_CATEGORIES.find((entry) => entry.key === normalized) || null;
}

function buildTicketCategoryRows() {
  const rows = [];
  for (let index = 0; index < TICKET_CATEGORIES.length; index += 3) {
    const row = new ActionRowBuilder().addComponents(
      ...TICKET_CATEGORIES.slice(index, index + 3).map((ticketCategory) => (
        new ButtonBuilder()
          .setCustomId(`${TICKET_CATEGORY_BUTTON_PREFIX}${ticketCategory.key}`)
          .setLabel(ticketCategory.label)
          .setEmoji(ticketCategory.emoji)
          .setStyle(ticketCategory.buttonStyle)
      ))
    );
    rows.push(row);
  }
  return rows;
}

async function showTicketCategoryPicker(interaction, promptText) {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎫 Open Support Ticket')
    .setDescription(promptText || 'Choose a category below, then describe your request in the next step.')
    .addFields(
      ...TICKET_CATEGORIES.map((ticketCategory) => ({
        name: `${ticketCategory.emoji} ${ticketCategory.label}`,
        value: ticketCategory.description,
        inline: false
      }))
    )
    .setFooter({ text: 'Ticket system' })
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    components: buildTicketCategoryRows(),
    flags: MessageFlags.Ephemeral
  });
}

function sanitizeChannelSegment(value, fallback = 'user') {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

  return normalized || fallback;
}

function buildTicketChannelName(ticketCategory, username) {
  const categorySegment = sanitizeChannelSegment(ticketCategory?.channelTag || ticketCategory?.key || 'other', 'other');
  const userSegment = sanitizeChannelSegment(username, 'user');
  return `ticket-${categorySegment}-${userSegment}`.slice(0, 95);
}

function normalizeReasonFingerprint(reason) {
  return String(reason || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getRegisteredTicketData(interaction) {
  if (!isTicketChannel(interaction.channel)) {
    await sendWarningReply(
      interaction,
      'Invalid Channel',
      'This command can only be used in a ticket channel!'
    );
    return null;
  }

  const ticketData = await getTicketRecordForChannel(interaction.channel);
  if (!ticketData) {
    await sendWarningReply(
      interaction,
      'Ticket Record Missing',
      'This channel is inside the ticket category but is not registered as a ticket. The command was blocked to avoid deleting or mutating the wrong channel.'
    );
    return null;
  }

  return ticketData;
}

async function openTicket(interaction) {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const requestData = getTicketRequestData(interaction);
    const reason = requestData.reason;
    const ticketCategory = getTicketCategory(requestData.categoryKey);

    if (!reason || reason.trim().length === 0) {
      return await interaction.editReply({ embeds: [createErrorEmbed('Invalid Input', 'Please provide a reason for your ticket.')] });
    }

    if (!ticketCategory) {
      return await interaction.editReply({
        embeds: [createWarningEmbed('Category Required', 'Please choose a ticket category before submitting your request.')]
      });
    }

    const cleanReason = reason.trim();
    if (cleanReason.length < 8) {
      return await interaction.editReply({
        embeds: [createWarningEmbed('More Detail Needed', 'Please provide a bit more detail (at least 8 characters).')]
      });
    }

    const guardState = await MySQLDatabaseManager.recordTicketOpenAttempt(interaction.user.id, TICKET_OPEN_WINDOW_MS);
    if (!guardState?.ok) {
      return await interaction.editReply({
        embeds: [createErrorEmbed('Ticket Guard Unavailable', 'Ticket creation is temporarily unavailable because the abuse-protection state could not be loaded. Please try again shortly.')]
      });
    }

    const attemptCount = guardState.attemptCount;
    if (attemptCount > TICKET_OPEN_MAX_ATTEMPTS) {
      return await interaction.editReply({
        embeds: [
          createWarningEmbed(
            'Too Many Ticket Attempts',
            'Please slow down. Too many ticket requests were submitted in a short period.'
          ).addFields({ name: 'Try Again In', value: `${Math.ceil(TICKET_OPEN_WINDOW_MS / 60000)} minutes`, inline: true })
        ]
      });
    }

    const lastOpenedAt = Number(guardState.lastSuccessfulOpenAt || 0);
    if (lastOpenedAt && Date.now() - lastOpenedAt < TICKET_CREATION_COOLDOWN_MS) {
      const secondsLeft = Math.ceil((TICKET_CREATION_COOLDOWN_MS - (Date.now() - lastOpenedAt)) / 1000);
      return await interaction.editReply({
        embeds: [createWarningEmbed('Ticket Cooldown Active', `Please wait ${secondsLeft}s before opening another ticket.`)]
      });
    }

    const reasonFingerprint = `${ticketCategory.key}:${normalizeReasonFingerprint(cleanReason)}`;
    if (
      guardState.lastReasonFingerprint
      && guardState.lastReasonFingerprint === reasonFingerprint
      && Date.now() - Number(guardState.lastReasonCreatedAt || 0) < DUPLICATE_REASON_WINDOW_MS
    ) {
      return await interaction.editReply({
        embeds: [
          createWarningEmbed(
            'Duplicate Ticket Detected',
            'This looks like the same request as your recent ticket attempt. Please continue in your existing ticket or wait before retrying.'
          )
        ]
      });
    }

    const categoryDisplay = `${ticketCategory.emoji} ${ticketCategory.label}`;

    const categoryChannel = interaction.guild.channels.cache.get(ticketCategoryId);
    if (!categoryChannel) {
      const errorEmbed = createErrorEmbed(
        'Category Not Found',
        `Ticket category not configured! Contact an <@&${administratorRoleId}>.`
      );
      return await interaction.editReply({ embeds: [errorEmbed] });
    }

    try {
      const existingTicket = await MySQLDatabaseManager.getActiveTicketByUserId(interaction.user.id).catch(() => null);

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

        await MySQLDatabaseManager.deleteTicket(existingTicket.channelId).catch(() => { });
      }
    } catch (err) {
      console.warn('[Ticket] Could not check existing tickets:', err.message);
    }

    const ticketChannel = await interaction.guild.channels.create({
      name: buildTicketChannelName(ticketCategory, interaction.user.username),
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

    const supportRole = interaction.guild.roles.cache.get(supportTeamRoleId);
    if (supportRole) {
      await ticketChannel.permissionOverwrites.create(supportRole, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true
      });
    } else {
      console.warn(`[Ticket] Support role not found by ID: ${supportTeamRoleId}`);
    }

    const welcomeEmbed = new EmbedBuilder()
      .setColor(ticketCategory.color)
      .setTitle(`${ticketCategory.emoji} Support Ticket Opened`)
      .setDescription(`Welcome, ${interaction.user}!\n\nYour support ticket has been created and assigned to our support team. Please provide as much detail as possible to help us assist you quickly.`)
      .addFields(
        { name: 'Status', value: '🟢 Open', inline: true },
        { name: 'Category', value: categoryDisplay, inline: true },
        { name: 'Created', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
        { name: 'Your Request', value: reason ? `\`\`\`${reason}\`\`\`` : 'No reason provided', inline: false },
        { name: 'How to Provide Info', value: '📝 Detailed description\n📸 Screenshots\n⏱️ Timing\n📎 Attach files', inline: true },
        { name: 'Support Actions', value: '✅ Review\n🔍 Clarify\n⚡ Solution\n📋 Document', inline: true },
        { name: 'Close Ticket', value: 'Use `/ticket close` when your issue is resolved. The transcript is archived automatically.', inline: false }
      )
      .setFooter({ text: '🎫 Support System • Case #' + Date.now().toString().slice(-6) })
      .setTimestamp();

    const ticketMessage = await ticketChannel.send({
      content: `${interaction.user}${supportRole ? ` | ${supportRole}` : ''}`,
      embeds: [welcomeEmbed]
    });

    const ticketSaved = await MySQLDatabaseManager.createTicket(ticketChannel.id, {
      userId: interaction.user.id,
      userName: interaction.user.tag,
      reason: cleanReason,
      categoryKey: ticketCategory.key,
      categoryLabel: ticketCategory.label,
      createdAt: Date.now(),
      claimedBy: null,
      claimedByName: null,
      status: 'open'
    });
    if (!ticketSaved) {
      await ticketChannel.delete().catch(() => { });
      throw new Error('Ticket record could not be created');
    }

    const guardUpdated = await MySQLDatabaseManager.recordSuccessfulTicketOpen(interaction.user.id, reasonFingerprint, Date.now());
    if (!guardUpdated) {
      console.warn(`[Ticket] Failed to persist successful open guard for user ${interaction.user.id}`);
    }

    const logChannel = interaction.guild.channels.cache.get(ticketLogChannelId);
    if (logChannel) {
      const logEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🎫 New Support Ticket Created')
        .setDescription(`A new support ticket has been submitted for staff review.`)
        .addFields(
          { name: 'Ticket Creator', value: `${interaction.user.tag}\n\`ID: ${interaction.user.id}\``, inline: true },
          { name: 'Category', value: categoryDisplay, inline: true },
          { name: 'Ticket Channel', value: `${ticketChannel}`, inline: false },
          { name: 'Issue Description', value: `\`\`\`${cleanReason || 'No reason provided'}\`\`\``, inline: false },
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
        { name: 'Category', value: categoryDisplay, inline: true },
        { name: 'Channel', value: `${ticketChannel}`, inline: true },
        { name: 'Your Issue', value: cleanReason ? `\`\`\`${cleanReason}\`\`\`` : 'No reason provided', inline: false },
        { name: 'What You Can Do', value: '✅ Add details\n📎 Share files\n💬 Ask questions\n⏳ Wait for support', inline: true },
        { name: 'When Done', value: 'Use `/ticket close` when the issue is resolved. Transcript logging stays automatic.', inline: true }
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
  const ticketData = await getRegisteredTicketData(interaction);
  if (!ticketData) return;

  const closeReason = interaction.options.getString('reason') || 'No reason provided';
  await interaction.reply({
    embeds: [createSuccessEmbed('Ticket Closure Started', 'The ticket transcript is being archived and this channel will be removed shortly.')]
  });

  try {
    await closeTicketChannel({
      client: interaction.client,
      channel: interaction.channel,
      closedByUser: interaction.user,
      closeReason,
      closeSource: 'slash-command'
    });
  } catch (error) {
    console.error('[Ticket] Failed to close ticket:', error?.message || error);
    await interaction.followUp({
      embeds: [createErrorEmbed('Ticket Close Failed', 'The ticket could not be closed safely because its record could not be updated. No channel deletion was performed.')],
      flags: MessageFlags.Ephemeral
    }).catch(() => { });
  }
}

async function addUserToTicket(interaction) {
  const ticketData = await getRegisteredTicketData(interaction);
  if (!ticketData) return;

  const member = interaction.member;
  const targetUser = interaction.options.getUser('user');
  const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

  if (!targetMember) {
    return sendInfoReply(
      interaction,
      'User Not Found',
      'Could not find that user in this server!'
    );
  }

  if (!hasSupportOrAdmin(member)) {
    return sendWarningReply(
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
  const ticketData = await getRegisteredTicketData(interaction);
  if (!ticketData) return;

  const member = interaction.member;
  const targetUser = interaction.options.getUser('user');
  const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

  if (!targetMember) {
    return sendInfoReply(
      interaction,
      'User Not Found',
      'Could not find that user in this server!'
    );
  }

  if (!hasSupportOrAdmin(member)) {
    return sendWarningReply(
      interaction,
      'No Permission',
      'Only support staff can remove users from tickets!'
    );
  }

  if (ticketData?.userId && ticketData.userId === targetUser.id) {
    return sendWarningReply(
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
  const ticketData = await getRegisteredTicketData(interaction);
  if (!ticketData) return;

  if (!hasSupportOrAdmin(interaction.member)) {
    return sendWarningReply(
      interaction,
      'No Permission',
      'Only support staff can claim tickets!'
    );
  }

  const ticketId = interaction.channel.id;

  if (ticketData.claimedBy && ticketData.claimedBy !== interaction.user.id) {
    const claimer = await interaction.client.users.fetch(ticketData.claimedBy).catch(() => null);
    return sendInfoReply(
      interaction,
      'Already Claimed',
      `This ticket has already been claimed by ${claimer ? claimer.tag : 'another support member'}!`
    );
  }

  const claimSaved = await MySQLDatabaseManager.updateTicket(ticketId, {
    claimedBy: interaction.user.id,
    claimedByName: interaction.user.tag,
    status: 'claimed'
  });
  if (!claimSaved) {
    return sendInfoReply(
      interaction,
      'Ticket Update Failed',
      'The ticket could not be claimed because the database record was not updated.'
    );
  }

  await updateTicketChannelAssigneeName(interaction.channel, interaction.user.username);

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

async function transferTicket(interaction) {
  const ticketData = await getRegisteredTicketData(interaction);
  if (!ticketData) return;

  if (!hasSupportOrAdmin(interaction.member)) {
    return sendWarningReply(
      interaction,
      'No Permission',
      'Only support staff can transfer tickets!'
    );
  }

  const targetUser = interaction.options.getUser('user');
  const transferReason = interaction.options.getString('reason') || 'No reason provided';
  const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

  if (!targetMember) {
    return sendInfoReply(
      interaction,
      'User Not Found',
      'Could not find that user in this server!'
    );
  }

  if (!hasSupportOrAdmin(targetMember)) {
    return sendWarningReply(
      interaction,
      'Invalid Assignee',
      'Tickets can only be transferred to support staff or admins.'
    );
  }

  if (ticketData.claimedBy === targetUser.id) {
    return sendInfoReply(
      interaction,
      'Already Assigned',
      `${targetUser} is already assigned to this ticket.`
    );
  }

  const transferSaved = await MySQLDatabaseManager.updateTicket(interaction.channel.id, {
    claimedBy: targetUser.id,
    claimedByName: targetUser.tag,
    status: 'claimed'
  });
  if (!transferSaved) {
    return sendInfoReply(
      interaction,
      'Ticket Update Failed',
      'The ticket could not be transferred because the database record was not updated.'
    );
  }

  await updateTicketChannelAssigneeName(interaction.channel, targetUser.username);

  let previousAssigneeText = 'Unassigned';
  if (ticketData.claimedBy) {
    const previousUser = await interaction.client.users.fetch(ticketData.claimedBy).catch(() => null);
    previousAssigneeText = previousUser ? previousUser.tag : `ID: ${ticketData.claimedBy}`;
  }

  const successEmbed = createSuccessEmbed(
    'Ticket Transferred',
    `This ticket has been reassigned to ${targetUser}.`
  ).addFields(
    { name: 'From', value: previousAssigneeText, inline: true },
    { name: 'To', value: `${targetUser.tag}\n\`${targetUser.id}\``, inline: true },
    { name: 'By', value: `${interaction.user.tag}\n\`${interaction.user.id}\``, inline: true },
    { name: 'Reason', value: `\`\`\`${transferReason}\`\`\``, inline: false }
  ).setTimestamp();

  await interaction.reply({ embeds: [successEmbed] });

  const notifyEmbed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🔄 Ticket Reassigned')
    .setDescription(`${targetUser} is now responsible for this ticket.`)
    .addFields(
      { name: 'Previous Assignee', value: previousAssigneeText, inline: true },
      { name: 'Reason', value: transferReason, inline: false }
    )
    .setTimestamp();

  await interaction.channel.send({ embeds: [notifyEmbed] }).catch(() => { });
}

async function markHandled(interaction) {
  if (!interaction.member.roles.cache.has(supportTeamRoleId) && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return sendWarningReply(
      interaction,
      'No Permission',
      `You need the <@&${supportTeamRoleId}> role to mark tickets as handled!`
    );
  }

  const ticketData = await getRegisteredTicketData(interaction);
  if (!ticketData) return;

  const handledSaved = await MySQLDatabaseManager.updateTicket(interaction.channel.id, {
    claimedBy: interaction.user.id,
    claimedByName: interaction.user.tag,
    status: 'waiting_user'
  });
  if (!handledSaved) {
    return sendInfoReply(
      interaction,
      'Ticket Update Failed',
      'The ticket could not be marked as handled because the database record was not updated.'
    );
  }

  await updateTicketChannelAssigneeName(interaction.channel, interaction.user.username);

  const successEmbed = createSuccessEmbed(
    'Ticket Marked as Handled',
    'The latest staff response is logged and the ticket is now waiting on the user.'
  ).addFields(
    { name: '👤 Handler', value: `${interaction.user.tag}\n\`${interaction.user.id}\``, inline: true },
    { name: '🚩 Status', value: '**Waiting on User**', inline: true },
    { name: '⏰ Marked At', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
    { name: '💡 Next Steps', value: 'If the ticket owner replies, the ticket will move back to Waiting on Staff automatically.', inline: false }
  ).setTimestamp();

  return interaction.reply({ embeds: [successEmbed] });
}

module.exports.handlers = {
  openTicket,
  closeTicket,
  addUserToTicket,
  removeUserFromTicket,
  claimTicket,
  transferTicket,
  markHandled
};