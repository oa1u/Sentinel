const moment = require("moment");
const JSONDatabase = require('../../Functions/Database');
require("moment-duration-format");
const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const { staffrole } = require("../../Config/constants/roles.json");
const { channelLog } = require("../../Config/constants/channel.json")
const { Color, serverID } = require("../../Config/constants/misc.json")

const colorInt = parseInt(Color.replace('#', ''), 16);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Warn a member')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to warn')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for the warning')
        .setRequired(true)
    ),
  category: 'moderation',
  async execute(interaction) {
    const toWarn = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason');
    const warnsDB = new JSONDatabase('warns');
    const cannedMsgs = new JSONDatabase('cannedMsgs');
    
    let Prohibited = new EmbedBuilder()
      .setColor(colorInt)
        .setTitle(`Prohibited User`)
        .setDescription(`You have to be in the moderation team to be able to use this command!`);
    
    let validuser = new EmbedBuilder()
      .setColor(colorInt)
        .setTitle(`Error`)
        .setDescription(`Mention a valid user`);
    
    let cantwarnyourself = new EmbedBuilder()
      .setColor(colorInt)
        .setTitle(`Error`)
        .setDescription(`You cant warn yourself`);
    
    let samerankorhigher = new EmbedBuilder()
      .setColor(colorInt)
        .setTitle(`Error`)
        .setDescription(`You can't warn that user due to role hierarchy`);
    
    const server = interaction.client.guilds.cache.get(serverID);
    if(!interaction.member.roles.cache.has(staffrole)) return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });
    
    const toWarnMember = await interaction.guild.members.fetch(toWarn.id).catch(() => null);
    const moderator = interaction.member;
    if (!toWarnMember) return interaction.reply({ embeds: [validuser], flags: MessageFlags.Ephemeral });
    
    warnsDB.ensure(toWarn.id, {warns: {}});
    let finalReason = cannedMsgs.has(reason) ? cannedMsgs.get(reason) : reason;
    
    if (moderator.id == toWarn.id) return interaction.reply({ embeds: [cantwarnyourself], flags: MessageFlags.Ephemeral });
    if (server.members.cache.get(moderator.id).roles.highest.rawPosition <= (server.members.cache.get(toWarn.id) ? server.members.cache.get(toWarn.id).roles.highest.rawPosition : 0)) return interaction.reply({ embeds: [samerankorhigher], flags: MessageFlags.Ephemeral });
    
    const warnLogs = server.channels.cache.get(channelLog);
    
    function makeid(length) {
      var result = '';
      var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      var charactersLength = characters.length;
      for (var i = 0; i < length; i++) {
         result += characters.charAt(Math.floor(Math.random() * charactersLength));
      }
      return result;
    }
    
    const caseID = makeid(10);
    const Server = interaction.guild.name;
    const em = new EmbedBuilder()
      .setTitle(`Case - ${caseID}`)
      .setColor(colorInt)
      .addFields(
        { name: "Member", value: `${toWarn.tag} (${toWarn.id})` },
        { name: "Moderator", value: `${moderator.user.tag} (${moderator.id})` },
        { name: "Reason", value: `\`(warned) - ${finalReason}\`` }
      )
      .setFooter({ text: `By: ${moderator.user.tag} (${moderator.id})` });
    
    await warnLogs.send({ embeds: [em] });
    
    const emUser = new EmbedBuilder()
      .setTitle("Warned")
      .setColor(colorInt)
      .setDescription(`You were warned in **${Server}** for ${finalReason}, please don't do it again!`)
      .addFields({ name: "Case ID", value: `\`${caseID}\`` });
    
    await toWarn.send({ embeds: [emUser] }).catch(err => err);
    
    const emChan = new EmbedBuilder()
      .setDescription(`You have succesfully warned **${toWarn.tag}**.`)
      .setColor(colorInt);
    
    await interaction.reply({ embeds: [emChan], flags: MessageFlags.Ephemeral });
    warnsDB.set(toWarn.id, {moderator: moderator.id, reason: `(warned) - ${finalReason}`, date: moment(Date.now()).format('LL')}, `warns.${caseID}`);
    return;
  }
}