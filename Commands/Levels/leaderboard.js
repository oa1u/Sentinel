const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getLeaderboard } = require('../../Events/Leveling');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('View the server XP leaderboard')
        .addIntegerOption(option =>
            option.setName('limit')
                .setDescription('Number of users to display (max 25)')
                .setRequired(false)
                .setMinValue(5)
                .setMaxValue(25)
        ),
    category: 'levels',
    async execute(interaction) {
        await interaction.deferReply();

        const limit = interaction.options.getInteger('limit') || 10;
        const leaderboard = getLeaderboard(limit);

        if (leaderboard.length === 0) {
            const emptyEmbed = new EmbedBuilder()
                .setColor(0xFAA61A)
                .setTitle('📊 Leaderboard')
                .setDescription('Nobody has earned XP yet! Start chatting to be first!');
            return interaction.editReply({ embeds: [emptyEmbed] });
        }

        // Fetch user details
        const leaderboardText = [];
        
        for (let i = 0; i < leaderboard.length; i++) {
            const entry = leaderboard[i];
            const user = await interaction.client.users.fetch(entry.id).catch(() => null);
            
            // Medal emojis for top 3
            let medal = '';
            if (i === 0) medal = '🥇';
            else if (i === 1) medal = '🥈';
            else if (i === 2) medal = '🥉';
            else medal = `**${i + 1}.**`;

            const username = user ? user.username : 'Unknown User';
            leaderboardText.push(
                `${medal} **${username}**\n` +
                `   ├ Level: **${entry.level}** | XP: **${entry.totalXP.toLocaleString()}**\n` +
                `   └ Messages: **${entry.messages.toLocaleString()}**`
            );
        }

        const leaderboardEmbed = new EmbedBuilder()
            .setColor(0xFFD700)
            .setTitle('🏆 XP Leaderboard')
            .setDescription(
                `Top ${limit} members\n\n` +
                leaderboardText.join('\n\n')
            )
            .setTimestamp()
            .setFooter({ text: `${leaderboard.length} users ranked` });

        await interaction.editReply({ embeds: [leaderboardEmbed] });
    }
};