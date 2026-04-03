const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours || parts.length) parts.push(`${hours}h`);
    if (minutes || parts.length) parts.push(`${minutes}m`);
    parts.push(`${secs}s`);
    return parts.join(' ');
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('uptime')
        .setDescription('Show how long the bot has been online'),
    category: 'utility',
    async execute(interaction) {
        try {
            const client = interaction.client;
            const uptimeSeconds = client.uptime ? client.uptime / 1000 : process.uptime();
            const readyAt = client.readyAt ? client.readyAt : null;
            const startedAt = readyAt ? Math.floor(readyAt.getTime() / 1000) : null;

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('⏱️ Bot Uptime')
                .setDescription('Current runtime since last start.')
                .addFields(
                    { name: 'Uptime', value: `**${formatDuration(uptimeSeconds)}**`, inline: true },
                    { name: 'Started', value: startedAt ? `<t:${startedAt}:F>` : 'Unknown', inline: true }
                )
                .setFooter({ text: `Requested by ${interaction.user?.tag || 'Unknown'}`, iconURL: interaction.user?.displayAvatarURL?.({ dynamic: true }) || null })
                .setTimestamp();

            // Use editReply if deferred, otherwise use reply
            if (interaction.deferred || interaction.replied) {
                return await interaction.editReply({ embeds: [embed] });
            } else {
                return await interaction.reply({ embeds: [embed] });
            }
        } catch (error) {
            console.error('Error in uptime command:', error);
            // Let the main handler catch this error
            throw error;
        }
    }
};