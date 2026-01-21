const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { staffrole } = require("../../Config/constants/roles.json");
const { Color } = require("../../Config/constants/misc.json")

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
    const colorInt = parseInt(Color.replace('#', ''), 16);
    const Prohibited = new EmbedBuilder()
      .setColor(colorInt)
      .setTitle('Prohibited User')
      .setDescription('You have to be in the moderation team to be able to use this command!');

    if (!interaction.member.roles.cache.has(staffrole)) {
      return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });
    }
    
    let invalidlink = new EmbedBuilder()
      .setColor(colorInt)
        .setDescription(":x: That isn't a valid message link! :x:");
    
    let cantindmmessages = new EmbedBuilder()
      .setColor(colorInt)
        .setDescription(":x: I can't delete messages in DMs! :x:");
    
    let otherserverisbad = new EmbedBuilder()
      .setColor(colorInt)
        .setDescription(":x: I can't delete messages in other servers! :x:");
    
    let successfullydeleted = new EmbedBuilder()
      .setColor(colorInt)
        .setDescription(":white_check_mark: Successfully deleted! :white_check_mark:");
    
    let cantfindthechannel = new EmbedBuilder()
      .setColor(colorInt)
        .setDescription(":x: I couldn't find that channel :x:");
    
    let cantfindthemessage = new EmbedBuilder()
      .setColor(colorInt)
        .setDescription(":x: I couldn't find that message :x:");
    
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
