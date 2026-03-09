const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { ROLES: { administratorRoleId, moderatorRoleId } } = require("../../Config/constants");

// The help command shows a categorized list of all available commands—easy to find what you need.
// Note to self: Remember to update categories when adding new commands!
module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all available commands')
    .addStringOption(option =>
      option.setName('category')
        .setDescription('Command category to display')
        .setRequired(false)
        .addChoices(
          { name: 'Management', value: 'management' },
          { name: 'Moderation', value: 'moderation' },
          { name: 'Voice', value: 'voice' },
          { name: 'Utility', value: 'utility' },
          { name: 'Leveling', value: 'levels' },
          { name: 'Fun', value: 'fun' },
          { name: 'Ticket', value: 'ticket' },
          { name: 'Verification', value: 'verification' }
        )
    ),
  category: 'utility',
  async execute(interaction) {
    const category = interaction.options.getString('category');

    // Figure out which commands the user can see based on their roles.
    const member = interaction.member;
    const hasAdminRole = member.roles.cache.has(administratorRoleId);
    const hasModRole = member.roles.cache.has(moderatorRoleId);

    function ChangeLatter(string) {
      return string.charAt(0).toUpperCase() + string.slice(1);
    }

    // Emojis for each command category—makes the help menu more fun.
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

    // Show different categories depending on the user's role.
    let categoryList = [];
    if (hasAdminRole) {
      categoryList.push('⚙️ **Management** - Server management commands');
    }
    if (hasModRole || hasAdminRole) {
      categoryList.push('🛡️ **Moderation** - Moderation & safety commands');
    }
    categoryList.push('🎤 **Voice** - Music and temporary voice channel commands');
    categoryList.push('🔧 **Utility** - Helpful utility commands');
    categoryList.push('📈 **Leveling** - Level up and rank commands');
    categoryList.push('🎮 **Fun** - Games and entertainment commands');
    categoryList.push('🎫 **Ticket** - Ticket system commands');
    categoryList.push('🔐 **Verification** - Account verification commands');

    let embedhelp = new EmbedBuilder()
      .setColor(0x1e1f22)
      .setAuthor({
        name: `${interaction.client.user.username} Help Menu`,
        iconURL: interaction.client.user.displayAvatarURL()
      })
      .setTitle('Bot Command Help')
      .setDescription([
        'Welcome to the help menu!', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        'Select a category below to view available commands.', '',
        '**Usage:** `/help [category]`', '**Example:** `/help moderation`'
      ].join('\n'))
      .addFields(
        {
          name: '📚 Available Categories',
          value: categoryList.join('\n') + '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
          inline: false
        },
        {
          name: '💡 Tip',
          value: 'Commands are filtered based on your permissions. Admin and Moderator commands are only visible to users with the appropriate roles.',
          inline: false
        },
      )
      .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ size: 128 }) })
      .setTimestamp();

    if (!category) {
      return interaction.reply({ embeds: [embedhelp], flags: MessageFlags.Ephemeral });
    }

    // Make sure the user has permission to view this category.
    if (category === 'management' && !hasAdminRole) {
      const adminRole = interaction.guild.roles.cache.get(administratorRoleId);
      const roleName = adminRole ? adminRole.name : 'Administrator';
      return interaction.reply({
        content: `❌ You need the **${roleName}** role to view Management commands.`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (category === 'moderation' && !hasModRole && !hasAdminRole) {
      const modRole = interaction.guild.roles.cache.get(moderatorRoleId);
      const roleName = modRole ? modRole.name : 'Moderator';
      return interaction.reply({
        content: `❌ You need the **${roleName}** role to view Moderation commands.`,
        flags: MessageFlags.Ephemeral
      });
    }

    // Build the command list for this category.
    let count = 0;
    const commands = [];
    for (const [, command] of interaction.client.slashCommands) {
      if (command.category === category) {
        const emoji = getCommandEmoji(command.data.name);
        commands.push(`${emoji} \`/${command.data.name}\` - ${command.data.description || 'No description'}`);
        count++;
      }
    }

    if (count === 0) {
      return interaction.reply({ content: `No commands found in the ${category} category.`, flags: MessageFlags.Ephemeral });
    }

    const categoryEmbed = new EmbedBuilder()
      .setColor(0x1e1f22)
      .setAuthor({
        name: `${ChangeLatter(category)} Commands`,
        iconURL: interaction.client.user.displayAvatarURL()
      })
      .setTitle(`${categoryIcons[category]} ${ChangeLatter(category)} Commands`)
      .setDescription(`Here are all commands in the **${ChangeLatter(category)}** category:`)
      .addFields({
        name: `Commands`,
        value: commands.join('\n'),
        inline: false
      })
      .setFooter({ text: `${count} commands • Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ size: 128 }) })
      .setTimestamp();


    if (category === 'utility') {
      const economyUserLines = [
        '• `/economy balance [user]` — wallet, bank, totals',
        '• `/economy daily` and `/economy weekly` — timed rewards',
        '• `/economy work` — work payouts with cooldowns',
        '• `/economy deposit|withdraw <amount|%|all>` — move funds',
        '• `/economy gamble <amount|%|all>` — risk/reward',
        '• `/economy quests` and `/economy quest-claim <quest>` — quests + rewards',
        '• `/economy shop`, `/economy buy`, `/economy inventory`, `/economy use` — items + boosts',
        '• `/economy leaderboard` and `/economy stats [user]` — rankings + analytics',
        '• `/weather <city>` — get the weather'
      ];

      categoryEmbed.addFields({
        name: '💰 Economy & Utility',
        value: economyUserLines.join('\n'),
        inline: false
      });

      if (hasAdminRole) {
        categoryEmbed.addFields({
          name: '🛠️ Economy Admin Tools',
          value: [
            '• `/economy admin set <user> <wallet|bank> <amount> [reason]`',
            '• `/economy admin add <user> <wallet|bank> <amount> [reason]`',
            '• `/economy admin remove <user> <wallet|bank> <amount> [reason]`',
            '• `/economy bounty list|create|award|close` — manage bounties'
          ].join('\n'),
          inline: false
        });
      }
    }

    if (category === 'fun') {
      const funLines = [
        '• `/trivia` — answer a trivia question',
        '• `/riddle` — solve a riddle for XP',
        '• `/8ball` — magic 8-ball',
        '• `/coinflip` — flip a coin',
        '• `/fact` — get a random fact',
        '• `/roast` — get roasted',
        '• `/pickup` — pickup lines'
      ];
      categoryEmbed.addFields({
        name: '🎮 Fun Quick Guide',
        value: funLines.join('\n'),
        inline: false
      });
    }

    return interaction.reply({ embeds: [categoryEmbed], flags: MessageFlags.Ephemeral });
  }
};

// Helper function to get the right emoji for each command category.
function getCommandEmoji(commandName) {
  const emojiMap = {
    // Management commands
    'announce': '📢',
    'checkban': '🔍',
    'unban': '🚫',
    'clearwarns': '🧹',
    'giveaway': '🎉',
    'automodwarns': '⚠️',
  'rules': '📜',
  'suggestion': '🧾',
  'setlevel': '⚡',
  'health': '🩺',
    // Moderation commands
    'warn': '⚠️',
    'warning': '📋',
    'warns': '📊',
    'ban': '🔨',
    'kick': '👢',
    'clear': '🧹',
    'timeout': '⏱️',
    'untimeout': '✅',
    'deletemsg': '🗑️',
    'slowmode': '🐢',
    'moderations': '📄',
    'note': '📝',
    'incident': '📁',
    'modlogs': '📚',
    'audit': '🧠',
    // Utility commands
    'help': '❓',
    'ping': '🏓',
    'userinfo': '👤',
    'avatar': '🖼️',
    'banner': '🧵',
    'serverinfo': '🏰',
    'inviteinfo': '🔎',
    'activity': '📊',
    'afk': '💤',
    'suggest': '💡',
    'snipe': '🎯',
    'rep': '🤝',
    'economy': '🪙',
    'joke': '😂',
    'define': '📖',
    'poll': '📊',
    'music': '🎵',
    'birthday': '🎂',
    'reminders': '🔔',
    'crypto': '💰',
    'voice': '🎤',
    // Leveling commands
    'rank': '🏆',
    'leaderboard': '🥇',
    // Fun commands
    '8ball': '🎱',
    'trivia': '🧠',
    'coinflip': '🎲',
    'riddle': '🧩',
    'fact': '💡',
    'roast': '🔥',
    'pickup': '💘',
    // Ticket commands
    'ticket': '🎫',
    'ticketclose': '🔒',
    'ticketmarkhandled': '✅',
    'ticketclaim': '👤',
    'ticketadduser': '➕',
    'ticketremoveuser': '➖',
    'tickettransfer': '🔁',
    // Verification commands
    'verify': '🔐',
    'verify-override': '🛂'
  };

  return emojiMap[commandName] || '❯';
};