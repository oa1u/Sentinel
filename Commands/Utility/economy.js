const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const DatabaseManager = require('../../Functions/MySQLDatabaseManager');
const EconomyActivity = require('../../Events/EconomyActivity');
const { MISC: miscConfig, ECONOMY: economyConfigFile } = require('../../Config/constants');
const { sendErrorReply, sendInfoReply, sendSuccessReply, sendWarningReply } = require('../../Functions/EmbedBuilders');
const RateLimiter = require('../../Functions/RateLimiter');

const economyConfig = miscConfig?.economy || {};
const CURRENCY_NAME = String(economyConfig.currencyName || 'coins');
const CURRENCY_SYMBOL = String(economyConfig.currencySymbol || '🪙');
const DAILY_MIN = Math.max(1, Math.min(1_000_000, Number(economyConfig.dailyMin) || 150));
const DAILY_MAX = Math.max(DAILY_MIN, Math.min(5_000_000, Number(economyConfig.dailyMax) || 300));
const DAILY_COOLDOWN_MS = Math.max(60_000, Math.min(7 * 24 * 60 * 60 * 1000, Number(economyConfig.dailyCooldownMs) || 24 * 60 * 60 * 1000));
const DAILY_STREAK_BONUS_PER_DAY = Math.max(0, Math.min(1, Number(economyConfig.dailyStreakBonusPerDay) || 0));
const DAILY_STREAK_MAX_BONUS = Math.max(0, Math.min(2, Number(economyConfig.dailyStreakMaxBonus) || 0));
const WEEKLY_MIN = Math.max(1, Math.min(5_000_000, Number(economyConfig.weeklyMin) || 800));
const WEEKLY_MAX = Math.max(WEEKLY_MIN, Math.min(10_000_000, Number(economyConfig.weeklyMax) || 1500));
const WEEKLY_COOLDOWN_MS = Math.max(60_000, Math.min(14 * 24 * 60 * 60 * 1000, Number(economyConfig.weeklyCooldownMs) || 7 * 24 * 60 * 60 * 1000));
const WEEKLY_STREAK_BONUS_PER_WEEK = Math.max(0, Math.min(1, Number(economyConfig.weeklyStreakBonusPerWeek) || 0));
const WEEKLY_STREAK_MAX_BONUS = Math.max(0, Math.min(2, Number(economyConfig.weeklyStreakMaxBonus) || 0));
const WORK_MIN = Math.max(1, Math.min(1_000_000, Number(economyConfig.workMin) || 40));
const WORK_MAX = Math.max(WORK_MIN, Math.min(5_000_000, Number(economyConfig.workMax) || 120));
const WORK_COOLDOWN_MS = Math.max(60_000, Math.min(24 * 60 * 60 * 1000, Number(economyConfig.workCooldownMs) || 60 * 60 * 1000));
const MAX_TRANSFER = Math.max(100, Math.min(5_000_000, Number(economyConfig.maxTransfer) || 250_000));
const MAX_MOVE = Math.max(100, Math.min(5_000_000, Number(economyConfig.maxMove) || 1_000_000));
const MAX_GAMBLE = Math.max(100, Math.min(5_000_000, Number(economyConfig.maxGamble) || 200_000));
const GAMBLE_WIN_CHANCE = Math.min(Math.max(Number(economyConfig.gambleWinChance) || 0.45, 0.05), 0.95);
const GAMBLE_MULTIPLIER = Math.min(Math.max(Number(economyConfig.gambleMultiplier) || 2, 1.1), 10);
const GAMBLE_COOLDOWN_MS = Math.max(10_000, Math.min(24 * 60 * 60 * 1000, Number(economyConfig.gambleCooldownMs) || 120_000));
const STATS_FLOW_DAYS = Math.max(1, Math.min(90, Number(economyConfig.statsFlowDays) || 7));
const MAX_ADMIN_ADJUST = Math.max(1_000, Math.min(100_000_000, Number(economyConfig.maxAdminAdjust) || 5_000_000));
const SHOP_ITEMS = Array.isArray(economyConfigFile?.shopItems) ? economyConfigFile.shopItems : [];
const QUEST_DEFS = economyConfigFile?.quests || {};
const RATE_LIMIT_EXEMPT_ROLES = Array.isArray(economyConfig.rateLimitExemptRoles)
    ? economyConfig.rateLimitExemptRoles
    : [];

const formatNumber = typeof EconomyActivity.formatNumber === 'function'
    ? EconomyActivity.formatNumber
    : (num) => Number(num || 0).toLocaleString('en-US');

function formatCooldown(ms) {
    const safeMs = Math.max(0, Number(ms) || 0);
    const totalSeconds = Math.ceil(safeMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || !parts.length) parts.push(`${seconds}s`);
    return parts.join(' ');
}

