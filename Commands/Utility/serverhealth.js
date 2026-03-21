const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');

// In-memory stats (for demo; for production, use a database or persistent storage)
const stats = {
    joins: [], // { timestamp }
    leaves: [], // { timestamp }
    messages: [] // { timestamp }
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('serverhealth')
        .setDescription('Show server join/leave/message activity rates.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
    category: 'Utility',
    async execute(interaction) {
        const now = Date.now();
        const oneHour = 60 * 60 * 1000;
        const oneDay = 24 * oneHour;

        // Calculate rates
        const joinsLastHour = stats.joins.filter(j => now - j.timestamp <= oneHour).length;
        const joinsLastDay = stats.joins.filter(j => now - j.timestamp <= oneDay).length;
        const leavesLastHour = stats.leaves.filter(l => now - l.timestamp <= oneHour).length;
        const leavesLastDay = stats.leaves.filter(l => now - l.timestamp <= oneDay).length;
        const messagesLastHour = stats.messages.filter(m => now - m.timestamp <= oneHour).length;
        const messagesLastDay = stats.messages.filter(m => now - m.timestamp <= oneDay).length;

        const embed = new EmbedBuilder()
            .setTitle('📊 Server Health Overview')
            .setColor(0x5865F2)
            .addFields(
                { name: 'Joins (1h)', value: String(joinsLastHour), inline: true },
                { name: 'Joins (24h)', value: String(joinsLastDay), inline: true },
                { name: 'Leaves (1h)', value: String(leavesLastHour), inline: true },
                { name: 'Leaves (24h)', value: String(leavesLastDay), inline: true },
                { name: 'Messages (1h)', value: String(messagesLastHour), inline: true },
                { name: 'Messages (24h)', value: String(messagesLastDay), inline: true }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed], flags: 64 });
    },
    // Event hooks to track stats
    onGuildMemberAdd(member) {
        stats.joins.push({ timestamp: Date.now() });
        // Optionally prune old entries
        stats.joins = stats.joins.filter(j => Date.now() - j.timestamp < 7 * 24 * 60 * 60 * 1000);
    },
    onGuildMemberRemove(member) {
        stats.leaves.push({ timestamp: Date.now() });
        stats.leaves = stats.leaves.filter(l => Date.now() - l.timestamp < 7 * 24 * 60 * 60 * 1000);
    },
    onMessageCreate(message) {
        if (!message.guild || message.author.bot) return;
        stats.messages.push({ timestamp: Date.now() });
        stats.messages = stats.messages.filter(m => Date.now() - m.timestamp < 7 * 24 * 60 * 60 * 1000);
    }
};
