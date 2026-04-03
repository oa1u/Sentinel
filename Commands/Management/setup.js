// Turn constant keys into readable labels.
function prettifyConstantName(key) {
    let name = key.replace(/Id$/i, '');
    name = name.replace(/Ids$/i, '');
    name = name.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
    return name.trim();
}
const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ChannelType, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Track setup sessions per user and guild.
const setupSessions = new Map();

const CLEAR_SELECTION_VALUE = '__clear_selection__';

const CHANNEL_FIELD_INFO = {
    serverLogChannelId: { description: 'Main moderation and server action log channel.' },
    announcementChannelId: { description: 'Channel used for public server announcements.' },
    suggestionChannelId: { description: 'Channel where suggestions are posted and reviewed.' },
    welcomeChannelId: { description: 'Channel for member welcome messages.' },
    leaveChannelId: { description: 'Channel for member leave messages.' },
    ticketCategoryId: { description: 'Category that new support tickets are created under.', allowedTypes: [ChannelType.GuildCategory] },
    ticketLogChannelId: { description: 'Log channel for ticket actions and transcripts.' },
    joinToCreateChannelId: { description: 'Voice channel members join to create temporary voice rooms.', allowedTypes: [ChannelType.GuildVoice, ChannelType.GuildStageVoice] },
    joinToCreateCategoryId: { description: 'Category where temporary voice rooms are created.', allowedTypes: [ChannelType.GuildCategory] },
    verificationChannelId: { description: 'Channel where members start the verification process.' },
    captchaLogChannelId: { description: 'Channel used for captcha and verification logs.' },
    giveawayChannelId: { description: 'Channel where giveaways are hosted.' },
    levelUpLogChannelId: { description: 'Channel for level-up announcements or logs.' },
    birthdayChannelId: { description: 'Channel for birthday announcements.' },
    rulesChannelId: { description: 'Channel containing server rules.' },
    incidentChannelId: { description: 'Channel for incident alerts and urgent moderation notices.' },
    notificationChannelId: { description: 'Channel for panel or automation notifications.' },
    webhookChannelId: { description: 'Channel that receives webhook-based alerts or logs.' },
    discordChannelId: { description: 'Primary Discord updates or sync channel used by the panel.' },
    antiraidLogChannelId: { description: 'Channel for anti-raid detections and lockdown logs.' },
    mediaOnlyChannelIds: { description: 'Channels where only media posts should be allowed.', multi: true },
    mediaOnlyLogChannelId: { description: 'Channel for media-only moderation logs.' },
    inactiveChannelIgnoreIds: { description: 'Channels ignored by inactive-channel scans and reports.', multi: true },
    revivalIgnoreIds: { description: 'Channels excluded from automatic channel revival checks.', multi: true },
    revivalTargetIds: { description: 'Channels that receive automatic revival messages when inactive.', multi: true },
    lockdownChannelIds: { description: 'Channels specifically targeted during anti-raid lockdowns.', multi: true },
    autoResponderAllowedChannelIds: { description: 'If set, the Auto-Responder only works in these channels.', multi: true },
    autoResponderBlockedChannelIds: { description: 'Channels where the Auto-Responder should never reply.', multi: true }
};

const ROLE_FIELD_INFO = {
    verifiedRoleId: { description: 'Role granted after a member completes verification.' },
    moderatorRoleId: { description: 'Primary moderator role used for staff permissions and checks.' },
    administratorRoleId: { description: 'Administrator role used for higher-level bot controls.' },
    ownerRoleId: { description: 'Owner or top-level management role recognized by the panel.' },
    supportTeamRoleId: { description: 'Role used for ticket support or general help staff.' },
    level5RoleId: { description: 'Automatic reward role for level 5 members.' },
    level10RoleId: { description: 'Automatic reward role for level 10 members.' },
    level25RoleId: { description: 'Automatic reward role for level 25 members.' },
    level50RoleId: { description: 'Automatic reward role for level 50 members.' },
    level75RoleId: { description: 'Automatic reward role for level 75 members.' },
    level100RoleId: { description: 'Automatic reward role for level 100 members.' },
    quarantineRoleId: { description: 'Restriction role used when isolating a member.' },
    protectedRoleIds: { description: 'Roles protected from anti-raid cleanup or bulk enforcement actions.', multi: true }
};

