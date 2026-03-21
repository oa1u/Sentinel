const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { ROLES: { administratorRoleId } } = require('../../Config/constants');
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
        .addIntegerOption(option =>
          option.setName('winners')
            .setDescription('How many winners to pick (default: 1)')
            .setMinValue(1)
            .setMaxValue(10)
            .setRequired(false)
        )
        .addRoleOption(option =>
          option.setName('required-role')
            .setDescription('Only members with this role can win (optional)')
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('extend')
        .setDescription('Extend an active giveaway')
        .addStringOption(option =>
          option.setName('message-id')
            .setDescription('The Case ID of the giveaway (e.g., GIVE-kX7mP9qL2n)')
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
            .setDescription('The Case ID of the ended giveaway (e.g., GIVE-kX7mP9qL2n)')
            .setRequired(true)
        )
        .addIntegerOption(option =>
          option.setName('winners')
            .setDescription('How many new winners to pick (default: original count)')
            .setMinValue(1)
            .setMaxValue(10)
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('end')
        .setDescription('End an active giveaway immediately')
        .addStringOption(option =>
          option.setName('message-id')
            .setDescription('The Case ID of the giveaway (e.g., GIVE-kX7mP9qL2n)')
            .setRequired(true)
        )
    ),
  category: 'management',
  async execute(interaction) {
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
    } else if (subcommand === 'end') {
      await giveawayHandler.handleEndGiveaway(interaction, interaction.client);
    }
  }
};