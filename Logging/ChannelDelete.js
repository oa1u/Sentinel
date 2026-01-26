const { EmbedBuilder, ChannelType } = require('discord.js');
const { channelLog } = require("../Config/constants/channel.json")

module.exports = (client) => {
	client.on("channelDelete", async(channel) => {
    let logs = await client.channels.cache.get(channelLog);
        if(channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildVoice){
            const isVoice = channel.type === ChannelType.GuildVoice;
            const channelTypeText = isVoice ? "Voice Channel" : "Text Channel";
            const emoji = isVoice ? "🔊" : "📝";
            const channelPrefix = isVoice ? "🔊 " : "#";
            
        	let embed = new EmbedBuilder()
            .setTitle("🗑️ Channel Deleted")
            .setColor("#F04747")
            .setDescription(`A ${channelTypeText.toLowerCase()} has been deleted from the server.`)
            const fields = [
                { name: "Channel Name", value: `${channelPrefix}${channel.name}`, inline: true },
                { name: "Channel ID", value: `\`${channel.id}\``, inline: true },
                { name: "Channel Type", value: channelTypeText, inline: true }
            ];
            
            if(!isVoice){
                fields.push({ name: "NSFW", value: channel.nsfw ? "Yes" : "No", inline: true });
                if(channel.topic){ 
                    fields.push({ name: "Channel Topic", value: channel.topic });
                }
            } else {
                fields.push(
                    { name: "User Limit", value: channel.userLimit === 0 ? "Unlimited" : channel.userLimit.toString(), inline: true },
                    { name: "Bitrate", value: `${channel.bitrate / 1000}kbps`, inline: true }
                );
            }
            
            if(channel.parent){
                fields.push({ name: "Category", value: channel.parent.name, inline: true });
            }
            embed.addFields(fields);
            embed.setTimestamp().setFooter({ text: "Channel Deleted" });
            return logs.send({embeds: [embed]});
        }
    })
}