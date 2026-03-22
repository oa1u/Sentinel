require("dotenv").config({ path: "./Config/credentials.env", override: false, debug: false, quiet: true });
const { Client, Collection, GatewayIntentBits, MessageFlags, Partials, PermissionFlagsBits } = require("discord.js");
const { REST } = require('@discordjs/rest');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { updateStats } = require('./Functions/botStats');
const eventLoader = require('./Events/_loader');
const JobScheduler = require('./Functions/JobScheduler');
const { ROLES, MISC, CHANNELS } = require('./Config/constants');


const { EmbedBuilder: DiscordEmbedBuilder } = require('discord.js');
let BuildersEmbedBuilder = null;
try {
  BuildersEmbedBuilder = require('@discordjs/builders').EmbedBuilder;
} catch (err) {
  BuildersEmbedBuilder = null;
}

const appName = require('./package.json')?.name || 'Bot';
const DEFAULT_EMBED_COLOR = 0x5865F2;
const DEFAULT_EMBED_FOOTER = `${appName} • System`;
const resilienceConfig = MISC?.resilience || {};
const LOGIN_MAX_ATTEMPTS = Math.max(1, Math.min(20, Number(resilienceConfig.loginMaxAttempts) || 5));
const LOGIN_BASE_RETRY_DELAY_MS = Math.max(500, Math.min(60_000, Number(resilienceConfig.loginBaseRetryDelayMs) || 2500));
const LOGIN_MAX_RETRY_DELAY_MS = Math.max(LOGIN_BASE_RETRY_DELAY_MS, Math.min(300_000, Number(resilienceConfig.loginMaxRetryDelayMs) || 30_000));
const HEALTH_CHECK_INTERVAL_MS = Math.max(15_000, Math.min(10 * 60 * 1000, Number(resilienceConfig.healthCheckIntervalMs) || 60_000));
const DB_FAILURE_THRESHOLD = Math.max(1, Math.min(10, Number(resilienceConfig.dbFailureThreshold) || 3));
const SHUTDOWN_TIMEOUT_MS = Math.max(2_000, Math.min(120_000, Number(resilienceConfig.shutdownTimeoutMs) || 15_000));
const EXIT_ON_UNHANDLED_REJECTION = resilienceConfig.exitOnUnhandledRejection !== false;
const EXIT_ON_UNCAUGHT_EXCEPTION = resilienceConfig.exitOnUncaughtException !== false;

function applyEmbedDefaults(embed) {
  if (!embed?.data) return;
  if (!embed.data.color) embed.setColor(DEFAULT_EMBED_COLOR);
  if (!embed.data.timestamp) embed.setTimestamp();
  if (!embed.data.footer?.text) embed.setFooter({ text: DEFAULT_EMBED_FOOTER });
}

function patchEmbedBuilder(EmbedBuilder) {
  if (!EmbedBuilder || EmbedBuilder.prototype.__embedDefaultsPatched) return;
  const originalToJSON = EmbedBuilder.prototype.toJSON;
  EmbedBuilder.prototype.toJSON = function (...args) {
    applyEmbedDefaults(this);
    return originalToJSON.apply(this, args);
  };
  EmbedBuilder.prototype.__embedDefaultsPatched = true;
}

patchEmbedBuilder(DiscordEmbedBuilder);
patchEmbedBuilder(BuildersEmbedBuilder);

// Create the Discord client with the intents we currently need.
// We can remove unused intents later if we want to tighten permissions.
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

const BOT_WEBHOOK_PORT = Number(process.env.BOT_WEBHOOK_PORT || 3050);
const BOT_WEBHOOK_SECRET = String(process.env.BOT_WEBHOOK_SECRET || '').trim();
const BOT_WEBHOOK_MAX_DRIFT_MS = Math.max(30_000, Math.min(15 * 60 * 1000, Number(process.env.BOT_WEBHOOK_MAX_DRIFT_MS) || 5 * 60 * 1000));

function verifyWebhookSignature(req, secret) {
  if (!secret) return false;
  const timestamp = String(req.headers['x-webhook-timestamp'] || '').trim();
  const signature = String(req.headers['x-webhook-signature'] || '').trim();
  if (!timestamp || !signature) return false;

  const tsNumber = Number(timestamp);
  if (!Number.isFinite(tsNumber)) return false;
  if (Math.abs(Date.now() - tsNumber) > BOT_WEBHOOK_MAX_DRIFT_MS) return false;

  const rawBody = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(req.body || {});
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  if (expected.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

async function dispatchWebsiteWebhook(payload) {
  if (!payload || typeof payload !== 'object') return;
  const channelId = CHANNELS?.webhookChannelId || CHANNELS?.notificationChannelId || CHANNELS?.serverLogChannelId;
  if (!channelId) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased?.()) return;

  const eventName = String(payload.event || 'website.event');
  const actor = payload.actor || 'system';
  const when = payload.timestamp || new Date().toISOString();
  let dataBlock = '';
  try {
    const json = JSON.stringify(payload.data || {}, null, 2);
    dataBlock = json.length > 900 ? `${json.slice(0, 900)}\n...` : json;
  } catch {
    dataBlock = String(payload.data || '');
  }

  const payloadField = dataBlock ? `\`\`\`json\n${dataBlock}\n\`\`\`` : 'None';

  const embed = new DiscordEmbedBuilder()
    .setTitle(`Website Webhook: ${eventName}`)
    .setDescription(`Actor: **${actor}**`)
    .addFields(
      { name: 'Timestamp', value: String(when), inline: false },
      { name: 'Source IP', value: String(payload.ipAddress || 'unknown'), inline: true },
      { name: 'User Agent', value: String(payload.userAgent || 'unknown').slice(0, 200), inline: false },
      { name: 'Payload', value: payloadField, inline: false }
    );

  channel.send({ embeds: [embed] }).catch(() => null);
}

const webhookApp = express();
webhookApp.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));

