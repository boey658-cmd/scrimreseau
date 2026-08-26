import { logger } from '../utils/logger.js';
import { runTransientDiscord } from './discordApiGuard.js';
import {
  classifyDiscordDeleteError,
  completeScrimLifecycleDeleteSuccess,
  recoverScrimLifecycleDeleteOperationsAtStartup,
  scheduleScrimLifecycleDeleteRetry,
  skipScrimLifecycleDeleteIfAlreadyMarked,
} from './scrimLifecycleDeleteRetry.js';
import {
  markScrimLifecycleOperationFailedTerminal,
  markScrimLifecycleOperationProcessing,
} from './scrimLifecycleOperationStore.js';

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
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {Record<string, unknown>} row
 * @param {number} id
 * @param {unknown} err
 * @param {'guild' | 'channel' | 'message'} phase
 * @returns {'terminal' | 'replanified'}
 */
function handleDeletePrefetchFailure(stmts, row, id, err, phase) {
  const c = classifyDiscordDeleteError(err);
  const phaseTag = `prefetch_${phase}`;

  if (c.kind === 'already_gone') {
    completeScrimLifecycleDeleteSuccess(
      stmts,
      id,
      {
        guild_id: /** @type {string} */ (row.guild_id),
        channel_id: /** @type {string} */ (row.channel_id),
        message_id: /** @type {string} */ (row.message_id),
      },
      { phase: phaseTag },
    );
    return 'terminal';
  }

  if (c.kind === 'terminal') {
    markScrimLifecycleOperationFailedTerminal(
      stmts,
      id,
      c.code,
      `${c.message} (${phaseTag})`,
    );
    try {
      logger.info('scrimLifecycleDelete: terminal', {
        lifecycle_operation_id: id,
        phase: phaseTag,
        error_code: c.code,
        scrim_post_db_id: row.scrim_post_db_id,
      });
    } catch {
      /* ignore */
    }
    return 'terminal';
  }

  const out = scheduleScrimLifecycleDeleteRetry(
    stmts,
    id,
    c.code,
    `${c.message} (${phaseTag})`,
  );
  return out === 'terminal' ? 'terminal' : 'replanified';
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {import('discord.js').Client} client
 */
export async function runDiscordDeleteRetryPass(client, stmts) {
  if (jobShuttingDown) {
    return { processed: 0, success: 0, terminal: 0, replanified: 0 };
  }

  const nowIso = new Date().toISOString();
  const rows = stmts.listDueScrimLifecycleDeleteOperations.all({ now_iso: nowIso });

  let success = 0;
  let terminal = 0;
  let replanified = 0;

  for (let i = 0; i < rows.length; i += 1) {
    if (jobShuttingDown) break;

    const row = rows[i];
    const id = Number(row.id);

    if (row.status === 'cancelled' || row.status === 'completed' || row.status === 'failed_terminal') {
      continue;
    }

    if (skipScrimLifecycleDeleteIfAlreadyMarked(stmts, row)) {
      success += 1;
      continue;
    }

    markScrimLifecycleOperationProcessing(stmts, id);

    let guild;
    try {
      guild = await runTransientDiscord(
        () => client.guilds.fetch(/** @type {string} */ (row.guild_id)),
        {
          kind: 'delete_retry_prefetch_guild',
          metadata: { operation_id: id, guild_id: row.guild_id },
        },
      );
    } catch (err) {
      const out = handleDeletePrefetchFailure(stmts, row, id, err, 'guild');
      if (out === 'terminal') terminal += 1;
      else replanified += 1;
      continue;
    }

    let channel;
    try {
      channel = await runTransientDiscord(
        () => guild.channels.fetch(/** @type {string} */ (row.channel_id)),
        {
          kind: 'delete_retry_prefetch_channel',
          metadata: { operation_id: id, channel_id: row.channel_id },
        },
      );
    } catch (err) {
      const out = handleDeletePrefetchFailure(stmts, row, id, err, 'channel');
      if (out === 'terminal') terminal += 1;
      else replanified += 1;
      continue;
    }

    if (!channel.isTextBased()) {
      markScrimLifecycleOperationFailedTerminal(
        stmts,
        id,
        'PREFETCH',
        'Salon non textuel (prefetch channel)',
      );
      terminal += 1;
      continue;
    }

    let msg;
    try {
      msg = await runTransientDiscord(
        () => channel.messages.fetch(/** @type {string} */ (row.message_id)),
        {
          kind: 'delete_retry_prefetch_message',
          metadata: { operation_id: id, message_id: row.message_id },
        },
      );
    } catch (err) {
      const out = handleDeletePrefetchFailure(stmts, row, id, err, 'message');
      if (out === 'terminal') terminal += 1;
      else replanified += 1;
      continue;
    }

    try {
      await runTransientDiscord(
        () => msg.delete(),
        {
          kind: 'scrim_lifecycle_delete_retry',
          metadata: {
            operation_id: id,
            scrim_post_db_id: row.scrim_post_db_id,
            message_id: row.message_id,
          },
        },
      );
      completeScrimLifecycleDeleteSuccess(
        stmts,
        id,
        {
          guild_id: /** @type {string} */ (row.guild_id),
          channel_id: /** @type {string} */ (row.channel_id),
          message_id: /** @type {string} */ (row.message_id),
        },
        { attempt_count: row.attempt_count },
      );
      success += 1;
    } catch (err) {
      const c = classifyDiscordDeleteError(err);
      if (c.kind === 'already_gone') {
        completeScrimLifecycleDeleteSuccess(
          stmts,
          id,
          {
            guild_id: /** @type {string} */ (row.guild_id),
            channel_id: /** @type {string} */ (row.channel_id),
            message_id: /** @type {string} */ (row.message_id),
          },
          { error_code: c.code, attempt_count: row.attempt_count },
        );
        success += 1;
      } else if (c.kind === 'terminal') {
        markScrimLifecycleOperationFailedTerminal(stmts, id, c.code, c.message);
        try {
          logger.info('scrimLifecycleDelete: terminal', {
            lifecycle_operation_id: id,
            scrim_post_db_id: row.scrim_post_db_id,
            guild_id: row.guild_id,
            channel_id: row.channel_id,
            message_id: row.message_id,
            attempt_count: row.attempt_count,
            error_code: c.code,
          });
        } catch {
          /* ignore */
        }
        terminal += 1;
      } else {
        const out = scheduleScrimLifecycleDeleteRetry(stmts, id, c.code, c.message);
        if (out === 'terminal') terminal += 1;
        else replanified += 1;
      }
    }

    if (i < rows.length - 1) {
      await sleep(75);
    }
  }

  return { processed: rows.length, success, terminal, replanified };
}

/**
 * @returns {{
 *   started: boolean,
 *   shuttingDown: boolean,
 *   passInProgress: boolean,
 *   intervalMinutes: number,
 * }}
 */
export function getDiscordDeleteRetryJobHealthSnapshot() {
  return {
    started: jobStarted,
    shuttingDown: jobShuttingDown,
    passInProgress: isPassRunning,
    intervalMinutes: parseIntervalMinutes(
      process.env.DISCORD_DELETE_RETRY_INTERVAL_MINUTES,
      2,
    ),
  };
}

/**
 * @param {import('discord.js').Client} client
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 */
export function startDiscordDeleteRetryJob(_client, _stmts) {
  if (jobStarted) {
    logger.warn('startDiscordDeleteRetryJob: déjà démarré, ignoré');
    return;
  }
  jobStarted = true;
  jobShuttingDown = false;
  try {
    logger.info('discordDeleteRetryJob: deprecated — dispatcher lifecycle 3F actif');
  } catch {
    /* ignore */
  }
}

export async function stopDiscordDeleteRetryJob() {
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
        'stopDiscordDeleteRetryJob: passe encore signalée après attente',
      );
    } catch {
      /* ignore */
    }
  }

  jobStarted = false;

  try {
    logger.info('Job retry suppressions messages scrim — arrêté');
  } catch {
    /* ignore */
  }
}
