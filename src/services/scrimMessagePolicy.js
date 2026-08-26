import { PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { enqueueDiscordTask } from './discordTaskQueue.js';
import {
  createScrimLifecycleOperation,
  LIFECYCLE_OP_TYPE_DELETE,
  markScrimLifecycleOperationFailedTerminal,
} from './scrimLifecycleOperationStore.js';
import {
  classifyDiscordDeleteError,
  completeScrimLifecycleDeleteSuccess,
  markScrimLifecycleDeleteProcessing,
  scheduleScrimLifecycleDeleteRetry,
} from './scrimLifecycleDeleteRetry.js';
import { safeScrimEmbedMessageEdit } from './safeDiscordMessageEdit.js';

/** @typedef {'keep' | 'delete'} ScrimMessageLifecyclePolicy */

export const LIFECYCLE_POLICY_KEEP = /** @type {ScrimMessageLifecyclePolicy} */ ('keep');
export const LIFECYCLE_POLICY_DELETE = /** @type {ScrimMessageLifecyclePolicy} */ ('delete');

/**
 * Lit la policy d'un serveur depuis la DB.
 * Retourne toujours `keep` en cas d'erreur ou d'absence de ligne (fail-safe).
 *
 * @param {{ getScrimMessageLifecyclePolicy: import('better-sqlite3').Statement }} stmts
 * @param {string} guildId
 * @returns {ScrimMessageLifecyclePolicy}
 */
export function getGuildScrimMessageLifecyclePolicy(stmts, guildId) {
  try {
    const row = stmts.getScrimMessageLifecyclePolicy.get(guildId);
    if (row?.policy === LIFECYCLE_POLICY_DELETE) return LIFECYCLE_POLICY_DELETE;
    return LIFECYCLE_POLICY_KEEP;
  } catch (err) {
    logger.error('getGuildScrimMessageLifecyclePolicy: erreur lecture DB', {
      guild_id: guildId,
      message: err instanceof Error ? err.message : String(err),
    });
    return LIFECYCLE_POLICY_KEEP;
  }
}

/**
 * Tente de supprimer un message scrim via la file Discord.
 * Sécurité absolue : vérifie que les IDs du message Discord correspondent exactement
 * à ceux stockés en base avant toute suppression.
 *
 * @param {{
 *   stmts: ReturnType<import('../database/db.js')['prepareStatements']>,
 *   guild: import('discord.js').Guild,
 *   channel: import('discord.js').TextBasedChannel,
 *   message: import('discord.js').Message,
 *   messageRow: { guild_id: string, channel_id: string, message_id: string },
 *   scrimPostDbId: number,
 *   eventType: string,
 * }} p
 * @returns {Promise<boolean>} true si supprimé (ou déjà absent), false si impossible
 */
/**
 * Phase 3A shadow row — best-effort avant enqueue delete legacy.
 *
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {object} p
 * @returns {number | null}
 */
function tryCreateDeleteShadowOperation(stmts, p) {
  try {
    return createScrimLifecycleOperation(stmts, {
      scrimPostDbId: p.scrimPostDbId,
      guildId: p.messageRow.guild_id,
      channelId: p.messageRow.channel_id,
      messageId: p.messageRow.message_id,
      operationType: LIFECYCLE_OP_TYPE_DELETE,
      targetStatus: p.eventType,
      priority: 'low',
      payloadJson: null,
    });
  } catch (dbErr) {
    logger.warn('scrimMessagePolicy: shadow lifecycle delete op non créée', {
      scrim_post_db_id: p.scrimPostDbId,
      guild_id: p.messageRow.guild_id,
      message_id: p.messageRow.message_id,
      message: dbErr instanceof Error ? dbErr.message : String(dbErr),
    });
    return null;
  }
}

async function tryDeleteScrimMessage({
  stmts,
  guild,
  channel,
  message,
  messageRow,
  scrimPostDbId,
  eventType,
  lifecycleOperationId = null,
  directExecution = false,
}) {
  /** @type {number | null} */
  const operationId =
    lifecycleOperationId != null
      ? Number(lifecycleOperationId)
      : tryCreateDeleteShadowOperation(stmts, {
          messageRow,
          scrimPostDbId,
          eventType,
        });

  const failShadow = (code, msg) => {
    if (operationId != null) {
      markScrimLifecycleOperationFailedTerminal(stmts, operationId, code, msg);
    }
  };

  // Vérification de sécurité absolue : correspondance stricte des IDs
  if (
    message.guildId !== messageRow.guild_id
    || message.channelId !== messageRow.channel_id
    || message.id !== messageRow.message_id
  ) {
    failShadow('SECURITY_MISMATCH', 'IDs message Discord ≠ DB');
    logger.warn('scrimMessagePolicy: mismatch IDs — suppression refusée (sécurité)', {
      scrim_post_db_id: scrimPostDbId,
      event_type: eventType,
      expected_guild: messageRow.guild_id,
      expected_channel: messageRow.channel_id,
      expected_message: messageRow.message_id,
      actual_guild: message.guildId,
      actual_channel: message.channelId,
      actual_message: message.id,
      lifecycle_operation_id: operationId,
    });
    return false;
  }

  // Vérification des permissions ManageMessages
  let botMember = guild.members.me;
  if (!botMember) {
    botMember = await guild.members.fetchMe().catch(() => null);
  }

  if (!botMember) {
    failShadow('BOT_MEMBER_MISSING', 'Membre bot introuvable');
    logger.warn('scrimMessagePolicy: bot member introuvable — suppression impossible', {
      guild_id: messageRow.guild_id,
      scrim_post_db_id: scrimPostDbId,
      event_type: eventType,
      lifecycle_operation_id: operationId,
    });
    return false;
  }

  const perms = channel.permissionsFor(botMember);
  const need = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ManageMessages,
  ];
  const missing = perms ? need.filter((p) => !perms.has(p)) : need;

  if (missing.length > 0) {
    failShadow('MISSING_PERMISSIONS', 'ManageMessages ou permissions lecture manquantes');
    logger.warn('scrimMessagePolicy: permissions manquantes — suppression impossible, fallback édition', {
      guild_id: messageRow.guild_id,
      channel_id: messageRow.channel_id,
      message_id: messageRow.message_id,
      scrim_post_db_id: scrimPostDbId,
      event_type: eventType,
      lifecycle_operation_id: operationId,
    });
    return false;
  }

  if (directExecution) {
    try {
      await message.delete();
      completeScrimLifecycleDeleteSuccess(stmts, operationId, messageRow, {
        event_type: eventType,
      });
      return true;
    } catch (err) {
      const c = classifyDiscordDeleteError(err);
      if (c.kind === 'already_gone') {
        completeScrimLifecycleDeleteSuccess(stmts, operationId, messageRow, {
          event_type: eventType,
          error_code: c.code,
        });
        return true;
      }
      if (c.kind === 'terminal') {
        if (operationId != null) {
          markScrimLifecycleOperationFailedTerminal(stmts, operationId, c.code, c.message);
        }
        return false;
      }
      if (operationId != null) {
        const out = scheduleScrimLifecycleDeleteRetry(stmts, operationId, c.code, c.message);
        return out === 'scheduled';
      }
      return false;
    }
  }

  if (operationId != null) {
    markScrimLifecycleDeleteProcessing(stmts, operationId);
  }

  try {
    await enqueueDiscordTask(
      async () => {
        try {
          await message.delete();
        } catch (deleteErr) {
          const c = classifyDiscordDeleteError(deleteErr);
          if (c.kind === 'already_gone') {
            completeScrimLifecycleDeleteSuccess(stmts, operationId, messageRow, {
              event_type: eventType,
              error_code: c.code,
            });
            return;
          }
          throw deleteErr;
        }
        completeScrimLifecycleDeleteSuccess(stmts, operationId, messageRow, {
          event_type: eventType,
        });
      },
      {
        kind: 'scrim_message_policy_delete',
        scrim_post_db_id: scrimPostDbId,
        guild_id: messageRow.guild_id,
        channel_id: messageRow.channel_id,
        message_id: messageRow.message_id,
        event_type: eventType,
        lifecycle_operation_id: operationId,
      },
      'low',
    );
    logger.info('scrimMessagePolicy: message supprimé', {
      scrim_post_db_id: scrimPostDbId,
      guild_id: messageRow.guild_id,
      channel_id: messageRow.channel_id,
      message_id: messageRow.message_id,
      event_type: eventType,
      lifecycle_operation_id: operationId,
    });
    return true;
  } catch (err) {
    const c = classifyDiscordDeleteError(err);

    if (c.kind === 'already_gone') {
      completeScrimLifecycleDeleteSuccess(stmts, operationId, messageRow, {
        event_type: eventType,
        error_code: c.code,
      });
      logger.info('scrimMessagePolicy: message déjà supprimé (10008) — marqué en DB', {
        scrim_post_db_id: scrimPostDbId,
        guild_id: messageRow.guild_id,
        message_id: messageRow.message_id,
        event_type: eventType,
        lifecycle_operation_id: operationId,
      });
      return true;
    }

    if (c.kind === 'terminal') {
      if (operationId != null) {
        markScrimLifecycleOperationFailedTerminal(stmts, operationId, c.code, c.message);
      }
      logger.warn('scrimMessagePolicy: échec suppression terminal — fallback édition', {
        scrim_post_db_id: scrimPostDbId,
        guild_id: messageRow.guild_id,
        channel_id: messageRow.channel_id,
        message_id: messageRow.message_id,
        event_type: eventType,
        error_code: c.code,
        lifecycle_operation_id: operationId,
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    // Échec transitoire après épuisement queue legacy → retry persistant, pas de fallback edit immédiat
    if (operationId != null) {
      const out = scheduleScrimLifecycleDeleteRetry(stmts, operationId, c.code, c.message);
      if (out === 'scheduled') {
        logger.warn('scrimMessagePolicy: échec suppression retryable — retry persistant planifié', {
          scrim_post_db_id: scrimPostDbId,
          guild_id: messageRow.guild_id,
          message_id: messageRow.message_id,
          event_type: eventType,
          error_code: c.code,
          lifecycle_operation_id: operationId,
        });
        return true;
      }
    }

    logger.warn('scrimMessagePolicy: échec suppression — fallback édition', {
      scrim_post_db_id: scrimPostDbId,
      guild_id: messageRow.guild_id,
      channel_id: messageRow.channel_id,
      message_id: messageRow.message_id,
      event_type: eventType,
      error_code: c.code,
      lifecycle_operation_id: operationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export { tryDeleteScrimMessage };

/**
 * Gère un message scrim inactif selon la policy configurée pour son serveur.
 *
 * - Policy `keep` (défaut) : édition de l'embed (comportement historique).
 * - Policy `delete` : suppression sécurisée du message.
 *   Si la suppression est impossible (permissions manquantes, erreur réseau),
 *   fallback automatique vers l'édition embed.
 *
 * Ne fait rien si guild / channel / message est absent (non bloquant).
 *
 * @param {{
 *   client: import('discord.js').Client,
 *   stmts: ReturnType<import('../database/db.js')['prepareStatements']>,
 *   messageRow: { guild_id: string, channel_id: string, message_id: string },
 *   scrimPostDbId: number,
 *   eventType: 'closed_manual' | 'closed_expired' | 'superseded_repost',
 *   targetStatus: string,
 *   editOptions: {
 *     content?: string | null,
 *     embeds: import('discord.js').EmbedBuilder[],
 *     components?: import('discord.js').ActionRowBuilder[] | null,
 *   },
 *   guild: import('discord.js').Guild | null,
 *   channel: import('discord.js').GuildChannel | import('discord.js').TextBasedChannel | null,
 *   message: import('discord.js').Message | null,
 * }} p
 * @returns {Promise<void>}
 */
export async function syncInactiveScrimMessageByPolicy(p) {
  const {
    client,
    stmts,
    messageRow,
    scrimPostDbId,
    eventType,
    targetStatus,
    editOptions,
    guild,
    channel,
    message,
  } = p;

  if (!guild || !channel || !message) {
    return;
  }

  const policy = getGuildScrimMessageLifecyclePolicy(stmts, messageRow.guild_id);

  if (policy === LIFECYCLE_POLICY_DELETE) {
    const deleted = await tryDeleteScrimMessage({
      stmts,
      guild,
      channel,
      message,
      messageRow,
      scrimPostDbId,
      eventType,
    });

    if (deleted) return;

    logger.info('scrimMessagePolicy: fallback édition embed après échec suppression', {
      scrim_post_db_id: scrimPostDbId,
      guild_id: messageRow.guild_id,
      event_type: eventType,
    });
  }

  await safeScrimEmbedMessageEdit({
    client,
    stmts,
    scrimPostDbId,
    guildId: messageRow.guild_id,
    channelId: messageRow.channel_id,
    messageId: messageRow.message_id,
    targetStatus,
    editOptions,
    message,
  });
}
