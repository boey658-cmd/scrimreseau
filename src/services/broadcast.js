import { assertBotCanPostInChannel } from './channelPermissions.js';
import {
  buildScrimCommunityServerActionRows,
  buildScrimEmbed,
} from './scrimEmbedBuilder.js';
import { getGame } from '../config/games.js';
import { logger } from '../utils/logger.js';
import { enqueueDiscordTask } from './discordTaskQueue.js';
import { runTransientDiscord } from './discordApiGuard.js';

const BROADCAST_DELAY_MS = 75;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Diffusion « best-effort » : chaque cible (guilde / salon) est traitée indépendamment.
 * Les erreurs réseau ou permissions par serveur sont absorbées et journalisées ; il n’y a pas
 * de rollback global si seulement une partie des cibles échoue. La valeur de retour est le
 * nombre d’envois ayant réussi (insert `scrim_post_messages` + message Discord posté).
 *
 * @param {{
 *   client: import('discord.js').Client,
 *   rows: { guild_id: string, channel_id: string }[],
 *   stmts: {
 *     isUserBlocked: import('better-sqlite3').Statement,
 *     insertScrimPostMessage: import('better-sqlite3').Statement,
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
 *     contactUserId: string,
 *     contactDisplayName?: string | null,
 *     multiOpggUrl?: string | null,
 *     scheduledAtIso?: string | null,
 *     scheduledAtEndIso?: string | null,
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
    if (i > 0) await sleep(BROADCAST_DELAY_MS);

    try {
      const blocked = stmts.isUserBlocked.get(row.guild_id, authorUserId);
      if (blocked) {
        continue;
      }

      const guild = client.guilds.cache.get(row.guild_id)
        ?? (await runTransientDiscord(
          () => client.guilds.fetch(row.guild_id),
          { kind: 'broadcast.fetch_guild', metadata: { guild_id: row.guild_id } },
        ).catch(() => null));
      if (!guild) {
        logger.warn('Guilde introuvable pour diffusion', { guild_id: row.guild_id });
        continue;
      }

      const channel = guild.channels.cache.get(row.channel_id)
        ?? (await runTransientDiscord(
          () => guild.channels.fetch(row.channel_id),
          {
            kind: 'broadcast.fetch_channel',
            metadata: { guild_id: row.guild_id, channel_id: row.channel_id },
          },
        ).catch(() => null));

      let botMember = guild.members.me;
      if (!botMember) {
        botMember = await guild.members.fetchMe().catch(() => null);
      }

      const perm = assertBotCanPostInChannel(channel, botMember);
      if (!perm.ok) {
        logger.warn('Permissions bot insuffisantes, salon ignoré', {
          guild_id: row.guild_id,
          channel_id: row.channel_id,
          detail: perm.error,
        });
        continue;
      }

      const embed = buildScrimEmbed({
        gameKey: payload.gameKey,
        rank: payload.rank,
        dateStr: payload.dateStr,
        timeStr: payload.timeStr,
        format: payload.format,
        nombreDeGames: payload.nombreDeGames ?? null,
        fearless: payload.fearless ?? null,
        contactUserId: payload.contactUserId,
        contactDisplayName: payload.contactDisplayName ?? null,
        multiOpggUrl: payload.multiOpggUrl ?? null,
        scheduledAtIso: payload.scheduledAtIso ?? null,
        scheduledAtEndIso: payload.scheduledAtEndIso ?? null,
      });

      const communityRows = buildScrimCommunityServerActionRows();
      const sendPayload =
        communityRows.length > 0
          ? { embeds: [embed], components: communityRows }
          : { embeds: [embed] };

      const sent = await enqueueDiscordTask(
        async () => channel.send(sendPayload),
        {
          kind: 'scrim_broadcast_send',
          scrim_post_db_id: scrimPostDbId,
          guild_id: row.guild_id,
          channel_id: row.channel_id,
        },
        'high',
      );

      try {
        stmts.insertScrimPostMessage.run({
          scrim_post_db_id: scrimPostDbId,
          guild_id: row.guild_id,
          channel_id: row.channel_id,
          message_id: sent.id,
        });
        successCount += 1;
      } catch (dbErr) {
        logger.error('broadcast: insert scrim_post_messages échoué après envoi Discord', {
          guild_id: row.guild_id,
          channel_id: row.channel_id,
          scrim_post_db_id: scrimPostDbId,
          message_id: sent.id,
          message: dbErr instanceof Error ? dbErr.message : String(dbErr),
        });
        try {
          await enqueueDiscordTask(
            () => sent.delete(),
            {
              kind: 'scrim_broadcast_rollback_delete',
              guild_id: row.guild_id,
              channel_id: row.channel_id,
              message_id: sent.id,
              scrim_post_db_id: scrimPostDbId,
            },
            'high',
          );
          logger.info('broadcast: message Discord supprimé après échec insert', {
            guild_id: row.guild_id,
            channel_id: row.channel_id,
            message_id: sent.id,
            scrim_post_db_id: scrimPostDbId,
          });
        } catch (delErr) {
          logger.warn('broadcast: suppression message impossible après échec insert', {
            guild_id: row.guild_id,
            channel_id: row.channel_id,
            message_id: sent.id,
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
