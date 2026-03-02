const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');
const { generateCaseId } = require('../../Events/caseId');
const moment = require('moment');

// Personal reminder system with set/list/delete subcommands
// Stores reminders in database and DMs users when time is up
module.exports = {
  data: new SlashCommandBuilder()
    .setName('reminders')
    .setDescription('Manage your personal reminders')
    .addSubcommand(subcommand =>
      subcommand
        .setName('set')
        .setDescription('Schedule a new personal reminder')
        .addStringOption(option =>
          option.setName('message')
            .setDescription('What to remind you about')
            .setRequired(true)
        )
        .addStringOption(option =>
          option.setName('time')
            .setDescription('Time until reminder (e.g., 10m, 2h, 1d)')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('View all your pending reminders')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('cancel')
        .setDescription('Cancel a specific reminder')
        .addStringOption(option =>
          option.setName('id')
            .setDescription('The reminder ID to cancel')
            .setRequired(true)
        )
    ),
  category: 'utility',
  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'set') {
      await handleSetReminder(interaction);
    } else if (subcommand === 'list') {
      await handleListReminders(interaction);
    } else if (subcommand === 'cancel') {
      await handleCancelReminder(interaction);
    }
  }
};

// Set a new reminder
async function handleSetReminder(interaction) {
  const remindDB = DatabaseManager.getRemindersDB();
  const message = interaction.options.getString('message');
  const timeString = interaction.options.getString('time');

  // Parse time string (e.g., "10m", "2h", "1d")
  const minutes = parseTimeToMinutes(timeString);

  if (!minutes || minutes < 1 || minutes > 525600) { // 525600 = 1 year in minutes
    const errorEmbed = new EmbedBuilder()
      .setColor(0xFF6B6B)
      .setTitle('❌ Invalid Time Format')
      .setDescription('Please use formats like:\n• `10m` (minutes)\n• `2h` (hours)\n• `1d` (days)\n\nMaximum: 1 year')
      .setTimestamp();

    return await interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
  }

  // Create reminder object
  const reminderId = `${interaction.user.id}-${Date.now()}`;
  const caseId = generateCaseId('REMIND', 10);
  const triggerTime = Date.now() + (minutes * 60000);
  const reminderData = {
    id: reminderId,
    caseId: caseId,
    userId: interaction.user.id,
    message: message,
    createdAt: Date.now(),
    triggerAt: triggerTime,
    channelId: interaction.channelId,
    guildId: interaction.guildId,
    completed: false,
    deliveryAttempts: 0,
    lastFailureReason: null,
    lastFailureTime: null
  };

  // Store in database (persistent) - both key-value and MySQL
  await remindDB.set(reminderId, reminderData);

  // Also save to MySQL database
  try {
    await DatabaseManager.addReminder(interaction.user.id, reminderData);
  } catch (err) {
    console.warn(`[Remind] Could not save reminder to MySQL: ${err.message}`);
  }

  const successEmbed = new EmbedBuilder()
    .setColor(0x43B581)
    .setTitle('✅ Reminder Set')
    .addFields(
      { name: '💬 Message', value: message, inline: false },
      { name: '⏰ Time', value: `${minutes} minute${minutes !== 1 ? 's' : ''} (${timeString})`, inline: true },
      { name: '🕐 Will remind at', value: moment(triggerTime).format('HH:mm:ss'), inline: true },
      { name: '🆔 Case ID', value: `\`${caseId}\``, inline: true }
    )
    .setFooter({ text: `Use '/reminders cancel ${caseId}' to remove this reminder` })
    .setTimestamp();

  await interaction.reply({ embeds: [successEmbed], flags: MessageFlags.Ephemeral });

  // Also set immediate timeout for active sessions (if within reasonable time)
  if (minutes <= 1440) { // Only for reminders <= 24 hours
    setTimeout(async () => {
      await processReminder(interaction.client, reminderData);
    }, minutes * 60000);
  }
}

