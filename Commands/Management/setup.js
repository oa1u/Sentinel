// Turn constant keys into readable labels.
function prettifyConstantName(key) {
    let name = key.replace(/Id$/i, '');
    name = name.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
    return name.trim();
}
const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ChannelType } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Track setup sessions per user and guild.
const setupSessions = new Map();

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
            return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
        }
        const type = interaction.options.getString('type');
        let filePath;
        if (type === 'channel') {
            filePath = path.join(__dirname, '../../Config/constants/channel.json');
        } else if (type === 'role') {
            filePath = path.join(__dirname, '../../Config/constants/roles.json');
        } else {
            return interaction.reply({ content: 'Type must be either "channel" or "role".', ephemeral: true });
        }
        let config;
        try {
            config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (err) {
            config = {};
        }
        const keys = Object.keys(config);
        if (keys.length === 0) {
            return interaction.reply({ content: `No constants found in ${type}.json.`, ephemeral: true });
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
            flags: 64
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
    const prettyKey = prettifyConstantName(key);

    let options = [];
    let placeholder = '';
    if (session.type === 'channel') {
        const allowedTypes = [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice, ChannelType.GuildForum];
        options = interaction.guild.channels.cache
            .filter(ch => allowedTypes.includes(ch.type))
            .map(ch => ({ label: ch.name, value: ch.id }))
            .slice(0, 25);
        placeholder = 'Select a channel';
    } else if (session.type === 'role') {
        options = interaction.guild.roles.cache
            .filter(role => role.editable && role.id !== interaction.guild.id)
            .map(role => ({ label: role.name, value: role.id }))
            .slice(0, 25);
        placeholder = 'Select a role';
    }

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`setup_select_${sessionId}`)
        .setPlaceholder(placeholder)
        .addOptions(options)
        .setMinValues(1)
        .setMaxValues(1);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    await interaction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Setup Step')
                .setDescription(`Select the ${session.type} for **${prettyKey}** or type 'skip' to leave unchanged, 'cancel' to stop.`)
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
        const value = i.values[0];
        session.config[key] = value;
        session.index++;
        await i.update({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Selection Saved')
                    .setDescription(`Saved **${key}** as <#${value}>`)
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
            await interaction.followUp({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Step Skipped')
                        .setDescription(`Skipped **${key}**.`)
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