function getFieldInfo(type, key, currentValue) {
    const infoMap = type === 'channel' ? CHANNEL_FIELD_INFO : ROLE_FIELD_INFO;
    const baseInfo = infoMap[key] || {};

    return {
        label: baseInfo.label || prettifyConstantName(key),
        description: baseInfo.description || `Configure the value used for ${prettifyConstantName(key).toLowerCase()}.`,
        multi: Boolean(baseInfo.multi || Array.isArray(currentValue) || /Ids$/i.test(key)),
        allowedTypes: baseInfo.allowedTypes || null
    };
}

function formatValueSummary(type, value) {
    if (Array.isArray(value)) {
        const cleaned = value.map((entry) => String(entry || '')).filter(Boolean);
        if (cleaned.length === 0) {
            return 'Not set';
        }

        return cleaned.map((entry) => (type === 'role' ? `<@&${entry}>` : `<#${entry}>`)).join(', ');
    }

    const normalized = String(value || '').trim();
    if (!normalized) {
        return 'Not set';
    }

    return type === 'role' ? `<@&${normalized}>` : `<#${normalized}>`;
}

function buildSelectOptions(interaction, session, key) {
    const fieldInfo = getFieldInfo(session.type, key, session.config[key]);

    if (session.type === 'channel') {
        const defaultTypes = [
            ChannelType.GuildText,
            ChannelType.GuildVoice,
            ChannelType.GuildAnnouncement,
            ChannelType.GuildStageVoice,
            ChannelType.GuildForum,
            ChannelType.GuildCategory
        ];
        const allowedTypes = fieldInfo.allowedTypes || defaultTypes;

        return interaction.guild.channels.cache
            .filter((channel) => allowedTypes.includes(channel.type))
            .sort((left, right) => left.rawPosition - right.rawPosition)
            .map((channel) => ({
                label: channel.name.slice(0, 100),
                value: channel.id
            }))
            .slice(0, 24);
    }

    return interaction.guild.roles.cache
        .filter((role) => role.id !== interaction.guild.id)
        .sort((left, right) => right.position - left.position)
        .map((role) => ({
            label: role.name.slice(0, 100),
            value: role.id
        }))
        .slice(0, 24);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Interactive setup for channel or role constants.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .addStringOption(option =>
            option.setName('type')
                .setDescription('Type of config to update (channel or role)')
                .setRequired(true)
                .addChoices(
                    { name: 'channel', value: 'channel' },
                    { name: 'role', value: 'role' }
                )
        ),
    category: 'Management',
    async execute(interaction) {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
        }
        const type = interaction.options.getString('type');
        let filePath;
        if (type === 'channel') {
            filePath = path.join(__dirname, '../../Config/constants/channel.json');
        } else if (type === 'role') {
            filePath = path.join(__dirname, '../../Config/constants/roles.json');
        } else {
            return interaction.reply({ content: 'Type must be either "channel" or "role".', flags: MessageFlags.Ephemeral });
        }
        let config;
        try {
            config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (err) {
            config = {};
        }
        const keys = Object.keys(config);
        if (keys.length === 0) {
            return interaction.reply({ content: `No constants found in ${type}.json.`, flags: MessageFlags.Ephemeral });
        }

        const sessionId = `${interaction.guildId}:${interaction.user.id}`;
        setupSessions.set(sessionId, { type, filePath, config, keys, index: 0 });

        await interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Setup Started')
                    .setDescription(`Setup started for **${type}.json**. Type \`cancel\` anytime to stop.`)
                    .setColor(0x5865F2)
            ],
            flags: MessageFlags.Ephemeral
        });
        askNext(interaction, sessionId);
    }
};

