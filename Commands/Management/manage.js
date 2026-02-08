const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { administratorRoleId } = require('../../Config/constants/roles.json');
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');

// Admins can view and manage reminders and giveaways with this command.
// This is the main control panel for all scheduled things.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('manage')
    .setDescription('Admin command to manage reminders and giveaways')
    .addSubcommand(subcommand =>
      subcommand
        .setName('reminders')
        .setDescription('View all pending reminders in the server')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('giveaways')
        .setDescription('View all active giveaways in the server')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('delete-reminder')
        .setDescription('Delete a specific reminder by ID')
        .addStringOption(option =>
          option.setName('id')
            .setDescription('The reminder ID to delete')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('clear-reminders')
        .setDescription('Clear all completed reminders from database')
    ),
  category: 'management',
  async execute(interaction) {
    // Only admins are allowed to use this command.
    if (!interaction.member.roles.cache.has(administratorRoleId)) {
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('🚫 Access Denied')
        .setDescription(`You don't have permission for this.\n\nOnly users with the <@&${administratorRoleId}> role can access admin commands.`)
        .setTimestamp();
      
      return await interaction.reply({ embeds: [embed], flags: 1 << 6 });
    }
    
    const subcommand = interaction.options.getSubcommand();
    
    // Figure out which subcommand the user picked and run the right function.
    if (subcommand === 'reminders') {
      await handleViewReminders(interaction);
    } else if (subcommand === 'giveaways') {
      await handleViewGiveaways(interaction);
    } else if (subcommand === 'delete-reminder') {
      await handleDeleteReminder(interaction);
    } else if (subcommand === 'clear-reminders') {
      await handleClearReminders(interaction);
    }
  }
};

// Show all reminders that haven't triggered yet.
async function handleViewReminders(interaction) {
  try {
    const remindDB = DatabaseManager.getRemindersDB();
    const allReminders = Object.values(await remindDB.all());
    const pendingReminders = allReminders.filter(r => !r.completed);
    
    if (pendingReminders.length === 0) {
      const embed = new EmbedBuilder()
        .setColor(0x7289DA)
        .setTitle('📭 No Pending Reminders')
        .setDescription('There are no pending reminders in the database.')
        .setTimestamp();
      
      return await interaction.reply({ embeds: [embed] });
    }
    
    // Sort reminders so the soonest ones are at the top.
    pendingReminders.sort((a, b) => a.triggerAt - b.triggerAt);
    
    const fields = pendingReminders.slice(0, 25).map((reminder, index) => {
      const user = reminder.userId;
      const timeRemaining = Math.max(0, reminder.triggerAt - Date.now());
      const formatted = formatDuration(timeRemaining);
      
      return {
        name: `#${index + 1} - ${formatted}`,
        value: `<@${user}> → ${reminder.message.substring(0, 60)}${reminder.message.length > 60 ? '...' : ''}\nID: \`${reminder.id}\``,
        inline: false
      };
    });
    
    const embed = new EmbedBuilder()
      .setColor(0x43B581)
      .setTitle(`⏰ All Pending Reminders (${pendingReminders.length})`)
      .addFields(...fields)
      .setFooter({ text: 'Use /manage delete-reminder <id> to remove one' })
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error('[manage.js] Error viewing reminders:', error);
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('❌ Error')
      .setDescription('Failed to load reminders. Please try again later.')
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  }
}

// Show all giveaways that are still active.
async function handleViewGiveaways(interaction) {
  try {
    const giveawayDB = DatabaseManager.getGiveawaysDB();
    const allGiveaways = Object.values(await giveawayDB.all());
    const activeGiveaways = allGiveaways.filter(g => !g.ended);
    
    if (activeGiveaways.length === 0) {
      const embed = new EmbedBuilder()
        .setColor(0x7289DA)
        .setTitle('🎁 No Active Giveaways')
        .setDescription('There are no active giveaways in the database.')
        .setTimestamp();
      
      return await interaction.reply({ embeds: [embed] });
    }
    
    // Sort giveaways so the ones ending soonest are at the top.
    activeGiveaways.sort((a, b) => a.endTime - b.endTime);
    
    const fields = activeGiveaways.slice(0, 25).map((giveaway, index) => {
      const timeRemaining = Math.max(0, giveaway.endTime - Date.now());
      const formatted = formatDuration(timeRemaining);
      let value = `Hosted by <@${giveaway.hostId}> • ${formatted}`;
      if (giveaway.guildId && giveaway.channelId && giveaway.messageId) {
        const url = `https://discord.com/channels/${giveaway.guildId}/${giveaway.channelId}/${giveaway.messageId}`;
        value += `\n[View Giveaway](${url})`;
      } else {
        value += '\nGiveaway link unavailable.';
      }
      return {
        name: `#${index + 1} - ${giveaway.prize}`,
        value,
        inline: false
      };
    });
    
    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle(`🎉 All Active Giveaways (${activeGiveaways.length})`)
      .addFields(...fields)
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error('[manage.js] Error viewing giveaways:', error);
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('❌ Error')
      .setDescription('Failed to load giveaways. Please try again later.')
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  }
}

// Delete a reminder by its ID—quick and easy.
async function handleDeleteReminder(interaction) {
  try {
    const remindDB = DatabaseManager.getRemindersDB();
    const reminderId = interaction.options.getString('id');
    
    const allReminders = Object.values(await remindDB.all());
    const reminder = allReminders.find(r => r.id === reminderId || r.id.endsWith(reminderId));
    
    if (!reminder) {
      const embed = new EmbedBuilder()
        .setColor(0xFF6B6B)
        .setTitle('❌ Reminder Not Found')
        .setDescription(`No reminder found with ID \`${reminderId}\`.`)
        .setTimestamp();
      
      return await interaction.reply({ embeds: [embed] });
    }
    
    await remindDB.delete(reminder.id);
    
    const embed = new EmbedBuilder()
      .setColor(0xFF6B6B)
      .setTitle('✅ Reminder Deleted')
      .addFields(
        { name: 'User', value: `<@${reminder.userId}>`, inline: true },
        { name: 'Message', value: reminder.message.substring(0, 100), inline: false },
        { name: 'Was Scheduled For', value: moment(reminder.triggerAt).fromNow(), inline: true }
      )
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error('[manage.js] Error deleting reminder:', error);
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('❌ Error')
      .setDescription('Failed to delete reminder. Please try again later.')
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  }
}

// Remove all reminders that are already finished.
async function handleClearReminders(interaction) {
  try {
    const remindDB = DatabaseManager.getRemindersDB();
    const allReminders = Object.values(await remindDB.all());
    const completedReminders = allReminders.filter(r => r.completed);
    
    let deleted = 0;
    for (const reminder of completedReminders) {
      try {
        await remindDB.delete(reminder.id);
        deleted++;
      } catch (err) {
        console.error(`[manage.js] Error deleting reminder ${reminder.id}:`, err);
      }
    }
    
    const embed = new EmbedBuilder()
      .setColor(0x43B581)
      .setTitle('✅ Cleanup Complete')
      .setDescription(`Deleted ${deleted} completed reminder${deleted !== 1 ? 's' : ''} from the database.`)
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error('[manage.js] Error clearing reminders:', error);
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('❌ Error')
      .setDescription('Failed to clear reminders. Please try again later.')
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  }
}

// Convert milliseconds into a human-friendly time string.
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