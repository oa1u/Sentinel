const { EmbedBuilder } = require('discord.js');
const { Color } = require("../Config/constants/misc.json");
const { guildLog } = require("../Config/constants/channel.json");

module.exports = {
    name: "guildMemberUpdate",
    runOnce: false,
    call: async (client, args) => {
        if (!args || args.length < 2) return;
        const oldMember = args[0];
        const newMember = args[1];
        
        if (oldMember.roles.cache.size === newMember.roles.cache.size) return;
        
        const guild = newMember.guild;
        const guildLogChannel = guild.channels.cache.get(guildLog);
        
        if (!guildLogChannel) return;
        
        let action = 'Role Added';
        let role = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id)).first();
        
        if (!role) {
            action = 'Role Removed';
            role = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id)).first();
        }
        
        if (!role) return;
        
        const embed = new EmbedBuilder()
            .setColor(parseInt(Color.replace('#', ''), 16))
            .setTitle(action)
            .setDescription(`${newMember.user.tag} (${newMember.id})`)
            .addFields(
                { name: "Role", value: `${role}`, inline: true }
            )
            .setTimestamp();
        
        guildLogChannel.send({ embeds: [embed] });
    }
};



