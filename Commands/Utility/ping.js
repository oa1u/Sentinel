const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Check bot response time and API latency'),
    category: 'utility',
    async execute(interaction) {
        const start = Date.now();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });

        const roundTripMs = Date.now() - start;
        const apiLatencyMs = Math.round(interaction.client.ws.ping);

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🏓 Pong!')
            .setDescription('Bot latency check complete.')
            .addFields(
                { name: 'Round Trip', value: `**${roundTripMs}ms**`, inline: true },
                { name: 'API Latency', value: `**${apiLatencyMs}ms**`, inline: true }
            )
            .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    }
};