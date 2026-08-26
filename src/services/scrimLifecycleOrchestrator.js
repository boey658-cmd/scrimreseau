import { EmbedBuilder } from 'discord.js';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { logger } from '../utils/logger.js';
import {
  buildScrimClosedMessageEditOptions,
  buildScrimSupersededMessageEditOptions,
} from './scrimEmbedBuilder.js';
import { runTransientDiscord } from './discordApiGuard.js';
import { classifyDiscordEditError } from './discordRetryPolicy.js';
import { getGuildLocale } from '../i18n/index.js';
import { isPersistentBroadcastEnabled } from '../utils/persistentBroadcastFlag.js';
import { invalidateIncompatibleEditRetriesForScrimPost } from './scrimLifecycleEditCoalescing.js';
import { isScrimLifecycleTargetStatusCurrent } from './scrimLifecycleTargetStatus.js';
import {
  markScrimLifecycleOperationCancelled,
  markScrimLifecycleOperationCompleted,
  markScrimLifecycleOperationFailedTerminal,
  LIFECYCLE_OP_TYPE_DELETE,
  LIFECYCLE_OP_TYPE_EDIT,
  insertOrchestratedScrimLifecycleOperation,
} from './scrimLifecycleOperationStore.js';
import {
  completeScrimLifecycleDeleteSuccess,
} from './scrimLifecycleDeleteRetry.js';
import { scheduleScrimLifecycleEditRetry } from './scrimLifecycleEditRetry.js';
import { scheduleScrimLifecycleDeleteRetry } from './scrimLifecycleDeleteRetry.js';
import {
  getGuildScrimMessageLifecyclePolicy,
  LIFECYCLE_POLICY_DELETE,
  tryDeleteScrimMessage,
} from './scrimMessagePolicy.js';
import { serializeScrimEditPayload, safeScrimEmbedMessageEdit } from './safeDiscordMessageEdit.js';
import { wakeScrimLifecycleDispatcher } from './scrimLifecycleDispatcher.js';
import { SCRIM_LIFECYCLE_MAX_ATTEMPTS } from './scrimLifecycleAttempts.js';

/** @typedef {'closed_manual' | 'closed_expired' | 'superseded_repost'} ScrimLifecycleEventType */

/**
 * Hooks injectables (tests uniquement) — jamais utilisés en prod.
 * @type {{
 *   beforeFinalDiscordRecheck?: (ctx: {
 *     operationId: number,
 *     opRow: Record<string, unknown> | undefined,
 *   }) => Promise<void>,
 * }}
 */
export const orchestratedLifecycleTestHooks = {
  beforeFinalDiscordRecheck: null,
};

/** @internal tests Phase 3H */
export function resetOrchestratedLifecycleTestHooksForTests() {
  orchestratedLifecycleTestHooks.beforeFinalDiscordRecheck = null;
}

/**
 * @param {number} scrimPostDbId
 * @param {ScrimLifecycleEventType} eventType
 * @param {string} messageId
 * @param {number | null} [generation]
 * @returns {string}
 */
export function buildScrimLifecycleEventKey(
  scrimPostDbId,
  eventType,
  messageId,
  generation = null,
) {
  if (eventType === 'superseded_repost') {
    return `supersede:${scrimPostDbId}:${generation ?? 0}:${messageId}`;
  }
  return `close:${scrimPostDbId}:${eventType}:${messageId}`;
}

/**
 * Clé idempotente pour une lifecycle_edit de fallback après delete terminal (Phase 3I).
 *
 * @param {number} scrimPostDbId
 * @param {'closed_manual' | 'closed_expired'} targetStatus
 * @param {string} messageId
 * @returns {string}
 */
export function buildCloseFallbackEditEventKey(scrimPostDbId, targetStatus, messageId) {
  return `close-fallback-edit:${scrimPostDbId}:${targetStatus}:${messageId}`;
}

/**
 * Crée ou déduplique une op lifecycle_edit orchestrée pour fallback visuel post-delete terminal.
 *
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {{
 *   scrimPostDbId: number,
 *   guildId: string,
 *   channelId: string,
 *   messageId: string,
 *   targetStatus: 'closed_manual' | 'closed_expired',
 *   payloadJson: string,
 * }} p
 * @returns {{ operationId: number | null, deduplicated: boolean }}
 */
