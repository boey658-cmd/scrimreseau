import { logger } from '../utils/logger.js';
import {
  executeOrchestratedLifecycleOperation,
} from './scrimLifecycleOrchestrator.js';
import {
  parseScrimLifecycleConcurrency,
  SCRIM_LIFECYCLE_CONCURRENCY_DEFAULT,
} from './scrimLifecycleConcurrency.js';
import {
  SCRIM_LIFECYCLE_STARVATION_BURST_AFTER_HIGH,
  SCRIM_LIFECYCLE_STARVATION_THRESHOLD_MS,
  isHighTierLifecycleOp,
  isStarvedLifecycleOp,
} from './scrimLifecyclePriority.js';
import { recoverScrimLifecycleDeleteOperationsAtStartup } from './scrimLifecycleDeleteRetry.js';
import {
  markScrimLifecycleOperationCompleted,
  markScrimLifecycleOperationFailedTerminal,
} from './scrimLifecycleOperationStore.js';
import { scheduleScrimLifecycleEditRetry } from './scrimLifecycleEditRetry.js';
import { scheduleScrimLifecycleDeleteRetry } from './scrimLifecycleDeleteRetry.js';
import { classifyDiscordEditError } from './discordRetryPolicy.js';
import {
  SCRIM_LIFECYCLE_MAX_ATTEMPTS,
  terminalizeExhaustedScrimLifecycleOperations,
} from './scrimLifecycleAttempts.js';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { completeScrimLifecycleDeleteSuccess } from './scrimLifecycleDeleteRetry.js';

let dispatcherStarted = false;
let dispatcherShuttingDown = false;
/** @type {number} */
let activeWorkers = 0;
/** @type {boolean} */
let dispatcherPassInProgress = false;
/** @type {Promise<void> | null} */
let wakeResolve = null;

/** @type {import('discord.js').Client | null} */
let boundClient = null;
/** @type {ReturnType<import('../database/db.js')['prepareStatements']> | null} */
let boundStmts = null;

/** HIGH consécutifs servis depuis le dernier slot starved forcé (Phase 3H M1). */
let consecutiveHighTierClaims = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string | undefined} raw
 * @param {number} fallbackMinutes
 */
