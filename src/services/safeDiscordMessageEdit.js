import { ActionRowBuilder, EmbedBuilder } from 'discord.js';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { logger } from '../utils/logger.js';
import {
  classifyDiscordEditError,
  computeNextRetryDelayMs,
} from './discordRetryPolicy.js';
import { enqueueDiscordTask } from './discordTaskQueue.js';
import {
  createScrimLifecycleOperation,
  LIFECYCLE_OP_TYPE_EDIT,
  markScrimLifecycleOperationCompleted,
  markScrimLifecycleOperationFailedTerminal,
  markScrimLifecycleOperationProcessing,
  resetScrimLifecycleOperationPending,
} from './scrimLifecycleOperationStore.js';
import {
  invalidateIncompatibleEditRetriesForMessage,
} from './scrimLifecycleEditCoalescing.js';
import { isDefinitiveLifecycleCloseTarget } from './scrimLifecycleTargetStatus.js';
import { scheduleScrimLifecycleEditRetry } from './scrimLifecycleEditRetry.js';

/** Code Discord API : message inconnu (déjà supprimé). */
const DISCORD_UNKNOWN_MESSAGE = RESTJSONErrorCodes.UnknownMessage;

/**
 * Sérialise une édition scrim pour la file SQLite (retry mono-instance).
 * v2 : content + embeds JSON ; legacy en base = JSON d’un seul embed (sans clé `v`).
 *
 * @param {{
 *   content?: string | null,
 *   embeds: import('discord.js').EmbedBuilder[],
 *   components?: import('discord.js').ActionRowBuilder[] | null,
 * }} editOptions
 */
export function serializeScrimEditPayload(editOptions) {
  const embeds = editOptions.embeds ?? [];
  /** @type {Record<string, unknown>} */
  const o = {
    v: 2,
    content: editOptions.content ?? null,
    embeds: embeds.map((e) => e.toJSON()),
  };
  if (Array.isArray(editOptions.components)) {
    o.components = editOptions.components.map((row) =>
      row && typeof row.toJSON === 'function' ? row.toJSON() : row,
    );
  }
  return JSON.stringify(o);
}

/**
 * Phase 3A shadow row — best-effort, n’influence pas le chemin Discord legacy.
 *
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {object} p
 * @returns {number | null}
 */
function tryCreateEditShadowOperation(stmts, p) {
  try {
    return createScrimLifecycleOperation(stmts, {
      scrimPostDbId: p.scrimPostDbId,
      guildId: p.guildId,
      channelId: p.channelId,
      messageId: p.messageId,
      operationType: LIFECYCLE_OP_TYPE_EDIT,
      targetStatus: p.targetStatus,
      priority: 'low',
      payloadJson: p.payloadJson,
    });
  } catch (dbErr) {
    logger.warn('safeScrimEmbedMessageEdit: shadow lifecycle op non créée', {
      scrim_post_db_id: p.scrimPostDbId,
      guild_id: p.guildId,
      message_id: p.messageId,
      message: dbErr instanceof Error ? dbErr.message : String(dbErr),
    });
    return null;
  }
}

/**
 * Tente `message.edit(editOptions)` pour une diffusion scrim.
 * Erreurs terminales : log, pas de file.
 * Erreurs retryables : enregistrement SQLite (mono-instance).
 *
 * Phase 3A : une row `scrim_lifecycle_operations` (shadow) est créée avant enqueue ;
 * l’exécution Discord reste identique. Sur échec retryable, la row repasse `pending`
 * et `discord_message_edit_retries` (legacy) continue de piloter les retries.
 *
 * @param {{
 *   client: import('discord.js').Client,
 *   stmts: ReturnType<import('../database/db.js')['prepareStatements']>,
 *   scrimPostDbId: number,
 *   guildId: string,
 *   channelId: string,
 *   messageId: string,
 *   targetStatus: string,
 *   editOptions: {
 *     content?: string | null,
 *     embeds: import('discord.js').EmbedBuilder[],
 *     components?: import('discord.js').ActionRowBuilder[] | null,
 *   },
 *   message: import('discord.js').Message,
 *   lifecycleOperationId?: number | null,
 *   directExecution?: boolean,
 *   beforeDiscordApply?: () => Promise<boolean>,
 * }} p
 * @returns {Promise<'ok' | 'terminal' | 'queued' | 'skipped_before_discord'>}
 */
