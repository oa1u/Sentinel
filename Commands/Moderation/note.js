const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');
const { sendErrorReply, sendSuccessReply, sendWarningReply, sendInfoReply } = require('../../Functions/EmbedBuilders');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('note')
        .setDescription('Add, view, or delete moderation notes for a user')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('Add a moderation note to a user')
                .addUserOption(option =>
                    option
                        .setName('user')
                        .setDescription('User to add a note for')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('text')
                        .setDescription('The note content')
                        .setRequired(true)
                        .setMinLength(2)
                        .setMaxLength(1000)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('view')
                .setDescription('View moderation notes for a user')
                .addUserOption(option =>
                    option
                        .setName('user')
                        .setDescription('User to view notes for')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('delete')
                .setDescription('Delete all moderation notes for a user')
                .addUserOption(option =>
                    option
                        .setName('user')
                        .setDescription('User to clear notes for')
                        .setRequired(true)
                )
        ),
    category: 'moderation',
    async execute(interaction) {
        if (!interaction.guild || !interaction.member) {
            return interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
        }

        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
        }

        const subcommand = interaction.options.getSubcommand();
        const targetUser = interaction.options.getUser('user', true);

        try {
            if (subcommand === 'add') {
                const noteText = interaction.options.getString('text', true).trim();
                const existingNotes = await DatabaseManager.getMemberNotes(targetUser.id);

                const entry = `${interaction.user.tag}: ${noteText}`;
                const merged = existingNotes && existingNotes.trim().length > 0
                    ? `${existingNotes.trim()}\n${entry}`
                    : entry;

                if (merged.length > 6000) {
                    return sendWarningReply(
                        interaction,
                        'Notes Too Long',
                        'This user\'s notes are too long to append another entry. Delete or shorten existing notes first.'
                    );
                }

                const saved = await DatabaseManager.updateMemberNotes(targetUser.id, merged);
                if (!saved) {
                    return sendErrorReply(interaction, 'Save Failed', 'Could not save the note right now.');
                }

                return sendSuccessReply(interaction, 'Note Added', `Added a moderation note for ${targetUser}.`);
            }

            if (subcommand === 'view') {
                const notes = await DatabaseManager.getMemberNotes(targetUser.id);
                if (!notes || !notes.trim()) {
                    return sendInfoReply(interaction, 'No Notes Found', `No moderation notes found for ${targetUser}.`);
                }

                const safeNotes = notes.length > 3900 ? `${notes.slice(0, 3900)}\n\n... (truncated)` : notes;
                const embed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('📝 User Notes')
                    .setDescription(`User: ${targetUser}\n\n${safeNotes}`)
                    .setTimestamp();

                return interaction.editReply({ embeds: [embed] });
            }

            if (subcommand === 'delete') {
                const notes = await DatabaseManager.getMemberNotes(targetUser.id);
                if (!notes || !notes.trim()) {
                    return sendInfoReply(interaction, 'No Notes Found', `No moderation notes found for ${targetUser}.`);
                }

                const cleared = await DatabaseManager.updateMemberNotes(targetUser.id, '');
                if (!cleared) {
                    return sendErrorReply(interaction, 'Delete Failed', 'Could not delete notes right now.');
                }

                return sendSuccessReply(interaction, 'Notes Deleted', `Cleared all moderation notes for ${targetUser}.`);
            }

            return sendWarningReply(interaction, 'Unknown Action', 'That note action is not supported.');
        } catch (error) {
            console.error('[note] Error:', error.message);
            return sendErrorReply(interaction, 'Note Command Failed', `Could not complete this action.\nError: ${error.message}`);
        }
    }
};