const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const moment = require("moment");
const JSONDatabase = require('../../Functions/Database');
require("moment-duration-format");
const { ModRole } = require("../../Config/constants/roles.json");
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
      .setColor(0xF04747)
      .setTitle(`❌ No Permission`)
      .setDescription(`You need the Moderator role to use this command!`);

    let validuser = new EmbedBuilder()
      .setColor(0xF04747)
      .setTitle(`❌ Invalid User`)
      .setDescription(`Please mention a valid user!`);

    let cantbanyourself = new EmbedBuilder()
      .setColor(0xF04747)
      .setTitle(`❌ Error`)
      .setDescription(`You can't ban yourself!`);

    let samerankorhigher = new EmbedBuilder()
      .setColor(0xF04747)
      .setTitle(`❌ Role Hierarchy`)
      .setDescription(`You can't ban that user due to role hierarchy!`);

    const warnsDB = new JSONDatabase('warns');
    
    if (!moderator.roles.cache.has(ModRole)) {
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
      .setTitle(`🔨 Ban Case - ${caseID}`)
      .setColor(0xF04747)
      .addFields(
        { name: "👤 Member", value: `${toWarn.username} (${toWarn.id})`, inline: true },
        { name: "🛡️ Moderator", value: `${moderator.user.username} (${moderator.id})`, inline: true },
        { name: "📝 Reason", value: `\`${reason}\``, inline: false }
      )
      .setFooter({ text: `Banned by ${moderator.user.username}` })
      .setTimestamp();

    if (warnLogs) await warnLogs.send({ embeds: [em] });

    const emUser = new EmbedBuilder()
      .setTitle("🔨 You Have Been Banned")
      .setColor(0xF04747)
      .setDescription(`You were banned from **${server.name}**`)
      .addFields(
        { name: "📝 Reason", value: `${reason}` },
        { name: "🔑 Case ID", value: `\`${caseID}\`` },
        { name: "📬 Ban Appeal", value: "[Join Appeal Server]()" }
      )
      .setTimestamp();

    await toWarn.send({ embeds: [emUser] }).catch(err => console.error(err));

    const emChan = new EmbedBuilder()
      .setTitle("✅ Member Banned")
      .setDescription(`Successfully banned **${toWarn.username}**`)
      .setColor(0x43B581)
      .addFields(
        { name: "🔑 Case ID", value: `\`${caseID}\`` }
      )
      .setTimestamp()
      .setTimestamp();

    await interaction.reply({ embeds: [emChan], flags: MessageFlags.Ephemeral });

    // Store ban information in database
    const userData = warnsDB.get(toWarn.id) || { warns: {} };
    if (!userData.warns) userData.warns = {};
    userData.warns[caseID] = {
      moderator: moderator.id,
      reason: `(banned) - ${reason}`,
      date: moment(Date.now()).format('LL')
    };
    warnsDB.set(toWarn.id, userData);
    
    // Perform the ban after replying, with error handling
    try {
      await server.members.ban(toWarn, { reason: reason });
    } catch (err) {
      console.error(`Error banning ${toWarn.username}:`, err);
    }
  }
};