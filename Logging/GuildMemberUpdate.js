const { EmbedBuilder } = require('discord.js');
const { Color } = require("../Config/constants/misc.json")
const { channelLog } = require("../Config/constants/channel.json")

module.exports = (client) => {
	client.on("guildMemberUpdate", async(Old, New) => {
 	   let logs = await client.channels.cache.get(channelLog);
	   if(Old.user.tag !== New.user.tag || Old.displayName !== New.displayName || Old.user.username !== New.user.username){
    	   let embed = new EmbedBuilder()
            .setTitle("Member Updated")
            .setColor(parseInt(Color.replace('#', ''), 16));
            const fields = [];
            if(Old.user.tag !== New.user.tag){
                fields.push({ name: "Old User Tag", value: Old.user.tag });
                fields.push({ name: "New User Tag", value: New.user.tag });
            }else{
                fields.push({ name: "User Tag", value: Old.user.tag });
            }
        	if(Old.displayName !== New.displayName){
                fields.push({ name: "Old Nickname", value: Old.nickname || "None" });
                fields.push({ name: "New Nickname", value: New.nickname || "None" });
            }   	
        	if(Old.user.username !== New.user.username){
                fields.push({ name: "Old Username", value: Old.user.username });
                fields.push({ name: "New Username", value: New.user.username });
            }
            embed.addFields(fields);
            embed.setThumbnail(New.user.displayAvatarURL({ dynamic: true }));
            return logs.send({embeds: [embed]});
        }
    })
}





