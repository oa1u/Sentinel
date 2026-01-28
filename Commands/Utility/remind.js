const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const DatabaseManager = require('../../Functions/DatabaseManager');
const moment = require('moment');

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
        .addIntegerOption(option =>
          option.setName('minutes')
            .setDescription('Minutes until reminder (1-1440)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(1440)
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
    const minutes = interaction.options.getInteger('minutes');
    
    // Create reminder object
    const reminderId = `${interaction.user.id}-${Date.now()}`;
    const triggerTime = Date.now() + (minutes * 60000);
    const reminderData = {
      id: reminderId,
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
    
    // Store in database (persistent)
    remindDB.set(reminderId, reminderData);
    
    const successEmbed = new EmbedBuilder()
      .setColor(0x43B581)
      .setTitle('✅ Reminder Set')
      .addFields(
        { name: '💬 Message', value: message, inline: false },
        { name: '⏰ Time', value: `${minutes} minute${minutes !== 1 ? 's' : ''}`, inline: true },
        { name: '🕐 Will remind at', value: moment(triggerTime).format('HH:mm:ss'), inline: true }
      )
      .setFooter({ text: `Reminder ID: ${reminderId}` })
      .setTimestamp();
    
    await interaction.reply({ embeds: [successEmbed], flags: MessageFlags.Ephemeral });
    
    // Also set immediate timeout for active sessions (if within reasonable time)
    if (minutes <= 1440) { // Only for reminders <= 24 hours
      setTimeout(async () => {
        await processReminder(interaction.client, reminderData);
      }, minutes * 60000);
    }
}

/**
 * Handle listing user's reminders
 */
async function handleListReminders(interaction) {
  const remindDB = DatabaseManager.getRemindersDB();
  const allReminders = Object.values(remindDB.all());
  
  // Filter to only this user's incomplete reminders
  const userReminders = allReminders.filter(r => r.userId === interaction.user.id && !r.completed);
  
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
      value: `\`${reminder.id.split('-')[1]}\` → ${reminder.message.substring(0, 100)}${reminder.message.length > 100 ? '...' : ''}`,
      inline: false
    };
  });
  
  const listEmbed = new EmbedBuilder()
    .setColor(0x43B581)
    .setTitle(`⏰ Your Reminders (${userReminders.length})`)
    .addFields(...fields)
    .setFooter({ text: 'Use /reminders cancel <id> to remove a reminder' })
    .setTimestamp();
  
  await interaction.reply({ embeds: [listEmbed], flags: MessageFlags.Ephemeral });
}

/**
 * Handle canceling a reminder
 */
async function handleCancelReminder(interaction) {
  const remindDB = DatabaseManager.getRemindersDB();
  const reminderId = interaction.options.getString('id');
  
  // Find reminder by ID suffix (last part after hyphen)
  const allReminders = Object.values(remindDB.all());
  const reminder = allReminders.find(r => 
    r.userId === interaction.user.id && r.id.endsWith(reminderId)
  );
  
  if (!reminder) {
    const notFoundEmbed = new EmbedBuilder()
      .setColor(0xFF6B6B)
      .setTitle('❌ Reminder Not Found')
      .setDescription(`No reminder found with ID \`${reminderId}\`.\n\nUse \`/reminders list\` to see your reminders.`)
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
  
  // Delete the reminder
  remindDB.delete(reminder.id);
  
  const canceledEmbed = new EmbedBuilder()
    .setColor(0xFF6B6B)
    .setTitle('✅ Reminder Canceled')
    .addFields(
      { name: '💬 Message', value: reminder.message, inline: false },
      { name: '⏰ Was scheduled for', value: moment(reminder.triggerAt).fromNow(), inline: true }
    )
    .setTimestamp();
  
  await interaction.reply({ embeds: [canceledEmbed], flags: MessageFlags.Ephemeral });
}

/**
 * Process a reminder and send it to the user
 */
async function processReminder(client, reminderData) {
  try {
    const remindDB = DatabaseManager.getRemindersDB();
    
    // Check if reminder was already processed
    const current = remindDB.get(reminderData.id);
    if (!current || current.completed) return;
    
    // Mark as completed
    reminderData.completed = true;
    remindDB.set(reminderData.id, reminderData);
    
    const user = await client.users.fetch(reminderData.userId).catch(() => null);
    if (!user) {
      console.warn(`[Remind] User not found: ${reminderData.userId}`);
      return;
    }
    
    const reminderEmbed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle('🔔 Reminder!')
      .setDescription(reminderData.message)
      .setFooter({ text: `Set ${moment(reminderData.createdAt).fromNow()}` })
      .setTimestamp();
    
    await user.send({ embeds: [reminderEmbed] });
    console.log(`[Remind] Reminder delivered to ${user.tag}`);
  } catch (error) {
    console.error(`[Remind] Error processing reminder: ${error.message}`);
  }
}

/**
 * Format duration in milliseconds to readable text
 */
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