function parsePollIntervalMinutes(raw, fallbackMinutes) {
  const n = Number(raw?.trim());
  if (!Number.isFinite(n) || n < 1 || n > 60) return fallbackMinutes;
  return Math.floor(n);
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @returns {number}
 */
export function recoverScrimLifecycleDispatcherAtStartup(stmts) {
  const nowIso = new Date().toISOString();
  const info = stmts.recoverScrimLifecycleDispatcherProcessing.run({
    updated_at: nowIso,
    now_iso: nowIso,
  });
  const deleteRecovered = recoverScrimLifecycleDeleteOperationsAtStartup(stmts);
  const exhausted = terminalizeExhaustedScrimLifecycleOperations(stmts);
  const total = info.changes + deleteRecovered;
  if (total > 0 || exhausted > 0) {
    try {
      logger.info('scrimLifecycleDispatcher: recovered_processing', {
        orchestrated_count: info.changes,
        delete_count: deleteRecovered,
        exhausted_count: exhausted,
      });
    } catch {
      /* ignore */
    }
  }
  return total + exhausted;
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {string} nowIso
 * @returns {boolean}
 */
function shouldForceStarvedBurst(stmts, nowIso) {
  if (consecutiveHighTierClaims < SCRIM_LIFECYCLE_STARVATION_BURST_AFTER_HIGH) return false;
  const row = stmts.countStarvedPendingScrimLifecycleOperations.get({
    now_iso: nowIso,
    starvation_threshold_ms: SCRIM_LIFECYCLE_STARVATION_THRESHOLD_MS,
    max_attempts: SCRIM_LIFECYCLE_MAX_ATTEMPTS,
  });
  return Number(row?.n ?? 0) > 0;
}

/**
 * Claim atomique : sélection + UPDATE pending→processing.
 *
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @returns {Record<string, unknown> | null}
 */
export function claimNextScrimLifecycleOperation(stmts) {
  terminalizeExhaustedScrimLifecycleOperations(stmts);

  const nowIso = new Date().toISOString();
  const dispatchParams = {
    now_iso: nowIso,
    starvation_threshold_ms: SCRIM_LIFECYCLE_STARVATION_THRESHOLD_MS,
    max_attempts: SCRIM_LIFECYCLE_MAX_ATTEMPTS,
  };

  /** @type {Record<string, unknown> | null} */
  let candidate = null;
  let forcedStarvedBurst = false;

  if (shouldForceStarvedBurst(stmts, nowIso)) {
    candidate = stmts.selectNextStarvedScrimLifecycleOperationForDispatcher.get(dispatchParams);
    forcedStarvedBurst = Boolean(candidate);
  }

  if (!candidate) {
    candidate = stmts.selectNextScrimLifecycleOperationForDispatcher.get(dispatchParams);
  }
  if (!candidate) return null;

  const claimInfo = stmts.claimScrimLifecycleOperationForDispatcher.run({
    id: candidate.id,
    started_at: nowIso,
    last_dispatched_at: nowIso,
    updated_at: nowIso,
  });
  if (claimInfo.changes === 0) return null;

  const op = stmts.getScrimLifecycleOperationById.get(candidate.id);

  if (forcedStarvedBurst || isStarvedLifecycleOp(op, nowIso)) {
    consecutiveHighTierClaims = 0;
  } else if (isHighTierLifecycleOp(op)) {
    consecutiveHighTierClaims += 1;
  }

  try {
    logger.info('scrimLifecycleDispatcher: claimed', {
      operation_id: candidate.id,
      operation_type: candidate.operation_type,
      priority: candidate.priority,
      scrim_post_db_id: candidate.scrim_post_db_id,
      attempt_count: Number(candidate.attempt_count ?? 0) + 1,
      target_status: candidate.target_status,
      forced_starved_burst: forcedStarvedBurst,
      consecutive_high_tier_claims: consecutiveHighTierClaims,
    });
  } catch {
    /* ignore */
  }

  return op;
}

/** @internal tests Phase 3H */
export function resetScrimLifecycleDispatcherBurstStateForTests() {
  consecutiveHighTierClaims = 0;
}

/** @internal tests Phase 3H */
export function getScrimLifecycleDispatcherBurstStateForTests() {
  return { consecutiveHighTierClaims };
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {Record<string, unknown>} op
 * @param {unknown} err
 */
function scheduleDispatchFailureRetry(stmts, op, err) {
  const id = Number(op.id);
  const c = classifyDiscordEditError(err);

  if (c.kind === 'terminal') {
    if (String(c.code) === String(RESTJSONErrorCodes.UnknownMessage)) {
      if (op.operation_type === 'lifecycle_delete') {
        completeScrimLifecycleDeleteSuccess(
          stmts,
          id,
          {
            guild_id: /** @type {string} */ (op.guild_id),
            channel_id: /** @type {string} */ (op.channel_id),
            message_id: /** @type {string} */ (op.message_id),
          },
          { error_code: c.code },
        );
      } else {
        markScrimLifecycleOperationCompleted(stmts, id);
      }
      return;
    }
    markScrimLifecycleOperationFailedTerminal(stmts, id, c.code, c.message);
    return;
  }

  if (op.operation_type === 'lifecycle_delete') {
    scheduleScrimLifecycleDeleteRetry(stmts, id, c.code, c.message);
  } else {
    scheduleScrimLifecycleEditRetry(stmts, id, c.code, c.message);
  }
}

/**
 * @param {import('discord.js').Client} client
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {Record<string, unknown>} op
 */
async function executeClaimedOperation(client, stmts, op) {
  try {
    const out = await executeOrchestratedLifecycleOperation(client, stmts, op, {
      fromDispatcher: true,
    });
    if (out === 'completed') {
      try {
        logger.info('scrimLifecycleDispatcher: completed', {
          operation_id: op.id,
          operation_type: op.operation_type,
          priority: op.priority,
          scrim_post_db_id: op.scrim_post_db_id,
          target_status: op.target_status,
        });
      } catch {
        /* ignore */
      }
      return;
    }
    if (out === 'skipped') {
      try {
        logger.info('scrimLifecycleDispatcher: stale_cancelled', {
          operation_id: op.id,
          scrim_post_db_id: op.scrim_post_db_id,
          target_status: op.target_status,
        });
      } catch {
        /* ignore */
      }
      return;
    }
    if (out === 'queued') {
      return;
    }
    // 'failed' : orchestrator doit déjà avoir terminalisé. Filet de sécurité.
    const fresh = stmts.getScrimLifecycleOperationById.get(Number(op.id));
    if (fresh?.status === 'processing') {
      markScrimLifecycleOperationFailedTerminal(
        stmts,
        Number(op.id),
        'PREFETCH_FAILED',
        'prefetch failed — terminalized by dispatcher (no hot requeue)',
      );
    }
  } catch (err) {
    const fresh = stmts.getScrimLifecycleOperationById.get(Number(op.id));
    if (fresh?.status === 'processing' || fresh?.status === 'pending') {
      scheduleDispatchFailureRetry(stmts, op, err);
    }
    logger.warn('scrimLifecycleDispatcher: execute error', {
      operation_id: op.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Attend que le dispatcher n'ait plus de workers actifs ni d'ops due pending.
 *
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} deadlineMs
 */
async function waitForLifecycleDispatcherIdle(stmts, deadlineMs) {
  while (!dispatcherShuttingDown && Date.now() < deadlineMs) {
    const pendingDue = Number(
      stmts.countScrimLifecycleOperationsPendingDue.get({
        now_iso: new Date().toISOString(),
      })?.n ?? 0,
    );
    if (activeWorkers === 0 && pendingDue === 0) {
      return true;
    }
    await sleep(5);
  }
  while (activeWorkers > 0 && Date.now() < deadlineMs) {
    await sleep(5);
  }
  return activeWorkers === 0;
}

/**
 * Pompe le dispatcher via les slots partagés (post-orchestration close low-latency).
 * N'exécute pas d'ops hors activeWorkers / SCRIM_LIFECYCLE_CONCURRENCY.
 *
 * @param {import('discord.js').Client} client
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {{ maxOps?: number, timeoutMs?: number }} [options]
 * @returns {Promise<number>}
 */
export async function drainScrimLifecycleDispatcher(client, stmts, options = {}) {
  // Bloquer uniquement pendant un shutdown actif (dispatcher encore « started »).
  // Après stop complet, shuttingDown peut rester true mais le drain standalone doit fonctionner.
  if (dispatcherShuttingDown && dispatcherStarted) return 0;

  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxCycles = options.maxOps ?? 50;
  const deadline = Date.now() + timeoutMs;

  wakeScrimLifecycleDispatcher();

  let cycles = 0;
  while (!dispatcherShuttingDown && cycles < maxCycles && Date.now() < deadline) {
    await runScrimLifecycleDispatcherPass(client, stmts);
    const idle = await waitForLifecycleDispatcherIdle(stmts, deadline);
    if (idle) {
      return cycles + 1;
    }
    cycles += 1;
    wakeScrimLifecycleDispatcher();
  }

  await waitForLifecycleDispatcherIdle(stmts, deadline);
  return cycles;
}

/**
 * @param {import('discord.js').Client} client
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @returns {Promise<{ claimed: number }>}
 */
export async function runScrimLifecycleDispatcherPass(client, stmts) {
  if ((dispatcherShuttingDown && dispatcherStarted) || dispatcherPassInProgress) {
    return { claimed: 0 };
  }

  dispatcherPassInProgress = true;
  const concurrency = parseScrimLifecycleConcurrency();
  let claimed = 0;

  try {
    while (!dispatcherShuttingDown && activeWorkers < concurrency) {
      const op = claimNextScrimLifecycleOperation(stmts);
      if (!op) break;

      claimed += 1;
      activeWorkers += 1;
      void executeClaimedOperation(client, stmts, op).finally(() => {
        activeWorkers -= 1;
        wakeScrimLifecycleDispatcher();
      });
    }
  } finally {
    dispatcherPassInProgress = false;
  }

  return { claimed };
}

/**
 * Réveille le dispatcher pour traiter des ops pending (post-orchestration).
 */
export function wakeScrimLifecycleDispatcher() {
  if (wakeResolve) {
    wakeResolve();
    wakeResolve = null;
  }
}

/**
 * @returns {Promise<void>}
 */
function waitForWakeOrTimeout(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wakeResolve = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

async function dispatcherLoop() {
  const pollMs =
    parsePollIntervalMinutes(process.env.SCRIM_LIFECYCLE_DISPATCHER_INTERVAL_MINUTES, 2) *
    60 *
    1000;

  while (!dispatcherShuttingDown) {
    if (boundClient && boundStmts) {
      try {
        await runScrimLifecycleDispatcherPass(boundClient, boundStmts);
      } catch (err) {
        try {
          logger.error('scrimLifecycleDispatcher: pass error', {
            message: err instanceof Error ? err.message : String(err),
          });
        } catch {
          /* ignore */
        }
      }
    }

    const pending =
      boundStmts?.countScrimLifecycleOperationsPendingDue.get({
        now_iso: new Date().toISOString(),
      })?.n ?? 0;
    if (Number(pending) === 0 && activeWorkers === 0) {
      await waitForWakeOrTimeout(pollMs);
    } else {
      await sleep(50);
    }
  }
}

/**
 * @returns {{
 *   started: boolean,
 *   shuttingDown: boolean,
 *   activeWorkers: number,
 *   concurrency: number,
 * }}
 */
export function getScrimLifecycleDispatcherHealthSnapshot() {
  return {
    started: dispatcherStarted,
    shuttingDown: dispatcherShuttingDown,
    activeWorkers,
    concurrency: parseScrimLifecycleConcurrency(),
  };
}

/**
 * @param {import('discord.js').Client} client
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 */
export function startScrimLifecycleDispatcher(client, stmts) {
  if (dispatcherStarted) {
    logger.warn('startScrimLifecycleDispatcher: déjà démarré, ignoré');
    return;
  }

  dispatcherStarted = true;
  dispatcherShuttingDown = false;
  consecutiveHighTierClaims = 0;
  boundClient = client;
  boundStmts = stmts;

  recoverScrimLifecycleDispatcherAtStartup(stmts);

  const concurrency = parseScrimLifecycleConcurrency();
  try {
    logger.info('scrimLifecycleDispatcher: started', {
      concurrency,
      default_concurrency: SCRIM_LIFECYCLE_CONCURRENCY_DEFAULT,
      env_key: 'SCRIM_LIFECYCLE_CONCURRENCY',
    });
  } catch {
    /* ignore */
  }

  void dispatcherLoop();
  wakeScrimLifecycleDispatcher();
}

export async function stopScrimLifecycleDispatcher() {
  dispatcherShuttingDown = true;
  wakeScrimLifecycleDispatcher();

  const deadline = Date.now() + 15_000;
  while (activeWorkers > 0 && Date.now() < deadline) {
    try {
      logger.info('scrimLifecycleDispatcher: shutdown_wait', {
        active_workers: activeWorkers,
      });
    } catch {
      /* ignore */
    }
    await sleep(50);
  }

  if (activeWorkers > 0) {
    try {
      logger.warn('scrimLifecycleDispatcher: shutdown_wait timeout', {
        active_workers: activeWorkers,
      });
    } catch {
      /* ignore */
    }
  }

  dispatcherStarted = false;
  boundClient = null;
  boundStmts = null;

  try {
    logger.info('scrimLifecycleDispatcher: stopped');
  } catch {
    /* ignore */
  }
}
