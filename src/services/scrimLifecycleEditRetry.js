import { computeNextRetryDelayMs } from './discordRetryPolicy.js';
import {
  markScrimLifecycleOperationFailedTerminal,
} from './scrimLifecycleOperationStore.js';
import { SCRIM_LIFECYCLE_MAX_ATTEMPTS } from './scrimLifecycleAttempts.js';
import { logger } from '../utils/logger.js';

/**
 * Planifie ou abandonne un retry edit persistant sur scrim_lifecycle_operations.
 *
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} operationId
 * @param {string} errorCode
 * @param {string} errorMessage
 * @returns {'scheduled' | 'terminal'}
 */
export function scheduleScrimLifecycleEditRetry(stmts, operationId, errorCode, errorMessage) {
  const row = stmts.getScrimLifecycleOperationById.get(operationId);
  const attempts = Number(row?.attempt_count ?? 0);
  const delay = computeNextRetryDelayMs(attempts);
  const nowIso = new Date().toISOString();

  if (attempts >= SCRIM_LIFECYCLE_MAX_ATTEMPTS || delay == null) {
    markScrimLifecycleOperationFailedTerminal(
      stmts,
      operationId,
      'RETRY_EXHAUSTED',
      `${errorCode}: ${errorMessage} (max tentatives edit)`,
    );
    try {
      logger.info('scrimLifecycleDispatcher: terminal', {
        lifecycle_operation_id: operationId,
        operation_type: 'lifecycle_edit',
        scrim_post_db_id: row?.scrim_post_db_id ?? null,
        attempt_count: attempts,
        error_code: errorCode,
      });
    } catch {
      /* ignore */
    }
    return 'terminal';
  }

  const nextAt = new Date(Date.now() + delay).toISOString();
  stmts.scheduleScrimLifecycleEditRetry.run({
    id: operationId,
    attempt_count: attempts,
    next_attempt_at: nextAt,
    last_error_code: errorCode,
    last_error_message: errorMessage.slice(0, 500),
    updated_at: nowIso,
  });

  try {
    logger.info('scrimLifecycleDispatcher: retry_scheduled', {
      lifecycle_operation_id: operationId,
      operation_type: 'lifecycle_edit',
      scrim_post_db_id: row?.scrim_post_db_id ?? null,
      attempt_count: attempts,
      next_attempt_at: nextAt,
      error_code: errorCode,
    });
  } catch {
    /* ignore */
  }

  return 'scheduled';
}