function getDateKey(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getWeekStartKey(date) {
    const day = date.getUTCDay();
    const diff = (day + 6) % 7;
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    start.setUTCDate(start.getUTCDate() - diff);
    return getDateKey(start);
}

function calculateStreakBonus(streak, perUnit, maxBonus) {
    const bonus = Math.max(0, Math.min(maxBonus, (Number(streak) || 0) * perUnit));
    return 1 + bonus;
}

function getShopItem(itemId) {
    return SHOP_ITEMS.find((item) => String(item.id) === String(itemId));
}

function formatItemLine(item) {
    const price = moneyLine(item.price || 0);
    return `• **${item.name}** (${item.id}) — ${price}\n${item.description}`;
}

function getQuestList(cadence) {
    if (cadence === 'weekly') {
        return Array.isArray(QUEST_DEFS.weekly) ? QUEST_DEFS.weekly : [];
    }
    return Array.isArray(QUEST_DEFS.daily) ? QUEST_DEFS.daily : [];
}

const moneyLine = typeof EconomyActivity.moneyLine === 'function'
    ? EconomyActivity.moneyLine
    : (amount) => `${CURRENCY_SYMBOL} **${formatNumber(amount)}** ${CURRENCY_NAME}`;

function formatTxType(txType) {
    return String(txType || 'unknown')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

function resolveAmountInput(input, available, maxCap) {
    const safeAvailable = Math.max(0, Number(available) || 0);
    const safeCap = Math.max(1, Number(maxCap) || 1);
    const raw = String(input || '').trim().toLowerCase();

    if (!raw) return { ok: false, code: 'invalid_amount' };

    let amount = 0;
    if (raw === 'all' || raw === 'max') {
        amount = safeAvailable;
    } else if (/^\d+%$/.test(raw)) {
        const percent = Math.max(1, Math.min(100, Number(raw.replace('%', '')) || 0));
        amount = Math.floor((safeAvailable * percent) / 100);
    } else if (/^\d+$/.test(raw)) {
        amount = Number(raw);
    } else {
        return { ok: false, code: 'invalid_amount' };
    }

    if (!Number.isFinite(amount) || amount <= 0) {
        return { ok: false, code: 'invalid_amount' };
    }

    if (amount > safeCap) {
        return { ok: false, code: 'over_cap', maxCap: safeCap };
    }

    if (amount > safeAvailable) {
        return { ok: false, code: 'insufficient_available', available: safeAvailable };
    }

    return { ok: true, amount };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('economy')
        .setDescription('Economy system commands')
        .addSubcommand((subcommand) =>
            subcommand
                .setName('balance')
                .setDescription('View your or another user\'s balance')
                .addUserOption((option) =>
                    option
                        .setName('user')
                        .setDescription('User to check (defaults to you)')
                        .setRequired(false)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('daily')
                .setDescription('Claim your daily reward')
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('weekly')
                .setDescription('Claim your weekly reward')
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('work')
                .setDescription('Work for some coins')
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('pay')
                .setDescription('Send coins from your wallet to another user')
                .addUserOption((option) =>
                    option
                        .setName('user')
                        .setDescription('User to pay')
                        .setRequired(true)
                )
                .addIntegerOption((option) =>
                    option
                        .setName('amount')
                        .setDescription(`Amount to send (max ${MAX_TRANSFER.toLocaleString()})`)
                        .setRequired(true)
                        .setMinValue(1)
                        .setMaxValue(MAX_TRANSFER)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('deposit')
                .setDescription('Move coins from wallet to bank')
                .addStringOption((option) =>
                    option
                        .setName('amount')
                        .setDescription('Amount: number, %, or all (e.g., 500, 50%, all)')
                        .setRequired(true)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('withdraw')
                .setDescription('Move coins from bank to wallet')
                .addStringOption((option) =>
                    option
                        .setName('amount')
                        .setDescription('Amount: number, %, or all (e.g., 500, 50%, all)')
                        .setRequired(true)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('gamble')
                .setDescription('Risk wallet coins for a chance to win more')
                .addStringOption((option) =>
                    option
                        .setName('amount')
                        .setDescription('Wager: number, %, or all (e.g., 250, 25%, all)')
                        .setRequired(true)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('quests')
                .setDescription('View daily and weekly economy quests')
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('quest-claim')
                .setDescription('Claim a completed quest reward')
                .addStringOption((option) =>
                    option
                        .setName('quest')
                        .setDescription('Quest key to claim')
                        .setRequired(true)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('shop')
                .setDescription('View economy shop items')
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('buy')
                .setDescription('Buy an item from the shop')
                .addStringOption((option) =>
                    option
                        .setName('item')
                        .setDescription('Item ID to purchase')
                        .setRequired(true)
                )
                .addIntegerOption((option) =>
                    option
                        .setName('quantity')
                        .setDescription('Quantity to purchase')
                        .setRequired(false)
                        .setMinValue(1)
                        .setMaxValue(25)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('inventory')
                .setDescription('View your economy inventory')
                .addUserOption((option) =>
                    option
                        .setName('user')
                        .setDescription('User to check (defaults to you)')
                        .setRequired(false)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('use')
                .setDescription('Use an item from your inventory')
                .addStringOption((option) =>
                    option
                        .setName('item')
                        .setDescription('Item ID to use')
                        .setRequired(true)
                )
                .addIntegerOption((option) =>
                    option
                        .setName('quantity')
                        .setDescription('Quantity to use')
                        .setRequired(false)
                        .setMinValue(1)
                        .setMaxValue(10)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('leaderboard')
                .setDescription('Top economy users in this server')
                .addIntegerOption((option) =>
                    option
                        .setName('limit')
                        .setDescription('How many users to show (1-20)')
                        .setRequired(false)
                        .setMinValue(1)
                        .setMaxValue(20)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('stats')
                .setDescription('View advanced economy analytics for a user')
                .addUserOption((option) =>
                    option
                        .setName('user')
                        .setDescription('User to check (defaults to you)')
                        .setRequired(false)
                )
        )
        .addSubcommandGroup((group) =>
            group
                .setName('admin')
                .setDescription('Admin economy controls')
                .addSubcommand((subcommand) =>
                    subcommand
                        .setName('set')
                        .setDescription('Set a user wallet/bank amount')
                        .addUserOption((option) =>
                            option
                                .setName('user')
                                .setDescription('User to modify')
                                .setRequired(true)
                        )
                        .addStringOption((option) =>
                            option
                                .setName('account')
                                .setDescription('Which account to change')
                                .setRequired(true)
                                .addChoices(
                                    { name: 'Wallet', value: 'wallet' },
                                    { name: 'Bank', value: 'bank' }
                                )
                        )
                        .addIntegerOption((option) =>
                            option
                                .setName('amount')
                                .setDescription(`Amount to set (0-${MAX_ADMIN_ADJUST.toLocaleString()})`)
                                .setRequired(true)
                                .setMinValue(0)
                                .setMaxValue(MAX_ADMIN_ADJUST)
                        )
                        .addStringOption((option) =>
                            option
                                .setName('reason')
                                .setDescription('Optional reason for audit trail')
                                .setRequired(false)
                                .setMaxLength(200)
                        )
                )
                .addSubcommand((subcommand) =>
                    subcommand
                        .setName('add')
                        .setDescription('Add to a user wallet/bank amount')
                        .addUserOption((option) =>
                            option
                                .setName('user')
                                .setDescription('User to modify')
                                .setRequired(true)
                        )
                        .addStringOption((option) =>
                            option
                                .setName('account')
                                .setDescription('Which account to change')
                                .setRequired(true)
                                .addChoices(
                                    { name: 'Wallet', value: 'wallet' },
                                    { name: 'Bank', value: 'bank' }
                                )
                        )
                        .addIntegerOption((option) =>
                            option
                                .setName('amount')
                                .setDescription(`Amount to add (1-${MAX_ADMIN_ADJUST.toLocaleString()})`)
                                .setRequired(true)
                                .setMinValue(1)
                                .setMaxValue(MAX_ADMIN_ADJUST)
                        )
                        .addStringOption((option) =>
                            option
                                .setName('reason')
                                .setDescription('Optional reason for audit trail')
                                .setRequired(false)
                                .setMaxLength(200)
                        )
                )
                .addSubcommand((subcommand) =>
                    subcommand
                        .setName('remove')
                        .setDescription('Remove from a user wallet/bank amount')
                        .addUserOption((option) =>
                            option
                                .setName('user')
                                .setDescription('User to modify')
                                .setRequired(true)
                        )
                        .addStringOption((option) =>
                            option
                                .setName('account')
                                .setDescription('Which account to change')
                                .setRequired(true)
                                .addChoices(
                                    { name: 'Wallet', value: 'wallet' },
                                    { name: 'Bank', value: 'bank' }
                                )
                        )
                        .addIntegerOption((option) =>
                            option
                                .setName('amount')
                                .setDescription(`Amount to remove (1-${MAX_ADMIN_ADJUST.toLocaleString()})`)
                                .setRequired(true)
                                .setMinValue(1)
                                .setMaxValue(MAX_ADMIN_ADJUST)
                        )
                        .addStringOption((option) =>
                            option
                                .setName('reason')
                                .setDescription('Optional reason for audit trail')
                                .setRequired(false)
                                .setMaxLength(200)
                        )
                )
        )
        .addSubcommandGroup((group) =>
            group
                .setName('bounty')
                .setDescription('Economy bounty board')
                .addSubcommand((subcommand) =>
                    subcommand
                        .setName('list')
                        .setDescription('List open bounties')
                )
                .addSubcommand((subcommand) =>
                    subcommand
                        .setName('create')
                        .setDescription('Create a new bounty')
                        .addStringOption((option) =>
                            option
                                .setName('title')
                                .setDescription('Bounty title')
                                .setRequired(true)
                                .setMaxLength(120)
                        )
                        .addIntegerOption((option) =>
                            option
                                .setName('reward')
                                .setDescription('Reward amount')
                                .setRequired(true)
                                .setMinValue(1)
                                .setMaxValue(100000000)
                        )
                        .addStringOption((option) =>
                            option
                                .setName('description')
                                .setDescription('Optional details for the bounty')
                                .setRequired(false)
                                .setMaxLength(1000)
                        )
                )
                .addSubcommand((subcommand) =>
                    subcommand
                        .setName('award')
                        .setDescription('Award a bounty to a user')
                        .addIntegerOption((option) =>
                            option
                                .setName('id')
                                .setDescription('Bounty ID')
                                .setRequired(true)
                                .setMinValue(1)
                        )
                        .addUserOption((option) =>
                            option
                                .setName('user')
                                .setDescription('User to award')
                                .setRequired(true)
                        )
                        .addStringOption((option) =>
                            option
                                .setName('note')
                                .setDescription('Optional award note')
                                .setRequired(false)
                                .setMaxLength(255)
                        )
                )
                .addSubcommand((subcommand) =>
                    subcommand
                        .setName('close')
                        .setDescription('Close an open bounty')
                        .addIntegerOption((option) =>
                            option
                                .setName('id')
                                .setDescription('Bounty ID')
                                .setRequired(true)
                                .setMinValue(1)
                        )
                        .addStringOption((option) =>
                            option
                                .setName('reason')
                                .setDescription('Reason for closing the bounty')
                                .setRequired(false)
                                .setMaxLength(255)
                        )
                )
        ),
    category: 'utility',
    async execute(interaction) {
        if (!interaction.guild || !interaction.member) {
            return interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
        }

        const subcommand = interaction.options.getSubcommand();
        const subcommandGroup = interaction.options.getSubcommandGroup(false);

        const rateLimitKey = `economy:${subcommandGroup ? `${subcommandGroup}:${subcommand}` : subcommand}`;
        const isExempt = RateLimiter.isExempt(interaction.member, RATE_LIMIT_EXEMPT_ROLES);
        if (!isExempt) {
            const limitStatus = RateLimiter.checkLimit(interaction.user.id, rateLimitKey);
            if (limitStatus.limited) {
                return sendWarningReply(
                    interaction,
                    'Slow Down',
                    `You are using economy commands too quickly. Try again in **${limitStatus.retryAfter}s**.`
                );
            }
            RateLimiter.recordUsage(interaction.user.id, rateLimitKey);
        }

        if (subcommandGroup === 'bounty') {
            const action = subcommand;
            const needsManage = ['create', 'award', 'close'].includes(action);

            if (needsManage && !interaction.member.permissions?.has(PermissionFlagsBits.ManageGuild) && !interaction.member.permissions?.has(PermissionFlagsBits.Administrator)) {
                return sendWarningReply(interaction, 'Missing Permission', 'You need `Manage Server` permission to manage bounties.');
            }

            if (action === 'list') {
                const rows = await DatabaseManager.listEconomyBounties(interaction.guildId, 'open', 10);
                if (!rows.length) {
                    return sendInfoReply(interaction, 'Bounty Board', 'No open bounties right now.');
                }

                const lines = rows.map((row) => {
                    return `• **#${row.bounty_id}** — ${row.title} (${moneyLine(row.reward_amount)})`;
                });

                const embed = new EmbedBuilder()
                    .setColor(0x1e1f22)
                    .setTitle('🎯 Open Bounties')
                    .setDescription(lines.join('\n'))
                    .setFooter({ text: `Requested by ${interaction.user.tag}` })
                    .setTimestamp();

                return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
            }

            if (action === 'create') {
                const title = interaction.options.getString('title', true);
                const reward = interaction.options.getInteger('reward', true);
                const description = interaction.options.getString('description') || null;

                const bountyId = await DatabaseManager.createEconomyBounty(
                    interaction.guildId,
                    interaction.user.id,
                    title,
                    description,
                    reward
                );

                if (!bountyId) {
                    return sendErrorReply(interaction, 'Bounty Create Failed', 'Could not create the bounty right now.');
                }

                return sendSuccessReply(
                    interaction,
                    'Bounty Created',
                    `Bounty **#${bountyId}** created for ${moneyLine(reward)}.`
                );
            }

            if (action === 'award') {
                const bountyId = interaction.options.getInteger('id', true);
                const targetUser = interaction.options.getUser('user', true);
                const note = interaction.options.getString('note') || null;

                if (targetUser.bot) {
                    return sendWarningReply(interaction, 'Invalid User', 'You cannot award bounties to bots.');
                }

                const result = await DatabaseManager.awardEconomyBounty(
                    interaction.guildId,
                    bountyId,
                    targetUser.id,
                    interaction.user.id,
                    note
                );

                if (!result?.ok && result?.code === 'not_open') {
                    return sendWarningReply(interaction, 'Bounty Closed', 'That bounty is not open anymore.');
                }

                if (!result?.ok) {
                    return sendErrorReply(interaction, 'Bounty Award Failed', 'Could not award that bounty right now.');
                }

                return sendSuccessReply(
                    interaction,
                    'Bounty Awarded',
                    `${targetUser} received ${moneyLine(result.reward)} for bounty **#${bountyId}**.`
                );
            }

            if (action === 'close') {
                const bountyId = interaction.options.getInteger('id', true);
                const reason = interaction.options.getString('reason') || null;
                const result = await DatabaseManager.closeEconomyBounty(
                    interaction.guildId,
                    bountyId,
                    interaction.user.id,
                    reason
                );

                if (!result?.ok) {
                    return sendErrorReply(interaction, 'Bounty Close Failed', 'Could not close that bounty right now.');
                }

                return sendSuccessReply(
                    interaction,
                    'Bounty Closed',
                    `Bounty **#${bountyId}** has been closed.`
                );
            }
        }

        if (subcommandGroup === 'admin') {
            if (!interaction.member.permissions?.has(PermissionFlagsBits.ManageGuild) && !interaction.member.permissions?.has(PermissionFlagsBits.Administrator)) {
                return sendWarningReply(interaction, 'Missing Permission', 'You need `Manage Server` permission to use economy admin actions.');
            }

            const targetUser = interaction.options.getUser('user', true);
            const account = interaction.options.getString('account', true);
            const amount = interaction.options.getInteger('amount', true);
            const reason = interaction.options.getString('reason') || null;

            if (targetUser.bot) {
                return sendWarningReply(interaction, 'Invalid User', 'You cannot modify bot economy balances.');
            }

            const adjustResult = await DatabaseManager.adminAdjustEconomyBalance(
                interaction.guildId,
                targetUser.id,
                amount,
                {
                    scope: account,
                    mode: subcommand,
                    actorId: interaction.user.id,
                    reason
                }
            );

            if (!adjustResult?.ok && adjustResult?.code === 'insufficient_funds') {
                return sendWarningReply(
                    interaction,
                    'Insufficient Funds',
                    `${targetUser} only has ${moneyLine(adjustResult.currentValue || 0)} in ${account}.`
                );
            }

            if (!adjustResult?.ok) {
                return sendErrorReply(interaction, 'Admin Economy Action Failed', 'Could not apply that balance change right now.');
            }

            const delta = Number(adjustResult.delta || 0);
            const deltaText = `${delta >= 0 ? '+' : '-'}${moneyLine(Math.abs(delta))}`;

            return sendSuccessReply(
                interaction,
                'Admin Economy Update Applied',
                `${targetUser} ${subcommand} ${account} completed.\nChange: ${deltaText}\nWallet: ${moneyLine(adjustResult.balance.wallet)}\nBank: ${moneyLine(adjustResult.balance.bank)}${reason ? `\nReason: ${reason}` : ''}`,
                { ephemeral: false }
            );
        }

        if (subcommand === 'balance') {
            const targetUser = interaction.options.getUser('user') || interaction.user;
            const balance = await DatabaseManager.getEconomyBalance(interaction.guildId, targetUser.id);

            return sendInfoReply(
                interaction,
                'Economy Balance',
                `${targetUser} has:\n• Wallet: ${moneyLine(balance.wallet)}\n• Bank: ${moneyLine(balance.bank)}\n• Total: ${moneyLine(balance.total)}`,
                {
                    fields: [
                        { name: 'Total Earned', value: moneyLine(balance.totalEarned), inline: true },
                        { name: 'Total Spent', value: moneyLine(balance.totalSpent), inline: true }
                    ]
                }
            );
        }

        if (subcommand === 'daily') {
            const now = new Date();
            const lastDailyClaimMs = await DatabaseManager.getLastEconomyTransaction(interaction.guildId, interaction.user.id, 'daily_reward');
            const lastDailyKey = lastDailyClaimMs ? getDateKey(new Date(lastDailyClaimMs)) : null;
            const todayKey = getDateKey(now);
            const yesterdayKey = getDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
            const twoDaysKey = getDateKey(new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000));

            let continuesStreak = lastDailyKey === yesterdayKey;
            let freezeUsed = false;
            if (!continuesStreak && lastDailyKey === twoDaysKey) {
                const freeze = await DatabaseManager.consumeEconomyBoost(interaction.guildId, interaction.user.id, 'streak_freeze');
                if (freeze) {
                    continuesStreak = true;
                    freezeUsed = true;
                }
            }

            let currentStreak = 0;
            if (continuesStreak) {
                const dailyDates = await DatabaseManager.getEconomyClaimDates(interaction.guildId, interaction.user.id, 'daily_reward', 90);
                if (dailyDates.length) {
                    currentStreak = 1;
                    const oneDayMs = 24 * 60 * 60 * 1000;
                    for (let i = 1; i < dailyDates.length; i++) {
                        if (dailyDates[i] === dailyDates[i - 1] - oneDayMs) {
                            currentStreak++;
                        } else {
                            break;
                        }
                    }
                }
            }

            const nextStreak = continuesStreak ? currentStreak + 1 : 1;
            const streakMultiplier = calculateStreakBonus(Math.max(0, nextStreak - 1), DAILY_STREAK_BONUS_PER_DAY, DAILY_STREAK_MAX_BONUS);

            const result = await DatabaseManager.claimEconomyReward(interaction.guildId, interaction.user.id, {
                rewardType: 'daily_reward',
                minReward: Math.round(DAILY_MIN * streakMultiplier),
                maxReward: Math.round(DAILY_MAX * streakMultiplier),
                cooldownMs: DAILY_COOLDOWN_MS,
                note: 'Daily reward claim'
            });

            if (!result?.ok && result?.code === 'cooldown') {
                return sendWarningReply(
                    interaction,
                    'Daily Cooldown',
                    `You already claimed your daily reward. Try again in **${formatCooldown(result.retryAfterMs)}**.`
                );
            }

            if (!result?.ok) {
                return sendErrorReply(interaction, 'Daily Failed', 'Could not process your daily reward right now.');
            }

            let boostNote = '';
            const dailyBoost = await DatabaseManager.consumeEconomyBoost(interaction.guildId, interaction.user.id, 'daily_boost');
            if (dailyBoost && dailyBoost > 1) {
                const bonusAmount = Math.max(1, Math.round(result.amount * (dailyBoost - 1)));
                await DatabaseManager.awardEconomyActivity(interaction.guildId, interaction.user.id, bonusAmount, {
                    txType: 'boost_bonus',
                    note: 'Daily boost bonus'
                });
                boostNote = `\nBoost bonus: ${moneyLine(bonusAmount)}`;
            }

            DatabaseManager.updateEconomyQuestProgress(interaction.guildId, interaction.user.id, 'daily_claim', 1).catch(() => { });

            const streakText = `Daily streak: **${formatNumber(nextStreak)}** day(s)`;
            const freezeText = freezeUsed ? '\nStreak freeze consumed to keep your streak alive.' : '';

            return sendSuccessReply(
                interaction,
                'Daily Claimed',
                `You received ${moneyLine(result.amount)}!${boostNote}\n${streakText}${freezeText}\nNew wallet balance: ${moneyLine(result.balance.wallet)}`,
                { ephemeral: false }
            );
        }

        if (subcommand === 'weekly') {
            const now = new Date();
            const lastWeeklyClaimMs = await DatabaseManager.getLastEconomyTransaction(interaction.guildId, interaction.user.id, 'weekly_reward');
            const lastWeeklyKey = lastWeeklyClaimMs ? getWeekStartKey(new Date(lastWeeklyClaimMs)) : null;
            const lastWeekKey = getWeekStartKey(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));

            const continuesStreak = lastWeeklyKey === lastWeekKey;
            const stats = await DatabaseManager.getEconomyStats(interaction.guildId, interaction.user.id, { daysWindow: STATS_FLOW_DAYS, recentTxLimit: 5 });
            const currentStreak = continuesStreak ? Number(stats?.currentWeeklyStreak || 0) : 0;
            const nextStreak = continuesStreak ? currentStreak + 1 : 1;
            const streakMultiplier = calculateStreakBonus(Math.max(0, nextStreak - 1), WEEKLY_STREAK_BONUS_PER_WEEK, WEEKLY_STREAK_MAX_BONUS);

            const result = await DatabaseManager.claimEconomyReward(interaction.guildId, interaction.user.id, {
                rewardType: 'weekly_reward',
                minReward: Math.round(WEEKLY_MIN * streakMultiplier),
                maxReward: Math.round(WEEKLY_MAX * streakMultiplier),
                cooldownMs: WEEKLY_COOLDOWN_MS,
                note: 'Weekly reward claim'
            });

            if (!result?.ok && result?.code === 'cooldown') {
                return sendWarningReply(
                    interaction,
                    'Weekly Cooldown',
                    `You already claimed your weekly reward. Try again in **${formatCooldown(result.retryAfterMs)}**.`
                );
            }

            if (!result?.ok) {
                return sendErrorReply(interaction, 'Weekly Failed', 'Could not process your weekly reward right now.');
            }

            DatabaseManager.updateEconomyQuestProgress(interaction.guildId, interaction.user.id, 'weekly_claim', 1).catch(() => { });

            const streakText = `Weekly streak: **${formatNumber(nextStreak)}** week(s)`;
            return sendSuccessReply(
                interaction,
                'Weekly Claimed',
                `You received ${moneyLine(result.amount)}!\n${streakText}\nNew wallet balance: ${moneyLine(result.balance.wallet)}`,
                { ephemeral: false }
            );
        }

        if (subcommand === 'work') {
            const jobs = ['Developer', 'Designer', 'Courier', 'Moderator', 'Trader', 'Chef', 'Builder'];
            const pickedJob = jobs[Math.floor(Math.random() * jobs.length)];

            const result = await DatabaseManager.claimEconomyReward(interaction.guildId, interaction.user.id, {
                rewardType: 'work_reward',
                minReward: WORK_MIN,
                maxReward: WORK_MAX,
                cooldownMs: WORK_COOLDOWN_MS,
                note: `Worked as ${pickedJob}`
            });

            if (!result?.ok && result?.code === 'cooldown') {
                return sendWarningReply(
                    interaction,
                    'Work Cooldown',
                    `You need to rest before working again. Try in **${formatCooldown(result.retryAfterMs)}**.`
                );
            }

            if (!result?.ok) {
                return sendErrorReply(interaction, 'Work Failed', 'Could not process work reward right now.');
            }

            let boostNote = '';
            const workBoost = await DatabaseManager.consumeEconomyBoost(interaction.guildId, interaction.user.id, 'work_boost');
            if (workBoost && workBoost > 1) {
                const bonusAmount = Math.max(1, Math.round(result.amount * (workBoost - 1)));
                await DatabaseManager.awardEconomyActivity(interaction.guildId, interaction.user.id, bonusAmount, {
                    txType: 'boost_bonus',
                    note: 'Work boost bonus'
                });
                boostNote = `\nBoost bonus: ${moneyLine(bonusAmount)}`;
            }

            DatabaseManager.updateEconomyQuestProgress(interaction.guildId, interaction.user.id, 'work', 1).catch(() => { });

            return sendSuccessReply(
                interaction,
                'Work Complete',
                `You worked as **${pickedJob}** and earned ${moneyLine(result.amount)}.${boostNote}\nWallet: ${moneyLine(result.balance.wallet)}`,
                { ephemeral: false }
            );
        }

        if (subcommand === 'pay') {
            const targetUser = interaction.options.getUser('user', true);
            const amount = interaction.options.getInteger('amount', true);

            if (targetUser.id === interaction.user.id) {
                return sendWarningReply(interaction, 'Invalid Payment', 'You cannot pay yourself.');
            }

            if (targetUser.bot) {
                return sendWarningReply(interaction, 'Invalid Payment', 'You cannot pay bots.');
            }

            const transfer = await DatabaseManager.transferEconomy(interaction.guildId, interaction.user.id, targetUser.id, amount);

            if (!transfer?.ok && transfer?.code === 'insufficient_funds') {
                const senderBalance = await DatabaseManager.getEconomyBalance(interaction.guildId, interaction.user.id);
                return sendWarningReply(
                    interaction,
                    'Insufficient Funds',
                    `You don't have enough in your wallet to send that amount.\nYour wallet: ${moneyLine(senderBalance.wallet)}`
                );
            }

            if (!transfer?.ok) {
                return sendErrorReply(interaction, 'Payment Failed', 'Could not complete that transfer right now.');
            }

            DatabaseManager.updateEconomyQuestProgress(interaction.guildId, interaction.user.id, 'pay_amount', transfer.amount).catch(() => { });

            return sendSuccessReply(
                interaction,
                'Payment Sent',
                `${interaction.user} sent ${moneyLine(transfer.amount)} to ${targetUser}.\nYour wallet: ${moneyLine(transfer.fromBalance.wallet)}`,
                { ephemeral: false }
            );
        }

        if (subcommand === 'deposit' || subcommand === 'withdraw') {
            const amountInput = interaction.options.getString('amount', true);
            const direction = subcommand === 'deposit' ? 'deposit' : 'withdraw';
            const sourceKey = direction === 'deposit' ? 'wallet' : 'bank';

            const balance = await DatabaseManager.getEconomyBalance(interaction.guildId, interaction.user.id);
            const parsed = resolveAmountInput(amountInput, balance[sourceKey], MAX_MOVE);

            if (!parsed.ok && parsed.code === 'invalid_amount') {
                return sendWarningReply(
                    interaction,
                    'Invalid Amount',
                    'Use a positive number, `%` value, or `all` (example: `500`, `25%`, `all`).'
                );
            }

            if (!parsed.ok && parsed.code === 'over_cap') {
                return sendWarningReply(
                    interaction,
                    'Amount Too High',
                    `Maximum per ${direction} is ${moneyLine(parsed.maxCap)}.`
                );
            }

            if (!parsed.ok && parsed.code === 'insufficient_available') {
                return sendWarningReply(
                    interaction,
                    direction === 'deposit' ? 'Insufficient Wallet Funds' : 'Insufficient Bank Funds',
                    `Available ${sourceKey}: ${moneyLine(parsed.available)}`
                );
            }

            const moveResult = await DatabaseManager.moveEconomyFunds(interaction.guildId, interaction.user.id, parsed.amount, direction);

            if (!moveResult?.ok && (moveResult?.code === 'insufficient_wallet' || moveResult?.code === 'insufficient_bank')) {
                const freshBalance = await DatabaseManager.getEconomyBalance(interaction.guildId, interaction.user.id);
                const key = moveResult.code === 'insufficient_wallet' ? 'wallet' : 'bank';
                return sendWarningReply(interaction, 'Insufficient Funds', `Available ${key}: ${moneyLine(freshBalance[key])}`);
            }

            if (!moveResult?.ok) {
                return sendErrorReply(interaction, `${direction === 'deposit' ? 'Deposit' : 'Withdraw'} Failed`, 'Could not move funds right now.');
            }

            return sendSuccessReply(
                interaction,
                direction === 'deposit' ? 'Deposit Complete' : 'Withdraw Complete',
                `${direction === 'deposit' ? 'Deposited' : 'Withdrew'} ${moneyLine(moveResult.amount)}.\nWallet: ${moneyLine(moveResult.balance.wallet)}\nBank: ${moneyLine(moveResult.balance.bank)}`,
                { ephemeral: false }
            );
        }

        if (subcommand === 'gamble') {
            const amountInput = interaction.options.getString('amount', true);
            const balance = await DatabaseManager.getEconomyBalance(interaction.guildId, interaction.user.id);
            const parsed = resolveAmountInput(amountInput, balance.wallet, MAX_GAMBLE);

            if (!parsed.ok && parsed.code === 'invalid_amount') {
                return sendWarningReply(
                    interaction,
                    'Invalid Wager',
                    'Use a positive number, `%` value, or `all` (example: `250`, `25%`, `all`).'
                );
            }

            if (!parsed.ok && parsed.code === 'over_cap') {
                return sendWarningReply(
                    interaction,
                    'Wager Too High',
                    `Maximum gamble amount is ${moneyLine(parsed.maxCap)}.`
                );
            }

            if (!parsed.ok && parsed.code === 'insufficient_available') {
                return sendWarningReply(
                    interaction,
                    'Insufficient Wallet Funds',
                    `Available wallet: ${moneyLine(parsed.available)}`
                );
            }

            const gambleResult = await DatabaseManager.gambleEconomy(interaction.guildId, interaction.user.id, parsed.amount, {
                winChance: GAMBLE_WIN_CHANCE,
                multiplier: GAMBLE_MULTIPLIER,
                cooldownMs: GAMBLE_COOLDOWN_MS
            });

            if (!gambleResult?.ok && gambleResult?.code === 'cooldown') {
                return sendWarningReply(
                    interaction,
                    'Gamble Cooldown',
                    `You can gamble again in **${formatCooldown(gambleResult.retryAfterMs)}**.`
                );
            }

            if (!gambleResult?.ok && gambleResult?.code === 'insufficient_funds') {
                const freshBalance = await DatabaseManager.getEconomyBalance(interaction.guildId, interaction.user.id);
                return sendWarningReply(interaction, 'Insufficient Wallet Funds', `Available wallet: ${moneyLine(freshBalance.wallet)}`);
            }

            if (!gambleResult?.ok) {
                return sendErrorReply(interaction, 'Gamble Failed', 'Could not complete your gamble right now.');
            }

            DatabaseManager.updateEconomyQuestProgress(interaction.guildId, interaction.user.id, 'gamble_wager', gambleResult.wager).catch(() => { });

            if (gambleResult.isWin) {
                return sendSuccessReply(
                    interaction,
                    'You Won! 🎉',
                    `Wager: ${moneyLine(gambleResult.wager)}\nPayout: ${moneyLine(gambleResult.payout)}\nNet: ${moneyLine(gambleResult.netChange)}\nWallet: ${moneyLine(gambleResult.balance.wallet)}`,
                    { ephemeral: false }
                );
            }

            return sendWarningReply(
                interaction,
                'You Lost 💸',
                `Wager: ${moneyLine(gambleResult.wager)}\nLoss: ${moneyLine(Math.abs(gambleResult.netChange))}\nWallet: ${moneyLine(gambleResult.balance.wallet)}`,
                { ephemeral: false }
            );
        }

        if (subcommand === 'quests') {
            const [dailyProgress, weeklyProgress] = await Promise.all([
                DatabaseManager.getEconomyQuestProgress(interaction.guildId, interaction.user.id, 'daily'),
                DatabaseManager.getEconomyQuestProgress(interaction.guildId, interaction.user.id, 'weekly')
            ]);

            const dailyMap = new Map((dailyProgress || []).map((row) => [row.quest_key, row]));
            const weeklyMap = new Map((weeklyProgress || []).map((row) => [row.quest_key, row]));

            const dailyQuests = getQuestList('daily');
            const weeklyQuests = getQuestList('weekly');

            const dailyLines = dailyQuests.length
                ? dailyQuests.map((quest) => {
                    const progressRow = dailyMap.get(quest.key);
                    const progress = Number(progressRow?.progress || 0);
                    const target = Math.max(1, Number(quest.target) || 1);
                    const status = progress >= target ? '✅' : '⬜';
                    return `${status} **${quest.title}** (${quest.key}) — ${progress}/${target} • Reward: ${moneyLine(quest.reward || 0)}`;
                }).join('\n')
                : 'No daily quests configured.';

            const weeklyLines = weeklyQuests.length
                ? weeklyQuests.map((quest) => {
                    const progressRow = weeklyMap.get(quest.key);
                    const progress = Number(progressRow?.progress || 0);
                    const target = Math.max(1, Number(quest.target) || 1);
                    const status = progress >= target ? '✅' : '⬜';
                    return `${status} **${quest.title}** (${quest.key}) — ${progress}/${target} • Reward: ${moneyLine(quest.reward || 0)}`;
                }).join('\n')
                : 'No weekly quests configured.';

            const embed = new EmbedBuilder()
                .setColor(0x1e1f22)
                .setTitle('🗺️ Economy Quests')
                .addFields(
                    { name: 'Daily', value: dailyLines, inline: false },
                    { name: 'Weekly', value: weeklyLines, inline: false }
                )
                .setFooter({ text: `Claim rewards with /economy quest-claim <quest>` })
                .setTimestamp();

            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        if (subcommand === 'quest-claim') {
            const questKey = interaction.options.getString('quest', true);
            const result = await DatabaseManager.claimEconomyQuest(interaction.guildId, interaction.user.id, questKey);

            if (!result?.ok && result?.code === 'unknown_quest') {
                return sendWarningReply(interaction, 'Unknown Quest', 'That quest key does not exist.');
            }

            if (!result?.ok && result?.code === 'incomplete') {
                return sendWarningReply(interaction, 'Quest Incomplete', 'That quest is not complete yet.');
            }

            if (!result?.ok && result?.code === 'already_claimed') {
                return sendWarningReply(interaction, 'Already Claimed', 'You already claimed that quest reward.');
            }

            if (!result?.ok) {
                return sendErrorReply(interaction, 'Quest Claim Failed', 'Could not claim that quest reward right now.');
            }

            return sendSuccessReply(
                interaction,
                'Quest Reward Claimed',
                `You received ${moneyLine(result.reward)}.\nWallet: ${moneyLine(result.balance.wallet)}`
            );
        }

        if (subcommand === 'shop') {
            if (!SHOP_ITEMS.length) {
                return sendInfoReply(interaction, 'Shop', 'No shop items are configured yet.');
            }

            const lines = SHOP_ITEMS.map(formatItemLine);
            const embed = new EmbedBuilder()
                .setColor(0x1e1f22)
                .setTitle('🛒 Economy Shop')
                .setDescription(lines.join('\n\n'))
                .setFooter({ text: `Use /economy buy <item> to purchase.` })
                .setTimestamp();

            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        if (subcommand === 'buy') {
            const itemId = interaction.options.getString('item', true);
            const quantity = interaction.options.getInteger('quantity') || 1;
            const item = getShopItem(itemId);

            if (!item) {
                return sendWarningReply(interaction, 'Unknown Item', 'That item ID does not exist in the shop.');
            }

            const totalPrice = Math.max(1, Math.round(Number(item.price || 0) * quantity));
            const spendResult = await DatabaseManager.spendEconomyFunds(
                interaction.guildId,
                interaction.user.id,
                totalPrice,
                'shop_purchase',
                `Purchased ${quantity}x ${item.id}`
            );

            if (!spendResult?.ok && spendResult?.code === 'insufficient_funds') {
                const balance = await DatabaseManager.getEconomyBalance(interaction.guildId, interaction.user.id);
                return sendWarningReply(
                    interaction,
                    'Insufficient Funds',
                    `You need ${moneyLine(totalPrice)} but only have ${moneyLine(balance.wallet)} in your wallet.`
                );
            }

            if (!spendResult?.ok) {
                return sendErrorReply(interaction, 'Purchase Failed', 'Could not complete that purchase right now.');
            }

            await DatabaseManager.addEconomyInventoryItem(interaction.guildId, interaction.user.id, item.id, quantity);

            return sendSuccessReply(
                interaction,
                'Purchase Complete',
                `Purchased **${quantity}x ${item.name}** for ${moneyLine(totalPrice)}.\nWallet: ${moneyLine(spendResult.balance.wallet)}`
            );
        }

        if (subcommand === 'inventory') {
            const targetUser = interaction.options.getUser('user') || interaction.user;
            const rows = await DatabaseManager.getEconomyInventory(interaction.guildId, targetUser.id);

            if (!rows.length) {
                return sendInfoReply(interaction, 'Inventory', `${targetUser} has no items yet.`);
            }

            const lines = rows.map((row) => {
                const item = getShopItem(row.item_id);
                const name = item ? item.name : row.item_id;
                return `• **${name}** (${row.item_id}) — x${formatNumber(row.quantity)}`;
            });

            const embed = new EmbedBuilder()
                .setColor(0x1e1f22)
                .setTitle('🎒 Inventory')
                .setDescription(lines.join('\n'))
                .setFooter({ text: `Requested by ${interaction.user.tag}` })
                .setTimestamp();

            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        if (subcommand === 'use') {
            const itemId = interaction.options.getString('item', true);
            const quantity = interaction.options.getInteger('quantity') || 1;
            const item = getShopItem(itemId);

            if (!item) {
                return sendWarningReply(interaction, 'Unknown Item', 'That item ID does not exist in the shop.');
            }

            const consumeResult = await DatabaseManager.consumeEconomyInventoryItem(
                interaction.guildId,
                interaction.user.id,
                item.id,
                quantity
            );

            if (!consumeResult?.ok && consumeResult?.code === 'insufficient_items') {
                return sendWarningReply(
                    interaction,
                    'Not Enough Items',
                    `You only have **${formatNumber(consumeResult.available || 0)}** of ${item.name}.`
                );
            }

            if (!consumeResult?.ok) {
                return sendErrorReply(interaction, 'Item Use Failed', 'Could not use that item right now.');
            }

            const meta = item.meta || {};
            let appliedText = '';
            const expiresAt = meta.expiresMs ? Date.now() + Number(meta.expiresMs) : 0;
            const uses = Math.max(1, Number(meta.uses) || 1) * quantity;

            if (item.type === 'work_boost') {
                await DatabaseManager.addEconomyBoost(
                    interaction.guildId,
                    interaction.user.id,
                    'work_boost',
                    Number(meta.multiplier) || 1.5,
                    uses,
                    expiresAt
                );
                appliedText = `Applied a work boost (${Number(meta.multiplier) || 1.5}x).`;
            } else if (item.type === 'daily_boost') {
                await DatabaseManager.addEconomyBoost(
                    interaction.guildId,
                    interaction.user.id,
                    'daily_boost',
                    Number(meta.multiplier) || 1.4,
                    uses,
                    expiresAt
                );
                appliedText = `Applied a daily boost (${Number(meta.multiplier) || 1.4}x).`;
            } else if (item.type === 'streak_freeze') {
                await DatabaseManager.addEconomyBoost(
                    interaction.guildId,
                    interaction.user.id,
                    'streak_freeze',
                    1,
                    uses,
                    expiresAt
                );
                appliedText = 'Streak freeze added to your account.';
            } else {
                await DatabaseManager.addEconomyInventoryItem(interaction.guildId, interaction.user.id, item.id, quantity);
                return sendWarningReply(interaction, 'Unsupported Item', 'That item cannot be used yet.');
            }

            return sendSuccessReply(
                interaction,
                'Item Used',
                `${appliedText}\nRemaining: **${formatNumber(consumeResult.remaining || 0)}** ${item.name}`
            );
        }

        if (subcommand === 'leaderboard') {
            const limit = interaction.options.getInteger('limit') || Number(economyConfig.leaderboardLimit) || 10;
            const rows = await DatabaseManager.getEconomyLeaderboard(interaction.guildId, limit);

            if (!rows.length) {
                return sendInfoReply(interaction, 'Economy Leaderboard', 'No economy activity yet in this server.');
            }

            const lines = rows.map((row, index) => {
                return `**#${index + 1}** <@${row.user_id}> — ${moneyLine(row.total)}`;
            });

            const embed = new EmbedBuilder()
                .setColor(0x1e1f22)
                .setTitle('🏆 Economy Leaderboard')
                .setDescription(lines.join('\n'))
                .setFooter({ text: `Requested by ${interaction.user.tag}` })
                .setTimestamp();

            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        if (subcommand === 'stats') {
            const targetUser = interaction.options.getUser('user') || interaction.user;
            const [balance, stats] = await Promise.all([
                DatabaseManager.getEconomyBalance(interaction.guildId, targetUser.id),
                DatabaseManager.getEconomyStats(interaction.guildId, targetUser.id, { daysWindow: STATS_FLOW_DAYS, recentTxLimit: 20 })
            ]);

            if (!stats) {
                return sendErrorReply(interaction, 'Stats Unavailable', 'Could not load economy statistics right now.');
            }

            const topTypesText = stats.topTypes.length
                ? stats.topTypes.map((entry) => `• ${formatTxType(entry.type)} — **${formatNumber(entry.count)}**`).join('\n')
                : 'No transaction data yet.';

            const recentText = stats.recentTransactions.length
                ? stats.recentTransactions
                    .slice(0, 5)
                    .map((tx) => {
                        const sign = tx.amount >= 0 ? '+' : '-';
                        const absAmount = Math.abs(tx.amount);
                        const ts = tx.createdAtMs > 0 ? `<t:${Math.floor(tx.createdAtMs / 1000)}:R>` : 'Unknown';
                        return `• ${formatTxType(tx.type)}: ${sign}${CURRENCY_SYMBOL}${formatNumber(absAmount)} (${ts})`;
                    })
                    .join('\n')
                : 'No recent transactions.';

            const statsEmbed = new EmbedBuilder()
                .setColor(0x1e1f22)
                .setTitle('📊 Economy Analytics')
                .setDescription(`Stats for ${targetUser}`)
                .addFields(
                    {
                        name: 'Balances',
                        value: `Wallet: ${moneyLine(balance.wallet)}\nBank: ${moneyLine(balance.bank)}\nTotal: ${moneyLine(balance.total)}`,
                        inline: true
                    },
                    {
                        name: 'Lifetime Flow',
                        value: `In: ${moneyLine(stats.totalIn)}\nOut: ${moneyLine(stats.totalOut)}\nTransactions: **${formatNumber(stats.txCount)}**`,
                        inline: true
                    },
                    {
                        name: `Net (${stats.netFlowWindowDays}d)`,
                        value: `${stats.netFlowWindow >= 0 ? '+' : '-'}${moneyLine(Math.abs(stats.netFlowWindow))}`,
                        inline: true
                    },
                    {
                        name: 'Daily Streak',
                        value: `Current: **${formatNumber(stats.currentDailyStreak)}** day(s)\nBest: **${formatNumber(stats.bestDailyStreak)}** day(s)`,
                        inline: true
                    },
                    {
                        name: 'Weekly Streak',
                        value: `Current: **${formatNumber(stats.currentWeeklyStreak || 0)}** week(s)\nBest: **${formatNumber(stats.bestWeeklyStreak || 0)}** week(s)`,
                        inline: true
                    },
                    {
                        name: 'Top Transaction Types',
                        value: topTypesText,
                        inline: true
                    },
                    {
                        name: 'Recent Activity',
                        value: recentText,
                        inline: false
                    }
                )
                .setFooter({ text: `Requested by ${interaction.user.tag}` })
                .setTimestamp();

            return interaction.reply({ embeds: [statsEmbed], flags: MessageFlags.Ephemeral });
        }
    }
};