import { ActionRowBuilder, EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';
import {
  classifyDiscordEditError,
  computeNextRetryDelayMs,
} from './discordRetryPolicy.js';
import { enqueueDiscordTask } from './discordTaskQueue.js';

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
function serializeScrimEditPayload(editOptions) {
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
 * Tente `message.edit(editOptions)` pour une diffusion scrim.
 * Erreurs terminales : log, pas de file.
 * Erreurs retryables : enregistrement SQLite (mono-instance).
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
 * }} p
 * @returns {Promise<'ok' | 'terminal' | 'queued'>}
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

  try {
    await enqueueDiscordTask(
      async () => {
        await message.edit(editOptions);
      },
      {
        kind: 'scrim_embed_edit',
        scrim_post_db_id: scrimPostDbId,
        guild_id: guildId,
        channel_id: channelId,
        message_id: messageId,
      },
      'low',
    );
    logger.info('safeScrimEmbedMessageEdit: édition OK', {
      scrim_post_db_id: scrimPostDbId,
      guild_id: guildId,
      channel_id: channelId,
      message_id: messageId,
      target_status: targetStatus,
    });
    return 'ok';
  } catch (err) {
    const c = classifyDiscordEditError(err);
    if (c.kind === 'terminal') {
      logger.warn('safeScrimEmbedMessageEdit: échec terminal (pas de retry)', {
        scrim_post_db_id: scrimPostDbId,
        guild_id: guildId,
        channel_id: channelId,
        message_id: messageId,
        target_status: targetStatus,
        error_code: c.code,
        message: c.message,
      });
      return 'terminal';
    }

    const delay0 = computeNextRetryDelayMs(0);
    if (delay0 == null) {
      logger.warn('safeScrimEmbedMessageEdit: délai null à l’enqueue (inattendu)', {
        scrim_post_db_id: scrimPostDbId,
      });
      return 'terminal';
    }

    const nextAttemptAt = new Date(Date.now() + delay0).toISOString();

    try {
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
          created_at: nowIso,
          updated_at: nowIso,
        });
      }

      logger.warn('safeScrimEmbedMessageEdit: échec retryable — file SQLite', {
        scrim_post_db_id: scrimPostDbId,
        guild_id: guildId,
        channel_id: channelId,
        message_id: messageId,
        target_status: targetStatus,
        error_code: c.code,
        next_attempt_at: nextAttemptAt,
      });
    } catch (dbErr) {
      logger.error('safeScrimEmbedMessageEdit: échec enqueue SQLite', {
        scrim_post_db_id: scrimPostDbId,
        message: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
      return 'terminal';
    }

    return 'queued';
  }
}

/**
 * Réessaie une édition à partir du JSON stocké (v2 ou legacy embed seul).
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
