import { logger } from '../utils/logger.js';
import { broadcastScrimRequest } from './broadcast.js';
import { scrimDbRowToEmbedPayload } from './scrimEmbedBuilder.js';
import { markScrimPostMessagesSuperseded } from './scrimLifecycle.js';
import {
  cancelSupersedeOpsForGeneration,
  executeOrchestratedLifecycleOperations,
  orchestrateScrimCloseIntentionsForMessages,
} from './scrimLifecycleOrchestrator.js';

/** @typedef {'reserved' | 'broadcasting' | 'broadcast_done' | 'finalized' | 'cancelled' | 'failed'} RepostCycleStatus */

/**
 * @param {number} scrimPostDbId
 * @param {number} generation
 * @returns {string}
 */
export function buildRepostCycleEventKey(scrimPostDbId, generation) {
  return `repost:${scrimPostDbId}:${generation}`;
}

/**
 * @param {string} oldMessagesJson
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} scrimPostDbId
 * @returns {{ guild_id: string, channel_id: string, message_id: string }[]}
 */
export function getNewMessagesSinceCycleSnapshot(oldMessagesJson, stmts, scrimPostDbId) {
  /** @type {{ guild_id: string, channel_id: string, message_id: string }[]} */
  let oldMessages = [];
  try {
    oldMessages = JSON.parse(oldMessagesJson);
  } catch {
    oldMessages = [];
  }
  const oldIds = new Set(oldMessages.map((m) => m.message_id));
  const current = stmts.listScrimPostMessagesByPostId.all(scrimPostDbId);
  return current.filter((m) => !oldIds.has(m.message_id));
}

/**
 * @param {Record<string, unknown>} cycle
 * @returns {{ guild_id: string, channel_id: string, message_id: string }[]}
 */
