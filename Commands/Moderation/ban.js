const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const moment = require("moment");
const JSONDatabase = require('../../Functions/Database');
require("moment-duration-format");
const { staffrole } = require("../../Config/constants/roles.json");
const { channelLog } = require("../../Config/constants/channel.json");
const { Color } = require("../../Config/constants/misc.json");

const colorInt = parseInt(Color.replace('#', ''), 16);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a user from the server')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to ban')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for the ban')
        .setRequired(false)
    ),
  category: 'moderation',
  async execute(interaction) {
    const client = interaction.client;
    const toWarn = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const moderator = interaction.member;
    const server = interaction.guild;

    let Prohibited = new EmbedBuilder()
      .setColor(colorInt)
      .setTitle(`Prohibited User`)
      .setDescription(`You have to be in the moderation team to be able to use this command!`);

    let validuser = new EmbedBuilder()
      .setColor(colorInt)
      .setTitle(`Error`)
      .setDescription(`Mention a valid user`);

    let cantbanyourself = new EmbedBuilder()
      .setColor(colorInt)
      .setTitle(`Error`)
      .setDescription(`You can't ban yourself`);

    let samerankorhigher = new EmbedBuilder()
      .setColor(colorInt)
      .setTitle(`Error`)
      .setDescription(`You can't ban that user due to role hierarchy`);

    const warnsDB = new JSONDatabase('warns');
    
    if (!moderator.roles.cache.has(staffrole)) {
      return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });
    }

    if (!toWarn) {
      return interaction.reply({ embeds: [validuser], flags: MessageFlags.Ephemeral });
    }

    warnsDB.ensure(toWarn.id, { warns: {} });

    if (moderator.id == toWarn.id) {
      return interaction.reply({ content: "You may not ban yourself!", flags: MessageFlags.Ephemeral });
    }

    const targetMember = await server.members.fetch(toWarn.id).catch(() => null);
    if (targetMember && moderator.roles.highest.rawPosition <= targetMember.roles.highest.rawPosition) {
      return interaction.reply({ embeds: [samerankorhigher], flags: MessageFlags.Ephemeral });
    }

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
    const warnLogs = server.channels.cache.get(channelLog);

    const em = new EmbedBuilder()
      .setTitle(`Case - ${caseID}`)
      .setColor(colorInt)
      .addFields(
        { name: "Member", value: `${toWarn.tag} (${toWarn.id})` },
        { name: "Moderator", value: `${moderator.user.tag} (${moderator.id})` },
        { name: "Reason", value: `\`(banned) - ${reason}\`` }
      )
      .setFooter({ text: `By: ${moderator.user.tag} (${moderator.id})` })
      .setTimestamp();

    if (warnLogs) await warnLogs.send({ embeds: [em] });

    const emUser = new EmbedBuilder()
      .setTitle("Banned")
      .setColor(colorInt)
      .setDescription(`You were banned from **${server.name}** for ${reason}!`)
      .addFields(
        { name: "Case ID", value: `\`${caseID}\`` },
        { name: "Ban Appeal Server", value: "[Join]()" }
      )
      .setTimestamp();

    await toWarn.send({ embeds: [emUser] }).catch(err => console.error(err));

    const emChan = new EmbedBuilder()
      .setDescription(`You have successfully banned **${toWarn.tag}**.`)
      .setColor(colorInt)
      .setTimestamp();

    await interaction.reply({ embeds: [emChan], flags: MessageFlags.Ephemeral });

    warnsDB.set(toWarn.id, { moderator: moderator.id, reason: `(banned) - ${reason}`, date: moment(Date.now()).format('LL') }, `warns.${caseID}`);
    
    // Perform the ban after replying, with error handling
    try {
      await server.members.ban(toWarn, { reason: reason });
    } catch (err) {
      console.error(`Error banning ${toWarn.tag}:`, err);
    }
  }
};