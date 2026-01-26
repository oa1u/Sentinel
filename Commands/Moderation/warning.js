const moment = require("moment");
const JSONDatabase = require('../../Functions/Database');
require("moment-duration-format");
const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const { ModRole } = require("../../Config/constants/roles.json");
const { Color } = require("../../Config/constants/misc.json")

const colorInt = parseInt(Color.replace('#', ''), 16);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warning')
    .setDescription('Get information about a case')
    .addStringOption(option =>
      option.setName('caseid')
        .setDescription('Case ID')
        .setRequired(true)
    )
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User ID (optional)')
        .setRequired(false)
    ),
  category: 'moderation',
  async execute(interaction) {
    let Prohibited = new EmbedBuilder()
      .setColor(colorInt)
        .setTitle(`Prohibited User`)
        .setDescription(`You have to be in the moderation team to be able to use this command!`);
    
    // Check for ModRole permission
    if(!interaction.member.roles.cache.has(ModRole)) return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });
    
    let enabledms = new EmbedBuilder()
      .setColor(colorInt)
        .setTitle(`Error!`)
        .setDescription(`Please enable your dms with this server to that I can send you the information you requested!`);
    
    let caseidincorrect = new EmbedBuilder()
      .setColor(colorInt)
        .setTitle(`Error`)
        .setDescription(`Invalid case ID`);
    
    let warninginfo = new EmbedBuilder()
      .setColor(colorInt)
        .setTitle(`Success`)
        .setDescription(`I have sent you a dm with your requested information!`);
    
    const warnsDB = new JSONDatabase('warns');
    const caseID = interaction.options.getString('caseid');
    const userOption = interaction.options.getUser('user');
    const user = userOption || interaction.user;
    
    warnsDB.ensure(user.id, {points: 0, warns: {}});
    
    if (!warnsDB.get(user.id).warns[caseID]) return interaction.reply({ content: 'Case ID not found', flags: MessageFlags.Ephemeral });
    
    if (user.id == interaction.user.id) {
      const em = new EmbedBuilder()
        .setTitle(caseID)
        .setColor(colorInt)
        .addFields(
          { name: "Reason", value: warnsDB.get(user.id).warns[caseID].reason },
          { name: "Date", value: warnsDB.get(user.id).warns[caseID].date }
        );
      
      await interaction.user.send({ embeds: [em] }).catch(err => interaction.reply({ embeds: [enabledms], flags: MessageFlags.Ephemeral }));
      await interaction.reply({ embeds: [warninginfo], flags: MessageFlags.Ephemeral });
    } else {
      const em = new EmbedBuilder()
        .setTitle(caseID)
        .setColor(colorInt)
        .addFields(
          { name: "Reason", value: warnsDB.get(user.id).warns[caseID].reason },
          { name: "Moderator ID", value: warnsDB.get(user.id).warns[caseID].moderator },
          { name: "Date", value: warnsDB.get(user.id).warns[caseID].date }
        );
      
      await interaction.user.send({ embeds: [em] }).catch(err => interaction.reply({ embeds: [enabledms], flags: MessageFlags.Ephemeral }));
      await interaction.reply({ embeds: [warninginfo], flags: MessageFlags.Ephemeral });
    }
  }
}