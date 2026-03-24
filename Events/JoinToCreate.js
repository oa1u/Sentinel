const { ChannelType, PermissionFlagsBits } = require("discord.js");
const MySQLDatabaseManager = require("../Functions/MySQLDatabaseManager");
const { CHANNELS: { joinToCreateChannelId, joinToCreateCategoryId } } = require("../Config/constants");

const JTC_CREATION_COOLDOWN_MS = 3500;
const JTC_IDLE_CLEANUP_MS = Math.max(0, Number(process.env.JTC_IDLE_CLEANUP_MS || 120000));
const JTC_NOTIFY_OWNER_TRANSFER = String(process.env.JTC_NOTIFY_OWNER_TRANSFER || 'true').toLowerCase() !== 'false';
const JTC_RECONCILE_EMPTY_GRACE_MS = Math.max(
  JTC_IDLE_CLEANUP_MS,
  Number(process.env.JTC_RECONCILE_EMPTY_GRACE_MS || 5 * 60 * 1000)
);
const userCreationLocks = new Map();
const userCreationCooldowns = new Map();
const pendingIdleCleanupTimers = new Map();

// Join-to-Create (JTC): when users join the lobby channel, we create a private temporary voice room for them.
// When the room becomes empty, it is automatically removed to keep things tidy.
module.exports = {
  name: "voiceStateUpdate",
  disabled: true,
  runOnce: false,
  call: async (client, args) => {
    const [oldState, newState] = args;

    // If there's no old/new state, ignore - nothing for us to do.
    if (!oldState && !newState) return;

    const oldChannelId = oldState?.channelId || null;
    const newChannelId = newState?.channelId || null;

    if (newChannelId) {
      clearIdleCleanupTimer(newChannelId);
    }

    // User joined the JTC lobby.
    if (newChannelId === joinToCreateChannelId && oldChannelId !== joinToCreateChannelId) {
      await safelyCreateOrReuseTempChannel(newState);
    }

    // User left any previous channel (disconnect/move), cleanup if it was JTC and now empty.
    if (oldChannelId && oldChannelId !== newChannelId) {
      await cleanupIfEmptyJtcChannel(oldState.guild, oldChannelId, oldState.id);
    }

    cleanupCreationCooldowns();
  }
};

function clearIdleCleanupTimer(channelId) {
  if (!channelId) return;
  const timer = pendingIdleCleanupTimers.get(channelId);
  if (!timer) return;
  clearTimeout(timer);
  pendingIdleCleanupTimers.delete(channelId);
}

async function safelyCreateOrReuseTempChannel(userState) {
  const userId = userState?.id;
  if (!userId) return;

  if (userCreationLocks.get(userId)) {
    return;
  }

  const now = Date.now();
  const lastCreatedAt = userCreationCooldowns.get(userId) || 0;
  if (now - lastCreatedAt < JTC_CREATION_COOLDOWN_MS) {
    return;
  }

  userCreationLocks.set(userId, true);
  try {
    await createOrReuseTempChannel(userState);
    userCreationCooldowns.set(userId, Date.now());
  } finally {
    userCreationLocks.delete(userId);
  }
}

async function createOrReuseTempChannel(userState) {
  const guild = userState?.guild;
  const userId = userState?.id;
  if (!guild || !userId) return;

  // If user already owns an active JTC channel, move them there instead of creating duplicates.
  const existing = await findExistingOwnedJtcChannel(guild, userId);
  if (existing) {
    await userState.setChannel(existing).catch((err) => {
      console.error(`[JoinToCreate] Failed moving user to existing channel: ${err.message}`);
    });
    return;
  }

  await createTempChannel(userState);
}

async function findExistingOwnedJtcChannel(guild, ownerId) {
  try {
    const active = await MySQLDatabaseManager.getActiveJTCChannels(guild.id);
    if (!Array.isArray(active) || !active.length) return null;

    for (const row of active) {
      if (String(row?.owner_id) !== String(ownerId)) continue;

      const channel = guild.channels.cache.get(row.channel_id) || await guild.channels.fetch(row.channel_id).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        // Stale row, mark inactive so we don't keep trying it.
        await MySQLDatabaseManager.deleteJTCChannel(row.channel_id).catch(() => { });
        continue;
      }

      return channel;
    }
  } catch (error) {
    console.warn(`[JoinToCreate] Failed checking existing owned JTC channel: ${error.message}`);
  }

  return null;
}

