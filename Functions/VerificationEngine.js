const { AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { CaptchaGenerator } = require('captcha-canvas');
const { recordVerificationEvent } = require('./VerificationAnalytics');
const AntiRaid = require('./AntiRaid');
const {
    canStartVerification,
    createVerificationSession,
    updateVerificationSession,
    appendVerificationHistory,
    appendVerificationDiagnostic,
    markVerificationStepResult,
    registerVerificationFailure,
    registerVerificationSuccess
} = require('./VerificationSessionManager');
const {
    getVerificationRuntimeConfig,
    shouldUseStrictMode,
    assessVerificationRisk,
    createAdaptiveChallengePlan,
    collectExpectedResponse
} = require('./VerificationFlowHelper');
const { ROLES: { verifiedRoleId, administratorRoleId, supportTeamRoleId } } = require('../Config/constants');
const { Version } = require('../Config/main.json');

function getVerificationContactLabel(guild) {
    const administratorRole = guild?.roles?.cache.get(administratorRoleId);
    if (administratorRole) {
        return administratorRole.name;
    }

    const supportRole = guild?.roles?.cache.get(supportTeamRoleId);
    if (supportRole) {
        return supportRole.name;
    }

    return 'the server staff team';
}

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
        return `Verified role (${roleObj.name}) is higher than or equal to the bot\'s highest role (${me.roles.highest.name}).`;
    }

    if (!member.manageable) {
        return 'Bot cannot manage this member due to role hierarchy or ownership restrictions.';
    }

    return null;
}

async function safeReply(interaction, payload) {
    if (!interaction) return null;
    if (interaction.replied || interaction.deferred) {
        return interaction.followUp(payload);
    }
    return interaction.reply(payload);
}

async function safeSend(channel, payload) {
    if (!channel || typeof channel.send !== 'function') return null;
    return channel.send(payload).catch(() => null);
}

async function sendChallengeImage(channel, embed, captchaBuffer) {
    const attachment = new AttachmentBuilder(captchaBuffer, { name: 'captcha.png' });
    const messageEmbed = new EmbedBuilder(embed).setImage('attachment://captcha.png');
    await channel.send({ embeds: [messageEmbed], files: [attachment] });
}

function buildDiagnostics({ member, verifyChannel, captchaChannel, verifiedRole, antiRaidSnapshot, riskAssessment, mode }) {
    return {
        guildId: member.guild.id,
        verifyChannel: verifyChannel?.name || null,
        captchaChannel: captchaChannel?.name || null,
        verifiedRole: verifiedRole?.name || null,
        antiRaidActive: Boolean(antiRaidSnapshot?.active),
        antiRaidReason: antiRaidSnapshot?.reason || null,
        riskScore: Number(riskAssessment?.score || 0),
        riskFlags: Array.isArray(riskAssessment?.flags) ? riskAssessment.flags : [],
        mode
    };
}

function formatDiagnostics(diagnostics = {}) {
    return [
        `verifyChannel=${diagnostics.verifyChannel || 'missing'}`,
        `captchaChannel=${diagnostics.captchaChannel || 'missing'}`,
        `verifiedRole=${diagnostics.verifiedRole || 'missing'}`,
        `antiRaidActive=${diagnostics.antiRaidActive ? 'yes' : 'no'}`,
        `antiRaidReason=${diagnostics.antiRaidReason || 'none'}`,
        `riskScore=${Number(diagnostics.riskScore || 0)}`,
        `riskFlags=${Array.isArray(diagnostics.riskFlags) && diagnostics.riskFlags.length ? diagnostics.riskFlags.join(',') : 'none'}`,
        `mode=${diagnostics.mode || 'unknown'}`
    ].join('; ');
}

