import { logger } from '../utils/logger.js';
import { executeRepostCycleForScrim, recoverIncompleteRepostCycles } from './scrimRepostCycle.js';

let jobStarted = false;
let jobShuttingDown = false;
let isPassRunning = false;

/** @type {ReturnType<typeof setInterval> | null} */
let intervalHandle = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let firstPassHandle = null;

/** Reposts max traités par passe (limite spike Discord au déploiement bêta). */
export const SCRIM_REPOST_MAX_PER_PASS = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string | undefined} raw
 * @param {number} fallback
 */
function parseIntervalMinutes(raw, fallback) {
  const n = Number(raw?.trim());
  if (!Number.isFinite(n) || n < 1 || n > 60) return fallback;
  return Math.floor(n);
}

/**
 * @param {string | undefined} raw
 * @param {number} fallbackHours
 */
export function parseRepostIntervalHours(raw, fallbackHours = 24) {
  const n = Number(raw?.trim());
  if (!Number.isFinite(n) || n < 1 || n > 24 * 7) return fallbackHours;
  return Math.floor(n);
}

/**
 * @param {string | undefined} raw
 */
export function isScrimRepostEnabled(raw = process.env.SCRIM_REPOST_ENABLED) {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return true;
}

/**
 * Instant ISO UTC : maintenant − intervalle repost (heures).
 * @param {number} [nowMs]
 * @param {number} [intervalHours]
 */
export function computeRepostCutoffIso(nowMs = Date.now(), intervalHours = 24) {
  const cutoffMs = nowMs - intervalHours * 60 * 60 * 1000;
  return new Date(cutoffMs).toISOString();
}

/**
 * @param {import('discord.js').Client} client
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 */
export async function runScrimRepostPass(client, db, stmts) {
  if (jobShuttingDown || !isScrimRepostEnabled()) {
    return { candidates: 0, reposted: 0, skipped: 0 };
  }

  const intervalHours = parseRepostIntervalHours(
    process.env.SCRIM_REPOST_INTERVAL_HOURS,
    24,
  );
  const maxPerPass = SCRIM_REPOST_MAX_PER_PASS;
  const cutoffIso = computeRepostCutoffIso(Date.now(), intervalHours);

  const candidates = stmts.findActiveScrimPostsDueForRepost.all({
    cutoff_iso: cutoffIso,
    max_per_pass: maxPerPass,
  });

  if (candidates.length === 0) {
    return { candidates: 0, reposted: 0, skipped: 0 };
  }

  logger.info('scrimRepost: passe — candidats', {
    count: candidates.length,
    cutoff_iso: cutoffIso,
    interval_hours: intervalHours,
    max_per_pass: maxPerPass,
  });

  let reposted = 0;
  let skipped = 0;

  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    const dbId = Number(c.id);
    if (i > 0) await sleep(150);

    try {
      const result = await executeRepostCycleForScrim(client, db, stmts, dbId);
      if (result.ok) {
        reposted += 1;
      } else {
        skipped += 1;
      }
    } catch (err) {
      skipped += 1;
      logger.error('scrimRepost: erreur sur un scrim', {
        scrim_post_db_id: dbId,
        scrim_public_id: c.scrim_public_id,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }

  if (reposted > 0) {
    logger.event('runScrimRepostPass', {
      reposted,
      skipped,
      candidates: candidates.length,
    });
  }

  return { candidates: candidates.length, reposted, skipped };
}

/**
 * @returns {{
 *   started: boolean,
 *   shuttingDown: boolean,
 *   passInProgress: boolean,
 *   enabled: boolean,
 *   intervalMinutes: number,
 *   intervalHours: number,
 *   maxPerPass: number,
 * }}
 */
export function getScrimRepostJobHealthSnapshot() {
  return {
    started: jobStarted,
    shuttingDown: jobShuttingDown,
    passInProgress: isPassRunning,
    enabled: isScrimRepostEnabled(),
    intervalMinutes: parseIntervalMinutes(
      process.env.SCRIM_REPOST_CHECK_INTERVAL_MINUTES,
      10,
    ),
    intervalHours: parseRepostIntervalHours(
      process.env.SCRIM_REPOST_INTERVAL_HOURS,
      24,
    ),
    maxPerPass: SCRIM_REPOST_MAX_PER_PASS,
  };
}

export async function stopScrimRepostJob() {
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
  if (isPassRunning) {
    try {
      logger.warn(
        'stopScrimRepostJob: passe encore signalée après attente (suite du shutdown)',
      );
    } catch {
      /* ignore */
    }
  }

  jobStarted = false;

  try {
    logger.info('Job repost scrims — arrêté');
  } catch {
    /* ignore */
  }
}

/**
 * @param {import('discord.js').Client} client
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 */
export function startScrimRepostJob(client, db, stmts) {
  if (jobStarted) {
    logger.warn('startScrimRepostJob: déjà démarré, ignoré');
    return;
  }
  if (!isScrimRepostEnabled()) {
    logger.info('Job repost scrims — désactivé (SCRIM_REPOST_ENABLED)', {
      env_key: 'SCRIM_REPOST_ENABLED',
    });
    return;
  }

  jobStarted = true;
  jobShuttingDown = false;

  const minutes = parseIntervalMinutes(
    process.env.SCRIM_REPOST_CHECK_INTERVAL_MINUTES,
    10,
  );
  const intervalMs = minutes * 60 * 1000;
  const intervalHours = parseRepostIntervalHours(
    process.env.SCRIM_REPOST_INTERVAL_HOURS,
    24,
  );

  logger.info('Job repost scrims — démarrage', {
    interval_minutes: minutes,
    env_check_interval: 'SCRIM_REPOST_CHECK_INTERVAL_MINUTES',
    interval_hours: intervalHours,
    env_interval_hours: 'SCRIM_REPOST_INTERVAL_HOURS',
    max_per_pass: SCRIM_REPOST_MAX_PER_PASS,
    first_pass_delay_ms: 20_000,
  });

  void (async () => {
    try {
      await recoverIncompleteRepostCycles(client, db, stmts);
    } catch (err) {
      try {
        logger.error('scrimRepostJob: recovery cycles incomplets', {
          message: err instanceof Error ? err.message : String(err),
        });
      } catch {
        /* ignore */
      }
    }
  })();

  const tick = () => {
    if (jobShuttingDown || !isScrimRepostEnabled()) return;
    if (isPassRunning) {
      try {
        logger.warn('Job repost scrims — tick ignoré (passe déjà en cours)');
      } catch {
        /* ignore */
      }
      return;
    }
    isPassRunning = true;
    void (async () => {
      try {
        await runScrimRepostPass(client, db, stmts);
      } catch (err) {
        try {
          logger.error('scrimRepostJob tick', {
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
  firstPassHandle = setTimeout(tick, 20_000);
  firstPassHandle.unref();
}
