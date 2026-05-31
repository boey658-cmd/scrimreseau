import { logger } from '../utils/logger.js';
import { runPlayerSearchExpirationPass } from '../services/playerSearchLifecycle.js';

let jobStarted = false;
let isPassRunning = false;
let jobShuttingDown = false;

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
 * @param {ReturnType<import('../database/db.js')['preparePlayerSearchStatements']>} playerSearchStmts
 */
export async function stopPlayerSearchExpirationJob() {
  jobShuttingDown = true;

  if (intervalHandle != null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (firstPassHandle != null) {
    clearTimeout(firstPassHandle);
    firstPassHandle = null;
  }

  const deadline = Date.now() + 10_000;
  while (isPassRunning && Date.now() < deadline) {
    await sleep(50);
  }

  jobStarted = false;
  logger.info('player_search_expiration_job stop');
}

/**
 * @param {import('discord.js').Client} client
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('../database/db.js')['preparePlayerSearchStatements']>} playerSearchStmts
 */
export function startPlayerSearchExpirationJob(client, db, playerSearchStmts) {
  if (jobStarted) {
    logger.warn('player_search_expiration_job: déjà démarré, ignoré');
    return;
  }
  jobStarted = true;
  jobShuttingDown = false;

  const minutes = parseIntervalMinutes(
    process.env.PLAYER_SEARCH_EXPIRATION_CHECK_INTERVAL_MINUTES,
    30,
  );
  const intervalMs = minutes * 60 * 1000;

  logger.info('player_search_expiration_job start', {
    interval_minutes: minutes,
    env_key: 'PLAYER_SEARCH_EXPIRATION_CHECK_INTERVAL_MINUTES',
    first_pass_delay_ms: 15_000,
  });

  const tick = () => {
    if (jobShuttingDown) return;
    if (isPassRunning) {
      logger.warn('player_search_expiration_job — tick ignoré (passe en cours)');
      return;
    }
    isPassRunning = true;
    void (async () => {
      try {
        const result = await runPlayerSearchExpirationPass(
          client,
          db,
          playerSearchStmts,
        );
        logger.info('player_search_expiration_job done', {
          expired_closed: result.count,
          candidates: result.candidates,
        });
      } catch (err) {
        logger.error('player_search_expiration_job tick', {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      } finally {
        isPassRunning = false;
      }
    })();
  };

  intervalHandle = setInterval(tick, intervalMs);
  firstPassHandle = setTimeout(tick, 15_000);
}
