const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { CaptchaGenerator } = require("captcha-canvas");
const { sendErrorReply } = require('../../Functions/EmbedBuilders');
const { recordVerificationEvent } = require('../../Functions/VerificationAnalytics');
const {
  canStartVerification,
  createVerificationSession,
  registerVerificationFailure,
  registerVerificationSuccess
} = require('../../Functions/VerificationSessionManager');
const { ROLES: { verifiedRoleId, administratorRoleId }, CHANNELS: { verificationChannelId, captchaLogChannelId } } = require("../../Config/constants");
const {
  getVerificationRuntimeConfig,
  shouldUseStrictMode,
  createStepTwoChallenge,
  collectExpectedResponse
} = require('../../Functions/VerificationFlowHelper');

const {
  challengeTimeoutMs: CHALLENGE_TIMEOUT,
  maxWrongAttemptsPerStep: MAX_WRONG_ATTEMPTS_PER_STEP
} = getVerificationRuntimeConfig();

function getRoleAssignmentIssue(member, roleObj) {
  if (!member || !roleObj || !member.guild) return 'Missing member or role context.';

  const me = member.guild.members.me;
  if (!me) return 'Bot member object is unavailable in this guild.';

  if (!me.permissions.has('ManageRoles')) {
    return 'Bot is missing the Manage Roles permission.';
  }

  if (roleObj.managed) {
    return 'Target role is managed by an integration and cannot be assigned manually.';
  }

  if (me.roles.highest.position <= roleObj.position) {
    return `Verified role (${roleObj.name}) is higher than or equal to the bot's highest role (${me.roles.highest.name}).`;
  }

  if (!member.manageable) {
    return 'Bot cannot manage this member due to role hierarchy or ownership restrictions.';
  }

  return null;
}

async function safeReply(interaction, payload) {
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(payload);
  }
  return interaction.reply(payload);
}

