const { EmbedBuilder } = require('discord.js');
const { serverLogChannelId } = require("../Config/constants/channel.json");

// Log when roles are created — include role settings and current member count.
module.exports = (client) => {
    client.on("roleCreate", async (role) => {
        const logs = client.channels.cache.get(serverLogChannelId);
        if (!logs) return;
        const embed = new EmbedBuilder()
            .setTitle("🏷️ Role Created")
            .setColor(role.hexColor !== "#000000" ? parseInt(role.hexColor.replace('#', ''), 16) : 0x43B581)
            .setDescription(`New role created.`)
            .addFields(
                { name: "Role", value: role.toString(), inline: true },
                { name: "Role ID", value: `\`${role.id}\``, inline: true },
                { name: "Role Color", value: `${role.hexColor}`, inline: true },
                { name: "Hoisted", value: role.hoist ? "Yes (Displayed separately)" : "No", inline: true },
                { name: "Mentionable", value: role.mentionable ? "Yes" : "No", inline: true },
                { name: "Position", value: role.position.toString(), inline: true },
                { name: "Members", value: role.members.size.toString(), inline: true } // How many people have this role already
            )
            .setTimestamp()
            .setFooter({ text: "Role Created" });
        return logs.send({ embeds: [embed] });
    })
}