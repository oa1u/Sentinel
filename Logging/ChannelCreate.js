const { EmbedBuilder, ChannelType } = require('discord.js');
const { serverLogChannelId } = require("../Config/constants/channel.json");

module.exports = (client) => {
	client.on("channelCreate", async(channel) => {
    const logs = client.channels.cache.get(serverLogChannelId);
    if (!logs) return;
        if(channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildVoice){
            const isVoice = channel.type === ChannelType.GuildVoice;
            const channelTypeText = isVoice ? "Voice Channel" : "Text Channel";
            const emoji = isVoice ? "🔊" : "📝";
            
        const embed = new EmbedBuilder()
            .setTitle(`${emoji} Channel Created`)
            .setColor("#43B581")
            .setDescription(`New ${channelTypeText.toLowerCase()} created.`)
            .addFields(
                { name: "Channel", value: channel.toString(), inline: true },
                { name: "Channel ID", value: `\`${channel.id}\``, inline: true },
                { name: "Channel Type", value: channelTypeText, inline: true },
                { name: "Category", value: channel.parent ? channel.parent.name : "None", inline: true },
                { name: "Position", value: channel.position.toString(), inline: true }
            )
            .setTimestamp()
            .setFooter({ text: `Channel Created` });
            
            if(!isVoice){
                embed.addFields({ name: "NSFW", value: channel.nsfw ? "Yes" : "No", inline: true });
                if(channel.topic) embed.addFields({ name: "Topic", value: channel.topic });
            } else {
                embed.addFields(
                    { name: "User Limit", value: channel.userLimit === 0 ? "Unlimited" : channel.userLimit.toString(), inline: true },
                    { name: "Bitrate", value: `${channel.bitrate / 1000}kbps`, inline: true }
                );
            }
            
            return logs.send({embeds: [embed]});
        }
    })
}