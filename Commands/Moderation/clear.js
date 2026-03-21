const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const { sendErrorReply, sendWarningReply, sendInfoReply } = require("../../Functions/EmbedBuilders");
const { logModerationAction } = require("../../Functions/ModerationHelper");

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear a certain amount of messages from the channel')
    .addIntegerOption(option =>
      option.setName('amount')
        .setDescription('Amount of messages to delete (1-100)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100)
    )
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for clearing messages')
        .setRequired(true)
    )
    .addUserOption(option =>
      option.setName('user')
        .setDescription('Only delete messages from this specific user')
        .setRequired(false)
    ),
  category: "moderation",
  async execute(interaction) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
    }

    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      await sendWarningReply(
        interaction,
        'No Permission',
        'You need **Manage Messages** permission!'
      );
      return;
    }

    const amount = interaction.options.getInteger('amount');
    const reason = interaction.options.getString('reason');
    const targetUser = interaction.options.getUser('user');

    try {
      const messages = await interaction.channel.messages.fetch({ limit: amount });

      let toDelete = targetUser
        ? messages.filter(msg => msg.author.id === targetUser.id)
        : messages;

      const twoWeeksAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
      toDelete = toDelete.filter(msg => msg.createdTimestamp > twoWeeksAgo);

      if (toDelete.size === 0) {
        await sendInfoReply(
          interaction,
          'Clear Failed',
          'No messages to delete.\n\n**Note:** Messages older than 2 weeks can\'t be bulk deleted.'
        );
        return;
      }

      const deleted = await interaction.channel.bulkDelete(toDelete, true);

      const logFields = [
        { name: '📊 Messages Deleted', value: `**${deleted.size}**`, inline: true },
        { name: '🧰 Scope', value: targetUser ? 'Targeted user messages' : 'Recent channel messages', inline: true },
        { name: '📝 Requested Amount', value: `**${amount}**`, inline: true },
        { name: '💬 Reason', value: `\`\`\`${reason}\`\`\``, inline: false }
      ];

      if (targetUser) {
        logFields.push({ name: '🎯 Target User', value: `${targetUser.tag}\n\`${targetUser.id}\``, inline: false });
      }

      const logEmbed = new EmbedBuilder()
        .setColor(0x43B581)
        .setTitle('🧹 Messages Cleared')
        .setDescription('Bulk message cleanup action completed.')
        .addFields(...logFields)
        .setFooter({ text: `Logged at ${new Date().toLocaleTimeString()}` })
        .setTimestamp();

      await logModerationAction(interaction, logEmbed);

      const fields = [
        { name: '📊 Messages Deleted', value: `**${deleted.size}**`, inline: true },
        { name: '📍 Channel', value: `${interaction.channel}`, inline: true },
        { name: '👤 Moderator', value: `${interaction.user}`, inline: true },
        { name: '💬 Reason', value: `\`\`\`${reason}\`\`\``, inline: false }
      ];

      if (targetUser) {
        fields.push({ name: '🎯 Target User', value: `${targetUser.tag}\n\`${targetUser.id}\``, inline: false });
      }

      const successEmbed = new EmbedBuilder()
        .setColor(0x43B581)
        .setTitle('🧹 Messages cleared')
        .setDescription(`━━━━━━━━━━━━━━━━━━━━━`)
        .addFields(...fields)
        .setFooter({ text: `Action performed by ${interaction.user.username}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [successEmbed] });
    } catch (err) {
      console.error(`Error clearing messages:`, err);

      let errorMessage = 'Could not clear messages.';

      if (err.message.includes('Missing Permissions')) {
        errorMessage = 'I don\'t have permission to delete messages in this channel.';
      } else if (err.message.includes('50016')) {
        errorMessage = 'The target message ID is invalid. This may happen if messages were already deleted.';
      } else if (err.code === 50013) {
        errorMessage = 'Missing permissions to perform this action.';
      } else if (err.message) {
        errorMessage = `Error: ${err.message}`;
      }

      await sendErrorReply(
        interaction,
        'Clear Failed',
        errorMessage
      );
    }
  }
};