// Handle listing user's reminders
async function handleListReminders(interaction) {
  const remindDB = DatabaseManager.getRemindersDB();
  const allRemindersResult = await remindDB.all();

  // Handle both Map and Object responses from database
  const allReminders = allRemindersResult instanceof Map
    ? Array.from(allRemindersResult.values())
    : Array.isArray(allRemindersResult)
      ? allRemindersResult
      : Object.values(allRemindersResult || {});

  // Filter to only this user's incomplete reminders
  const userReminders = allReminders.filter(r => r && r.userId === interaction.user.id && !r.completed);

  if (userReminders.length === 0) {
    const noRemindersEmbed = new EmbedBuilder()
      .setColor(0x7289DA)
      .setTitle('📭 No Reminders')
      .setDescription('You have no pending reminders. Use `/reminders set` to create one!')
      .setTimestamp();

    return await interaction.reply({ embeds: [noRemindersEmbed], flags: MessageFlags.Ephemeral });
  }

  // Sort by trigger time (soonest first)
  userReminders.sort((a, b) => a.triggerAt - b.triggerAt);

  const fields = userReminders.slice(0, 25).map((reminder, index) => {
    const timeRemaining = Math.max(0, reminder.triggerAt - Date.now());
    const formatted = formatDuration(timeRemaining);

    return {
      name: `#${index + 1} - ${formatted}`,
      value: `\`${reminder.caseId}\` → ${reminder.message.substring(0, 100)}${reminder.message.length > 100 ? '...' : ''}`,
      inline: false
    };
  });

  const listEmbed = new EmbedBuilder()
    .setColor(0x43B581)
    .setTitle(`⏰ Your Reminders (${userReminders.length})`)
    .addFields(...fields)
    .setFooter({ text: 'Use /reminders cancel <case-id> to remove a reminder' })
    .setTimestamp();

  await interaction.reply({ embeds: [listEmbed], flags: MessageFlags.Ephemeral });
}

// Handle canceling a reminder
async function handleCancelReminder(interaction) {
  const remindDB = DatabaseManager.getRemindersDB();
  const identifier = interaction.options.getString('id');

  // Verify identifier is a case ID (format: REMIND-XXXXXXXXXX)
  if (!identifier.startsWith('REMIND-')) {
    const invalidEmbed = new EmbedBuilder()
      .setColor(0xFF6B6B)
      .setTitle('❌ Invalid Format')
      .setDescription(`Please use the Case ID format: \`REMIND-XXXXXXXXXX\`\n\nExample: \`/reminders cancel REMIND-kX7mP9qL2n\``)
      .setFooter({ text: 'Case IDs only' })
      .setTimestamp();

    return await interaction.reply({ embeds: [invalidEmbed], flags: MessageFlags.Ephemeral });
  }

  // Find reminder by case ID only
  const allRemindersResult = await remindDB.all();

  // Handle both Map and Object responses from database
  const allReminders = allRemindersResult instanceof Map
    ? Array.from(allRemindersResult.values())
    : Array.isArray(allRemindersResult)
      ? allRemindersResult
      : Object.values(allRemindersResult || {});

  const reminder = allReminders.find(r =>
    r && r.userId === interaction.user.id && r.caseId === identifier
  );

  if (!reminder) {
    const notFoundEmbed = new EmbedBuilder()
      .setColor(0xFF6B6B)
      .setTitle('❌ Reminder Not Found')
      .setDescription(`No reminder found with Case ID \`${identifier}\`.\n\nUse \`/reminders list\` to see your reminders.`)
      .setTimestamp();

    return await interaction.reply({ embeds: [notFoundEmbed], flags: MessageFlags.Ephemeral });
  }

  if (reminder.completed) {
    const completedEmbed = new EmbedBuilder()
      .setColor(0xFF6B6B)
      .setTitle('⚠️ Reminder Already Completed')
      .setDescription('This reminder has already been delivered. It will be automatically removed from your list.')
      .setTimestamp();

    return await interaction.reply({ embeds: [completedEmbed], flags: MessageFlags.Ephemeral });
  }

  // Delete the reminder from key-value store
  await remindDB.delete(reminder.id);

  // Also delete from MySQL database
  try {
    await DatabaseManager.removeReminder(interaction.user.id, reminder.id);
  } catch (err) {
    console.warn(`[Remind] Could not delete reminder from MySQL: ${err.message}`);
  }

  const canceledEmbed = new EmbedBuilder()
    .setColor(0xFF6B6B)
    .setTitle('✅ Reminder Canceled')
    .addFields(
      { name: '💬 Message', value: reminder.message, inline: false },
      { name: '⏰ Was scheduled for', value: moment(reminder.triggerAt).fromNow(), inline: true },
      { name: '🆔 Case ID', value: `\`${reminder.caseId}\``, inline: true }
    )
    .setTimestamp();

  await interaction.reply({ embeds: [canceledEmbed], flags: MessageFlags.Ephemeral });
}

