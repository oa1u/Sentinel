const { EmbedBuilder } = require('discord.js');
const { Color } = require("../Config/constants/misc.json")
const { channelLog } = require("../Config/constants/channel.json")

module.exports = (client) => {
	client.on("inviteDelete", async(invite) => {
    let logs = await client.channels.cache.get(channelLog);
        	let embed = new EmbedBuilder()
            .setTitle("Invite Deleted")
            .setColor(parseInt(Color.replace('#', ''), 16));
            const fields = [
                { name: "Invite Code", value: invite.code, inline: true },
                { name: "Invite URL", value: invite.url, inline: true },
                { name: "Invite Channel", value: invite.channel.toString() }
            ];
  			if(invite.uses){
                fields.push({ name: "Invite Uses", value: invite.uses.toString() });
            }
        	if(invite.inviter){
                fields.push({ name: "Inviter", value: `${invite.inviter.tag} | ${invite.inviter.id}` });
            }
            embed.addFields(fields);
            return logs.send({embeds: [embed]});
    })
}