async function askNext(interaction, sessionId) {
    const session = setupSessions.get(sessionId);
    if (!session) return;
    if (session.index >= session.keys.length) {
        fs.writeFileSync(session.filePath, JSON.stringify(session.config, null, 2));
        await interaction.followUp({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Setup Complete')
                    .setDescription(`✅ All values saved to **${session.type}.json**.`)
                    .setColor(0x57F287)
            ],
            flags: 64
        });
        setupSessions.delete(sessionId);
        return;
    }

    const key = session.keys[session.index];
    const fieldInfo = getFieldInfo(session.type, key, session.config[key]);
    const prettyKey = fieldInfo.label;

    let options = buildSelectOptions(interaction, session, key);
    const placeholder = fieldInfo.multi
        ? `Select one or more ${session.type}s`
        : `Select a ${session.type}`;

    options = [
        {
            label: fieldInfo.multi ? 'Clear current selections' : 'Clear current selection',
            value: CLEAR_SELECTION_VALUE,
            description: fieldInfo.multi ? 'Save this field as an empty list.' : 'Save this field as empty.'
        },
        ...options
    ];

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`setup_select_${sessionId}`)
        .setPlaceholder(placeholder)
        .addOptions(options)
        .setMinValues(1)
        .setMaxValues(fieldInfo.multi ? Math.min(options.length, 25) : 1);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    await interaction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Setup Step')
                .setDescription([
                    `Configure **${prettyKey}**.`,
                    fieldInfo.description,
                    '',
                    `**Current value:** ${formatValueSummary(session.type, session.config[key])}`,
                    fieldInfo.multi
                        ? `Select one or more ${session.type}s, choose **Clear current selections**, type \`skip\` to leave it unchanged, or type \`cancel\` to stop.`
                        : `Select a ${session.type}, choose **Clear current selection**, type \`skip\` to leave it unchanged, or type \`cancel\` to stop.`
                ].join('\n'))
                .setColor(0x5865F2)
        ],
        components: [row],
        flags: 64
    });

    const filter = i => i.user.id === interaction.user.id && i.customId === `setup_select_${sessionId}`;
    const collector = interaction.channel.createMessageComponentCollector({ filter, max: 1, time: 60000 });
    const msgFilter = m => m.author.id === interaction.user.id && ['skip', 'cancel'].includes(m.content.trim().toLowerCase());
    const msgCollector = interaction.channel.createMessageCollector({ filter: msgFilter, max: 1, time: 60000 });

    collector.on('collect', async i => {
        const values = i.values;
        const shouldClear = values.includes(CLEAR_SELECTION_VALUE);

        if (shouldClear) {
            session.config[key] = fieldInfo.multi ? [] : '';
        } else {
            session.config[key] = fieldInfo.multi ? values : values[0];
        }

        session.index++;
        msgCollector.stop('handled');
        await i.update({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Selection Saved')
                    .setDescription(`Saved **${prettyKey}** as ${formatValueSummary(session.type, session.config[key])}`)
                    .setColor(0x57F287)
            ],
            components: [],
            flags: 64
        });
        askNext(interaction, sessionId);
    });

    msgCollector.on('collect', async msg => {
        const content = msg.content.trim().toLowerCase();
        if (content === 'cancel') {
            collector.stop('handled');
            fs.writeFileSync(session.filePath, JSON.stringify(session.config, null, 2));
            await interaction.followUp({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Setup Cancelled')
                        .setDescription('❌ Setup cancelled. Progress saved.')
                        .setColor(0xED4245)
                ],
                components: [],
                flags: 64
            });
            setupSessions.delete(sessionId);
            return;
        }
        if (content === 'skip') {
            session.index++;
            collector.stop('handled');
            await interaction.followUp({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Step Skipped')
                        .setDescription(`Skipped **${prettyKey}**.`)
                        .setColor(0x5865F2)
                ],
                components: [],
                flags: 64
            });
            askNext(interaction, sessionId);
            return;
        }
    });

    collector.on('end', async (collected, reason) => {
        if (reason === 'time' && setupSessions.has(sessionId)) {
            fs.writeFileSync(session.filePath, JSON.stringify(session.config, null, 2));
            await interaction.followUp({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Setup Timed Out')
                        .setDescription('⏰ Setup timed out. Progress saved.')
                        .setColor(0xED4245)
                ],
                components: [],
                flags: 64
            });
            setupSessions.delete(sessionId);
        }
    });
}