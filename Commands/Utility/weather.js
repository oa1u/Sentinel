const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const apiConfig = require('../../Config/constants/api.json');

const WEATHER_API_URL = 'https://api.openweathermap.org/data/2.5/weather';

function toTitleCase(input) {
    return String(input || '')
        .toLowerCase()
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTemp(value) {
    if (!Number.isFinite(value)) return 'N/A';
    return `${Math.round(value)}°C`;
}

function formatWind(speedMs) {
    if (!Number.isFinite(speedMs)) return 'N/A';
    const kmh = speedMs * 3.6;
    return `${Math.round(kmh)} km/h`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('weather')
        .setDescription('Check current weather by city')
        .addStringOption((option) =>
            option
                .setName('city')
                .setDescription('City name (e.g., London)')
                .setRequired(true)
        ),
    category: 'utility',
    async execute(interaction) {
        const apiKey = String(apiConfig?.weatherapikey || '').trim();
        if (!apiKey) {
            return interaction.reply({
                content: 'Weather API key is missing. Please set `weatherapikey` in Config/constants/api.json.',
                flags: MessageFlags.Ephemeral
            });
        }

        const city = interaction.options.getString('city', true).trim();
        if (!city) {
            return interaction.reply({
                content: 'Please provide a city name.',
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply().catch(() => { });

        const url = `${WEATHER_API_URL}?q=${encodeURIComponent(city)}&appid=${encodeURIComponent(apiKey)}&units=metric`;

        let data = null;
        try {
            const response = await fetch(url);
            if (response.status === 404) {
                return interaction.editReply({
                    content: 'City not found. Try a different spelling or include the country (e.g., London, GB).'
                });
            }
            if (!response.ok) {
                return interaction.editReply({
                    content: 'Weather service is unavailable right now. Please try again later.'
                });
            }
            data = await response.json();
        } catch (error) {
            return interaction.editReply({
                content: 'Weather service request failed. Please try again.'
            });
        }

        if (!data || !data.main || !Array.isArray(data.weather)) {
            return interaction.editReply({
                content: 'Weather response was incomplete. Please try again.'
            });
        }

        const locationName = `${data.name || city}${data.sys?.country ? `, ${data.sys.country}` : ''}`;
        const condition = toTitleCase(data.weather[0]?.description || 'Unknown');
        const temp = formatTemp(Number(data.main.temp));
        const feelsLike = formatTemp(Number(data.main.feels_like));
        const humidity = Number(data.main.humidity || 0);
        const wind = formatWind(Number(data.wind?.speed));
        const clouds = Number(data.clouds?.all || 0);
        const updatedAt = Number(data.dt || 0);
        const icon = data.weather[0]?.icon ? `https://openweathermap.org/img/wn/${data.weather[0].icon}@2x.png` : null;

        const embed = new EmbedBuilder()
            .setColor(0x4aa3df)
            .setTitle(`🌤️ Weather for ${locationName}`)
            .setDescription(condition)
            .addFields(
                { name: 'Temperature', value: temp, inline: true },
                { name: 'Feels Like', value: feelsLike, inline: true },
                { name: 'Humidity', value: `${humidity}%`, inline: true },
                { name: 'Wind', value: wind, inline: true },
                { name: 'Clouds', value: `${clouds}%`, inline: true },
                { name: 'Updated', value: updatedAt ? `<t:${updatedAt}:f>` : 'Unknown', inline: true }
            )
            .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
            .setTimestamp();

        if (icon) {
            embed.setThumbnail(icon);
        }

        return interaction.editReply({ embeds: [embed] });
    }
};