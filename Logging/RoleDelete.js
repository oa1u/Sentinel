const { EmbedBuilder } = require('discord.js');
const { serverLogChannelId } = require("../Config/constants/channel.json");

module.exports = (client) => {
	client.on("roleDelete", async(role) => {
    const logs = client.channels.cache.get(serverLogChannelId);
    if (!logs) return;
        const embed = new EmbedBuilder()
            .setTitle("🗑️ Role Deleted")
            .setColor(role.hexColor !== "#000000" ? parseInt(role.hexColor.replace('#', ''), 16) : 0xF04747)
            .setDescription(`Role deleted from server.`)
            .addFields(
                { name: "Role Name", value: `@${role.name}`, inline: true },
                { name: "Role ID", value: `\`${role.id}\``, inline: true },
                { name: "Role Color", value: `${role.hexColor}`, inline: true },
                { name: "Was Hoisted", value: role.hoist ? "Yes (Displayed separately)" : "No", inline: true },
                { name: "Was Mentionable", value: role.mentionable ? "Yes" : "No", inline: true },
                { name: "Position", value: role.position.toString(), inline: true },
                { name: "Members Had This Role", value: role.members.size.toString(), inline: true }
            )
            .setTimestamp()
            .setFooter({ text: "Role Deleted" });
            return logs.send({embeds: [embed]});
    })
}