webhookApp.post('/webhooks/website', (req, res) => {
  if (!BOT_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Webhook secret not configured' });
  }
  if (!verifyWebhookSignature(req, BOT_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const payload = req.body || {};
  dispatchWebsiteWebhook(payload).catch(() => null);
  return res.json({ success: true });
});

webhookApp.listen(BOT_WEBHOOK_PORT, () => {
  if (!BOT_WEBHOOK_SECRET) {
    console.warn('⚠️ Bot webhook server started without BOT_WEBHOOK_SECRET. Requests will be rejected.');
  }
  console.log(`🔗 Bot webhook listener running on port ${BOT_WEBHOOK_PORT}`);
});

// Collections for commands, slash commands, and events - handy globals
client.commands = new Collection();
client.slashCommands = new Collection();
client.events = new Collection();
client.runtimeHealth = {
  healthCheckIntervalMs: HEALTH_CHECK_INTERVAL_MS,
  consecutiveDatabaseHealthFailures: 0,
  lastDatabaseHealthCheckAt: null,
  lastDatabaseHealth: null,
  lastDatabaseHealthError: null
};
client.jobScheduler = null;
let jobScheduler = null;
let reminderTimer = null;
let botStatsTimer = null;
let runtimeHealthTimer = null;
let runtimeHealthCheckInProgress = false;
let consecutiveDatabaseHealthFailures = 0;
let shutdownInProgress = false;
let stopCommandWatcher = null;
let pendingWatchRegistrationTimer = null;
let lastRegisteredCommandSignature = null;

function sleep(ms) {
  const safeDelay = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, safeDelay));
}

