const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const MySQLDatabaseManager = require('../../Functions/MySQLDatabaseManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('streak')
        .setDescription('View your or another user\'s message streak')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User to check streak for')
                .setRequired(false)
        ),
    category: 'levels',
    async execute(interaction) {
        const targetUser = interaction.options.getUser('user') || interaction.user;

        if (targetUser.bot) {
            const errorEmbed = new EmbedBuilder()
                .setColor(0xF04747)
                .setTitle('❌ Invalid User')
                .setDescription('Bots do not have message streaks.');
            return interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
        }

        await MySQLDatabaseManager.ensureMessageStreakColumns();
        const info = await MySQLDatabaseManager.getUserInfo(targetUser.id);

        const streak = Number(info?.message_streak || 0);
        const best = Number(info?.message_streak_best || 0);
        const lastDay = info?.message_streak_last_day ? Number(info.message_streak_last_day) : null;

        const now = new Date();
        const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        const yesterdayStart = todayStart - 86400000;

        let status = 'No activity yet';
        if (lastDay === todayStart) {
            status = 'Active today';
        } else if (lastDay === yesterdayStart) {
            status = 'On track (message today to continue)';
        } else if (lastDay) {
            status = 'Streak broken';
        }

        const lastActiveText = lastDay
            ? `<t:${Math.floor(lastDay / 1000)}:D>`
            : 'No messages yet';

        const streakEmbed = new EmbedBuilder()
            .setColor(0x57F287)
            .setAuthor({
                name: `${targetUser.username}\'s Streak`,
                iconURL: targetUser.displayAvatarURL()
            })
            .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
            .addFields(
                { name: '🔥 Current Streak', value: `**${streak}** day${streak === 1 ? '' : 's'}`, inline: true },
                { name: '🏆 Best Streak', value: `**${best}** day${best === 1 ? '' : 's'}`, inline: true },
                { name: '📌 Status', value: status, inline: true },
                { name: '📅 Last Active Day (UTC)', value: lastActiveText, inline: false }
            )
            .setTimestamp();

        return interaction.reply({ embeds: [streakEmbed] });
    }
};
