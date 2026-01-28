const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');

const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];

// Simple HTML entity decoder without DOM
function htmlDecode(str) {
  const entities = {
    '&quot;': '"',
    '&#039;': "'",
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>'
  };
  return str.replace(/&quot;|&#039;|&amp;|&lt;|&gt;/g, (match) => entities[match]);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trivia')
    .setDescription('Answer a random trivia question'),
  category: 'fun',
  async execute(interaction) {
    await interaction.deferReply();
    
    try {
      const response = await fetch('https://opentdb.com/api.php?amount=1&type=multiple');
      const data = await response.json();
      
      if (!data.results || data.results.length === 0) {
        const errorEmbed = new EmbedBuilder()
          .setColor(0xF04747)
          .setTitle('❌ Error')
          .setDescription('Could not fetch trivia question. Please try again!');
        return interaction.editReply({ embeds: [errorEmbed] });
      }
      
      const question = data.results[0];
      const correctAnswer = htmlDecode(question.correct_answer);
      const allAnswers = [
        correctAnswer,
        ...question.incorrect_answers.map(ans => htmlDecode(ans))
      ].sort(() => Math.random() - 0.5);
      
      const correctIndex = allAnswers.indexOf(correctAnswer);
      
      const em = new EmbedBuilder()
        .setColor(0xFF6B6B)
        .setTitle('🧠 Trivia Question')
        .addFields(
          { name: 'Category', value: htmlDecode(question.category), inline: true },
          { name: 'Difficulty', value: question.difficulty.toUpperCase(), inline: true },
          { name: 'Question', value: htmlDecode(question.question), inline: false }
        );
      
      const optionsText = allAnswers
        .map((ans, i) => `${emojis[i]} ${ans}`)
        .join('\n');
      
      em.addFields({ name: 'Options', value: optionsText, inline: false });
      em.setFooter({ text: `React with your answer! 30 seconds.` })
        .setTimestamp();
      
      const triviaMessage = await interaction.editReply({ embeds: [em] }).then(response => response || interaction.message);
      
      // Add reaction options
      for (let i = 0; i < 4; i++) {
        await triviaMessage.react(emojis[i]);
      }
      
      // Create collector
      const filter = (reaction, user) => {
        return emojis.includes(reaction.emoji.name) && user.id === interaction.user.id;
      };
      
      const collector = triviaMessage.createReactionCollector({ filter, time: 30000, max: 1 });
      
      collector.on('collect', (reaction) => {
        const answerIndex = emojis.indexOf(reaction.emoji.name);
        
        if (answerIndex === correctIndex) {
          const correctEmbed = new EmbedBuilder()
            .setColor(0x43B581)
            .setTitle('✅ Correct!')
            .setDescription(`The answer is **${correctAnswer}**`)
            .setFooter({ text: `${interaction.user.username} got it right!` });
          
          interaction.followUp({ embeds: [correctEmbed] });
        } else {
          const wrongEmbed = new EmbedBuilder()
            .setColor(0xF04747)
            .setTitle('❌ Wrong!')
            .setDescription(`Correct answer: **${correctAnswer}**\n\nYou answered: **${allAnswers[answerIndex]}**`)
            .setFooter({ text: `Better luck next time!` });
          
          interaction.followUp({ embeds: [wrongEmbed] });
        }
      });
      
      collector.on('end', (collected) => {
        if (collected.size === 0) {
          const timeoutEmbed = new EmbedBuilder()
            .setColor(0xFAA61A)
            .setTitle('⏱️ Time\'s Up!')
            .setDescription(`The correct answer was **${correctAnswer}**`)
            .setFooter({ text: `No answer was selected in time.` });
          
          interaction.followUp({ embeds: [timeoutEmbed] });
        }
      });
    } catch (error) {
      console.error('Trivia error:', error);
      const errorEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Error')
        .setDescription('Could not fetch trivia question. Please try again!');
      
      await interaction.editReply({ embeds: [errorEmbed] });
    }
  }
};