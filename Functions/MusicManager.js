// MusicManager
// Handles playback queues, stream sourcing (play-dl / ytdl / yt-dlp), and
// voice connection management for the bot's music features.
const {
    AudioPlayerStatus,
    NoSubscriberBehavior,
    StreamType,
    VoiceConnectionStatus,
    createAudioPlayer,
    createAudioResource,
    entersState,
    getVoiceConnection,
    joinVoiceChannel
} = require('@discordjs/voice');
const playdl = require('play-dl');
const prism = require('prism-media');
const ffmpegPath = require('ffmpeg-static');
let ytdl = null;
try {
    ytdl = require('ytdl-core');
} catch (_) {
    ytdl = null;
}
let ytdlp = null;
try {
    ytdlp = require('yt-dlp-exec');
} catch (_) {
    ytdlp = null;
}

const guildQueues = new Map();
const pendingAutoLeaveTimers = new Map();
const AUTO_LEAVE_GRACE_MS = 30_000;
const MAX_TRACK_FAILURE_ATTEMPTS = 2;
const STALL_TIMEOUT_MS = 20_000;
const RECONNECT_ATTEMPTS = 3;
const RECONNECT_TIMEOUT_MS = 5_000;

function clearAutoLeaveTimer(guildId) {
    const pendingTimer = pendingAutoLeaveTimers.get(guildId);
    if (!pendingTimer) return;
    clearTimeout(pendingTimer);
    pendingAutoLeaveTimers.delete(guildId);
}

function scheduleTrackRetry(queue, track, reasonLabel) {
    if (!queue || !track) return false;

    const currentFailures = Number(track.failureCount) || 0;
    const nextFailures = currentFailures + 1;
    track.failureCount = nextFailures;

    if (nextFailures >= MAX_TRACK_FAILURE_ATTEMPTS) {
        console.warn(`[Music] Skipping track after ${nextFailures} failed attempt(s): ${track.url} (${reasonLabel})`);
        return false;
    }

    queue.tracks.unshift(track);
    console.warn(`[Music] Retrying track (${nextFailures}/${MAX_TRACK_FAILURE_ATTEMPTS - 1} retry): ${track.url} (${reasonLabel})`);
    return true;
}

function clearStallTimer(queue) {
    if (!queue?.stallTimer) return;
    clearTimeout(queue.stallTimer);
    queue.stallTimer = null;
}

async function attemptReconnect(queue) {
    if (!queue?.connection || !queue.voiceChannelId || !queue.adapterCreator) return false;

    for (let attempt = 0; attempt < RECONNECT_ATTEMPTS; attempt += 1) {
        try {
            await entersState(queue.connection, VoiceConnectionStatus.Ready, RECONNECT_TIMEOUT_MS);
            return true;
        } catch (_) {
            // continue retries
        }
    }

    try {
        queue.connection.destroy();
    } catch (_) {
        // ignore destroy errors
    }

    try {
        const connection = joinVoiceChannel({
            channelId: queue.voiceChannelId,
            guildId: queue.guildId,
            adapterCreator: queue.adapterCreator,
            selfDeaf: true,
            selfMute: false
        });

        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
        connection.subscribe(queue.player);
        queue.connection = connection;
        registerConnectionHandlers(queue);
        return true;
    } catch (error) {
        console.error(`[Music] Failed to reconnect in guild ${queue.guildId}:`, error?.message || error);
        stop(queue.guildId);
        return false;
    }
}

function registerConnectionHandlers(queue) {
    const connection = queue?.connection;
    if (!connection || connection._musicHandlersAttached) return;

    connection._musicHandlersAttached = true;

    connection.on('stateChange', async (_, newState) => {
        if (newState.status === VoiceConnectionStatus.Disconnected) {
            await attemptReconnect(queue);
        }

        if (newState.status === VoiceConnectionStatus.Destroyed) {
            stop(queue.guildId);
        }
    });

    connection.on('error', (error) => {
        console.error(`[Music] Voice connection error in guild ${queue.guildId}:`, error?.message || error);
    });
}

