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
    .setName('warns')
    .setDescription('Get a list of cases')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User (optional)')
        .setRequired(false)
    ),
  category: 'moderation',
  async execute(interaction) {
    let Prohibited = new EmbedBuilder()
      .setColor(colorInt)
        .setTitle(`Prohibited User`)
        .setDescription(`You have to be in the moderation team to look at other people's warnings`);
    
    // Check for ModRole permission
    if(!interaction.member.roles.cache.has(ModRole)) return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });
    
    let enabledms = new EmbedBuilder()
      .setColor(colorInt)
        .setTitle(`Error!`)
        .setDescription(`Please enable your dms with this server to that I can send you the information you requested!`);
    
    const warnsDB = new JSONDatabase('warns');
    const userOption = interaction.options.getUser('user');
    const user = userOption ? await interaction.guild.members.fetch(userOption.id).catch(() => null) : interaction.member;
    
    warnsDB.ensure(user.id, {points: 0, warns: {}});
    
    if (user.id == interaction.user.id) {
      const em = new EmbedBuilder()
        .setTitle("Warnings")
        .setColor(colorInt)
        .setDescription(`\`${Object.keys(warnsDB.get(user.id).warns).length != 0 ? Object.keys(warnsDB.get(user.id).warns).join('\n') : 'You have not been warned before'}\``);
      
      await interaction.user.send({ embeds: [em] }).catch(err => interaction.reply({ embeds: [enabledms], flags: MessageFlags.Ephemeral }));
      await interaction.reply({ content: 'I have sent you a dm with your requested information!', flags: MessageFlags.Ephemeral });
    } else {
      const em = new EmbedBuilder()
        .setTitle("Warnings")
        .setColor(colorInt)
        .setDescription(`\`${Object.keys(warnsDB.get(user.id).warns).length != 0 ? Object.keys(warnsDB.get(user.id).warns).join('\n') : 'User has not been warned before'}\``);
      
      await interaction.user.send({ embeds: [em] }).catch(err => interaction.reply({ embeds: [enabledms], flags: MessageFlags.Ephemeral }));
      await interaction.reply({ content: 'I have sent you a dm with your requested information!', flags: MessageFlags.Ephemeral });
    }
  }
}