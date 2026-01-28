const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');

// Fallback roasts in case API fails
const fallbackRoasts = [
  "I'd agree with you, but then we'd both be wrong.",
  "You're not stupid; you just have bad luck thinking.",
  "I'd explain it to you, but I left my English-to-Dingbat dictionary at home.",
  "If I wanted to hear from someone with your IQ, I'd watch paint dry.",
  "You bring everyone so much joy... when you leave the room.",
  "I'm not saying you're dumb, but you have the brain capacity of a participation trophy.",
  "You're the reason the gene pool needs a lifeguard.",
  "If stupidity was a crime, you'd be serving a life sentence.",
  "You're like a cloud. When you disappear, it's a beautiful day.",
  "I'd call you a tool, but that would imply you're useful.",
  "You're proof that evolution can go in reverse.",
  "I would insult your intelligence, but I doubt you'd understand.",
  "You're like Monday mornings - nobody likes you.",
  "If laughter is the best medicine, your face must be curing the world.",
  "You're so dense, light bends around you.",
  "I'd challenge you to a battle of wits, but I see you came unarmed.",
  "You have the charisma of a damp sock.",
  "You're the human equivalent of a participation award.",
  "I'd slap you, but that would be animal abuse.",
  "You're living proof that not all people are created equal."
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('roast')
    .setDescription('Get roasted or roast someone else')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to roast (leave empty to roast yourself)')
        .setRequired(false)
    ),
  category: 'fun',
  async execute(interaction) {
    await interaction.deferReply();
    
    const targetUser = interaction.options.getUser('user') || interaction.user;
    let roast;
    
    roast = fallbackRoasts[Math.floor(Math.random() * fallbackRoasts.length)];
    
    const em = new EmbedBuilder()
      .setColor(0xFF4500)
      .setTitle('🔥 Roast')
      .setDescription(`${targetUser}, ${roast}`)
      .setTimestamp();
    
    await interaction.editReply({ embeds: [em] });
  }
};