function extractYouTubeVideoId(input) {
    if (!input || typeof input !== 'string') return null;

    try {
        const parsed = new URL(input.trim());
        const host = parsed.hostname.toLowerCase();

        if (host === 'youtu.be') {
            return parsed.pathname.replace('/', '').trim() || null;
        }

        if (host.includes('youtube.com')) {
            if (parsed.pathname === '/watch') {
                return parsed.searchParams.get('v');
            }
            if (parsed.pathname.startsWith('/shorts/')) {
                return parsed.pathname.split('/')[2] || null;
            }
            if (parsed.pathname.startsWith('/live/')) {
                return parsed.pathname.split('/')[2] || null;
            }
        }
    } catch (_) {
        // Ignore parse errors and fall back to regex extraction.
    }

    const regexMatch = String(input).match(/(?:v=|youtu\.be\/|shorts\/|live\/)([A-Za-z0-9_-]{11})/);
    return regexMatch?.[1] || null;
}

function normalizeYouTubeUrl(input, fallbackVideoId = null) {
    const videoId = extractYouTubeVideoId(input) || fallbackVideoId || null;
    if (!videoId) return input;
    return `https://www.youtube.com/watch?v=${videoId}`;
}

async function buildPlaybackSource(track) {
    const playbackUrls = [
        track.url,
        normalizeYouTubeUrl(track.url, track.videoId || null)
    ].filter((url, index, arr) => url && arr.indexOf(url) === index);

    let lastError = null;

    for (const attemptUrl of playbackUrls) {
        try {
            const stream = await playdl.stream(attemptUrl, { discordPlayerCompatibility: true });
            return {
                stream: stream.stream,
                inputType: stream.type,
                resolvedUrl: attemptUrl,
                backend: 'play-dl'
            };
        } catch (error) {
            lastError = error;
            const message = String(error?.message || '').toLowerCase();
            if (!message.includes('invalid url')) {
                throw error;
            }
        }
    }

    const videoId = extractYouTubeVideoId(track.url) || track.videoId || null;
    if (ytdl && videoId) {
        const fallbackUrl = normalizeYouTubeUrl(track.url, videoId);
        try {
            await ytdl.getInfo(fallbackUrl);

            const stream = ytdl(fallbackUrl, {
                filter: 'audioonly',
                quality: 'highestaudio',
                highWaterMark: 1 << 25
            });

            return {
                stream,
                inputType: StreamType.Arbitrary,
                resolvedUrl: fallbackUrl,
                backend: 'ytdl-core'
            };
        } catch (error) {
            lastError = error;
        }
    }

    if (ytdlp && ffmpegPath && videoId) {
        const fallbackUrl = normalizeYouTubeUrl(track.url, videoId);
        try {
            const info = await ytdlp(fallbackUrl, {
                dumpSingleJson: true,
                noWarnings: true,
                skipDownload: true,
                format: 'bestaudio/best'
            });

            const directUrl = info?.url;
            if (directUrl) {
                const ffmpegStream = new prism.FFmpeg({
                    ffmpegPath,
                    args: [
                        '-reconnect', '1',
                        '-reconnect_streamed', '1',
                        '-reconnect_delay_max', '5',
                        '-i', directUrl,
                        '-analyzeduration', '0',
                        '-loglevel', '0',
                        '-f', 's16le',
                        '-ar', '48000',
                        '-ac', '2'
                    ]
                });

                return {
                    stream: ffmpegStream,
                    inputType: StreamType.Raw,
                    resolvedUrl: fallbackUrl,
                    backend: 'yt-dlp+ffmpeg'
                };
            }
        } catch (error) {
            const rawMessage = String(error?.stderr || error?.message || '').toLowerCase();
            if (rawMessage.includes('this video is not available') || rawMessage.includes('video unavailable')) {
                throw new Error('This video is unavailable or restricted and cannot be played.');
            }
            if (rawMessage.includes('private video')) {
                throw new Error('This video is private and cannot be played.');
            }
            if (rawMessage.includes('sign in to confirm your age') || rawMessage.includes('age-restricted')) {
                throw new Error('This video is age-restricted and cannot be played by the bot.');
            }
            lastError = error;
        }
    }

    throw lastError || new Error('Invalid URL');
}

