import { logger } from '../utils/logger.js';
import { resolveOrchestratedLifecyclePriority } from './scrimLifecyclePriority.js';

/** @typedef {'lifecycle_edit' | 'lifecycle_delete'} ScrimLifecycleOperationType */
/** @typedef {'pending' | 'processing' | 'completed' | 'failed_terminal' | 'cancelled'} ScrimLifecycleOperationStatus */
/** @typedef {'high' | 'low'} ScrimLifecycleOperationPriority */

export const LIFECYCLE_OP_TYPE_EDIT = /** @type {ScrimLifecycleOperationType} */ ('lifecycle_edit');
export const LIFECYCLE_OP_TYPE_DELETE = /** @type {ScrimLifecycleOperationType} */ ('lifecycle_delete');

/**
 * @param {Record<string, unknown>} fields
 */
function logLifecycleOpCreated(fields) {
  try {
    logger.info('scrimLifecycleOperation: created', fields);
  } catch {
    /* ignore */
  }
}

/**
 * @param {Record<string, unknown>} fields
 */
function logLifecycleOpCompleted(fields) {
  try {
    logger.info('scrimLifecycleOperation: completed', fields);
  } catch {
    /* ignore */
  }
}

/**
 * @param {Record<string, unknown>} fields
 */
function logLifecycleOpFailedTerminal(fields) {
  try {
    logger.info('scrimLifecycleOperation: failed_terminal', fields);
  } catch {
    /* ignore */
  }
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {{
 *   scrimPostDbId: number,
 *   guildId: string,
 *   channelId: string,
 *   messageId: string,
 *   operationType: ScrimLifecycleOperationType,
 *   targetStatus?: string | null,
 *   priority?: ScrimLifecycleOperationPriority,
 *   payloadJson?: string | null,
 * }} p
 * @returns {number} operation id
 */
export function createScrimLifecycleOperation(stmts, p) {
  const nowIso = new Date().toISOString();
  const info = stmts.createScrimLifecycleOperation.run({
    scrim_post_db_id: p.scrimPostDbId,
    guild_id: p.guildId,
    channel_id: p.channelId,
    message_id: p.messageId,
    operation_type: p.operationType,
    target_status: p.targetStatus ?? null,
    priority: p.priority ?? 'low',
    payload_json: p.payloadJson ?? null,
    created_at: nowIso,
    updated_at: nowIso,
  });
  const operationId = Number(info.lastInsertRowid);
  logLifecycleOpCreated({
    operation_id: operationId,
    operation_type: p.operationType,
    scrim_post_db_id: p.scrimPostDbId,
    guild_id: p.guildId,
    channel_id: p.channelId,
    message_id: p.messageId,
    target_status: p.targetStatus ?? null,
  });
  return operationId;
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} operationId
 * @returns {boolean}
 */
export function markScrimLifecycleOperationProcessing(stmts, operationId) {
  const nowIso = new Date().toISOString();
  const info = stmts.markScrimLifecycleOperationProcessing.run({
    id: operationId,
    started_at: nowIso,
    updated_at: nowIso,
  });
  return info.changes > 0;
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} operationId
 * @returns {boolean}
 */
export function markScrimLifecycleOperationCompleted(stmts, operationId) {
  const nowIso = new Date().toISOString();
  const info = stmts.markScrimLifecycleOperationCompleted.run({
    id: operationId,
    completed_at: nowIso,
    updated_at: nowIso,
  });
  if (info.changes > 0) {
    const row = stmts.getScrimLifecycleOperationById.get(operationId);
    logLifecycleOpCompleted({
      operation_id: operationId,
      operation_type: row?.operation_type ?? null,
      scrim_post_db_id: row?.scrim_post_db_id ?? null,
      guild_id: row?.guild_id ?? null,
      channel_id: row?.channel_id ?? null,
      message_id: row?.message_id ?? null,
      target_status: row?.target_status ?? null,
    });
  }
  return info.changes > 0;
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} operationId
 * @param {string} [errorCode]
 * @param {string} [errorMessage]
 * @returns {boolean}
 */
export function markScrimLifecycleOperationFailedTerminal(
  stmts,
  operationId,
  errorCode,
  errorMessage,
) {
  const nowIso = new Date().toISOString();
  const info = stmts.markScrimLifecycleOperationFailedTerminal.run({
    id: operationId,
    completed_at: nowIso,
    last_error_code: errorCode ?? null,
    last_error_message: errorMessage?.slice(0, 500) ?? null,
    updated_at: nowIso,
  });
  if (info.changes > 0) {
    const row = stmts.getScrimLifecycleOperationById.get(operationId);
    logLifecycleOpFailedTerminal({
      operation_id: operationId,
      operation_type: row?.operation_type ?? null,
      scrim_post_db_id: row?.scrim_post_db_id ?? null,
      guild_id: row?.guild_id ?? null,
      channel_id: row?.channel_id ?? null,
      message_id: row?.message_id ?? null,
      target_status: row?.target_status ?? null,
      error_code: errorCode ?? null,
    });
  }
  return info.changes > 0;
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} operationId
 * @param {string} [reasonCode]
 * @param {string} [reasonMessage]
 * @returns {boolean}
 */
export function markScrimLifecycleOperationCancelled(
  stmts,
  operationId,
  reasonCode,
  reasonMessage,
) {
  const nowIso = new Date().toISOString();
  const info = stmts.markScrimLifecycleOperationCancelled.run({
    id: operationId,
    completed_at: nowIso,
    updated_at: nowIso,
    last_error_code: reasonCode ?? null,
    last_error_message: reasonMessage?.slice(0, 500) ?? null,
  });
  return info.changes > 0;
}

/**
 * Remet une op en pending après échec retryable (shadow — exécution legacy via edit retries).
 *
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} operationId
 * @param {string} [errorCode]
 * @param {string} [errorMessage]
 * @returns {boolean}
 */
export function resetScrimLifecycleOperationPending(
  stmts,
  operationId,
  errorCode,
  errorMessage,
) {
  const nowIso = new Date().toISOString();
  const info = stmts.resetScrimLifecycleOperationPending.run({
    id: operationId,
    last_error_code: errorCode ?? null,
    last_error_message: errorMessage?.slice(0, 500) ?? null,
    updated_at: nowIso,
  });
  return info.changes > 0;
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} operationId
 * @returns {Record<string, unknown> | undefined}
 */
export function getScrimLifecycleOperationById(stmts, operationId) {
  return stmts.getScrimLifecycleOperationById.get(operationId);
}

/**
 * Insère une op orchestrée avec event_key (idempotent via INSERT OR IGNORE).
 *
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {{
 *   scrimPostDbId: number,
 *   guildId: string,
 *   channelId: string,
 *   messageId: string,
 *   operationType: ScrimLifecycleOperationType,
 *   targetStatus: string,
 *   eventKey: string,
 *   payloadJson?: string | null,
 *   priority?: ScrimLifecycleOperationPriority,
 * }} p
 * @returns {{ operationId: number | null, deduplicated: boolean }}
 */
export function insertOrchestratedScrimLifecycleOperation(stmts, p) {
  const nowIso = new Date().toISOString();
  const info = stmts.insertOrchestratedScrimLifecycleOperation.run({
    scrim_post_db_id: p.scrimPostDbId,
    guild_id: p.guildId,
    channel_id: p.channelId,
    message_id: p.messageId,
    operation_type: p.operationType,
    target_status: p.targetStatus,
    priority: p.priority ?? resolveOrchestratedLifecyclePriority(p.targetStatus, p.operationType),
    payload_json: p.payloadJson ?? null,
    event_key: p.eventKey,
    created_at: nowIso,
    updated_at: nowIso,
  });

  if (info.changes > 0) {
    return { operationId: Number(info.lastInsertRowid), deduplicated: false };
  }

  const existing = stmts.getScrimLifecycleOperationByEventKey.get(p.eventKey);
  return {
    operationId: existing ? Number(existing.id) : null,
    deduplicated: true,
  };
}
