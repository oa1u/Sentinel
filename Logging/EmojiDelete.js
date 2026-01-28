const { EmbedBuilder } = require('discord.js');
const { serverLogChannelId } = require("../Config/constants/channel.json");

module.exports = (client) => {
	client.on("emojiDelete", async(emoji) => {
    const logs = client.channels.cache.get(serverLogChannelId);
    if (!logs) return;
        const embed = new EmbedBuilder()
            .setTitle("🗑️ Emoji Deleted")
            .setColor("#F04747")
            .setDescription(`Emoji removed from server.`)
            .addFields(
                { name: "Emoji Name", value: `\`:${emoji.name}:\``, inline: true },
                { name: "Emoji ID", value: `\`${emoji.id}\``, inline: true },
                { name: "Animated", value: emoji.animated ? "Yes" : "No", inline: true }
            )
            .setThumbnail(emoji.url)
            .setTimestamp()
            .setFooter({ text: "Emoji Deleted" });
            return logs.send({embeds: [embed]});
    })
}