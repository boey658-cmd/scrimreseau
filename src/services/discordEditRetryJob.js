import { logger } from '../utils/logger.js';
import {
  classifyDiscordEditError,
  computeNextRetryDelayMs,
} from './discordRetryPolicy.js';
import { runTransientDiscord } from './discordApiGuard.js';
import { applyScrimEmbedEditFromPayload } from './safeDiscordMessageEdit.js';

let jobStarted = false;
let jobShuttingDown = false;
let isPassRunning = false;

/** @type {ReturnType<typeof setInterval> | null} */
let intervalHandle = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string | undefined} raw
 * @param {number} fallbackMinutes
 */
function parseIntervalMinutes(raw, fallbackMinutes) {
  const n = Number(raw?.trim());
  if (!Number.isFinite(n) || n < 1 || n > 60) return fallbackMinutes;
  return Math.floor(n);
}

/**
 * Échec de prefetch (guild / channel / message) : abandon si terminal, sinon même
 * replanification que pour l’édition (attempt_count, next_attempt_at).
 *
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {Record<string, unknown>} row
 * @param {number} id
 * @param {unknown} err
 * @param {'guild' | 'channel' | 'message'} phase
 * @returns {'abandoned' | 'replanified'}
 */
function handlePrefetchFailure(stmts, row, id, err, phase) {
  const c = classifyDiscordEditError(err);
  const now = new Date().toISOString();
  const phaseTag = `prefetch_${phase}`;

  if (c.kind === 'terminal') {
    stmts.markDiscordEditRetryAbandoned.run({
      id,
      abandoned_at: now,
      updated_at: now,
      last_error_code: c.code,
      last_error_message: `${c.message} (${phaseTag})`,
    });
    logger.warn('discordEditRetryJob: abandon (prefetch terminal)', {
      retry_id: id,
      phase: phaseTag,
      error_code: c.code,
      scrim_post_db_id: row.scrim_post_db_id,
    });
    return 'abandoned';
  }

  const prev = Number(row.attempt_count);
  const newCount = prev + 1;
  const nextDelay = computeNextRetryDelayMs(newCount);
  if (newCount >= 5 || nextDelay == null) {
    stmts.markDiscordEditRetryAbandoned.run({
      id,
      abandoned_at: now,
      updated_at: now,
      last_error_code: c.code,
      last_error_message: `${c.message} (${phaseTag}, max tentatives)`,
    });
    logger.warn('discordEditRetryJob: abandon (prefetch max tentatives)', {
      retry_id: id,
      phase: phaseTag,
      attempt_count: newCount,
    });
    return 'abandoned';
  }

  const nextAt = new Date(Date.now() + nextDelay).toISOString();
  stmts.updateDiscordEditRetryAfterFailure.run({
    id,
    attempt_count: newCount,
    next_attempt_at: nextAt,
    last_error_code: c.code,
    last_error_message: `${c.message} (${phaseTag})`,
    updated_at: now,
  });
  logger.warn('discordEditRetryJob: prefetch retryable — replanifié', {
    retry_id: id,
    phase: phaseTag,
    attempt_count: newCount,
    next_attempt_at: nextAt,
    error_code: c.code,
  });
  return 'replanified';
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {import('discord.js').Client} client
 */
export async function runDiscordEditRetryPass(client, stmts) {
  if (jobShuttingDown) {
    return { processed: 0, success: 0, abandoned: 0 };
  }

  const nowIso = new Date().toISOString();
  const rows = stmts.listDueDiscordEditRetries.all({
    now_iso: nowIso,
  });

  let success = 0;
  let abandoned = 0;

  for (let i = 0; i < rows.length; i += 1) {
    if (jobShuttingDown) break;

    const row = rows[i];
    const id = Number(row.id);

    let guild;
    try {
      guild = await runTransientDiscord(
        () => client.guilds.fetch(row.guild_id),
        {
          kind: 'edit_retry_prefetch_guild',
          metadata: { retry_id: id, guild_id: row.guild_id },
        },
      );
    } catch (err) {
      const out = handlePrefetchFailure(stmts, row, id, err, 'guild');
      if (out === 'abandoned') abandoned += 1;
      continue;
    }

    let channel;
    try {
      channel = await runTransientDiscord(
        () => guild.channels.fetch(row.channel_id),
        {
          kind: 'edit_retry_prefetch_channel',
          metadata: { retry_id: id, channel_id: row.channel_id },
        },
      );
    } catch (err) {
      const out = handlePrefetchFailure(stmts, row, id, err, 'channel');
      if (out === 'abandoned') abandoned += 1;
      continue;
    }

    if (!channel.isTextBased()) {
      const now = new Date().toISOString();
      stmts.markDiscordEditRetryAbandoned.run({
        id,
        abandoned_at: now,
        updated_at: now,
        last_error_code: 'PREFETCH',
        last_error_message:
          'Salon non textuel ou type incompatible (prefetch channel)',
      });
      abandoned += 1;
      logger.warn('discordEditRetryJob: abandon (prefetch terminal)', {
        retry_id: id,
        phase: 'prefetch_channel',
        reason: 'not_text_based',
        channel_id: row.channel_id,
      });
      continue;
    }

    let msg;
    try {
      msg = await runTransientDiscord(
        () => channel.messages.fetch(row.message_id),
        {
          kind: 'edit_retry_prefetch_message',
          metadata: { retry_id: id, message_id: row.message_id },
        },
      );
    } catch (err) {
      const out = handlePrefetchFailure(stmts, row, id, err, 'message');
      if (out === 'abandoned') abandoned += 1;
      continue;
    }

    try {
      await applyScrimEmbedEditFromPayload(msg, row.payload_json);
      const resolvedAt = new Date().toISOString();
      stmts.markDiscordEditRetryResolved.run({
        id,
        resolved_at: resolvedAt,
        updated_at: resolvedAt,
      });
      success += 1;
      logger.info('discordEditRetryJob: édition retentée OK', {
        retry_id: id,
        scrim_post_db_id: row.scrim_post_db_id,
      });
    } catch (err) {
      const c = classifyDiscordEditError(err);
      const now = new Date().toISOString();
      if (c.kind === 'terminal') {
        stmts.markDiscordEditRetryAbandoned.run({
          id,
          abandoned_at: now,
          updated_at: now,
          last_error_code: c.code,
          last_error_message: c.message,
        });
        abandoned += 1;
        logger.warn('discordEditRetryJob: abandon (erreur terminal)', {
          retry_id: id,
          error_code: c.code,
        });
      } else {
        const prev = Number(row.attempt_count);
        const newCount = prev + 1;
        const nextDelay = computeNextRetryDelayMs(newCount);
        if (newCount >= 5 || nextDelay == null) {
          stmts.markDiscordEditRetryAbandoned.run({
            id,
            abandoned_at: now,
            updated_at: now,
            last_error_code: c.code,
            last_error_message: `${c.message} (max tentatives)`,
          });
          abandoned += 1;
          logger.warn('discordEditRetryJob: abandon (max tentatives)', {
            retry_id: id,
            attempt_count: newCount,
          });
        } else {
          const nextAt = new Date(Date.now() + nextDelay).toISOString();
          stmts.updateDiscordEditRetryAfterFailure.run({
            id,
            attempt_count: newCount,
            next_attempt_at: nextAt,
            last_error_code: c.code,
            last_error_message: c.message,
            updated_at: now,
          });
          logger.warn('discordEditRetryJob: échec retryable — replanifié', {
            retry_id: id,
            attempt_count: newCount,
            next_attempt_at: nextAt,
          });
        }
      }
    }

    if (i < rows.length - 1) {
      await sleep(75);
    }
  }

  return { processed: rows.length, success, abandoned };
}

/**
 * @returns {{
 *   started: boolean,
 *   shuttingDown: boolean,
 *   passInProgress: boolean,
 *   intervalMinutes: number,
 * }}
 */
export function getDiscordEditRetryJobHealthSnapshot() {
  return {
    started: jobStarted,
    shuttingDown: jobShuttingDown,
    passInProgress: isPassRunning,
    intervalMinutes: parseIntervalMinutes(
      process.env.DISCORD_EDIT_RETRY_INTERVAL_MINUTES,
      2,
    ),
  };
}

/**
 * @param {import('discord.js').Client} client
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 */
export function startDiscordEditRetryJob(client, stmts) {
  if (jobStarted) {
    logger.warn('startDiscordEditRetryJob: déjà démarré, ignoré');
    return;
  }
  jobStarted = true;
  jobShuttingDown = false;

  const minutes = parseIntervalMinutes(
    process.env.DISCORD_EDIT_RETRY_INTERVAL_MINUTES,
    2,
  );
  const intervalMs = minutes * 60 * 1000;

  logger.info('Job retry éditions messages scrim — démarrage', {
    interval_minutes: minutes,
    env_key: 'DISCORD_EDIT_RETRY_INTERVAL_MINUTES',
  });

  const tick = () => {
    if (jobShuttingDown) return;
    if (isPassRunning) {
      try {
        logger.warn('Job retry éditions — tick ignoré (passe déjà en cours)');
      } catch {
        /* ignore */
      }
      return;
    }
    isPassRunning = true;
    void (async () => {
      try {
        await runDiscordEditRetryPass(client, stmts);
      } catch (err) {
        try {
          logger.error('discordEditRetryJob tick', {
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
        } catch {
          /* ignore */
        }
      } finally {
        isPassRunning = false;
      }
    })();
  };

  intervalHandle = setInterval(tick, intervalMs);
  intervalHandle.unref();
  tick();
}

export async function stopDiscordEditRetryJob() {
  jobShuttingDown = true;

  if (intervalHandle != null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }

  const deadline = Date.now() + 10_000;
  while (isPassRunning && Date.now() < deadline) {
    await sleep(50);
  }
  if (isPassRunning) {
    try {
      logger.warn(
        'stopDiscordEditRetryJob: passe encore signalée après attente',
      );
    } catch {
      /* ignore */
    }
  }

  jobStarted = false;

  try {
    logger.info('Job retry éditions messages scrim — arrêté');
  } catch {
    /* ignore */
  }
}
