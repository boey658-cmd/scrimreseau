/**
 * Bornes attempt_count pour ops lifecycle orchestrées (Phase 3J).
 * attempt_count est incrémenté au claim ; MAX = nombre max d'exécutions Discord.
 */

import { logger } from '../utils/logger.js';
import { markScrimLifecycleOperationFailedTerminal } from './scrimLifecycleOperationStore.js';

/** Nombre max de claims / exécutions Discord par op lifecycle. */
export const SCRIM_LIFECYCLE_MAX_ATTEMPTS = 5;

/**
 * Terminalise sans Discord les ops déjà au-delà (ou au) max.
 * Couvre les rows canary/dev avec attempt_count explosé (hot-loop pré-3J).
 *
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @returns {number} rows terminalisées
 */
export function terminalizeExhaustedScrimLifecycleOperations(stmts) {
  if (typeof stmts.listExhaustedPendingScrimLifecycleOperations?.all !== 'function') {
    return 0;
  }
  const rows = stmts.listExhaustedPendingScrimLifecycleOperations.all({
    max_attempts: SCRIM_LIFECYCLE_MAX_ATTEMPTS,
  });
  let n = 0;
  for (const row of rows) {
    const ok = markScrimLifecycleOperationFailedTerminal(
      stmts,
      Number(row.id),
      'RETRY_EXHAUSTED',
      `attempt_count=${row.attempt_count} >= ${SCRIM_LIFECYCLE_MAX_ATTEMPTS} — terminalisé sans Discord`,
    );
    if (ok) {
      n += 1;
      try {
        logger.info('scrimLifecycle: exhausted_without_discord', {
          lifecycle_operation_id: row.id,
          attempt_count: row.attempt_count,
          operation_type: row.operation_type,
          last_error_code: row.last_error_code ?? null,
        });
      } catch {
        /* ignore */
      }
    }
  }
  return n;
}

/**
 * @param {number} attemptCount post-claim
 * @returns {boolean}
 */
export function isScrimLifecycleAttemptExhausted(attemptCount) {
  return Number(attemptCount) >= SCRIM_LIFECYCLE_MAX_ATTEMPTS;
}
