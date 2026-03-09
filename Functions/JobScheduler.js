// JobScheduler
// Simple scheduler for running background jobs stored in the database.
// It claims due jobs, runs registered handlers, and reschedules recurring work.
const MySQLDatabaseManager = require('./MySQLDatabaseManager');
const { ECONOMY: economyConfigFile } = require('../Config/constants');
const { generateInactiveChannelReport, resolveConfig } = require('./InactiveChannelReporter');
const { runChannelRevival, resolveConfig: resolveRevivalConfig } = require('./ChannelRevival');

const DEFAULT_POLL_INTERVAL_MS = 15000;
const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000;
const PROFILE_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const PROFILE_SYNC_BATCH_SIZE = 25;

function parsePayload(payload) {
    if (!payload) return {};
    if (typeof payload === 'object') return payload;
    try {
        return JSON.parse(payload);
    } catch (_) {
        return {};
    }
}

class JobScheduler {
    constructor(client) {
        this.client = client;
        this.workerId = `worker-${process.pid}`;
        this.handlers = new Map();
        this.timer = null;
        this.running = false;
    }

    register(jobType, handler) {
        if (!jobType || typeof handler !== 'function') return;
        this.handlers.set(jobType, handler);
    }

    async ensureRecurringJob(jobType, payload = {}, intervalMs = 24 * 60 * 60 * 1000) {
        try {
            const existing = await MySQLDatabaseManager.connection.query(
                `SELECT id FROM scheduled_jobs
         WHERE job_type = ? AND status IN ('pending', 'running')
         ORDER BY id DESC LIMIT 1`,
                [jobType]
            );

            if (existing && existing.length > 0) {
                return existing[0].id;
            }

            const runAt = Date.now() + Math.max(60 * 1000, Number(intervalMs) || 24 * 60 * 60 * 1000);
            return await MySQLDatabaseManager.enqueueJob(jobType, {
                ...(payload || {}),
                recurring: true,
                intervalMs: Math.max(60 * 1000, Number(intervalMs) || 24 * 60 * 60 * 1000)
            }, runAt, 5);
        } catch (error) {
            console.error('[JobScheduler] Failed to ensure recurring job:', error.message);
            return null;
        }
    }

    async runJob(job) {
        const payload = parsePayload(job.payload);
        const handler = this.handlers.get(job.job_type);

        if (!handler) {
            await MySQLDatabaseManager.failJob(job.id, `No handler registered for job type: ${job.job_type}`);
            return;
        }

        try {
            await handler({
                client: this.client,
                payload,
                job
            });

            await MySQLDatabaseManager.completeJob(job.id);

            if (payload.recurring && Number(payload.intervalMs) > 0) {
                const nextRunAt = Date.now() + Number(payload.intervalMs);
                await MySQLDatabaseManager.enqueueJob(job.job_type, payload, nextRunAt, Number(job.max_attempts) || 5);
            }
        } catch (error) {
            await MySQLDatabaseManager.failJob(job.id, error.message || 'Job execution failed');
        }
    }

    async tick() {
        if (this.running) return;
        this.running = true;

        try {
            await MySQLDatabaseManager.releaseStaleRunningJobs(DEFAULT_STALE_LOCK_MS);
            const dueJobs = await MySQLDatabaseManager.claimDueJobs(this.workerId, 10);

            for (const job of dueJobs) {
                await this.runJob(job);
            }
        } catch (error) {
            console.error('[JobScheduler] Tick failed:', error.message);
        } finally {
            this.running = false;
        }
    }

