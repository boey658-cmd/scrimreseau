import { logger } from '../utils/logger.js';
import {
  closeScrimPostByDbIdAndSyncMessages,
  findExpiredActiveScrimCandidates,
} from './scrimLifecycle.js';

let jobStarted = false;
/** Indique si une passe `runScrimExpirationPass` est déjà en cours (évite les ticks concurrents). */
let isExpirationPassRunning = false;
/** True dès que l’arrêt du job est demandé — ignore les ticks tardifs et les entrées dans la passe. */
let expirationJobShuttingDown = false;

/** @type {ReturnType<typeof setInterval> | null} */
let intervalHandle = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let firstPassHandle = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string | undefined} raw
 * @param {number} fallback
 */
function parseIntervalMinutes(raw, fallback) {
  const n = Number(raw?.trim());
  if (!Number.isFinite(n) || n < 1 || n > 24 * 60) return fallback;
  return Math.floor(n);
}

/**
 * @param {import('discord.js').Client} client
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 */
export async function runScrimExpirationPass(client, db, stmts) {
  if (expirationJobShuttingDown) {
    return { count: 0 };
  }

  const nowIso = new Date().toISOString();
  const candidates = findExpiredActiveScrimCandidates(stmts, nowIso);
  if (candidates.length === 0) return { count: 0 };

  let closed = 0;
  for (const { id, missingSchedule } of candidates) {
    const closeReason = missingSchedule ? 'expired_missing_schedule' : 'expired';
    try {
      if (missingSchedule) {
        logger.warn('runScrimExpirationPass: fermeture défensive (scheduled_at absent)', {
          scrim_post_db_id: id,
          closed_reason: closeReason,
        });
      }
      const ok = await closeScrimPostByDbIdAndSyncMessages(
        client,
        db,
        stmts,
        id,
        'closed_expired',
        closeReason,
      );
      if (ok) closed += 1;
    } catch (err) {
      logger.error('runScrimExpirationPass: fermeture scrim', {
        scrim_post_db_id: id,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }

  if (closed > 0) {
    logger.event('runScrimExpirationPass', {
      expired_closed: closed,
      candidates: candidates.length,
    });
  }
  return { count: closed, candidates: candidates.length };
}

/**
 * Arrête les timers, marque l’arrêt, attend la fin de la passe en cours (best-effort) avant retour.
 * À appeler **avant** `closeDb()` au shutdown.
 */
/**
 * Instantané read-only pour diagnostics (ex. /scrim-dev health).
 * @returns {{
 *   started: boolean,
 *   shuttingDown: boolean,
 *   passInProgress: boolean,
 *   intervalMinutes: number,
 * }}
 */
export function getScrimExpirationJobHealthSnapshot() {
  return {
    started: jobStarted,
    shuttingDown: expirationJobShuttingDown,
    passInProgress: isExpirationPassRunning,
    intervalMinutes: parseIntervalMinutes(
      process.env.SCRIM_EXPIRATION_CHECK_INTERVAL_MINUTES,
      30,
    ),
  };
}

export async function stopScrimExpirationJob() {
  expirationJobShuttingDown = true;

  if (intervalHandle != null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (firstPassHandle != null) {
    clearTimeout(firstPassHandle);
    firstPassHandle = null;
  }

  const deadline = Date.now() + 10_000;
  while (isExpirationPassRunning && Date.now() < deadline) {
    await sleep(50);
  }
  if (isExpirationPassRunning) {
    try {
      logger.warn(
        'stopScrimExpirationJob: une passe est encore signalée en cours après attente (suite du shutdown)',
      );
    } catch {
      /* ignore */
    }
  }

  jobStarted = false;

  try {
    logger.info('Job expiration scrims — arrêté');
  } catch {
    /* ignore */
  }
}

/**
 * @param {import('discord.js').Client} client
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 */
export function startScrimExpirationJob(client, db, stmts) {
  if (jobStarted) {
    logger.warn('startScrimExpirationJob: déjà démarré, ignoré');
    return;
  }
  jobStarted = true;
  expirationJobShuttingDown = false;

  const minutes = parseIntervalMinutes(
    process.env.SCRIM_EXPIRATION_CHECK_INTERVAL_MINUTES,
    30,
  );
  const intervalMs = minutes * 60 * 1000;

  logger.info('Job expiration scrims — démarrage', {
    interval_minutes: minutes,
    env_key: 'SCRIM_EXPIRATION_CHECK_INTERVAL_MINUTES',
    first_pass_delay_ms: 15_000,
  });

  const tick = () => {
    if (expirationJobShuttingDown) {
      return;
    }
    if (isExpirationPassRunning) {
      try {
        logger.warn('Job expiration scrims — tick ignoré (passe déjà en cours)');
      } catch {
        /* ne pas faire échouer le timer */
      }
      return;
    }
    isExpirationPassRunning = true;
    void (async () => {
      try {
        await runScrimExpirationPass(client, db, stmts);
      } catch (err) {
        try {
          logger.error('scrimExpirationJob tick', {
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
        } catch {
          /* ignore */
        }
      } finally {
        isExpirationPassRunning = false;
      }
    })();
  };

  intervalHandle = setInterval(tick, intervalMs);
  // Le WebSocket du client Discord maintient le process en vie ; unref évite que ce seul timer bloque une sortie propre / certains tests.
  intervalHandle.unref();
  firstPassHandle = setTimeout(tick, 15_000);
  firstPassHandle.unref();
}
