const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const fetch = require('node-fetch');
const apiConfig = require('../../Config/constants/api.json');
const STEAM_API_KEY = apiConfig.steamapikey;

function getStatus(state) {
    switch (state) {
        case 0: return 'Offline';
        case 1: return 'Online';
        case 2: return 'Busy';
        case 3: return 'Away';
        case 4: return 'Snooze';
        case 5: return 'Looking to Trade';
        case 6: return 'Looking to Play';
        default: return 'Unknown';
    }
}

function getStatusIcon(state) {
    switch (state) {
        case 1: return '🟢';
        case 2: return '⛔';
        case 3: return '🌙';
        case 4: return '💤';
        case 5: return '🔄';
        case 6: return '🎮';
        default: return '⚫';
    }
}

function getStatusColor(state) {
    switch (state) {
        case 1: return 0x57F287;
        case 2: return 0xED4245;
        case 3: return 0xFEE75C;
        case 4: return 0xFAA61A;
        case 5: return 0x5865F2;
        case 6: return 0x3BA55C;
        default: return 0x171A21;
    }
}

function formatUnixTimestamp(unixSeconds) {
    if (!unixSeconds) {
        return 'N/A';
    }

    return `<t:${unixSeconds}:F>\n<t:${unixSeconds}:R>`;
}

function getProfileVisibility(player) {
    if (player.communityvisibilitystate === 3) {
        return player.profilestate === 1 ? 'Public' : 'Public (profile setup incomplete)';
    }

    if (player.communityvisibilitystate === 1) {
        return 'Private';
    }

    return 'Friends Only / Limited';
}

function getCountryName(countryCode) {
    if (!countryCode) {
        return 'N/A';
    }

    try {
        const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
        const regionName = regionNames.of(countryCode.toUpperCase());
        return regionName ? `${regionName} (${countryCode.toUpperCase()})` : countryCode.toUpperCase();
    } catch {
        return countryCode.toUpperCase();
    }
}

function getCurrentActivity(player) {
    if (player.gameextrainfo) {
        return `Playing **${player.gameextrainfo}**`;
    }

    return getStatus(player.personastate);
}

