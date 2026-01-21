const { EmbedBuilder } = require('discord.js');
const { Color } = require("../Config/constants/misc.json")
const { channelLog } = require("../Config/constants/channel.json")

module.exports = (client) => {
	client.on("roleUpdate", async(Old, New) => {
    let logs = await client.channels.cache.get(channelLog);
      if(Old.hexColor !== New.hexColor || Old.name !== New.name || Old.hoist !== New.hoist || Old.mentionable !== New.mentionable){
        let embed = new EmbedBuilder()
            .setTitle("Role Updated")
            .setColor(New.hexColor);
        const fields = [];
            if(Old.name !== New.name){
                fields.push({ name: "Old Role Name", value: Old.name });
                fields.push({ name: "New Role Name", value: New.name });
            }else{
            	fields.push({ name: "Role Name", value: Old.name });
            }
        	if(Old.hexColor !== New.hexColor){
        		fields.push({ name: "Old Role Hex Color", value: Old.hexColor });
                fields.push({ name: "New Role Hex Color", value: New.hexColor });
            }
        	if(Old.hoist !== New.hoist){
            	fields.push({ name: "Old Role Hoisted?", value: Old.hoist.toString() });
                fields.push({ name: "New Role Hoisted?", value: New.hoist.toString() });
            }
        	if(Old.mentionable !== New.mentionable){
            	fields.push({ name: "Old Role Mentionable By Everyone?", value: Old.mentionable.toString() });
                fields.push({ name: "New Role Mentionable By Everyone?", value: New.mentionable.toString() });
            }
        	embed.addFields(fields);
        	return logs.send({embeds: [embed]});
        }
    })
}