    async start() {
        if (this.timer) return;

        this.register('maintenance.cleanup_inactive_jtc', async () => {
            await MySQLDatabaseManager.deleteInactiveJoinToCreate(7);
        });

        this.register('maintenance.inactive_channel_report', async ({ client }) => {
            await generateInactiveChannelReport(client);
        });

        this.register('maintenance.channel_revival', async ({ client }) => {
            await runChannelRevival(client);
        });

        this.register('economy.apply_bank_interest', async () => {
            const config = economyConfigFile?.bankInterest || {};
            if (config.enabled === false) return;

            let guildIds = [];
            try {
                const mainConfig = require('../Config/main.json');
                const configuredGuildId = String(mainConfig?.serverID || '').trim();
                if (configuredGuildId) {
                    guildIds = [configuredGuildId];
                }
            } catch (_) {
                guildIds = [];
            }

            if (!guildIds.length) {
                guildIds = await MySQLDatabaseManager.listEconomyGuilds();
            }

            for (const guildId of guildIds) {
                await MySQLDatabaseManager.applyBankInterest(guildId);
            }
        });

        this.register('userinfo.sync_selected_profiles', async ({ client, payload }) => {
            const intervalMs = Math.max(5 * 60 * 1000, Number(payload?.intervalMs) || PROFILE_SYNC_INTERVAL_MS);
            const staleMs = Math.max(5 * 60 * 1000, Number(payload?.staleMs) || intervalMs);
            const batchSize = Math.max(1, Math.min(100, Number(payload?.batchSize) || PROFILE_SYNC_BATCH_SIZE));

            const dueUsers = await MySQLDatabaseManager.getUsersDueForProfileSync(batchSize, staleMs);
            if (!Array.isArray(dueUsers) || dueUsers.length === 0) return;

            let guild = null;
            if (client) {
                try {
                    const mainConfig = require('../Config/main.json');
                    const configuredGuildId = String(mainConfig?.serverID || '').trim();
                    guild = configuredGuildId
                        ? await client.guilds.fetch(configuredGuildId).catch(() => null)
                        : (client.guilds.cache.first() || null);
                } catch (_) {
                    guild = null;
                }
            }

            for (const row of dueUsers) {
                const userId = String(row?.user_id || '').trim();
                if (!/^\d{17,19}$/.test(userId)) continue;

                let discordUser = null;
                let guildMember = null;
                try {
                    if (client) {
                        discordUser = await client.users.fetch(userId, { force: true }).catch(() => null);
                        if (guild) {
                            guildMember = await guild.members.fetch(userId).catch(() => guild.members.cache.get(userId) || null);
                        }
                    }

                    const bio = typeof discordUser?.bio === 'string' && discordUser.bio.trim()
                        ? discordUser.bio
                        : null;
                    const nickname = typeof guildMember?.nickname === 'string' && guildMember.nickname.trim()
                        ? guildMember.nickname
                        : null;
                    const username = typeof discordUser?.username === 'string' && discordUser.username.trim()
                        ? discordUser.username
                        : (typeof row?.username === 'string' ? row.username : null);

                    await MySQLDatabaseManager.upsertUserProfileSnapshot(userId, {
                        username,
                        nickname,
                        bio,
                        selectedAt: null,
                        syncedAt: Date.now(),
                        enableSync: true
                    });
                } catch (error) {
                    console.error(`[JobScheduler] Failed profile sync for ${userId}:`, error?.message || error);
                    await MySQLDatabaseManager.markUserProfileSynced(userId, Date.now());
                }
            }
        });

        try {
            await MySQLDatabaseManager.connection.query(
                `UPDATE scheduled_jobs
         SET payload = JSON_SET(
           COALESCE(payload, JSON_OBJECT()),
           '$.recurring', true,
           '$.intervalMs', ?,
           '$.staleMs', ?,
           '$.batchSize', ?
         )
         WHERE job_type = 'userinfo.sync_selected_profiles'
           AND status IN ('pending', 'running')`,
                [PROFILE_SYNC_INTERVAL_MS, PROFILE_SYNC_INTERVAL_MS, PROFILE_SYNC_BATCH_SIZE]
            );
        } catch (error) {
            console.warn('[JobScheduler] Failed to normalize existing profile sync jobs:', error.message);
        }

        const { intervalMs: inactiveReportIntervalMs } = resolveConfig();
        const { intervalMs: revivalIntervalMs } = resolveRevivalConfig();
        await this.ensureRecurringJob('maintenance.cleanup_inactive_jtc', { recurring: true, intervalMs: 24 * 60 * 60 * 1000 }, 24 * 60 * 60 * 1000);
        await this.ensureRecurringJob(
            'maintenance.inactive_channel_report',
            { recurring: true, intervalMs: inactiveReportIntervalMs },
            inactiveReportIntervalMs
        );
        await this.ensureRecurringJob(
            'maintenance.channel_revival',
            { recurring: true, intervalMs: revivalIntervalMs },
            revivalIntervalMs
        );
        await this.ensureRecurringJob('userinfo.sync_selected_profiles', {
            recurring: true,
            intervalMs: PROFILE_SYNC_INTERVAL_MS,
            staleMs: PROFILE_SYNC_INTERVAL_MS,
            batchSize: PROFILE_SYNC_BATCH_SIZE
        }, PROFILE_SYNC_INTERVAL_MS);

        const interestIntervalMs = Math.max(60 * 60 * 1000, Number(economyConfigFile?.bankInterest?.intervalMs) || 24 * 60 * 60 * 1000);
        await this.ensureRecurringJob(
            'economy.apply_bank_interest',
            { recurring: true, intervalMs: interestIntervalMs },
            interestIntervalMs
        );

        await this.tick();
        this.timer = setInterval(() => {
            this.tick();
        }, DEFAULT_POLL_INTERVAL_MS);

        console.log(`[JobScheduler] Started with worker ${this.workerId} (poll ${DEFAULT_POLL_INTERVAL_MS / 1000}s)`);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

module.exports = JobScheduler;