import { logger } from '../utils/logger.js';
import { isPlayerSearchExpired } from '../utils/playerSearchExpiration.js';
import { buildPlayerSearchClosedMessageEditOptions } from './playerSearchEmbedBuilder.js';
import { normalizePlayerSearchPublicId } from './playerSearchPublicId.js';
import { runTransientDiscord } from './discordApiGuard.js';
import { enqueueDiscordTask } from './discordTaskQueue.js';

/** Délai entre éditions d’embeds (anti rate-limit Discord), en ms. */
export const PLAYER_SEARCH_EDIT_DELAY_MS = 75;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const MS_TOO_MANY =
  '❌ Trop de recherches actives actuellement. Réessaie dans quelques minutes.';

export const MSG_NO_ACTIVE =
  '❌ Aucune recherche active trouvée pour cet ID.';
export const MSG_NOT_AUTHOR =
  '❌ Tu ne peux fermer que tes propres recherches.';
export const MSG_ALREADY_DONE =
  '❌ Cette recherche est déjà terminée.';
export const MSG_OK_CLOSE =
  '✅ Ta recherche de joueur a été marquée comme terminée.';

/**
 * @param {import('discord.js').Client} client
 * @param {{
 *   listPlayerSearchPostMessagesByPostId: import('better-sqlite3').Statement,
 * }} playerSearchStmts
 * @param {Record<string, unknown>} dbRow
 */
