const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const JSONDatabase = require('../../Functions/Database');
const { AdminRole } = require("../../Config/constants/roles.json");
const { channelLog } = require("../../Config/constants/channel.json")
const { Color } = require("../../Config/constants/misc.json")

const colorInt = parseInt(Color.replace('#', ''), 16);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clearwarn')
    .setDescription('Clear a warning of a user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to clear warning from')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('caseid')
        .setDescription('Case ID to clear')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(0x8),
  category: 'management',
  async execute(interaction) {
    const Prohibited = new EmbedBuilder()
      .setColor(colorInt)
      .setTitle(`Prohibited User`)
      .setDescription(`You have to be an administrator to use this command!`);
    
    if (!interaction.member.roles.cache.has(AdminRole)) {
      return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });
    }
    
    const user = interaction.options.getUser('user');
    const caseID = interaction.options.getString('caseid');
    const warnsDB = new JSONDatabase('warns');
    warnsDB.ensure(user.id, {points: 0, warns: {}});
    
    if (!warnsDB.get(user.id).warns[caseID]) {
      return interaction.reply({
        content: 'I could not find a case with this ID, please make sure you filled it in correctly.',
        flags: MessageFlags.Ephemeral
      });
    }
    const casePoints = warnsDB.get(user.id).warns[caseID].points;
    const caseReason = warnsDB.get(user.id).warns[caseID].reason;
    const newPoints = warnsDB.get(user.id).points - casePoints;
    warnsDB.delete(user.id, `warns.${caseID}`);
    warnsDB.set(user.id, newPoints, 'points');
    const userBanned = warnsDB.get(user.id).points < 5;
    if (userBanned) {
      await interaction.guild.members.unban(user.id, `${interaction.user.tag} - warnings cleared`).catch(err => {
        console.error('Error unbanning user:', err);
      });
    }
    const clearedWarnsLog = interaction.client.channels.cache.get(channelLog);
    const em = new EmbedBuilder()
    .setTitle("Warning cleared")
    .setColor(colorInt)
    .addFields(
      { name: "Administrator", value: `${interaction.user.tag} (${interaction.user.id})` },
      { name: "User", value: `${user.tag} (${user.id})` },
      { name: "Case ID", value: `\`${caseID}\`` },
      { name: "Case Points", value: `\`${parseInt(casePoints).toLocaleString()}\`` },
      { name: "Case Reason", value: `\`${caseReason}\`` },
      { name: "Unbanned?", value: userBanned ? 'Yes' : 'No' }
    )
    .setFooter({ text: `By: ${interaction.user.tag}` })
    if (clearedWarnsLog) await clearedWarnsLog.send({ embeds: [em] });
    return interaction.reply({
      content: `I have successfully cleared warning **${caseID}** from **${user.tag}**!`,
      flags: MessageFlags.Ephemeral
    });
  }
}