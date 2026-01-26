const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { ModRole } = require("../../Config/constants/roles.json");
const { channelLog } = require("../../Config/constants/channel.json")

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
    let Prohibited = new EmbedBuilder()
      .setColor(0xF04747)
      .setTitle(`❌ No Permission`)
      .setDescription(`You need the Moderator role to use this command!`);
    
    let MessageLimit = new EmbedBuilder()
      .setColor(0xFAA61A)
      .setTitle(`⚠️ Invalid Amount`)
      .setDescription("You can only delete up to **100 messages** at once.");
    
    if(!interaction.member.roles.cache.has(ModRole)) return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });

    const amount = interaction.options.getInteger('amount');

    if (amount > 100) return interaction.reply({ embeds: [MessageLimit], flags: MessageFlags.Ephemeral });

    await interaction.channel.bulkDelete(amount, true).then(Amount => {
        let Embed = new EmbedBuilder()
          .setColor(0x43B581)
          .setTitle(`🧹 Messages Cleared`)
          .setDescription(`Successfully deleted **${Amount.size}** message(s)`)
          .addFields(
            { name: "👮 Moderator", value: `${interaction.user.tag}\n\`${interaction.user.id}\``, inline: true },
            { name: "📝 Messages Deleted", value: `**${Amount.size}**`, inline: true },
            { name: "📍 Channel", value: `${interaction.channel}`, inline: true }
          )
          .setTimestamp()
          .setFooter({ text: `Bulk Delete` });
        warnLogs.send({ embeds: [Embed] });
        return interaction.reply({ embeds: [Embed], flags: MessageFlags.Ephemeral });
    })
  }
};