// ANSI Color codes
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    red: '\x1b[31m',
    white: '\x1b[37m',
    bgBlue: '\x1b[44m',
    bgGreen: '\x1b[42m'
};

module.exports = {
    name: "commandsAndEventsLoaded",
    runOnce: true,
    call: async (client, args) => {
        const commands = client.slashCommands.size;
        const events = client.eventNames().length;
        const categories = new Set();
        
        // Count command categories
        client.slashCommands.forEach(cmd => {
            if (cmd.category) categories.add(cmd.category);
        });
        
        console.log('\n');
        console.log(colors.cyan + colors.bright + '╔════════════════════════════════════════════════════════════════╗' + colors.reset);
        console.log(colors.cyan + '║' + colors.reset + '                                                                ' + colors.cyan + '║' + colors.reset);
        console.log(colors.cyan + '║' + colors.green + colors.bright + '                ✅ BOT STARTUP COMPLETE                      ' + colors.cyan + '║' + colors.reset);
        console.log(colors.cyan + '║' + colors.reset + '                                                                ' + colors.cyan + '║' + colors.reset);
        console.log(colors.cyan + colors.bright + '╚════════════════════════════════════════════════════════════════╝' + colors.reset);
        console.log('');
        console.log(colors.yellow + colors.bright + '📊 Stats:' + colors.reset);
        console.log(colors.blue + '  ├─ 🎮 Commands:  ' + colors.bright + colors.green + commands + colors.reset + colors.dim + ' loaded' + colors.reset);
        console.log(colors.blue + '  ├─ 📡 Events:     ' + colors.bright + colors.green + events + colors.reset + colors.dim + ' registered' + colors.reset);
        console.log(colors.blue + '  ├─ 🏷️  Categories: ' + colors.bright + colors.green + categories.size + colors.reset + colors.dim + ' (' + Array.from(categories).join(', ') + ')' + colors.reset);
        console.log(colors.blue + '  └─ 👤 Bot:        ' + colors.bright + colors.cyan + (client.user?.tag || 'Connecting...') + colors.reset);
        console.log('');
        console.log(colors.green + colors.bright + '🟢 Ready' + colors.reset);
        console.log(colors.dim + '⏰ ' + new Date().toLocaleString() + colors.reset);
        console.log('');
    }
};