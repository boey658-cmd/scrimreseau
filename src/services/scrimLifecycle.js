import { logger } from '../utils/logger.js';
import { buildScrimClosedMessageEditOptions } from './scrimEmbedBuilder.js';
import { runTransientDiscord } from './discordApiGuard.js';
import { safeScrimEmbedMessageEdit } from './safeDiscordMessageEdit.js';

/** Délai entre éditions d’embeds (anti rate-limit Discord), en ms. */
export const SCRIM_EDIT_DELAY_MS = 75;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const MS_TOO_MANY =
  '❌ Trop de recherches actives actuellement. Réessaie dans quelques minutes.';

export const MSG_NO_ACTIVE = '❌ Aucune recherche active trouvée pour cet ID.';
export const MSG_NOT_AUTHOR = '❌ Tu ne peux fermer que tes propres recherches.';
export const MSG_ALREADY_DONE = '❌ Cette recherche est déjà terminée.';
export const MSG_OK_CLOSE =
  '✅ Ta recherche de scrim a été marquée comme terminée.';

/** Borne haute inclusive des `scrim_public_id` (alignée sur {@link allocateScrimPublicId}). */
export const SCRIM_PUBLIC_ID_MAX = 9999;

/**
 * Plus petit ID public libre parmi les recherches `active` uniquement.
 * Plages successives : 1–999, 1000–1999, … jusqu’à {@link SCRIM_PUBLIC_ID_MAX} (inclus).
 * @param {{ listActiveScrimPublicIds: import('better-sqlite3').Statement }} stmts
 * @returns {number | null} `null` si toutes les plages jusqu’au plafond sont pleines
 */
export function allocateScrimPublicId(stmts) {
  const maxPublicId = SCRIM_PUBLIC_ID_MAX;
  const firstBandEnd = 999;
  const bandStep = 1000;

  const rows = stmts.listActiveScrimPublicIds.all();
  const used = new Set(
    rows
      .map((r) => Number(r.scrim_public_id))
      .filter((n) => Number.isFinite(n)),
  );

  for (let band = 0; ; band += 1) {
    const start = band === 0 ? 1 : band * bandStep;
    if (start > maxPublicId) return null;
    const end =
      band === 0
        ? firstBandEnd
        : Math.min(start + bandStep - 1, maxPublicId);

    for (let i = start; i <= end; i += 1) {
      if (!used.has(i)) return i;
    }
  }
}

/**
 * @param {import('discord.js').Client} client
 * @param {{
 *   listScrimPostMessagesByPostId: import('better-sqlite3').Statement,
 * }} stmts
 * @param {Record<string, unknown>} dbRow ligne scrim_posts après fermeture
 */