function buildStateFields({ currentStep, totalSteps, tierLabel, mode, riskAssessment, antiRaidLinked, timeoutMs }) {
    return [
        { name: 'Progress', value: `Step ${currentStep}/${totalSteps}`, inline: true },
        { name: 'Challenge Tier', value: tierLabel, inline: true },
        { name: 'Mode', value: mode === 'dm' ? 'Direct Messages' : 'Channel fallback', inline: true },
        { name: 'Risk Score', value: `${Number(riskAssessment?.score || 0)}`, inline: true },
        { name: 'Risk Flags', value: Array.isArray(riskAssessment?.flags) && riskAssessment.flags.length ? riskAssessment.flags.join(', ') : 'None', inline: true },
        { name: 'Anti-Raid Link', value: antiRaidLinked ? 'Active' : 'Normal', inline: true },
        { name: 'Time Limit', value: `${Math.max(1, Math.round(timeoutMs / 60000))} minute(s) per step`, inline: false }
    ];
}

function createBaseVerificationEmbed(member, color = 0x5865F2) {
    return new EmbedBuilder()
        .setTitle('🔐 Verification Required')
        .setColor(color)
        .setFooter({ text: `${member.guild.name} • ${Version}` })
        .setTimestamp();
}

function createStepEmbed(member, options = {}) {
    const embed = createBaseVerificationEmbed(member, options.color || 0x5865F2)
        .setTitle(options.title || '🔐 Verification Required')
        .setDescription(options.description || 'Complete the requested verification step.')
        .addFields(buildStateFields(options.state));

    if (options.hint) {
        embed.addFields({ name: 'Hint', value: options.hint, inline: false });
    }

    return embed;
}

function createFailureNotice(member, options = {}) {
    const embed = createBaseVerificationEmbed(member, options.color || 0xFAA61A)
        .setTitle(options.title || 'Verification Failed')
        .setDescription(options.description || 'Verification could not be completed.');

    if (options.cooldownMs > 0) {
        embed.addFields({
            name: 'Retry Window',
            value: `Try again in ${Math.max(1, Math.ceil(options.cooldownMs / 1000))} seconds.`,
            inline: false
        });
    }

    if (options.details) {
        embed.addFields({ name: 'Details', value: options.details, inline: false });
    }

    return embed;
}

function createCaptchaChallenge(tier) {
    const length = tier >= 3 ? 8 : tier === 2 ? 7 : 6;
    const captcha = new CaptchaGenerator()
        .setDimension(600, 600)
        .setCaptcha({
            text: Math.random().toString(36).substring(2, 2 + length).toUpperCase(),
            size: tier >= 3 ? 72 : 68,
            color: '#32CD32'
        })
        .setDecoy({ opacity: tier >= 3 ? 0.3 : 0.2 })
        .setTrace({ color: '#32CD32', size: tier >= 3 ? 3 : 2 });

    return captcha;
}