export function parseCycleOldMessagesSnapshot(cycle) {
  try {
    return JSON.parse(/** @type {string} */ (cycle.old_messages_json));
  } catch {
    return [];
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} scrimPostDbId
 * @returns {{ reserved: boolean, cycle?: Record<string, unknown>, reason?: string }}
 */
export function reserveRepostCycle(db, stmts, scrimPostDbId) {
  /** @type {{ reserved: boolean, cycle?: Record<string, unknown>, reason?: string }} */
  const out = { reserved: false };
  const nowIso = new Date().toISOString();

  const trx = db.transaction(() => {
    const row = stmts.getScrimPostById.get(scrimPostDbId);
    if (!row || row.status !== 'active') {
      out.reason = 'not_active';
      return;
    }

    const active = stmts.getActiveRepostCycleForScrim.get(scrimPostDbId);
    if (active) {
      out.reason = 'existing_cycle';
      out.cycle = active;
      return;
    }

    const generation = Number(row.repost_count ?? 0) + 1;
    const eventKey = buildRepostCycleEventKey(scrimPostDbId, generation);
    const oldMessages = stmts.listScrimPostMessagesByPostId.all(scrimPostDbId);

    const info = stmts.insertScrimRepostCycle.run({
      scrim_post_db_id: scrimPostDbId,
      generation,
      event_key: eventKey,
      status: 'reserved',
      old_messages_json: JSON.stringify(oldMessages),
      success_count: 0,
      started_at: nowIso,
      updated_at: nowIso,
    });

    out.reserved = true;
    out.cycle = stmts.getScrimRepostCycleById.get(Number(info.lastInsertRowid));
  });

  try {
    trx();
  } catch (err) {
    const active = stmts.getActiveRepostCycleForScrim.get(scrimPostDbId);
    if (active) {
      out.reason = 'existing_cycle';
      out.cycle = active;
      return out;
    }
    throw err;
  }

  if (out.reserved && out.cycle) {
    try {
      logger.info('scrimRepostCycle: reserved', {
        cycle_id: out.cycle.id,
        scrim_post_db_id: scrimPostDbId,
        generation: out.cycle.generation,
        event_key: out.cycle.event_key,
      });
    } catch {
      /* ignore */
    }
  } else if (out.reason === 'existing_cycle' && out.cycle) {
    try {
      logger.info('scrimRepostCycle: skipped_existing', {
        cycle_id: out.cycle.id,
        scrim_post_db_id: scrimPostDbId,
        generation: out.cycle.generation,
      });
    } catch {
      /* ignore */
    }
  }

  return out;
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} cycleId
 * @param {RepostCycleStatus} status
 * @param {number} [successCount]
 */
function updateCycleStatus(stmts, cycleId, status, successCount) {
  const nowIso = new Date().toISOString();
  const cycle = stmts.getScrimRepostCycleById.get(cycleId);
  stmts.updateScrimRepostCycleStatus.run({
    id: cycleId,
    status,
    success_count: successCount ?? Number(cycle?.success_count ?? 0),
    updated_at: nowIso,
    completed_at:
      status === 'finalized' || status === 'cancelled' || status === 'failed'
        ? nowIso
        : null,
  });
}

/**
 * @param {import('discord.js').Client} client
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {Record<string, unknown>} cycle
 */
async function handleClosedDuringRepostCycle(client, db, stmts, cycle) {
  const scrimPostDbId = Number(cycle.scrim_post_db_id);
  const generation = Number(cycle.generation);
  const scrimRow = stmts.getScrimPostById.get(scrimPostDbId);
  if (!scrimRow) return;

  cancelSupersedeOpsForGeneration(stmts, scrimPostDbId, generation);
  updateCycleStatus(stmts, Number(cycle.id), 'cancelled');

  const allMessages = stmts.listScrimPostMessagesByPostId.all(scrimPostDbId);
  const closeOps = orchestrateScrimCloseIntentionsForMessages(
    db,
    stmts,
    scrimPostDbId,
    allMessages,
  );

  try {
    logger.info('scrimRepostCycle: cancelled_closed', {
      cycle_id: cycle.id,
      scrim_post_db_id: scrimPostDbId,
      generation,
      scrim_status: scrimRow.status,
      close_ops: closeOps.operations.length,
    });
  } catch {
    /* ignore */
  }

  executeOrchestratedLifecycleOperations(client, stmts, closeOps.operations);
}

/**
 * Finalize : record repost success + supersede snapshot (scrim must be active).
 *
 * @param {import('discord.js').Client} client
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {Record<string, unknown>} cycle
 * @returns {Promise<boolean>}
 */
export async function finalizeRepostCycle(client, db, stmts, cycle) {
  const cycleId = Number(cycle.id);
  const scrimPostDbId = Number(cycle.scrim_post_db_id);
  const generation = Number(cycle.generation);
  const successCount = Number(cycle.success_count ?? 0);

  if (successCount <= 0) {
    updateCycleStatus(stmts, cycleId, 'failed');
    return false;
  }

  const freshCycle = stmts.getScrimRepostCycleById.get(cycleId);
  if (!freshCycle) return false;
  if (freshCycle.status === 'finalized') return true;

  const scrimRow = stmts.getScrimPostById.get(scrimPostDbId);
  if (!scrimRow || scrimRow.status !== 'active') {
    await handleClosedDuringRepostCycle(client, db, stmts, freshCycle);
    return false;
  }

  const nowIso = new Date().toISOString();
  const trx = db.transaction(() => {
    const row = stmts.getScrimPostById.get(scrimPostDbId);
    const currentCount = Number(row?.repost_count ?? 0);
    if (currentCount < generation) {
      const info = stmts.recordScrimPostRepostSuccessForGeneration.run({
        id: scrimPostDbId,
        last_repost_at: nowIso,
        expected_generation: generation,
      });
      if (info.changes === 0) {
        throw new Error('recordScrimPostRepostSuccessForGeneration: no changes');
      }
    }
  });

  try {
    trx();
  } catch (err) {
    logger.warn('scrimRepostCycle: finalize record failed', {
      cycle_id: cycleId,
      scrim_post_db_id: scrimPostDbId,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  const oldMessages = parseCycleOldMessagesSnapshot(freshCycle);
  const rowAfter = stmts.getScrimPostById.get(scrimPostDbId);
  if (rowAfter?.status === 'active') {
    await markScrimPostMessagesSuperseded(
      client,
      db,
      stmts,
      rowAfter,
      oldMessages,
      generation,
    );
  }

  updateCycleStatus(stmts, cycleId, 'finalized');

  try {
    logger.info('scrimRepostCycle: finalized', {
      cycle_id: cycleId,
      scrim_post_db_id: scrimPostDbId,
      generation,
      success_count: successCount,
    });
  } catch {
    /* ignore */
  }

  return true;
}

/**
 * Recovery : pas de rebroadcast aveugle. Finalize ou cancel/sync selon état.
 *
 * @param {import('discord.js').Client} client
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 */
export async function recoverIncompleteRepostCycles(client, db, stmts) {
  const cycles = stmts.listIncompleteScrimRepostCycles.all();
  for (const cycle of cycles) {
    const scrimPostDbId = Number(cycle.scrim_post_db_id);
    const cycleId = Number(cycle.id);
    const newMessages = getNewMessagesSinceCycleSnapshot(
      cycle.old_messages_json,
      stmts,
      scrimPostDbId,
    );

    try {
      logger.info('scrimRepostCycle: recovery_finalize', {
        cycle_id: cycleId,
        scrim_post_db_id: scrimPostDbId,
        status: cycle.status,
        new_message_count: newMessages.length,
      });
    } catch {
      /* ignore */
    }

    const scrimRow = stmts.getScrimPostById.get(scrimPostDbId);
    if (scrimRow && scrimRow.status !== 'active') {
      await handleClosedDuringRepostCycle(client, db, stmts, cycle);
      continue;
    }

    if (cycle.status === 'broadcast_done' || newMessages.length > 0) {
      const inferredSuccess = Math.max(Number(cycle.success_count ?? 0), newMessages.length);
      updateCycleStatus(stmts, cycleId, 'broadcast_done', inferredSuccess);
      const updated = stmts.getScrimRepostCycleById.get(cycleId);
      await finalizeRepostCycle(client, db, stmts, updated);
      continue;
    }

    updateCycleStatus(stmts, cycleId, 'failed');
  }
}

/**
 * @param {import('discord.js').Client} client
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} scrimPostDbId
 * @returns {Promise<{ ok: boolean, successCount: number, reason?: string }>}
 */
export async function executeRepostCycleForScrim(client, db, stmts, scrimPostDbId) {
  const row = stmts.getScrimPostById.get(scrimPostDbId);
  if (!row || row.status !== 'active') {
    return { ok: false, successCount: 0, reason: 'not_active' };
  }

  if (typeof stmts.hasOpenPersistentBroadcastForScrim?.get === 'function') {
    const open = stmts.hasOpenPersistentBroadcastForScrim.get(scrimPostDbId, scrimPostDbId);
    if (open) {
      return { ok: false, successCount: 0, reason: 'persistent_broadcast_open' };
    }
  } else {
    const openBatch = stmts.getActiveStagingBatchForScrim?.get(scrimPostDbId);
    if (openBatch) {
      return { ok: false, successCount: 0, reason: 'persistent_broadcast_open' };
    }
  }

  const reserve = reserveRepostCycle(db, stmts, scrimPostDbId);
  if (!reserve.reserved || !reserve.cycle) {
    if (reserve.reason === 'existing_cycle') {
      return { ok: false, successCount: 0, reason: 'existing_cycle' };
    }
    return { ok: false, successCount: 0, reason: reserve.reason ?? 'reserve_failed' };
  }

  const cycle = reserve.cycle;
  const cycleId = Number(cycle.id);

  const gameKey = /** @type {string} */ (row.game_key);
  const channelRows = stmts.listChannelsByGame.all(gameKey);
  if (channelRows.length === 0) {
    updateCycleStatus(stmts, cycleId, 'failed');
    return { ok: false, successCount: 0, reason: 'no_channels' };
  }

  updateCycleStatus(stmts, cycleId, 'broadcasting');

  try {
    logger.info('scrimRepostCycle: broadcast_started', {
      cycle_id: cycleId,
      scrim_post_db_id: scrimPostDbId,
      generation: cycle.generation,
    });
  } catch {
    /* ignore */
  }

  const embedPayload = scrimDbRowToEmbedPayload(row);
  let successCount = 0;

  try {
    const { runWithReservedBroadcastSlot, BROADCAST_POOL_STOPPING } = await import(
      './scrimBroadcastExecutionPool.js'
    );
    try {
      successCount = await runWithReservedBroadcastSlot(async () =>
        broadcastScrimRequest({
          client,
          rows: channelRows,
          stmts,
          authorUserId: /** @type {string} */ (row.author_user_id),
          scrimPostDbId,
          payload: embedPayload,
        }),
      );
    } catch (poolErr) {
      const code =
        poolErr && typeof poolErr === 'object' && 'code' in poolErr
          ? /** @type {{ code?: string }} */ (poolErr).code
          : undefined;
      updateCycleStatus(stmts, cycleId, 'failed');
      return {
        ok: false,
        successCount: 0,
        reason: code === BROADCAST_POOL_STOPPING ? 'pool_unavailable' : 'pool_error',
      };
    }
  } catch (err) {
    updateCycleStatus(stmts, cycleId, 'failed');
    logger.error('scrimRepostCycle: broadcast error', {
      cycle_id: cycleId,
      scrim_post_db_id: scrimPostDbId,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, successCount: 0, reason: 'broadcast_throw' };
  }

  if (successCount === 0) {
    updateCycleStatus(stmts, cycleId, 'failed');
    try {
      logger.info('scrimRepostCycle: failed', {
        cycle_id: cycleId,
        scrim_post_db_id: scrimPostDbId,
        reason: 'broadcast_zero',
      });
    } catch {
      /* ignore */
    }
    return { ok: false, successCount: 0, reason: 'broadcast_zero' };
  }

  if (successCount < channelRows.length) {
    try {
      logger.info('scrimRepostCycle: partial_success', {
        cycle_id: cycleId,
        scrim_post_db_id: scrimPostDbId,
        success_count: successCount,
        target_count: channelRows.length,
      });
    } catch {
      /* ignore */
    }
  }

  updateCycleStatus(stmts, cycleId, 'broadcast_done', successCount);

  const scrimAfterBroadcast = stmts.getScrimPostById.get(scrimPostDbId);
  if (!scrimAfterBroadcast || scrimAfterBroadcast.status !== 'active') {
    const updatedCycle = stmts.getScrimRepostCycleById.get(cycleId);
    await handleClosedDuringRepostCycle(client, db, stmts, updatedCycle);
    return { ok: false, successCount, reason: 'closed_during_repost' };
  }

  const updatedCycle = stmts.getScrimRepostCycleById.get(cycleId);
  const finalized = await finalizeRepostCycle(client, db, stmts, updatedCycle);

  if (!finalized) {
    return { ok: false, successCount, reason: 'finalize_failed' };
  }

  return { ok: true, successCount };
}