export function ensureCloseFallbackEditOperation(stmts, p) {
  const inserted = insertOrchestratedScrimLifecycleOperation(stmts, {
    scrimPostDbId: p.scrimPostDbId,
    guildId: p.guildId,
    channelId: p.channelId,
    messageId: p.messageId,
    operationType: LIFECYCLE_OP_TYPE_EDIT,
    targetStatus: p.targetStatus,
    eventKey: buildCloseFallbackEditEventKey(p.scrimPostDbId, p.targetStatus, p.messageId),
    payloadJson: p.payloadJson,
  });

  if (!inserted.deduplicated && inserted.operationId != null) {
    try {
      logger.info('scrimLifecycleOrchestrator: fallback_edit_op_created', {
        lifecycle_operation_id: inserted.operationId,
        scrim_post_db_id: p.scrimPostDbId,
        message_id: p.messageId,
        target_status: p.targetStatus,
        event_key: buildCloseFallbackEditEventKey(p.scrimPostDbId, p.targetStatus, p.messageId),
      });
    } catch {
      /* ignore */
    }
  }

  return {
    operationId: inserted.operationId,
    deduplicated: inserted.deduplicated,
  };
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {string} guildId
 * @returns {string}
 */
function resolveGuildLocale(stmts, guildId) {
  return stmts.getGuildLanguage ? getGuildLocale(guildId, stmts) : 'fr';
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {Record<string, unknown>} dbRow
 * @param {ScrimLifecycleEventType} eventType
 * @param {{ guild_id: string }} messageRow
 * @returns {string}
 */
function buildOrchestratedEditPayloadJson(stmts, dbRow, eventType, messageRow) {
  const locale = resolveGuildLocale(stmts, messageRow.guild_id);
  const editOptions =
    eventType === 'superseded_repost'
      ? buildScrimSupersededMessageEditOptions(dbRow, locale)
      : buildScrimClosedMessageEditOptions(
          /** @type {'closed_manual' | 'closed_expired'} */ (eventType),
          dbRow,
          locale,
        );
  return serializeScrimEditPayload(editOptions);
}

/**
 * Transaction SQLite : close métier + annulations Phase 2/3B + création ops lifecycle.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} dbId
 * @param {'closed_manual' | 'closed_expired'} status
 * @param {string} reason
 * @returns {{ closed: boolean, operations: Record<string, unknown>[], deduplicatedCount: number }}
 */
export function orchestrateScrimCloseInTransaction(db, stmts, dbId, status, reason) {
  const nowIso = new Date().toISOString();
  /** @type {Record<string, unknown>[]} */
  const operations = [];
  let deduplicatedCount = 0;
  let closed = false;

  const trx = db.transaction(() => {
    const info = stmts.closeScrimPostIfActive.run({
      id: dbId,
      status,
      closed_at: nowIso,
      closed_reason: reason,
    });
    if (info.changes === 0) return;

    closed = true;
    invalidateIncompatibleEditRetriesForScrimPost(stmts, dbId, status);

    const cancelNow = new Date().toISOString();
    stmts.cancelSupersedeLifecycleOpsForGeneration.run({
      scrim_post_db_id: dbId,
      event_key_like: `supersede:${dbId}:%`,
      completed_at: cancelNow,
      last_error_code: 'cancelled_close',
      last_error_message: 'supersede cancelled — scrim closed',
      updated_at: cancelNow,
    });

    if (isPersistentBroadcastEnabled()) {
      stmts.cancelPendingDeliveriesForScrim?.run({
        scrim_post_db_id: dbId,
        completed_at: nowIso,
        updated_at: nowIso,
      });
    }

    const dbRow = stmts.getScrimPostById.get(dbId);
    if (!dbRow) return;

    const messages = stmts.listScrimPostMessagesByPostId.all(dbId);
    for (const m of messages) {
      try {
        if (
          stmts.isScrimPostMessageDiscordDeleted.get(
            m.guild_id,
            m.channel_id,
            m.message_id,
          )
        ) {
          continue;
        }
      } catch {
        /* fail-open */
      }

      const policy = getGuildScrimMessageLifecyclePolicy(stmts, m.guild_id);
      const eventKey = buildScrimLifecycleEventKey(dbId, status, m.message_id);
      const operationType =
        policy === LIFECYCLE_POLICY_DELETE
          ? LIFECYCLE_OP_TYPE_DELETE
          : LIFECYCLE_OP_TYPE_EDIT;
      const payloadJson =
        operationType === LIFECYCLE_OP_TYPE_EDIT
          ? buildOrchestratedEditPayloadJson(stmts, dbRow, status, m)
          : null;

      const inserted = insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId: dbId,
        guildId: m.guild_id,
        channelId: m.channel_id,
        messageId: m.message_id,
        operationType,
        targetStatus: status,
        eventKey,
        payloadJson,
      });

      if (inserted.deduplicated) deduplicatedCount += 1;
      if (inserted.operationId != null) {
        const op = stmts.getScrimLifecycleOperationById.get(inserted.operationId);
        if (op) operations.push(op);
      }
    }
  });

  trx();

  if (closed) {
    try {
      logger.info('scrimLifecycleOrchestrator: operations_created', {
        scrim_post_db_id: dbId,
        event_type: status,
        operation_count: operations.length,
        deduplicated_count: deduplicatedCount,
      });
    } catch {
      /* ignore */
    }
  }

  if (deduplicatedCount > 0) {
    try {
      logger.info('scrimLifecycleOrchestrator: event_deduplicated', {
        scrim_post_db_id: dbId,
        event_type: status,
        deduplicated_count: deduplicatedCount,
      });
    } catch {
      /* ignore */
    }
  }

  return { closed, operations, deduplicatedCount };
}

