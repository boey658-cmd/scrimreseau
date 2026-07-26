import { getGame } from '../config/games.js';
import { logger } from '../utils/logger.js';
import { enqueueDiscordTask } from './discordTaskQueue.js';
import { deliverScrimToDestination } from './scrimDelivery.js';

const BROADCAST_DELAY_MS = 75;

/**
 * Diffusion « best-effort » : chaque cible (guilde / salon) est traitée indépendamment.
 * Les erreurs réseau ou permissions par serveur sont absorbées et journalisées ; il n'y a pas
 * de rollback global si seulement une partie des cibles échoue. La valeur de retour est le
 * nombre d'envois ayant réussi (insert `scrim_post_messages` + message Discord posté).
 *
 * @param {{
 *   client: import('discord.js').Client,
 *   rows: { guild_id: string, channel_id: string }[],
 *   stmts: {
 *     isUserBlocked: import('better-sqlite3').Statement,
 *     insertScrimPostMessage: import('better-sqlite3').Statement,
 *     getGuildLanguage?: import('better-sqlite3').Statement,
 *   },
 *   authorUserId: string,
 *   scrimPostDbId: number,
 *   payload: {
 *     gameKey: string,
 *     rank: string,
 *     dateStr: string,
 *     timeStr: string,
 *     format: string,
 *     nombreDeGames?: number | null,
 *     fearless?: string | null,
 *     eloPrecision?: string | null,
 *     contactUserId: string,
 *     contactDisplayName?: string | null,
 *     multiOpggUrl?: string | null,
 *     scheduledAtIso?: string | null,
 *     scheduledAtEndIso?: string | null,
 *     structureNameSnapshot?: string | null,
 *     structureInviteUrl?: string | null,
 *   },
 * }} args
 */
export async function broadcastScrimRequest(args) {
  const {
    client,
    rows,
    stmts,
    authorUserId,
    scrimPostDbId,
    payload,
  } = args;

  const _game = getGame(payload.gameKey);

  let successCount = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    try {
      const result = await deliverScrimToDestination({
        client,
        stmts,
        row,
        authorUserId,
        payload,
        delayMs: i > 0 ? BROADCAST_DELAY_MS : 0,
      });

      if (result.outcome !== 'sent') {
        if (result.outcome === 'blocked') {
          // ignoré silencieusement comme avant
        } else {
          logger.warn('Échec envoi scrim sur channel', {
            guild_id: row.guild_id,
            channel_id: row.channel_id,
            outcome: result.outcome,
            errorCode: result.errorCode,
            errorMessage: result.errorMessage,
          });
        }
        continue;
      }

      try {
        stmts.insertScrimPostMessage.run({
          scrim_post_db_id: scrimPostDbId,
          guild_id: row.guild_id,
          channel_id: row.channel_id,
          message_id: result.message.id,
        });
        successCount += 1;
      } catch (dbErr) {
        logger.error('broadcast: insert scrim_post_messages échoué après envoi Discord', {
          guild_id: row.guild_id,
          channel_id: row.channel_id,
          scrim_post_db_id: scrimPostDbId,
          message_id: result.message.id,
          message: dbErr instanceof Error ? dbErr.message : String(dbErr),
        });
        try {
          await enqueueDiscordTask(
            () => result.message.delete(),
            {
              kind: 'scrim_broadcast_rollback_delete',
              guild_id: row.guild_id,
              channel_id: row.channel_id,
              message_id: result.message.id,
              scrim_post_db_id: scrimPostDbId,
            },
            'high',
          );
          logger.info('broadcast: message Discord supprimé après échec insert', {
            guild_id: row.guild_id,
            channel_id: row.channel_id,
            message_id: result.message.id,
            scrim_post_db_id: scrimPostDbId,
          });
        } catch (delErr) {
          logger.warn('broadcast: suppression message impossible après échec insert', {
            guild_id: row.guild_id,
            channel_id: row.channel_id,
            message_id: result.message.id,
            scrim_post_db_id: scrimPostDbId,
            message: delErr instanceof Error ? delErr.message : String(delErr),
          });
        }
      }
    } catch (err) {
      logger.error('Échec envoi scrim sur channel', {
        guild_id: row.guild_id,
        channel_id: row.channel_id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('Fin diffusion scrim', {
    game_key: payload.gameKey,
    targets: rows.length,
    success: successCount,
    scrim_post_db_id: scrimPostDbId,
  });

  return successCount;
}