async function fetchSteamJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Steam API request failed with status ${response.status}`);
    }

    return response.json();
}

async function fetchOptionalSteamJson(url) {
    try {
        return await fetchSteamJson(url);
    } catch {
        return null;
    }
}

function formatHoursFromMinutes(minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0) {
        return '0h';
    }

    const hours = minutes / 60;
    if (hours >= 100) {
        return `${Math.round(hours)}h`;
    }

    if (hours >= 10) {
        return `${hours.toFixed(1)}h`;
    }

    return `${hours.toFixed(1).replace(/\.0$/, '')}h`;
}

function formatBanSummary(banInfo) {
    if (!banInfo) {
        return 'Unavailable';
    }

    if (banInfo.CommunityBanned) {
        return 'Community Banned';
    }

    const banParts = [];
    if (banInfo.VACBanned) {
        banParts.push(`VAC: ${banInfo.NumberOfVACBans}`);
    }

    if (banInfo.NumberOfGameBans > 0) {
        banParts.push(`Game Bans: ${banInfo.NumberOfGameBans}`);
    }

    if (banInfo.EconomyBan && banInfo.EconomyBan !== 'none') {
        banParts.push(`Economy: ${banInfo.EconomyBan}`);
    }

    if (!banParts.length) {
        return 'No bans on record';
    }

    if (banInfo.DaysSinceLastBan > 0) {
        banParts.push(`${banInfo.DaysSinceLastBan} day(s) since last ban`);
    }

    return banParts.join('\n');
}

function getTrustLabel(banInfo) {
    if (!banInfo) {
        return 'Unknown';
    }

    if (banInfo.CommunityBanned) {
        return 'High Risk';
    }

    if (banInfo.VACBanned || banInfo.NumberOfGameBans > 0 || (banInfo.EconomyBan && banInfo.EconomyBan !== 'none')) {
        return 'Flagged';
    }

    return 'Clean';
}

function getTrustIcon(banInfo) {
    if (!banInfo) {
        return '⚪';
    }

    if (banInfo.CommunityBanned) {
        return '🔴';
    }

    if (banInfo.VACBanned || banInfo.NumberOfGameBans > 0 || (banInfo.EconomyBan && banInfo.EconomyBan !== 'none')) {
        return '🟠';
    }

    return '🟢';
}

function formatRecentGame(recentGame) {
    if (!recentGame?.name) {
        return 'No recent playtime visible';
    }

    const recentHours = formatHoursFromMinutes(recentGame.playtime_2weeks || 0);
    const totalHours = formatHoursFromMinutes(recentGame.playtime_forever || 0);
    return `**${recentGame.name}**\nLast 2 weeks: ${recentHours}\nTotal: ${totalHours}`;
}

function formatRecentGames(games) {
    if (!Array.isArray(games) || !games.length) {
        return 'No recent playtime visible';
    }

    return games.slice(0, 3).map((game, index) => {
        const recentHours = formatHoursFromMinutes(game.playtime_2weeks || 0);
        const totalHours = formatHoursFromMinutes(game.playtime_forever || 0);
        return `${index + 1}. **${game.name || 'Unknown Game'}**\n2 weeks: ${recentHours} • Total: ${totalHours}`;
    }).join('\n\n');
}

function formatLibraryHighlights(ownedGamesData) {
    const totalGames = ownedGamesData?.response?.game_count;
    const games = Array.isArray(ownedGamesData?.response?.games) ? ownedGamesData.response.games : [];

    if (!Number.isFinite(totalGames) && !games.length) {
        return 'Hidden / Unavailable';
    }

    const sortedGames = [...games]
        .filter((game) => game?.name)
        .sort((left, right) => (right.playtime_forever || 0) - (left.playtime_forever || 0));

    const topGame = sortedGames[0];
    const topGamesText = sortedGames.slice(0, 3).map((game, index) => (
        `${index + 1}. ${game.name} (${formatHoursFromMinutes(game.playtime_forever || 0)})`
    )).join('\n');

    return [
        `Games: ${Number.isFinite(totalGames) ? totalGames.toLocaleString('en-US') : 'Unknown'}`,
        `Most Played: ${topGame ? `${topGame.name} (${formatHoursFromMinutes(topGame.playtime_forever || 0)})` : 'Unavailable'}`,
        `Top Library:\n${topGamesText || 'Unavailable'}`
    ].join('\n');
}

function formatBadgeStats(badgesData, steamLevel) {
    const response = badgesData?.response;
    const badgeCount = Array.isArray(response?.badges) ? response.badges.length : null;
    const level = response?.player_level || steamLevel;
    const xp = response?.player_xp;
    const xpIntoLevel = response?.player_xp_needed_current_level;
    const xpToNext = response?.player_xp_needed_to_level_up;

    if (!Number.isFinite(level) && !Number.isFinite(xp) && !Number.isFinite(badgeCount)) {
        return 'Hidden / Unavailable';
    }

    const lines = [];
    lines.push(`Level: ${Number.isFinite(level) ? level : 'Unknown'}`);
    lines.push(`XP: ${Number.isFinite(xp) ? xp.toLocaleString('en-US') : 'Unknown'}`);
    lines.push(`Badges: ${Number.isFinite(badgeCount) ? badgeCount.toLocaleString('en-US') : 'Unknown'}`);

    if (Number.isFinite(xpIntoLevel) && Number.isFinite(xpToNext)) {
        lines.push(`Progress: ${xpIntoLevel.toLocaleString('en-US')} XP into level`);
        lines.push(`Next Level In: ${xpToNext.toLocaleString('en-US')} XP`);
    }

    return lines.join('\n');
}

function formatFriendCount(friendListData) {
    const friends = friendListData?.friendslist?.friends || friendListData?.response?.friends || [];
    if (!Array.isArray(friends)) {
        return 'Hidden / Unavailable';
    }

    return friends.length.toLocaleString('en-US');
}

function trimFieldValue(value, maxLength = 1000) {
    const text = String(value || 'N/A');
    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, maxLength - 3)}...`;
}

function hasVisibleValue(value) {
    const normalized = String(value || '').trim();
    return Boolean(normalized)
        && normalized !== 'Hidden / Unavailable'
        && normalized !== 'No recent playtime visible'
        && normalized !== 'Unavailable'
        && normalized !== 'N/A';
}

function getFieldsTextLength(fields) {
    return fields.reduce((total, field) => total + String(field.name || '').length + String(field.value || '').length, 0);
}

