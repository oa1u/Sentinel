const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');

function mockText(input) {
    const text = String(input || '').trim();
    if (!text) return '';

    let flip = false;
    return text.split('').map((char) => {
        if (!/[a-z]/i.test(char)) return char;
        flip = !flip;
        return flip ? char.toUpperCase() : char.toLowerCase();
    }).join('');
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('mock')
        .setDescription('Mock some text with alternating caps')
        .addStringOption(option =>
            option.setName('text')
                .setDescription('Text to mock')
                .setRequired(true)
        ),
    category: 'fun',
    async execute(interaction) {
        const input = interaction.options.getString('text');
        const output = mockText(input);

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🤪 Mock Text')
            .setDescription(output || 'Nothing to mock.')
            .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ size: 128 }) })
            .setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }
};