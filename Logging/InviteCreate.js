const { EmbedBuilder } = require('discord.js');
const { channelLog } = require("../Config/constants/channel.json")

module.exports = (client) => {
	client.on("inviteCreate", async(invite) => {
    let logs = await client.channels.cache.get(channelLog);
        	let embed = new EmbedBuilder()
            .setTitle("🔗 Invite Created")
            .setColor("#43B581")
            .setDescription(`A new server invite has been created.`)
            const fields = [
                { name: "Invite Code", value: `\`${invite.code}\``, inline: true },
                { name: "Invite URL", value: `[Click Here](${invite.url})`, inline: true },
                { name: "Channel", value: invite.channel.toString(), inline: true },
                { name: "Max Uses", value: invite.maxUses ? invite.maxUses.toString() : "Unlimited", inline: true },
                { name: "Max Age", value: invite.maxAge ? `${Math.floor(invite.maxAge / 3600)} hours` : "Never", inline: true },
                { name: "Temporary", value: invite.temporary ? "Yes" : "No", inline: true }
            ];
            if(invite.expiresAt){
                fields.push({ name: "Expires", value: `<t:${Math.floor(invite.expiresAt.getTime() / 1000)}:R>` });
            }
        	if(invite.inviter){
                fields.push({ name: "Created By", value: `${invite.inviter.tag} (\`${invite.inviter.id}\`)` });
                embed.setThumbnail(invite.inviter.displayAvatarURL({ size: 128 }));
            }
            embed.addFields(fields);
            embed.setTimestamp().setFooter({ text: "Invite Created" });
            return logs.send({embeds: [embed]});
    })
}