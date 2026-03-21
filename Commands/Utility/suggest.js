const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const MySQLDatabaseManager = require('../../Functions/MySQLDatabaseManager');
const { CHANNELS: { suggestionChannelId } } = require('../../Config/constants');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('suggest')
        .setDescription('Submit a suggestion for the server')
        .addStringOption(option =>
            option.setName('title')
                .setDescription('Brief title for your suggestion')
                .setRequired(true)
                .setMaxLength(100))
        .addStringOption(option =>
            option.setName('description')
                .setDescription('Detailed description of your suggestion')
                .setRequired(true)
                .setMaxLength(1000)),
    execute: async (interaction) => {
        const title = interaction.options.getString('title');
        const description = interaction.options.getString('description');
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;

        const { generateCaseId } = require('../../Events/caseId');

        try {
            const caseId = generateCaseId('SUGGEST', 8);

            const suggestionId = await MySQLDatabaseManager.createSuggestion(
                guildId,
                userId,
                title,
                description,
                caseId
            );

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setAuthor({
                    name: `💡 Suggestion #${suggestionId}`,
                    iconURL: interaction.user.displayAvatarURL()
                })
                .setTitle(`Suggestion: ${title}`)
                .setDescription(`**Description:**\n${description}`)
                .addFields(
                    { name: '👤 Submitted by', value: `<@${userId}>`, inline: true },
                    { name: '📊 Status', value: '🟡 **Pending**', inline: true },
                    { name: '📈 Votes', value: '👍 0 | 👎 0', inline: true }
                )
                .setFooter({ text: `Case ID: ${caseId} • Vote using the reactions below!` })
                .setTimestamp();

            const suggestionChannel = interaction.guild.channels.cache.get(suggestionChannelId);
            if (!suggestionChannel) {
                return await interaction.reply({
                    content: '❌ Suggestion channel not found. Please contact an admin.',
                    flags: require('discord.js').MessageFlags.Ephemeral
                });
            }
            const msg = await suggestionChannel.send({ embeds: [embed] });
            await msg.react('👍');
            await msg.react('👎');

            await MySQLDatabaseManager.updateSuggestionMessageId(suggestionId, msg.id);

            await interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x57F287)
                        .setTitle('Suggestion Submitted')
                        .setDescription(`Your suggestion has been posted in the suggestion channel.\n**Case ID:** ${caseId}`)
                        .setFooter({ text: 'Thank you for your feedback!' })
                        .setTimestamp()
                ],
                flags: require('discord.js').MessageFlags.Ephemeral
            });

            console.log(`[Suggestion] Created suggestion #${suggestionId} (Case ID: ${caseId}) by ${interaction.user.tag}`);

        } catch (error) {
            console.error('[Suggestion] Error creating suggestion:', error);
            await interaction.reply({
                content: '❌ Failed to create suggestion. Please try again later.',
                flags: require('discord.js').MessageFlags.Ephemeral
            });
        }
    }
};