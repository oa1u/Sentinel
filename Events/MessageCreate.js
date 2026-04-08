const AfkStatus = require('./AfkStatus');
const AutoMod = require('./AutoMod');
const EconomyActivity = require('./EconomyActivity');
const Leveling = require('./Leveling');
const MediaOnly = require('./MediaOnly');
const LuckyDrop = require('../Functions/LuckyDrop');
const AttachmentScanner = require('../Functions/AttachmentScanner');
const { syncTicketConversationState } = require('../Functions/TicketLifecycle');
const { AUTO_RESPONDER: autoResponderConfig, CHANNELS: channelConfig } = require('../Config/constants');
const mainConfig = require('../Config/main.json');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

const autoResponseCooldown = new Map();
const AUTO_RESPONSE_DEFAULT_COOLDOWN_MS = 30 * 1000;
const botName = String(mainConfig?.botName || 'Sentinel');

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasIgnoredPrefix(content, ignoredPrefixes) {
  return ignoredPrefixes.some((prefix) => content.startsWith(prefix));
}

function isChannelAllowed(message) {
  const autoResponderAllowedChannelIds = Array.isArray(channelConfig?.autoResponderAllowedChannelIds)
    ? channelConfig.autoResponderAllowedChannelIds.map((value) => String(value || '')).filter(Boolean)
    : [];
  const autoResponderBlockedChannelIds = Array.isArray(channelConfig?.autoResponderBlockedChannelIds)
    ? channelConfig.autoResponderBlockedChannelIds.map((value) => String(value || '')).filter(Boolean)
    : [];

  const channelId = String(message.channelId || message.channel?.id || '');
  if (autoResponderBlockedChannelIds.includes(channelId)) return false;
  if (autoResponderAllowedChannelIds.length > 0 && !autoResponderAllowedChannelIds.includes(channelId)) return false;
  return true;
}

function resolveButtonStyle(styleName) {
  if (styleName === 'Success') return ButtonStyle.Success;
  if (styleName === 'Secondary') return ButtonStyle.Secondary;
  if (styleName === 'Danger') return ButtonStyle.Danger;
  return ButtonStyle.Primary;
}

function scoreTriggerMatch(content, trigger) {
  const normalizedContent = normalizeText(content);
  const normalizedTrigger = normalizeText(trigger);
  if (!normalizedContent || !normalizedTrigger) return 0;
  if (normalizedContent === normalizedTrigger) return 100;

  const boundaryRegex = new RegExp(`(?:^|\\W)${escapeRegExp(normalizedTrigger)}(?:$|\\W)`, 'i');
  if (boundaryRegex.test(normalizedContent)) return 70;
  if (normalizedContent.includes(normalizedTrigger)) return 40;
  return 0;
}

function findKbResponses(content) {
  const entries = Array.isArray(autoResponderConfig?.entries) ? autoResponderConfig.entries : [];

  return entries
    .map((entry) => {
      const triggers = Array.isArray(entry?.triggers) ? entry.triggers : [];
      const score = Math.max(0, ...triggers.map((trigger) => scoreTriggerMatch(content, trigger)));
      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, Number(autoResponderConfig?.maxMatches) || 3));
}

