const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { staffrole } = require("../../Config/constants/roles.json");
const { channelLog } = require("../../Config/constants/channel.json")
const { Color } = require("../../Config/constants/misc.json")

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear a certain amount of messages!')
    .addIntegerOption(option =>
      option.setName('amount')
        .setDescription('Amount of messages to delete')
        .setRequired(true)
    ),
  category: "moderation",
  async execute(interaction) {
    const warnLogs = interaction.guild.channels.cache.get(channelLog);
    const colorInt = parseInt(Color.replace('#', ''), 16);
    let Prohibited = new EmbedBuilder()
      .setColor(colorInt)
        .setTitle(`Prohibited User`)
        .setDescription(`You have to be in the moderation team to be able to use this command!`);
    
    let MessageLimit = new EmbedBuilder()
      .setColor(colorInt)
        .setTitle(`Error`)
        .setDescription("The limit of messages you can delete at once is 100");
    
    if(!interaction.member.roles.cache.has(staffrole)) return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });

    const amount = interaction.options.getInteger('amount');

    if (amount > 100) return interaction.reply({ embeds: [MessageLimit], flags: MessageFlags.Ephemeral });

    await interaction.channel.bulkDelete(amount, true).then(Amount => {
        let Embed = new EmbedBuilder()
          .setColor(colorInt)
          .setTitle(`**Messages Deleted!**`)
          .addFields(
            { name: "Moderator", value: `${interaction.user.tag} (${interaction.user.id})` },
            { name: "Messages Deleted", value: String(Amount.size) },
            { name: "In Channel", value: `<#${interaction.channel.id}>` }
          );
        warnLogs.send({ embeds: [Embed] });
        return interaction.reply({ embeds: [Embed], flags: MessageFlags.Ephemeral });
    })
  }
};