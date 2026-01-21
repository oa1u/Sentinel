const { EmbedBuilder } = require('discord.js');
const { Color } = require("../Config/constants/misc.json")
const { channelLog } = require("../Config/constants/channel.json")

module.exports = (client) => {
	client.on("guildMemberRemove", async(member) => {
    let logs = await client.channels.cache.get(channelLog);
        	let embed = new EmbedBuilder()
            .setTitle("Member Left")
            .setColor(parseInt(Color.replace('#', ''), 16))
            .setDescription(`A member left the server.`)
            .addFields(
                { name: "User", value: member.user.tag, inline: true },
                { name: "User ID", value: member.id, inline: true },
                { name: "User Account Registered At", value: member.user.createdAt.toString() }
            )
            .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
            return logs.send({embeds: [embed]});
    })
}





