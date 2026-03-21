const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags } = require('discord.js');
const { ROLES: { administratorRoleId, moderatorRoleId } } = require("../../Config/constants");

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all available commands'),
  category: 'utility',
  async execute(interaction) {
    const member = interaction.member;
    const hasAdminRole = member.roles.cache.has(administratorRoleId);
    const hasModRole = member.roles.cache.has(moderatorRoleId);

    const categoryIcons = {
      management: '⚙️',
      moderation: '🛡️',
      voice: '🎤',
      utility: '🔧',
      levels: '📈',
      fun: '🎮',
      ticket: '🎫',
      verification: '🔐'
    };

    const categories = [];
    if (hasAdminRole) categories.push('management');
    if (hasModRole || hasAdminRole) categories.push('moderation');
    categories.push('voice', 'utility', 'levels', 'fun', 'ticket', 'verification');

    const uniqueCategories = [...new Set(categories)];

    function buildMainMenuEmbed() {
      return new EmbedBuilder()
        .setColor(0x23272A)
        .setTitle('✨  __Bot Command Help__')
        .setDescription([
          '**Welcome to the interactive help menu!**',
          '╭───────────────────────────────╮',
          'Click a button below to view commands for a category.',
          '',
          '_Tip: Commands are filtered based on your permissions._',
          '',
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        ].join('\n'))
        .addFields({
          name: '📚 __Available Categories__',
          value: uniqueCategories.map(cat => `> ${categoryIcons[cat]} **${cat.charAt(0).toUpperCase() + cat.slice(1)}**`).join('\n'),
          inline: false
        })
        .setFooter({ text: `Requested by ${interaction.user.tag}  •  ${new Date().toLocaleTimeString()}`, iconURL: interaction.user.displayAvatarURL({ size: 128 }) })
        .setTimestamp();
    }

    function buildCategoryEmbed(category) {
      let commands = [];
      for (const [, command] of interaction.client.slashCommands) {
        if (command.category === category) {
          const cmdName = command?.data?.name || 'unknown';
          const emoji = getCommandEmoji(cmdName);
          let desc = 'No description';
          if (command?.data?.description && typeof command.data.description === 'string') {
            desc = command.data.description;
          }
          commands.push(`${emoji} \`/${cmdName}\` - ${desc}`);
        }
      }
      if (commands.length === 0) {
        commands = ['No commands found in this category.'];
      }
      return new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`${categoryIcons[category] || ''} ${category.charAt(0).toUpperCase() + category.slice(1)} Commands`)
        .setDescription(commands.join('\n'))
        .setFooter({ text: `Requested by ${interaction.user.tag} • Click Back to return`, iconURL: interaction.user.displayAvatarURL({ size: 128 }) })
        .setTimestamp();
    }

    function buildCategoryButtons(selected) {
      const rows = [];
      let currentRow = new ActionRowBuilder();
      uniqueCategories.forEach((cat, idx) => {
        if (currentRow.components.length === 5) {
          rows.push(currentRow);
          currentRow = new ActionRowBuilder();
        }
        currentRow.addComponents(
          new ButtonBuilder()
            .setCustomId(`help_cat_${cat}`)
            .setLabel(`${categoryIcons[cat] || ''} ${cat.charAt(0).toUpperCase() + cat.slice(1)}`)
            .setStyle(selected === cat ? ButtonStyle.Primary : ButtonStyle.Secondary)
        );
      });
      if (currentRow.components.length > 0) rows.push(currentRow);
      return rows;
    }

    function buildBackButton() {
      return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('help_back')
          .setLabel('⬅️ Back')
          .setStyle(ButtonStyle.Secondary)
      );
    }

    await interaction.reply({
      embeds: [buildMainMenuEmbed()],
      components: buildCategoryButtons(),
      flags: MessageFlags.Ephemeral
    });

    const msg = await interaction.fetchReply();
    const collector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 2 * 60 * 1000,
      filter: i => i.user.id === interaction.user.id
    });

    collector.on('collect', async i => {
      if (i.customId === 'help_back') {
        await i.update({
          embeds: [buildMainMenuEmbed()],
          components: buildCategoryButtons(),
        });
        return;
      }
      if (i.customId.startsWith('help_cat_')) {
        const cat = i.customId.replace('help_cat_', '');
        if (!uniqueCategories.includes(cat)) {
          await i.reply({ content: 'Invalid category.', ephemeral: true });
          return;
        }
        await i.update({
          embeds: [buildCategoryEmbed(cat)],
          components: [buildBackButton()],
        });
      }
    });

    collector.on('end', async () => {
      try {
        await msg.edit({ components: [] });
      } catch (_) {}
    });
  }
};

function getCommandEmoji(commandName) {
  const emojiMap = {
    'announce': '📢',
    'automodwarns': '🤖',
    'clearwarns': '🧹',
    'giveaway': '🎉',
    'health': '🩺',
    'rules': '📜',
    'setup': '🧰',
    'setlevel': '⚡',
    'suggestion': '🗳️',
    'swearfilter': '🚫',

    'audit': '🧾',
    'ban': '🔨',
    'case': '⚖️',
    'checkban': '🔍',
    'clear': '🧹',
    'deletemsg': '🗑️',
    'incident': '🚨',
    'kick': '👢',
    'moderations': '📂',
    'modlogs': '📚',
    'note': '📝',
    'raid': '🛡️',
    'setnick': '✏️',
    'slowmode': '🐢',
    'timeout': '⏱️',
    'unban': '🔓',
    'untimeout': '✅',
    'warn': '⚠️',
    'warning': '📋',
    'warns': '📊',

    'activity': '📊',
    'afk': '💤',
    'avatar': '🖼️',
    'banner': '🏳️',
    'birthday': '🎂',
    'crypto': '💰',
    'define': '📖',
    'economy': '🪙',
    'events': '📅',
    'help': '🧭',
    'inviteinfo': '🔗',
    'invites': '📨',
    'ping': '🏓',
    'poll': '🗳️',
    'reminders': '⏰',
    'rep': '🤝',
    'serverhealth': '❤️‍🩹',
    'serverinfo': '🏰',
    'snipe': '🎯',
    'steam': '🎮',
    'suggest': '💡',
    'timezone': '🌍',
    'uptime': '⏱️',
    'userinfo': '👤',
    'weather': '🌤️',

    'music': '🎵',
    'voice': '🎤',

    'leaderboard': '🥇',
    'rank': '🏆',
    'streak': '🔥',

    '8ball': '🎱',
    'coinflip': '🪙',
    'dadjoke': '👴',
    'fact': '💡',
    'joke': '😂',
    'mock': '🎭',
    'pickup': '💘',
    'qr': '🔳',
    'riddle': '🧩',
    'roast': '🌶️',
    'trivia': '🧠',

    'ticket': '🎫',
    'ticketadduser': '➕',
    'ticketclaim': '🙋',
    'ticketclose': '🔒',
    'ticketmarkhandled': '✅',
    'ticketremoveuser': '➖',
    'tickettransfer': '🔁',

    'verify': '🔐',
    'verify-override': '🛂'
  };

  return emojiMap[commandName] || '❯';
};
