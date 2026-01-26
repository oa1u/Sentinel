const { EmbedBuilder } = require('discord.js');
const { channelLog } = require("../Config/constants/channel.json")

module.exports = (client) => {
	client.on("guildMemberRemove", async(member) => {
    let logs = await client.channels.cache.get(channelLog);
        const memberCount = member.guild.memberCount;
        const joinDuration = member.joinedTimestamp ? Math.floor((Date.now() - member.joinedTimestamp) / (1000 * 60 * 60 * 24)) : "Unknown";
        const roles = member.roles.cache
            .filter(role => role.id !== member.guild.id)
            .map(role => role.name)
            .join(", ") || "None";
        	let embed = new EmbedBuilder()
            .setTitle("📤 Member Left")
            .setColor("#F04747")
            .setDescription(`${member.user.toString()} has left the server.`)
            .addFields(
                { name: "User", value: `${member.user.tag}`, inline: true },
                { name: "User ID", value: `\`${member.id}\``, inline: true },
                { name: "Bot Account", value: member.user.bot ? "Yes" : "No", inline: true },
                { name: "Account Created", value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
                { name: "Time in Server", value: joinDuration !== "Unknown" ? `${joinDuration} days` : "Unknown", inline: true },
                { name: "Member Count", value: `${memberCount}`, inline: true }
            )
            .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
            .setTimestamp()
            .setFooter({ text: `Member Left • ID: ${member.id}` });
            if(roles.length < 1000) embed.addFields({ name: "Roles", value: roles });
            return logs.send({embeds: [embed]});
    })
}