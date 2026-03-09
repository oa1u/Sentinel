const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');

// Fetch a random dad joke from icanhazdadjoke.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('dadjoke')
        .setDescription('Get a random dad joke'),
    category: 'fun',
    async execute(interaction) {
        await interaction.deferReply();

        try {
            const response = await fetch('https://icanhazdadjoke.com/', {
                headers: {
                    Accept: 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const jokeData = await response.json();
            const jokeText = String(jokeData?.joke || '').trim();

            const em = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('😄 Dad Joke')
                .setDescription(jokeText || 'No joke found. Try again!')
                .setFooter({ text: `Requested by ${interaction.user.username}` })
                .setTimestamp();

            await interaction.editReply({ embeds: [em] });
        } catch (error) {
            const errorEmbed = new EmbedBuilder()
                .setColor(0xF04747)
                .setTitle('❌ Error')
                .setDescription('Could not fetch a dad joke. Please try again!');

            await interaction.editReply({ embeds: [errorEmbed] });
        }
    }
};