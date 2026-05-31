import { assertBotCanPostInChannel } from './channelPermissions.js';
import { buildPlayerSearchEmbed } from './playerSearchEmbedBuilder.js';
import { logger } from '../utils/logger.js';
import { enqueueDiscordTask } from './discordTaskQueue.js';
import { runTransientDiscord } from './discordApiGuard.js';

const BROADCAST_DELAY_MS = 75;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Diffusion Recherche Joueur — uniquement via `guild_player_search_channels`.
 *
 * @param {{
 *   client: import('discord.js').Client,
 *   rows: { guild_id: string, channel_id: string }[],
 *   playerSearchStmts: {
 *     insertPlayerSearchPostMessage: import('better-sqlite3').Statement,
 *   },
 *   playerSearchPostDbId: number,
 *   payload: import('./playerSearchEmbedBuilder.js').PlayerSearchEmbedPayload,
 * }} args
 * @returns {Promise<number>} nombre d’envois réussis
 */
export async function broadcastPlayerSearchRequest(args) {
  const {
    client,
    rows,
    playerSearchStmts,
    playerSearchPostDbId,
    payload,
  } = args;

  let successCount = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (i > 0) await sleep(BROADCAST_DELAY_MS);

    try {
      const guild =
        client.guilds.cache.get(row.guild_id) ??
        (await runTransientDiscord(() => client.guilds.fetch(row.guild_id), {
          kind: 'player_search_broadcast.fetch_guild',
          metadata: {
            guild_id: row.guild_id,
            player_search_post_db_id: playerSearchPostDbId,
          },
        }).catch(() => null));

      if (!guild) {
        logger.warn('player_search: guilde introuvable pour diffusion', {
          guild_id: row.guild_id,
          player_search_post_db_id: playerSearchPostDbId,
        });
        continue;
      }

      const channel =
        guild.channels.cache.get(row.channel_id) ??
        (await runTransientDiscord(() => guild.channels.fetch(row.channel_id), {
          kind: 'player_search_broadcast.fetch_channel',
          metadata: {
            guild_id: row.guild_id,
            channel_id: row.channel_id,
            player_search_post_db_id: playerSearchPostDbId,
          },
        }).catch(() => null));

      let botMember = guild.members.me;
      if (!botMember) {
        botMember = await guild.members.fetchMe().catch(() => null);
      }

      const perm = assertBotCanPostInChannel(channel, botMember);
      if (!perm.ok) {
        logger.warn('player_search: permissions bot insuffisantes, salon ignoré', {
          guild_id: row.guild_id,
          channel_id: row.channel_id,
          detail: perm.error,
          player_search_post_db_id: playerSearchPostDbId,
        });
        continue;
      }

      const embed = buildPlayerSearchEmbed(payload);

      const sent = await enqueueDiscordTask(
        async () => channel.send({ embeds: [embed] }),
        {
          kind: 'player_search_broadcast_send',
          player_search_post_db_id: playerSearchPostDbId,
          guild_id: row.guild_id,
          channel_id: row.channel_id,
        },
        'high',
      );

      try {
        playerSearchStmts.insertPlayerSearchPostMessage.run({
          player_search_post_db_id: playerSearchPostDbId,
          guild_id: row.guild_id,
          channel_id: row.channel_id,
          message_id: sent.id,
        });
        successCount += 1;
      } catch (dbErr) {
        logger.error(
          'player_search: insert player_search_post_messages échoué après envoi Discord',
          {
            guild_id: row.guild_id,
            channel_id: row.channel_id,
            player_search_post_db_id: playerSearchPostDbId,
            message_id: sent.id,
            message: dbErr instanceof Error ? dbErr.message : String(dbErr),
          },
        );
        try {
          await enqueueDiscordTask(
            () => sent.delete(),
            {
              kind: 'player_search_broadcast_rollback_delete',
              guild_id: row.guild_id,
              channel_id: row.channel_id,
              message_id: sent.id,
              player_search_post_db_id: playerSearchPostDbId,
            },
            'high',
          );
        } catch (delErr) {
          logger.warn(
            'player_search: suppression message impossible après échec insert',
            {
              guild_id: row.guild_id,
              channel_id: row.channel_id,
              message_id: sent.id,
              message: delErr instanceof Error ? delErr.message : String(delErr),
            },
          );
        }
      }
    } catch (err) {
      logger.error('player_search: échec envoi sur salon', {
        guild_id: row.guild_id,
        channel_id: row.channel_id,
        player_search_post_db_id: playerSearchPostDbId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('player_search: fin diffusion', {
    targets: rows.length,
    success: successCount,
    player_search_post_db_id: playerSearchPostDbId,
  });

  return successCount;
}
