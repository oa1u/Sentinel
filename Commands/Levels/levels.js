const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getUserData, getUserRank, calculateRequiredXP } = require('../../Events/Leveling');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('rank')
        .setDescription('View your or another user\'s rank and level progress')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User to check rank for')
                .setRequired(false)
        ),
    category: 'levels',
    async execute(interaction) {
        const targetUser = interaction.options.getUser('user') || interaction.user;
        
        // Don't allow checking bot ranks
        if (targetUser.bot) {
            const errorEmbed = new EmbedBuilder()
                .setColor(0xF04747)
                .setTitle('❌ Invalid User')
                .setDescription('Bots do not have levels!');
            return interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
        }

        const userData = getUserData(targetUser.id);
        const rank = getUserRank(targetUser.id);
        const requiredXP = calculateRequiredXP(userData.level + 1);
        const progress = Math.min(100, Math.max(0, Math.floor((userData.xp / requiredXP) * 100)));

        // Create progress bar
        const barLength = 20;
        const filledBars = Math.max(0, Math.min(barLength, Math.floor((progress / 100) * barLength)));
        const emptyBars = Math.max(0, barLength - filledBars);
        const progressBar = '▰'.repeat(filledBars) + '▱'.repeat(emptyBars);

        const rankEmbed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setAuthor({ 
                name: `${targetUser.username}'s Rank`, 
                iconURL: targetUser.displayAvatarURL() 
            })
            .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
            .addFields(
                { 
                    name: '📊 Level', 
                    value: `**${userData.level}**`, 
                    inline: true 
                },
                { 
                    name: '🏆 Rank', 
                    value: rank ? `**#${rank}**` : 'Unranked', 
                    inline: true 
                },
                { 
                    name: '💬 Messages', 
                    value: `**${userData.messages.toLocaleString()}**`, 
                    inline: true 
                },
                {
                    name: '⬆️ Progress to Next Level',
                    value: `${progressBar} **${progress}%**\n${Math.max(0, userData.xp).toLocaleString()} / ${requiredXP.toLocaleString()} XP`,
                    inline: false
                },
                {
                    name: '📈 Total XP',
                    value: `**${userData.totalXP.toLocaleString()}**`,
                    inline: true
                },
                {
                    name: '🎯 XP Needed',
                    value: `**${Math.max(0, requiredXP - userData.xp).toLocaleString()}**`,
                    inline: true
                }
            )
            .setTimestamp()
            .setFooter({ text: `Keep chatting to level up!` });

        await interaction.reply({ embeds: [rankEmbed] });
    }
};