const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const MusicManager = require('../../Functions/MusicManager');
const RateLimiter = require('../../Functions/RateLimiter');
const { sendEmbedReply, sendErrorReply, sendSuccessReply, sendWarningReply, sendInfoReply } = require('../../Functions/EmbedBuilders');

const MAX_LYRICS_CHARS = 3800;
const PROGRESS_BAR_LENGTH = 18;
const MUTATING_SUBCOMMANDS = new Set(['play', 'skip', 'stop', 'pause', 'resume', 'volume', 'shuffle', 'remove']);

function cleanTrackTitle(input) {
    if (!input) return '';
    return String(input)
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\([^)]*\)/g, '')
        .replace(/\b(official|video|lyrics|audio|visualizer|hd|4k)\b/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function parseArtistTitle(input) {
    const cleaned = cleanTrackTitle(input);
    if (!cleaned) return { artist: null, title: null };

    const separators = [' - ', ' – ', ' — ', ' | ', ' : '];
    for (const separator of separators) {
        const split = cleaned.split(separator);
        if (split.length >= 2) {
            const artist = split.shift().trim();
            const title = split.join(separator).trim();
            return { artist: artist || null, title: title || null };
        }
    }

    return { artist: null, title: cleaned };
}

function buildProgressBar(elapsedSec, durationSec) {
    if (!durationSec || durationSec <= 0) {
        return { bar: 'Live/Unknown', label: 'Live/Unknown' };
    }

    const safeElapsed = Math.max(0, Math.min(durationSec, elapsedSec));
    const progress = safeElapsed / durationSec;
    const filled = Math.max(0, Math.min(PROGRESS_BAR_LENGTH - 1, Math.round(progress * (PROGRESS_BAR_LENGTH - 1))));
    const bar = `${'='.repeat(filled)}>${'-'.repeat(PROGRESS_BAR_LENGTH - filled - 1)}`;
    const label = `${MusicManager.formatDuration(safeElapsed)} / ${MusicManager.formatDuration(durationSec)}`;
    return { bar, label };
}

function getElapsedSeconds(queue) {
    if (!queue?.currentStartedAt) return 0;
    const now = queue.currentPausedAt || Date.now();
    const elapsedMs = Math.max(0, now - queue.currentStartedAt - (queue.totalPausedMs || 0));
    return Math.floor(elapsedMs / 1000);
}

async function fetchLyrics(artist, title) {
    const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    if (!data?.lyrics) return null;
    return data.lyrics;
}

async function fetchLyricsFromLrcLib({ artist, title }) {
    const params = new URLSearchParams();
    if (title) params.set('track_name', title);
    if (artist) params.set('artist_name', artist);

    const url = `https://lrclib.net/api/search?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    if (!Array.isArray(data) || data.length === 0) return null;

    const match = data.find(item => item?.plainLyrics || item?.syncedLyrics) || null;
    const lyrics = match?.plainLyrics || match?.syncedLyrics || null;
    if (!lyrics) return null;
    return {
        lyrics,
        source: 'lrclib',
        artist: match?.artistName || artist || null,
        title: match?.trackName || title || null
    };
}

function buildUpcomingQueueLines(queue) {
    return queue.tracks.slice(0, 10).map((track, index) => {
        const duration = track.durationText || MusicManager.formatDuration(track.durationSec);
        return `**${index + 1}.** [${track.title}](${track.url}) • ${duration}`;
    });
}

function getUpcomingDurationLabel(tracks) {
    const totalSeconds = tracks.reduce((sum, track) => sum + (Number(track?.durationSec) || 0), 0);
    return MusicManager.formatDuration(totalSeconds);
}

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
                .setName('shuffle')
                .setDescription('Shuffle the upcoming queue')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('Remove a track from the upcoming queue')
                .addIntegerOption(option =>
                    option
                        .setName('position')
                        .setDescription('Upcoming queue position to remove')
                        .setMinValue(1)
                        .setRequired(true)
                )
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
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('lyrics')
                .setDescription('Show lyrics for the current song or a query')
                .addStringOption(option =>
                    option
                        .setName('query')
                        .setDescription('Optional: Artist - Title')
                        .setRequired(false)
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
        const queue = MusicManager.getQueue(interaction.guildId);

        if (MUTATING_SUBCOMMANDS.has(subcommand) && !RateLimiter.isExempt(interaction.member)) {
            const limitState = RateLimiter.checkLimit(interaction.user.id, `music:${subcommand}`);
            if (limitState.limited) {
                return sendWarningReply(
                    interaction,
                    'Slow Down',
                    `You are using music controls too quickly. Try again in **${limitState.retryAfter}s**.`
                );
            }

            RateLimiter.recordUsage(interaction.user.id, `music:${subcommand}`);
        }

        try {
            if (subcommand === 'play') {
                if (!memberVoiceChannelId) {
                    return sendWarningReply(interaction, 'Join A Voice Channel', 'You must join a voice channel before using music commands.');
                }

                if (botVoiceChannelId && botVoiceChannelId !== memberVoiceChannelId) {
                    return sendWarningReply(
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

            if (subcommand === 'lyrics') {
                const queryInput = interaction.options.getString('query') || null;
                const fallbackTitle = queue?.currentTrack?.title || null;
                const lookupTitle = queryInput || fallbackTitle;

                if (!lookupTitle) {
                    return sendInfoReply(interaction, 'No Track Found', 'Start music or provide `Artist - Title` to fetch lyrics.');
                }

                const parsed = parseArtistTitle(lookupTitle);
                const artist = parsed.artist || null;
                const title = parsed.title || null;
                if (!title) {
                    return sendInfoReply(interaction, 'Need A Title', 'Please provide a track name like `Artist - Title` or a song title.');
                }

                let lyrics = null;
                let resolvedArtist = artist;
                let resolvedTitle = title;
                let sourceLabel = null;

                if (artist) {
                    lyrics = await fetchLyrics(artist, title);
                    sourceLabel = lyrics ? 'lyrics.ovh' : null;
                }

                if (!lyrics) {
                    const lrclib = await fetchLyricsFromLrcLib({ artist, title });
                    if (lrclib?.lyrics) {
                        lyrics = lrclib.lyrics;
                        resolvedArtist = lrclib.artist || resolvedArtist;
                        resolvedTitle = lrclib.title || resolvedTitle;
                        sourceLabel = 'lrclib.net';
                    }
                }

                if (!lyrics) {
                    return sendInfoReply(interaction, 'Lyrics Not Found', 'No lyrics were found for that track. Try a different query.');
                }

                const clipped = lyrics.length > MAX_LYRICS_CHARS
                    ? `${lyrics.slice(0, MAX_LYRICS_CHARS).trim()}...`
                    : lyrics.trim();

                const embed = new EmbedBuilder()
                    .setColor(0x1DB954)
                    .setTitle(`📄 Lyrics: ${resolvedTitle || title}`)
                    .setDescription(clipped)
                    .setFooter({ text: `Artist: ${resolvedArtist || 'Unknown'}${sourceLabel ? ` • Source: ${sourceLabel}` : ''}` });

                return sendEmbedReply(interaction, embed, { ephemeral: true });
            }

            if (!queue) {
                return sendInfoReply(interaction, 'No Active Music Session', 'Use `/music play` first to start playback.');
            }

            if (!memberVoiceChannelId) {
                return sendWarningReply(interaction, 'Join A Voice Channel', 'You must join a voice channel before using music commands.');
            }

            const expectedVoiceChannelId = queue.voiceChannelId || botVoiceChannelId;
            if (!expectedVoiceChannelId || memberVoiceChannelId !== expectedVoiceChannelId) {
                return sendWarningReply(
                    interaction,
                    'Wrong Voice Channel',
                    'You must be in the same voice channel as the bot to use music controls.'
                );
            }

            if (subcommand === 'skip') {
                const skipped = MusicManager.skip(interaction.guildId);
                if (!skipped) {
                    return sendInfoReply(interaction, 'Nothing To Skip', 'There is no active track to skip right now.');
                }
                return sendSuccessReply(interaction, 'Track Skipped', 'Skipped the current track.');
            }

            if (subcommand === 'stop') {
                const stopped = MusicManager.stop(interaction.guildId);
                if (!stopped) {
                    return sendInfoReply(interaction, 'Nothing To Stop', 'There is no active music session.');
                }
                return sendSuccessReply(interaction, 'Playback Stopped', 'Stopped music and cleared the queue.');
            }

            if (subcommand === 'pause') {
                const paused = MusicManager.pause(interaction.guildId);
                if (!paused) {
                    return sendWarningReply(interaction, 'Cannot Pause', 'Playback is not currently running.');
                }
                return sendSuccessReply(interaction, 'Playback Paused', 'Paused the current track.');
            }

            if (subcommand === 'resume') {
                const resumed = MusicManager.resume(interaction.guildId);
                if (!resumed) {
                    return sendWarningReply(interaction, 'Cannot Resume', 'Playback is not paused right now.');
                }
                return sendSuccessReply(interaction, 'Playback Resumed', 'Resumed the current track.');
            }

            if (subcommand === 'volume') {
                const requestedLevel = interaction.options.getInteger('level', true);
                const appliedLevel = MusicManager.setVolume(interaction.guildId, requestedLevel);
                if (appliedLevel === null) {
                    return sendInfoReply(interaction, 'No Active Music Session', 'Use `/music play` first to start playback.');
                }
                return sendSuccessReply(interaction, 'Volume Updated', `Set volume to **${appliedLevel}%**.`);
            }

            if (subcommand === 'shuffle') {
                const shuffledCount = MusicManager.shuffle(interaction.guildId);
                if (!shuffledCount) {
                    return sendInfoReply(interaction, 'Not Enough Tracks', 'Add at least two upcoming tracks before shuffling the queue.');
                }

                return sendSuccessReply(interaction, 'Queue Shuffled', `Shuffled **${shuffledCount}** upcoming track(s).`);
            }

            if (subcommand === 'remove') {
                const position = interaction.options.getInteger('position', true);
                const removedTrack = MusicManager.removeTrack(interaction.guildId, position);
                if (!removedTrack) {
                    return sendInfoReply(interaction, 'Invalid Position', 'That upcoming queue position does not exist.');
                }

                return sendSuccessReply(interaction, 'Track Removed', `Removed **${removedTrack.title}** from the queue.`);
            }

            if (subcommand === 'nowplaying') {
                const current = queue.currentTrack || queue.tracks[0];
                if (!current) {
                    return sendInfoReply(interaction, 'Nothing Playing', 'Queue is currently empty.');
                }

                const elapsed = current === queue.currentTrack ? getElapsedSeconds(queue) : 0;
                const durationSec = Number(current.durationSec) || 0;
                const progress = buildProgressBar(elapsed, durationSec);
                const thumbnail = current.videoId ? `https://i.ytimg.com/vi/${current.videoId}/hqdefault.jpg` : null;

                const embed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('🎵 Now Playing')
                    .setDescription(`[${current.title}](${current.url})`)
                    .addFields(
                        { name: 'Progress', value: `${progress.bar}\n${progress.label}`, inline: false },
                        { name: 'Requested By', value: `<@${current.requestedBy}>`, inline: true },
                        { name: 'Volume', value: `${queue.volumePercent || 65}%`, inline: true },
                        { name: 'Backend', value: current.backend || 'play-dl', inline: true },
                        { name: 'Upcoming Tracks', value: `${queue.tracks.length}`, inline: true },
                        { name: 'Upcoming Duration', value: getUpcomingDurationLabel(queue.tracks), inline: true }
                    )
                    .setTimestamp();

                if (thumbnail) {
                    embed.setThumbnail(thumbnail);
                }

                return sendEmbedReply(interaction, embed, { ephemeral: true });
            }

            if (subcommand === 'queue') {
                if (!queue.currentTrack && !queue.tracks.length) {
                    return sendInfoReply(interaction, 'Queue Empty', 'No tracks are currently queued.');
                }

                const queueLines = buildUpcomingQueueLines(queue);

                const moreCount = Math.max(queue.tracks.length - 10, 0);
                const currentDescription = queue.currentTrack
                    ? `**Now Playing:** [${queue.currentTrack.title}](${queue.currentTrack.url}) • ${queue.currentTrack.durationText || MusicManager.formatDuration(queue.currentTrack.durationSec)}`
                    : '**Now Playing:** Waiting for the next track to start.';
                const embed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('📜 Music Queue')
                    .setDescription([
                        currentDescription,
                        '',
                        queueLines.length
                            ? `**Up Next:**\n${queueLines.join('\n')}${moreCount ? `\n\n...and **${moreCount}** more track(s).` : ''}`
                            : '**Up Next:** No additional tracks queued.'
                    ].join('\n'))
                    .setFooter({ text: `${queue.tracks.length} upcoming track(s) • ${getUpcomingDurationLabel(queue.tracks)} total` })
                    .setTimestamp();

                return sendEmbedReply(interaction, embed, { ephemeral: true });
            }

            return sendWarningReply(interaction, 'Unknown Action', 'That music action is not supported.');
        } catch (error) {
            console.error('[music] Error:', error.message);
            return sendErrorReply(interaction, 'Music Command Failed', `Could not complete this action.\nError: ${error.message}`);
        }
    }
}