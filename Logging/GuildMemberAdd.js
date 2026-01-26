const { EmbedBuilder } = require('discord.js');
const { channelLog } = require("../Config/constants/channel.json")

module.exports = (client) => {
	client.on("guildMemberAdd", async(member) => {
    let logs = await client.channels.cache.get(channelLog);
        const accountAge = Math.floor((Date.now() - member.user.createdTimestamp) / (1000 * 60 * 60 * 24));
        const memberCount = member.guild.memberCount;
        	let embed = new EmbedBuilder()
            .setTitle("📥 Member Joined")
            .setColor("#43B581")
            .setDescription(`${member.user.toString()} has joined the server!`)
            .addFields(
                { name: "User", value: `${member.user.tag}`, inline: true },
                { name: "User ID", value: `\`${member.id}\``, inline: true },
                { name: "Bot Account", value: member.user.bot ? "Yes" : "No", inline: true },
                { name: "Account Created", value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>\n<t:${Math.floor(member.user.createdTimestamp / 1000)}:F>`, inline: true },
                { name: "Account Age", value: `${accountAge} days old`, inline: true },
                { name: "Member Count", value: `${memberCount}`, inline: true }
            )
            .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
            .setTimestamp()
            .setFooter({ text: `Member Joined • ID: ${member.id}` });
            return logs.send({embeds: [embed]});
    })
}