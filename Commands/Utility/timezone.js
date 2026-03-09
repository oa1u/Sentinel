const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const moment = require('moment-timezone');
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');

function resolveTimezone(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;

    const normalized = raw.replace(/\s+/g, '_');
    if (moment.tz.zone(normalized)) return normalized;

    const lower = normalized.toLowerCase();
    const match = moment.tz.names().find((name) => name.toLowerCase() === lower);
    return match || null;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('timezone')
        .setDescription('Set or view a user timezone')
        .addSubcommand((sub) =>
            sub
                .setName('set')
                .setDescription('Set your timezone')
                .addStringOption((option) =>
                    option
                        .setName('timezone')
                        .setDescription('Timezone name (e.g., America/New_York)')
                        .setRequired(true)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('view')
                .setDescription('View a user timezone')
                .addUserOption((option) =>
                    option
                        .setName('user')
                        .setDescription('User to check (defaults to you)')
                        .setRequired(false)
                )
        ),
    category: 'utility',
    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'set') {
            const input = interaction.options.getString('timezone', true);
            const timezone = resolveTimezone(input);

            if (!timezone) {
                const example = 'America/New_York';
                return interaction.reply({
                    content: `Invalid timezone. Example: \`${example}\``,
                    ephemeral: true
                });
            }

            const saved = await DatabaseManager.setUserTimezone(interaction.user.id, timezone);
            if (!saved) {
                return interaction.reply({
                    content: 'Could not save your timezone. Please try again later.',
                    ephemeral: true
                });
            }

            const now = moment().tz(timezone).format('dddd, MMM D YYYY • HH:mm z');
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('🕒 Timezone Updated')
                .setDescription(`Your timezone is now **${timezone}**.`)
                .addFields({ name: 'Current Time', value: now, inline: false })
                .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ size: 128 }) })
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }

        const targetUser = interaction.options.getUser('user') || interaction.user;
        const timezone = await DatabaseManager.getUserTimezone(targetUser.id);
        const resolved = timezone || 'UTC';
        const now = moment().tz(resolved).format('dddd, MMM D YYYY • HH:mm z');

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🗺️ Timezone Info')
            .setDescription(`Timezone for **${targetUser.tag}**`)
            .addFields(
                { name: 'Timezone', value: resolved, inline: true },
                { name: 'Current Time', value: now, inline: true }
            )
            .setFooter({ text: timezone ? 'Stored in MySQL' : 'Defaulting to UTC' })
            .setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }
};