export async function safeScrimEmbedMessageEdit(p) {
  const {
    stmts,
    scrimPostDbId,
    guildId,
    channelId,
    messageId,
    targetStatus,
    editOptions,
    message,
    lifecycleOperationId: existingLifecycleOperationId = null,
    directExecution = false,
    beforeDiscordApply,
  } = p;

  /** Sérialisation locale : erreur = données invalides — terminal, pas de retry réseau. */
  let payloadJson;
  try {
    payloadJson = serializeScrimEditPayload(editOptions);
  } catch (serErr) {
    logger.error('safeScrimEmbedMessageEdit: sérialisation payload impossible (terminal)', {
      scrim_post_db_id: scrimPostDbId,
      guild_id: guildId,
      channel_id: channelId,
      message_id: messageId,
      target_status: targetStatus,
      message: serErr instanceof Error ? serErr.message : String(serErr),
      stack: serErr instanceof Error ? serErr.stack : undefined,
    });
    return 'terminal';
  }

  const nowIso = new Date().toISOString();

  /** @type {number | null} */
  const operationId =
    existingLifecycleOperationId != null
      ? Number(existingLifecycleOperationId)
      : tryCreateEditShadowOperation(stmts, {
          scrimPostDbId,
          guildId,
          channelId,
          messageId,
          targetStatus,
          payloadJson,
        });

  const opRow = operationId != null ? stmts.getScrimLifecycleOperationById.get(operationId) : null;
  const isOrchestratedOp = Boolean(opRow?.event_key);

  /**
   * @param {unknown} err
   * @returns {'ok' | 'terminal' | 'queued'}
   */
  function handleEditError(err) {
    const c = classifyDiscordEditError(err);

    if (c.kind === 'terminal' && c.code === String(DISCORD_UNKNOWN_MESSAGE)) {
      if (operationId != null) {
        markScrimLifecycleOperationCompleted(stmts, operationId);
      }
      try {
        stmts.markScrimPostMessageDiscordDeleted.run({
          discord_deleted_at: new Date().toISOString(),
          guild_id: guildId,
          channel_id: channelId,
          message_id: messageId,
        });
      } catch {
        /* non bloquant */
      }
      return 'ok';
    }

    if (c.kind === 'terminal') {
      if (operationId != null) {
        markScrimLifecycleOperationFailedTerminal(stmts, operationId, c.code, c.message);
      }
      return 'terminal';
    }

    if (isOrchestratedOp && operationId != null) {
      const out = scheduleScrimLifecycleEditRetry(stmts, operationId, c.code, c.message);
      return out === 'terminal' ? 'terminal' : 'queued';
    }

    const delay0 = computeNextRetryDelayMs(0);
    if (delay0 == null) {
      if (operationId != null) {
        markScrimLifecycleOperationFailedTerminal(stmts, operationId, 'MAX_RETRIES', 'delay null');
      }
      return 'terminal';
    }

    const nextAttemptAt = new Date(Date.now() + delay0).toISOString();

    if (operationId != null) {
      resetScrimLifecycleOperationPending(stmts, operationId, c.code, c.message);
    }

    try {
      const scrimRow = stmts.getScrimPostById.get(scrimPostDbId);
      const scrimPostStatus = scrimRow?.status ?? 'active';

      if (isDefinitiveLifecycleCloseTarget(targetStatus)) {
        invalidateIncompatibleEditRetriesForMessage(
          stmts,
          scrimPostDbId,
          guildId,
          channelId,
          messageId,
          scrimPostStatus,
          targetStatus,
        );
      }

      const existing = stmts.getPendingDiscordEditRetry.get(
        guildId,
        channelId,
        messageId,
        targetStatus,
      );

      if (existing) {
        stmts.updateDiscordEditRetryPendingRefresh.run({
          id: existing.id,
          payload_json: payloadJson,
          attempt_count: 0,
          next_attempt_at: nextAttemptAt,
          last_error_code: c.code,
          last_error_message: c.message,
          lifecycle_operation_id: operationId,
          updated_at: nowIso,
        });
      } else {
        stmts.insertDiscordEditRetry.run({
          scrim_post_db_id: scrimPostDbId,
          guild_id: guildId,
          channel_id: channelId,
          message_id: messageId,
          target_status: targetStatus,
          attempt_count: 0,
          next_attempt_at: nextAttemptAt,
          last_error_code: c.code,
          last_error_message: c.message,
          payload_json: payloadJson,
          lifecycle_operation_id: operationId,
          created_at: nowIso,
          updated_at: nowIso,
        });
      }
    } catch (dbErr) {
      if (operationId != null) {
        markScrimLifecycleOperationFailedTerminal(
          stmts,
          operationId,
          'LEGACY_RETRY_ENQUEUE_FAILED',
          dbErr instanceof Error ? dbErr.message : String(dbErr),
        );
      }
      return 'terminal';
    }

    return 'queued';
  }

  /**
   * Shadow mark après Discord réussi — ne doit jamais faire échouer le taskFn.
   * @param {number} opId
   */
  function safeMarkShadowCompletedAfterDiscord(opId) {
    try {
      markScrimLifecycleOperationCompleted(stmts, opId);
    } catch (shadowErr) {
      logger.warn('safeScrimEmbedMessageEdit: shadow mark completed échoué (non bloquant)', {
        lifecycle_operation_id: opId,
        scrim_post_db_id: scrimPostDbId,
        guild_id: guildId,
        channel_id: channelId,
        message_id: messageId,
        target_status: targetStatus,
        message: shadowErr instanceof Error ? shadowErr.message : String(shadowErr),
      });
    }
  }

  if (directExecution) {
    if (typeof beforeDiscordApply === 'function') {
      const proceed = await beforeDiscordApply();
      if (!proceed) return 'skipped_before_discord';
    }
    try {
      await message.edit(editOptions);
      if (operationId != null) {
        safeMarkShadowCompletedAfterDiscord(operationId);
      }
      return 'ok';
    } catch (err) {
      return handleEditError(err);
    }
  }

  try {
    await enqueueDiscordTask(
      async () => {
        if (operationId != null) {
          markScrimLifecycleOperationProcessing(stmts, operationId);
        }
        await message.edit(editOptions);
        if (operationId != null) {
          safeMarkShadowCompletedAfterDiscord(operationId);
        }
      },
      {
        kind: 'scrim_embed_edit',
        scrim_post_db_id: scrimPostDbId,
        guild_id: guildId,
        channel_id: channelId,
        message_id: messageId,
        lifecycle_operation_id: operationId,
      },
      'low',
    );
    logger.info('safeScrimEmbedMessageEdit: édition OK', {
      scrim_post_db_id: scrimPostDbId,
      guild_id: guildId,
      channel_id: channelId,
      message_id: messageId,
      target_status: targetStatus,
      lifecycle_operation_id: operationId,
    });
    return 'ok';
  } catch (err) {
    return handleEditError(err);
  }
}

