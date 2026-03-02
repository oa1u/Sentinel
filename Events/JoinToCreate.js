const { ChannelType, PermissionFlagsBits } = require("discord.js");
const MySQLDatabaseManager = require("../Functions/MySQLDatabaseManager");
const { joinToCreateChannelId, joinToCreateCategoryId } = require("../Config/constants/channel.json");
const { serverID } = require("../Config/main.json");

// Join-to-Create (JTC): when users join the lobby channel, we create a private temporary voice room for them.
// When the room becomes empty, it is automatically removed to keep things tidy.
module.exports = {
  name: "voiceStateUpdate",
  runOnce: false,
  call: async (client, args) => {
    const [oldState, newState] = args;

    // If there's no old/new state, ignore — nothing for us to do.
    if (!oldState && !newState) return;

    const oldChannelId = oldState?.channelId;
    const newChannelId = newState?.channelId;

    // If the user joined a channel, create a temp room when they entered the JTC lobby.
    if (!oldChannelId && newChannelId) {
      if (newChannelId !== joinToCreateChannelId) return;
      await createTempChannel(newState);
      return;
    }

    // If the user left a channel, clean up the temp JTC room if it's now empty.
    if (oldChannelId && !newChannelId) {
      const jtcData = await MySQLDatabaseManager.getJTCChannel(oldChannelId);
      if (jtcData) {
        const vc = oldState.guild.channels.cache.get(jtcData.channel_id);
        if (!vc) {
          await MySQLDatabaseManager.deleteJTCChannel(oldChannelId);
          return;
        }
        if (vc.members.size < 1) {
          await MySQLDatabaseManager.deleteJTCChannel(oldChannelId);
          vc.delete().catch(err => {
            console.error(`[JoinToCreate] Failed to delete empty voice channel: ${err.message}`);
          });
        }
      }
      return;
    }

    // When a user moves channels, handle creating or cleaning up JTC channels as appropriate.
    if (oldChannelId && newChannelId && oldChannelId !== newChannelId) {
      if (newChannelId === joinToCreateChannelId) {
        await createTempChannel(newState);
      }

      // If they left a temp channel, clean it up if it's empty.
      const jtcData = await MySQLDatabaseManager.getJTCChannel(oldChannelId);
      if (jtcData) {
        const vc = oldState.guild.channels.cache.get(jtcData.channel_id);
        if (!vc) {
          await MySQLDatabaseManager.deleteJTCChannel(oldChannelId);
          return;
        }
        if (vc.members.size < 1) {
          await MySQLDatabaseManager.deleteJTCChannel(oldChannelId);
          vc.delete().catch(err => {
            console.error(`[JoinToCreate] Failed to delete empty voice channel: ${err.message}`);
          });
        }
      }
    }
  }
};

async function createTempChannel(userState) {
  try {
    const username = userState.member?.user?.username || userState.id;
    const guild = userState.guild;
    if (!guild) {
      console.warn('[JTC] Guild not found');
      return;
    }

    const vc = await guild.channels.create({
      name: `${username}'s room`,
      type: ChannelType.GuildVoice,
      parent: joinToCreateCategoryId || undefined,
      userLimit: 14,
      permissionOverwrites: [
        {
          id: userState.id,
          allow: [PermissionFlagsBits.ManageChannels],
        },
        {
          id: guild.id,
          allow: [PermissionFlagsBits.ViewChannel],
        },
      ],
    });

    await userState.setChannel(vc).catch(err => console.error('[JoinToCreate] Error moving user into temp channel:', err.message));

    // Persist the created JTC channel so cleanup logic can find it later.
    await MySQLDatabaseManager.createJTCChannel(vc.id, userState.id, guild.id, vc.name);
  } catch (err) {
    console.error('[JoinToCreate] Error creating temp channel:', err.message);
  }
}