// Recursively yield command file paths (.js) from a directory.
// Files or folders that start with '_' are skipped (they're helpers/private).
function* getCommandFiles(dir) {
  const files = fs.readdirSync(dir).sort((a, b) => a.localeCompare(b));
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

function buildSlashCommandPayloadsFromCollection(collection) {
  const commands = [];
  const entries = Array.from(collection?.entries?.() || []).sort(([a], [b]) => String(a).localeCompare(String(b)));

  for (const [, command] of entries) {
    if (!command?.data || typeof command.data.toJSON !== 'function') continue;

    const json = command.data.toJSON();
    const category = command.category || 'uncategorized';

    if (!json.default_member_permissions) {
      if (category === 'moderation') {
        json.default_member_permissions = PermissionFlagsBits.ModerateMembers.toString();
      }
      if (category === 'management') {
        json.default_member_permissions = PermissionFlagsBits.Administrator.toString();
      }
    }

    commands.push(json);
  }

  return commands;
}

function createSlashCommandSignature(commands = []) {
  return JSON.stringify(Array.isArray(commands) ? commands : []);
}

// Load and register slash commands with Discord (guild-scoped when possible).
async function registerCommands({ commandsOverride = null, skipIfUnchanged = false, reason = 'manual' } = {}) {
  const TOKEN = process.env.TOKEN;
  const CLIENT_ID = process.env.CLIENT_ID;
  const GUILD_ID = process.env.GUILD_ID;

  if (!TOKEN || !CLIENT_ID) {
    console.error('🗑️Missing TOKEN or CLIENT_ID in environment variables');
    return false;
  }

  const commands = Array.isArray(commandsOverride)
    ? commandsOverride
    : buildSlashCommandPayloadsFromCollection(client.slashCommands);

  const signature = createSlashCommandSignature(commands);
  if (skipIfUnchanged && signature === lastRegisteredCommandSignature) {
    console.log(`↩️  Slash command schema unchanged, skipping registration (${reason}).`);
    return true;
  }

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  try {
    console.log(`\n⚙️  Registering ${commands.length} commands...`);

    // Register to a guild (faster propagation) if `GUILD_ID` is set; otherwise
    // register globally which can take longer to appear.
    const route = GUILD_ID
      ? `/applications/${CLIENT_ID}/guilds/${GUILD_ID}/commands`
      : `/applications/${CLIENT_ID}/commands`;

    const data = await rest.put(route, { body: commands });
    console.log(`✅ ${data.length} commands registered\n`);
    lastRegisteredCommandSignature = signature;
    return true;
  } catch (error) {
    console.error('🗑️Error registering commands:', error.message);
    return false;
  }
}

// Reply with a generic ephemeral error message when a command throws.
async function sendCommandErrorResponse(interaction) {
  const errorMessage = {
    content: '- There was an error while executing this command!',
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
  try {
    console.log('\n🚀 Starting up...');

    // Initialize MySQL connection first
    const DatabaseManager = require('./Functions/MySQLDatabaseManager');
    await DatabaseManager.initialize();

    await eventLoader(client);

    const slashLoader = require('./Commands/_slashLoader');

    await slashLoader(client.slashCommands).catch((err) => {
      console.error("- Couldn't load commands:", err.message);
      process.exit(1);
    });

    const initialCommandsPayload = buildSlashCommandPayloadsFromCollection(client.slashCommands);
    const registered = await registerCommands({ commandsOverride: initialCommandsPayload, reason: 'startup' });
    if (!registered) {
      console.warn('⚠️  Command registration failed but continuing anyway...');
    }

    const commandWatchMode = String(process.env.COMMANDS_WATCH_MODE || '').toLowerCase() === 'true';
    if (commandWatchMode && typeof slashLoader.createCommandWatcher === 'function') {
      const watchRegisterCooldownMs = Math.max(250, Number(process.env.COMMANDS_REGISTER_COOLDOWN_MS) || 2000);
      let lastWatchRegisterAt = 0;

      const runWatchRegistration = async (event) => {
        const commandsPayload = buildSlashCommandPayloadsFromCollection(client.slashCommands);
        const syncOk = await registerCommands({ commandsOverride: commandsPayload, skipIfUnchanged: true, reason: event });
        if (!syncOk) {
          console.warn(`⚠️  Slash command re-registration failed after reload (${event}).`);
          return;
        }
        lastWatchRegisterAt = Date.now();
      };

      stopCommandWatcher = slashLoader.createCommandWatcher({
        collection: client.slashCommands,
        watchDir: './Commands',
        debounceMs: Number(process.env.COMMANDS_WATCH_DEBOUNCE_MS) || 500,
        onReload: async ({ event, result }) => {
          console.log(`🔄 Reloaded slash commands (${event}) -> loaded=${result.loaded}, errors=${result.errors}`);
          if (result?.errors > 0) {
            console.warn('⚠️  Skipping slash command registration because loader reported errors.');
            return;
          }

          const elapsed = Date.now() - lastWatchRegisterAt;
          if (elapsed < watchRegisterCooldownMs) {
            const waitMs = watchRegisterCooldownMs - elapsed;
            console.log(`⏳ Slash registration cooldown active (${waitMs}ms remaining) after ${event}; scheduling deferred sync.`);
            if (pendingWatchRegistrationTimer) {
              clearTimeout(pendingWatchRegistrationTimer);
            }
            pendingWatchRegistrationTimer = setTimeout(() => {
              pendingWatchRegistrationTimer = null;
              console.log(`🕒 Running deferred slash registration sync (trigger: ${event}).`);
              runWatchRegistration(`cooldown:${event}`).catch((error) => {
                console.warn('⚠️  Deferred slash registration failed:', error?.message || error);
              });
            }, waitMs);
            return;
          }

          await runWatchRegistration(event);
        }
      });
    }

    require("./Logging/index")(client);
    restoreGiveaways(client);
    startReminderChecker(client);

    jobScheduler = new JobScheduler(client);
    await jobScheduler.start();
    client.jobScheduler = jobScheduler;
  } catch (error) {
    console.error('🗑️Fatal error during bot initialization:', error);
    process.exit(1);
  }
}

/**
 * Start the periodic reminder checker. Runs once immediately and then on an interval.
 * Responsible for delivering due reminders (DMs) and retrying or notifying staff on failures.
 */
function startReminderChecker(client) {
  const { reminderCheckInterval } = MISC.timeouts;

  // Check immediately on startup
  checkPendingReminders(client);

  // Check every so often
  reminderTimer = setInterval(() => {
    checkPendingReminders(client);
  }, reminderCheckInterval);

  if (typeof reminderTimer.unref === 'function') {
    reminderTimer.unref();
  }

  console.log(`⏰ Reminder system started (checking every ${reminderCheckInterval / 1000}s)`);
}

function startRuntimeHealthMonitor() {
  if (runtimeHealthTimer) {
    clearInterval(runtimeHealthTimer);
    runtimeHealthTimer = null;
  }

  runtimeHealthTimer = setInterval(async () => {
    if (runtimeHealthCheckInProgress || shutdownInProgress) return;
    runtimeHealthCheckInProgress = true;

    try {
      const DatabaseManager = require('./Functions/MySQLDatabaseManager');
      const health = await DatabaseManager.getDatabaseHealth();

      if (health?.ok) {
        if (consecutiveDatabaseHealthFailures > 0) {
          console.log('✅ Database health restored');
        }
        consecutiveDatabaseHealthFailures = 0;
      } else {
        consecutiveDatabaseHealthFailures += 1;
        console.warn(
          `⚠️  Database health check failed (${consecutiveDatabaseHealthFailures}/${DB_FAILURE_THRESHOLD})${health?.error ? `: ${health.error}` : ''}`
        );

        if (consecutiveDatabaseHealthFailures >= DB_FAILURE_THRESHOLD) {
          console.warn('♻️  Attempting database reconnection...');
          const reinitialized = await DatabaseManager.initialize();
          if (reinitialized) {
            consecutiveDatabaseHealthFailures = 0;
            console.log('✅ Database reconnection successful');
          } else {
            console.error('🗑️Database reconnection attempt failed');
          }
        }
      }

      client.runtimeHealth.consecutiveDatabaseHealthFailures = consecutiveDatabaseHealthFailures;
      client.runtimeHealth.lastDatabaseHealthCheckAt = Date.now();
      client.runtimeHealth.lastDatabaseHealth = Boolean(health?.ok);
      client.runtimeHealth.lastDatabaseHealthError = health?.error || null;

      if (typeof client.ws?.ping === 'number' && client.ws.ping > 15_000) {
        console.warn(`⚠️  High Discord gateway ping detected: ${client.ws.ping}ms`);
      }
    } catch (error) {
      consecutiveDatabaseHealthFailures += 1;
      client.runtimeHealth.consecutiveDatabaseHealthFailures = consecutiveDatabaseHealthFailures;
      client.runtimeHealth.lastDatabaseHealthCheckAt = Date.now();
      client.runtimeHealth.lastDatabaseHealth = false;
      client.runtimeHealth.lastDatabaseHealthError = error?.message || 'Runtime health check failed';
      console.error('[Health] Runtime health check failed:', error.message || error);
    } finally {
      runtimeHealthCheckInProgress = false;
    }
  }, HEALTH_CHECK_INTERVAL_MS);

  if (typeof runtimeHealthTimer.unref === 'function') {
    runtimeHealthTimer.unref();
  }

  console.log(`🩺 Runtime health monitor started (${HEALTH_CHECK_INTERVAL_MS / 1000}s interval)`);
}

async function loginWithRetry(clientInstance, token) {
  let attempt = 0;
  let delayMs = LOGIN_BASE_RETRY_DELAY_MS;

  while (attempt < LOGIN_MAX_ATTEMPTS) {
    attempt += 1;
    try {
      await clientInstance.login(token);
      if (attempt > 1) {
        console.log(`✅ Discord login succeeded on attempt ${attempt}/${LOGIN_MAX_ATTEMPTS}`);
      }
      return true;
    } catch (error) {
      const isFinal = attempt >= LOGIN_MAX_ATTEMPTS;
      console.error(`- Discord login failed (attempt ${attempt}/${LOGIN_MAX_ATTEMPTS}): ${error.message}`);

      if (isFinal) {
        throw error;
      }

      await sleep(delayMs);
      delayMs = Math.min(LOGIN_MAX_RETRY_DELAY_MS, delayMs * 2);
    }
  }

  return false;
}

async function gracefulShutdown(reason = 'shutdown', exitCode = 0) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  console.log(`\n🛑 Shutting down (${reason})...`);

  const shutdownTask = (async () => {
    try {
      if (runtimeHealthTimer) {
        clearInterval(runtimeHealthTimer);
        runtimeHealthTimer = null;
      }

      if (reminderTimer) {
        clearInterval(reminderTimer);
        reminderTimer = null;
      }

      if (botStatsTimer) {
        clearInterval(botStatsTimer);
        botStatsTimer = null;
      }

      if (jobScheduler && typeof jobScheduler.stop === 'function') {
        jobScheduler.stop();
      }

      if (typeof stopCommandWatcher === 'function') {
        stopCommandWatcher();
        stopCommandWatcher = null;
      }

      if (pendingWatchRegistrationTimer) {
        clearTimeout(pendingWatchRegistrationTimer);
        pendingWatchRegistrationTimer = null;
      }

      if (client && typeof client.destroy === 'function') {
        await client.destroy().catch(() => { });
      }

      try {
        const DatabaseManager = require('./Functions/MySQLDatabaseManager');
        if (DatabaseManager?.connection?.close) {
          await DatabaseManager.connection.close();
        }
      } catch (closeError) {
        console.warn('⚠️  Failed to close database connection cleanly:', closeError.message);
      }
    } catch (error) {
      console.error('🗑️Error during graceful shutdown:', error.message || error);
    }
  })();

  await Promise.race([
    shutdownTask,
    sleep(SHUTDOWN_TIMEOUT_MS)
  ]);

  process.exit(exitCode);
}

// Process pending reminders from the database and deliver them when due.
async function checkPendingReminders(client) {
  try {
    const DatabaseManager = require('./Functions/MySQLDatabaseManager');
    const { EmbedBuilder } = require('discord.js');
    const moment = require('moment-timezone');
    const { reminders: reminderConfig } = MISC;

    const remindDB = DatabaseManager.getRemindersDB();
    const now = Date.now();

    // Get all reminders
    const allReminders = Object.values(await remindDB.all());

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
          console.log(`[Remind] User not found for reminder ${reminder.id}: ${reminder.userId}`);
          reminder.completed = true;
          await remindDB.set(reminder.id, reminder);
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
          // Attempt to send reminder DM first - mark as completed ONLY after successful send
          await user.send({ embeds: [reminderEmbed] });
          console.log(`[Remind] Reminder delivered to ${user.tag}`);

          // ONLY mark as completed AFTER successful send to prevent race conditions
          reminder.completed = true;
          await remindDB.set(reminder.id, reminder);

          // Clean up after a delay
          setTimeout(async () => {
            await remindDB.delete(reminder.id);
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
            const notificationChannelId = CHANNELS.notificationChannelId;
            if (notificationChannelId && notificationChannelId !== 'YOUR_NOTIFICATIONS_CHANNEL_ID') {
              try {
                const channel = await client.channels.fetch(notificationChannelId).catch(() => null);
                if (channel && channel.isTextBased()) {
                  const failedEmbed = new EmbedBuilder()
                    .setColor(0xFF6B6B)
                    .setTitle('- Reminder Delivery Failed')
                    .setDescription(`Could not deliver reminder to <@${reminder.userId}>`)
                    .addFields(
                      { name: '💬 Message', value: reminder.message, inline: false },
                      { name: '⚠️ Reason', value: dmError.message, inline: false },
                      { name: '📝 Note', value: 'User may have DMs disabled or has left the server', inline: false }
                    )
                    .setFooter({ text: `Reminder ID: ${reminder.id}` })
                    .setTimestamp();

                  await channel.send({ embeds: [failedEmbed] }).catch(sendErr => {
                    console.error(`[Remind] Failed to notify staff channel: ${sendErr.message}`);
                  });
                  console.log(`[Remind] Notified staff channel about failed reminder for ${reminder.userId}`);
                }
              } catch (notifyError) {
                console.error(`[Remind] Could not send notification to staff channel: ${notifyError.message}`);
              }
            }

            // Mark as completed after max attempts
            reminder.completed = true;
            await remindDB.set(reminder.id, reminder);
          } else {
            // Schedule retry - reset triggerAt to retry in configured minutes
            const retryDelayMs = reminderConfig.retryDelayMinutes * 60 * 1000;
            reminder.triggerAt = Date.now() + retryDelayMs;
            console.log(`[Remind] Scheduled retry for ${user.tag} in ${reminderConfig.retryDelayMinutes} minutes`);
            await remindDB.set(reminder.id, reminder);
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

// Restore active giveaways from the database and resume their countdowns.
async function restoreGiveaways(client) {
  try {
    const DatabaseManager = require('./Functions/MySQLDatabaseManager');
    const giveawayDB = DatabaseManager.getGiveawaysDB();

    const allGiveaways = Object.values(await giveawayDB.all());
    let restored = 0;
    let invalid = 0;

    if (!allGiveaways || allGiveaways.length === 0) {
      return;
    }

    for (const giveaway of allGiveaways) {
      if (!giveaway || giveaway.completed) continue;

      // Ensure giveaway has all required fields; delete invalid entries to avoid buildup.
      if (!giveaway.channelId || !giveaway.messageId || !giveaway.endTime || !giveaway.prize) {
        console.log(`[Giveaway] Invalid giveaway data, cleaning up: ${JSON.stringify(giveaway)}`);
        // DELETE invalid giveaway from database to prevent accumulation
        try {
          await giveawayDB.delete(giveaway.id || giveaway.messageId);
          invalid++;
        } catch (deleteErr) {
          console.error(`[Giveaway] Failed to delete invalid entry: ${deleteErr.message}`);
        }
        continue;
      }

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
  } catch (error) {
    console.error('[Giveaway] Error in giveaway restoration:', error.message);
  }
}

// End a giveaway that ended while bot was offline
async function finalizeGiveawayFromDB(message, giveaway, client) {
  try {
    let participants = Array.isArray(giveaway?.entries) ? [...new Set(giveaway.entries)] : [];
    const winnerCount = Math.max(1, Number(giveaway?.winnerCount || 1));

    // Check if message and reactions exist
    if (message && message.reactions && message.reactions.cache) {
      const reaction = message.reactions.cache.get('🎉');

      if (reaction && participants.length === 0) {
        try {
          const users = await reaction.users.fetch();
          participants = users.filter(user => !user.bot).map(user => user.id);
        } catch (err) {
          console.error('[Giveaway] Could not fetch reaction users:', err.message);
        }
      }
    } else {
      console.warn('[Giveaway] Message reactions not available for finalization');
    }

    // Ensure the message can be edited. If not, mark the giveaway completed to
    // avoid retry loops; don't attempt to edit a non-editable object.
    if (!message || typeof message.edit !== 'function') {
      console.warn('[Giveaway] Cannot finalize - message object is invalid or missing edit method');

      // Mark as completed anyway to prevent retry loops - but don't try to save if we don't have valid data
      if (giveaway && (giveaway.messageId || giveaway.id)) {
        try {
          const DatabaseManager = require('./Functions/MySQLDatabaseManager');
          const giveawayDB = DatabaseManager.getGiveawaysDB();
          giveaway.completed = true;
          giveaway.ended = true;
          const giveawayId = giveaway.id || giveaway.messageId;
          await giveawayDB.set(giveawayId, giveaway);
        } catch (err) {
          console.error('[Giveaway] Could not mark as completed:', err.message);
        }
      }
      return;
    }

    let endEmbed;

    if (participants.length === 0) {
      endEmbed = {
        color: 16744171,
        title: '- No Winners',
        description: `━━━━━━━━━━━━━━━━━━━━━\n\nUnfortunately, nobody reacted to the **${giveaway.prize}** giveaway.\n\n**Better luck next time!** 🍀\n\n━━━━━━━━━━━━━━━━━━━━━`,
        fields: [
          { name: '🎁 Prize', value: `**${giveaway.prize}**`, inline: true },
          { name: '👥 Total Reactions', value: '0', inline: true }
        ],
        footer: { text: 'Giveaway Ended - No participants' },
        timestamp: new Date()
      };
    } else {
      const shuffled = [...participants].sort(() => Math.random() - 0.5);
      const winnerIds = shuffled.slice(0, Math.min(winnerCount, shuffled.length));
      const winnerMentions = winnerIds.map((id) => `<@${id}>`).join('\n');
      endEmbed = {
        color: 65280,
        title: winnerIds.length > 1 ? '🏆 Giveaway Winners Announced!' : '🏆 Giveaway Winner Announced!',
        description: `━━━━━━━━━━━━━━━━━━━━━\n\n🎉 **Congratulations!** 🎉\n\nYou won the **${giveaway.prize}** giveaway!\n\n━━━━━━━━━━━━━━━━━━━━━`,
        fields: [
          { name: '🎁 Prize Won', value: `**${giveaway.prize}**`, inline: true },
          { name: winnerIds.length > 1 ? '🥇 Winners' : '🥇 Winner', value: winnerMentions.slice(0, 1024), inline: false },
          { name: '👥 Total Participants', value: `**${participants.length}**`, inline: true },
          { name: '🏆 Winner Count', value: `**${winnerIds.length}**`, inline: true }
        ],
        footer: { text: '🎊 Giveaway Ended - Congratulations to the winner!' },
        timestamp: new Date()
      };

      giveaway.winnerIds = winnerIds;
    }

    await message.edit({ embeds: [endEmbed] }).catch((err) => {
      console.error(`[Giveaway] Failed to update end embed: ${err.message}`);
    });

    // Mark as completed in database
    try {
      const DatabaseManager = require('./Functions/MySQLDatabaseManager');
      const giveawayDB = DatabaseManager.getGiveawaysDB();
      giveaway.completed = true;
      giveaway.ended = true;
      const giveawayId = giveaway.id || giveaway.messageId;

      if (giveawayId) {
        await giveawayDB.set(giveawayId, giveaway);
      } else {
        console.warn('[Giveaway] Cannot save - no valid ID found');
      }
    } catch (err) {
      console.error('[Giveaway] Error saving completed status:', err.message);
    }

  } catch (error) {
    console.error('[Giveaway] Error finalizing restored giveaway:', error.message);
  }
}

// Update the giveaway message periodically while the countdown runs.
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

// Format a duration given in seconds into a human-friendly string.
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

// Select a giveaway winner (random) and update the end embed accordingly.
async function finalizeGiveaway(message, giveawayId, client, prize, host) {
  try {
    const DatabaseManager = require('./Functions/MySQLDatabaseManager');
    const giveawayDB = DatabaseManager.getGiveawaysDB();
    const giveaway = await giveawayDB.get(giveawayId);

    let participants = Array.isArray(giveaway?.entries) ? [...new Set(giveaway.entries)] : [];
    const winnerCount = Math.max(1, Number(giveaway?.winnerCount || 1));

    if (participants.length === 0) {
      const reaction = await message.reactions.cache.get('🎉');
      const users = reaction ? await reaction.users.fetch() : new Map();
      participants = users.filter(user => !user.bot).map(user => user.id);
    }

    let endEmbed;

    if (participants.length === 0) {
      endEmbed = {
        color: 16744171,
        title: '- No Winners',
        description: `━━━━━━━━━━━━━━━━━━━━━\n\nUnfortunately, nobody reacted to the **${prize}** giveaway.\n\n**Better luck next time!** 🍀\n\n━━━━━━━━━━━━━━━━━━━━━`,
        fields: [
          { name: '🎁 Prize', value: `**${prize}**`, inline: true },
          { name: '👥 Total Reactions', value: '0', inline: true }
        ],
        footer: { text: 'Giveaway Ended - No participants' },
        timestamp: new Date()
      };
    } else {
      const shuffled = [...participants].sort(() => Math.random() - 0.5);
      const winnerIds = shuffled.slice(0, Math.min(winnerCount, shuffled.length));
      const winnerMentions = winnerIds.map((id) => `<@${id}>`).join('\n');
      endEmbed = {
        color: 65280,
        title: winnerIds.length > 1 ? '🏆 Giveaway Winners Announced!' : '🏆 Giveaway Winner Announced!',
        description: `━━━━━━━━━━━━━━━━━━━━━\n\n🎉 **Congratulations!** 🎉\n\nYou have won the **${prize}** giveaway!\n\n━━━━━━━━━━━━━━━━━━━━━`,
        fields: [
          { name: '🎁 Prize Won', value: `**${prize}**`, inline: true },
          { name: winnerIds.length > 1 ? '🥇 Winners' : '🥇 Winner', value: winnerMentions.slice(0, 1024), inline: false },
          { name: '👥 Total Participants', value: `**${participants.length}**`, inline: true },
          { name: '🏆 Winner Count', value: `**${winnerIds.length}**`, inline: true }
        ],
        footer: { text: '🎊 Giveaway Ended - Congratulations to the winner!' },
        timestamp: new Date()
      };

      if (giveaway) {
        giveaway.winnerIds = winnerIds;
      }
    }

    await message.edit({ embeds: [endEmbed] }).catch((err) => {
      console.error(`[Giveaway] Failed to update end embed: ${err.message}`);
    });

    // Mark as completed in database
    if (giveaway) {
      giveaway.completed = true;
      giveaway.ended = true;
      await giveawayDB.set(giveawayId, giveaway);
    }

  } catch (error) {
    console.error('Error finalizing giveaway:', error);
  }
}

// Handle slash command interactions: permission checks, rate limiting, execution.
client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) {
    try {
      const announceCommand = client.slashCommands.get('announce');
      if (announceCommand && typeof announceCommand.handleComponent === 'function') {
        const handled = await announceCommand.handleComponent(interaction);
        if (handled) return;
      }
    } catch (error) {
      console.error('🗑️Error handling button interaction:', error.message || error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: '- There was an error while processing that button.',
          flags: MessageFlags.Ephemeral
        }).catch(() => { });
      }
      return;
    }
  }

  if (!interaction.isChatInputCommand()) return;

  const command = client.slashCommands.get(interaction.commandName);

  if (!command) {
    console.warn(`⚠️  No command matching /${interaction.commandName} was found.`);
    return;
  }

  // Rate limiting
  const RateLimiter = require('./Functions/RateLimiter');
  const { administratorRoleId, moderatorRoleId } = ROLES;
  const DatabaseManager = require('./Functions/MySQLDatabaseManager');

  // Role and permission checks for moderation/management commands
  const category = command.category || 'uncategorized';
  const member = interaction.member;

  const logInteraction = async (status, errorMessage = null) => {
    try {
      await DatabaseManager.logUserInteraction({
        userId: interaction.user?.id,
        username: interaction.user?.username,
        commandName: interaction.commandName,
        commandCategory: category,
        guildId: interaction.guild?.id,
        channelId: interaction.channelId,
        status,
        errorMessage
      });
    } catch (err) {
      // Avoid blocking command flow on logging issues
    }
  };
  if (category === 'moderation' || category === 'management') {
    const hasModeratorRole = member?.roles?.cache?.has(moderatorRoleId);
    const hasAdminRole = member?.roles?.cache?.has(administratorRoleId);
    const hasModeratePermission = member?.permissions?.has('ModerateMembers');
    const hasAdminPermission = member?.permissions?.has('Administrator');

    const roleAllowed = category === 'management' ? hasAdminRole : (hasAdminRole || hasModeratorRole);
    const permissionAllowed = category === 'management' ? hasAdminPermission : (hasAdminPermission || hasModeratePermission);

    if (!roleAllowed || !permissionAllowed) {
      await logInteraction('PERMISSION', 'Missing required role or permissions');
      return interaction.reply({
        content: '- You do not have the required role and permissions for this command.',
        flags: MessageFlags.Ephemeral
      }).catch(() => { });
    }
  }

  // Determine if the user is exempt from rate limits (admins/mods).
  const isExempt = RateLimiter.isExempt(interaction.member, [administratorRoleId, moderatorRoleId]);

  if (!isExempt) {
    const rateLimit = RateLimiter.checkLimit(interaction.user.id, interaction.commandName);

    if (rateLimit.limited) {
      const errorMessage = rateLimit.type === 'global'
        ? `⏱️ You're using commands too quickly! Please wait **${rateLimit.retryAfter}s** before trying again.`
        : `⏱️ You're using this command too quickly! Please wait **${rateLimit.retryAfter}s** before using \`/${interaction.commandName}\` again.`;

      await logInteraction('RATE_LIMIT', errorMessage);
      return interaction.reply({
        content: errorMessage,
        flags: MessageFlags.Ephemeral
      }).catch(() => { });
    }

    // Record usage
    RateLimiter.recordUsage(interaction.user.id, interaction.commandName);
  }

  try {
    await command.execute(interaction);
    await logInteraction('SUCCESS');
  } catch (error) {
    console.error(`- Error executing command /${interaction.commandName}:`, error.message);
    await logInteraction('ERROR', error.message);
    await sendCommandErrorResponse(interaction);
  }
});

// Make sure required environment variables exist and have values; exit with
// clear instructions if anything is missing.
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
    console.error('🗑️Missing required environment variables:');
    missing.forEach(item => console.error(`   - ${item}`));
    console.error('\n📖 Please configure these in Config/credentials.env\n');
    process.exit(1);
  }

  if (empty.length > 0) {
    console.error('🗑️Empty environment variables (must have values):');
    empty.forEach(item => console.error(`   - ${item}`));
    console.error('\n📖 Please add values in Config/credentials.env\n');
    process.exit(1);
  }

  console.log('✅ All required environment variables configured\n');
}

