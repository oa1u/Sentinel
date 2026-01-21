const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const { AdminRole } = require("../../Config/constants/roles.json");
const { Announcement } = require("../../Config/constants/channel.json")
const { Color } = require("../../Config/constants/misc.json")

const colorInt = parseInt(Color.replace('#', ''), 16);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Send an announcement')
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
    .setDefaultMemberPermissions(0x8),
  category: "management",
  async execute(interaction) {
    const Prohibited = new EmbedBuilder()
      .setColor(colorInt)
      .setTitle(`Prohibited User`)
      .setDescription(`You have to be an administrator to use this command!`);
    
    if (!interaction.member.roles.cache.has(AdminRole)) {
      return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });
    }
    
    const announceChan = interaction.client.channels.cache.get(Announcement);
    const title = interaction.options.getString('title');
    const message = interaction.options.getString('message');

    if (!message || message.trim().split(' ').length < 5) {
      return interaction.reply({
        content: 'Make sure to include a description for the announcement! (Must be longer than 5 words)',
        flags: MessageFlags.Ephemeral
      });
    }

    const em = new EmbedBuilder()
      .setColor(colorInt)
      .setTitle(title)
      .setDescription(message);

    if (announceChan) {
      await announceChan.send({ embeds: [em] });
    }

    await interaction.reply({
      content: 'Announcement sent!',
      flags: MessageFlags.Ephemeral
    });
  }
}