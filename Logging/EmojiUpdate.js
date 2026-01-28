const { EmbedBuilder } = require('discord.js');
const { serverLogChannelId } = require("../Config/constants/channel.json");

module.exports = (client) => {
	client.on("emojiUpdate", async(oldEmoji, newEmoji) => {
        const logs = client.channels.cache.get(serverLogChannelId);
        if (!logs) return;
        
        const embed = new EmbedBuilder()
            .setTitle("✏️ Emoji Updated")
            .setColor("#FAA61A")
            .setDescription(`Emoji updated.`)
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