async function handleAutoResponse(message) {
  if (!message.guild || message.author.bot) return;
  if (autoResponderConfig?.enabled === false) return;
  if (!isChannelAllowed(message)) return;

  const normalizedContent = normalizeText(message.content);
  if (!normalizedContent.length) return;

  const ignoredPrefixes = Array.isArray(autoResponderConfig?.ignoredPrefixes)
    ? autoResponderConfig.ignoredPrefixes.map((prefix) => String(prefix || ''))
    : [];
  if (hasIgnoredPrefix(normalizedContent, ignoredPrefixes)) return;

  const now = Date.now();
  const last = autoResponseCooldown.get(message.author.id) || 0;
  const cooldownMs = Math.max(5_000, Number(autoResponderConfig?.cooldownMs) || AUTO_RESPONSE_DEFAULT_COOLDOWN_MS);
  if (now - last < cooldownMs) return;

  const matches = findKbResponses(message.content);
  if (matches.length === 0) return;

  autoResponseCooldown.set(message.author.id, now);

  const primaryEntry = matches[0]?.entry || {};
  const categoryName = String(primaryEntry.category || 'general');
  const categoryConfig = autoResponderConfig?.categories?.[categoryName] || {};
  const chosenColor = Number(categoryConfig.color) || 0x7289DA;
  const categoryEmoji = categoryConfig.emoji || '🤖';

  const userAvatarURL = message.author.displayAvatarURL({ extension: 'png', size: 1024 });
  const quickLinks = Array.isArray(autoResponderConfig?.quickLinks) ? autoResponderConfig.quickLinks : [];
  const quickLinkText = quickLinks.length ? quickLinks.map((item) => `\`${item}\``).join(' • ') : '`/help`';
  const confidence = matches[0]?.score >= 100 ? 'High' : matches[0]?.score >= 70 ? 'Medium' : 'Low';

  const embed = new EmbedBuilder()
    .setTitle(`${categoryEmoji} ${botName} Auto-Responder`)
    .setDescription(`Hey ${message.author}, I found **${matches.length}** relevant knowledge-base match${matches.length === 1 ? '' : 'es'} for your message.`)
    .setColor(chosenColor)
    .setAuthor({ name: `${message.author.username}'s helper`, iconURL: userAvatarURL })
    .setThumbnail(userAvatarURL)
    .addFields(
      { name: 'Category', value: `**${categoryName}**`, inline: true },
      { name: 'Confidence', value: `**${confidence}**`, inline: true },
      { name: 'Quick links', value: quickLinkText, inline: false }
    )
    .setFooter({ text: `Powered by ${botName} knowledge base`, iconURL: userAvatarURL })
    .setTimestamp();

  for (const match of matches) {
    const entry = match.entry;
    const summary = entry.summary ? `*${entry.summary}*\n` : '';
    embed.addFields({
      name: `• ${entry.title}`,
      value: `${summary}${entry.response}`,
      inline: false
    });
  }

  embed.addFields({ name: 'Next Step', value: 'If this did not answer your question, please open a ticket or mention a staff member for immediate support.', inline: false });

  const ticketButtonConfig = autoResponderConfig?.ticketButton || {};
  const components = [];
  if (ticketButtonConfig.enabled !== false) {
    const buttonRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket:auto_open')
        .setLabel(String(ticketButtonConfig.label || 'Open Ticket'))
        .setStyle(resolveButtonStyle(ticketButtonConfig.style))
    );
    components.push(buttonRow);
  }

  await message
    .reply({
      embeds: [embed],
      components,
      allowedMentions: { repliedUser: true }
    })
    .catch(() => message.channel.send({ content: `${message.author}`, embeds: [embed], components }).catch(() => null));
}

async function invokeHandler(handler, message, client, label) {
  if (!handler) return;

  try {
    if (typeof handler.handleMessageCreate === 'function') {
      await handler.handleMessageCreate(message, client);
      return;
    }

    if (typeof handler.call === 'function') {
      await handler.call(client, [message]);
      return;
    }

    if (typeof handler.execute === 'function') {
      await handler.execute(message, client);
    }
  } catch (error) {
    const safeLabel = label || handler?.name || 'unknown';
    console.error(`[MessageCreate] ${safeLabel} failed:`, error?.message || error);
  }
}

module.exports = {
  name: 'messageCreate',
  runOnce: false,
  async execute(message, client) {
    await syncTicketConversationState(message).catch((error) => {
      console.error('[MessageCreate] TicketStatusSync failed:', error?.message || error);
    });

    await invokeHandler(AfkStatus, message, client, 'AfkStatus');
    await invokeHandler(AutoMod, message, client, 'AutoMod');
    await invokeHandler(MediaOnly, message, client, 'MediaOnly');
    await invokeHandler(EconomyActivity, message, client, 'EconomyActivity');
    await invokeHandler(Leveling, message, client, 'Leveling');
    await LuckyDrop.handleMessage(message).catch(() => { });
    await invokeHandler(AttachmentScanner, message, client, 'AttachmentScanner');

    await handleAutoResponse(message).catch(() => { });
  }
};