// Process a reminder and send it to the user
async function processReminder(client, reminderData) {
  try {
    const remindDB = DatabaseManager.getRemindersDB();

    // Check if reminder was already processed
    const current = await remindDB.get(reminderData.id);
    if (!current || current.completed) return;

    const user = await client.users.fetch(reminderData.userId).catch(() => null);
    if (!user) {
      console.warn(`[Remind] User not found: ${reminderData.userId}`);
      // Mark as completed even though delivery failed
      reminderData.completed = true;
      reminderData.lastFailureReason = 'User not found';
      reminderData.lastFailureTime = Date.now();
      await remindDB.set(reminderData.id, reminderData);
      return;
    }

    const reminderEmbed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle('🔔 Reminder!')
      .setDescription(reminderData.message)
      .addFields(
        { name: '📅 Set', value: moment(reminderData.createdAt).fromNow(), inline: true },
        { name: '🆔 Case ID', value: `\`${reminderData.caseId}\``, inline: true }
      )
      .setTimestamp();

    // Try to send the reminder
    try {
      await user.send({ embeds: [reminderEmbed] });
      console.log(`[Remind] Reminder delivered to ${user.tag}`);

      // Mark as completed on successful delivery
      reminderData.completed = true;
      await remindDB.set(reminderData.id, reminderData);

      // Also update MySQL database
      try {
        await DatabaseManager.addReminder(reminderData.userId, reminderData);
      } catch (err) {
        console.warn(`[Remind] Could not update reminder in MySQL: ${err.message}`);
      }
    } catch (dmError) {
      console.warn(`[Remind] Failed to send DM to ${user.tag}: ${dmError.message}`);

      // Mark as completed but with failure reason
      reminderData.completed = true;
      reminderData.deliveryAttempts = (reminderData.deliveryAttempts || 0) + 1;
      reminderData.lastFailureReason = 'DM delivery failed - user may have DMs disabled';
      reminderData.lastFailureTime = Date.now();
      await remindDB.set(reminderData.id, reminderData);

      // Try to send in the original channel as fallback if we have the info
      if (reminderData.channelId && reminderData.guildId) {
        try {
          const guild = await client.guilds.fetch(reminderData.guildId).catch(() => null);
          if (guild) {
            const channel = await guild.channels.fetch(reminderData.channelId).catch(() => null);
            if (channel) {
              const fallbackEmbed = new EmbedBuilder()
                .setColor(0xFFAA00)
                .setTitle('🔔 Reminder (DM Failed)')
                .setDescription(`<@${reminderData.userId}>, I couldn't DM you this reminder:\n\n${reminderData.message}`)
                .addFields(
                  { name: '📅 Set', value: moment(reminderData.createdAt).fromNow(), inline: true },
                  { name: '💡 Tip', value: 'Enable DMs from server members to receive reminders privately', inline: false }
                )
                .setTimestamp();

              await channel.send({ embeds: [fallbackEmbed] });
              console.log(`[Remind] Sent fallback reminder to channel for ${user.tag}`);
            }
          }
        } catch (fallbackError) {
          console.error(`[Remind] Fallback delivery also failed: ${fallbackError.message}`);
        }
      }
    }
  } catch (error) {
    console.error(`[Remind] Error processing reminder: ${error.message}`);
  }
}

// Format duration in milliseconds to readable text
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `in ${days}d ${hours % 24}h`;
  if (hours > 0) return `in ${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `in ${minutes}m`;
  return 'soon';
}

// Parse time string to minutes
// Supports: 10m, 2h, 1d, etc.
function parseTimeToMinutes(timeString) {
  const match = timeString.match(/^(\d+)([smhd])$/i);
  if (!match) return null;

  const amount = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 's': return amount;
    case 'm': return amount;
    case 'h': return amount * 60;
    case 'd': return amount * 60 * 24;
    default: return null;
  }
}