async function executeVerificationFlow({
    member,
    interaction = null,
    source = 'unknown',
    verifyChannel = null,
    captchaLogChannel = null,
    announceInVerifyChannel = false,
    startContextLabel = 'Check your DMs to continue verification.',
    successContextLabel = 'Verification started successfully.',
    onVerificationCompleted = null
} = {}) {
    if (!member?.guild || !member?.user) {
        return { status: 'error', reason: 'missing_member_context' };
    }

    const runtime = getVerificationRuntimeConfig();
    const userId = member.id;
    const guild = member.guild;
    const verificationChannel = verifyChannel || interaction?.channel || null;
    const captchaChannel = captchaLogChannel || null;
    const verifiedRole = guild.roles.cache.get(verifiedRoleId) || null;

    const penaltyCheck = canStartVerification(userId);
    if (!penaltyCheck.allowed) {
        const cooldownEmbed = createFailureNotice(member, {
            title: '⏳ Cooldown Active',
            description: 'You must wait before trying verification again.',
            cooldownMs: penaltyCheck.remainingMs
        });
        if (interaction) {
            await safeReply(interaction, { embeds: [cooldownEmbed], flags: 64 });
        } else {
            await member.send({ embeds: [cooldownEmbed] }).catch(() => { });
        }
        return { status: 'blocked', reason: 'cooldown_active', remainingMs: penaltyCheck.remainingMs };
    }

    if (member.roles.cache.has(verifiedRoleId)) {
        if (interaction) {
            await safeReply(interaction, {
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x43B581)
                        .setTitle('✅ Already Verified')
                        .setDescription('Your account has already been verified.')
                ],
                flags: 64
            });
        }
        return { status: 'already_verified' };
    }

    const antiRaidLinkConfig = runtime.riskBased.antiRaidLink;
    const antiRaidSnapshot = AntiRaid.getRiskSnapshot(guild.id);
    const antiRaidRecent = antiRaidSnapshot?.lastTriggeredAt
        ? (Date.now() - antiRaidSnapshot.lastTriggeredAt <= antiRaidLinkConfig.recentLockdownMs)
        : false;
    const antiRaidLinked = antiRaidLinkConfig.enabled && (antiRaidSnapshot?.active || antiRaidRecent);
    const riskAssessment = assessVerificationRisk(member);
    const strictMode = shouldUseStrictMode(member.user.createdTimestamp)
        || riskAssessment.shouldUseStrictMode
        || (antiRaidLinked && antiRaidLinkConfig.forceStrictOnLockdown);
    const plan = createAdaptiveChallengePlan({
        strictMode,
        riskScore: riskAssessment.score,
        antiRaid: {
            active: Boolean(antiRaidSnapshot?.active),
            recent: antiRaidRecent
        }
    });
    const totalSteps = 1 + plan.challenges.length;
    const timeoutMs = Math.max(30_000, Math.round(runtime.challengeTimeoutMs * Number(plan.timeoutMultiplier || 1)));
    let mode = antiRaidLinked ? 'channel_fallback' : 'dm';
    const diagnostics = buildDiagnostics({
        member,
        verifyChannel: verificationChannel,
        captchaChannel,
        verifiedRole,
        antiRaidSnapshot,
        riskAssessment,
        mode
    });

    if (!captchaChannel || !verifiedRole) {
        const contactLabel = getVerificationContactLabel(guild);
        const details = formatDiagnostics(diagnostics);
        const errorEmbed = createBaseVerificationEmbed(member, 0xF04747)
            .setTitle('❌ Verification Error')
            .setDescription('Verification could not start because part of the verification system is unavailable.')
            .addFields(
                { name: 'What To Do', value: `Please contact ${contactLabel} and ask them to review the verification setup.`, inline: false },
                { name: 'Diagnostic Summary', value: details, inline: false }
            );

        if (interaction) {
            await safeReply(interaction, { embeds: [errorEmbed], flags: 64 });
        } else {
            await member.send({ embeds: [errorEmbed] }).catch(() => { });
        }

        await recordVerificationEvent({
            type: 'failure',
            userId,
            username: member.user.tag,
            guildId: guild.id,
            guildName: guild.name,
            mode,
            reason: `system_unavailable | ${details}`
        }).catch(() => { });
        return { status: 'error', reason: 'system_unavailable' };
    }

    const session = createVerificationSession({
        userId,
        guildId: guild.id,
        source,
        ttlMs: timeoutMs * totalSteps + 60_000,
        totalSteps,
        tier: plan.tier,
        tierLabel: plan.tierLabel,
        mode,
        riskScore: riskAssessment.score,
        riskFlags: riskAssessment.flags,
        antiRaid: {
            active: Boolean(antiRaidSnapshot?.active),
            recent: antiRaidRecent,
            reason: antiRaidSnapshot?.reason || null
        },
        metadata: {
            strictMode,
            diagnostics: formatDiagnostics(diagnostics)
        }
    });

    if (!session?.sessionId) {
        const failure = registerVerificationFailure(userId, { reason: 'session_creation_failed' });
        if (interaction) {
            await safeReply(interaction, {
                embeds: [createFailureNotice(member, {
                    title: '❌ Verification Error',
                    description: 'Could not create a verification session. Please try again later.',
                    cooldownMs: failure.cooldownMs
                })],
                flags: 64
            });
        }
        return { status: 'error', reason: 'session_creation_failed' };
    }

    appendVerificationDiagnostic(userId, formatDiagnostics(diagnostics));
    appendVerificationHistory(userId, { type: 'session_started', source, tier: plan.tier, mode });

    await recordVerificationEvent({
        type: 'session_started',
        userId,
        username: member.user.tag,
        guildId: guild.id,
        guildName: guild.name,
        mode,
        reason: `sessionId=${session.sessionId}; tier=${plan.tier}; strict=${strictMode}`
    }).catch(() => { });

    await recordVerificationEvent({
        type: 'risk_assessed',
        userId,
        username: member.user.tag,
        guildId: guild.id,
        guildName: guild.name,
        mode,
        reason: `score=${riskAssessment.score}; flags=${riskAssessment.flags.join(',') || 'none'}; antiRaid=${antiRaidLinked}`
    }).catch(() => { });

    await AntiRaid.handleVerificationRisk(member, riskAssessment.score, riskAssessment.flags).catch(() => { });

    if (antiRaidLinked && antiRaidLinkConfig.autoFailOnLockdown === true) {
        const failure = registerVerificationFailure(userId, { reason: 'anti_raid_lockdown_auto_fail' });
        const blockedEmbed = createFailureNotice(member, {
            title: '🚫 Verification Paused',
            description: 'Verification is temporarily restricted because the server is in an anti-raid state.',
            cooldownMs: failure.cooldownMs,
            details: 'Please wait for staff to confirm the server is stable, then try again.'
        });
        if (interaction) {
            await safeReply(interaction, { embeds: [blockedEmbed], flags: 64 });
        } else {
            await member.send({ embeds: [blockedEmbed] }).catch(() => { });
        }
        await recordVerificationEvent({
            type: 'failure',
            userId,
            username: member.user.tag,
            guildId: guild.id,
            guildName: guild.name,
            mode,
            reason: 'anti_raid_lockdown_auto_fail'
        }).catch(() => { });
        return { status: 'blocked', reason: 'anti_raid_lockdown_auto_fail' };
    }

    if (riskAssessment.shouldAutoFail) {
        const failure = registerVerificationFailure(userId, { reason: 'risk_auto_fail' });
        const blockedEmbed = createFailureNotice(member, {
            title: '🚫 Verification Escalated',
            description: 'Your verification was flagged for manual review due to elevated risk signals.',
            cooldownMs: failure.cooldownMs,
            details: `Please contact ${getVerificationContactLabel(guild)} if you need access urgently.`
        });
        if (interaction) {
            await safeReply(interaction, { embeds: [blockedEmbed], flags: 64 });
        } else {
            await member.send({ embeds: [blockedEmbed] }).catch(() => { });
        }
        await recordVerificationEvent({
            type: 'failure',
            userId,
            username: member.user.tag,
            guildId: guild.id,
            guildName: guild.name,
            mode,
            reason: 'risk_auto_fail'
        }).catch(() => { });
        return { status: 'blocked', reason: 'risk_auto_fail' };
    }

    const captcha = createCaptchaChallenge(plan.tier);
    const captchaBuffer = await captcha.generate();
    const captchaCode = captcha.text;

    const captchaLogEmbed = new EmbedBuilder()
        .setTitle('🧩 Captcha Generated')
        .setDescription(`Captcha generated for ${member.user.tag}`)
        .setImage('attachment://captcha.png')
        .setColor(0x5865F2)
        .addFields(
            { name: 'Tier', value: plan.tierLabel, inline: true },
            { name: 'Risk Score', value: `${riskAssessment.score}`, inline: true },
            { name: 'Source', value: source, inline: true }
        )
        .setFooter({ text: `${guild.name} • Verification System` });
    await safeSend(captchaChannel, {
        embeds: [captchaLogEmbed],
        files: [new AttachmentBuilder(captchaBuffer, { name: 'captcha.png' })]
    });

    let activeChannel = null;
    if (mode === 'dm') {
        activeChannel = await member.user.createDM().catch(() => null);
    }
    if (!activeChannel) {
        mode = 'channel_fallback';
        activeChannel = verificationChannel;
        updateVerificationSession(userId, { mode });
        await recordVerificationEvent({
            type: 'fallback_used',
            userId,
            username: member.user.tag,
            guildId: guild.id,
            guildName: guild.name,
            mode,
            reason: 'dm_unavailable_or_forced_fallback'
        }).catch(() => { });
    }

    if (!activeChannel) {
        await recordVerificationEvent({
            type: 'failure',
            userId,
            username: member.user.tag,
            guildId: guild.id,
            guildName: guild.name,
            mode,
            reason: 'dm_closed_and_no_verify_channel'
        }).catch(() => { });
        registerVerificationFailure(userId, { reason: 'dm_closed_and_no_verify_channel' });
        return { status: 'error', reason: 'dm_closed_and_no_verify_channel' };
    }

    if (announceInVerifyChannel && verificationChannel && mode === 'dm') {
        safeSend(verificationChannel, {
            content: `${member}`,
            embeds: [
                createBaseVerificationEmbed(member, 0x43B581)
                    .setTitle('✅ Verification Started')
                    .setDescription(startContextLabel)
                    .addFields({ name: 'Challenge Tier', value: plan.tierLabel, inline: true })
            ]
        }).then((message) => {
            if (message) {
                setTimeout(() => message.delete().catch(() => { }), timeoutMs);
            }
        });
    }

    if (interaction) {
        const replyEmbed = createBaseVerificationEmbed(member, 0x43B581)
            .setTitle('✅ Verification Started')
            .setDescription(mode === 'dm' ? startContextLabel : 'DMs were unavailable, so verification has switched to the channel fallback.')
            .addFields(
                { name: 'Tier', value: plan.tierLabel, inline: true },
                { name: 'Total Steps', value: `${totalSteps}`, inline: true },
                { name: 'Mode', value: mode === 'dm' ? 'Direct Messages' : 'Channel fallback', inline: true }
            );
        await safeReply(interaction, { embeds: [replyEmbed], flags: 64 });
    }

    const captchaStepState = {
        currentStep: 1,
        totalSteps,
        tierLabel: plan.tierLabel,
        mode,
        riskAssessment,
        antiRaidLinked,
        timeoutMs
    };
    updateVerificationSession(userId, {
        currentStep: 1,
        currentStepLabel: 'Captcha',
        currentChallengeType: 'captcha',
        mode
    });

    const introEmbed = createStepEmbed(member, {
        title: '🧩 Step 1: Captcha',
        description: 'Reply with the captcha code shown in the image to begin verification.',
        hint: 'Read the letters carefully and type them exactly as shown.',
        state: captchaStepState
    });
    await sendChallengeImage(activeChannel, introEmbed, captchaBuffer);

    const cleanupFallbackMessages = mode !== 'dm';
    const captchaAttempt = await collectExpectedResponse({
        channel: activeChannel,
        memberId: userId,
        expectedAnswer: captchaCode,
        wrongAnswerEmbed: createBaseVerificationEmbed(member, 0xF04747)
            .setTitle('❌ Incorrect Captcha')
            .setDescription('That captcha answer is not correct. Please try again.'),
        sessionId: session.sessionId,
        timeoutMs,
        maxWrongAttempts: runtime.maxWrongAttemptsPerStep,
        cleanupChannelMessages: cleanupFallbackMessages,
        onAttempt: ({ status, wrongAttempts }) => {
            if (status === 'incorrect') {
                updateVerificationSession(userId, {
                    attemptsByStep: { captcha: wrongAttempts }
                });
                appendVerificationHistory(userId, { type: 'captcha_incorrect', attempts: wrongAttempts });
            }
        }
    });

    if (captchaAttempt.status !== 'passed') {
        markVerificationStepResult(userId, 'captcha', { status: captchaAttempt.status, attempts: captchaAttempt.wrongAttempts, challengeType: 'captcha' });
        const reason = captchaAttempt.status === 'max_attempts' ? 'captcha_max_attempts' : 'captcha_timeout';
        const failure = registerVerificationFailure(userId, { reason });
        await recordVerificationEvent({
            type: captchaAttempt.status === 'max_attempts' ? 'failure' : 'timeout',
            userId,
            username: member.user.tag,
            guildId: guild.id,
            guildName: guild.name,
            mode,
            reason: `${reason}:${captchaAttempt.wrongAttempts}`
        }).catch(() => { });
        await recordVerificationEvent({
            type: 'penalty_applied',
            userId,
            username: member.user.tag,
            guildId: guild.id,
            guildName: guild.name,
            mode,
            reason: `${reason} | cooldown=${failure.cooldownMs}ms | streak=${failure.streak}`
        }).catch(() => { });
        await safeSend(activeChannel, {
            embeds: [createFailureNotice(member, {
                title: captchaAttempt.status === 'max_attempts' ? '🚫 Step 1 Failed' : '⏱️ Step 1 Timed Out',
                description: captchaAttempt.status === 'max_attempts'
                    ? 'Too many incorrect captcha attempts were entered.'
                    : 'The captcha step was not completed in time.',
                cooldownMs: failure.cooldownMs,
                details: `Verification tier: ${plan.tierLabel}`
            })]
        });
        return { status: 'failed', reason };
    }

    markVerificationStepResult(userId, 'captcha', { status: 'passed', attempts: captchaAttempt.wrongAttempts, challengeType: 'captcha' });
    await recordVerificationEvent({
        type: 'step_captcha_passed',
        userId,
        username: member.user.tag,
        guildId: guild.id,
        guildName: guild.name,
        mode,
        reason: `tier=${plan.tier}`
    }).catch(() => { });

    for (let index = 0; index < plan.challenges.length; index += 1) {
        const challenge = plan.challenges[index];
        const stepNumber = index + 2;
        const stepId = `challenge_${index + 1}`;
        updateVerificationSession(userId, {
            currentStep: stepNumber,
            currentStepLabel: `Challenge ${index + 1}`,
            currentChallengeType: challenge.type,
            attemptsByStep: { [stepId]: 0 }
        });

        const state = {
            currentStep: stepNumber,
            totalSteps,
            tierLabel: plan.tierLabel,
            mode,
            riskAssessment,
            antiRaidLinked,
            timeoutMs
        };
        const stepEmbed = createStepEmbed(member, {
            title: `🧠 Step ${stepNumber}: Additional Check`,
            description: challenge.prompt,
            hint: challenge.hint,
            state
        });
        await safeSend(activeChannel, { embeds: [stepEmbed] });

        const attempt = await collectExpectedResponse({
            channel: activeChannel,
            memberId: userId,
            expectedAnswer: challenge.answer,
            wrongAnswerEmbed: createBaseVerificationEmbed(member, 0xF04747)
                .setTitle('❌ Incorrect Answer')
                .setDescription('That answer is not correct. Please try again.'),
            sessionId: session.sessionId,
            timeoutMs,
            maxWrongAttempts: runtime.maxWrongAttemptsPerStep,
            cleanupChannelMessages: cleanupFallbackMessages,
            onAttempt: ({ status, wrongAttempts }) => {
                if (status === 'incorrect') {
                    updateVerificationSession(userId, {
                        attemptsByStep: { [stepId]: wrongAttempts }
                    });
                    appendVerificationHistory(userId, { type: 'challenge_incorrect', challengeType: challenge.type, attempts: wrongAttempts });
                }
            }
        });

        if (attempt.status !== 'passed') {
            markVerificationStepResult(userId, stepId, { status: attempt.status, attempts: attempt.wrongAttempts, challengeType: challenge.type });
            const reason = attempt.status === 'max_attempts' ? 'challenge_max_attempts' : 'challenge_timeout';
            const failure = registerVerificationFailure(userId, { reason });
            await recordVerificationEvent({
                type: attempt.status === 'max_attempts' ? 'failure' : 'timeout',
                userId,
                username: member.user.tag,
                guildId: guild.id,
                guildName: guild.name,
                mode,
                challengeType: challenge.type,
                reason: `${reason}:${attempt.wrongAttempts}`
            }).catch(() => { });
            await recordVerificationEvent({
                type: 'penalty_applied',
                userId,
                username: member.user.tag,
                guildId: guild.id,
                guildName: guild.name,
                mode,
                challengeType: challenge.type,
                reason: `${reason} | cooldown=${failure.cooldownMs}ms | streak=${failure.streak}`
            }).catch(() => { });
            await safeSend(activeChannel, {
                embeds: [createFailureNotice(member, {
                    title: attempt.status === 'max_attempts' ? `🚫 Step ${stepNumber} Failed` : `⏱️ Step ${stepNumber} Timed Out`,
                    description: attempt.status === 'max_attempts'
                        ? 'Too many incorrect answers were entered for this verification step.'
                        : 'This verification step was not completed before the timeout expired.',
                    cooldownMs: failure.cooldownMs,
                    details: `Challenge type: ${challenge.type}`
                })]
            });
            return { status: 'failed', reason, challengeType: challenge.type };
        }

        markVerificationStepResult(userId, stepId, { status: 'passed', attempts: attempt.wrongAttempts, challengeType: challenge.type });
        await recordVerificationEvent({
            type: 'step_challenge_passed',
            userId,
            username: member.user.tag,
            guildId: guild.id,
            guildName: guild.name,
            mode,
            challengeType: challenge.type,
            reason: `step=${stepNumber}`
        }).catch(() => { });
    }

    const roleIssue = getRoleAssignmentIssue(member, verifiedRole);
    if (roleIssue) {
        const contactLabel = getVerificationContactLabel(guild);
        const blockedEmbed = createBaseVerificationEmbed(member, 0xF04747)
            .setTitle('❌ Verification Blocked')
            .setDescription('Verification passed, but the verified role could not be assigned.')
            .addFields(
                { name: 'What Happened', value: roleIssue, inline: false },
                { name: 'What To Do', value: `Please contact ${contactLabel} so staff can fix the role setup.`, inline: false }
            );
        await safeSend(activeChannel, { embeds: [blockedEmbed] });
        await recordVerificationEvent({
            type: 'role_assignment_failed',
            userId,
            username: member.user.tag,
            guildId: guild.id,
            guildName: guild.name,
            mode,
            reason: roleIssue
        }).catch(() => { });
        await recordVerificationEvent({
            type: 'failure',
            userId,
            username: member.user.tag,
            guildId: guild.id,
            guildName: guild.name,
            mode,
            reason: 'role_assignment_blocked'
        }).catch(() => { });
        return { status: 'error', reason: 'role_assignment_blocked' };
    }

    await member.roles.add(verifiedRole);
    registerVerificationSuccess(userId);
    if (typeof onVerificationCompleted === 'function') {
        await onVerificationCompleted();
    }

    const durationMs = timeoutMs ? Date.now() - session.createdAt : 0;
    const successEmbed = createBaseVerificationEmbed(member, 0x43B581)
        .setTitle('✅ Verification Complete')
        .setDescription(`Welcome to **${guild.name}**. Your verification has been completed successfully.`)
        .addFields(
            { name: 'Role Granted', value: verifiedRole.name, inline: true },
            { name: 'Challenge Tier', value: plan.tierLabel, inline: true },
            { name: 'Duration', value: `${Math.max(1, Math.round(durationMs / 1000))}s`, inline: true }
        );
    await safeSend(activeChannel, { embeds: [successEmbed] });

    await safeSend(captchaChannel, {
        embeds: [
            new EmbedBuilder()
                .setTitle('✅ Verification Complete')
                .setDescription(`${member.user.tag} completed verification.`)
                .setColor(0x43B581)
                .addFields(
                    { name: 'Tier', value: plan.tierLabel, inline: true },
                    { name: 'Mode', value: mode, inline: true },
                    { name: 'Challenges', value: plan.challenges.map((challenge) => challenge.type).join(', ') || 'captcha_only', inline: false }
                )
                .setFooter({ text: `${guild.name} • Verification System` })
        ]
    });

    await recordVerificationEvent({
        type: 'success',
        userId,
        username: member.user.tag,
        guildId: guild.id,
        guildName: guild.name,
        mode,
        challengeType: plan.challenges.map((challenge) => challenge.type).join(','),
        durationMs,
        reason: `tier=${plan.tier}; challenges=${plan.challenges.length}`
    }).catch(() => { });

    return { status: 'success', mode, tier: plan.tier, durationMs, successContextLabel };
}

module.exports = {
    executeVerificationFlow,
    getVerificationContactLabel,
    getRoleAssignmentIssue,
    formatDiagnostics
};