export async function updatePlayerSearchPostMessagesEmbeds(
  client,
  playerSearchStmts,
  dbRow,
) {
  const messages = playerSearchStmts.listPlayerSearchPostMessagesByPostId.all(
    dbRow.id,
  );
  const status = /** @type {'closed_manual' | 'closed_expired'} */ (
    dbRow.status
  );
  if (status !== 'closed_manual' && status !== 'closed_expired') {
    logger.warn('player_search: statut inattendu pour sync embeds', {
      player_search_post_db_id: dbRow.id,
      status,
    });
    return;
  }

  const editOptions = buildPlayerSearchClosedMessageEditOptions(status, dbRow);
  const postDbId = Number(dbRow.id);

  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (i > 0) await sleep(PLAYER_SEARCH_EDIT_DELAY_MS);

    try {
      const guild = await runTransientDiscord(
        () => client.guilds.fetch(m.guild_id),
        {
          kind: 'player_search_close_prefetch_guild',
          metadata: {
            guild_id: m.guild_id,
            player_search_post_db_id: postDbId,
          },
        },
      ).catch(() => null);

      if (!guild) {
        logger.warn('player_search: guilde introuvable pour fermeture embed', {
          guild_id: m.guild_id,
          player_search_post_db_id: postDbId,
        });
        continue;
      }

      const channel = await runTransientDiscord(
        () => guild.channels.fetch(m.channel_id),
        {
          kind: 'player_search_close_prefetch_channel',
          metadata: {
            guild_id: m.guild_id,
            channel_id: m.channel_id,
            player_search_post_db_id: postDbId,
          },
        },
      ).catch(() => null);

      if (!channel?.isTextBased()) {
        logger.warn('player_search: salon introuvable pour fermeture embed', {
          channel_id: m.channel_id,
          player_search_post_db_id: postDbId,
        });
        continue;
      }

      const msg = await runTransientDiscord(
        () => channel.messages.fetch(m.message_id),
        {
          kind: 'player_search_close_prefetch_message',
          metadata: {
            guild_id: m.guild_id,
            channel_id: m.channel_id,
            message_id: m.message_id,
            player_search_post_db_id: postDbId,
          },
        },
      ).catch(() => null);

      if (!msg) {
        logger.warn('player_search: message introuvable pour fermeture embed', {
          message_id: m.message_id,
          player_search_post_db_id: postDbId,
        });
        continue;
      }

      await enqueueDiscordTask(
        () => msg.edit(editOptions),
        {
          kind: 'player_search_close_embed_edit',
          player_search_post_db_id: postDbId,
          guild_id: m.guild_id,
          channel_id: m.channel_id,
          message_id: m.message_id,
          target_status: status,
        },
        'high',
      );
    } catch (err) {
      logger.warn('player_search: erreur édition embed fermeture', {
        player_search_post_db_id: postDbId,
        guild_id: m.guild_id,
        channel_id: m.channel_id,
        message_id: m.message_id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   closePlayerSearchPostIfActive: import('better-sqlite3').Statement,
 * }} playerSearchStmts
 * @param {number} dbId
 * @param {'closed_manual' | 'closed_expired'} status
 * @param {string} reason
 * @returns {boolean}
 */
export function closePlayerSearchPostByDbId(
  db,
  playerSearchStmts,
  dbId,
  status,
  reason,
) {
  const nowIso = new Date().toISOString();
  const trx = db.transaction(() =>
    playerSearchStmts.closePlayerSearchPostIfActive.run({
      id: dbId,
      status,
      closed_at: nowIso,
      closed_reason: reason,
    }),
  );
  const info = trx();
  return info.changes > 0;
}

/**
 * @param {import('discord.js').Client} client
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   closePlayerSearchPostIfActive: import('better-sqlite3').Statement,
 *   getPlayerSearchPostById: import('better-sqlite3').Statement,
 *   listPlayerSearchPostMessagesByPostId: import('better-sqlite3').Statement,
 * }} playerSearchStmts
 */
export async function closePlayerSearchPostByDbIdAndSyncMessages(
  client,
  db,
  playerSearchStmts,
  dbId,
  status,
  reason,
) {
  const ok = closePlayerSearchPostByDbId(
    db,
    playerSearchStmts,
    dbId,
    status,
    reason,
  );
  if (!ok) return false;

  const row = playerSearchStmts.getPlayerSearchPostById.get(dbId);
  if (!row) {
    logger.warn('player_search: ligne introuvable après close', { db_id: dbId });
    return false;
  }

  await updatePlayerSearchPostMessagesEmbeds(client, playerSearchStmts, row);
  return true;
}

/**
 * @param {import('discord.js').Client} client
 * @param {import('better-sqlite3').Database} db
 * @param {Parameters<typeof closePlayerSearchPostByDbIdAndSyncMessages>[2]} playerSearchStmts
 * @param {string} rawPublicId
 * @param {string} userId
 */
export async function closePlayerSearchPostByPublicIdForAuthor(
  client,
  db,
  playerSearchStmts,
  rawPublicId,
  userId,
) {
  const publicId = normalizePlayerSearchPublicId(rawPublicId);
  if (!publicId) {
    return {
      ok: false,
      code: 'invalid_id',
      message: '❌ ID invalide. Utilise le format J1, J2, etc.',
    };
  }

  const active =
    playerSearchStmts.getPlayerSearchPostActiveByPublicId.get(publicId);
  if (!active) {
    const any =
      playerSearchStmts.getPlayerSearchPostByPublicIdAny.get(publicId);
    if (any) {
      return { ok: false, code: 'already_done', message: MSG_ALREADY_DONE };
    }
    return { ok: false, code: 'not_found', message: MSG_NO_ACTIVE };
  }

  if (active.author_user_id !== userId) {
    return { ok: false, code: 'not_author', message: MSG_NOT_AUTHOR };
  }

  const dbId = Number(active.id);
  const closed = await closePlayerSearchPostByDbIdAndSyncMessages(
    client,
    db,
    playerSearchStmts,
    dbId,
    'closed_manual',
    'manual',
  );

  if (!closed) {
    return { ok: false, code: 'already_done', message: MSG_ALREADY_DONE };
  }

  return { ok: true, message: MSG_OK_CLOSE, publicId };
}

/**
 * Rollback création si diffusion échouée.
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   deletePlayerSearchPostMessagesForPost: import('better-sqlite3').Statement,
 *   deletePlayerSearchPostById: import('better-sqlite3').Statement,
 * }} playerSearchStmts
 * @param {number} dbId
 */
export function rollbackPlayerSearchPostCreation(db, playerSearchStmts, dbId) {
  db.transaction((id) => {
    playerSearchStmts.deletePlayerSearchPostMessagesForPost.run(id);
    playerSearchStmts.deletePlayerSearchPostById.run(id);
  })(dbId);
}

/**
 * @param {{
 *   findExpiredActivePlayerSearchPosts: import('better-sqlite3').Statement,
 * }} playerSearchStmts
 * @param {string} nowIso
 * @returns {{ id: number, publicId: string, missingSchedule: boolean }[]}
 */
export function findExpiredActivePlayerSearchCandidates(
  playerSearchStmts,
  nowIso,
) {
  const rows = playerSearchStmts.findExpiredActivePlayerSearchPosts.all();
  /** @type {{ id: number, publicId: string, missingSchedule: boolean }[]} */
  const candidates = [];

  for (const row of rows) {
    const id = Number(row.id);
    const publicId = String(row.player_search_public_id ?? '');
    const missingSchedule = Number(row.missing_schedule) === 1;

    if (missingSchedule) {
      candidates.push({ id, publicId, missingSchedule: true });
      continue;
    }

    if (isPlayerSearchExpired(row, nowIso)) {
      candidates.push({ id, publicId, missingSchedule: false });
    }
  }

  return candidates;
}

/**
 * @param {import('discord.js').Client} client
 * @param {import('better-sqlite3').Database} db
 * @param {Parameters<typeof closePlayerSearchPostByDbIdAndSyncMessages>[2]} playerSearchStmts
 */
export async function runPlayerSearchExpirationPass(
  client,
  db,
  playerSearchStmts,
) {
  const nowIso = new Date().toISOString();
  const candidates = findExpiredActivePlayerSearchCandidates(
    playerSearchStmts,
    nowIso,
  );
  if (candidates.length === 0) return { count: 0, candidates: 0 };

  let closed = 0;
  for (const { id, publicId, missingSchedule } of candidates) {
    try {
      if (missingSchedule) {
        logger.warn('player_search: expiration défensive (scheduled_at absent)', {
          player_search_post_db_id: id,
          player_search_public_id: publicId,
        });
      }
      const ok = await closePlayerSearchPostByDbIdAndSyncMessages(
        client,
        db,
        playerSearchStmts,
        id,
        'closed_expired',
        'expired',
      );
      if (ok) {
        closed += 1;
        logger.info('player_search_expired', { public_id: publicId });
      }
    } catch (err) {
      logger.error('player_search: expiration — fermeture recherche', {
        player_search_post_db_id: id,
        player_search_public_id: publicId,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }

  return { count: closed, candidates: candidates.length };
}
