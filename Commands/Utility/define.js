const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('define')
    .setDescription('Look up a word definition')
    .addStringOption(option =>
      option.setName('word')
        .setDescription('The word to define')
        .setRequired(true)
    ),
  category: 'utility',
  async execute(interaction) {
    await interaction.deferReply();
    
    const word = interaction.options.getString('word').trim().toLowerCase();
    
    try {
      const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`);
      
      if (!response.ok) {
        const notFound = new EmbedBuilder()
          .setColor(0xF04747)
          .setTitle('❌ Not Found')
          .setDescription(`No definition for "${word}". Check spelling!`);
        return interaction.editReply({ embeds: [notFound] });
      }
      
      const data = await response.json();
      const entry = data[0];
      
      const em = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`📖 ${entry.word}`)
        .setDescription(`*${entry.phonetic || 'N/A'}*`);
      
      // Add meanings
      if (entry.meanings && entry.meanings.length > 0) {
        entry.meanings.slice(0, 3).forEach((meaning, index) => {
          const definitions = meaning.definitions
            .slice(0, 2)
            .map((def, i) => `${i + 1}. ${def.definition}${def.example ? `\n   *"${def.example}"*` : ''}`)
            .join('\n');
          
          em.addFields({
            name: `**${meaning.partOfSpeech}**`,
            value: definitions || 'No definition available',
            inline: false
          });
        });
      }
      
      // Add synonyms if available
      if (entry.meanings?.[0]?.synonyms?.length > 0) {
        const synonyms = entry.meanings[0].synonyms.slice(0, 5).join(', ');
        em.addFields({
          name: 'Similar Words',
          value: synonyms,
          inline: false
        });
      }
      
      em.setFooter({ text: `Requested by ${interaction.user.username}` })
        .setTimestamp();
      
      await interaction.editReply({ embeds: [em] });
    } catch (error) {
      const errorEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Error')
        .setDescription('Couldn\'t fetch definition. Try again later!');
      
      await interaction.editReply({ embeds: [errorEmbed] });
    }
  }
};