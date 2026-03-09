const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { generateCaseId } = require('../../Events/caseId');
const { sendErrorReply, sendSuccessReply, sendWarningReply, createModerationEmbed, createModerationDmEmbed } = require('../../Functions/EmbedBuilders');
const { canModerateMember, addCase, sendModerationDM, logModerationAction } = require('../../Functions/ModerationHelper');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setnick')
        .setDescription('Set or reset a user nickname')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User to change nickname')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('nickname')
                .setDescription('New nickname (leave empty to reset)')
                .setRequired(false)
        ),
    category: 'moderation',
    async execute(interaction) {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
        }

        const targetUser = interaction.options.getUser('user');
        const newNicknameRaw = interaction.options.getString('nickname');
        const reason = interaction.options.getString('reason');

        if (!targetUser) {
            return sendErrorReply(interaction, 'Invalid User', 'Please provide a valid user.');
        }

        if (!await canModerateMember(interaction, targetUser, 'setnick')) {
            return;
        }

        const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (!targetMember) {
            return sendWarningReply(interaction, 'User Not Found', `**${targetUser.tag}** is not in this server.`);
        }

        if (!targetMember.manageable) {
            return sendErrorReply(interaction, 'Cannot Edit Nickname', 'I do not have permission to change that user\'s nickname.');
        }

        const newNickname = newNicknameRaw && String(newNicknameRaw).trim().length
            ? String(newNicknameRaw).trim()
            : null;

        if (newNickname && newNickname.length > 32) {
            return sendWarningReply(interaction, 'Nickname Too Long', 'Nicknames must be 32 characters or fewer.');
        }

        const oldNickname = targetMember.nickname || targetMember.user.username;
        const caseId = generateCaseId('NICK');

        try {
            await targetMember.setNickname(newNickname, reason);
        } catch (error) {
            return sendErrorReply(interaction, 'Nickname Update Failed', error?.message || 'Unable to update nickname.');
        }

        const actionLabel = newNickname ? 'Set Nickname' : 'Reset Nickname';
        const logEmbed = createModerationEmbed({
            action: actionLabel,
            target: targetUser,
            moderator: interaction.user,
            reason,
            caseId,
            color: 0x5865F2
        }).addFields(
            { name: 'Old Nickname', value: `\`${oldNickname}\``, inline: true },
            { name: 'New Nickname', value: newNickname ? `\`${newNickname}\`` : 'Reset to default', inline: true }
        );

        await logModerationAction(interaction, logEmbed);

        addCase(targetUser.id, caseId, {
            moderator: interaction.user.id,
            moderatorTag: interaction.user.username,
            userTag: targetUser.username,
            reason: `(setnick) - ${reason}`,
            date: new Date().toLocaleDateString('en-US'),
            type: 'NICKNAME',
            oldNickname,
            newNickname: newNickname || null
        });

        const dmEmbed = createModerationDmEmbed({
            actionTitle: newNickname ? 'Nickname Updated' : 'Nickname Reset',
            actionEmoji: '🏷️',
            color: 0x5865F2,
            guildName: interaction.guild.name,
            description: newNickname
                ? `Your nickname has been updated in **${interaction.guild.name}**.`
                : `Your nickname has been reset in **${interaction.guild.name}**.`,
            statusLabel: 'Nickname',
            statusValue: newNickname ? newNickname : 'Reset to default',
            reason,
            caseId,
            moderatorName: interaction.user.username
        });

        await sendModerationDM(targetUser, dmEmbed);

        return sendSuccessReply(
            interaction,
            'Nickname Updated',
            newNickname
                ? `**${targetUser.tag}** is now **${newNickname}**.`
                : `Nickname reset for **${targetUser.tag}**.`
        );
    }
};