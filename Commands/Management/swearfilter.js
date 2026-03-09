const fs = require('fs');
const path = require('path');
const { EmbedBuilder, MessageFlags } = require('discord.js');
const { SlashCommandBuilder } = require('@discordjs/builders');
const { ROLES: { administratorRoleId: adminRoleId } } = require('../../Config/constants');

const AUTOMOD_CONFIG_PATH = path.join(__dirname, '..', '..', 'Config', 'constants', 'automod.json');

function readAutoModConfig() {
    try {
        const raw = fs.readFileSync(AUTOMOD_CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        console.error('[swearfilter] Failed to read automod config:', error.message);
        return {};
    }
}

function writeAutoModConfig(config) {
    fs.writeFileSync(AUTOMOD_CONFIG_PATH, `${JSON.stringify(config, null, '\t')}\n`, 'utf8');
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('swearfilter')
        .setDescription('Enable or disable swear/profanity filtering in AutoMod.')
        .addStringOption((option) =>
            option
                .setName('state')
                .setDescription('Choose whether the swear filter is enabled')
                .setRequired(true)
                .addChoices(
                    { name: 'Enable', value: 'enable' },
                    { name: 'Disable', value: 'disable' }
                )
        ),
    category: 'management',
    async execute(interaction) {
        const member = interaction.member;
        const hasAdminRole = member?.roles?.cache?.has(adminRoleId);
        const hasAdminPerm = member?.permissions?.has('Administrator');

        if (!hasAdminRole && !hasAdminPerm) {
            const deniedEmbed = new EmbedBuilder()
                .setColor(0xFF4444)
                .setTitle('Permission Denied')
                .setDescription('You need the Administrator role or Administrator permissions to use this command.');
            return interaction.reply({ embeds: [deniedEmbed], flags: MessageFlags.Ephemeral });
        }

        const desiredState = interaction.options.getString('state', true);
        const enabled = desiredState === 'enable';

        try {
            const config = readAutoModConfig();
            config.autoMod = config.autoMod && typeof config.autoMod === 'object' ? config.autoMod : {};
            config.autoMod.profanityFilterEnabled = enabled;

            const activeProfile = config?.autoModProfiles?.activeProfile;
            const activeProfileConfig = activeProfile && config?.autoModProfiles?.profiles
                ? config.autoModProfiles.profiles[activeProfile]
                : null;

            if (activeProfileConfig && typeof activeProfileConfig === 'object') {
                activeProfileConfig.autoMod = activeProfileConfig.autoMod && typeof activeProfileConfig.autoMod === 'object'
                    ? activeProfileConfig.autoMod
                    : {};
                activeProfileConfig.autoMod.profanityFilterEnabled = enabled;
            }

            writeAutoModConfig(config);

            const successEmbed = new EmbedBuilder()
                .setColor(enabled ? 0x57F287 : 0xFEE75C)
                .setTitle(`Swear Filter ${enabled ? 'Enabled' : 'Disabled'}`)
                .setDescription(`AutoMod profanity filtering is now **${enabled ? 'enabled' : 'disabled'}**.${activeProfile ? `\nUpdated profile: **${activeProfile}**.` : ''}\nChanges apply within a few seconds.`);

            return interaction.reply({ embeds: [successEmbed], flags: MessageFlags.Ephemeral });
        } catch (error) {
            console.error('[swearfilter] Failed to update swear filter state:', error.message);
            const errorEmbed = new EmbedBuilder()
                .setColor(0xFF4444)
                .setTitle('Update Failed')
                .setDescription('Could not update AutoMod swear filter settings.');
            return interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
        }
    }
};