const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { Color } = require("../../Config/constants/misc.json");

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Lists all available commands')
    .addStringOption(option =>
      option.setName('category')
        .setDescription('Command category to display')
        .setRequired(false)
        .addChoices(
          { name: 'Management', value: 'management' },
          { name: 'Moderation', value: 'moderation' },
          { name: 'Utility', value: 'utility' },
          { name: 'Application', value: 'application' },
          { name: 'Staff', value: 'staff' },
          { name: 'Ticket', value: 'ticket' },
          { name: 'ServerInfo', value: 'serverinfo' }
        )
    ),
  category: 'utility',
  async execute(interaction) {
    const category = interaction.options.getString('category');
    const colorInt = parseInt(Color.replace('#', ''), 16);

    function ChangeLatter(string) {
      return string.charAt(0).toUpperCase() + string.slice(1);
    }

    let embedhelp = new EmbedBuilder()
      .setColor(colorInt)
      .setTitle(`${interaction.client.user.username} - Help Section!`)
      .setDescription(`Below you can see the current Command Categories\nUse /help [category] for more details`)
      .addFields(
        { name: 'Command Categories', value: 'Management\nModeration\nUtility\nApplication\nStaff\nTicket\nServerInfo', inline: true },
        { name: 'Server information', value: '[Server Invite]()\n[Server Info]', inline: true },
      );

    if (!category) {
      return interaction.reply({ embeds: [embedhelp], flags: MessageFlags.Ephemeral });
    }

    const categoryEmbed = new EmbedBuilder()
      .setColor(colorInt)
      .setTitle(`${ChangeLatter(category)} Commands`);

    let count = 0;
    for (const [, command] of interaction.client.slashCommands) {
      if (command.category === category) {
        categoryEmbed.addFields({
          name: `/${command.data.name}`,
          value: command.data.description || 'No description',
          inline: false
        });
        count++;
      }
    }

    if (count === 0) {
      return interaction.reply({ content: `No commands found in the ${category} category.`, flags: MessageFlags.Ephemeral });
    }

    return interaction.reply({ embeds: [categoryEmbed], flags: MessageFlags.Ephemeral });
  }
};