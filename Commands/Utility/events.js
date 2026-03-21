const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags } = require('discord.js');

const eventGroups = [
    {
        group: 'Moderation',
        emoji: '🛡️',
        events: [
            {
                key: 'antiraid',
                name: 'AntiRaid',
                emoji: '🛡️',
                value: [
                    'Detects and blocks raid attempts in real time.',
                    '• Can auto-ban, mute, or restrict suspicious users.',
                    '_Admins can configure thresholds and actions in the config files._'
                ].join('\n')
            },
            {
                key: 'automod',
                name: 'AutoMod',
                emoji: '🛡️',
                value: [
                    'Automatically detects and acts on spam, blocked words, invite links, and other rule violations.',
                    '• Can warn, mute, or log offenders.',
                    '_Configurable by admins in the dashboard or config files._'
                ].join('\n')
            },
            {
                key: 'caseid',
                name: 'Case ID',
                emoji: '🆔',
                value: [
                    'Generates unique, secure case IDs for moderation actions and logs.',
                    '• Used for tracking warnings, bans, and other actions.',
                    '_Example: `WARN-abc123`_'
                ].join('\n')
            },
            {
                key: 'ghostpingalert',
                name: 'Ghost Ping Alert',
                emoji: '👻',
                value: [
                    'Detects and logs deleted messages that mention users or roles (ghost pings).',
                    '• Alerts to potential ghost ping abuse.',
                    '_Triggered when a message with a mention is deleted._'
                ].join('\n')
            },
            {
                key: 'verification',
                name: 'Verification',
                emoji: '✅',
                value: [
                    'Manages user verification with captcha and risk-based checks.',
                    '• Protects your server from raids and spam.',
                    '_Users must complete verification to access the server._'
                ].join('\n')
            }
        ]
    },
    {
        group: 'Utility',
        emoji: '🛠️',
        events: [
            {
                key: 'inactivechannelreporter',
                name: 'Inactive Channel Reporter',
                emoji: '📢',
                value: [
                    'Monitors channels for inactivity and reports those that are unused.',
                    '• Helps keep your server tidy by identifying dead channels.',
                    '_Admins can review and archive or delete inactive channels._'
                ].join('\n')
            },
            {
                key: 'luckydrop',
                name: 'Lucky Drop',
                emoji: '🍀',
                value: [
                    'Users randomly receive xp or coins for their activity in chat.',
                    '• Encourages engagement and activity.',
                    '_Watch for special drop messages and claim quickly!_'
                ].join('\n')
            },
            {
                key: 'afkstatus',
                name: 'AFK Status',
                emoji: '💤',
                value: [
                    'Tracks when users set themselves as AFK and notifies others who mention them.',
                    '• Prevents spam with cooldowns.',
                    '_Tip: Type `/afk [reason]` to set your AFK status._'
                ].join('\n')
            },
            {
                key: 'snipe',
                name: 'Snipe Tracker',
                emoji: '🕵️',
                value: [
                    'Captures and allows retrieval of recently deleted messages.',
                    '• Use `/snipe` to view the last deleted message in a channel.',
                    '_Great for catching message deletions!_'
                ].join('\n')
            }
        ]
    },
    {
        group: 'Fun & Engagement',
        emoji: '🎉',
        events: [
            {
                key: 'giveaway',
                name: 'Giveaway',
                emoji: '🎉',
                value: [
                    'Handles timed giveaways, winner selection, and entry tracking.',
                    '• Users can enter with a reaction or command.',
                    '_Use `/giveaway` to start a new giveaway._'
                ].join('\n')
            },
            {
                key: 'leveling',
                name: 'Leveling',
                emoji: '📈',
                value: [
                    'Awards XP for messages, tracks user progress, and handles level-up notifications.',
                    '• Level up and earn rewards for being active!',
                    '_Check your level with `/rank` or `/leaderboard`._'
                ].join('\n')
            },
            {
                key: 'mediaonly',
                name: 'Media Only',
                emoji: '🖼️',
                value: [
                    'Restricts certain channels to media content only (images, videos, etc.).',
                    '• Non-media messages are deleted.',
                    '_Look for the 📷 icon in channel names._'
                ].join('\n')
            },
            {
                key: 'musicmanager',
                name: 'Music Manager',
                emoji: '🎶',
                value: [
                    'Controls music playback, queue, and audio features for the server.',
                    '• Supports playlists, skip, pause, and more.',
                    '_Use `/music` commands to interact with the bot._'
                ].join('\n')
            },
            {
                key: 'jointocreate',
                name: 'Join to Create',
                emoji: '🔊',
                value: [
                    'Creates temporary private voice channels when users join a lobby channel.',
                    '• Channels are auto-deleted when empty.',
                    '_Join the JTC voice channel to create your own room!_'
                ].join('\n')
            }
        ]
    }
];


