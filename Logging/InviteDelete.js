const { EmbedBuilder } = require('discord.js');
const { serverLogChannelId } = require("../Config/constants/channel.json");

module.exports = (client) => {
	client.on("inviteDelete", async(invite) => {
    const logs = client.channels.cache.get(serverLogChannelId);
    if (!logs) return;
        const embed = new EmbedBuilder()
            .setTitle("🗑️ Invite Deleted")
            .setColor("#F04747")
            .setDescription(`Invite deleted.`);
            const fields = [
                { name: "Invite Code", value: `\`${invite.code}\``, inline: true },
                { name: "Invite URL", value: `\`${invite.url}\``, inline: true },
                { name: "Channel", value: invite.channel ? invite.channel.toString() : "Unknown", inline: true }
            ];
  			if(invite.uses){
                fields.push({ name: "Total Uses", value: invite.uses.toString(), inline: true });
            }
        	if(invite.inviter){
                fields.push({ name: "Created By", value: `${invite.inviter.tag} (\`${invite.inviter.id}\`)` });
                embed.setThumbnail(invite.inviter.displayAvatarURL({ size: 128 }));
            }
            embed.addFields(fields);
            embed.setTimestamp().setFooter({ text: "Invite Deleted" });
            return logs.send({embeds: [embed]});
    })
}