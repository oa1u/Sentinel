const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const moment = require("moment");
require("moment-duration-format");
const { generateCaseId } = require("../../Events/caseId");
const { sendErrorReply, sendSuccessReply, createModerationEmbed } = require("../../Functions/EmbedBuilders");
const { canModerateMember, addCase, sendModerationDM, logModerationAction } = require("../../Functions/ModerationHelper");

function parseDuration(input) {
  const match = input.match(/^(\d+)([mhdw])$/i);
  if (!match) return null;
  
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  
  switch (unit) {
    case 'm': return value;
    case 'h': return value * 60;
    case 'd': return value * 1440;
    case 'w': return value * 10080;
    default: return null;
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Timeout a user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to timeout')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('duration')
        .setDescription('Duration (e.g., 10m, 2h, 1d, 1w - max 28 days)')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for the timeout')
        .setRequired(false)
    ),
  category: 'moderation',
  async execute(interaction) {
      // Acknowledge early to prevent interaction expiry during longer flows
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
      }

    const targetUser = interaction.options.getUser('user');
    const durationInput = interaction.options.getString('duration');
    const reason = interaction.options.getString('reason') || 'No reason provided';

    // Parse duration
    const duration = parseDuration(durationInput);
    if (!duration) {
      return sendErrorReply(
        interaction,
        'Invalid Duration',
        'Use valid format:\n' +
        '• **m** for minutes (e.g., `10m`)\n' +
        '• **h** for hours (e.g., `2h`)\n' +
        '• **d** for days (e.g., `1d`)\n' +
        '• **w** for weeks (e.g., `1w`)\n\n' +
        'Max: 28 days'
      );
    }

    // Discord timeout limit is 28 days (40320 minutes)
    if (duration < 1) {
      return sendErrorReply(
        interaction,
        'Invalid Duration',
        'Duration must be at least **1 minute**'
      );
    }
    
    if (duration > 40320) {
      const days = Math.floor(duration / 1440);
      return sendErrorReply(
        interaction,
        'Too Long',
        `You entered **${durationInput}** (${days} days), but max is **28 days**.\n\n` +
        'Use shorter duration (e.g., `28d`, `4w`)'
      );
    }

    // Check permissions and hierarchy
    if (!await canModerateMember(interaction, targetUser, 'timeout')) {
      return;
    }

    // Fetch member to verify they exist in guild
    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) {
      await sendErrorReply(
        interaction,
        'Invalid User',
        `**${targetUser.tag}** is not in this server!`
      );
      return;
    }

    // Check if member is already timed out
    if (targetMember.isCommunicationDisabled()) {
      await sendErrorReply(
        interaction,
        'Already Timed Out',
        `**${targetUser.tag}** is already timed out!`
      );
      return;
    }

    // Generate case ID
    const caseID = generateCaseId('TIMEOUT');

    // Calculate timeout duration in milliseconds
    const timeoutMs = duration * 60 * 1000;
    const expiresAt = Date.now() + timeoutMs;

    // Create logging embed
    const logEmbed = createModerationEmbed({
      action: '⏱️ Time Out',
      target: targetUser,
      moderator: interaction.user,
      reason: reason,
      caseId: caseID,
      color: 0xFAA61A
    }).addFields(
      { name: '⏰ Duration', value: moment.duration(duration, 'minutes').format('d[d] h[h] m[m]'), inline: true },
      { name: '📅 Expires', value: `<t:${Math.floor(expiresAt / 1000)}:R>`, inline: true }
    );

    // Send DM to user
    const dmEmbed = new EmbedBuilder()
      .setTitle('⏱️ You Have Been Timed Out')
      .setColor(0xFAA61A)
      .setDescription(`You were timed out in **${interaction.guild.name}**\n\n**⏰ Duration:** ${moment.duration(duration, 'minutes').format('d[d] h[h] m[m]')}\n**📅 Expires:** <t:${Math.floor(expiresAt / 1000)}:R>\n\n━━━━━━━━━━━━━━━━━━━━━━`)
      .addFields(
        { name: '📝 Reason', value: `\`\`\`${reason}\`\`\``, inline: false },
        { name: '🔑 Case ID', value: `\`${caseID}\``, inline: true },
        { name: '👮 Moderator', value: `${interaction.user}`, inline: true }
      )
      .setFooter({ text: '⚠️ You cannot send messages or join voice channels during this time' })
      .setTimestamp();

    const dmSent = await sendModerationDM(targetUser, dmEmbed);

    // Log the action
    await logModerationAction(interaction, logEmbed);

    // Add to database
    addCase(targetUser.id, caseID, {
      moderator: interaction.user.id,
      reason: `(timeout ${durationInput}) - ${reason}`,
      date: moment(Date.now()).format('LL'),
      type: 'TIMEOUT',
      duration: duration,
      durationString: durationInput,
      expiresAt: expiresAt
    });

    // Perform the timeout
    try {
      await targetMember.timeout(timeoutMs, reason);
      
      // Send success response
      await sendSuccessReply(
        interaction,
        '⏱️ Member Timed Out',
        `**${targetUser.tag}** has been timed out\n\n` +
        `**⏰ Duration:** ${moment.duration(duration, 'minutes').format('d[d] h[h] m[m]')}\n` +
        `**📅 Expires:** <t:${Math.floor(expiresAt / 1000)}:R>\n` +
        `**🔑 Case ID:** \`${caseID}\`\n` +
        `**📬 DM Status:** ${dmSent ? '✅ Sent' : '❌ Failed'}`
      );
    } catch (err) {
      console.error(`Error timing out ${targetUser.tag}:`, err.message);
      await sendErrorReply(
        interaction,
        'Timeout Failed',
        `Could not timeout **${targetUser.tag}**\nError: ${err.message}`
      );
    }
  }
};