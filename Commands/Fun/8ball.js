const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');

const responses = [
  "It is certain 🎱",
  "It is decidedly so ✅",
  "Without a doubt 💯",
  "Yes definitely 👍",
  "You may rely on it 🤞",
  "As I see it, yes 👀",
  "Most likely 😊",
  "Outlook good 📈",
  "Yes 🎉",
  "Signs point to yes ⭐",
  "Reply hazy, try again 🌫️",
  "Ask again later ⏰",
  "Better not tell you now 🤐",
  "Cannot predict now 🔮",
  "Concentrate and ask again 🧠",
  "Don't count on it ❌",
  "My reply is no 🚫",
  "My sources say no 📵",
  "Outlook not so good 📉",
  "Very doubtful 😔"
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('8ball')
    .setDescription('Ask the magic 8 ball a question')
    .addStringOption(option =>
      option.setName('question')
        .setDescription('Your question for the 8 ball')
        .setRequired(true)
    ),
  category: 'fun',
  async execute(interaction) {
    const question = interaction.options.getString('question');
    const response = responses[Math.floor(Math.random() * responses.length)];

    const em = new EmbedBuilder()
      .setColor(0x000000)
      .setTitle('🎱 Magic 8 Ball')
      .addFields(
        { name: 'Question', value: question, inline: false },
        { name: 'Answer', value: response, inline: false }
      )
      .setFooter({ text: `Asked by ${interaction.user.username}` })
      .setTimestamp();

    await interaction.reply({ embeds: [em] });
  }
};