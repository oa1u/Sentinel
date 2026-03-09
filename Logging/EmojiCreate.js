const { EmbedBuilder } = require('discord.js');
const { CHANNELS: { serverLogChannelId } } = require("../Config/constants");

// Log when new custom emojis are added — include metadata and a thumbnail.
module.exports = (client) => {
    client.on("emojiCreate", async (emoji) => {
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
                { name: "URL", value: `[Click Here](${emoji.imageURL()})` }
            )
            .setThumbnail(emoji.imageURL())
            .setTimestamp()
            .setFooter({ text: "Emoji Created" });
        if (emoji.author) embed.addFields({ name: "Added By", value: `${emoji.author.tag} (${emoji.author.id})` });
        return logs.send({ embeds: [embed] });
    })
}