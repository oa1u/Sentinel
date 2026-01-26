const { EmbedBuilder } = require('discord.js');
const { channelLog } = require("../Config/constants/channel.json")

module.exports = (client) => {
	client.on("roleCreate", async(role) => {
    let logs = await client.channels.cache.get(channelLog);
        	let embed = new EmbedBuilder()
            .setTitle("🏷️ Role Created")
            .setColor(role.hexColor !== "#000000" ? parseInt(role.hexColor.replace('#', ''), 16) : 0x43B581)
            .setDescription(`A new role has been created in the server.`)
            .addFields(
                { name: "Role", value: role.toString(), inline: true },
                { name: "Role ID", value: `\`${role.id}\``, inline: true },
                { name: "Role Color", value: `${role.hexColor}`, inline: true },
                { name: "Hoisted", value: role.hoist ? "Yes (Displayed separately)" : "No", inline: true },
                { name: "Mentionable", value: role.mentionable ? "Yes" : "No", inline: true },
                { name: "Position", value: role.position.toString(), inline: true },
                { name: "Members", value: role.members.size.toString(), inline: true }
            )
            .setTimestamp()
            .setFooter({ text: "Role Created" });
            return logs.send({embeds: [embed]});
    })
}