client.once("clientReady", () => {
  client.emit("commandsAndEventsLoaded", 1);

  // Send bot stats immediately on ready, then update every 30 seconds.
  const updateBotStats = () => {
    try {
      const guildCount = client.guilds.cache.size;
      let totalMembers = 0;
      let botMembers = 0;

      // Count total members and bots
      client.guilds.cache.forEach(guild => {
        totalMembers += guild.memberCount;
        // Count bots in this guild
        guild.members.cache.forEach(member => {
          if (member.user.bot) botMembers++;
        });
      });

      const totalRoles = client.guilds.cache.reduce((acc, guild) => acc + guild.roles.cache.size, 0);
      const totalChannels = client.guilds.cache.reduce((acc, guild) => acc + guild.channels.cache.size, 0);
      const totalEmojis = client.guilds.cache.reduce((acc, guild) => acc + guild.emojis.cache.size, 0);

      updateStats({
        uptime: Math.floor(client.uptime / 1000), // Convert to seconds
        guildCount: guildCount,
        totalMembers: totalMembers,
        botMembers: botMembers,
        totalRoles: totalRoles,
        totalChannels: totalChannels,
        totalEmojis: totalEmojis,
        commandsLoaded: client.slashCommands.size,
        eventsLoaded: eventLoader.getEventCount()
      });
    } catch (err) {
      console.error('Error updating bot stats:', err.message);
    }
  };

  // Update immediately on ready
  updateBotStats();

  // Then update every 30 seconds
  botStatsTimer = setInterval(updateBotStats, 30000);
  if (typeof botStatsTimer.unref === 'function') {
    botStatsTimer.unref();
  }
});

