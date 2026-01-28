const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('joke')
    .setDescription('Get a random joke'),
  category: 'utility',
  async execute(interaction) {
    await interaction.deferReply();
    
    try {
      const response = await fetch('https://official-joke-api.appspot.com/random_joke');
      const jokeData = await response.json();
      
      const em = new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle('😂 Random Joke')
        .setDescription(
          `**Setup:**\n> ${jokeData.setup}\n\n` +
          `**Punchline:**\n> ${jokeData.punchline}`
        )
        .setFooter({ text: `Requested by ${interaction.user.username}` })
        .setTimestamp();
      
      await interaction.editReply({ embeds: [em] });
    } catch (error) {
      const errorEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Error')
        .setDescription('Could not fetch a joke. Please try again!');
      
      await interaction.editReply({ embeds: [errorEmbed] });
    }
  }
};