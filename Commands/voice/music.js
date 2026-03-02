const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const MusicManager = require('../../Functions/MusicManager');
const { sendErrorReply, sendSuccessReply } = require('../../Functions/EmbedBuilders');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('music')
        .setDescription('Play and control music in voice channels')
        .addSubcommand(subcommand =>
            subcommand
                .setName('play')
                .setDescription('Play a song or add it to the queue')
                .addStringOption(option =>
                    option
                        .setName('query')
                        .setDescription('YouTube URL, playlist URL, or search query')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('skip')
                .setDescription('Skip the current song')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('stop')
                .setDescription('Stop playback and clear the queue')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('pause')
                .setDescription('Pause the current song')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('resume')
                .setDescription('Resume paused playback')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('queue')
                .setDescription('Show queued tracks')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('nowplaying')
                .setDescription('Show the currently playing track')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('volume')
                .setDescription('Set playback volume (1-100)')
                .addIntegerOption(option =>
                    option
                        .setName('level')
                        .setDescription('Volume level from 1 to 100')
                        .setMinValue(1)
                        .setMaxValue(100)
                        .setRequired(true)
                )
        ),
    category: 'voice',
    async execute(interaction) {
        if (!interaction.guild || !interaction.member) {
            return interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
        }

        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
        }

        const subcommand = interaction.options.getSubcommand();
        const memberVoiceChannelId = interaction.member.voice?.channelId || null;
        const botVoiceChannelId = interaction.guild.members.me?.voice?.channelId || null;

        try {
            if (subcommand === 'play') {
                if (!memberVoiceChannelId) {
                    return sendErrorReply(interaction, 'Join A Voice Channel', 'You must join a voice channel before using music commands.');
                }

                if (botVoiceChannelId && botVoiceChannelId !== memberVoiceChannelId) {
                    return sendErrorReply(
                        interaction,
                        'Wrong Voice Channel',
                        'You must be in the same voice channel as the bot to use music commands.'
                    );
                }

                const query = interaction.options.getString('query', true);
                const result = await MusicManager.enqueue(interaction, query);

                if (result.sourceType === 'playlist') {
                    return sendSuccessReply(
                        interaction,
                        'Playlist Added',
                        `Added **${result.addedCount}** tracks from **${result.sourceTitle}** to the queue.`
                    );
                }

                return sendSuccessReply(
                    interaction,
                    'Track Added',
                    `Added **${result.firstTrack.title}** (${result.firstTrack.durationText}) to the queue.`
                );
            }

            const queue = MusicManager.getQueue(interaction.guildId);
            if (!queue) {
                return sendErrorReply(interaction, 'No Active Music Session', 'Use `/music play` first to start playback.');
            }

            if (!memberVoiceChannelId) {
                return sendErrorReply(interaction, 'Join A Voice Channel', 'You must join a voice channel before using music commands.');
            }

            const expectedVoiceChannelId = queue.voiceChannelId || botVoiceChannelId;
            if (!expectedVoiceChannelId || memberVoiceChannelId !== expectedVoiceChannelId) {
                return sendErrorReply(
                    interaction,
                    'Wrong Voice Channel',
                    'You must be in the same voice channel as the bot to use music controls.'
                );
            }

            if (subcommand === 'skip') {
                const skipped = MusicManager.skip(interaction.guildId);
                if (!skipped) {
                    return sendErrorReply(interaction, 'Nothing To Skip', 'There is no active track to skip right now.');
                }
                return sendSuccessReply(interaction, 'Track Skipped', 'Skipped the current track.');
            }

            if (subcommand === 'stop') {
                const stopped = MusicManager.stop(interaction.guildId);
                if (!stopped) {
                    return sendErrorReply(interaction, 'Nothing To Stop', 'There is no active music session.');
                }
                return sendSuccessReply(interaction, 'Playback Stopped', 'Stopped music and cleared the queue.');
            }

            if (subcommand === 'pause') {
                const paused = MusicManager.pause(interaction.guildId);
                if (!paused) {
                    return sendErrorReply(interaction, 'Cannot Pause', 'Playback is not currently running.');
                }
                return sendSuccessReply(interaction, 'Playback Paused', 'Paused the current track.');
            }

            if (subcommand === 'resume') {
                const resumed = MusicManager.resume(interaction.guildId);
                if (!resumed) {
                    return sendErrorReply(interaction, 'Cannot Resume', 'Playback is not paused right now.');
                }
                return sendSuccessReply(interaction, 'Playback Resumed', 'Resumed the current track.');
            }

            if (subcommand === 'volume') {
                const requestedLevel = interaction.options.getInteger('level', true);
                const appliedLevel = MusicManager.setVolume(interaction.guildId, requestedLevel);
                if (appliedLevel === null) {
                    return sendErrorReply(interaction, 'No Active Music Session', 'Use `/music play` first to start playback.');
                }
                return sendSuccessReply(interaction, 'Volume Updated', `Set volume to **${appliedLevel}%**.`);
            }

            if (subcommand === 'nowplaying') {
                const current = queue.currentTrack || queue.tracks[0];
                if (!current) {
                    return sendErrorReply(interaction, 'Nothing Playing', 'Queue is currently empty.');
                }

                const embed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('🎵 Now Playing')
                    .setDescription(`[${current.title}](${current.url})`)
                    .addFields(
                        { name: 'Duration', value: current.durationText || MusicManager.formatDuration(current.durationSec), inline: true },
                        { name: 'Requested By', value: `<@${current.requestedBy}>`, inline: true },
                        { name: 'Backend', value: current.backend || 'play-dl', inline: true }
                    )
                    .setTimestamp();

                return interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
            }

            if (subcommand === 'queue') {
                if (!queue.tracks.length) {
                    return sendErrorReply(interaction, 'Queue Empty', 'No tracks are currently queued.');
                }

                const queueLines = queue.tracks.slice(0, 10).map((track, index) => {
                    const duration = track.durationText || MusicManager.formatDuration(track.durationSec);
                    return `**${index + 1}.** [${track.title}](${track.url}) • ${duration}`;
                });

                const moreCount = Math.max(queue.tracks.length - 10, 0);
                const embed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('📜 Music Queue')
                    .setDescription(queueLines.join('\n') + (moreCount ? `\n\n...and **${moreCount}** more track(s).` : ''))
                    .setFooter({ text: `${queue.tracks.length} track(s) queued` })
                    .setTimestamp();

                return interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
            }

            return sendErrorReply(interaction, 'Unknown Action', 'That music action is not supported.');
        } catch (error) {
            console.error('[music] Error:', error.message);
            return sendErrorReply(interaction, 'Music Command Failed', `Could not complete this action.\nError: ${error.message}`);
        }
    }
}