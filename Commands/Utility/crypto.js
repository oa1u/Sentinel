const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('crypto')
    .setDescription('Get current cryptocurrency prices')
    .addStringOption(option =>
      option.setName('coin')
        .setDescription('Cryptocurrency symbol (e.g., BTC, ETH, DOGE)')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('currency')
        .setDescription('Currency to display price in (default: USD)')
        .setRequired(false)
        .addChoices(
          { name: 'USD', value: 'USD' },
          { name: 'EUR', value: 'EUR' },
          { name: 'GBP', value: 'GBP' },
          { name: 'JPY', value: 'JPY' },
          { name: 'AUD', value: 'AUD' },
          { name: 'CAD', value: 'CAD' }
        )
    ),
  category: 'utility',
  async execute(interaction) {
    await interaction.deferReply();
    
    const coinQuery = interaction.options.getString('coin').trim();
    const currency = (interaction.options.getString('currency') || 'USD').toUpperCase();
    
    try {
      const searchResponse = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(coinQuery)}`);
      if (!searchResponse.ok) {
        throw new Error('Search failed');
      }
      const searchData = await searchResponse.json();
      const match = (searchData.coins || []).find((c) => c.symbol.toUpperCase() === coinQuery.toUpperCase())
        || (searchData.coins || []).find((c) => c.id.toUpperCase() === coinQuery.toUpperCase());
      
      if (!match) {
        const errorEmbed = new EmbedBuilder()
          .setColor(0xF04747)
          .setTitle('❌ Error')
          .setDescription(`Cryptocurrency "${coinQuery}" not found. Check the symbol!`);
        return interaction.editReply({ embeds: [errorEmbed] });
      }
      
      const coinId = match.id;
      const marketResponse = await fetch(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=${currency}&ids=${coinId}&sparkline=false&price_change_percentage=1h,24h,7d`
      );
      
      if (!marketResponse.ok) {
        throw new Error('Market data fetch failed');
      }
      
      const marketData = await marketResponse.json();
      const coinData = marketData[0];
      
      if (!coinData) {
        const errorEmbed = new EmbedBuilder()
          .setColor(0xF04747)
          .setTitle('❌ Error')
          .setDescription(`Cryptocurrency "${coinQuery}" not found. Check the symbol!`);
        return interaction.editReply({ embeds: [errorEmbed] });
      }
      
      displayCryptoData(interaction, coinData, currency);
      
    } catch (error) {
      console.error('Error fetching crypto data:', error);
      const errorEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Error')
        .setDescription('Error fetching crypto data. Try again!');
      await interaction.editReply({ embeds: [errorEmbed] });
    }
  }
};

function displayCryptoData(interaction, coinData, currency) {
  const currencySymbols = {
    'USD': '$',
    'EUR': '€',
    'GBP': '£',
    'JPY': '¥',
    'AUD': 'A$',
    'CAD': 'C$'
  };
  
  const symbol = currencySymbols[currency] || currency;
  const price = coinData.current_price;
  const change1h = coinData.price_change_percentage_1h_in_currency;
  const change24h = coinData.price_change_percentage_24h_in_currency;
  const change7d = coinData.price_change_percentage_7d_in_currency;
  const marketCap = coinData.market_cap;
  const volume24h = coinData.total_volume;
  const rank = coinData.market_cap_rank;
  
  const changeEmoji = change24h >= 0 ? '📈' : '📉';
  const changeColor = change24h >= 0 ? 0x00FF00 : 0xFF0000;
  
  const formatChange = (change) => {
    if (!change) return 'N/A';
    return change >= 0 ? `+${change.toFixed(2)}%` : `${change.toFixed(2)}%`;
  };
  
  const formatPrice = (value) => {
    if (value >= 1) {
      return `${symbol}${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    } else {
      return `${symbol}${value.toFixed(8)}`;
    }
  };
  
  const formatLargeNumber = (value) => {
    if (value >= 1e12) return `${symbol}${(value / 1e12).toFixed(2)}T`;
    if (value >= 1e9) return `${symbol}${(value / 1e9).toFixed(2)}B`;
    if (value >= 1e6) return `${symbol}${(value / 1e6).toFixed(2)}M`;
    return `${symbol}${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  };
  
  const em = new EmbedBuilder()
    .setColor(changeColor)
    .setTitle(`💰 ${coinData.name} (${coinData.symbol.toUpperCase()})`)
    .setDescription(rank ? `**Rank:** #${rank}` : 'Rank: N/A')
    .addFields(
      { name: '💵 Current Price', value: formatPrice(price), inline: true },
      { name: `${changeEmoji} 24h Change`, value: formatChange(change24h), inline: true },
      { name: '⏱️ 1h Change', value: formatChange(change1h), inline: true },
      { name: '📊 Market Cap', value: formatLargeNumber(marketCap), inline: true },
      { name: '📦 24h Volume', value: formatLargeNumber(volume24h), inline: true },
      { name: '📈 7d Change', value: formatChange(change7d), inline: true }
    )
    .setFooter({ text: `Data from CoinGecko • Requested by ${interaction.user.username}` })
    .setTimestamp();

  interaction.editReply({ embeds: [em] });
}
