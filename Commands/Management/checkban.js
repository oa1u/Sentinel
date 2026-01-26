const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags } = require('discord.js');
const JSONDatabase = require('../../Functions/Database');
const { ModRole, AdminRole } = require("../../Config/constants/roles.json");
const { Color } = require("../../Config/constants/misc.json");

const colorInt = parseInt(Color.replace('#', ''), 16);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('checkban')
    .setDescription('Check ban information using a case ID')
    .addStringOption(option =>
      option.setName('caseid')
        .setDescription('The case ID to look up')
        .setRequired(true)
    ),
  category: 'management',
  async execute(interaction) {
    const moderator = interaction.member;
    const caseID = interaction.options.getString('caseid');

    // Permission check
    if (!moderator.roles.cache.has(ModRole) && !moderator.roles.cache.has(AdminRole)) {
      const noPermEmbed = new EmbedBuilder()
        .setColor(colorInt)
        .setTitle('❌ No Permission')
        .setDescription('You must be a moderator or administrator to use this command!');
      
      return interaction.reply({ embeds: [noPermEmbed], flags: MessageFlags.Ephemeral });
    }

    const warnsDB = new JSONDatabase('warns');
    const allData = warnsDB.all();

    // Search through all users for the case ID
    let foundCase = null;
    let foundUserId = null;

    for (const [userId, userData] of Object.entries(allData)) {
      if (userData.warns && userData.warns[caseID]) {
        foundCase = userData.warns[caseID];
        foundUserId = userId;
        break;
      }
    }

    if (!foundCase) {
      const notFoundEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Case Not Found')
        .setDescription(`No ban/warn record found with case ID: \`${caseID}\``)
        .setTimestamp();
      
      return interaction.reply({ embeds: [notFoundEmbed], flags: MessageFlags.Ephemeral });
    }

    // Fetch user and moderator information
    let targetUser;
    let moderatorUser;
    
    try {
      targetUser = await interaction.client.users.fetch(foundUserId).catch(() => null);
      moderatorUser = await interaction.client.users.fetch(foundCase.moderator).catch(() => null);
    } catch (err) {
      console.error('Error fetching users:', err);
    }

    // Check if this is a ban or warn
    const isBan = foundCase.reason && foundCase.reason.includes('(banned)');
    const actionType = isBan ? '🔨 Ban' : '⚠️ Warning';
    const embedColor = isBan ? 0xF04747 : 0xFAA61A;

    // Build the embed
    const caseEmbed = new EmbedBuilder()
      .setTitle(`${actionType} - Case ${caseID}`)
      .setColor(embedColor)
      .addFields(
        { 
          name: '👤 User', 
          value: targetUser 
            ? `${targetUser.tag}\n\`${foundUserId}\`` 
            : `Unknown User\n\`${foundUserId}\``,
          inline: true 
        },
        { 
          name: '👮 Moderator', 
          value: moderatorUser 
            ? `${moderatorUser.tag}\n\`${foundCase.moderator}\`` 
            : `Unknown Moderator\n\`${foundCase.moderator}\``,
          inline: true 
        },
        { 
          name: '📅 Date', 
          value: foundCase.date || 'Unknown',
          inline: true 
        },
        { 
          name: '📝 Reason', 
          value: foundCase.reason || 'No reason provided',
          inline: false 
        }
      )
      .setFooter({ text: `Case ID: ${caseID}` })
      .setTimestamp();

    // Add user thumbnail if available
    if (targetUser) {
      caseEmbed.setThumbnail(targetUser.displayAvatarURL({ size: 128 }));
    }

    // Check current ban status
    if (isBan) {
      try {
        const banInfo = await interaction.guild.bans.fetch(foundUserId).catch(() => null);
        caseEmbed.addFields({
          name: '🔍 Current Status',
          value: banInfo ? '🔴 Currently Banned' : '🟢 No Longer Banned (Unbanned)',
          inline: true
        });
      } catch (err) {
        // User not found in bans
        caseEmbed.addFields({
          name: '🔍 Current Status',
          value: '🟢 No Longer Banned',
          inline: true
        });
      }
    }

    await interaction.reply({ embeds: [caseEmbed] });
  }
};
