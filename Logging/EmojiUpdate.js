const { EmbedBuilder } = require('discord.js');
const { channelLog } = require("../Config/constants/channel.json")

module.exports = (client) => {
	client.on("emojiUpdate", async(oldEmoji, newEmoji) => {
    let logs = await client.channels.cache.get(channelLog);
        	let embed = new EmbedBuilder()
            .setTitle("✏️ Emoji Updated")
            .setColor("#FAA61A")
            .setDescription(`A custom emoji has been updated.`)
            const fields = [];
            if(oldEmoji.name !== newEmoji.name){
                fields.push({ name: "Old Emoji Name", value: `\`:${oldEmoji.name}:\``, inline: true });
                fields.push({ name: "New Emoji Name", value: `\`:${newEmoji.name}:\``, inline: true });
            } else {
                fields.push({ name: "Emoji Name", value: `\`:${newEmoji.name}:\``, inline: true });
            }
            fields.push({ name: "Emoji ID", value: `\`${oldEmoji.id}\``, inline: true });
            fields.push({ name: "Emoji", value: newEmoji.toString(), inline: true });
            embed.addFields(fields);
            embed.setThumbnail(newEmoji.url);
            embed.setTimestamp().setFooter({ text: "Emoji Updated" });
            return logs.send({embeds: [embed]});
    })
}