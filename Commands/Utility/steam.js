const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
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
            return interaction.reply({ content: 'Steam API key is not set. Please configure it in api.json.', ephemeral: true });
        }
        const input = interaction.options.getString('user');
        let steamId = input;
        // If input is not a 17-digit SteamID, resolve vanity URL
        if (!/^\d{17}$/.test(steamId)) {
            const vanityRes = await fetch(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${STEAM_API_KEY}&vanityurl=${encodeURIComponent(steamId)}`);
            const vanityData = await vanityRes.json();
            if (vanityData.response.success !== 1) {
                return interaction.reply({ content: 'Could not resolve the provided vanity URL.', ephemeral: true });
            }
            steamId = vanityData.response.steamid;
        }

        // Get player summary
        const summaryRes = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${steamId}`);
        const summaryData = await summaryRes.json();
        const player = summaryData.response.players[0];
        if (!player) {
            return interaction.reply({ content: 'Could not find a Steam user with that ID.', ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setTitle(player.personaname)
            .setURL(player.profileurl)
            .setThumbnail(player.avatarfull)
            .addFields(
                { name: 'SteamID64', value: player.steamid, inline: true },
                { name: 'Profile State', value: player.profilestate === 1 ? 'Public' : 'Private', inline: true },
                { name: 'Account Created', value: player.timecreated ? new Date(player.timecreated * 1000).toLocaleDateString() : 'N/A', inline: true },
                { name: 'Country', value: player.loccountrycode || 'N/A', inline: true },
                { name: 'Status', value: getStatus(player.personastate), inline: true }
            )
            .setColor('#171a21');

        await interaction.reply({ embeds: [embed] });
    }
};
