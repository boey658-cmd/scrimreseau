import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { logger } from '../utils/logger.js';
import {
  classifyDiscordEditError,
  computeNextRetryDelayMs,
} from './discordRetryPolicy.js';
import {
  markScrimLifecycleOperationCompleted,
  markScrimLifecycleOperationFailedTerminal,
  markScrimLifecycleOperationProcessing,
} from './scrimLifecycleOperationStore.js';
import { SCRIM_LIFECYCLE_MAX_ATTEMPTS } from './scrimLifecycleAttempts.js';

/** @typedef {'success' | 'already_gone' | 'terminal' | 'retryable'} DiscordDeleteOutcomeKind */

/**
 * @param {unknown} err
 * @returns {{ kind: DiscordDeleteOutcomeKind, code: string, message: string }}
 */
export function classifyDiscordDeleteError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  const shortMsg = msg.slice(0, 500);
  const rawCode =
    typeof err === 'object' && err !== null && 'code' in err
      ? /** @type {{ code?: unknown }} */ (err).code
      : undefined;
  const numCode = typeof rawCode === 'number' ? rawCode : null;

  if (numCode === RESTJSONErrorCodes.UnknownMessage) {
    return { kind: 'already_gone', code: String(RESTJSONErrorCodes.UnknownMessage), message: shortMsg };
  }

  const c = classifyDiscordEditError(err);
  if (c.kind === 'terminal') {
    return { kind: 'terminal', code: c.code, message: c.message };
  }
  return { kind: 'retryable', code: c.code, message: c.message };
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {{ guild_id: string, channel_id: string, message_id: string }} messageRow
 */
export function markScrimMessageDiscordDeletedBestEffort(stmts, messageRow) {
  try {
    stmts.markScrimPostMessageDiscordDeleted.run({
      discord_deleted_at: new Date().toISOString(),
      guild_id: messageRow.guild_id,
      channel_id: messageRow.channel_id,
      message_id: messageRow.message_id,
    });
  } catch (dbErr) {
    logger.warn('scrimLifecycleDelete: mark discord_deleted_at échoué (non bloquant)', {
      guild_id: messageRow.guild_id,
      channel_id: messageRow.channel_id,
      message_id: messageRow.message_id,
      message: dbErr instanceof Error ? dbErr.message : String(dbErr),
    });
  }
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number | null} operationId
 * @param {{ guild_id: string, channel_id: string, message_id: string }} messageRow
 * @param {Record<string, unknown>} [logFields]
 */
export function completeScrimLifecycleDeleteSuccess(stmts, operationId, messageRow, logFields = {}) {
  if (operationId != null) {
    try {
      markScrimLifecycleOperationCompleted(stmts, operationId);
    } catch (shadowErr) {
      logger.warn('scrimLifecycleDelete: shadow mark completed échoué (non bloquant)', {
        lifecycle_operation_id: operationId,
        guild_id: messageRow.guild_id,
        channel_id: messageRow.channel_id,
        message_id: messageRow.message_id,
        message: shadowErr instanceof Error ? shadowErr.message : String(shadowErr),
        ...logFields,
      });
    }
  }
  markScrimMessageDiscordDeletedBestEffort(stmts, messageRow);
  try {
    logger.info('scrimLifecycleDelete: completed', {
      lifecycle_operation_id: operationId,
      guild_id: messageRow.guild_id,
      channel_id: messageRow.channel_id,
      message_id: messageRow.message_id,
      ...logFields,
    });
  } catch {
    /* ignore */
  }
}

/**
 * Planifie ou abandonne un retry delete persistant.
 *
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} operationId
 * @param {string} errorCode
 * @param {string} errorMessage
 * @returns {'scheduled' | 'terminal'}
 */
export function scheduleScrimLifecycleDeleteRetry(stmts, operationId, errorCode, errorMessage) {
  const row = stmts.getScrimLifecycleOperationById.get(operationId);
  // attempt_count est incrémenté uniquement au claim dispatcher — conserver comme edit.
  const attempts = Number(row?.attempt_count ?? 0);
  const delay = computeNextRetryDelayMs(attempts);
  const nowIso = new Date().toISOString();

  if (attempts >= SCRIM_LIFECYCLE_MAX_ATTEMPTS || delay == null) {
    markScrimLifecycleOperationFailedTerminal(
      stmts,
      operationId,
      'RETRY_EXHAUSTED',
      `${errorCode}: ${errorMessage} (max tentatives delete)`,
    );
    try {
      logger.info('scrimLifecycleDelete: terminal', {
        lifecycle_operation_id: operationId,
        scrim_post_db_id: row?.scrim_post_db_id ?? null,
        guild_id: row?.guild_id ?? null,
        channel_id: row?.channel_id ?? null,
        message_id: row?.message_id ?? null,
        attempt_count: attempts,
        error_code: errorCode,
      });
    } catch {
      /* ignore */
    }
    return 'terminal';
  }

  const nextAt = new Date(Date.now() + delay).toISOString();
  stmts.scheduleScrimLifecycleDeleteRetry.run({
    id: operationId,
    attempt_count: attempts,
    next_attempt_at: nextAt,
    last_error_code: errorCode,
    last_error_message: errorMessage.slice(0, 500),
    updated_at: nowIso,
  });

  try {
    logger.info('scrimLifecycleDelete: retry_scheduled', {
      lifecycle_operation_id: operationId,
      scrim_post_db_id: row?.scrim_post_db_id ?? null,
      guild_id: row?.guild_id ?? null,
      channel_id: row?.channel_id ?? null,
      message_id: row?.message_id ?? null,
      attempt_count: attempts,
      next_attempt_at: nextAt,
      error_code: errorCode,
    });
  } catch {
    /* ignore */
  }

  return 'scheduled';
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} operationId
 */
export function markScrimLifecycleDeleteProcessing(stmts, operationId) {
  markScrimLifecycleOperationProcessing(stmts, operationId);
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @returns {number}
 */
export function recoverScrimLifecycleDeleteOperationsAtStartup(stmts) {
  const nowIso = new Date().toISOString();
  const info = stmts.recoverScrimLifecycleDeleteProcessing.run({
    next_attempt_at: nowIso,
    updated_at: nowIso,
  });
  if (info.changes > 0) {
    try {
      logger.info('scrimLifecycleDelete: startup_recovered', {
        recovered_count: info.changes,
      });
    } catch {
      /* ignore */
    }
  }
  return info.changes;
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {Record<string, unknown>} row
 * @returns {boolean} true si skip sans Discord
 */
export function skipScrimLifecycleDeleteIfAlreadyMarked(stmts, row) {
  const alreadyDeleted = stmts.isScrimPostMessageDiscordDeleted.get(
    row.guild_id,
    row.channel_id,
    row.message_id,
  );
  if (!alreadyDeleted) return false;

  completeScrimLifecycleDeleteSuccess(
    stmts,
    Number(row.id),
    {
      guild_id: /** @type {string} */ (row.guild_id),
      channel_id: /** @type {string} */ (row.channel_id),
      message_id: /** @type {string} */ (row.message_id),
    },
    { reason: 'already_discord_deleted_at' },
  );

  try {
    logger.info('scrimLifecycleDelete: stale_skipped', {
      lifecycle_operation_id: row.id,
      scrim_post_db_id: row.scrim_post_db_id,
      guild_id: row.guild_id,
      channel_id: row.channel_id,
      message_id: row.message_id,
      reason: 'already_discord_deleted_at',
    });
  } catch {
    /* ignore */
  }

  return true;
}