async function sendChallengeImage(channel, embed, captchaBuffer) {
  const captchaAttachment = new AttachmentBuilder(captchaBuffer, { name: 'captcha.png' });
  const challengeEmbed = new EmbedBuilder(embed).setImage('attachment://captcha.png');
  await channel.send({ embeds: [challengeEmbed], files: [captchaAttachment] });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Verify yourself by completing a multi-step anti-bot check'),
  category: 'verification',
  async execute(interaction) {
    if (interaction.channelId !== verificationChannelId) {
      return sendErrorReply(
        interaction,
        'Wrong Channel',
        'This command can only be used in the verification channel.'
      );
    }

    const member = interaction.member;
    const userId = interaction.user.id;
    const captchachannel = interaction.client.channels.cache.get(captchaLogChannelId);
    const verifyChannel = interaction.channel;
    const verificationStartedAt = Date.now();
    let verificationMode = 'dm';
    const strictMode = shouldUseStrictMode(interaction.user.createdTimestamp);

    const penaltyCheck = canStartVerification(userId);
    if (!penaltyCheck.allowed) {
      const seconds = Math.max(1, Math.ceil(penaltyCheck.remainingMs / 1000));
      return sendErrorReply(
        interaction,
        'Cooldown Active',
        `You must wait ${seconds}s before trying verification again.`
      );
    }

    if (!member || !member.guild) {
      return sendErrorReply(
        interaction,
        'Error',
        'Could not verify your membership in the server.'
      );
    }

    if (member.roles.cache.has(verifiedRoleId)) {
      const alreadyVerifiedEmbed = new EmbedBuilder()
        .setColor(0x43B581)
        .setTitle('✅ Already Verified')
        .setDescription('Your account has already been verified.')
        .addFields(
          { name: 'Status', value: '**Verified** ✓\n\nYou have full access to all server channels and features.', inline: false },
          { name: 'What This Means', value: '• Access to all public channels\n• Ability to send messages\n• View member list\n• Participate in voice\n• Use bot commands', inline: false },
          { name: 'Need Help?', value: 'If you believe this is an error, contact the server admins.', inline: false }
        );

      return interaction.reply({
        embeds: [alreadyVerifiedEmbed],
        flags: 64
      });
    }

    const session = createVerificationSession({
      userId,
      guildId: member.guild.id,
      source: 'slash_verify'
    });

    if (!session?.sessionId) {
      return sendErrorReply(
        interaction,
        'Verification Error',
        'Could not create a verification session. Please try again.'
      );
    }

    const applyFailurePenalty = async (reason, challengeType = null) => {
      const penalty = registerVerificationFailure(userId);
      await recordVerificationEvent({
        type: 'penalty_applied',
        userId,
        username: interaction.user.tag,
        guildId: member.guild.id,
        guildName: member.guild.name,
        mode: verificationMode,
        challengeType,
        reason: `${reason} | cooldown=${penalty.cooldownMs}ms | streak=${penalty.streak}`
      }).catch(() => { });
    };

    await recordVerificationEvent({
      type: 'session_started',
      userId,
      username: interaction.user.tag,
      guildId: member.guild.id,
      guildName: member.guild.name,
      mode: verificationMode,
      reason: `sessionId=${session.sessionId}`
    }).catch(() => { });

    const captcha = new CaptchaGenerator()
      .setDimension(600, 600)
      .setCaptcha({
        text: Math.random().toString(36).substring(2, 8).toUpperCase(),
        size: 70,
        color: "#32CD32"
      })
      .setDecoy({ opacity: 0.2 })
      .setTrace({ color: "#32CD32", size: 2 });

    const captchaBuffer = await captcha.generate();
    const captchaCode = captcha.text;

    console.log(`Generated captcha for ${member.user.tag}: ${captchaCode}`);

    if (!captchachannel) {
      return sendErrorReply(
        interaction,
        'System Error',
        `Verification system is not configured. Please contact an <@&${administratorRoleId}>.`
      );
    }

    try {
      const captchaAttachment = new AttachmentBuilder(captchaBuffer, { name: "captcha.png" });
      const captchaEmbed = new EmbedBuilder()
        .setTitle("🧩 Captcha Generated")
        .setDescription(`Captcha generated for ${member.user.tag}`)
        .setImage(`attachment://captcha.png`)
        .setColor(0x5865F2)
        .setFooter({ text: `${member.guild.name} • Verification System` });
      await captchachannel.send({ embeds: [captchaEmbed], files: [captchaAttachment] });

      const Server = member.guild.name;
      const stepTwo = createStepTwoChallenge({ strictMode });

      await recordVerificationEvent({
        type: 'multi_step_issued',
        userId,
        username: interaction.user.tag,
        guildId: member.guild.id,
        guildName: member.guild.name,
        mode: verificationMode,
        challengeType: stepTwo.type,
        reason: `strictMode=${strictMode}`
      }).catch(() => { });

      const e0 = new EmbedBuilder()
        .setTitle(`🔐 Server Verification`)
        .setColor(0x5865F2)
        .setFooter({ text: `${member.guild.name} • Verification System` });

      const e1 = new EmbedBuilder(e0)
        .setDescription(`Welcome to **${Server}**!\n\nWe use automated verification to ensure a safe community. Please complete this verification to gain access.`)
        .addFields(
          { name: '🤖 Why Verification?', value: 'This flow confirms you are a real person and not an automated bot or spam account.', inline: false },
          { name: '📋 Step 1', value: 'Look at the image and reply with the CAPTCHA code.', inline: false },
          { name: '🧠 Step 2', value: 'After CAPTCHA, complete one extra anti-bot challenge.', inline: false },
          { name: '⏱️ Time Limit', value: `You have ${Math.max(1, Math.round(CHALLENGE_TIMEOUT / 60000))} minutes per step.`, inline: false },
          { name: '🔁 Attempts', value: `${MAX_WRONG_ATTEMPTS_PER_STEP} wrong attempt${MAX_WRONG_ATTEMPTS_PER_STEP === 1 ? '' : 's'} per step.`, inline: false },
          { name: '❓ Can\'t Read It?', value: 'Run `/verify` again to get a new captcha image.', inline: false }
        )
        .setTimestamp();

      const e2 = new EmbedBuilder(e0)
        .setColor(0xF04747)
        .setDescription(`❌ That code is incorrect.\n\nPlease try again. Check the image above carefully and enter the exact code shown.`);

      const e3 = new EmbedBuilder(e0)
        .setColor(0x43B581)
        .setDescription(`✅ Verification Successful!\n\nWelcome to **${Server}**! Multi-step verification is complete and your access has been granted.`)
        .addFields(
          { name: 'You Now Have Access To:', value: '✅ All public channels\n✅ Voice channels\n✅ Bot commands\n✅ Member list\n✅ All server features', inline: false },
          { name: 'Server Rules', value: 'Please review our rules in the #rules channel to avoid infractions.', inline: false },
          { name: 'Get Started', value: 'Check the #introductions channel to introduce yourself!', inline: false }
        );

      const dmChannel = await member.user.createDM().catch(() => null);
      let activeChannel = dmChannel;

      if (dmChannel) {
        await sendChallengeImage(dmChannel, e1, captchaBuffer);
        await safeReply(interaction, {
          embeds: [
            new EmbedBuilder()
              .setColor(0x43B581)
              .setTitle('✅ Verification Started')
              .setDescription('Check your DMs for Step 1 (captcha), then complete Step 2 challenge there.')
          ],
          flags: 64
        });
      } else {
        verificationMode = 'channel_fallback';
        activeChannel = verifyChannel;

        await recordVerificationEvent({
          type: 'fallback_used',
          userId,
          username: interaction.user.tag,
          guildId: member.guild.id,
          guildName: member.guild.name,
          mode: verificationMode,
          challengeType: stepTwo.type
        }).catch(() => { });

        await safeReply(interaction, {
          embeds: [
            new EmbedBuilder()
              .setColor(0xFAA61A)
              .setTitle('⚠️ DM Unavailable')
              .setDescription('DMs are closed, so verification has switched to in-channel fallback.')
          ],
          flags: 64
        });

        const channelPrompt = new EmbedBuilder(e1)
          .setDescription(`DMs are unavailable for ${member}.\n\nFallback mode is active. Reply in this channel with the CAPTCHA code to continue.`);

        await sendChallengeImage(verifyChannel, channelPrompt, captchaBuffer);
      }

      const cleanupFallbackMessages = verificationMode !== 'dm';
      const captchaAttempt = await collectExpectedResponse({
        channel: activeChannel,
        memberId: member.id,
        expectedAnswer: captchaCode,
        wrongAnswerEmbed: e2,
        sessionId: session.sessionId,
        timeoutMs: CHALLENGE_TIMEOUT,
        maxWrongAttempts: MAX_WRONG_ATTEMPTS_PER_STEP,
        cleanupChannelMessages: cleanupFallbackMessages
      });
      if (captchaAttempt.status === 'timeout' || captchaAttempt.status === 'max_attempts') {
        const timeoutEmbed = new EmbedBuilder()
          .setColor(0xFAA61A)
          .setTitle(captchaAttempt.status === 'max_attempts' ? '🚫 Step 1 Failed' : '⏱️ Step 1 Timed Out')
          .setDescription(
            captchaAttempt.status === 'max_attempts'
              ? 'Too many wrong captcha attempts. Run `/verify` to start again.'
              : 'You did not complete the captcha verification within the time limit. This check ensures you are not a robot. Please run `/verify` to try again.'
          );

        await activeChannel.send({ embeds: [timeoutEmbed] }).catch(() => { });

        await recordVerificationEvent({
          type: captchaAttempt.status === 'max_attempts' ? 'failure' : 'timeout',
          userId,
          username: interaction.user.tag,
          guildId: member.guild.id,
          guildName: member.guild.name,
          mode: verificationMode,
          challengeType: stepTwo.type,
          reason: captchaAttempt.status === 'max_attempts'
            ? `captcha_max_attempts:${captchaAttempt.wrongAttempts}`
            : 'captcha_timeout'
        }).catch(() => { });
        await applyFailurePenalty(captchaAttempt.status === 'max_attempts' ? 'captcha_max_attempts' : 'captcha_timeout', stepTwo.type);
        return;
      }

      await recordVerificationEvent({
        type: 'step_captcha_passed',
        userId,
        username: interaction.user.tag,
        guildId: member.guild.id,
        guildName: member.guild.name,
        mode: verificationMode,
        challengeType: stepTwo.type
      }).catch(() => { });

      const secondStepEmbed = new EmbedBuilder(e0)
        .setColor(0x5865F2)
        .setTitle('🧠 Final Step')
        .setDescription(`${stepTwo.question}\n\nReply with your answer in this channel.`);

      const secondStepWrongEmbed = new EmbedBuilder(e0)
        .setColor(0xF04747)
        .setDescription('❌ Incorrect final-step answer. Please try again.');

      await activeChannel.send({ embeds: [secondStepEmbed] }).catch(() => { });

      const secondStepAttempt = await collectExpectedResponse({
        channel: activeChannel,
        memberId: member.id,
        expectedAnswer: stepTwo.answer,
        wrongAnswerEmbed: secondStepWrongEmbed,
        sessionId: session.sessionId,
        timeoutMs: CHALLENGE_TIMEOUT,
        maxWrongAttempts: MAX_WRONG_ATTEMPTS_PER_STEP,
        cleanupChannelMessages: cleanupFallbackMessages
      });
      if (secondStepAttempt.status === 'timeout' || secondStepAttempt.status === 'max_attempts') {
        const timeoutEmbed = new EmbedBuilder()
          .setColor(0xFAA61A)
          .setTitle(secondStepAttempt.status === 'max_attempts' ? '🚫 Step 2 Failed' : '⏱️ Step 2 Timed Out')
          .setDescription(
            secondStepAttempt.status === 'max_attempts'
              ? 'Too many wrong final-step attempts. Run `/verify` to start again.'
              : 'Final challenge timed out. Run `/verify` to start again.'
          );

        await activeChannel.send({ embeds: [timeoutEmbed] }).catch(() => { });

        await recordVerificationEvent({
          type: secondStepAttempt.status === 'max_attempts' ? 'failure' : 'timeout',
          userId,
          username: interaction.user.tag,
          guildId: member.guild.id,
          guildName: member.guild.name,
          mode: verificationMode,
          challengeType: stepTwo.type,
          reason: secondStepAttempt.status === 'max_attempts'
            ? `challenge_max_attempts:${secondStepAttempt.wrongAttempts}`
            : 'challenge_timeout'
        }).catch(() => { });
        await applyFailurePenalty(secondStepAttempt.status === 'max_attempts' ? 'challenge_max_attempts' : 'challenge_timeout', stepTwo.type);
        return;
      }

      await recordVerificationEvent({
        type: 'step_challenge_passed',
        userId,
        username: interaction.user.tag,
        guildId: member.guild.id,
        guildName: member.guild.name,
        mode: verificationMode,
        challengeType: stepTwo.type
      }).catch(() => { });

      const roleObj = member.guild.roles.cache.get(verifiedRoleId);
      if (!roleObj) {
        await activeChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xF04747)
              .setTitle('❌ Verification Failed')
              .setDescription('Verified role is missing. Please contact staff.')
          ]
        }).catch(() => { });

        await recordVerificationEvent({
          type: 'failure',
          userId,
          username: interaction.user.tag,
          guildId: member.guild.id,
          guildName: member.guild.name,
          mode: verificationMode,
          challengeType: stepTwo.type,
          reason: 'verified_role_missing'
        }).catch(() => { });
        await applyFailurePenalty('verified_role_missing', stepTwo.type);
        return;
      }

      const roleIssue = getRoleAssignmentIssue(member, roleObj);
      if (roleIssue) {
        await activeChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xF04747)
              .setTitle('❌ Verification Blocked')
              .setDescription('Verification passed, but role assignment failed. Please contact staff.')
              .addFields({ name: 'Reason', value: roleIssue })
          ]
        }).catch(() => { });

        await recordVerificationEvent({
          type: 'role_assignment_failed',
          userId,
          username: interaction.user.tag,
          guildId: member.guild.id,
          guildName: member.guild.name,
          mode: verificationMode,
          challengeType: stepTwo.type,
          reason: roleIssue
        }).catch(() => { });

        await recordVerificationEvent({
          type: 'failure',
          userId,
          username: interaction.user.tag,
          guildId: member.guild.id,
          guildName: member.guild.name,
          mode: verificationMode,
          challengeType: stepTwo.type,
          reason: 'role_assignment_blocked'
        }).catch(() => { });
        await applyFailurePenalty('role_assignment_blocked', stepTwo.type);
        return;
      }

      await member.roles.add(roleObj);
      registerVerificationSuccess(userId);

      await activeChannel.send({ embeds: [e3] }).catch(() => { });

      await safeReply(interaction, {
        embeds: [
          new EmbedBuilder()
            .setColor(0x43B581)
            .setTitle('✅ Verified')
            .setDescription('You are now verified and have full access.')
        ],
        flags: 64
      }).catch(() => { });

      await recordVerificationEvent({
        type: 'success',
        userId,
        username: interaction.user.tag,
        guildId: member.guild.id,
        guildName: member.guild.name,
        mode: verificationMode,
        challengeType: stepTwo.type,
        durationMs: Date.now() - verificationStartedAt
      }).catch(() => { });

      const CaptchaLog = new EmbedBuilder()
        .setTitle('Member Verified (Multi-Step)')
        .addFields(
          { name: '**User:**', value: `${member.user.username}` },
          { name: '**Mode:**', value: verificationMode },
          { name: '**Challenge Type:**', value: stepTwo.type },
          { name: '**Joined Server at:**', value: `${member.joinedAt?.toDateString?.() || 'Unknown'}` },
          { name: '**Account Creation:**', value: `${member.user.createdAt.toDateString()}` },
          { name: '**Role Given:**', value: `${roleObj}` }
        )
        .setColor(0x43B581);

      if (captchachannel) {
        await captchachannel.send({ embeds: [CaptchaLog] }).catch(() => { });
      }

    } catch (err) {
      console.error('[Verify] Error generating captcha:', err);

      await recordVerificationEvent({
        type: 'failure',
        userId,
        username: interaction.user.tag,
        guildId: member.guild.id,
        guildName: member.guild.name,
        mode: verificationMode,
        reason: err?.message || 'unexpected_error'
      }).catch(() => { });
      await applyFailurePenalty(err?.message || 'unexpected_error');

      const errorEmbed = new EmbedBuilder()
        .setColor(0xF04747)
        .setTitle('❌ Error')
        .setDescription('An error occurred while generating your captcha. Please try again.');

      return safeReply(interaction, {
        embeds: [errorEmbed],
        flags: 64
      });
    }
  }
};