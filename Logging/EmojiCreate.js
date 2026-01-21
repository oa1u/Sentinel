const { EmbedBuilder } = require('discord.js');
const { Color } = require("../Config/constants/misc.json")
const { channelLog } = require("../Config/constants/channel.json")

module.exports = (client) => {
	client.on("emojiCreate", async(emoji) => {
    let logs = await client.channels.cache.get(channelLog);
         let embed = new EmbedBuilder()
             .setTitle("Emoji Added")
             .setColor(parseInt(Color.replace('#', ''), 16))
            .setDescription(`A custom emoji was added to the server.`)
            .addFields(
                { name: "Emoji Name", value: emoji.name, inline: true },
                { name: "Emoji ID", value: emoji.id, inline: true },
                { name: "Animted Emoji?", value: emoji.animated.toString() }
            )
             if (emoji.author) embed.addFields({ name: "Added By", value: emoji.author.tag });
            return logs.send({embeds: [embed]});
  })
}





