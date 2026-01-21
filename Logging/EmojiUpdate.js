const { EmbedBuilder } = require('discord.js');
const { Color } = require("../Config/constants/misc.json")
const { channelLog } = require("../Config/constants/channel.json")

module.exports = (client) => {
	client.on("emojiUpdate", async(oldEmoji, newEmoji) => {
    let logs = await client.channels.cache.get(channelLog);
        	let embed = new EmbedBuilder()
            .setTitle("Emoji Updated")
            .setColor(parseInt(Color.replace('#', ''), 16))
            .setDescription(`A custom emoji was updated.`)
            const fields = [];
            if(oldEmoji.name !== newEmoji.name){
                fields.push({ name: "Old Emoji Name", value: oldEmoji.name, inline: true });
                fields.push({ name: "New Emoji Name", value: newEmoji.name, inline: true });
            }
            fields.push({ name: "Emoji ID", value: oldEmoji.id, inline: true });
            embed.addFields(fields); 
            return logs.send({embeds: [embed]});
    })
}





