const { EmbedBuilder } = require('discord.js');
const { createLogEmbed, sendLogEmbed } = require('../Functions/LoggingHelper');

module.exports = {
    name: 'guildMemberUpdate',
    async execute(oldMember, newMember) {
        // Check if the member started boosting
        if (!oldMember.premiumSince && newMember.premiumSince) {
            const boostCount = newMember.guild.premiumSubscriptionCount || 'Unknown';
            const joinDate = `<t:${Math.floor(newMember.joinedTimestamp / 1000)}:R>`;
            const accountCreated = `<t:${Math.floor(newMember.user.createdTimestamp / 1000)}:R>`;
            const embed = new EmbedBuilder()
                .setColor(0xF47FFF)
                .setTitle('🚀 Server Boost!')
                .setDescription(`**${newMember.user.tag}** just boosted the server! Thank you for the support!`)
                .addFields(
                    { name: '👤 User', value: `${newMember.user.tag} (${newMember.id})`, inline: true },
                    { name: '📅 Joined Server', value: joinDate, inline: true },
                    { name: '📆 Account Created', value: accountCreated, inline: true },
                    { name: '🚀 Total Boosts', value: `${boostCount}`, inline: true }
                )
                .setThumbnail(newMember.user.displayAvatarURL({ dynamic: true }))
                .setFooter({ text: `User boosted • ID: ${newMember.id}` })
                .setTimestamp();
            await sendLogEmbed(newMember.guild, embed);
        }
        // Log when a member stopped boosting
        if (oldMember.premiumSince && !newMember.premiumSince) {
            // Calculate boost duration
            let boostDuration = '';
            if (oldMember.premiumSince) {
                const ms = Date.now() - new Date(oldMember.premiumSince).getTime();
                const days = Math.floor(ms / (1000 * 60 * 60 * 24));
                const hours = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                if (days > 0) boostDuration += `${days}d `;
                boostDuration += `${hours}h`;
            }
            const boostCount = newMember.guild.premiumSubscriptionCount || 'Unknown';
            const embed = new EmbedBuilder()
                .setColor(0x808080)
                .setTitle('Boost Ended')
                .setDescription(`**${newMember.user.tag}** has stopped boosting the server.`)
                .addFields(
                    { name: '👤 User', value: `${newMember.user.tag} (${newMember.id})`, inline: true },
                    { name: '⏱️ Boost Duration', value: boostDuration || 'Unknown', inline: true },
                    { name: '🚀 Total Boosts', value: `${boostCount}`, inline: true }
                )
                .setThumbnail(newMember.user.displayAvatarURL({ dynamic: true }))
                .setFooter({ text: `Boost ended • ID: ${newMember.id}` })
                .setTimestamp();
            await sendLogEmbed(newMember.guild, embed);
        }
    }
};
