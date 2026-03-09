const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags, EmbedBuilder } = require('discord.js');
const { sendErrorReply, sendWarningReply } = require('../../Functions/EmbedBuilders');
const { ROLES: { moderatorRoleId, administratorRoleId } } = require('../../Config/constants');
const { logModerationAction } = require('../../Functions/ModerationHelper');

function formatSlowmodeDuration(seconds) {
    if (seconds === 0) return 'Disabled';
    if (seconds % 3600 === 0) {
        const hours = seconds / 3600;
        return `${hours} hour${hours === 1 ? '' : 's'} (${seconds}s)`;
    }
    if (seconds % 60 === 0) {
        const minutes = seconds / 60;
        return `${minutes} minute${minutes === 1 ? '' : 's'} (${seconds}s)`;
    }
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

function parseSlowmodeInput(rawInput) {
    if (!rawInput || typeof rawInput !== 'string') {
        return { valid: false, seconds: null, error: 'Please provide a duration like `30s`, `5m`, `2h`, or `0`.' };
    }

    const normalized = rawInput.trim().toLowerCase();

    if (normalized === '0' || normalized === 'off' || normalized === 'disable' || normalized === 'disabled') {
        return { valid: true, seconds: 0 };
    }

    if (/^\d+$/.test(normalized)) {
        const seconds = Number(normalized);
        return Number.isFinite(seconds)
            ? { valid: true, seconds }
            : { valid: false, seconds: null, error: 'Invalid numeric duration.' };
    }

    const match = normalized.match(/^(\d+)(s|m|h|d)$/);
    if (!match) {
        return { valid: false, seconds: null, error: 'Invalid format. Use `30s`, `5m`, `2h`, `1d`, or `0`.' };
    }

    const value = Number(match[1]);
    const unit = match[2];

    const multipliers = {
        s: 1,
        m: 60,
        h: 3600,
        d: 86400
    };

    const seconds = value * multipliers[unit];
    return { valid: true, seconds };
}

async function sendSlowmodeLog(interaction, { success, channel, seconds, reason, details, input }) {
    try {
        const durationText = typeof seconds === 'number' ? formatSlowmodeDuration(seconds) : 'Unknown';

        const embed = new EmbedBuilder()
            .setColor(success ? 0x43B581 : 0xF04747)
            .setTitle(success ? '⏱️ Slowmode Update: Success' : '⏱️ Slowmode Update: Failed')
            .setDescription(success ? 'A slowmode change was applied.' : 'A slowmode change attempt failed.')
            .addFields(
                { name: '📍 Channel', value: channel ? `${channel}` : 'Unknown', inline: true },
                { name: '⌛ Slowmode', value: `**${durationText}**`, inline: true },
                { name: '🧾 Input', value: input ? `\`${input}\`` : 'N/A', inline: true },
                { name: '👤 Moderator', value: `${interaction.user}\n\`${interaction.user.id}\``, inline: true },
                { name: '🏷️ Status', value: success ? '✅ Success' : '❌ Failed', inline: true },
                { name: '💬 Reason', value: reason || 'No reason provided', inline: true },
                { name: success ? '✅ Details' : '❌ Error', value: details || (success ? 'Slowmode updated successfully.' : 'Unknown error.'), inline: false }
            )
            .setFooter({ text: `Guild: ${interaction.guild?.name || 'Unknown'}` })
            .setTimestamp();

        await logModerationAction(interaction, embed);
    } catch (err) {
        console.error('[slowmode] Failed to send log:', err.message);
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('slowmode')
        .setDescription('Set or disable slowmode in a text channel')
        .addStringOption(option =>
            option.setName('seconds')
                .setDescription('Duration: 30s, 5m, 2h, or 0/off (max 6h)')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for changing slowmode')
                .setRequired(true)
        )
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('Channel to apply slowmode to (defaults to current channel)')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(false)
        ),
    category: 'moderation',
    async execute(interaction) {
        try {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
            }

            const hasModeratorRole = interaction.member?.roles?.cache?.has(moderatorRoleId);
            const hasAdminRole = interaction.member?.roles?.cache?.has(administratorRoleId);
            const hasManageChannels = interaction.member?.permissions?.has(PermissionFlagsBits.ManageChannels);

            const hasAccess = hasModeratorRole || hasAdminRole || hasManageChannels;
            if (!hasAccess) {
                await sendSlowmodeLog(interaction, {
                    success: false,
                    channel: interaction.channel,
                    seconds: 0,
                    reason: interaction.options.getString('reason') || 'No reason provided',
                    details: 'Missing required role/permission (Moderator role or Manage Channels).',
                    input: interaction.options.getString('seconds') || 'N/A'
                });
                return sendWarningReply(
                    interaction,
                    'No Permission',
                    'You need the **Moderator role** or **Manage Channels** permission to use this command.'
                );
            }

            const secondsInput = interaction.options.getString('seconds', true);
            const parsed = parseSlowmodeInput(secondsInput);

            if (!parsed.valid) {
                await sendSlowmodeLog(interaction, {
                    success: false,
                    channel: interaction.channel,
                    seconds: 0,
                    reason: interaction.options.getString('reason') || 'No reason provided',
                    details: `Invalid duration input: ${secondsInput}`,
                    input: secondsInput
                });

                return sendWarningReply(
                    interaction,
                    'Invalid Duration',
                    `${parsed.error}\n\nExamples: \`45s\`, \`5m\`, \`2h\`, \`0\`.`
                );
            }

            const seconds = parsed.seconds;
            const channel = interaction.options.getChannel('channel') || interaction.channel;
            const reason = interaction.options.getString('reason') || 'No reason provided';

            if (seconds > 21600) {
                await sendSlowmodeLog(interaction, {
                    success: false,
                    channel,
                    seconds,
                    reason,
                    details: `Duration exceeds max limit (21600s). Input: ${secondsInput}`,
                    input: secondsInput
                });

                return sendWarningReply(
                    interaction,
                    'Duration Too High',
                    'Maximum slowmode is **6 hours** (`21600` seconds).'
                );
            }

            if (!channel || !channel.guild || channel.guild.id !== interaction.guildId) {
                await sendSlowmodeLog(interaction, {
                    success: false,
                    channel: interaction.channel,
                    seconds,
                    reason,
                    details: 'Invalid channel provided (not in this guild).',
                    input: secondsInput
                });
                return sendWarningReply(interaction, 'Invalid Channel', 'Please select a channel in this server.');
            }

            if (typeof channel.setRateLimitPerUser !== 'function') {
                await sendSlowmodeLog(interaction, {
                    success: false,
                    channel,
                    seconds,
                    reason,
                    details: 'Selected channel type does not support slowmode.',
                    input: secondsInput
                });
                return sendWarningReply(interaction, 'Unsupported Channel', 'Slowmode can only be set on text channels that support per-user rate limits.');
            }

            await channel.setRateLimitPerUser(seconds, `${interaction.user.tag}: ${reason}`);

            await sendSlowmodeLog(interaction, {
                success: true,
                channel,
                seconds,
                reason,
                details: 'Slowmode change applied successfully.',
                input: secondsInput
            });

            const durationText = formatSlowmodeDuration(seconds);
            const successEmbed = new EmbedBuilder()
                .setColor(0x43B581)
                .setTitle('⏱️ Slowmode Updated')
                .setDescription('━━━━━━━━━━━━━━━━━━━━━')
                .addFields(
                    { name: '⌛ Slowmode', value: `**${durationText}**`, inline: true },
                    { name: '📍 Channel', value: `${channel}`, inline: true },
                    { name: '🧾 Input', value: `\`${secondsInput}\``, inline: true },
                    { name: '👤 Moderator', value: `${interaction.user}`, inline: true },
                    { name: '💬 Reason', value: `\`\`\`${reason}\`\`\``, inline: false }
                )
                .setFooter({ text: `Action performed by ${interaction.user.username}` })
                .setTimestamp();

            await interaction.editReply({ embeds: [successEmbed] });
        } catch (error) {
            console.error('[slowmode] Error:', error.message);

            await sendSlowmodeLog(interaction, {
                success: false,
                channel: interaction.options?.getChannel('channel') || interaction.channel,
                seconds: (() => {
                    const fallback = interaction.options?.getString('seconds');
                    const parsed = parseSlowmodeInput(fallback || '0');
                    return parsed.valid ? parsed.seconds : 0;
                })(),
                reason: interaction.options?.getString('reason') || 'No reason provided',
                details: error.message || 'Unknown error while updating slowmode.',
                input: interaction.options?.getString('seconds') || 'N/A'
            });

            await sendErrorReply(
                interaction,
                'Slowmode Failed',
                `Could not update slowmode.\nError: ${error.message}`
            );
        }
    }
};