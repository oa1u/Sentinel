const moment = require("moment");
const JSONDatabase = require('../../Functions/Database');
require("moment-duration-format");
const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const { ModRole } = require("../../Config/constants/roles.json");
const { channelLog } = require("../../Config/constants/channel.json")
const { serverID } = require("../../Config/constants/misc.json")


module.exports = {
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a member')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to kick')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for the kick')
        .setRequired(true)
    ),
  category: 'moderation',
  async execute(interaction) {
    const toWarn = interaction.options.getUser('user');
    const toWarnMember = await interaction.guild.members.fetch(toWarn.id);
    const reason = interaction.options.getString('reason');
    const warnsDB = new JSONDatabase('warns');
    const cannedMsgs = new JSONDatabase('cannedMsgs');
    
    let Prohibited = new EmbedBuilder()
      .setColor(0xF04747)
        .setTitle(`❌ No Permission`)
        .setDescription(`You need the Moderator role to use this command!`);
    
    let validuser = new EmbedBuilder()
      .setColor(0xF04747)
        .setTitle(`❌ Invalid User`)
        .setDescription(`Please mention a valid user!`);
    
    let cantkickyourself = new EmbedBuilder()
      .setColor(0xF04747)
        .setTitle(`❌ Error`)
        .setDescription(`You cannot kick yourself!`);
    
    let samerankorhigher = new EmbedBuilder()
      .setColor(0xF04747)
        .setTitle(`❌ Role Hierarchy`)
        .setDescription(`You cannot kick that user due to role hierarchy!`);
    
    const server = interaction.client.guilds.cache.get(serverID);
    if(!interaction.member.roles.cache.has(ModRole)) return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });
    
    if (!toWarnMember) return interaction.reply({ embeds: [validuser], flags: MessageFlags.Ephemeral });
    
    warnsDB.ensure(toWarn.id, {warns: {}});
    let finalReason = cannedMsgs.has(reason) ? cannedMsgs.get(reason) : reason;
    
    if (interaction.member.id == toWarn.id) return interaction.reply({ embeds: [cantkickyourself], flags: MessageFlags.Ephemeral });
    if (server.members.cache.get(interaction.member.id).roles.highest.rawPosition <= (server.members.cache.get(toWarn.id) ? server.members.cache.get(toWarn.id).roles.highest.rawPosition : 0)) return interaction.reply({ embeds: [samerankorhigher], flags: MessageFlags.Ephemeral });
    
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
    const em = new EmbedBuilder()
      .setTitle(`👢 Kick Case - ${caseID}`)
      .setColor(0xFAA61A)
      .addFields(
        { name: "👤 Member", value: `${toWarn.tag} (${toWarn.id})`, inline: true },
        { name: "🛡️ Moderator", value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
        { name: "📝 Reason", value: `\`${finalReason}\``, inline: false }
      )
      .setFooter({ text: `Kicked by ${interaction.user.tag}` })
      .setTimestamp();
    
    await warnLogs.send({ embeds: [em] });
    
    const Server = interaction.guild.name;
    const emUser = new EmbedBuilder()
      .setTitle("👢 You Have Been Kicked")
      .setColor(0xFAA61A)
      .setDescription(`You were kicked from **${Server}**`)
      .addFields(
        { name: "📝 Reason", value: `${finalReason}` },
        { name: "🔑 Case ID", value: `\`${caseID}\`` },
        { name: "⚡ Note", value: "Please avoid repeating this behavior!" }
      )
      .setTimestamp();
    
    await toWarn.send({ embeds: [emUser] }).catch(err => err);
    
    const emChan = new EmbedBuilder()
      .setTitle("✅ Member Kicked")
      .setDescription(`Successfully kicked **${toWarn.tag}**`)
      .setColor(0x43B581)
      .addFields(
        { name: "🔑 Case ID", value: `\`${caseID}\`` }
      )
      .setTimestamp();
    
    // Perform the kick before replying
    await toWarnMember.kick(finalReason).catch(err => {
      console.error(`Error kicking ${toWarn.tag}:`, err);
    });
    
    warnsDB.set(toWarn.id, {moderator: interaction.user.id, reason: `(kicked) - ${finalReason}`, date: moment(Date.now()).format('LL')}, `warns.${caseID}`);
    
    return await interaction.reply({ embeds: [emChan], flags: MessageFlags.Ephemeral });
  }
}