/**
 * Crée des intentions close pour des messages quand le scrim est déjà fermé
 * (ex. nouveaux messages repost après close). Idempotent via event_key.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} scrimPostDbId
 * @param {{ guild_id: string, channel_id: string, message_id: string }[]} messages
 * @returns {{ operations: Record<string, unknown>[] }}
 */
export function orchestrateScrimCloseIntentionsForMessages(
  db,
  stmts,
  scrimPostDbId,
  messages,
) {
  /** @type {Record<string, unknown>[]} */
  const operations = [];
  const dbRow = stmts.getScrimPostById.get(scrimPostDbId);
  const status = dbRow?.status;
  if (status !== 'closed_manual' && status !== 'closed_expired') {
    return { operations };
  }

  const trx = db.transaction(() => {
    for (const m of messages) {
      try {
        if (
          stmts.isScrimPostMessageDiscordDeleted.get(
            m.guild_id,
            m.channel_id,
            m.message_id,
          )
        ) {
          continue;
        }
      } catch {
        /* fail-open */
      }

      const policy = getGuildScrimMessageLifecyclePolicy(stmts, m.guild_id);
      const eventKey = buildScrimLifecycleEventKey(
        scrimPostDbId,
        /** @type {'closed_manual' | 'closed_expired'} */ (status),
        m.message_id,
      );
      const operationType =
        policy === LIFECYCLE_POLICY_DELETE
          ? LIFECYCLE_OP_TYPE_DELETE
          : LIFECYCLE_OP_TYPE_EDIT;
      const payloadJson =
        operationType === LIFECYCLE_OP_TYPE_EDIT
          ? buildOrchestratedEditPayloadJson(
              stmts,
              dbRow,
              /** @type {'closed_manual' | 'closed_expired'} */ (status),
              m,
            )
          : null;

      const inserted = insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId,
        guildId: m.guild_id,
        channelId: m.channel_id,
        messageId: m.message_id,
        operationType,
        targetStatus: status,
        eventKey,
        payloadJson,
      });

      if (inserted.operationId != null) {
        const op = stmts.getScrimLifecycleOperationById.get(inserted.operationId);
        if (op) operations.push(op);
      }
    }
  });
  trx();

  return { operations };
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} scrimPostDbId
 * @param {number} generation
 */
