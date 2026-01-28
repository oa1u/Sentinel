const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Create a poll with up to 4 options')
    .addStringOption(option =>
      option.setName('question')
        .setDescription('Your poll question')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('option1')
        .setDescription('First option')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('option2')
        .setDescription('Second option')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('option3')
        .setDescription('Third option (optional)')
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName('option4')
        .setDescription('Fourth option (optional)')
        .setRequired(false)
    ),
  category: 'utility',
  async execute(interaction) {
    const question = interaction.options.getString('question');
    const option1 = interaction.options.getString('option1');
    const option2 = interaction.options.getString('option2');
    const option3 = interaction.options.getString('option3');
    const option4 = interaction.options.getString('option4');
    
    const options = [option1, option2, option3, option4].filter(Boolean);
    const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
    
    if (options.length < 2) {
      const errorEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Invalid')
        .setDescription('Need at least 2 options for a poll!');
      return interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
    }
    
    const pollEmbed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📊 Poll')
      .setDescription(`**${question}**`)
      .setFooter({ text: `Poll created by ${interaction.user.username}` })
      .setTimestamp();
    
    const optionTexts = options
      .map((opt, i) => `${emojis[i]} ${opt}`)
      .join('\n');
    
    pollEmbed.addFields({
      name: 'Options',
      value: optionTexts,
      inline: false
    });
    
    const pollMessage = await interaction.reply({ embeds: [pollEmbed] }).then(response => response || interaction.message);
    
    // React with options
    for (let i = 0; i < options.length; i++) {
      await pollMessage.react(emojis[i]);
    }
  }
};