module.exports = {
    data: new SlashCommandBuilder()
        .setName('events')
        .setDescription('Show descriptions of special server events and automations'),
    category: 'utility',
    async execute(interaction) {
        function buildMainMenuEmbed() {
            let desc = [
                'Discover the advanced automations and event features that power your server!',
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                '',
                'Click a button below to view details about a module:',
                ''
            ];
            eventGroups.forEach((g, idx) => {
                desc.push(`${g.emoji} **${g.group} Modules**`);
                desc.push(g.events.map(e => ` • ${e.emoji} ${e.name}`).join('\n'));
                if (idx < eventGroups.length - 1) desc.push('');
            });
            return new EmbedBuilder()
                .setColor(0x7289DA)
                .setTitle('✨  Server Events & Automations')
                .setDescription(desc.join('\n'))
                .setFooter({ text: `Requested by ${interaction.user.tag}  •  ${new Date().toLocaleTimeString()}`, iconURL: interaction.user.displayAvatarURL({ size: 128 }) })
                .setTimestamp();
        }

        function buildModuleButtons() {
            const allEvents = eventGroups.flatMap(g => g.events);
            const rows = [];
            let currentRow = new ActionRowBuilder();
            allEvents.forEach((e) => {
                if (currentRow.components.length === 5) {
                    rows.push(currentRow);
                    currentRow = new ActionRowBuilder();
                }
                currentRow.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`eventmod_${e.key}`)
                        .setLabel(`${e.emoji} ${e.name}`)
                        .setStyle(ButtonStyle.Secondary)
                );
            });
            if (currentRow.components.length > 0) rows.push(currentRow);
            return rows;
        }

        function buildBackButton() {
            return [new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('eventmod_back')
                    .setLabel('⬅️ Back')
                    .setStyle(ButtonStyle.Secondary)
            )];
        }

        function buildModuleEmbed(event) {
            return new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle(`${event.emoji}  __${event.name}__`)
                .setDescription(event.value)
                .setFooter({ text: `Requested by ${interaction.user.tag}  •  ${new Date().toLocaleTimeString()}`, iconURL: interaction.user.displayAvatarURL({ size: 128 }) })
                .setTimestamp();
        }

        await interaction.reply({
            embeds: [buildMainMenuEmbed()],
            components: buildModuleButtons(),
            flags: MessageFlags.Ephemeral
        });

        const msg = await interaction.fetchReply();
        const allEvents = eventGroups.flatMap(g => g.events);
        const collector = msg.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 2 * 60 * 1000,
            filter: i => i.user.id === interaction.user.id
        });

        collector.on('collect', async i => {
            if (i.customId === 'eventmod_back') {
                await i.update({
                    embeds: [buildMainMenuEmbed()],
                    components: buildModuleButtons(),
                });
                return;
            }
            if (i.customId.startsWith('eventmod_')) {
                const key = i.customId.replace('eventmod_', '');
                const event = allEvents.find(e => e.key === key);
                if (!event) {
                    await i.reply({ content: 'Module not found.', ephemeral: true });
                    return;
                }
                await i.update({
                    embeds: [buildModuleEmbed(event)],
                    components: buildBackButton(),
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
