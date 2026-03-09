const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { ROLES: { administratorRoleId } } = require('../../Config/constants');
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');

function formatBytes(bytes) {
    const size = Math.max(0, Number(bytes) || 0);
    if (size < 1024) return `${size} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = size;
    let idx = -1;
    do {
        value /= 1024;
        idx += 1;
    } while (value >= 1024 && idx < units.length - 1);
    return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[idx]}`;
}

function formatDuration(ms) {
    const safe = Math.max(0, Number(ms) || 0);
    const totalSeconds = Math.floor(safe / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (seconds || parts.length === 0) parts.push(`${seconds}s`);
    return parts.join(' ');
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('health')
        .setDescription('Show bot runtime and database health')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    category: 'management',
    async execute(interaction) {
        if (!interaction.member.roles.cache.has(administratorRoleId)) {
            const deniedEmbed = new EmbedBuilder()
                .setColor(0xF04747)
                .setTitle('❌ No Permission')
                .setDescription(`You need the <@&${administratorRoleId}> role to use this command.`);
            return interaction.reply({ embeds: [deniedEmbed], flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const [dbHealth, dbManagerHealth] = await Promise.all([
            DatabaseManager.connection.healthCheck().catch((error) => ({ ok: false, error: error?.message || 'Health check failed' })),
            DatabaseManager.getDatabaseHealth().catch((error) => ({ ok: false, error: error?.message || 'Manager health check failed' }))
        ]);

        const memory = process.memoryUsage();
        const runtimeHealth = interaction.client.runtimeHealth || {};
        const wsPing = typeof interaction.client.ws?.ping === 'number' ? `${interaction.client.ws.ping} ms` : 'N/A';

        const embed = new EmbedBuilder()
            .setColor(dbHealth?.ok ? 0x43B581 : 0xF04747)
            .setTitle('🩺 Bot Health')
            .addFields(
                {
                    name: 'Runtime',
                    value: [
                        `Uptime: **${formatDuration(process.uptime() * 1000)}**`,
                        `Gateway Ping: **${wsPing}**`,
                        `Guilds: **${interaction.client.guilds.cache.size}**`,
                        `Commands: **${interaction.client.slashCommands?.size || 0}**`
                    ].join('\n'),
                    inline: true
                },
                {
                    name: 'Memory',
                    value: [
                        `RSS: **${formatBytes(memory.rss)}**`,
                        `Heap Used: **${formatBytes(memory.heapUsed)}**`,
                        `Heap Total: **${formatBytes(memory.heapTotal)}**`,
                        `External: **${formatBytes(memory.external)}**`
                    ].join('\n'),
                    inline: true
                },
                {
                    name: 'Database',
                    value: [
                        `Connection: **${dbHealth?.ok ? 'Healthy' : 'Unhealthy'}**`,
                        `Latency: **${dbHealth?.latencyMs != null ? `${dbHealth.latencyMs} ms` : 'N/A'}**`,
                        `Manager: **${dbManagerHealth?.ok ? 'Healthy' : 'Unhealthy'}**`,
                        dbHealth?.error ? `Error: \`${String(dbHealth.error).slice(0, 120)}\`` : 'Error: `None`'
                    ].join('\n'),
                    inline: false
                },
                {
                    name: 'Resilience Monitor',
                    value: [
                        `Consecutive DB Failures: **${Number(runtimeHealth.consecutiveDatabaseHealthFailures || 0)}**`,
                        `Last Check: **${runtimeHealth.lastDatabaseHealthCheckAt ? `<t:${Math.floor(runtimeHealth.lastDatabaseHealthCheckAt / 1000)}:R>` : 'N/A'}**`,
                        `Last Result: **${runtimeHealth.lastDatabaseHealth === null ? 'N/A' : runtimeHealth.lastDatabaseHealth ? 'Healthy' : 'Unhealthy'}**`,
                        `Monitor Interval: **${Math.floor((Number(runtimeHealth.healthCheckIntervalMs) || 0) / 1000)}s**`
                    ].join('\n'),
                    inline: false
                },
                {
                    name: 'Background Systems',
                    value: `Job Scheduler: **${interaction.client.jobScheduler ? 'Running' : 'Not Available'}**`,
                    inline: false
                }
            )
            .setFooter({ text: `Requested by ${interaction.user.tag}` })
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    }
};