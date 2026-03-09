const { SlashCommandBuilder } = require('@discordjs/builders');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const { ROLES: { verifiedRoleId }, CHANNELS: { captchaLogChannelId } } = require('../../Config/constants');
const { recordVerificationEvent } = require('../../Functions/VerificationAnalytics');
const { registerVerificationSuccess } = require('../../Functions/VerificationSessionManager');
const { shouldUseStrictMode } = require('../../Functions/VerificationFlowHelper');

function getRoleAssignmentIssue(member, roleObj) {
    if (!member || !roleObj || !member.guild) return 'Missing member or role context.';

    const me = member.guild.members.me;
    if (!me) return 'Bot member object is unavailable in this guild.';

    if (!me.permissions.has('ManageRoles')) {
        return 'Bot is missing the Manage Roles permission.';
    }

    if (roleObj.managed) {
        return 'Target role is managed by an integration and cannot be assigned manually.';
    }

    if (me.roles.highest.position <= roleObj.position) {
        return `Verified role (${roleObj.name}) is higher than or equal to the bot\'s highest role (${me.roles.highest.name}).`;
    }

    if (!member.manageable) {
        return 'Bot cannot manage this member due to role hierarchy or ownership restrictions.';
    }

    return null;
}

function formatAccountAge(createdTimestamp) {
    const createdAtMs = Number(createdTimestamp) || 0;
    if (!createdAtMs) return 'Unknown';

    const ageMs = Math.max(0, Date.now() - createdAtMs);
    const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    const hours = Math.floor((ageMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));

    if (days <= 0) {
        return `${hours}h`;
    }

    if (days < 30) {
        return `${days}d ${hours}h`;
    }

    const months = Math.floor(days / 30);
    const remainingDays = days % 30;
    if (remainingDays === 0) {
        return `${months}mo`;
    }

    return `${months}mo ${remainingDays}d`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('verify-override')
        .setDescription('Staff override: instantly verify a member')
        .addUserOption((option) =>
            option
                .setName('user')
                .setDescription('Member to verify')
                .setRequired(true)
        )
        .addStringOption((option) =>
            option
                .setName('reason')
                .setDescription('Reason for manual override')
                .setRequired(false)
        ),
    category: 'moderation',
    async execute(interaction) {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
        }

        if (!interaction.memberPermissions?.has('ManageRoles')) {
            return interaction.editReply({
                content: 'You need the `Manage Roles` permission to use this command.'
            });
        }

        const targetUser = interaction.options.getUser('user', true);
        const reason = String(interaction.options.getString('reason') || 'Manual verification override by staff').trim();

        const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (!targetMember) {
            return interaction.editReply({ content: 'That user is not currently in this server.' });
        }

        const strictModeFlagged = shouldUseStrictMode(targetMember.user?.createdTimestamp);
        const accountAgeText = formatAccountAge(targetMember.user?.createdTimestamp);

        if (targetMember.roles.cache.has(verifiedRoleId)) {
            return interaction.editReply({ content: `${targetUser.tag} is already verified.` });
        }

        const roleObj = interaction.guild.roles.cache.get(verifiedRoleId);
        if (!roleObj) {
            return interaction.editReply({ content: 'Verified role is not configured or missing.' });
        }

        const roleIssue = getRoleAssignmentIssue(targetMember, roleObj);
        if (roleIssue) {
            return interaction.editReply({ content: `Cannot assign verified role: ${roleIssue}` });
        }

        await targetMember.roles.add(roleObj).catch(async (error) => {
            await interaction.editReply({ content: `Failed to assign role: ${error?.message || 'Unknown error'}` }).catch(() => { });
            throw error;
        });

        registerVerificationSuccess(targetMember.id);

        await recordVerificationEvent({
            type: 'staff_override',
            userId: targetMember.id,
            username: targetMember.user.tag,
            guildId: interaction.guild.id,
            guildName: interaction.guild.name,
            mode: 'staff_override',
            reason: `${reason} | by ${interaction.user.tag} | strictModeFlagged=${strictModeFlagged} | accountAge=${accountAgeText}`
        }).catch(() => { });

        const successEmbed = new EmbedBuilder()
            .setColor(0x43B581)
            .setTitle('✅ Verification Override Complete')
            .setDescription(`Verified ${targetMember} using staff override.`)
            .addFields(
                { name: 'Role', value: `${roleObj}`, inline: true },
                { name: 'Moderator', value: `${interaction.user.tag}`, inline: true },
                { name: 'Account Age', value: accountAgeText, inline: true },
                { name: 'Strict Mode Flag', value: strictModeFlagged ? 'Yes' : 'No', inline: true },
                { name: 'Reason', value: reason, inline: false }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [successEmbed] });

        const logChannel = interaction.client.channels.cache.get(captchaLogChannelId);
        if (logChannel) {
            await logChannel.send({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x5865F2)
                        .setTitle('🛠️ Staff Verification Override')
                        .setDescription(`${targetMember} was manually verified by ${interaction.user}.`)
                        .addFields(
                            { name: 'Reason', value: reason, inline: false },
                            { name: 'Role Granted', value: `${roleObj}`, inline: true },
                            { name: 'Account Age', value: accountAgeText, inline: true },
                            { name: 'Strict Mode Flag', value: strictModeFlagged ? 'Yes' : 'No', inline: true }
                        )
                        .setTimestamp()
                ]
            }).catch(() => { });
        }
    }
};