export async function updateScrimPostMessagesEmbeds(client, stmts, dbRow) {
  const messages = stmts.listScrimPostMessagesByPostId.all(dbRow.id);
  const status = /** @type {'active' | 'closed_manual' | 'closed_expired'} */ (
    dbRow.status
  );
  if (status !== 'closed_manual' && status !== 'closed_expired') {
    logger.warn('updateScrimPostMessagesEmbeds: statut inattendu (attendu fermeture)', {
      scrim_post_db_id: dbRow.id,
      status,
    });
    return;
  }
  const editOptions = buildScrimClosedMessageEditOptions(status);

  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (i > 0) await sleep(SCRIM_EDIT_DELAY_MS);
    try {
      const guild = await runTransientDiscord(
        () => client.guilds.fetch(m.guild_id),
        {
          kind: 'scrim_close_prefetch_guild',
          metadata: { guild_id: m.guild_id, scrim_post_db_id: dbRow.id },
        },
      ).catch(() => null);
      if (!guild) {
        logger.warn('updateScrimPostMessagesEmbeds: guilde introuvable', {
          guild_id: m.guild_id,
          scrim_post_db_id: dbRow.id,
        });
        continue;
      }
      const channel = await runTransientDiscord(
        () => guild.channels.fetch(m.channel_id),
        {
          kind: 'scrim_close_prefetch_channel',
          metadata: {
            guild_id: m.guild_id,
            channel_id: m.channel_id,
            scrim_post_db_id: dbRow.id,
          },
        },
      ).catch(() => null);
      if (!channel?.isTextBased()) {
        logger.warn('updateScrimPostMessagesEmbeds: salon introuvable ou non texte', {
          channel_id: m.channel_id,
          scrim_post_db_id: dbRow.id,
        });
        continue;
      }
      const msg = await runTransientDiscord(
        () => channel.messages.fetch(m.message_id),
        {
          kind: 'scrim_close_prefetch_message',
          metadata: {
            guild_id: m.guild_id,
            channel_id: m.channel_id,
            message_id: m.message_id,
            scrim_post_db_id: dbRow.id,
          },
        },
      ).catch(() => null);
      if (!msg) {
        logger.warn('updateScrimPostMessagesEmbeds: message introuvable', {
          message_id: m.message_id,
          scrim_post_db_id: dbRow.id,
        });
        continue;
      }
      try {
        await safeScrimEmbedMessageEdit({
          client,
          stmts,
          scrimPostDbId: Number(dbRow.id),
          guildId: m.guild_id,
          channelId: m.channel_id,
          messageId: m.message_id,
          targetStatus: status,
          editOptions,
          message: msg,
        });
      } catch (unexpected) {
        logger.warn('updateScrimPostMessagesEmbeds: exception inattendue', {
          scrim_post_db_id: dbRow.id,
          guild_id: m.guild_id,
          channel_id: m.channel_id,
          message_id: m.message_id,
          message:
            unexpected instanceof Error
              ? unexpected.message
              : String(unexpected),
        });
      }
    } catch (err) {
      logger.warn('updateScrimPostMessagesEmbeds: erreur avant édition', {
        scrim_post_db_id: dbRow.id,
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
 *   closeScrimPostIfActive: import('better-sqlite3').Statement,
 * }} stmts
 * @param {number} dbId
 * @param {'closed_manual' | 'closed_expired'} status
 * @param {string} reason ex. manual, expired, expired_missing_schedule
 * @returns {boolean} true si une ligne active a été fermée
 */
export function closeScrimPostByDbId(db, stmts, dbId, status, reason) {
  const nowIso = new Date().toISOString();
  const trx = db.transaction(() =>
    stmts.closeScrimPostIfActive.run({
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
 *   closeScrimPostIfActive: import('better-sqlite3').Statement,
 *   getScrimPostById: import('better-sqlite3').Statement,
 *   listScrimPostMessagesByPostId: import('better-sqlite3').Statement,
 * }} stmts
 * @param {number} dbId
 * @param {'closed_manual' | 'closed_expired'} status
 * @param {string} reason
 * @returns {Promise<boolean>}
 */
export async function closeScrimPostByDbIdAndSyncMessages(
  client,
  db,
  stmts,
  dbId,
  status,
  reason,
) {
  const ok = closeScrimPostByDbId(db, stmts, dbId, status, reason);
  if (!ok) return false;
  const row = stmts.getScrimPostById.get(dbId);
  if (!row) {
    logger.warn('closeScrimPostByDbIdAndSyncMessages: ligne introuvable après close', {
      db_id: dbId,
    });
    return false;
  }
  await updateScrimPostMessagesEmbeds(client, stmts, row);
  return true;
}

/**
 * @param {{
 *   findExpiredActiveScrimPosts: import('better-sqlite3').Statement,
 * }} stmts
 * @param {string} nowIso
 * @returns {{ id: number, missingSchedule: boolean }[]}
 */
export function findExpiredActiveScrimCandidates(stmts, nowIso) {
  const rows = stmts.findExpiredActiveScrimPosts.all({ now_iso: nowIso });
  return rows.map((r) => ({
    id: Number(r.id),
    missingSchedule: Number(r.missing_schedule) === 1,
  }));
}

/**
 * @param {import('discord.js').Client} client
 * @param {import('better-sqlite3').Database} db
 * @param {Parameters<typeof closeScrimPostByDbIdAndSyncMessages>[2]} stmts
 */
export async function closeScrimPostByPublicIdForAuthor(
  client,
  db,
  stmts,
  publicId,
  userId,
) {
  const active = stmts.getScrimPostActiveByPublicId.get(publicId);
  if (!active) {
    const any = stmts.getScrimPostByPublicIdAny.get(publicId);
    if (any) {
      return { ok: false, code: 'already_done', message: MSG_ALREADY_DONE };
    }
    return { ok: false, code: 'not_found', message: MSG_NO_ACTIVE };
  }
  if (active.author_user_id !== userId) {
    return { ok: false, code: 'not_author', message: MSG_NOT_AUTHOR };
  }
  const dbId = Number(active.id);
  const closed = await closeScrimPostByDbIdAndSyncMessages(
    client,
    db,
    stmts,
    dbId,
    'closed_manual',
    'manual',
  );
  if (!closed) {
    return { ok: false, code: 'already_done', message: MSG_ALREADY_DONE };
  }
  return { ok: true, message: MSG_OK_CLOSE };
}
