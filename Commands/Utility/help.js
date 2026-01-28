const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { ServerInvite } = require("../../Config/main.json");
const { administratorRoleId, moderatorRoleId } = require("../../Config/constants/roles.json");

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
    
    // Check user roles
    const member = interaction.member;
    const hasAdminRole = member.roles.cache.has(administratorRoleId);
    const hasModRole = member.roles.cache.has(moderatorRoleId);

    function ChangeLatter(string) {
      return string.charAt(0).toUpperCase() + string.slice(1);
    }

    // Category emojis
    const categoryIcons = {
      management: '⚙️',
      moderation: '🛡️',
      utility: '🔧',
      leveling: '📈',
      fun: '🎮',
      ticket: '🎫',
      verification: '🔐'
    };

    // Build category list based on permissions
    let categoryList = [];
    if (hasAdminRole) {
      categoryList.push('⚙️ **Management** - Server management commands');
    }
    if (hasModRole || hasAdminRole) {
      categoryList.push('🛡️ **Moderation** - Moderation & safety commands');
    }
    categoryList.push('🔧 **Utility** - Helpful utility commands');
    categoryList.push('📈 **Leveling** - Level up and rank commands');
    categoryList.push('🎮 **Fun** - Games and entertainment commands');
    categoryList.push('🎫 **Ticket** - Ticket system commands');
    categoryList.push('🔐 **Verification** - Account verification commands');

    let embedhelp = new EmbedBuilder()
      .setColor(0x5865F2)
      .setAuthor({ 
        name: `${interaction.client.user.username} Help Menu`, 
        iconURL: interaction.client.user.displayAvatarURL() 
      })
      .setDescription(`Welcome to the help menu!\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nSelect a category below to view available commands.\n\n**Usage:** \`/help [category]\`\n**Example:** \`/help moderation\``)
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
        { 
          name: '🔗 Server Invite', 
          value: `[Click here to invite friends](${ServerInvite})`, 
          inline: false 
        }
      )
      .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
      .setTimestamp();

    if (!category) {
      return interaction.reply({ embeds: [embedhelp], flags: MessageFlags.Ephemeral });
    }

    // Check permissions
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

    // Count commands first
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
      .setColor(0x5865F2)
      .setAuthor({ 
        name: `${ChangeLatter(category)} Commands`, 
        iconURL: interaction.client.user.displayAvatarURL() 
      })
      .setDescription(`${categoryIcons[category]} **${ChangeLatter(category)}**`)
      .setFooter({ text: `${count} commands`, iconURL: interaction.user.displayAvatarURL() })
      .setTimestamp();

    categoryEmbed.addFields({
      name: `Commands`,
      value: commands.join('\n'),
      inline: false
    });

    return interaction.reply({ embeds: [categoryEmbed], flags: MessageFlags.Ephemeral });
  }
};

// Helper function to get emoji for commands
function getCommandEmoji(commandName) {
  const emojiMap = {
    // Management
    'announce': '📢',
    'eannounce': '📢',
    'checkban': '🔍',
    'unban': '🚫',
    'clearwarning': '🧹',
    'clearwarns': '🧹',
    'giveaway': '🎉',
    'manage': '🛠️',
    // Moderation
    'warn': '⚠️',
    'warning': '📋',
    'warns': '📊',
    'ban': '🔨',
    'kick': '👢',
    'clear': '🧹',
    'timeout': '⏱️',
    'untimeout': '✅',
    'deletemsg': '🗑️',
    // Utility
    'help': '❓',
    'userinfo': '👤',
    'serverinfo': '🏰',
    'joke': '😂',
    'define': '📖',
    'poll': '📊',
    'reminders': '🔔',
    'crypto': '💰',
    // Leveling
    'rank': '🏆',
    'leaderboard': '🥇',
    'setlevel': '⚡',
    // Fun
    '8ball': '🎱',
    'trivia': '🧠',
    'coinflip': '🎲',
    'fact': '💡',
    'roast': '🔥',
    'pickup': '💘',
    // Ticket
    'ticket': '🎫',
    'close': '🔒',
    'markhandled': '✅',
    'claim': '👤',
    'adduser': '➕',
    'removeuser': '➖',
    // Verification
    'verify': '🔐'
  };
  
  return emojiMap[commandName] || '❯';
};