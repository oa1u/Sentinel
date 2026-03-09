const { SlashCommandBuilder, ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const MySQLDatabaseManager = require('../../Functions/MySQLDatabaseManager');
const { sendErrorReply, sendSuccessReply } = require('../../Functions/EmbedBuilders');
const { BLOCKED_WORDS: blockedWordsList } = require('../../Config/constants');
const { createProfanityMatcher } = require('../../Functions/ProfanityFilter');

const blockedWordMatcher = createProfanityMatcher(blockedWordsList);

module.exports = {
    data: new SlashCommandBuilder()
        .setName('voice')
        .setDescription('Manage your temporary Join-to-Create voice channel')
        .addSubcommand(subcommand =>
            subcommand
                .setName('info')
                .setDescription('Show details about your current temporary voice channel')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('name')
                .setDescription('Rename your temporary voice channel')
                .addStringOption(option =>
                    option
                        .setName('name')
                        .setDescription('New channel name')
                        .setRequired(true)
                        .setMinLength(2)
                        .setMaxLength(32)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('limit')
                .setDescription('Set user limit for your temporary voice channel')
                .addIntegerOption(option =>
                    option
                        .setName('slots')
                        .setDescription('0 removes limit, max 99')
                        .setRequired(true)
                        .setMinValue(0)
                        .setMaxValue(99)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('lock')
                .setDescription('Lock your temporary voice channel for @everyone')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('unlock')
                .setDescription('Unlock your temporary voice channel for @everyone')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('permit')
                .setDescription('Allow a specific user to join your temporary voice channel')
                .addUserOption(option =>
                    option
                        .setName('user')
                        .setDescription('User to allow')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('reject')
                .setDescription('Block a specific user from joining your temporary voice channel')
                .addUserOption(option =>
                    option
                        .setName('user')
                        .setDescription('User to block')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('delete')
                .setDescription('Delete your temporary voice channel immediately')
        ),
    category: 'voice',
    async execute(interaction) {
        if (!interaction.guild || !interaction.member) {
            return interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
        }

        const subcommand = interaction.options.getSubcommand();
        const voiceChannel = interaction.member.voice?.channel;

        if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
            return sendErrorReply(interaction, 'Not In Voice Channel', 'Join your temporary voice channel first, then run this command.');
        }

        const jtcData = await MySQLDatabaseManager.getJTCChannel(voiceChannel.id);
        if (!jtcData || jtcData.guild_id !== interaction.guildId) {
            return sendErrorReply(interaction, 'Not A Temporary Channel', 'Your current voice channel is not managed by Join-to-Create.');
        }

        const isOwner = jtcData.owner_id === interaction.user.id;

        if (!isOwner) {
            return sendErrorReply(interaction, 'No Permission', 'Only the creator of this temporary voice channel can use this command.');
        }

        try {
            if (subcommand === 'info') {
                const ownerDisplay = jtcData.owner_id ? `<@${jtcData.owner_id}>` : 'Unknown';
                const isLocked = voiceChannel.permissionsFor(interaction.guild.roles.everyone)?.has(PermissionFlagsBits.Connect) === false;

                const infoEmbed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('🎤 Temporary Voice Channel')
                    .setDescription(`Channel: ${voiceChannel}\nOwner: ${ownerDisplay}`)
                    .addFields(
                        { name: 'User Limit', value: `${voiceChannel.userLimit || 0}`, inline: true },
                        { name: 'Members', value: `${voiceChannel.members.size}`, inline: true },
                        { name: 'Locked', value: isLocked ? 'Yes' : 'No', inline: true }
                    )
                    .setFooter({ text: 'Join-to-Create' })
                    .setTimestamp();

                return interaction.followUp({ embeds: [infoEmbed], flags: MessageFlags.Ephemeral });
            }

            if (subcommand === 'name') {
                const newName = interaction.options.getString('name', true).trim();

                const matchedBlockedWord = blockedWordMatcher.findMatch(newName);
                if (matchedBlockedWord) {
                    return sendErrorReply(
                        interaction,
                        'Blocked Channel Name',
                        `That channel name contains blocked language (${matchedBlockedWord.term}). Please choose a different name.`
                    );
                }

                await voiceChannel.setName(newName, `${interaction.user.tag}: /voice name`);
                return sendSuccessReply(interaction, 'Channel Renamed', `New name: **${newName}**`);
            }

            if (subcommand === 'limit') {
                const slots = interaction.options.getInteger('slots', true);
                await voiceChannel.setUserLimit(slots, `${interaction.user.tag}: /voice limit`);
                return sendSuccessReply(interaction, 'User Limit Updated', `New limit: **${slots}**`);
            }

            if (subcommand === 'lock') {
                await voiceChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
                    Connect: false
                }, { reason: `${interaction.user.tag}: /voice lock` });

                return sendSuccessReply(interaction, 'Channel Locked', 'Your temporary voice channel is now locked for @everyone.');
            }

            if (subcommand === 'unlock') {
                await voiceChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
                    Connect: null
                }, { reason: `${interaction.user.tag}: /voice unlock` });

                return sendSuccessReply(interaction, 'Channel Unlocked', 'Your temporary voice channel is now open for @everyone.');
            }

            if (subcommand === 'permit') {
                const target = interaction.options.getUser('user', true);
                await voiceChannel.permissionOverwrites.edit(target.id, {
                    ViewChannel: true,
                    Connect: true
                }, { reason: `${interaction.user.tag}: /voice permit` });

                return sendSuccessReply(interaction, 'User Allowed', `${target} can now join your temporary voice channel.`);
            }

            if (subcommand === 'reject') {
                const target = interaction.options.getUser('user', true);

                if (target.id === jtcData.owner_id) {
                    return sendErrorReply(interaction, 'Invalid Target', 'You cannot block the channel owner.');
                }

                await voiceChannel.permissionOverwrites.edit(target.id, {
                    Connect: false
                }, { reason: `${interaction.user.tag}: /voice reject` });

                const targetMember = interaction.guild.members.cache.get(target.id);
                if (targetMember?.voice?.channelId === voiceChannel.id) {
                    await targetMember.voice.disconnect(`${interaction.user.tag}: Removed via /voice reject`).catch(() => { });
                }

                return sendSuccessReply(interaction, 'User Blocked', `${target} can no longer join this temporary voice channel.`);
            }

            if (subcommand === 'delete') {
                await MySQLDatabaseManager.deleteJTCChannel(voiceChannel.id);
                await voiceChannel.delete(`${interaction.user.tag}: /voice delete`);
                return sendSuccessReply(interaction, 'Channel Deleted', 'Your temporary voice channel has been deleted.');
            }

            return sendErrorReply(interaction, 'Unknown Action', 'That voice action is not supported.');
        } catch (error) {
            console.error('[voice] Error:', error.message);
            return sendErrorReply(interaction, 'Voice Action Failed', `Could not complete this action.\nError: ${error.message}`);
        }
    }
}