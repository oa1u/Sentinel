const { EmbedBuilder } = require('discord.js');
const { channelLog } = require("../Config/constants/channel.json")

module.exports = (client) => {
	client.on("emojiDelete", async(emoji) => {
    let logs = await client.channels.cache.get(channelLog);
        	let embed = new EmbedBuilder()
            .setTitle("🗑️ Emoji Deleted")
            .setColor("#F04747")
            .setDescription(`A custom emoji has been deleted from the server.`)
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