const { EmbedBuilder, ChannelType } = require('discord.js');
const { Color } = require("../Config/constants/misc.json")
const { channelLog } = require("../Config/constants/channel.json")

module.exports = (client) => {
	client.on("channelDelete", async(channel) => {
    let logs = await client.channels.cache.get(channelLog);
        if(channel.type === ChannelType.GuildText){
        	let embed = new EmbedBuilder()
            .setTitle("Channel Deleted")
            .setColor(parseInt(Color.replace('#', ''), 16))
            .setDescription(`A channel was deleted.`)
            const fields = [
                { name: "Channel Name", value: channel.name, inline: true },
                { name: "Channel ID", value: channel.id, inline: true }
            ];
            if(channel.topic){ 
                fields.push({ name: "Channel Topic", value: channel.topic });
            }
            fields.push({ name: "NSFW", value: channel.nsfw.toString() });
            embed.addFields(fields);
            return logs.send({embeds: [embed]});
        }
    })
}





