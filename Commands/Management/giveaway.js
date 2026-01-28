const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { administratorRoleId } = require('../../Config/constants/roles.json');
const giveawayHandler = require('../../Events/Giveaway');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Manage giveaways in your server')
    .addSubcommand(subcommand =>
      subcommand
        .setName('start')
        .setDescription('Start a new giveaway')
        .addStringOption(option =>
          option.setName('duration')
            .setDescription('Duration (examples: 10m, 1h, 2d) - Max 7 days')
            .setRequired(true)
        )
        .addStringOption(option =>
          option.setName('prize')
            .setDescription('The prize for the giveaway')
            .setRequired(true)
            .setMinLength(2)
            .setMaxLength(100)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('extend')
        .setDescription('Extend an active giveaway')
        .addStringOption(option =>
          option.setName('message-id')
            .setDescription('The message ID of the giveaway')
            .setRequired(true)
        )
        .addStringOption(option =>
          option.setName('duration')
            .setDescription('How much longer (e.g., 10m, 1h, 1d)')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('reroll')
        .setDescription('Pick a new winner from an ended giveaway')
        .addStringOption(option =>
          option.setName('message-id')
            .setDescription('The message ID of the ended giveaway')
            .setRequired(true)
        )
    ),
  category: 'management',
  async execute(interaction) {
    // Check if user has admin role
    if (!interaction.member.roles.cache.has(administratorRoleId)) {
      const embed = {
        color: 16711680,
        title: '🚫 Access Denied',
        description: `You don't have permission for this.\n\nOnly users with the <@&${administratorRoleId}> role can manage giveaways.`,
        fields: [
          { name: '📋 Required Role', value: `<@&${administratorRoleId}>`, inline: false }
        ],
        footer: { text: 'Permission Required' },
        timestamp: new Date()
      };
      return await interaction.reply({ embeds: [embed], flags: 64 });
    }
    
    const subcommand = interaction.options.getSubcommand();
    
    if (subcommand === 'start') {
      await giveawayHandler.handleGiveaway(interaction, interaction.client);
    } else if (subcommand === 'extend') {
      await giveawayHandler.handleExtendGiveaway(interaction, interaction.client);
    } else if (subcommand === 'reroll') {
      await giveawayHandler.handleRerollGiveaway(interaction, interaction.client);
    }
  }
};