const fs = require('fs');
const path = require('path');
const { REST } = require('@discordjs/rest');
require("dotenv").config({ path: "./Config/credentials.env" });

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing TOKEN or CLIENT_ID in environment variables');
  process.exit(1);
}

const commands = [];
const commandsPath = path.join(__dirname, 'commands');

function getCommandFiles(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory() && !file.startsWith('_')) {
      getCommandFiles(filePath);
    } else if (file.endsWith('.js') && !file.startsWith('_')) {
      try {
        const command = require(filePath);
        if (command.data && command.execute) {
          commands.push(command.data.toJSON());
        }
      } catch (err) {
        console.error(`Error loading command ${filePath}:`, err.message);
      }
    }
  }
}

getCommandFiles(commandsPath);

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    console.log(`Started refreshing ${commands.length} application (/) commands.`);

    let route;
    if (GUILD_ID) {
      route = `/applications/${CLIENT_ID}/guilds/${GUILD_ID}/commands`;
    } else {
      route = `/applications/${CLIENT_ID}/commands`;
    }

    const data = await rest.put(route, { body: commands });
    console.log(`Successfully reloaded ${data.length} application (/) commands.`);
  } catch (error) {
    console.error(error);
  }
})();



