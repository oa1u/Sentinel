const { EmbedBuilder } = require('discord.js');
const { Color } = require("../Config/constants/misc.json")
const { channelLog } = require("../Config/constants/channel.json")

module.exports = (client) => {
	client.on("roleCreate", async(role) => {
    let logs = await client.channels.cache.get(channelLog);
        	let embed = new EmbedBuilder()
            .setTitle("New Role Created")
            .setColor(role.hexColor)
            .addFields(
                { name: "Role Name", value: role.name, inline: true },
                { name: "Role ID", value: role.id, inline: true },
                { name: "Role Hex Color", value: role.hexColor },
                { name: "Role Hoisted?", value: role.hoist.toString() },
                { name: "Role Mentionable By Everyone?", value: role.mentionable.toString() },
                { name: "Role Position", value: role.position.toString() }
            )
            return logs.send({embeds: [embed]});
    })
}





