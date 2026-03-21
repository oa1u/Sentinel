const {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  Colors,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');
const crypto = require('crypto');
const { ROLES: { administratorRoleId }, CHANNELS: { announcementChannelId } } = require('../../Config/constants');

const STYLE_PRESETS = {
  info: { color: 0x5865F2, icon: '📢', label: 'Announcement' },
  success: { color: 0x43B581, icon: '✅', label: 'Update' },
  warning: { color: 0xFAA61A, icon: '⚠️', label: 'Important Update' },
  alert: { color: 0xF04747, icon: '🚨', label: 'Alert' }
};

const ANNOUNCEMENT_PERMISSION_FLAGS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild
];
const PREVIEW_EXPIRY_MS = 15 * 60 * 1000;
const previewSessions = new Map();

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function parseHexColor(input, fallback) {
  const raw = String(input || '').trim();
  if (!raw) return fallback;

  const normalizedName = raw.toLowerCase().replace(/[\s_-]+/g, '');
  const namedColors = Object.entries(Colors).reduce((map, [name, value]) => {
    if (typeof value === 'number') {
      map[name.toLowerCase().replace(/[\s_-]+/g, '')] = value;
    }
    return map;
  }, {});

  if (Object.prototype.hasOwnProperty.call(namedColors, normalizedName)) {
    return namedColors[normalizedName];
  }

  const normalized = raw.startsWith('#') ? raw.slice(1) : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new Error('Color must be a 6-digit hex code like #5865F2 or a named color like red, blue, or green.');
  }

  return parseInt(normalized, 16);
}

function normalizeAnnouncementBody(input) {
  return String(input || '')
    .replace(/\\n/g, '\n')
    .trim();
}

function chunkMessage(message, maxLength = 1024) {
  const parts = [];
  const lines = String(message || '').split('\n');
  let current = '';

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= maxLength) {
      current = next;
      continue;
    }

    if (current) parts.push(current);

    if (line.length <= maxLength) {
      current = line;
      continue;
    }

    let remainder = line;
    while (remainder.length > maxLength) {
      parts.push(remainder.slice(0, maxLength));
      remainder = remainder.slice(maxLength);
    }
    current = remainder;
  }

  if (current) parts.push(current);
  return parts.filter(Boolean);
}

function buildAnnouncementEmbed({
  title,
  message,
  style,
  color,
  imageUrl,
  thumbnailUrl,
  author
}) {
  const preset = STYLE_PRESETS[style] || STYLE_PRESETS.info;
  const embed = new EmbedBuilder()
    .setColor(color || preset.color)
    .setTitle(`${preset.icon} ${title}`)
    .setFooter({
      text: `${preset.label} • Posted by ${author.username}`,
      iconURL: author.displayAvatarURL()
    })
    .setTimestamp();

  const chunks = chunkMessage(message, 1024);
  if (chunks.length === 1 && chunks[0].length <= 4096) {
    embed.setDescription(chunks[0]);
  } else {
    embed.setDescription('');
    embed.addFields(
      chunks.slice(0, 10).map((chunk, index) => ({
        name: chunks.length === 1 ? 'Message' : `Message ${index + 1}`,
        value: chunk,
        inline: false
      }))
    );
  }

  if (imageUrl) embed.setImage(imageUrl);
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);

  return embed;
}

async function resolveAnnouncementChannel(interaction, explicitChannel) {
  if (explicitChannel) return explicitChannel;
  if (!announcementChannelId) return null;
  return interaction.guild.channels.fetch(announcementChannelId).catch(() => null);
}

function hasAnnouncementAccess(member) {
  return member.permissions.has(ANNOUNCEMENT_PERMISSION_FLAGS)
    || Boolean(administratorRoleId && member.roles.cache.has(administratorRoleId));
}

function getMentionText(value) {
  if (value === 'everyone') return '@everyone';
  if (value === 'here') return '@here';
  return null;
}

function createPreviewActionRow(sessionId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`announce:accept:${sessionId}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`announce:deny:${sessionId}`)
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger)
  );
}

function createDisabledPreviewActionRow(sessionId, accepted) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`announce:accept:${sessionId}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`announce:deny:${sessionId}`)
      .setLabel(accepted ? 'Posted' : 'Denied')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );
}

function storePreviewSession(data) {
  const sessionId = crypto.randomBytes(8).toString('hex');
  previewSessions.set(sessionId, {
    ...data,
    createdAt: Date.now()
  });
  return sessionId;
}

function getPreviewSession(sessionId) {
  const session = previewSessions.get(sessionId);
  if (!session) return null;

  if (Date.now() - session.createdAt > PREVIEW_EXPIRY_MS) {
    previewSessions.delete(sessionId);
    return null;
  }

  return session;
}

