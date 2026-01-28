const moment = require("moment");
const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags, ChannelType } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('Get server information'),
  category: 'utility',
  async execute(interaction) {
    const guild = interaction.guild;
    if (!guild) {
      return interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    }

    const owner = await guild.fetchOwner().catch(() => null);
    const rolesCount = guild.roles.cache.size;
    const emojisCount = guild.emojis.cache.size;
    const stickersCount = guild.stickers?.cache?.size || 0;
    const boostCount = guild.premiumSubscriptionCount || 0;
    const boostTier = guild.premiumTier ? `Tier ${guild.premiumTier}` : 'None';

    const channels = guild.channels.cache;
    const textChannels = channels.filter(ch => ch.type === ChannelType.GuildText).size;
    const voiceChannels = channels.filter(ch => ch.type === ChannelType.GuildVoice).size;
    const stageChannels = channels.filter(ch => ch.type === ChannelType.GuildStageVoice).size;
    const forumChannels = channels.filter(ch => ch.type === ChannelType.GuildForum || ch.type === ChannelType.GuildMedia).size;
    const categories = channels.filter(ch => ch.type === ChannelType.GuildCategory).size;

    const memberCount = guild.memberCount;
    const botCount = guild.members.cache.filter(m => m.user.bot).size;
    const humanCount = memberCount - botCount;

    const createdAt = moment(guild.createdAt);
    const features = guild.features || [];
    const featureDisplay = features.length ? features.map(f => f.replace(/_/g, ' ').toLowerCase()).slice(0, 10).join(', ') : 'None';

    const afkChannel = guild.afkChannel ? `${guild.afkChannel.name} (${guild.afkChannel.id})` : 'None';
    const afkTimeout = guild.afkTimeout ? `${guild.afkTimeout / 60} min` : 'N/A';

    const thresholds = [0, 2, 7, 14];
    const currentTier = guild.premiumTier || 0;
    const nextThreshold = thresholds[Math.min(currentTier + 1, thresholds.length - 1)];
    const boostProgress = nextThreshold > 0 ? `${boostCount}/${nextThreshold} to Tier ${Math.min(currentTier + 1, 3)}` : `${boostCount}`;

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setAuthor({ name: `🏰 ${guild.name}`, iconURL: guild.iconURL({ size: 128 }) || undefined })
      .setThumbnail(guild.iconURL({ size: 256 }) || null)
      .addFields(
        { name: '🪪 Server ID', value: guild.id, inline: true },
        { name: '👑 Owner', value: owner ? `${owner.user.tag}` : 'Unknown', inline: true },
        { name: '📅 Created', value: `${createdAt.format('LLL')}\n(${createdAt.fromNow()})`, inline: true },
        { name: '👥 Members', value: `Total: **${memberCount}**\n🙍‍♂️ Humans: **${humanCount}**\n🤖 Bots: **${botCount}**`, inline: true },
        { name: '📢 Channels', value: `#️⃣ Text: **${textChannels}**\n🔊 Voice: **${voiceChannels}**\n🎙️ Stage: **${stageChannels}**\n📰 Forum: **${forumChannels}**\n🗂️ Categories: **${categories}**`, inline: true },
        { name: '⚡ Boosts', value: `✨ ${boostCount} (${boostTier})\n📈 ${boostProgress}`, inline: true },
        { name: '🎭 Roles', value: `${rolesCount}`, inline: true },
        { name: '😀 Emojis', value: `${emojisCount}`, inline: true },
        { name: '🏷️ Stickers', value: `${stickersCount}`, inline: true },
        { name: '🛡️ Verification', value: `${guild.verificationLevel ?? 'Unknown'}`, inline: true },
        { name: '😴 AFK', value: `${afkChannel}\n⏱️ Timeout: ${afkTimeout}`, inline: true },
        { name: '🔗 Vanity', value: guild.vanityURLCode ? `discord.gg/${guild.vanityURLCode}` : 'None', inline: true },
        { name: '✨ Features', value: featureDisplay, inline: false }
      )
      .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
      .setTimestamp();

    const banner = guild.bannerURL({ size: 1024 });
    if (banner) embed.setImage(banner);

    return interaction.reply({ embeds: [embed] });
  }
};