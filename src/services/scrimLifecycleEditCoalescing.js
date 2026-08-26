import { logger } from '../utils/logger.js';
import {
  isDefinitiveLifecycleCloseTarget,
  isScrimLifecycleTargetStatusCurrent,
} from './scrimLifecycleTargetStatus.js';
import { markScrimLifecycleOperationCancelled } from './scrimLifecycleOperationStore.js';

/**
 * Annule un retry legacy obsolète sans appeler Discord (0 message.edit).
 *
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {Record<string, unknown>} retryRow
 * @param {string} scrimPostStatus
 * @param {string} reasonCode
 * @param {string} [reasonDetail]
 * @returns {boolean} true si le retry a été abandonné
 */
export function cancelStaleScrimLifecycleEditRetry(
  stmts,
  retryRow,
  scrimPostStatus,
  reasonCode,
  reasonDetail,
) {
  const now = new Date().toISOString();
  const retryId = Number(retryRow.id);
  const detail =
    reasonDetail ??
    `target_status ${retryRow.target_status} obsolete for scrim status ${scrimPostStatus}`;

  stmts.markDiscordEditRetryAbandoned.run({
    id: retryId,
    abandoned_at: now,
    updated_at: now,
    last_error_code: reasonCode,
    last_error_message: detail.slice(0, 500),
  });

  const opId =
    retryRow.lifecycle_operation_id != null
      ? Number(retryRow.lifecycle_operation_id)
      : null;
  if (opId != null && Number.isFinite(opId)) {
    markScrimLifecycleOperationCancelled(stmts, opId, reasonCode, detail);
  }

  try {
    logger.info('scrimLifecycleEdit: stale_cancelled', {
      retry_id: retryId,
      scrim_post_db_id: retryRow.scrim_post_db_id,
      guild_id: retryRow.guild_id,
      channel_id: retryRow.channel_id,
      message_id: retryRow.message_id,
      target_status: retryRow.target_status,
      scrim_post_status: scrimPostStatus,
      reason_code: reasonCode,
      lifecycle_operation_id: opId,
    });
  } catch {
    /* ignore */
  }

  return true;
}

/**
 * Invalide tous les retries actifs d'un scrim incompatibles avec son statut métier courant.
 *
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} scrimPostDbId
 * @param {string} scrimPostStatus
 * @returns {number} nombre de retries annulés
 */
export function invalidateIncompatibleEditRetriesForScrimPost(
  stmts,
  scrimPostDbId,
  scrimPostStatus,
) {
  const rows = stmts.listActiveDiscordEditRetriesForScrimPost.all(scrimPostDbId);
  let cancelled = 0;
  for (const row of rows) {
    const check = isScrimLifecycleTargetStatusCurrent(scrimPostStatus, row.target_status);
    if (!check.current) {
      cancelStaleScrimLifecycleEditRetry(
        stmts,
        row,
        scrimPostStatus,
        check.reason ?? 'stale_target_status',
      );
      cancelled += 1;
    }
  }
  return cancelled;
}

/**
 * Invalide les retries actifs d'un message incompatibles avec le statut métier courant.
 * Utilisé lors de l'enqueue d'un nouvel état définitif (closed_manual / closed_expired).
 *
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} scrimPostDbId
 * @param {string} guildId
 * @param {string} channelId
 * @param {string} messageId
 * @param {string} scrimPostStatus
 * @param {string | null} [exceptTargetStatus] target_status conservé (nouvel état courant)
 * @returns {number}
 */
export function invalidateIncompatibleEditRetriesForMessage(
  stmts,
  scrimPostDbId,
  guildId,
  channelId,
  messageId,
  scrimPostStatus,
  exceptTargetStatus = null,
) {
  const rows = stmts.listActiveDiscordEditRetriesForMessage.all(
    guildId,
    channelId,
    messageId,
  );
  let cancelled = 0;
  for (const row of rows) {
    if (exceptTargetStatus != null && row.target_status === exceptTargetStatus) {
      continue;
    }
    const check = isScrimLifecycleTargetStatusCurrent(scrimPostStatus, row.target_status);
    if (!check.current) {
      cancelStaleScrimLifecycleEditRetry(
        stmts,
        row,
        scrimPostStatus,
        check.reason ?? 'stale_target_status',
      );
      cancelled += 1;
      continue;
    }
    // Même message, deux target_status lifecycle valides en parallèle : impossible si active
    // (seul superseded_repost) ou closed (un seul close). Si conflit cross-status explicite :
    if (
      exceptTargetStatus != null &&
      isDefinitiveLifecycleCloseTarget(exceptTargetStatus) &&
      row.target_status !== exceptTargetStatus
    ) {
      cancelStaleScrimLifecycleEditRetry(
        stmts,
        row,
        scrimPostStatus,
        'superseded_by_newer_state',
        `superseded by newer target_status ${exceptTargetStatus}`,
      );
      cancelled += 1;
    }
  }
  return cancelled;
}

/**
 * Recheck avant retry edit : le target_status est-il encore valide ?
 *
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {Record<string, unknown>} retryRow
 * @returns {{ stale: boolean, scrimPostStatus?: string, reason?: string }}
 */
export function recheckScrimLifecycleEditRetryTargetStatus(stmts, retryRow) {
  const scrimPostDbId = Number(retryRow.scrim_post_db_id);
  const scrimRow = stmts.getScrimPostById.get(scrimPostDbId);
  const scrimPostStatus = scrimRow?.status ?? null;

  if (!scrimPostStatus) {
    return { stale: true, reason: 'unknown_scrim_post_status' };
  }

  const check = isScrimLifecycleTargetStatusCurrent(
    scrimPostStatus,
    /** @type {string} */ (retryRow.target_status),
  );
  if (!check.current) {
    return {
      stale: true,
      scrimPostStatus,
      reason: check.reason ?? 'stale_target_status',
    };
  }
  return { stale: false, scrimPostStatus };
}