async function postAnnouncement({
  sourceInteraction,
  embed,
  channel,
  mentionText,
  title,
  style
}) {
  const postedMessage = await channel.send({
    content: mentionText,
    embeds: [embed],
    allowedMentions: {
      parse: mentionText === '@everyone' || mentionText === '@here' ? ['everyone'] : []
    }
  });

  return new EmbedBuilder()
    .setColor(0x43B581)
    .setTitle('✅ Announcement Posted')
    .setDescription(`Your announcement was posted in ${channel}.`)
    .addFields(
      { name: 'Title', value: title, inline: true },
      { name: 'Style', value: style.charAt(0).toUpperCase() + style.slice(1), inline: true },
      { name: 'Ping', value: mentionText || 'None', inline: true },
      { name: 'Message Link', value: postedMessage.url, inline: false }
    )
    .setTimestamp();
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Create, preview, and post announcements')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('post')
        .setDescription('Post an announcement')
        .addStringOption((option) =>
          option.setName('title')
            .setDescription('Announcement title')
            .setRequired(true)
            .setMinLength(3)
            .setMaxLength(100)
        )
        .addStringOption((option) =>
          option.setName('message')
            .setDescription('Announcement body (use \\n for line breaks)')
            .setRequired(true)
            .setMinLength(8)
            .setMaxLength(4000)
        )
        .addStringOption((option) =>
          option.setName('style')
            .setDescription('Visual style')
            .setRequired(false)
            .addChoices(
              { name: 'Info', value: 'info' },
              { name: 'Success', value: 'success' },
              { name: 'Warning', value: 'warning' },
              { name: 'Alert', value: 'alert' }
            )
        )
        .addStringOption((option) =>
          option.setName('mention')
            .setDescription('Optional ping for the post')
            .setRequired(false)
            .addChoices(
              { name: 'None', value: 'none' },
              { name: '@here', value: 'here' },
              { name: '@everyone', value: 'everyone' }
            )
        )
        .addChannelOption((option) =>
          option.setName('channel')
            .setDescription('Target channel (defaults to configured announcement channel)')
            .setRequired(false)
        )
        .addStringOption((option) =>
          option.setName('color')
            .setDescription('Optional custom hex color, for example #5865F2')
            .setRequired(false)
        )
        .addStringOption((option) =>
          option.setName('image_url')
            .setDescription('Optional large image URL')
            .setRequired(false)
        )
        .addStringOption((option) =>
          option.setName('thumbnail_url')
            .setDescription('Optional thumbnail URL')
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('preview')
        .setDescription('Preview an announcement without posting it')
        .addStringOption((option) =>
          option.setName('title')
            .setDescription('Announcement title')
            .setRequired(true)
            .setMinLength(3)
            .setMaxLength(100)
        )
        .addStringOption((option) =>
          option.setName('message')
            .setDescription('Announcement body (use \\n for line breaks)')
            .setRequired(true)
            .setMinLength(8)
            .setMaxLength(4000)
        )
        .addStringOption((option) =>
          option.setName('style')
            .setDescription('Visual style')
            .setRequired(false)
            .addChoices(
              { name: 'Info', value: 'info' },
              { name: 'Success', value: 'success' },
              { name: 'Warning', value: 'warning' },
              { name: 'Alert', value: 'alert' }
            )
        )
        .addStringOption((option) =>
          option.setName('color')
            .setDescription('Optional custom hex color, for example #5865F2')
            .setRequired(false)
        )
        .addStringOption((option) =>
          option.setName('image_url')
            .setDescription('Optional large image URL')
            .setRequired(false)
        )
        .addStringOption((option) =>
          option.setName('thumbnail_url')
            .setDescription('Optional thumbnail URL')
            .setRequired(false)
        )
        .addStringOption((option) =>
          option.setName('mention')
            .setDescription('Optional ping if you accept the preview')
            .setRequired(false)
            .addChoices(
              { name: 'None', value: 'none' },
              { name: '@here', value: 'here' },
              { name: '@everyone', value: 'everyone' }
            )
        )
    ),
  category: 'management',
  async execute(interaction) {
    if (!hasAnnouncementAccess(interaction.member)) {
      const deniedEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ No Permission')
        .setDescription('You need the configured administrator role, Manage Server, or Administrator permission to use this command.');
      return interaction.reply({ embeds: [deniedEmbed], flags: MessageFlags.Ephemeral });
    }

    const subcommand = interaction.options.getSubcommand();
    const title = String(interaction.options.getString('title') || '').trim();
    const message = normalizeAnnouncementBody(interaction.options.getString('message'));
    const style = interaction.options.getString('style') || 'info';
    const colorInput = interaction.options.getString('color') || '';
    const imageUrl = interaction.options.getString('image_url') || null;
    const thumbnailUrl = interaction.options.getString('thumbnail_url') || null;
    const mentionText = getMentionText(interaction.options.getString('mention') || 'none');

    if (!title || title.length < 3 || title.length > 100) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xF04747)
            .setTitle('❌ Invalid Title')
            .setDescription('The title must be between 3 and 100 characters.')
        ],
        flags: MessageFlags.Ephemeral
      });
    }

    if (!message || message.length < 8) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xF04747)
            .setTitle('❌ Invalid Message')
            .setDescription('The announcement message needs a little more detail before it can be sent.')
        ],
        flags: MessageFlags.Ephemeral
      });
    }

    if (imageUrl && !isHttpUrl(imageUrl)) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xF04747)
            .setTitle('❌ Invalid Image URL')
            .setDescription('The image URL must start with http:// or https://.')
        ],
        flags: MessageFlags.Ephemeral
      });
    }

    if (thumbnailUrl && !isHttpUrl(thumbnailUrl)) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xF04747)
            .setTitle('❌ Invalid Thumbnail URL')
            .setDescription('The thumbnail URL must start with http:// or https://.')
        ],
        flags: MessageFlags.Ephemeral
      });
    }

    let customColor;
    try {
      customColor = parseHexColor(colorInput, STYLE_PRESETS[style]?.color || STYLE_PRESETS.info.color);
    } catch (error) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xF04747)
            .setTitle('❌ Invalid Color')
            .setDescription(error.message)
        ],
        flags: MessageFlags.Ephemeral
      });
    }

    const embed = buildAnnouncementEmbed({
      title,
      message,
      style,
      color: customColor,
      imageUrl,
      thumbnailUrl,
      author: interaction.user
    });

    if (subcommand === 'preview') {
      const sessionId = storePreviewSession({
        authorId: interaction.user.id,
        embed: embed.toJSON(),
        title,
        style,
        mentionText,
        targetChannelId: null
      });

      return interaction.reply({
        content: 'Preview only. Use the buttons below to post or cancel.',
        embeds: [embed],
        components: [createPreviewActionRow(sessionId)],
        flags: MessageFlags.Ephemeral
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const targetChannel = await resolveAnnouncementChannel(interaction, interaction.options.getChannel('channel'));
    if (!targetChannel || !targetChannel.isTextBased()) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xF04747)
            .setTitle('❌ Channel Not Found')
            .setDescription('I could not resolve the target announcement channel. Set one in the command or update the configured announcement channel.')
        ]
      });
    }

    try {
      const successEmbed = await postAnnouncement({
        sourceInteraction: interaction,
        embed,
        channel: targetChannel,
        mentionText,
        title,
        style
      });

      return interaction.editReply({ embeds: [successEmbed] });
    } catch (error) {
      console.error('[announce] Failed to post announcement:', error);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xF04747)
            .setTitle('❌ Announcement Failed')
            .setDescription('I could not post the announcement. Check my channel permissions and make sure the target channel accepts bot messages.')
        ]
      });
    }
  },
  async handleComponent(interaction) {
    if (!interaction.isButton()) return false;
    if (!interaction.customId.startsWith('announce:')) return false;

    const [, action, sessionId] = interaction.customId.split(':');
    const session = getPreviewSession(sessionId);

    if (!session) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xF04747)
            .setTitle('❌ Preview Expired')
            .setDescription('This announcement preview is no longer available. Run /announce preview again.')
        ],
        flags: MessageFlags.Ephemeral
      });
      return true;
    }

    if (interaction.user.id !== session.authorId) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xF04747)
            .setTitle('❌ Not Your Preview')
            .setDescription('Only the user who created this preview can accept or deny it.')
        ],
        flags: MessageFlags.Ephemeral
      });
      return true;
    }

    if (!hasAnnouncementAccess(interaction.member)) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xF04747)
            .setTitle('❌ No Permission')
            .setDescription('You no longer have permission to post this announcement.')
        ],
        flags: MessageFlags.Ephemeral
      });
      return true;
    }

    if (action === 'deny') {
      previewSessions.delete(sessionId);
      await interaction.update({
        content: 'Announcement preview denied. Nothing was posted.',
        embeds: [EmbedBuilder.from(session.embed)],
        components: [createDisabledPreviewActionRow(sessionId, false)]
      });
      return true;
    }

    if (action !== 'accept') return false;

    const targetChannel = await resolveAnnouncementChannel(interaction, session.targetChannelId ? await interaction.guild.channels.fetch(session.targetChannelId).catch(() => null) : null);
    if (!targetChannel || !targetChannel.isTextBased()) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xF04747)
            .setTitle('❌ Channel Not Found')
            .setDescription('I could not resolve the target announcement channel for this preview.')
        ],
        flags: MessageFlags.Ephemeral
      });
      return true;
    }

    try {
      const successEmbed = await postAnnouncement({
        sourceInteraction: interaction,
        embed: EmbedBuilder.from(session.embed),
        channel: targetChannel,
        mentionText: session.mentionText,
        title: session.title,
        style: session.style
      });

      previewSessions.delete(sessionId);
      await interaction.update({
        content: 'Announcement approved and posted.',
        embeds: [successEmbed],
        components: [createDisabledPreviewActionRow(sessionId, true)]
      });
      return true;
    } catch (error) {
      console.error('[announce] Failed to post approved preview:', error);
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xF04747)
            .setTitle('❌ Announcement Failed')
            .setDescription('I could not post the approved announcement. Check my channel permissions and try again.')
        ],
        flags: MessageFlags.Ephemeral
      });
      return true;
    }
  }
};