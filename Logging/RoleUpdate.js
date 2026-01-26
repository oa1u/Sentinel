const { EmbedBuilder } = require('discord.js');
const { channelLog } = require("../Config/constants/channel.json")

module.exports = (client) => {
	client.on("roleUpdate", async(Old, New) => {
    let logs = await client.channels.cache.get(channelLog);
      if(Old.hexColor !== New.hexColor || Old.name !== New.name || Old.hoist !== New.hoist || Old.mentionable !== New.mentionable || Old.permissions.bitfield !== New.permissions.bitfield){
        let embed = new EmbedBuilder()
            .setTitle("✏️ Role Updated")
            .setColor(New.hexColor !== "#000000" ? parseInt(New.hexColor.replace('#', ''), 16) : 0xFAA61A)
            .setDescription(`A role has been updated.`);
        const fields = [];
            if(Old.name !== New.name){
                fields.push({ name: "Old Role Name", value: `@${Old.name}`, inline: true });
                fields.push({ name: "New Role Name", value: New.toString(), inline: true });
            }else{
            	fields.push({ name: "Role", value: New.toString(), inline: true });
            }
            fields.push({ name: "Role ID", value: `\`${New.id}\``, inline: true });
        	if(Old.hexColor !== New.hexColor){
        		fields.push({ name: "Old Role Color", value: Old.hexColor, inline: true });
                fields.push({ name: "New Role Color", value: New.hexColor, inline: true });
            }
        	if(Old.hoist !== New.hoist){
            	fields.push({ name: "Old Hoist Setting", value: Old.hoist ? "Yes" : "No", inline: true });
                fields.push({ name: "New Hoist Setting", value: New.hoist ? "Yes" : "No", inline: true });
            }
        	if(Old.mentionable !== New.mentionable){
            	fields.push({ name: "Old Mentionable Setting", value: Old.mentionable ? "Yes" : "No", inline: true });
                fields.push({ name: "New Mentionable Setting", value: New.mentionable ? "Yes" : "No", inline: true });
            }
            if(Old.permissions.bitfield !== New.permissions.bitfield){
                fields.push({ name: "Permissions", value: "Role permissions have been updated", inline: false });
            }
        	embed.addFields(fields);
            embed.setTimestamp().setFooter({ text: "Role Updated" });
        	return logs.send({embeds: [embed]});
        }
    })
}