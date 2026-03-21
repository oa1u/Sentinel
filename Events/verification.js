const { AttachmentBuilder, EmbedBuilder } = require("discord.js");
const { CaptchaGenerator } = require("captcha-canvas");
const { recordVerificationEvent } = require("../Functions/VerificationAnalytics");
const AntiRaid = require("../Functions/AntiRaid");
const {
    canStartVerification,
    createVerificationSession,
    registerVerificationFailure,
    registerVerificationSuccess
} = require("../Functions/VerificationSessionManager");
const { ROLES: { verifiedRoleId, administratorRoleId }, CHANNELS: { verificationChannelId, captchaLogChannelId } } = require("../Config/constants");
const { Version } = require("../Config/main.json");
const {
    getVerificationRuntimeConfig,
    shouldUseStrictMode,
    createStepTwoChallenge,
    collectExpectedResponse
} = require("../Functions/VerificationFlowHelper");

const Color = "#32CD32";
const {
    challengeTimeoutMs: CHALLENGE_TIMEOUT,
    maxWrongAttemptsPerStep: MAX_WRONG_ATTEMPTS_PER_STEP
} = getVerificationRuntimeConfig();

const VERIFICATION_CONFIG = (require("../Config/constants").MISC?.verification || {});
const RISK_CONFIG = VERIFICATION_CONFIG?.riskBased || {};
const RISK_ENABLED = RISK_CONFIG.enabled !== false;
const RISK_WEIGHTS = RISK_CONFIG.weights || {};
const DEFAULT_RISK_WEIGHTS = {
    youngAccount: 25,
    noAvatar: 10,
    digitHeavyName: 12,
    repeatChars: 10,
    lowEntropyName: 12,
    joinBurst: 15,
    nameCollision: 18
};
const JOIN_BURST_WINDOW_MS = Math.max(5_000, Number(RISK_CONFIG.joinBurstWindowMs || 60_000));
const RECENT_NAME_WINDOW_MS = Math.max(30_000, Number(RISK_CONFIG.recentNameWindowMs || 1_800_000));
const STRICT_SCORE_THRESHOLD = Math.max(1, Number(RISK_CONFIG.strictScoreThreshold || 30));
const AUTO_FAIL_ENABLED = RISK_CONFIG.autoFailEnabled === true;
const AUTO_FAIL_SCORE_THRESHOLD = Math.max(1, Number(RISK_CONFIG.autoFailScoreThreshold || 80));
const ANTI_RAID_LINK = RISK_CONFIG.antiRaidLink || {};
const ANTI_RAID_RECENT_MS = Math.max(60_000, Number(ANTI_RAID_LINK.recentLockdownMs || 900_000));

const recentJoinState = {
    lastJoinAtByGuild: new Map(),
    recentNamesByGuild: new Map()
};

function getRiskWeight(key) {
    if (Object.prototype.hasOwnProperty.call(RISK_WEIGHTS, key)) {
        return Number(RISK_WEIGHTS[key] || 0);
    }
    return Number(DEFAULT_RISK_WEIGHTS[key] || 0);
}