/**
 * Réessaie une édition à partir du JSON stocké (v2 ou legacy embed seul).
 * Phase 3A : non instrumenté (chemin legacy discordEditRetryJob).
 *
 * @param {import('discord.js').Message} message
 * @param {string} payloadJson
 */
export async function applyScrimEmbedEditFromPayload(message, payloadJson) {
  const data = JSON.parse(payloadJson);
  /** @type {{
   *   content?: string | null,
   *   embeds: import('discord.js').EmbedBuilder[],
   *   components?: import('discord.js').ActionRowBuilder<import('discord.js').ButtonBuilder>[],
   * }} */
  let editOptions;
  if (data && data.v === 2) {
    const embeds = Array.isArray(data.embeds)
      ? data.embeds.map((e) => EmbedBuilder.from(e))
      : [];
    editOptions = { embeds };
    if (data.content !== null && data.content !== undefined) {
      editOptions.content = data.content;
    }
    if (Array.isArray(data.components)) {
      editOptions.components = data.components.map((row) =>
        ActionRowBuilder.from(/** @type {import('discord.js').APIActionRowComponent} */ (row)),
      );
    } else if (Array.isArray(data.embeds) && data.embeds.length === 0) {
      /** Anciens enregistrements retry sans clé `components` : fermeture → retirer boutons éventuels. */
      editOptions.components = [];
    }
  } else {
    editOptions = { embeds: [EmbedBuilder.from(data)] };
  }
  await enqueueDiscordTask(
    async () => {
      await message.edit(editOptions);
    },
    {
      kind: 'scrim_embed_edit_retry',
      message_id: message.id,
      channel_id: message.channelId,
    },
    'low',
  );
}
