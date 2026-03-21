const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { ROLES: { administratorRoleId }, CHANNELS: { rulesChannelId } } = require("../../Config/constants");
const fs = require('fs');
const path = require('path');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rules')
    .setDescription('Post server rules to the rules channel'),

  async execute(interaction) {
    const Prohibited = new EmbedBuilder()
      .setColor(0xF04747)
      .setTitle(`❌ No Permission`)
      .setDescription(`You need the Administrator role to use this command!`);

    if (!interaction.member.roles.cache.has(administratorRoleId)) {
      return interaction.reply({ embeds: [Prohibited], flags: MessageFlags.Ephemeral });
    }

    try {
      const rulesPath = path.join(__dirname, '../../Config/constants/rules.json');
      const rulesConfig = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
      const rules = rulesConfig.rules;

      if (!rules || rules.length === 0) {
        const NoRules = new EmbedBuilder()
          .setColor(0xF04747)
          .setTitle('❌ Error')
          .setDescription('No rules found in the configuration file.');

        return interaction.reply({ embeds: [NoRules], flags: MessageFlags.Ephemeral });
      }

      const rulesChannel = await interaction.guild.channels.fetch(rulesChannelId).catch(() => null);

      if (!rulesChannel) {
        const NoChannel = new EmbedBuilder()
          .setColor(0xF04747)
          .setTitle('❌ Error')
          .setDescription('Rules channel not found. Please check the configuration.');

        return interaction.reply({ embeds: [NoChannel], flags: MessageFlags.Ephemeral });
      }

      const rulesEmbeds = [];

      const titleEmbed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('📋 Server Rules')
        .setDescription(`Welcome to our server! Please read and follow these ${rules.length} rules to maintain a positive community.`)
        .setFooter({ text: 'Last Updated: ' + new Date().toLocaleDateString() });

      rulesEmbeds.push(titleEmbed);

      const rulesEmbed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setFooter({ text: 'Server Rules' });

      for (const rule of rules) {
        rulesEmbed.addFields({
          name: `Rule ${rule.number}: ${rule.title}`,
          value: rule.description,
          inline: false
        });
      }

      rulesEmbeds.push(rulesEmbed);

      await rulesChannel.send({ embeds: rulesEmbeds });

      const Success = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('✅ Success')
        .setDescription(`Server rules have been posted to <#${rulesChannelId}>!`);

      return interaction.reply({ embeds: [Success], flags: MessageFlags.Ephemeral });

    } catch (error) {
      console.error('Error in rules command:', error);

      const ErrorEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Error')
        .setDescription('An error occurred while posting the rules. Please check the logs.');

      return interaction.reply({ embeds: [ErrorEmbed], flags: MessageFlags.Ephemeral });
    }
  },
};