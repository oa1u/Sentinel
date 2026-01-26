require("dotenv").config({ path: "./Config/credentials.env" });
// Discord bot stuff
const { Client, Collection, GatewayIntentBits, MessageFlags, Partials } = require("discord.js");
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildEmojisAndStickers,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  presence: require("./Config/presence.json"),
});

client.commands = new Collection();
client.slashCommands = new Collection();
client.events = new Collection();
require("./events/_loader")(client).then(() =>
  client.emit("commandsAndEventsLoaded", 1)
);
require("./commands/_slashLoader")(client.slashCommands).catch((err) => {
  console.error("Error loading slash commands:", err);
});
require("./Logging/index")(client);

// Interaction handler for slash commands
client.once("clientReady", () => {
  console.log(`Bot is ready! Loaded ${client.slashCommands.size} slash commands.`);
});
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.slashCommands.get(interaction.commandName);

  if (!command) {
    console.error(`No command matching ${interaction.commandName} was found.`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: 'There was an error while executing this command!',
        flags: MessageFlags.Ephemeral
      });
    } else {
      await interaction.reply({
        content: 'There was an error while executing this command!',
        flags: MessageFlags.Ephemeral
      });
    }
  }
});

// Prevent unhandled client errors from crashing the process
client.on('error', (err) => {
  console.error('Client error:', err);
});
client.on('warn', (msg) => {
  console.warn('Client warn:', msg);
});


client.login(process.env.TOKEN);