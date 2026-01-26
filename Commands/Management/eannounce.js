const moment = require("moment");
const JSONDatabase = require('../../Functions/Database');
const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
require("moment-duration-format");
const { AdminRole } = require("../../Config/constants/roles.json");
const { Announcement } = require("../../Config/constants/channel.json")

module.exports = {
  data: new SlashCommandBuilder()
    .setName('eannounce')
    .setDescription('everyone announcements')
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
    let Prohibited = new EmbedBuilder()
      .setColor(0xF04747)
      .setTitle(`❌ No Permission`)
      .setDescription(`You need the Administrator role to use this command!`);
    
    if (!interaction.member.roles.cache.has(AdminRole)) return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });
    
    const announceChan = interaction.client.channels.cache.get(Announcement);
    const title = interaction.options.getString('title');
    const AnnDesc = interaction.options.getString('message');
    
    const em = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`📢 ${title}`)
      .setDescription(AnnDesc)
      .setFooter({ text: `Announced by ${interaction.user.username}` })
      .setTimestamp();
    
    await announceChan.send({ content: '@everyone', embeds: [em] });
    
    const successEmbed = new EmbedBuilder()
      .setColor(0x43B581)
      .setTitle('✅ Announcement Sent')
      .setDescription(`Your announcement has been posted to <#${Announcement}>`)
      .setTimestamp();
    
    await interaction.reply({ embeds: [successEmbed], flags: MessageFlags.Ephemeral });
  }
}