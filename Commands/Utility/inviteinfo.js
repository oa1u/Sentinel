const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

function extractInviteCode(input) {
    if (!input) return '';
    const trimmed = input.trim();

    const inviteRegex = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]+)/i;
    const urlMatch = trimmed.match(inviteRegex);
    if (urlMatch && urlMatch[1]) return urlMatch[1];

    return trimmed.replace(/[^A-Za-z0-9-]/g, '');
}

function formatDate(value) {
    if (!value) return 'Unknown';
    const unix = Math.floor(new Date(value).getTime() / 1000);
    return `<t:${unix}:f>\n<t:${unix}:R>`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('inviteinfo')
        .setDescription('Get information about a Discord invite')
        .addStringOption(option =>
            option
                .setName('invite')
                .setDescription('Invite code or full Discord invite URL')
                .setRequired(true)
        ),
    category: 'utility',

    async execute(interaction) {
        const rawInput = interaction.options.getString('invite', true);
        const code = extractInviteCode(rawInput);

        if (!code || code.length < 2) {
            return interaction.reply({
                content: '❌ Please provide a valid invite code or URL.',
                flags: MessageFlags.Ephemeral
            });
        }

        try {
            const invite = await interaction.client.fetchInvite(code, {
                withCounts: true,
                withExpiration: true
            });

            const guildName = invite.guild?.name || 'Unknown Server';
            const guildId = invite.guild?.id || 'Unknown';
            const channelName = invite.channel ? `#${invite.channel.name}` : 'Unknown';
            const channelType = invite.channel?.type ? String(invite.channel.type).replace('Guild', '') : 'Unknown';
            const inviterTag = invite.inviter ? `${invite.inviter.tag} (${invite.inviter.id})` : 'Unknown';
            const uses = invite.uses ?? 'Unknown';
            const maxUses = invite.maxUses ?? 'Unlimited';
            const expiresAt = invite.expiresAt ? formatDate(invite.expiresAt) : 'Never';
            const createdAt = invite.createdAt ? formatDate(invite.createdAt) : 'Unknown';
            const memberCount = invite.memberCount ?? 'Unknown';
            const onlineCount = invite.presenceCount ?? 'Unknown';
            const temporary = invite.temporary ? 'Yes' : 'No';

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('🔎 Invite Information')
                .setDescription(`Details for invite: **discord.gg/${invite.code}**`)
                .addFields(
                    { name: '🏠 Server', value: `${guildName}\n\`${guildId}\``, inline: true },
                    { name: '📺 Channel', value: `${channelName}\nType: ${channelType}`, inline: true },
                    { name: '👤 Inviter', value: inviterTag, inline: false },
                    { name: '📊 Uses', value: `Current: **${uses}**\nMax: **${maxUses}**`, inline: true },
                    { name: '⏳ Expires', value: expiresAt, inline: true },
                    { name: '🧳 Temporary', value: temporary, inline: true },
                    { name: '👥 Members', value: `Total: **${memberCount}**\nOnline: **${onlineCount}**`, inline: true },
                    { name: '🕒 Created', value: createdAt, inline: true },
                    { name: '🔗 URL', value: `[discord.gg/${invite.code}](https://discord.gg/${invite.code})`, inline: true }
                )
                .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
                .setTimestamp();

            if (invite.guild?.iconURL) {
                embed.setThumbnail(invite.guild.iconURL({ size: 256 }));
            }

            return interaction.reply({ embeds: [embed] });
        } catch (error) {
            return interaction.reply({
                content: '❌ Could not fetch that invite. It may be invalid, expired, revoked, or inaccessible.',
                flags: MessageFlags.Ephemeral
            });
        }
    }
};