export function cancelSupersedeOpsForGeneration(stmts, scrimPostDbId, generation) {
  const nowIso = new Date().toISOString();
  stmts.cancelSupersedeLifecycleOpsForGeneration.run({
    scrim_post_db_id: scrimPostDbId,
    event_key_like: `supersede:${scrimPostDbId}:${generation}:%`,
    completed_at: nowIso,
    last_error_code: 'cancelled_closed',
    last_error_message: 'supersede cancelled — scrim closed during repost',
    updated_at: nowIso,
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {Record<string, unknown>} dbRow
 * @param {{ guild_id: string, channel_id: string, message_id: string }[]} messages
 * @param {number} generation identité repost (repost_count+1 avant increment)
 * @returns {{ operations: Record<string, unknown>[], deduplicatedCount: number, skipped: boolean }}
 */
export function orchestrateScrimSupersedeInTransaction(
  db,
  stmts,
  dbRow,
  messages,
  generation,
) {
  /** @type {Record<string, unknown>[]} */
  const operations = [];
  let deduplicatedCount = 0;
  let skipped = false;
  const scrimPostDbId = Number(dbRow.id);

  const trx = db.transaction(() => {
    const fresh = stmts.getScrimPostById.get(scrimPostDbId);
    if (!fresh || fresh.status !== 'active') {
      skipped = true;
      return;
    }

    for (const m of messages) {
      try {
        if (
          stmts.isScrimPostMessageDiscordDeleted.get(
            m.guild_id,
            m.channel_id,
            m.message_id,
          )
        ) {
          continue;
        }
      } catch {
        /* fail-open */
      }

      const policy = getGuildScrimMessageLifecyclePolicy(stmts, m.guild_id);
      const eventKey = buildScrimLifecycleEventKey(
        scrimPostDbId,
        'superseded_repost',
        m.message_id,
        generation,
      );
      const operationType =
        policy === LIFECYCLE_POLICY_DELETE
          ? LIFECYCLE_OP_TYPE_DELETE
          : LIFECYCLE_OP_TYPE_EDIT;
      const payloadJson =
        operationType === LIFECYCLE_OP_TYPE_EDIT
          ? buildOrchestratedEditPayloadJson(stmts, fresh, 'superseded_repost', m)
          : null;

      const inserted = insertOrchestratedScrimLifecycleOperation(stmts, {
        scrimPostDbId,
        guildId: m.guild_id,
        channelId: m.channel_id,
        messageId: m.message_id,
        operationType,
        targetStatus: 'superseded_repost',
        eventKey,
        payloadJson,
      });

      if (inserted.deduplicated) deduplicatedCount += 1;
      if (inserted.operationId != null) {
        const op = stmts.getScrimLifecycleOperationById.get(inserted.operationId);
        if (op) operations.push(op);
      }
    }
  });

  trx();

  if (!skipped && operations.length > 0) {
    try {
      logger.info('scrimLifecycleOrchestrator: event_created', {
        scrim_post_db_id: scrimPostDbId,
        event_type: 'superseded_repost',
        generation,
        operation_count: operations.length,
      });
    } catch {
      /* ignore */
    }
  }

  return { operations, deduplicatedCount, skipped };
}

/**
 * @param {Record<string, unknown>} opRow
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @returns {boolean} true si stale (annulée)
 */
export function cancelOrchestratedOpIfStale(stmts, opRow) {
  const scrimRow = stmts.getScrimPostById.get(Number(opRow.scrim_post_db_id));
  const check = isScrimLifecycleTargetStatusCurrent(
    scrimRow?.status ?? null,
    /** @type {string} */ (opRow.target_status),
  );
  if (check.current) return false;

  markScrimLifecycleOperationCancelled(
    stmts,
    Number(opRow.id),
    check.reason ?? 'stale_target_status',
    `orchestrated op obsolete for scrim status ${scrimRow?.status ?? 'unknown'}`,
  );

  try {
    logger.info('scrimLifecycleRecovery: stale_cancelled', {
      lifecycle_operation_id: opRow.id,
      event_key: opRow.event_key,
      scrim_post_db_id: opRow.scrim_post_db_id,
      target_status: opRow.target_status,
      reason: check.reason,
    });
  } catch {
    /* ignore */
  }

  return true;
}

/**
 * Phase 3H — dernier recheck synchrone DB immédiatement avant Discord applicatif.
 * Réduit la micro-fenêtre post-fetch ; sans lock réseau ni transaction Discord.
 *
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} operationId
 * @returns {Promise<{ proceed: boolean, opRow?: Record<string, unknown> }>}
 */
async function finalRecheckOrchestratedOpBeforeDiscord(stmts, operationId) {
  if (orchestratedLifecycleTestHooks.beforeFinalDiscordRecheck) {
    await orchestratedLifecycleTestHooks.beforeFinalDiscordRecheck({
      operationId,
      opRow: stmts.getScrimLifecycleOperationById.get(operationId),
    });
  }

  const freshOpRow = stmts.getScrimLifecycleOperationById.get(operationId);
  if (
    !freshOpRow
    || freshOpRow.status === 'cancelled'
    || freshOpRow.status === 'completed'
    || freshOpRow.status === 'failed_terminal'
  ) {
    return { proceed: false };
  }
  if (cancelOrchestratedOpIfStale(stmts, freshOpRow)) {
    return { proceed: false };
  }
  return { proceed: true, opRow: freshOpRow };
}

/**
 * Finalise un échec prefetch : terminal → failed_terminal ; retryable → backoff futur.
 * Ne throw jamais vers le catch retry générique du dispatcher.
 *
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {Record<string, unknown>} opRow
 * @param {unknown} err
 * @param {'guild' | 'channel' | 'message'} stage
 * @returns {'failed' | 'queued' | 'completed'}
 */
function finalizeOrchestratedPrefetchError(stmts, opRow, err, stage) {
  const operationId = Number(opRow.id);
  const c = classifyDiscordEditError(err);

  if (
    stage === 'message'
    && String(c.code) === String(RESTJSONErrorCodes.UnknownMessage)
  ) {
    if (opRow.operation_type === LIFECYCLE_OP_TYPE_DELETE) {
      completeScrimLifecycleDeleteSuccess(
        stmts,
        operationId,
        {
          guild_id: /** @type {string} */ (opRow.guild_id),
          channel_id: /** @type {string} */ (opRow.channel_id),
          message_id: /** @type {string} */ (opRow.message_id),
        },
        { error_code: c.code, reason: 'prefetch_unknown_message' },
      );
    } else {
      markScrimLifecycleOperationCompleted(stmts, operationId);
      try {
        stmts.markScrimPostMessageDiscordDeleted.run({
          discord_deleted_at: new Date().toISOString(),
          guild_id: opRow.guild_id,
          channel_id: opRow.channel_id,
          message_id: opRow.message_id,
        });
      } catch {
        /* non bloquant */
      }
    }
    return 'completed';
  }

  if (c.kind === 'terminal') {
    markScrimLifecycleOperationFailedTerminal(stmts, operationId, c.code, c.message);
    try {
      logger.info('scrimLifecycleOrchestrator: prefetch_terminal', {
        lifecycle_operation_id: operationId,
        stage,
        error_code: c.code,
        operation_type: opRow.operation_type,
      });
    } catch {
      /* ignore */
    }
    return 'failed';
  }

  const out =
    opRow.operation_type === LIFECYCLE_OP_TYPE_DELETE
      ? scheduleScrimLifecycleDeleteRetry(stmts, operationId, c.code, c.message)
      : scheduleScrimLifecycleEditRetry(stmts, operationId, c.code, c.message);

  try {
    logger.info('scrimLifecycleOrchestrator: prefetch_retryable', {
      lifecycle_operation_id: operationId,
      stage,
      error_code: c.code,
      scheduled: out,
    });
  } catch {
    /* ignore */
  }

  return out === 'terminal' ? 'failed' : 'queued';
}

/**
 * @param {import('discord.js').Client} client
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {Record<string, unknown>} opRow
 * @param {{ fromDispatcher?: boolean }} [options]
 * @returns {Promise<'completed' | 'queued' | 'skipped' | 'failed'>}
 */
export async function executeOrchestratedLifecycleOperation(client, stmts, opRow, options = {}) {
  const fromDispatcher = options.fromDispatcher === true;
  if (cancelOrchestratedOpIfStale(stmts, opRow)) {
    return 'skipped';
  }

  if (opRow.status !== 'pending' && opRow.status !== 'processing') {
    return 'skipped';
  }

  const guildId = /** @type {string} */ (opRow.guild_id);
  const channelId = /** @type {string} */ (opRow.channel_id);
  const messageId = /** @type {string} */ (opRow.message_id);
  const scrimPostDbId = Number(opRow.scrim_post_db_id);
  const operationId = Number(opRow.id);

  // Garde-fou : op déjà au max (claim filtré + rows legacy) — pas de Discord.
  if (Number(opRow.attempt_count ?? 0) > SCRIM_LIFECYCLE_MAX_ATTEMPTS) {
    markScrimLifecycleOperationFailedTerminal(
      stmts,
      operationId,
      'RETRY_EXHAUSTED',
      `attempt_count=${opRow.attempt_count} > ${SCRIM_LIFECYCLE_MAX_ATTEMPTS}`,
    );
    return 'failed';
  }

  try {
    if (
      stmts.isScrimPostMessageDiscordDeleted.get(guildId, channelId, messageId)
    ) {
      if (opRow.operation_type === LIFECYCLE_OP_TYPE_DELETE) {
        completeScrimLifecycleDeleteSuccess(
          stmts,
          operationId,
          { guild_id: guildId, channel_id: channelId, message_id: messageId },
          { reason: 'already_discord_deleted_at' },
        );
      } else {
        markScrimLifecycleOperationCompleted(stmts, operationId);
      }
      return 'completed';
    }
  } catch {
    /* fail-open */
  }

  /** @type {import('discord.js').Guild | null} */
  let guild = null;
  try {
    guild = await runTransientDiscord(
      () => client.guilds.fetch(guildId),
      {
        kind: 'lifecycle_orchestrator_prefetch_guild',
        metadata: { operation_id: operationId, guild_id: guildId },
      },
    );
  } catch (err) {
    return finalizeOrchestratedPrefetchError(stmts, opRow, err, 'guild');
  }
  if (!guild) {
    markScrimLifecycleOperationFailedTerminal(
      stmts,
      operationId,
      'GUILD_MISSING',
      'guild fetch returned empty',
    );
    return 'failed';
  }

  /** @type {import('discord.js').GuildBasedChannel | null} */
  let channel = null;
  try {
    channel = await runTransientDiscord(
      () => guild.channels.fetch(channelId),
      {
        kind: 'lifecycle_orchestrator_prefetch_channel',
        metadata: { operation_id: operationId, channel_id: channelId },
      },
    );
  } catch (err) {
    return finalizeOrchestratedPrefetchError(stmts, opRow, err, 'channel');
  }
  if (!channel?.isTextBased()) {
    markScrimLifecycleOperationFailedTerminal(
      stmts,
      operationId,
      'CHANNEL_NOT_TEXT',
      'channel missing or not text-based',
    );
    return 'failed';
  }

  /** @type {import('discord.js').Message | null} */
  let msg = null;
  try {
    msg = await runTransientDiscord(
      () => channel.messages.fetch(messageId),
      {
        kind: 'lifecycle_orchestrator_prefetch_message',
        metadata: { operation_id: operationId, message_id: messageId },
      },
    );
  } catch (err) {
    return finalizeOrchestratedPrefetchError(stmts, opRow, err, 'message');
  }
  if (!msg) {
    markScrimLifecycleOperationFailedTerminal(
      stmts,
      operationId,
      'MESSAGE_MISSING',
      'message fetch returned empty',
    );
    return 'failed';
  }

  // Phase 3G — recheck stale le plus tard possible avant l'appel Discord applicatif.
  const freshOpRow = stmts.getScrimLifecycleOperationById.get(operationId);
  if (
    !freshOpRow
    || freshOpRow.status === 'cancelled'
    || freshOpRow.status === 'completed'
    || freshOpRow.status === 'failed_terminal'
  ) {
    return 'skipped';
  }
  if (cancelOrchestratedOpIfStale(stmts, freshOpRow)) {
    return 'skipped';
  }

  try {
    logger.info('scrimLifecycleRecovery: executing', {
      lifecycle_operation_id: operationId,
      event_key: opRow.event_key,
      scrim_post_db_id: scrimPostDbId,
      operation_type: opRow.operation_type,
      target_status: opRow.target_status,
    });
  } catch {
    /* ignore */
  }

  if (opRow.operation_type === LIFECYCLE_OP_TYPE_DELETE) {
    const deleted = await tryDeleteScrimMessage({
      stmts,
      guild,
      channel,
      message: msg,
      messageRow: { guild_id: guildId, channel_id: channelId, message_id: messageId },
      scrimPostDbId,
      eventType: /** @type {string} */ (opRow.target_status),
      lifecycleOperationId: operationId,
      directExecution: fromDispatcher,
    });
    if (deleted) {
      const fresh = stmts.getScrimLifecycleOperationById.get(operationId);
      if (fresh?.status === 'pending' && fresh?.next_attempt_at) {
        return 'queued';
      }
      return 'completed';
    }

    if (
      opRow.target_status === 'closed_manual' ||
      opRow.target_status === 'closed_expired'
    ) {
      const dbRow = stmts.getScrimPostById.get(scrimPostDbId);
      const locale = resolveGuildLocale(stmts, guildId);
      const payloadJson = serializeScrimEditPayload(
        buildScrimClosedMessageEditOptions(
          /** @type {'closed_manual' | 'closed_expired'} */ (opRow.target_status),
          dbRow,
          locale,
        ),
      );
      ensureCloseFallbackEditOperation(stmts, {
        scrimPostDbId,
        guildId,
        channelId,
        messageId,
        targetStatus: /** @type {'closed_manual' | 'closed_expired'} */ (opRow.target_status),
        payloadJson,
      });
      wakeScrimLifecycleDispatcher();
      return 'queued';
    }
    return 'failed';
  }

  const payload = opRow.payload_json
    ? JSON.parse(/** @type {string} */ (opRow.payload_json))
    : null;
  /** @type {{ content?: string | null, embeds: EmbedBuilder[], components?: import('discord.js').ActionRowBuilder[] | null }} */
  let editOptions;
  if (payload && payload.v === 2) {
    editOptions = {
      embeds: Array.isArray(payload.embeds)
        ? payload.embeds.map((e) => EmbedBuilder.from(e))
        : [],
    };
    if (payload.content !== null && payload.content !== undefined) {
      editOptions.content = payload.content;
    }
    if (Array.isArray(payload.components)) {
      editOptions.components = payload.components;
    } else {
      editOptions.components = [];
    }
  } else {
    const dbRow = stmts.getScrimPostById.get(scrimPostDbId);
    const locale = resolveGuildLocale(stmts, guildId);
    editOptions =
      opRow.target_status === 'superseded_repost'
        ? buildScrimSupersededMessageEditOptions(dbRow, locale)
        : buildScrimClosedMessageEditOptions(
            /** @type {'closed_manual' | 'closed_expired'} */ (opRow.target_status),
            dbRow,
            locale,
          );
  }

  const result = await safeScrimEmbedMessageEdit({
    client,
    stmts,
    scrimPostDbId,
    guildId,
    channelId,
    messageId,
    targetStatus: /** @type {string} */ (opRow.target_status),
    editOptions,
    message: msg,
    lifecycleOperationId: operationId,
    directExecution: fromDispatcher,
    beforeDiscordApply: fromDispatcher
      ? async () => {
          const check = await finalRecheckOrchestratedOpBeforeDiscord(stmts, operationId);
          return check.proceed;
        }
      : undefined,
  });

  if (result === 'ok') {
    try {
      logger.info('scrimLifecycleRecovery: completed', {
        lifecycle_operation_id: operationId,
        event_key: opRow.event_key,
        scrim_post_db_id: scrimPostDbId,
      });
    } catch {
      /* ignore */
    }
    return 'completed';
  }
  if (result === 'skipped_before_discord') return 'skipped';
  if (result === 'queued') return 'queued';
  return 'failed';
}

/**
 * Phase 3F/3I : réveille le dispatcher pour ops créées (close durable, sans drain bloquant).
 *
 * @param {import('discord.js').Client} _client
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} _stmts
 * @param {Record<string, unknown>[]} operations
 */
export function executeOrchestratedLifecycleOperations(_client, _stmts, operations) {
  if (operations.length === 0) return;
  wakeScrimLifecycleDispatcher();
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} dbId
 * @param {'closed_manual' | 'closed_expired'} status
 * @param {string} reason
 * @returns {boolean}
 */
export function closeScrimPostByDbIdOrchestrated(db, stmts, dbId, status, reason) {
  return orchestrateScrimCloseInTransaction(db, stmts, dbId, status, reason).closed;
}

/**
 * @param {import('discord.js').Client} client
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} dbId
 * @param {'closed_manual' | 'closed_expired'} status
 * @param {string} reason
 * @returns {Promise<boolean>}
 */
export async function closeScrimPostByDbIdAndExecuteLifecycle(
  client,
  db,
  stmts,
  dbId,
  status,
  reason,
) {
  const result = orchestrateScrimCloseInTransaction(db, stmts, dbId, status, reason);
  if (!result.closed) return false;
  executeOrchestratedLifecycleOperations(client, stmts, result.operations);
  return true;
}
