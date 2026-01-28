const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('fact')
    .setDescription('Get a random interesting fact'),
  category: 'fun',
  async execute(interaction) {
    await interaction.deferReply();
    
    try {
      const response = await fetch('https://uselessfacts.jsph.pl/api/v2/facts/random');
      const data = await response.json();
      
      if (!data.text) {
        const errorEmbed = new EmbedBuilder()
          .setColor(0xF04747)
          .setTitle('❌ Error')
          .setDescription('Couldn\'t fetch a fact. Try again!');
        return interaction.editReply({ embeds: [errorEmbed] });
      }
      
      const em = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('💡 Random Fact')
        .setDescription(data.text)
        .setTimestamp();
      
      await interaction.editReply({ embeds: [em] });
    } catch (error) {
      console.error('Error fetching fact:', error);
      const errorEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Error')
        .setDescription('Error fetching fact. Try again!');
      await interaction.editReply({ embeds: [errorEmbed] });
    }
  }
};
