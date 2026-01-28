require("dotenv").config({ path: "./Config/credentials.env" });
const { Client, Collection, GatewayIntentBits, MessageFlags, Partials } = require("discord.js");
const { REST } = require('@discordjs/rest');
const fs = require('fs');
const path = require('path');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildEmojisAndStickers,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  presence: require("./Config/presence.json"),
});

client.commands = new Collection();
client.slashCommands = new Collection();
client.events = new Collection();

function* getCommandFiles(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory() && !file.startsWith('_')) {
      yield* getCommandFiles(filePath);
    } else if (file.endsWith('.js') && !file.startsWith('_')) {
      yield filePath;
    }
  }
}

async function registerCommands() {
  const TOKEN = process.env.TOKEN;
  const CLIENT_ID = process.env.CLIENT_ID;
  const GUILD_ID = process.env.GUILD_ID;

  if (!TOKEN || !CLIENT_ID) {
    console.error('❌ Missing TOKEN or CLIENT_ID in environment variables');
    return false;
  }

  const commands = [];
  const commandsPath = path.join(__dirname, 'Commands');

  try {
    for (const filePath of getCommandFiles(commandsPath)) {
      try {
        const command = require(filePath);
        if (command.data) {
          commands.push(command.data.toJSON());
        }
      } catch (err) {
        console.error(`  ❌ Error loading command ${filePath}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('❌ Error scanning command directory:', err.message);
    return false;
  }

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  try {
    console.log(`\n⚙️  Registering ${commands.length} commands...`);

    const route = GUILD_ID 
      ? `/applications/${CLIENT_ID}/guilds/${GUILD_ID}/commands`
      : `/applications/${CLIENT_ID}/commands`;

    const data = await rest.put(route, { body: commands });
    console.log(`✅ ${data.length} commands registered\n`);
    return true;
  } catch (error) {
    console.error('❌ Error registering commands:', error.message);
    return false;
  }
}

async function sendCommandErrorResponse(interaction) {
  const errorMessage = {
    content: '❌ There was an error while executing this command!',
    flags: MessageFlags.Ephemeral
  };

  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(errorMessage);
    } else {
      await interaction.reply(errorMessage);
    }
  } catch (err) {
    console.error('Failed to send error response:', err.message);
  }
}

async function initializeBot() {
  console.log('\n🚀 Starting up...');
  
  await require("./Events/_loader")(client);
  
  await require("./Commands/_slashLoader")(client.slashCommands).catch((err) => {
    console.error("❌ Couldn't load commands:", err.message);
    process.exit(1);
  });
  
  const registered = await registerCommands();
  if (!registered) {
    console.warn('⚠️  Command registration failed but continuing anyway...');
  }
  
  require("./Logging/index")(client);
  restoreGiveaways(client);
  startReminderChecker(client);
}

/**
 * Start the reminder checker that runs periodically to check for pending reminders
 */
function startReminderChecker(client) {
  const { reminderCheckInterval } = require('./Config/constants/misc.json').timeouts;
  
  // Check immediately on startup
  checkPendingReminders(client);
  
  // Check every so often
  setInterval(() => {
    checkPendingReminders(client);
  }, reminderCheckInterval);
  
  console.log(`⏰ Reminder system started (checking every ${reminderCheckInterval / 1000}s)`);
}

// Check and deliver any pending reminders
async function checkPendingReminders(client) {
  try {
    const DatabaseManager = require('./Functions/DatabaseManager');
    const { EmbedBuilder } = require('discord.js');
    const moment = require('moment-timezone');
    const { reminders: reminderConfig } = require('./Config/constants/misc.json');
    
    const remindDB = DatabaseManager.getRemindersDB();
    const now = Date.now();
    
    // Get all reminders
    const allReminders = Object.values(remindDB.all());
    
    for (const reminder of allReminders) {
      // Skip if already completed
      if (reminder.completed) continue;
      
      // Skip if not yet due
      if (reminder.triggerAt > now) continue;
      
      try {
        // Initialize delivery attempt tracking
        if (!reminder.deliveryAttempts) {
          reminder.deliveryAttempts = 0;
        }
        
        // Fetch user
        const user = await client.users.fetch(reminder.userId).catch(() => null);
        if (!user) {
          console.warn(`[Remind] User not found for reminder ${reminder.id}: ${reminder.userId}`);
          reminder.completed = true;
          remindDB.set(reminder.id, reminder);
          continue;
        }
        
        // Create reminder embed
        const reminderEmbed = new EmbedBuilder()
          .setColor(0xFFD700)
          .setTitle('🔔 Reminder!')
          .setDescription(reminder.message)
          .setFooter({ text: `Set ${moment(reminder.createdAt).fromNow()}` })
          .setTimestamp();
        
        try {
          // Attempt to send reminder DM
          await user.send({ embeds: [reminderEmbed] });
          console.log(`[Remind] Reminder delivered to ${user.tag}`);
          
          // Mark as completed
          reminder.completed = true;
          remindDB.set(reminder.id, reminder);
          
          // Clean up after a delay
          setTimeout(() => {
            remindDB.delete(reminder.id);
          }, 300000); // Keep for 5 minutes then delete
          
        } catch (dmError) {
          // DM failed - implement retry logic
          reminder.deliveryAttempts++;
          reminder.lastFailureReason = dmError.message;
          reminder.lastFailureTime = Date.now();
          
          console.warn(`[Remind] DM delivery failed for ${user.tag} (attempt ${reminder.deliveryAttempts}/${reminderConfig.maxDeliveryAttempts}): ${dmError.message}`);
          
          // Check if we've exceeded max attempts
          if (reminder.deliveryAttempts >= reminderConfig.maxDeliveryAttempts) {
            console.error(`[Remind] Max delivery attempts reached for reminder ${reminder.id}`);
            
            // Try to notify in notification channel
            const notificationChannelId = reminderConfig.notificationChannelId;
            if (notificationChannelId && notificationChannelId !== 'YOUR_NOTIFICATIONS_CHANNEL_ID') {
              try {
                const channel = await client.channels.fetch(notificationChannelId).catch(() => null);
                if (channel && channel.isTextBased()) {
                  const failedEmbed = new EmbedBuilder()
                    .setColor(0xFF6B6B)
                    .setTitle('❌ Reminder Delivery Failed')
                    .setDescription(`Could not deliver reminder to <@${reminder.userId}>`)
                    .addFields(
                      { name: '💬 Message', value: reminder.message, inline: false },
                      { name: '⚠️ Reason', value: dmError.message, inline: false },
                      { name: '📝 Note', value: 'User may have DMs disabled or has left the server', inline: false }
                    )
                    .setFooter({ text: `Reminder ID: ${reminder.id}` })
                    .setTimestamp();
                  
                  await channel.send({ embeds: [failedEmbed] }).catch(() => {});
                  console.log(`[Remind] Notified staff channel about failed reminder for ${reminder.userId}`);
                }
              } catch (notifyError) {
                console.error(`[Remind] Could not send notification to staff channel: ${notifyError.message}`);
              }
            }
            
            // Mark as completed after max attempts
            reminder.completed = true;
            remindDB.set(reminder.id, reminder);
          } else {
            // Schedule retry - reset triggerAt to retry in configured minutes
            const retryDelayMs = reminderConfig.retryDelayMinutes * 60 * 1000;
            reminder.triggerAt = Date.now() + retryDelayMs;
            console.log(`[Remind] Scheduled retry for ${user.tag} in ${reminderConfig.retryDelayMinutes} minutes`);
            remindDB.set(reminder.id, reminder);
          }
        }
      } catch (error) {
        console.error(`[Remind] Error processing reminder ${reminder.id}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error('[Remind] Error in reminder checker:', error.message);
  }
}

// Load any active giveaways from the database
async function restoreGiveaways(client) {
  try {
    const DatabaseManager = require('./Functions/DatabaseManager');
    const giveawayDB = DatabaseManager.getGiveawaysDB();
    
    const allGiveaways = Object.values(giveawayDB.all());
    let restored = 0;
    
    for (const giveaway of allGiveaways) {
      if (giveaway.completed) continue;
      
      try {
        const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
        if (!channel) continue;
        
        const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
        if (!message) continue;
        
        // Calculate remaining time
        const timeRemaining = Math.max(0, giveaway.endTime - Date.now());
        
        // If giveaway has already ended, finalize it
        if (timeRemaining === 0) {
          await finalizeGiveawayFromDB(message, giveaway, client);
          restored++;
          continue;
        }
        
        // Resume countdown for giveaway
        const durationInSeconds = Math.ceil(timeRemaining / 1000);
        runGiveawayCountdown(message, giveaway.messageId, client, durationInSeconds, giveaway.prize, giveaway.hostName);
        restored++;
        console.log(`[Giveaway] ${giveaway.prize} - ${Math.ceil(timeRemaining / 1000)}s left`);
      } catch (error) {
        console.error(`[Giveaway] Couldn't restore ${giveaway.messageId}: ${error.message}`);
      }
    }
    
    if (restored > 0) {
      console.log(`[Giveaway] ${restored} giveaway${restored > 1 ? 's' : ''} restored`);
    }
  } catch (error) {
    console.error('[Giveaway] Error in giveaway restoration:', error.message);
  }
}

// End a giveaway that ended while bot was offline
async function finalizeGiveawayFromDB(message, giveaway, client) {
  try {
    const reaction = await message.reactions.cache.get('🎉');
    const users = reaction ? await reaction.users.fetch() : new Map();
    const participants = users.filter(user => !user.bot).map(user => user.username);

    let endEmbed;

    if (participants.length === 0) {
      endEmbed = {
        color: 16744171,
        title: '❌ No Winners',
        description: `━━━━━━━━━━━━━━━━━━━━━\n\nUnfortunately, nobody reacted to the **${giveaway.prize}** giveaway.\n\n**Better luck next time!** 🍀\n\n━━━━━━━━━━━━━━━━━━━━━`,
        fields: [
          { name: '🎁 Prize', value: `**${giveaway.prize}**`, inline: true },
          { name: '👥 Total Reactions', value: '0', inline: true }
        ],
        footer: { text: 'Giveaway Ended - No participants' },
        timestamp: new Date()
      };
    } else {
      const winner = participants[Math.floor(Math.random() * participants.length)];
      endEmbed = {
        color: 65280,
        title: '🏆 Giveaway Winner Announced!',
        description: `━━━━━━━━━━━━━━━━━━━━━\n\n🎉 **Congratulations ${winner}!** 🎉\n\nYou have won the **${giveaway.prize}** giveaway!\n\n━━━━━━━━━━━━━━━━━━━━━`,
        fields: [
          { name: '🎁 Prize Won', value: `**${giveaway.prize}**`, inline: true },
          { name: '🥇 Winner', value: `**${winner}**`, inline: true },
          { name: '👥 Total Participants', value: `**${participants.length}**`, inline: true },
          { name: '📊 Winning Chance', value: `**${((1 / participants.length) * 100).toFixed(2)}%**`, inline: true }
        ],
        footer: { text: '🎊 Giveaway Ended - Congratulations to the winner!' },
        timestamp: new Date()
      };
    }

    await message.edit({ embeds: [endEmbed] }).catch((err) => {
      console.error(`[Giveaway] Failed to update end embed: ${err.message}`);
    });

    // Mark as completed in database
    const DatabaseManager = require('./Functions/DatabaseManager');
    const giveawayDB = DatabaseManager.getGiveawaysDB();
    giveaway.completed = true;
    giveawayDB.set(giveaway.messageId, giveaway);

  } catch (error) {
    console.error('[Giveaway] Error finalizing restored giveaway:', error.message);
  }
}

// Update giveaway message as time counts down
async function runGiveawayCountdown(message, giveawayId, client, duration, prize, host) {
  let timeRemaining = duration;
  const updateInterval = Math.min(30, Math.max(5, Math.floor(duration / 10)));

  while (timeRemaining > 0) {
    await sleep(updateInterval * 1000);
    timeRemaining -= updateInterval;

    try {
      const reaction = message.reactions.cache.get('🎉');
      const participantCount = reaction ? reaction.count - 1 : 0;

      const countdownEmbed = {
        color: 16766680,
        title: '🎉 Giveaway in Progress!',
        description: '━━━━━━━━━━━━━━━━━━━━━\n\n⏳ **Giveaway is still running!**\n\n━━━━━━━━━━━━━━━━━━━━━',
        fields: [
          { name: '🎁 Prize', value: `**${prize}**`, inline: true },
          { name: '⏱️ Time Remaining', value: `**${toTime(timeRemaining)}**`, inline: true },
          { name: '👤 Hosted by', value: host, inline: true },
          { name: '🎪 Participants', value: `**${participantCount}** 🎯`, inline: true }
        ],
        footer: { text: '⚡ Keep reacting to participate! The winner will be selected when time runs out.' },
        timestamp: new Date()
      };

      await message.edit({ embeds: [countdownEmbed] }).catch((err) => {
        console.error(`[Giveaway] Failed to update countdown: ${err.message}`);
      });
    } catch (error) {
      console.error('Error updating giveaway:', error);
    }
  }

  // Giveaway ended
  await finalizeGiveaway(message, giveawayId, client, prize, host);
}

// Convert seconds to readable time
function toTime(seconds) {
  seconds = Number(seconds);
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  const dDisplay = d > 0 ? `${d}${d === 1 ? ' day' : ' days'}, ` : '';
  const hDisplay = h > 0 ? `${h}${h === 1 ? ' hour' : ' hours'}, ` : '';
  const mDisplay = m > 0 ? `${m}${m === 1 ? ' minute' : ' minutes'}, ` : '';
  const sDisplay = s > 0 ? `${s}${s === 1 ? ' second' : ' seconds'}` : '';
  
  const result = `${dDisplay}${hDisplay}${mDisplay}${sDisplay}`.replace(/, $/, '');
  return result || '0 seconds';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Pick winner and update giveaway message
async function finalizeGiveaway(message, giveawayId, client, prize, host) {
  try {
    const reaction = await message.reactions.cache.get('🎉');
    const users = reaction ? await reaction.users.fetch() : new Map();
    
    const participants = users.filter(user => !user.bot).map(user => user.username);

    let endEmbed;

    if (participants.length === 0) {
      endEmbed = {
        color: 16744171,
        title: '❌ No Winners',
        description: `━━━━━━━━━━━━━━━━━━━━━\n\nUnfortunately, nobody reacted to the **${prize}** giveaway.\n\n**Better luck next time!** 🍀\n\n━━━━━━━━━━━━━━━━━━━━━`,
        fields: [
          { name: '🎁 Prize', value: `**${prize}**`, inline: true },
          { name: '👥 Total Reactions', value: '0', inline: true }
        ],
        footer: { text: 'Giveaway Ended - No participants' },
        timestamp: new Date()
      };
    } else {
      const winner = participants[Math.floor(Math.random() * participants.length)];
      endEmbed = {
        color: 65280,
        title: '🏆 Giveaway Winner Announced!',
        description: `━━━━━━━━━━━━━━━━━━━━━\n\n🎉 **Congratulations ${winner}!** 🎉\n\nYou have won the **${prize}** giveaway!\n\n━━━━━━━━━━━━━━━━━━━━━`,
        fields: [
          { name: '🎁 Prize Won', value: `**${prize}**`, inline: true },
          { name: '🥇 Winner', value: `**${winner}**`, inline: true },
          { name: '👥 Total Participants', value: `**${participants.length}**`, inline: true },
          { name: '📊 Winning Chance', value: `**${((1 / participants.length) * 100).toFixed(2)}%**`, inline: true }
        ],
        footer: { text: '🎊 Giveaway Ended - Congratulations to the winner!' },
        timestamp: new Date()
      };
    }

    await message.edit({ embeds: [endEmbed] }).catch((err) => {
      console.error(`[Giveaway] Failed to update end embed: ${err.message}`);
    });

    // Mark as completed in database
    const DatabaseManager = require('./Functions/DatabaseManager');
    const giveawayDB = DatabaseManager.getGiveawaysDB();
    const giveaway = giveawayDB.get(giveawayId);
    if (giveaway) {
      giveaway.completed = true;
      giveawayDB.set(giveawayId, giveaway);
    }

  } catch (error) {
    console.error('Error finalizing giveaway:', error);
  }
}

// Interaction handler for slash commands
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.slashCommands.get(interaction.commandName);

  if (!command) {
    console.warn(`⚠️  No command matching /${interaction.commandName} was found.`);
    return;
  }

  // Rate limiting
  const RateLimiter = require('./Functions/RateLimiter');
  const { administratorRoleId, moderatorRoleId } = require('./Config/constants/roles.json');
  
  // Check if user is exempt (admins/mods)
  const isExempt = RateLimiter.isExempt(interaction.member, [administratorRoleId, moderatorRoleId]);
  
  if (!isExempt) {
    const rateLimit = RateLimiter.checkLimit(interaction.user.id, interaction.commandName);
    
    if (rateLimit.limited) {
      const errorMessage = rateLimit.type === 'global'
        ? `⏱️ You're using commands too quickly! Please wait **${rateLimit.retryAfter}s** before trying again.`
        : `⏱️ You're using this command too quickly! Please wait **${rateLimit.retryAfter}s** before using \`/${interaction.commandName}\` again.`;
      
      return interaction.reply({
        content: errorMessage,
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
    }
    
    // Record usage
    RateLimiter.recordUsage(interaction.user.id, interaction.commandName);
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`❌ Error executing command /${interaction.commandName}:`, error.message);
    await sendCommandErrorResponse(interaction);
  }
});

// Validate required environment variables
function validateEnvironment() {
  const required = {
    'TOKEN': 'Discord Bot Token',
    'CLIENT_ID': 'Discord Application ID',
    'GUILD_ID': 'Discord Server ID'
  };
  
  const missing = [];
  const empty = [];
  
  for (const [key, description] of Object.entries(required)) {
    if (!(key in process.env)) {
      missing.push(`${key} (${description})`);
    } else if (!process.env[key] || process.env[key].trim() === '') {
      empty.push(`${key} (${description})`);
    }
  }
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach(item => console.error(`   - ${item}`));
    console.error('\n📖 Please configure these in Config/credentials.env\n');
    process.exit(1);
  }
  
  if (empty.length > 0) {
    console.error('❌ Empty environment variables (must have values):');
    empty.forEach(item => console.error(`   - ${item}`));
    console.error('\n📖 Please add values in Config/credentials.env\n');
    process.exit(1);
  }
  
  console.log('✅ All required environment variables configured\n');
}

client.once("clientReady", () => {
  client.emit("commandsAndEventsLoaded", 1);
});

client.on('error', (err) => {
  console.error('❌ Client error:', err.message);
});
client.on('warn', (msg) => {
  console.warn('⚠️  Client warn:', msg);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Promise Rejection:', err);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  await client.destroy();
  process.exit(0);
});

// Start everything
(async () => {
  try {
    validateEnvironment();
    await initializeBot();
    client.login(process.env.TOKEN);
  } catch (err) {
    console.error('❌ Fatal error during startup:', err.message);
    process.exit(1);
  }
})();