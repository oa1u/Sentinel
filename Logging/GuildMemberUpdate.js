const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require("../Config/constants");

// Log member updates (nickname, username changes) with old and new values for auditing.
module.exports = (client) => {
    client.on("guildMemberUpdate", async (Old, New) => {
        const logs = client.channels.cache.get(serverLogChannelId);
        if (!logs) return;
        // Only log if their nickname or username actually changed
        if (Old.displayName !== New.displayName || Old.user.username !== New.user.username) {
            const embed = new EmbedBuilder()
                .setTitle("✏️ Member Updated")
                .setColor("#FAA61A")
                .setDescription(`${New.user.toString()} updated.`);
            const fields = [];
            fields.push({ name: "User", value: `${New.user.tag}`, inline: true });
            fields.push({ name: "User ID", value: `\`${New.id}\``, inline: true });
            // Log nickname change if it happened
            if (Old.displayName !== New.displayName) {
                fields.push({ name: "Old Nickname", value: Old.nickname || "None", inline: true });
                fields.push({ name: "New Nickname", value: New.nickname || "None", inline: true });
            }
            // Log username change if that's what changed
            if (Old.user.username !== New.user.username) {
                fields.push({ name: "Old Username", value: Old.user.username, inline: true });
                fields.push({ name: "New Username", value: New.user.username, inline: true });
            }
            embed.addFields(fields);
            embed.setThumbnail(New.user.displayAvatarURL({ size: 256 }));
            embed.setTimestamp().setFooter({ text: `Member Updated • ID: ${New.id}` });
            return logs.send({ embeds: [embed] });
        }
    })
}