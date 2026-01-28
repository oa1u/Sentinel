const moment = require("moment");
const JSONDatabase = require('../../Functions/Database');
const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
require("moment-duration-format");
const { administratorRoleId } = require("../../Config/constants/roles.json");
const { announcementChannelId } = require("../../Config/constants/channel.json")

// Helper function to format long messages for embeds
function formatMessageForEmbed(message) {
  const MAX_DESC_LENGTH = 4096;
  
  if (message.length <= MAX_DESC_LENGTH) {
    return { type: 'description', content: message };
  }
  
  // Split message into chunks for fields
  const chunks = [];
  const lines = message.split('\n');
  let currentChunk = '';
  
  for (const line of lines) {
    if ((currentChunk + line + '\n').length > 1024) {
      if (currentChunk) chunks.push(currentChunk.trim());
      currentChunk = line + '\n';
    } else {
      currentChunk += line + '\n';
    }
  }
  if (currentChunk) chunks.push(currentChunk.trim());
  
  return { type: 'fields', content: chunks };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('eannounce')
    .setDescription('Make an @everyone announcement with custom styling')
    .addStringOption(option =>
      option.setName('title')
        .setDescription('Announcement title')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('message')
        .setDescription('Announcement message')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('color')
        .setDescription('Embed color (hex code or name)')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(0x8),
  category: "management",
  async execute(interaction) {
    const Prohibited = new EmbedBuilder()
      .setColor(0xF04747)
      .setTitle(`❌ No Permission`)
      .setDescription(`You need the Administrator role to use this command!`);
    
    if (!interaction.member.roles.cache.has(administratorRoleId)) {
      return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });
    }
    
    const announceChan = interaction.client.channels.cache.get(announcementChannelId);
    if (!announceChan) {
      const notFoundEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Channel Not Found')
        .setDescription('The announcement channel could not be found!');
      return interaction.reply({ embeds: [notFoundEmbed], flags: MessageFlags.Ephemeral });
    }

    const title = interaction.options.getString('title').trim();
    const message = interaction.options.getString('message').trim();
    const colorInput = interaction.options.getString('color') || 'F04747';

    // Capitalize first letter of title
    const formattedTitle = title.charAt(0).toUpperCase() + title.slice(1);

    // Validate title
    if (title.length < 3 || title.length > 100) {
      const titleEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Invalid Title')
        .setDescription('Title must be between 3 and 100 characters!');
      return interaction.reply({ embeds: [titleEmbed], flags: MessageFlags.Ephemeral });
    }

    // Validate message
    if (!message || message.trim().split(' ').length < 3) {
      const shortMsgEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Message Too Short')
        .setDescription('Your announcement must be at least 3 words long!');
      return interaction.reply({ embeds: [shortMsgEmbed], flags: MessageFlags.Ephemeral });
    }

    // Parse color
    let embedColor = 0xF04747;
    try {
      if (colorInput.startsWith('#')) {
        embedColor = parseInt(colorInput.slice(1), 16);
      } else {
        embedColor = parseInt(colorInput, 16);
      }
    } catch (e) {
      const colorEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Invalid Color')
        .setDescription('Please provide a valid hex color code (e.g., #F04747 or F04747)!');
      return interaction.reply({ embeds: [colorEmbed], flags: MessageFlags.Ephemeral });
    }

    // Defer after all validations pass
    await interaction.deferReply();
    
    const em = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle(`📢 ${formattedTitle}`)
      .setFooter({ text: `Announced by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
      .setTimestamp();

    // Format message based on length
    const formatted = formatMessageForEmbed(message);
    if (formatted.type === 'description') {
      em.setDescription(formatted.content);
    } else {
      em.addFields(
        formatted.content.map((chunk, index) => ({
          name: formatted.content.length === 1 ? '📝 Message' : `📝 Message (Part ${index + 1}/${formatted.content.length})`,
          value: chunk,
          inline: false
        }))
      );
    }
    
    await announceChan.send({ content: '@everyone', embeds: [em] });
    
    const successEmbed = new EmbedBuilder()
      .setColor(0x43B581)
      .setTitle('✅ Announcement Sent with @everyone')
      .setDescription(`Your announcement has been posted to <#${announcementChannelId}> and @everyone was pinged`)
      .addFields(
        { name: 'Title', value: formattedTitle, inline: true },
        { name: 'Characters', value: `${message.length}`, inline: true }
      )
      .setTimestamp();
    
    await interaction.editReply({ embeds: [successEmbed] });
  }
}