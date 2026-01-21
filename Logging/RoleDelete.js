const { EmbedBuilder } = require('discord.js');
const { Color } = require("../Config/constants/misc.json")
const { channelLog } = require("../Config/constants/channel.json")

module.exports = (client) => {
	client.on("roleDelete", async(role) => {
    let logs = await client.channels.cache.get(channelLog);
        	let embed = new EmbedBuilder()
            .setTitle("Role Deleted")
            .setColor(role.hexColor)
            .addFields(
                { name: "Role Name", value: role.name, inline: true },
                { name: "Role ID", value: role.id, inline: true },
                { name: "Role Hex Color", value: role.hexColor },
                { name: "Role Was Hoisted?", value: role.hoist.toString() },
                { name: "Role Was Mentionable By Everyone?", value: role.mentionable.toString() },
                { name: "Role Position", value: role.position.toString() }
            )
            return logs.send({embeds: [embed]});
    })
}





