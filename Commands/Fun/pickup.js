const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');

const pickupLines = [
  "Are you a magician? Because whenever I look at you, everyone else disappears.",
  "Do you have a map? I keep getting lost in your eyes.",
  "Are you a parking ticket? Because you've got 'FINE' written all over you.",
  "Is your name Google? Because you have everything I've been searching for.",
  "Do you believe in love at first sight, or should I walk by again?",
  "Are you a camera? Because every time I look at you, I smile.",
  "If you were a vegetable, you'd be a cute-cumber!",
  "Are you a time traveler? Because I can see you in my future.",
  "Do you have a Band-Aid? Because I just scraped my knee falling for you.",
  "Is your dad a boxer? Because you're a knockout!",
  "Are you French? Because Eiffel for you.",
  "Do you have a pencil? Because I want to erase your past and write our future.",
  "Are you a loan? Because you've got my interest.",
  "If beauty were time, you'd be an eternity.",
  "Are you a Wi-Fi signal? Because I'm feeling a connection.",
  "Do you like Star Wars? Because Yoda one for me!",
  "Are you Australian? Because when I look at you, I feel like I'm down under.",
  "Is your name Chapstick? Because you're da balm!",
  "Are you a banana? Because I find you a-peeling.",
  "Did it hurt when you fell from heaven?",
  "Are you a dictionary? Because you add meaning to my life.",
  "If looks could kill, you'd be a weapon of mass destruction.",
  "Do you play soccer? Because you're a keeper!",
  "Are you a campfire? Because you're hot and I want s'more.",
  "Is your name Ariel? Because we mermaid for each other."
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pickup')
    .setDescription('Get a cheesy pickup line'),
  category: 'fun',
  async execute(interaction) {
    const line = pickupLines[Math.floor(Math.random() * pickupLines.length)];
    
    const em = new EmbedBuilder()
      .setColor(0xFF69B4)
      .setTitle('💘 Pickup Line')
      .setDescription(line)
      .setFooter({ text: `Use at your own risk!` })
      .setTimestamp();
    
    await interaction.reply({ embeds: [em] });
  }
};
