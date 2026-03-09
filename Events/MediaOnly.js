const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { CHANNELS: channelsConfig, ROLES: rolesConfig } = require('../Config/constants');

const rawMediaOnlyIds = channelsConfig?.mediaOnlyChannelIds;
const MEDIA_ONLY_CHANNEL_IDS = new Set(
    Array.isArray(rawMediaOnlyIds)
        ? rawMediaOnlyIds.map((id) => String(id))
        : rawMediaOnlyIds
            ? [String(rawMediaOnlyIds)]
            : []
);
const MEDIA_ONLY_LOG_CHANNEL_ID = channelsConfig?.mediaOnlyLogChannelId
    ? String(channelsConfig.mediaOnlyLogChannelId)
    : null;
const MEDIA_ONLY_EXEMPT_ROLE_IDS = [
    rolesConfig?.administratorRoleId,
    rolesConfig?.moderatorRoleId
].filter(Boolean).map((id) => String(id));

function isRoleWhitelisted(member) {
    if (!member || !MEDIA_ONLY_EXEMPT_ROLE_IDS.length) return false;
    return MEDIA_ONLY_EXEMPT_ROLE_IDS.some((roleId) => member.roles?.cache?.has(roleId));
}

function hasMedia(message) {
    if (message.attachments?.size) return true;
    if (message.stickers?.size) return true;

    if (Array.isArray(message.embeds) && message.embeds.length) {
        return message.embeds.some((embed) => {
            return Boolean(
                embed?.image?.url
                || embed?.video?.url
                || embed?.thumbnail?.url
            );
        });
    }

    return false;
}

function buildLogEmbed(message) {
    const content = String(message.content || '').trim();
    const safeContent = content.length > 900 ? `${content.slice(0, 900)}...` : (content || 'No text content');

    return new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('Media-only message removed')
        .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL({ size: 128 }) })
        .addFields(
            { name: 'User', value: `${message.author.toString()} (ID: ${message.author.id})`, inline: false },
            { name: 'Channel', value: `${message.channel} (ID: ${message.channelId})`, inline: false },
            { name: 'Message', value: safeContent, inline: false }
        )
        .setTimestamp()
        .setFooter({ text: `User ID: ${message.author.id}` });
}

async function sendTempWarning(message) {
    const warningEmbed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle('Media-only channel')
        .setDescription('This channel only allows images, videos, or files.')
        .addFields(
            { name: 'How to post', value: 'Attach a file or upload media with your message.', inline: false }
        )
        .setFooter({ text: 'This notice will disappear shortly.' });

    const warning = await message.channel
        .send({ content: `${message.author}`, embeds: [warningEmbed] })
        .catch(() => null);

    if (warning) {
        setTimeout(() => {
            warning.delete().catch(() => null);
        }, 8000);
    }
}

module.exports = {
    name: 'messageCreate',
    disabled: true,
    async execute(message) {
        return this.handleMessageCreate(message);
    },
    async handleMessageCreate(message) {
        try {
            if (!message || !message.guild || !message.author || message.author.bot) return;
            if (!MEDIA_ONLY_CHANNEL_IDS.has(String(message.channelId))) return;

            if (message.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) return;
            if (isRoleWhitelisted(message.member)) return;

            if (hasMedia(message)) return;

            const logChannel = MEDIA_ONLY_LOG_CHANNEL_ID
                ? message.guild.channels.cache.get(MEDIA_ONLY_LOG_CHANNEL_ID)
                : null;

            await message.delete().catch(() => null);
            await sendTempWarning(message);

            if (logChannel) {
                await logChannel.send({ embeds: [buildLogEmbed(message)] }).catch(() => null);
            }
        } catch (error) {
            console.error('[MediaOnly] Failed to enforce media-only channel:', error?.message || error);
        }
    }
};