function normalizeName(input) {
    return String(input || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getDigitRatio(input) {
    const value = String(input || '');
    if (!value.length) return 0;
    const digits = value.replace(/[^0-9]/g, '').length;
    return digits / value.length;
}

function getEntropyScore(input) {
    const value = normalizeName(input);
    if (!value.length) return 0;
    const uniqueCount = new Set(value.split('')).size;
    return uniqueCount / value.length;
}

function assessVerificationRisk(member) {
    if (!RISK_ENABLED || !member?.user) {
        return { score: 0, flags: [], shouldUseStrictMode: false, shouldAutoFail: false };
    }

    const flags = [];
    let score = 0;
    const accountAgeDays = Math.max(0, (Date.now() - Number(member.user.createdTimestamp || 0)) / (24 * 60 * 60 * 1000));
    const accountAgeThreshold = Math.max(0, Number(RISK_CONFIG.accountAgeDaysThreshold || 7));

    if (accountAgeDays < accountAgeThreshold) {
        score += getRiskWeight('youngAccount');
        flags.push(`young_account:${accountAgeDays.toFixed(1)}d`);
    }

    const noAvatar = !member.user.avatar;
    if (RISK_CONFIG.noAvatarEnabled !== false && noAvatar) {
        score += getRiskWeight('noAvatar');
        flags.push('no_avatar');
    }

    const digitRatio = getDigitRatio(member.user.username);
    const digitRatioThreshold = Math.max(0, Number(RISK_CONFIG.digitRatioThreshold || 0.5));
    if (digitRatio >= digitRatioThreshold) {
        score += getRiskWeight('digitHeavyName');
        flags.push(`digit_heavy:${digitRatio.toFixed(2)}`);
    }

    const repeatThreshold = Math.max(2, Number(RISK_CONFIG.repeatCharThreshold || 4));
    const repeatRegex = new RegExp(`(.)\\1{${repeatThreshold - 1},}`);
    if (repeatRegex.test(member.user.username || '')) {
        score += getRiskWeight('repeatChars');
        flags.push('repeat_chars');
    }

    const entropy = getEntropyScore(member.user.username);
    const entropyThreshold = Math.max(0, Number(RISK_CONFIG.entropyThreshold || 0.35));
    if (entropy > 0 && entropy <= entropyThreshold) {
        score += getRiskWeight('lowEntropyName');
        flags.push(`low_entropy:${entropy.toFixed(2)}`);
    }

    const guildId = member.guild?.id || 'global';
    const lastJoinAt = recentJoinState.lastJoinAtByGuild.get(guildId) || 0;
    const now = Date.now();
    const joinDelta = lastJoinAt ? now - lastJoinAt : null;
    if (joinDelta !== null && joinDelta <= JOIN_BURST_WINDOW_MS) {
        score += getRiskWeight('joinBurst');
        flags.push(`join_burst:${Math.round(joinDelta / 1000)}s`);
    }
    recentJoinState.lastJoinAtByGuild.set(guildId, now);

    const normalized = normalizeName(member.user.username);
    if (RISK_CONFIG.nameCollisionEnabled !== false && normalized) {
        const recent = recentJoinState.recentNamesByGuild.get(guildId) || [];
        const cutoff = now - RECENT_NAME_WINDOW_MS;
        const filtered = recent.filter(entry => entry && entry.at >= cutoff);
        const collision = filtered.find(entry => entry.name === normalized);
        if (collision) {
            score += getRiskWeight('nameCollision');
            flags.push('name_collision');
        }
        filtered.push({ name: normalized, at: now });
        recentJoinState.recentNamesByGuild.set(guildId, filtered.slice(-50));
    }

    const shouldUseStrictMode = score >= STRICT_SCORE_THRESHOLD;
    const shouldAutoFail = AUTO_FAIL_ENABLED && score >= AUTO_FAIL_SCORE_THRESHOLD;

    return { score, flags, shouldUseStrictMode, shouldAutoFail };
}

function getRoleAssignmentIssue(member, roleObj) {
    if (!member || !roleObj || !member.guild) return "Missing member or role context.";

    const me = member.guild.members.me;
    if (!me) return "Bot member object is unavailable in this guild.";

    if (!me.permissions.has("ManageRoles")) {
        return "Bot is missing the Manage Roles permission.";
    }

    if (roleObj.managed) {
        return "Target role is managed by an integration and cannot be assigned manually.";
    }

    if (me.roles.highest.position <= roleObj.position) {
        return `Verified role (${roleObj.name}) is higher than or equal to the bot's highest role (${me.roles.highest.name}).`;
    }

    if (!member.manageable) {
        return "Bot cannot manage this member due to role hierarchy or ownership restrictions.";
    }

    return null;
}

async function sendChallengeImage(channel, embed, captchaBuffer) {
    const attachment = new AttachmentBuilder(captchaBuffer, { name: "captcha.png" });
    const messageEmbed = new EmbedBuilder(embed).setImage("attachment://captcha.png");
    await channel.send({ embeds: [messageEmbed], files: [attachment] });
}

module.exports = {
    name: "guildMemberAdd",
    disabled: true,
    runOnce: false,
    async execute(member, client) {
        if (!member) return;

        const captchachannel = client.channels.cache.get(captchaLogChannelId);
        const verifyChannel = client.channels.cache.get(verificationChannelId);
        const startedAt = Date.now();
        let mode = "dm";
        const userId = member.id;
        const baseStrictMode = shouldUseStrictMode(member.user?.createdTimestamp);
        const riskAssessment = assessVerificationRisk(member);
        const antiRaidSnapshot = AntiRaid.getRiskSnapshot(member.guild.id);
        const antiRaidRecent = antiRaidSnapshot?.lastTriggeredAt
            ? (Date.now() - antiRaidSnapshot.lastTriggeredAt <= ANTI_RAID_RECENT_MS)
            : false;
        const antiRaidLinked = ANTI_RAID_LINK.enabled !== false && (antiRaidSnapshot?.active || antiRaidRecent);
        const strictMode = baseStrictMode || riskAssessment.shouldUseStrictMode || (antiRaidLinked && ANTI_RAID_LINK.forceStrictOnLockdown !== false);

        // --- Verification timeout logic ---
        // Kick user if verification not completed in xyz time
        const VERIFICATION_TIMEOUT_MS = Math.max(1, Math.round(CHALLENGE_TIMEOUT * 2)); // Double challenge timeout for full process
        let verificationCompleted = false;
        // Helper to mark verification as completed
        function markVerificationCompleted() {
            verificationCompleted = true;
        }
        // Schedule kick
        setTimeout(async () => {
            if (!verificationCompleted && member && member.kickable) {
                try {
                    const kickEmbed = new EmbedBuilder()
                        .setColor("#FF0000")
                        .setTitle("🚫 Verification Failed")
                        .setDescription(`You have been removed from **${member.guild.name}** because you did not complete the verification process in time.\n\nPlease rejoin the server to try again when you are ready.`)
                        .setTimestamp();

                    try {
                        await member.send({ embeds: [kickEmbed] });
                    } catch (dmErr) {
                        // User has DMs off
                    }

                    await member.kick("Failed to complete verification in time.");
                } catch (err) {
                    console.error(`[Verify] Failed to kick user ${member.user.tag}: ${err.message}`);
                }
            }
        }, VERIFICATION_TIMEOUT_MS);

        const penaltyCheck = canStartVerification(userId);
        if (!penaltyCheck.allowed) {
            const cooldownSeconds = Math.max(1, Math.ceil(penaltyCheck.remainingMs / 1000));
            const cooldownEmbed = new EmbedBuilder()
                .setColor(0xFAA61A)
                .setTitle("⏳ Verification Cooldown")
                .setDescription(`Please wait ${cooldownSeconds}s before trying verification again.`);

            member.send({ embeds: [cooldownEmbed] }).catch(() => { });
            return;
        }

        if (member.user?.bot) {
            const roleObj = member.guild.roles.cache.get(verifiedRoleId);
            if (roleObj) {
                const roleIssue = getRoleAssignmentIssue(member, roleObj);
                if (roleIssue) {
                    console.error(`[Verify] Could not auto-verify bot ${member.user.tag}: ${roleIssue}`);
                } else {
                    await member.roles.add(roleObj).catch((err) => {
                        console.error(`[Verify] Couldn't add role to bot: ${err.message}`);
                    });
                }
            }
            return;
        }

        if (!captchachannel) {
            const systemErrorEmbed = new EmbedBuilder()
                .setColor(0xF04747)
                .setTitle("❌ Verification Error")
                .setDescription(`Verification system failed. Contact an <@&${administratorRoleId}> ASAP.`);

            return member.send({ embeds: [systemErrorEmbed] }).catch((err) => {
                console.error(`[Verify] Couldn't send error DM: ${err.message}`);
            });
        }

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
        const stepTwo = createStepTwoChallenge({ strictMode });
        const session = createVerificationSession({
            userId,
            guildId: member.guild.id,
            source: "guild_member_add"
        });

        if (!session?.sessionId) {
            return;
        }

        const applyFailurePenalty = async (reason, challengeType = null) => {
            const penalty = registerVerificationFailure(userId);
            await recordVerificationEvent({
                type: "penalty_applied",
                userId: member.id,
                username: member.user.tag,
                guildId: member.guild.id,
                guildName: member.guild.name,
                mode,
                challengeType,
                reason: `${reason} | cooldown=${penalty.cooldownMs}ms | streak=${penalty.streak}`
            }).catch(() => { });
        };

        await recordVerificationEvent({
            type: "session_started",
            userId: member.id,
            username: member.user.tag,
            guildId: member.guild.id,
            guildName: member.guild.name,
            mode,
            reason: `sessionId=${session.sessionId}`
        }).catch(() => { });

        if (RISK_ENABLED) {
            await recordVerificationEvent({
                type: "risk_assessed",
                userId: member.id,
                username: member.user.tag,
                guildId: member.guild.id,
                guildName: member.guild.name,
                mode,
                reason: `score=${riskAssessment.score}; flags=${riskAssessment.flags.join(',') || 'none'}; strict=${strictMode}; antiRaidLinked=${antiRaidLinked}`
            }).catch(() => { });
        }

        await AntiRaid.handleVerificationRisk(member, riskAssessment.score, riskAssessment.flags);

        if (antiRaidLinked && ANTI_RAID_LINK.autoFailOnLockdown === true) {
            await recordVerificationEvent({
                type: "failure",
                userId: member.id,
                username: member.user.tag,
                guildId: member.guild.id,
                guildName: member.guild.name,
                mode,
                reason: "anti_raid_lockdown_auto_fail"
            }).catch(() => { });
            await applyFailurePenalty("anti_raid_lockdown_auto_fail");
            return;
        }

        if (riskAssessment.shouldAutoFail) {
            await recordVerificationEvent({
                type: "failure",
                userId: member.id,
                username: member.user.tag,
                guildId: member.guild.id,
                guildName: member.guild.name,
                mode,
                reason: "risk_auto_fail"
            }).catch(() => { });
            await applyFailurePenalty("risk_auto_fail");
            return;
        }

        await recordVerificationEvent({
            type: "multi_step_issued",
            userId: member.id,
            username: member.user.tag,
            guildId: member.guild.id,
            guildName: member.guild.name,
            mode,
            challengeType: stepTwo.type,
            reason: `strictMode=${strictMode}`
        }).catch(() => { });

        try {
            const captchaAttachment = new AttachmentBuilder(captchaBuffer, { name: "captcha.png" });
            const captchaEmbed = new EmbedBuilder()
                .setTitle("🧩 Captcha Generated")
                .setDescription(`Captcha generated for ${member.user.tag}`)
                .setImage("attachment://captcha.png")
                .setColor(Color)
                .setFooter({ text: `${member.guild.name} • Verification System` });
            await captchachannel.send({ embeds: [captchaEmbed], files: [captchaAttachment] });

            const baseEmbed = new EmbedBuilder()
                .setTitle("🔐 Verification Required")
                .setColor(Color)
                .setFooter({ text: `${Version}` });

            const stepOneEmbed = new EmbedBuilder(baseEmbed)
                .setDescription("Welcome! Complete this 2-step verification to unlock the server.")
                .addFields(
                    { name: "Step 1", value: "Reply with the CAPTCHA code from the image.", inline: false },
                    { name: "Step 2", value: "Complete a quick anti-bot challenge.", inline: false },
                    { name: "Timeout", value: `${Math.max(1, Math.round(CHALLENGE_TIMEOUT / 60000))} minutes per step.`, inline: false },
                    { name: "Attempts", value: `${MAX_WRONG_ATTEMPTS_PER_STEP} wrong attempt${MAX_WRONG_ATTEMPTS_PER_STEP === 1 ? '' : 's'} per step.`, inline: false }
                )
                .setFooter({ text: `${Version} • Expires in ${Math.max(1, Math.round(CHALLENGE_TIMEOUT / 60000))} minutes` });

            const wrongCaptchaEmbed = new EmbedBuilder(baseEmbed)
                .setColor("#FF0000")
                .setDescription("❌ Wrong CAPTCHA code. Try again.");

            const wrongStepTwoEmbed = new EmbedBuilder(baseEmbed)
                .setColor("#FF0000")
                .setDescription("❌ Wrong final-step answer. Try again.");

            if (verifyChannel) {
                const verifyEmbed = new EmbedBuilder()
                    .setAuthor({ name: `${member.guild.name} Security`, iconURL: member.guild.iconURL() })
                    .setTitle("🔐 Verification Required")
                    .setColor(Color)
                    .setDescription(`👋 Welcome ${member}! Run /verify or complete verification in DM.`)
                    .addFields(
                        { name: "Flow", value: "2-step verification (captcha + anti-bot challenge)", inline: false },
                        { name: "Fallback", value: "If DMs fail, verification can continue in this channel.", inline: false }
                    )
                    .setTimestamp();

                verifyChannel.send({ content: `${member}`, embeds: [verifyEmbed] })
                    .then((msg) => setTimeout(() => msg.delete().catch(() => { }), CHALLENGE_TIMEOUT));
            }

            const dmChannel = await member.user.createDM().catch(() => null);
            let activeChannel = dmChannel;

            if (!activeChannel) {
                mode = "channel_fallback";
                activeChannel = verifyChannel;

                await recordVerificationEvent({
                    type: "fallback_used",
                    userId: member.id,
                    username: member.user.tag,
                    guildId: member.guild.id,
                    guildName: member.guild.name,
                    mode,
                    challengeType: stepTwo.type
                }).catch(() => { });

                if (!activeChannel) {
                    await recordVerificationEvent({
                        type: "failure",
                        userId: member.id,
                        username: member.user.tag,
                        guildId: member.guild.id,
                        guildName: member.guild.name,
                        mode,
                        challengeType: stepTwo.type,
                        reason: "dm_closed_and_no_verify_channel"
                    }).catch(() => { });
                    return;
                }

                await activeChannel.send({
                    content: `${member}`,
                    embeds: [
                        new EmbedBuilder(baseEmbed)
                            .setColor(0xFAA61A)
                            .setDescription("DMs are unavailable, so verification switched to in-channel fallback.")
                    ]
                }).catch(() => { });
            }

            await sendChallengeImage(activeChannel, stepOneEmbed, captchaBuffer);

            const cleanupFallbackMessages = mode !== "dm";
            const captchaAttempt = await collectExpectedResponse(
                {
                    channel: activeChannel,
                    memberId: member.id,
                    expectedAnswer: captchaCode,
                    wrongAnswerEmbed: wrongCaptchaEmbed,
                    sessionId: session.sessionId,
                    timeoutMs: CHALLENGE_TIMEOUT,
                    maxWrongAttempts: MAX_WRONG_ATTEMPTS_PER_STEP,
                    cleanupChannelMessages: cleanupFallbackMessages
                }
            );

            if (captchaAttempt.status === "timeout" || captchaAttempt.status === "max_attempts") {
                await activeChannel.send({
                    embeds: [
                        new EmbedBuilder(baseEmbed)
                            .setColor(0xFAA61A)
                            .setTitle(captchaAttempt.status === "max_attempts" ? "🚫 Step 1 Failed" : "⏱️ Step 1 Timed Out")
                            .setDescription(
                                captchaAttempt.status === "max_attempts"
                                    ? `Too many wrong captcha attempts. Run /verify to try again.`
                                    : "You did not complete the captcha verification within the time limit. This check ensures you are not a robot. Please run `/verify` to try again."
                            )
                    ]
                }).catch(() => { });

                await recordVerificationEvent({
                    type: captchaAttempt.status === "max_attempts" ? "failure" : "timeout",
                    userId: member.id,
                    username: member.user.tag,
                    guildId: member.guild.id,
                    guildName: member.guild.name,
                    mode,
                    challengeType: stepTwo.type,
                    reason: captchaAttempt.status === "max_attempts"
                        ? `captcha_max_attempts:${captchaAttempt.wrongAttempts}`
                        : "captcha_timeout"
                }).catch(() => { });
                await applyFailurePenalty(
                    captchaAttempt.status === "max_attempts" ? "captcha_max_attempts" : "captcha_timeout",
                    stepTwo.type
                );
                return;
            }

            await recordVerificationEvent({
                type: "step_captcha_passed",
                userId: member.id,
                username: member.user.tag,
                guildId: member.guild.id,
                guildName: member.guild.name,
                mode,
                challengeType: stepTwo.type
            }).catch(() => { });

            await activeChannel.send({
                embeds: [
                    new EmbedBuilder(baseEmbed)
                        .setTitle("🧠 Final Step")
                        .setDescription(`${stepTwo.question}\n\nReply with your answer.`)
                ]
            }).catch(() => { });

            const stepTwoAttempt = await collectExpectedResponse(
                {
                    channel: activeChannel,
                    memberId: member.id,
                    expectedAnswer: stepTwo.answer,
                    wrongAnswerEmbed: wrongStepTwoEmbed,
                    sessionId: session.sessionId,
                    timeoutMs: CHALLENGE_TIMEOUT,
                    maxWrongAttempts: MAX_WRONG_ATTEMPTS_PER_STEP,
                    cleanupChannelMessages: cleanupFallbackMessages
                }
            );
            if (stepTwoAttempt.status === "timeout" || stepTwoAttempt.status === "max_attempts") {
                await activeChannel.send({
                    embeds: [
                        new EmbedBuilder(baseEmbed)
                            .setColor(0xFAA61A)
                            .setTitle(stepTwoAttempt.status === "max_attempts" ? "🚫 Step 2 Failed" : "⏱️ Step 2 Timed Out")
                            .setDescription(
                                stepTwoAttempt.status === "max_attempts"
                                    ? `Too many wrong final-step attempts. Run /verify to try again.`
                                    : "Final challenge timed out. Run /verify to try again."
                            )
                    ]
                }).catch(() => { });

                await recordVerificationEvent({
                    type: stepTwoAttempt.status === "max_attempts" ? "failure" : "timeout",
                    userId: member.id,
                    username: member.user.tag,
                    guildId: member.guild.id,
                    guildName: member.guild.name,
                    mode,
                    challengeType: stepTwo.type,
                    reason: stepTwoAttempt.status === "max_attempts"
                        ? `challenge_max_attempts:${stepTwoAttempt.wrongAttempts}`
                        : "challenge_timeout"
                }).catch(() => { });
                await applyFailurePenalty(
                    stepTwoAttempt.status === "max_attempts" ? "challenge_max_attempts" : "challenge_timeout",
                    stepTwo.type
                );
                return;
            }

            await recordVerificationEvent({
                type: "step_challenge_passed",
                userId: member.id,
                username: member.user.tag,
                guildId: member.guild.id,
                guildName: member.guild.name,
                mode,
                challengeType: stepTwo.type
            }).catch(() => { });

            const roleObj = member.guild.roles.cache.get(verifiedRoleId);
            if (!roleObj) {
                await recordVerificationEvent({
                    type: "failure",
                    userId: member.id,
                    username: member.user.tag,
                    guildId: member.guild.id,
                    guildName: member.guild.name,
                    mode,
                    challengeType: stepTwo.type,
                    reason: "verified_role_missing"
                }).catch(() => { });
                await applyFailurePenalty("verified_role_missing", stepTwo.type);
                return;
            }

            const roleIssue = getRoleAssignmentIssue(member, roleObj);
            if (roleIssue) {
                await activeChannel.send({
                    embeds: [
                        new EmbedBuilder(baseEmbed)
                            .setColor(0xF04747)
                            .setTitle("❌ Verification Blocked")
                            .setDescription("Verification passed, but role assignment failed. Please contact staff.")
                            .addFields({ name: "Reason", value: roleIssue })
                    ]
                }).catch(() => { });

                await recordVerificationEvent({
                    type: "role_assignment_failed",
                    userId: member.id,
                    username: member.user.tag,
                    guildId: member.guild.id,
                    guildName: member.guild.name,
                    mode,
                    challengeType: stepTwo.type,
                    reason: roleIssue
                }).catch(() => { });

                await recordVerificationEvent({
                    type: "failure",
                    userId: member.id,
                    username: member.user.tag,
                    guildId: member.guild.id,
                    guildName: member.guild.name,
                    mode,
                    challengeType: stepTwo.type,
                    reason: "role_assignment_blocked"
                }).catch(() => { });
                await applyFailurePenalty("role_assignment_blocked", stepTwo.type);
                return;
            }

            await member.roles.add(roleObj);
            registerVerificationSuccess(userId);
            markVerificationCompleted();

            const successEmbed = new EmbedBuilder()
                .setAuthor({ name: `${member.guild.name} Verification System`, iconURL: member.guild.iconURL() })
                .setTitle("✅ Verification Complete!")
                .setColor("#00FF00")
                .setDescription(`🎉 Welcome to ${member.guild.name}!\n\nYou passed multi-step verification and got **${roleObj.name}**.`)
                .setFooter({ text: `${Version} • Thanks for verifying!` })
                .setTimestamp();

            await activeChannel.send({ embeds: [successEmbed] }).catch(() => { });

            const captchaLog = new EmbedBuilder()
                .setAuthor({ name: "Member Verification Log", iconURL: member.user.displayAvatarURL() })
                .setTitle("✅ New Member Verified (Multi-Step)")
                .setDescription(`${member} has successfully completed verification.`)
                .addFields(
                    { name: "👤 User", value: `${member.user.username}\n\`${member.id}\``, inline: true },
                    { name: "🎭 Role Given", value: `${roleObj}`, inline: true },
                    { name: "🧠 Challenge", value: `${stepTwo.type}`, inline: true },
                    { name: "📨 Mode", value: mode, inline: true },
                    { name: "🔑 Captcha Code", value: `\`${captchaCode}\``, inline: true },
                    { name: "⏱️ Duration", value: `${Math.max(1, Math.round((Date.now() - startedAt) / 1000))}s`, inline: true }
                )
                .setColor("#00FF00")
                .setTimestamp();

            if (captchachannel) {
                await captchachannel.send({ embeds: [captchaLog] }).catch(() => { });
            }

            await recordVerificationEvent({
                type: "success",
                userId: member.id,
                username: member.user.tag,
                guildId: member.guild.id,
                guildName: member.guild.name,
                mode,
                challengeType: stepTwo.type,
                durationMs: Date.now() - startedAt
            }).catch(() => { });
        } catch (err) {
            console.error("[Verification] Error in verification process:", err);
            await recordVerificationEvent({
                type: "failure",
                userId: member.id,
                username: member.user.tag,
                guildId: member.guild.id,
                guildName: member.guild.name,
                mode,
                reason: err?.message || "unexpected_error"
            }).catch(() => { });
            await applyFailurePenalty(err?.message || "unexpected_error");
        }
    }
};