async function assertTrackPlayable(track) {
    const videoId = extractYouTubeVideoId(track?.url) || track?.videoId || null;
    if (!videoId || !ytdlp) return true;

    const checkUrl = normalizeYouTubeUrl(track.url, videoId);
    try {
        await ytdlp(checkUrl, {
            dumpSingleJson: true,
            noWarnings: true,
            skipDownload: true,
            format: 'bestaudio/best'
        });
        return true;
    } catch (error) {
        const rawMessage = String(error?.stderr || error?.message || '').toLowerCase();
        if (rawMessage.includes('this video is not available') || rawMessage.includes('video unavailable')) {
            throw new Error('This video is unavailable or restricted and cannot be played.');
        }
        if (rawMessage.includes('private video')) {
            throw new Error('This video is private and cannot be played.');
        }
        if (rawMessage.includes('sign in to confirm your age') || rawMessage.includes('age-restricted')) {
            throw new Error('This video is age-restricted and cannot be played by the bot.');
        }
        throw new Error('This track could not be validated for playback right now.');
    }
}

function formatDuration(seconds) {
    const total = Number(seconds) || 0;
    if (total <= 0) return 'Live/Unknown';

    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function createQueue(guildId) {
    const player = createAudioPlayer({
        behaviors: {
            noSubscriber: NoSubscriberBehavior.Pause
        }
    });

    const queue = {
        guildId,
        voiceChannelId: null,
        textChannelId: null,
        adapterCreator: null,
        connection: null,
        player,
        tracks: [],
        currentTrack: null,
        currentResource: null,
        currentStartedAt: null,
        currentPausedAt: null,
        totalPausedMs: 0,
        stallTimer: null,
        volumePercent: 65
    };

    player.on(AudioPlayerStatus.Idle, () => {
        clearStallTimer(queue);
        queue.currentTrack = null;
        queue.currentResource = null;
        queue.currentStartedAt = null;
        queue.currentPausedAt = null;
        queue.totalPausedMs = 0;
        void playNext(guildId);
    });

    player.on('stateChange', (_, newState) => {
        if (newState.status === AudioPlayerStatus.Buffering) {
            clearStallTimer(queue);
            queue.stallTimer = setTimeout(() => {
                if (queue.player.state.status !== AudioPlayerStatus.Buffering) return;
                const stalledTrack = queue.currentTrack;
                queue.currentTrack = null;
                queue.currentResource = null;
                queue.currentStartedAt = null;
                queue.currentPausedAt = null;
                queue.totalPausedMs = 0;
                scheduleTrackRetry(queue, stalledTrack, 'buffering timeout');
                queue.player.stop(true);
            }, STALL_TIMEOUT_MS);
            return;
        }

        if (newState.status === AudioPlayerStatus.Playing) {
            clearStallTimer(queue);
        }
    });

    player.on('error', (error) => {
        console.error(`[Music] Player error in guild ${guildId}:`, error.message);
        const failedTrack = queue.currentTrack;
        queue.currentTrack = null;
        queue.currentResource = null;
        scheduleTrackRetry(queue, failedTrack, 'player error');
        void playNext(guildId);
    });

    guildQueues.set(guildId, queue);
    return queue;
}

function getOrCreateQueue(guildId) {
    return guildQueues.get(guildId) || createQueue(guildId);
}

async function connectToVoiceChannel(interaction, queue) {
    const memberChannel = interaction.member?.voice?.channel;
    if (!memberChannel) {
        throw new Error('You must be connected to a voice channel to use music commands.');
    }

    const permissions = memberChannel.permissionsFor(interaction.guild.members.me);
    if (!permissions?.has('Connect') || !permissions?.has('Speak')) {
        throw new Error('I need **Connect** and **Speak** permissions in your voice channel.');
    }

    if (queue.voiceChannelId && queue.voiceChannelId !== memberChannel.id) {
        throw new Error('Music is already active in another voice channel for this server.');
    }

    let connection = getVoiceConnection(interaction.guildId);
    if (!connection) {
        connection = joinVoiceChannel({
            channelId: memberChannel.id,
            guildId: interaction.guildId,
            adapterCreator: interaction.guild.voiceAdapterCreator,
            selfDeaf: true,
            selfMute: false
        });
    }

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    connection.subscribe(queue.player);

    queue.connection = connection;
    queue.adapterCreator = interaction.guild.voiceAdapterCreator;
    queue.voiceChannelId = memberChannel.id;
    queue.textChannelId = interaction.channelId;
    registerConnectionHandlers(queue);
    return connection;
}

async function resolveTracks(query, requestedBy) {
    const validate = playdl.yt_validate(query);

    if (validate === 'playlist') {
        const playlist = await playdl.playlist_info(query, { incomplete: true });
        const videos = await playlist.all_videos();
        const selected = videos.slice(0, 25);

        const tracks = selected
            .filter(video => video?.url)
            .map(video => ({
                title: video.title || 'Unknown title',
                url: normalizeYouTubeUrl(video.url, video?.id || null),
                videoId: extractYouTubeVideoId(video.url) || video?.id || null,
                durationSec: Number(video.durationInSec) || 0,
                durationText: video.durationRaw || formatDuration(video.durationInSec),
                requestedBy
            }));

        return {
            tracks,
            sourceType: 'playlist',
            sourceTitle: playlist.title || 'Playlist'
        };
    }

    let video = null;
    if (validate === 'video') {
        const info = await playdl.video_basic_info(query);
        video = info?.video_details;
    } else {
        const results = await playdl.search(query, {
            limit: 1,
            source: { youtube: 'video' }
        });
        video = results?.[0] || null;
    }

    if (!video?.url) {
        throw new Error('No playable YouTube result was found for that query.');
    }

    const singleTrack = {
        title: video.title || 'Unknown title',
        url: normalizeYouTubeUrl(video.url, video?.id || null),
        videoId: extractYouTubeVideoId(video.url) || video?.id || null,
        durationSec: Number(video.durationInSec) || 0,
        durationText: video.durationRaw || formatDuration(video.durationInSec),
        requestedBy
    };

    await assertTrackPlayable(singleTrack);

    return {
        tracks: [singleTrack],
        sourceType: 'single',
        sourceTitle: video.title || 'Track'
    };
}

async function playNext(guildId) {
    const queue = guildQueues.get(guildId);
    if (!queue) return;

    const track = queue.tracks.shift();
    if (!track) {
        queue.currentTrack = null;
        queue.currentResource = null;
        if (queue.connection) {
            queue.connection.destroy();
        }
        guildQueues.delete(guildId);
        return;
    }

    try {
        const source = await buildPlaybackSource(track);
        track.url = source.resolvedUrl;
        track.backend = source.backend;

        if (source.backend && source.backend !== 'play-dl') {
            console.log(`[Music] Using fallback backend ${source.backend} for ${track.url}`);
        }

        const resource = createAudioResource(source.stream, { inputType: source.inputType, inlineVolume: true });
        const targetVolume = Math.max(1, Math.min(100, Number(queue.volumePercent) || 65)) / 100;
        if (resource.volume) resource.volume.setVolume(targetVolume);

        queue.currentTrack = track;
        queue.currentResource = resource;
        queue.currentStartedAt = Date.now();
        queue.currentPausedAt = null;
        queue.totalPausedMs = 0;
        queue.player.play(resource);
    } catch (error) {
        console.error(`[Music] Failed to play track ${track.url}:`, error.message);
        queue.currentTrack = null;
        queue.currentResource = null;
        queue.currentStartedAt = null;
        queue.currentPausedAt = null;
        queue.totalPausedMs = 0;
        scheduleTrackRetry(queue, track, 'source/build failure');
        await playNext(guildId);
    }
}

function setVolume(guildId, volumePercent) {
    const queue = guildQueues.get(guildId);
    if (!queue) return null;

    const nextPercent = Math.max(1, Math.min(100, Number(volumePercent) || 65));
    queue.volumePercent = nextPercent;

    if (queue.currentResource?.volume) {
        queue.currentResource.volume.setVolume(nextPercent / 100);
    }

    return nextPercent;
}

async function enqueue(interaction, query) {
    const queue = getOrCreateQueue(interaction.guildId);
    await connectToVoiceChannel(interaction, queue);

    const resolved = await resolveTracks(query, interaction.user.id);
    queue.tracks.push(...resolved.tracks);

    if (queue.player.state.status !== AudioPlayerStatus.Playing && queue.player.state.status !== AudioPlayerStatus.Buffering) {
        await playNext(interaction.guildId);
    }

    return {
        queue,
        addedCount: resolved.tracks.length,
        firstTrack: resolved.tracks[0],
        sourceType: resolved.sourceType,
        sourceTitle: resolved.sourceTitle
    };
}

function getQueue(guildId) {
    return guildQueues.get(guildId) || null;
}

function skip(guildId) {
    const queue = guildQueues.get(guildId);
    if (!queue || queue.tracks.length === 0) return false;
    clearStallTimer(queue);
    return queue.player.stop(true);
}

function stop(guildId) {
    const queue = guildQueues.get(guildId);
    if (!queue) return false;

    clearAutoLeaveTimer(guildId);
    clearStallTimer(queue);
    queue.tracks = [];
    queue.currentTrack = null;
    queue.currentResource = null;
    queue.currentStartedAt = null;
    queue.currentPausedAt = null;
    queue.totalPausedMs = 0;
    queue.player.stop(true);
    if (queue.connection) {
        queue.connection.destroy();
    }
    guildQueues.delete(guildId);
    return true;
}

function pause(guildId) {
    const queue = guildQueues.get(guildId);
    if (!queue) return false;
    if (queue.currentTrack && !queue.currentPausedAt) {
        queue.currentPausedAt = Date.now();
    }
    return queue.player.pause(true);
}

function resume(guildId) {
    const queue = guildQueues.get(guildId);
    if (!queue) return false;
    if (queue.currentPausedAt) {
        queue.totalPausedMs += Math.max(0, Date.now() - queue.currentPausedAt);
        queue.currentPausedAt = null;
    }
    return queue.player.unpause();
}

async function handleVoiceStateUpdate(oldState, newState, client) {
    const guildId = oldState?.guild?.id || newState?.guild?.id;
    if (!guildId) return;

    const queue = guildQueues.get(guildId);
    if (!queue || !queue.voiceChannelId) return;

    const oldChannelId = oldState?.channelId || null;
    const newChannelId = newState?.channelId || null;
    const watchedChannelId = queue.voiceChannelId;

    if (oldChannelId !== watchedChannelId && newChannelId !== watchedChannelId) {
        return;
    }

    if (client?.user?.id && oldState?.id === client.user.id && oldChannelId === watchedChannelId && !newChannelId) {
        stop(guildId);
        return;
    }

    const guild = oldState?.guild || newState?.guild;
    const channel = guild?.channels?.cache?.get(watchedChannelId);
    if (!channel || !channel.members) {
        stop(guildId);
        return;
    }

    const humanCount = channel.members.filter(member => !member.user?.bot).size;
    if (humanCount > 0) {
        clearAutoLeaveTimer(guildId);
        return;
    }

    if (pendingAutoLeaveTimers.has(guildId)) return;

    const timer = setTimeout(async () => {
        pendingAutoLeaveTimers.delete(guildId);

        const currentQueue = guildQueues.get(guildId);
        if (!currentQueue || !currentQueue.voiceChannelId) return;

        const currentGuild = oldState?.guild || newState?.guild;
        const currentChannel = currentGuild?.channels?.cache?.get(currentQueue.voiceChannelId);
        if (!currentChannel || !currentChannel.members) {
            stop(guildId);
            return;
        }

        const remainingHumans = currentChannel.members.filter(member => !member.user?.bot).size;
        if (remainingHumans > 0) return;

        const wasStopped = stop(guildId);
        if (!wasStopped) return;

        const textChannel = currentQueue.textChannelId ? currentGuild?.channels?.cache?.get(currentQueue.textChannelId) : null;
        if (textChannel && typeof textChannel.send === 'function') {
            await textChannel.send('👋 Left voice channel because no one rejoined within 30 seconds.').catch(() => { });
        }
    }, AUTO_LEAVE_GRACE_MS);

    pendingAutoLeaveTimers.set(guildId, timer);
}

module.exports = {
    enqueue,
    getQueue,
    skip,
    stop,
    pause,
    resume,
    setVolume,
    handleVoiceStateUpdate,
    formatDuration
};