function pickNextJtcOwner(channel) {
  if (!channel?.members?.size) return null;

  const members = Array.from(channel.members.values());
  const nonBotMembers = members.filter((member) => !member?.user?.bot);
  const candidates = nonBotMembers.length ? nonBotMembers : members;

  candidates.sort((a, b) => {
    const aJoined = Number(a?.joinedTimestamp || 0);
    const bJoined = Number(b?.joinedTimestamp || 0);
    if (aJoined !== bJoined) return aJoined - bJoined;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });

  return candidates[0] || null;
}

async function transferOwnershipIfNeeded(guild, channel, jtcData, departedUserId) {
  if (!guild || !channel || !jtcData || !departedUserId) return;

  const previousOwnerId = String(jtcData.owner_id || '');
  if (!previousOwnerId || previousOwnerId !== String(departedUserId)) return;
  if (channel.members.size < 1) return;

  const newOwner = pickNextJtcOwner(channel);
  if (!newOwner) return;
  if (String(newOwner.id) === previousOwnerId) return;

  const transferred = await MySQLDatabaseManager.transferJTCOwner(channel.id, newOwner.id, channel.name);
  if (!transferred) {
    console.warn(`[JoinToCreate] Failed to transfer ownership in DB for ${channel.id}`);
    return;
  }

  await channel.permissionOverwrites.edit(newOwner.id, {
    ManageChannels: true
  }).catch((err) => {
    console.warn(`[JoinToCreate] Failed to set new owner channel permissions: ${err.message}`);
  });

  await channel.permissionOverwrites.edit(previousOwnerId, {
    ManageChannels: null
  }).catch(() => {
    // Ignore cleanup failure if old owner overwrite does not exist.
  });

  await notifyNewOwner(newOwner, guild, channel);
}

async function notifyNewOwner(newOwnerMember, guild, channel) {
  if (!JTC_NOTIFY_OWNER_TRANSFER) return;
  if (!newOwnerMember?.user || newOwnerMember.user.bot) return;

  const guildName = String(guild?.name || 'this server');
  const channelName = String(channel?.name || 'your voice channel');

  const { EmbedBuilder } = require('discord.js');
  const embed = new EmbedBuilder()
    .setTitle('Room Ownership Granted')
    .setDescription(`You are now the owner of **${channelName}** in **${guildName}**.`)
    .addFields([
      {
        name: 'Room Management',
        value: 'You can use the `/voice` commands to manage it:\n• `/voice name`\n• `/voice limit`\n• `/voice lock`\n• `/voice permit`\n• `/voice reject`\n• `/voice delete`'
      }
    ])
    .setColor(0x5865F2)
    .setFooter({ text: 'Enjoy your new room!' });

  await newOwnerMember.user.send({ embeds: [embed] }).catch(() => {
    // User may have DMs closed; this notification is optional.
  });
}

async function cleanupIfEmptyJtcChannel(guild, channelId, departedUserId = null) {
  if (!guild || !channelId || channelId === joinToCreateChannelId) return;

  const jtcData = await MySQLDatabaseManager.getJTCChannel(channelId);
  if (!jtcData) return;

  const vc = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);

  if (!vc) {
    await MySQLDatabaseManager.deleteJTCChannel(channelId).catch(() => { });
    return;
  }

  if (vc.type !== ChannelType.GuildVoice) {
    await MySQLDatabaseManager.deleteJTCChannel(channelId).catch(() => { });
    return;
  }

  if (vc.members.size > 0) {
    clearIdleCleanupTimer(channelId);
    await transferOwnershipIfNeeded(guild, vc, jtcData, departedUserId);
    return;
  }

  if (JTC_IDLE_CLEANUP_MS <= 0) {
    await MySQLDatabaseManager.deleteJTCChannel(channelId).catch((err) => {
      console.error(`[JoinToCreate] Failed marking JTC channel inactive: ${err.message}`);
    });

    await vc.delete().catch((err) => {
      console.error(`[JoinToCreate] Failed to delete empty voice channel: ${err.message}`);
    });
    return;
  }

  if (pendingIdleCleanupTimers.has(channelId)) return;

  const timer = setTimeout(async () => {
    pendingIdleCleanupTimers.delete(channelId);

    const freshData = await MySQLDatabaseManager.getJTCChannel(channelId).catch(() => null);
    if (!freshData) return;

    const freshChannel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!freshChannel) {
      await MySQLDatabaseManager.deleteJTCChannel(channelId).catch(() => { });
      return;
    }

    if (freshChannel.type !== ChannelType.GuildVoice) {
      await MySQLDatabaseManager.deleteJTCChannel(channelId).catch(() => { });
      return;
    }

    if (freshChannel.members.size > 0) return;

    await MySQLDatabaseManager.deleteJTCChannel(channelId).catch((err) => {
      console.error(`[JoinToCreate] Failed marking JTC channel inactive: ${err.message}`);
    });

    await freshChannel.delete().catch((err) => {
      console.error(`[JoinToCreate] Failed to delete idle voice channel: ${err.message}`);
    });
  }, JTC_IDLE_CLEANUP_MS);

  pendingIdleCleanupTimers.set(channelId, timer);
}

