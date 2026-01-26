const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { ModRole } = require("../../Config/constants/roles.json");

module.exports = {
  data: new SlashCommandBuilder()
    .setName('deletemsg')
    .setDescription('Delete a message')
    .addStringOption(option =>
      option.setName('link')
        .setDescription('Message link')
        .setRequired(true)
    ),
  category: 'moderation',
  async execute(interaction) {
    const link = interaction.options.getString('link');
    const Prohibited = new EmbedBuilder()
      .setColor(0xF04747)
      .setTitle('❌ No Permission')
      .setDescription('You need the Moderator role to use this command!');

    if (!interaction.member.roles.cache.has(ModRole)) {
      return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });
    }
    
    let invalidlink = new EmbedBuilder()
      .setColor(0xF04747)
      .setTitle('❌ Invalid Link')
      .setDescription("That isn't a valid message link!");
    
    let cantindmmessages = new EmbedBuilder()
      .setColor(0xF04747)
      .setTitle('❌ Cannot Delete DMs')
      .setDescription("I can't delete messages in DMs!");
    
    let otherserverisbad = new EmbedBuilder()
      .setColor(0xF04747)
      .setTitle('❌ Different Server')
      .setDescription("I can't delete messages from other servers!");
    
    let successfullydeleted = new EmbedBuilder()
      .setColor(0x43B581)
      .setTitle('✅ Message Deleted')
      .setDescription("Successfully deleted the message!");
    
    let cantfindthechannel = new EmbedBuilder()
      .setColor(0xF04747)
      .setTitle('❌ Channel Not Found')
      .setDescription("I couldn't find that channel!");
    
    let cantfindthemessage = new EmbedBuilder()
      .setColor(0xF04747)
      .setTitle('❌ Message Not Found')
      .setDescription("I couldn't find that message!");
    
    if (!link.includes("https://discord.com/channels/")) return interaction.reply({ embeds: [invalidlink], flags: MessageFlags.Ephemeral });
    if (link.includes("@me")) return interaction.reply({ embeds: [cantindmmessages], flags: MessageFlags.Ephemeral });
    
    const data = link.slice(29).split("/");
    if (data[0] !== interaction.guild.id) return interaction.reply({ embeds: [otherserverisbad], flags: MessageFlags.Ephemeral });
    
    interaction.guild.channels.fetch(data[1])
      .then(channel => {
        channel.messages.fetch(data[2]).then(msg => {
          msg.delete().then(() => {
            interaction.reply({ embeds: [successfullydeleted], flags: MessageFlags.Ephemeral });
          })
        }).catch((e) => {
          interaction.reply({ embeds: [cantfindthemessage], flags: MessageFlags.Ephemeral });
        })
      }).catch((e) => {
        interaction.reply({ embeds: [cantfindthechannel], flags: MessageFlags.Ephemeral });
      })
  }
}