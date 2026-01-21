const { EmbedBuilder } = require('discord.js');
const { Color } = require("../Config/constants/misc.json");
const { guildLog } = require("../Config/constants/channel.json");

module.exports = {
    name: "guildMemberRemove",
    runOnce: false,
    call: async (client, args) => {
        if (!args || !args[0]) return;
        const member = args[0];
        const guild = member.guild;
        const guildLogChannel = guild.channels.cache.get(guildLog);
        
        if (!guildLogChannel) return;
        
        const embed = new EmbedBuilder()
            .setColor(parseInt(Color.replace('#', ''), 16))
            .setTitle("Member Left")
            .setDescription(`${member.user.tag} (${member.id}) has left the server`)
            .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
            .addFields(
                { name: "Time in Server", value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true },
                { name: "Member Count", value: `${guild.memberCount}`, inline: true }
            )
            .setTimestamp();
        
        guildLogChannel.send({ embeds: [embed] });
    }
};





