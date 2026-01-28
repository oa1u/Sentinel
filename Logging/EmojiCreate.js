const { EmbedBuilder } = require('discord.js');
const { serverLogChannelId } = require("../Config/constants/channel.json");

module.exports = (client) => {
	client.on("emojiCreate", async(emoji) => {
    const logs = client.channels.cache.get(serverLogChannelId);
    if (!logs) return;
        const embed = new EmbedBuilder()
             .setTitle("😀 Emoji Added")
             .setColor("#43B581")
            .setDescription(`New emoji added to server.`)
            .addFields(
                { name: "Emoji", value: emoji.toString(), inline: true },
                { name: "Emoji Name", value: `\`:${emoji.name}:\``, inline: true },
                { name: "Emoji ID", value: `\`${emoji.id}\``, inline: true },
                { name: "Animated", value: emoji.animated ? "Yes" : "No", inline: true },
                { name: "URL", value: `[Click Here](${emoji.url})` }
            )
            .setThumbnail(emoji.url)
            .setTimestamp()
            .setFooter({ text: "Emoji Created" });
             if (emoji.author) embed.addFields({ name: "Added By", value: `${emoji.author.tag} (${emoji.author.id})` });
            return logs.send({embeds: [embed]});
  })
}