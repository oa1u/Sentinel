const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const { AdminRole } = require("../../Config/constants/roles.json");
const { Announcement } = require("../../Config/constants/channel.json")

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
      .setColor(0xF04747)
      .setTitle(`❌ No Permission`)
      .setDescription(`You need the Administrator role to use this command!`);
    
    if (!interaction.member.roles.cache.has(AdminRole)) {
      return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });
    }
    
    const announceChan = interaction.client.channels.cache.get(Announcement);
    const title = interaction.options.getString('title');
    const message = interaction.options.getString('message');

    if (!message || message.trim().split(' ').length < 5) {
      const shortMsgEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Message Too Short')
        .setDescription('Your announcement must be at least 5 words long!');
      return interaction.reply({
        embeds: [shortMsgEmbed],
        flags: MessageFlags.Ephemeral
      });
    }

    const em = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`📢 ${title}`)
      .setDescription(message)
      .setFooter({ text: `Announced by ${interaction.user.username}` })
      .setTimestamp();

    if (announceChan) {
      await announceChan.send({ embeds: [em] });
    }

    const successEmbed = new EmbedBuilder()
      .setColor(0x43B581)
      .setTitle('✅ Announcement Sent')
      .setDescription(`Your announcement has been posted to <#${Announcement}>`)
      .setTimestamp();
    
    await interaction.reply({
      embeds: [successEmbed],
      flags: MessageFlags.Ephemeral
    });
  }
}