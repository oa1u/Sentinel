const { EmbedBuilder, ChannelType } = require('discord.js');
const { Color } = require("../Config/constants/misc.json")
const { channelLog } = require("../Config/constants/channel.json")

module.exports = (client) => {
	client.on("channelCreate", async(channel) => {
    let logs = await client.channels.cache.get(channelLog);
        if(channel.type === ChannelType.GuildText){
        	let embed = new EmbedBuilder()
            .setTitle("Channel Created")
            .setColor(parseInt(Color.replace('#', ''), 16))
            .setDescription(`A new channel was created.`)
            .addFields(
                { name: "Channel", value: channel.toString(), inline: true },
                { name: "Channel ID", value: channel.id, inline: true }
            );
            return logs.send({embeds: [embed]});
        }
    })
}