function getChannelAgeMs(channel, jtcData) {
  const channelTimestamp = Number(channel?.createdTimestamp || 0);
  if (channelTimestamp > 0) {
    return Math.max(0, Date.now() - channelTimestamp);
  }

  const createdAt = Number(jtcData?.created_at || 0);
  if (createdAt > 0) {
    return Math.max(0, Date.now() - createdAt);
  }

  return Number.POSITIVE_INFINITY;
}

async function reconcileGuildJtcChannels(guild, options = {}) {
  if (!guild?.id) return;

  const emptyGraceMs = Math.max(0, Number(options.emptyGraceMs ?? JTC_RECONCILE_EMPTY_GRACE_MS));
  const activeRows = await MySQLDatabaseManager.getActiveJTCChannels(guild.id).catch(() => []);
  if (!Array.isArray(activeRows) || activeRows.length === 0) return;

  for (const jtcData of activeRows) {
    const channelId = String(jtcData?.channel_id || '');
    if (!channelId) continue;

    const vc = guild.channels.cache.get(channelId)
      || await guild.channels.fetch(channelId).catch(() => null);

    if (!vc || vc.type !== ChannelType.GuildVoice) {
      await MySQLDatabaseManager.deleteJTCChannel(channelId).catch(() => { });
      continue;
    }

    if (vc.members.size > 0) {
      const ownerId = String(jtcData?.owner_id || '');
      if (ownerId && !vc.members.has(ownerId)) {
        await transferOwnershipIfNeeded(guild, vc, jtcData, ownerId);
      }
      continue;
    }

    if (getChannelAgeMs(vc, jtcData) < emptyGraceMs) {
      continue;
    }

    await MySQLDatabaseManager.deleteJTCChannel(channelId).catch(() => { });
    await vc.delete().catch((err) => {
      console.error(`[JTC] Couldn't delete reconciled temp channel: ${err.message}`);
    });
  }
}

function cleanupCreationCooldowns() {
  const now = Date.now();
  for (const [userId, ts] of userCreationCooldowns.entries()) {
    if (now - Number(ts || 0) > JTC_CREATION_COOLDOWN_MS * 3) {
      userCreationCooldowns.delete(userId);
    }
  }
}

async function createTempChannel(userState) {
  try {
    const username = userState.member?.user?.username || userState.id;
    const guild = userState.guild;
    if (!guild) {
      console.warn('[JTC] Guild not found');
      return;
    }

    const safeName = String(username).trim().slice(0, 22) || 'User';

    const vc = await guild.channels.create({
      name: `${safeName}'s room`,
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

    const moved = await userState.setChannel(vc).then(() => true).catch(err => {
      console.error('[JoinToCreate] Error moving user into temp channel:', err.message);
      return false;
    });

    if (!moved) {
      // If user cannot be moved, remove orphan channel immediately.
      await vc.delete().catch(() => { });
      return;
    }

    // Persist the created JTC channel so cleanup logic can find it later.
    await MySQLDatabaseManager.createJTCChannel(vc.id, userState.id, guild.id, vc.name);
  } catch (err) {
    console.error('[JoinToCreate] Error creating temp channel:', err.message);
  }
}

module.exports.cleanupIfEmptyJtcChannel = cleanupIfEmptyJtcChannel;
module.exports.reconcileGuildJtcChannels = reconcileGuildJtcChannels;