function parseSteamInput(input) {
    const trimmedInput = input.trim();

    if (/^\d{17}$/.test(trimmedInput)) {
        return { steamId: trimmedInput };
    }

    let vanityUrl = trimmedInput;
    const normalizedPathInput = trimmedInput
        .replace(/^https?:\/\/(www\.)?steamcommunity\.com\//i, '')
        .replace(/^steamcommunity\.com\//i, '')
        .replace(/^\/+|\/+$/g, '');
    const pathParts = normalizedPathInput.split('/').filter(Boolean);
    const firstSegment = pathParts[0]?.toLowerCase();
    const secondSegment = pathParts[1];

    if (firstSegment === 'profiles' && /^\d{17}$/.test(secondSegment || '')) {
        return { steamId: secondSegment };
    }

    if (firstSegment === 'id' && secondSegment) {
        vanityUrl = secondSegment;
    }

    if (/steamcommunity\.com/i.test(trimmedInput) || /^https?:\/\//i.test(trimmedInput)) {
        const normalizedUrl = /^https?:\/\//i.test(trimmedInput)
            ? trimmedInput
            : `https://${trimmedInput}`;

        let parsedUrl;
        try {
            parsedUrl = new URL(normalizedUrl);
        } catch {
            return { error: 'The provided Steam URL is invalid.' };
        }

        const urlPathParts = parsedUrl.pathname.split('/').filter(Boolean);
        const urlFirstSegment = urlPathParts[0]?.toLowerCase();
        const urlSecondSegment = urlPathParts[1];

        if (urlFirstSegment === 'profiles' && /^\d{17}$/.test(urlSecondSegment || '')) {
            return { steamId: urlSecondSegment };
        }

        if (urlFirstSegment === 'id' && urlSecondSegment) {
            vanityUrl = urlSecondSegment;
        } else {
            return { error: 'The provided Steam URL must use /id/<name> or /profiles/<steamid>.' };
        }
    }

    vanityUrl = decodeURIComponent(vanityUrl).trim().replace(/^@/, '').replace(/^\/+|\/+$/g, '');

    if (!vanityUrl) {
        return { error: 'Please provide a SteamID64, vanity URL, or Steam profile URL.' };
    }

    return { vanityUrl };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('steam')
        .setDescription('Get information about a Steam account by SteamID or vanity URL.')
        .addStringOption(option =>
            option.setName('user')
                .setDescription('SteamID64 or vanity URL')
                .setRequired(true)
        ),
    category: 'Utility',
    async execute(interaction) {
        if (!STEAM_API_KEY || STEAM_API_KEY.startsWith('##REPLACE')) {
            return interaction.reply({ content: 'Steam API key is not set. Please configure it in api.json.', flags: MessageFlags.Ephemeral });
        }

        try {
            const input = interaction.options.getString('user');
            const parsedInput = parseSteamInput(input);

            if (parsedInput.error) {
                return interaction.reply({ content: parsedInput.error, flags: MessageFlags.Ephemeral });
            }

            let steamId = parsedInput.steamId;

            if (!steamId) {
                const vanityRes = await fetch(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${STEAM_API_KEY}&vanityurl=${encodeURIComponent(parsedInput.vanityUrl)}`);
                if (!vanityRes.ok) {
                    return interaction.reply({ content: 'Steam returned an error while resolving that profile.', flags: MessageFlags.Ephemeral });
                }

                const vanityData = await vanityRes.json();
                if (vanityData.response.success !== 1) {
                    return interaction.reply({ content: 'Could not resolve the provided vanity URL.', flags: MessageFlags.Ephemeral });
                }

                steamId = vanityData.response.steamid;
            }

            const summaryData = await fetchSteamJson(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${steamId}`);
            const player = summaryData.response.players[0];
            if (!player) {
                return interaction.reply({ content: 'Could not find a Steam user with that ID.', flags: MessageFlags.Ephemeral });
            }

            const [banData, levelData, recentGamesData, ownedGamesData, badgesData, friendListData] = await Promise.all([
                fetchOptionalSteamJson(`https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${STEAM_API_KEY}&steamids=${steamId}`),
                fetchOptionalSteamJson(`https://api.steampowered.com/IPlayerService/GetSteamLevel/v1/?key=${STEAM_API_KEY}&steamid=${steamId}`),
                fetchOptionalSteamJson(`https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/?key=${STEAM_API_KEY}&steamid=${steamId}&count=3`),
                fetchOptionalSteamJson(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_API_KEY}&steamid=${steamId}&include_appinfo=true&include_played_free_games=true`),
                fetchOptionalSteamJson(`https://api.steampowered.com/IPlayerService/GetBadges/v1/?key=${STEAM_API_KEY}&steamid=${steamId}`),
                fetchOptionalSteamJson(`https://api.steampowered.com/ISteamUser/GetFriendList/v1/?key=${STEAM_API_KEY}&steamid=${steamId}&relationship=friend`)
            ]);

            const visibility = getProfileVisibility(player);
            const activity = getCurrentActivity(player);
            const country = getCountryName(player.loccountrycode);
            const profileSlug = player.profileurl ? player.profileurl.replace(/^https?:\/\/steamcommunity\.com\//i, '').replace(/\/$/, '') : 'N/A';
            const banInfo = banData?.players?.[0] || banData?.response?.players?.[0] || null;
            const steamLevel = levelData?.response?.player_level;
            const recentGames = Array.isArray(recentGamesData?.response?.games) ? recentGamesData.response.games : [];
            const summaryText = [];
            const statusLine = `${getStatusIcon(player.personastate)} ${activity}`;
            const trustLine = `${getTrustIcon(banInfo)} ${getTrustLabel(banInfo)}`;
            const ownedGamesValue = ownedGamesData?.response?.game_count;
            const badgeStats = formatBadgeStats(badgesData, steamLevel);
            const friendCount = formatFriendCount(friendListData);
            const libraryHighlights = formatLibraryHighlights(ownedGamesData);

            summaryText.push(`[Open Profile](${player.profileurl})`);
            if (player.realname) {
                summaryText.push(player.realname);
            }

            const overviewLines = [
                `Status: ${statusLine}`,
                `Visibility: ${visibility}`,
                `Country: ${country}`,
                `🛡️ Trust: ${trustLine}`
            ];

            if (Number.isFinite(steamLevel)) {
                overviewLines.push(`Lvl: ${steamLevel}`);
            }

            if (Number.isFinite(ownedGamesValue)) {
                overviewLines.push(`Games: ${ownedGamesValue.toLocaleString('en-US')}`);
            }

            if (hasVisibleValue(friendCount)) {
                overviewLines.push(`Friends: ${friendCount}`);
            }

            const overviewValue = overviewLines.join('\n');
            const profileFields = [
                { name: '🧾 Overview', value: trimFieldValue(overviewValue), inline: true }
            ];

            if (hasVisibleValue(badgeStats)) {
                profileFields.push({ name: '🏅 Badges & XP', value: trimFieldValue(badgeStats), inline: true });
            }

            profileFields.push({ name: '🆔 SteamID64', value: player.steamid, inline: false });

            if (hasVisibleValue(profileSlug)) {
                profileFields.push({ name: '🔗 Profile Path', value: profileSlug, inline: true });
            }

            if (player.timecreated) {
                profileFields.push({ name: '📅 Created', value: formatUnixTimestamp(player.timecreated), inline: true });
            }

            if (player.lastlogoff) {
                profileFields.push({ name: '🕓 Last Seen', value: formatUnixTimestamp(player.lastlogoff), inline: true });
            }

            const statsFields = [];
            const recentGamesValue = formatRecentGames(recentGames);
            const trustDetailsValue = formatBanSummary(banInfo);

            if (hasVisibleValue(recentGamesValue)) {
                statsFields.push({ name: '🕹 Recent Games', value: trimFieldValue(recentGamesValue), inline: false });
            }

            if (hasVisibleValue(libraryHighlights)) {
                statsFields.push({ name: '📚 Library', value: trimFieldValue(libraryHighlights), inline: false });
            }

            if (hasVisibleValue(trustDetailsValue) && trustDetailsValue !== 'No bans on record') {
                statsFields.push({ name: '🛡 Trust Details', value: trimFieldValue(trustDetailsValue), inline: false });
            }

            const profileEmbed = new EmbedBuilder()
                .setColor(getStatusColor(player.personastate))
                .setAuthor({ name: 'Steam Profile', iconURL: 'https://store.cloudflare.steamstatic.com/public/shared/images/header/logo_steam.svg' })
                .setTitle(player.personaname)
                .setURL(player.profileurl)
                .setDescription(summaryText.join(' • '))
                .setThumbnail(player.avatarfull)
                .addFields(profileFields)
                .setFooter({ text: `Requested by ${interaction.user.username}` })
                .setTimestamp();

            const embeds = [profileEmbed];
            const shouldCollapseToSingleEmbed = statsFields.length > 0
                && statsFields.length <= 2
                && profileFields.length + statsFields.length <= 25
                && getFieldsTextLength(profileFields) + getFieldsTextLength(statsFields) <= 4500;

            if (shouldCollapseToSingleEmbed) {
                profileEmbed.addFields(statsFields);
            } else if (statsFields.length) {
                const statsEmbed = new EmbedBuilder()
                    .setColor(getStatusColor(player.personastate))
                    .setTitle(`${player.personaname} • Activity`)
                    .setURL(player.profileurl)
                    .addFields(statsFields);
                embeds.push(statsEmbed);
            }

            await interaction.reply({ embeds });
        } catch (error) {
            console.error('Steam command failed:', error);
            if (interaction.replied || interaction.deferred) {
                return interaction.followUp({ content: 'Something went wrong while looking up that Steam profile.', flags: MessageFlags.Ephemeral });
            }

            return interaction.reply({ content: 'Something went wrong while looking up that Steam profile.', flags: MessageFlags.Ephemeral });
        }
    }
};