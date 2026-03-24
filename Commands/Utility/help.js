const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags } = require('discord.js');
const { ROLES: { administratorRoleId, moderatorRoleId } } = require('../../Config/constants');

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

    const visibleCommands = [...interaction.client.slashCommands.values()]
      .filter(command => isCommandVisibleToMember(command, { hasAdminRole, hasModRole }))
      .map(command => ({
        ...command,
        normalizedCategory: normalizeHelpCategory(command.category)
      }))
      .filter(command => Boolean(command.normalizedCategory));

    const uniqueCategories = [...new Set(visibleCommands.map(command => command.normalizedCategory))]
      .sort((left, right) => getCategorySortIndex(left) - getCategorySortIndex(right));

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
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
        ].join('\n'))
        .addFields({
          name: '📚 __Available Categories__',
          value: uniqueCategories.map(category => {
            const commandCount = visibleCommands.filter(command => command.normalizedCategory === category).length;
            return `> ${categoryIcons[category] || '❯'} **${formatCategoryLabel(category)}** (${commandCount})`;
          }).join('\n'),
          inline: false
        })
        .setFooter({ text: `Requested by ${interaction.user.tag}  •  ${new Date().toLocaleTimeString()}`, iconURL: interaction.user.displayAvatarURL({ size: 128 }) })
        .setTimestamp();
    }

    function buildCategoryEmbed(category) {
      let commands = visibleCommands
        .filter(command => command.normalizedCategory === category)
        .sort((left, right) => {
          const leftName = left?.data?.name || '';
          const rightName = right?.data?.name || '';
          return leftName.localeCompare(rightName);
        })
        .map(command => {
          const cmdName = command?.data?.name || 'unknown';
          const emoji = getCommandEmoji(cmdName);
          const desc = typeof command?.data?.description === 'string' ? command.data.description : 'No description';
          return `${emoji} \`/${cmdName}\` - ${desc}`;
        });

      if (commands.length === 0) {
        commands = ['No commands found in this category.'];
      }

      return new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`${categoryIcons[category] || ''} ${formatCategoryLabel(category)} Commands`)
        .setDescription(commands.join('\n'))
        .setFooter({ text: `Requested by ${interaction.user.tag} • Click Back to return`, iconURL: interaction.user.displayAvatarURL({ size: 128 }) })
        .setTimestamp();
    }

    function buildCategoryButtons(selected) {
      const rows = [];
      let currentRow = new ActionRowBuilder();

      uniqueCategories.forEach(category => {
        if (currentRow.components.length === 5) {
          rows.push(currentRow);
          currentRow = new ActionRowBuilder();
        }

        currentRow.addComponents(
          new ButtonBuilder()
            .setCustomId(`help_cat_${category}`)
            .setLabel(`${categoryIcons[category] || ''} ${formatCategoryLabel(category)}`)
            .setStyle(selected === category ? ButtonStyle.Primary : ButtonStyle.Secondary)
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
          components: buildCategoryButtons()
        });
        return;
      }

      if (i.customId.startsWith('help_cat_')) {
        const category = i.customId.replace('help_cat_', '');
        if (!uniqueCategories.includes(category)) {
          await i.reply({ content: 'Invalid category.', flags: MessageFlags.Ephemeral });
          return;
        }

        await i.update({
          embeds: [buildCategoryEmbed(category)],
          components: [buildBackButton()]
        });
      }
    });

    collector.on('end', async () => {
      try {
        await msg.edit({ components: [] });
      } catch (_) { }
    });
  }
};

function getCommandEmoji(commandName) {
  const emojiMap = {
    announce: '📢',
    automodwarns: '🤖',
    clearwarns: '🧹',
    giveaway: '🎉',
    health: '🩺',
    rules: '📜',
    serverbackup: '💾',
    setup: '🧰',
    setlevel: '⚡',
    suggestion: '🗳️',
    swearfilter: '🚫',

    audit: '🧾',
    ban: '🔨',
    case: '⚖️',
    clear: '🧹',
    deletemsg: '🗑️',
    incident: '🚨',
    kick: '👢',
    moderations: '📂',
    modlogs: '📚',
    note: '📝',
    raid: '🛡️',
    setnick: '✏️',
    slowmode: '🐢',
    timeout: '⏱️',
    unban: '🔓',
    untimeout: '✅',
    warn: '⚠️',
    warns: '📊',

    activity: '📊',
    afk: '💤',
    avatar: '🖼️',
    banner: '🏳️',
    birthday: '🎂',
    crypto: '💰',
    credits: '🙏',
    define: '📖',
    economy: '🪙',
    events: '📅',
    help: '🧭',
    invites: '📨',
    ping: '🏓',
    poll: '🗳️',
    profile: '🪪',
    reminders: '⏰',
    rep: '🤝',
    serverhealth: '❤️‍🩹',
    serverinfo: '🏰',
    snipe: '🎯',
    steam: '🎮',
    suggest: '💡',
    timezone: '🌍',
    uptime: '⏱️',
    weather: '🌤️',

    music: '🎵',
    voice: '🎤',

    leaderboard: '🥇',
    rank: '🏆',
    streak: '🔥',

    '8ball': '🎱',
    coinflip: '🪙',
    dadjoke: '👴',
    fact: '💡',
    joke: '😂',
    mock: '🎭',
    pickup: '💘',
    qr: '🔳',
    riddle: '🧩',
    roast: '🌶️',
    trivia: '🧠',

    ticket: '🎫',
    ticketadduser: '➕',
    ticketclaim: '🙋',
    ticketclose: '🔒',
    ticketmarkhandled: '✅',
    ticketremoveuser: '➖',
    tickettransfer: '🔁',

    verify: '🔐',
    'verify-override': '🛂'
  };

  return emojiMap[commandName] || '❯';
}

function normalizeHelpCategory(category) {
  return String(category || '').trim().toLowerCase();
}

function formatCategoryLabel(category) {
  const normalized = normalizeHelpCategory(category);
  if (!normalized) return 'Other';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function getCategorySortIndex(category) {
  const order = ['management', 'moderation', 'voice', 'utility', 'levels', 'fun', 'ticket', 'verification'];
  const normalized = normalizeHelpCategory(category);
  const index = order.indexOf(normalized);
  return index === -1 ? order.length + 1 : index;
}

function isCommandVisibleToMember(command, permissions) {
  const category = normalizeHelpCategory(command?.category);
  if (!category) return false;
  if (category === 'management') return permissions.hasAdminRole;
  if (category === 'moderation') return permissions.hasModRole || permissions.hasAdminRole;
  return true;
}