client.on('error', (err) => {
  console.error('🗑️Client error:', err.message);
});
client.on('warn', (msg) => {
  console.warn('⚠️  Client warn:', msg);
});
client.on('shardDisconnect', (event, shardId) => {
  console.warn(`⚠️  Shard ${shardId} disconnected (code: ${event?.code ?? 'unknown'})`);
});
client.on('shardReconnecting', (shardId) => {
  console.warn(`♻️  Shard ${shardId} reconnecting...`);
});
client.on('shardResume', (shardId, replayedEvents) => {
  console.log(`✅ Shard ${shardId} resumed (${replayedEvents} replayed events)`);
});

// Log unhandled promise rejections and optionally exit to avoid inconsistent state.
process.on('unhandledRejection', async (err) => {
  console.error('🗑️Unhandled Promise Rejection:', err);
  if (EXIT_ON_UNHANDLED_REJECTION) {
    await gracefulShutdown('unhandledRejection', 1);
  }
});

// Log uncaught exceptions and optionally exit to prevent the bot from running in a bad state.
process.on('uncaughtException', async (err) => {
  console.error('🗑️Uncaught Exception:', err);
  if (EXIT_ON_UNCAUGHT_EXCEPTION) {
    await gracefulShutdown('uncaughtException', 1);
  }
});

// Graceful shutdown on SIGINT: destroy the client and exit cleanly.
process.on('SIGINT', async () => {
  await gracefulShutdown('SIGINT', 0);
});

process.on('SIGTERM', async () => {
  await gracefulShutdown('SIGTERM', 0);
});

// Start everything
(async () => {
  try {
    validateEnvironment();
    await initializeBot();
    await loginWithRetry(client, process.env.TOKEN);
    startRuntimeHealthMonitor();

    // Start admin panel if enabled
    if (process.env.ENABLE_ADMIN_PANEL !== 'false') {
      try {
        const adminPanel = require('./adminPanel');
        if (typeof adminPanel.setDiscordClient === 'function') {
          adminPanel.setDiscordClient(client);
        }
        console.log('Admin Panel: Enabled');
      } catch (err) {
        console.warn('⚠️  Admin panel could not start:', err.message);
      }
    }
  } catch (err) {
    console.error('🗑️Fatal error during startup:', err.message);
    process.exit(1);
  }
})();