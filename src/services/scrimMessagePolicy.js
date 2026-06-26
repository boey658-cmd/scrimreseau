import { PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { enqueueDiscordTask } from './discordTaskQueue.js';
import { safeScrimEmbedMessageEdit } from './safeDiscordMessageEdit.js';

/** @typedef {'keep' | 'delete'} ScrimMessageLifecyclePolicy */

export const LIFECYCLE_POLICY_KEEP = /** @type {ScrimMessageLifecyclePolicy} */ ('keep');
export const LIFECYCLE_POLICY_DELETE = /** @type {ScrimMessageLifecyclePolicy} */ ('delete');

/** Code Discord API : message inconnu (déjà supprimé). */
const DISCORD_UNKNOWN_MESSAGE = 10008;

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
 *   guild: import('discord.js').Guild,
 *   channel: import('discord.js').TextBasedChannel,
 *   message: import('discord.js').Message,
 *   messageRow: { guild_id: string, channel_id: string, message_id: string },
 *   scrimPostDbId: number,
 *   eventType: string,
 * }} p
 * @returns {Promise<boolean>} true si supprimé (ou déjà absent), false si impossible
 */
async function tryDeleteScrimMessage({ guild, channel, message, messageRow, scrimPostDbId, eventType }) {
  // Vérification de sécurité absolue : correspondance stricte des IDs
  if (
    message.guildId !== messageRow.guild_id
    || message.channelId !== messageRow.channel_id
    || message.id !== messageRow.message_id
  ) {
    logger.warn('scrimMessagePolicy: mismatch IDs — suppression refusée (sécurité)', {
      scrim_post_db_id: scrimPostDbId,
      event_type: eventType,
      expected_guild: messageRow.guild_id,
      expected_channel: messageRow.channel_id,
      expected_message: messageRow.message_id,
      actual_guild: message.guildId,
      actual_channel: message.channelId,
      actual_message: message.id,
    });
    return false;
  }

  // Vérification des permissions ManageMessages
  let botMember = guild.members.me;
  if (!botMember) {
    botMember = await guild.members.fetchMe().catch(() => null);
  }

  if (!botMember) {
    logger.warn('scrimMessagePolicy: bot member introuvable — suppression impossible', {
      guild_id: messageRow.guild_id,
      scrim_post_db_id: scrimPostDbId,
      event_type: eventType,
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
    logger.warn('scrimMessagePolicy: permissions manquantes — suppression impossible, fallback édition', {
      guild_id: messageRow.guild_id,
      channel_id: messageRow.channel_id,
      message_id: messageRow.message_id,
      scrim_post_db_id: scrimPostDbId,
      event_type: eventType,
    });
    return false;
  }

  try {
    await enqueueDiscordTask(
      () => message.delete(),
      {
        kind: 'scrim_message_policy_delete',
        scrim_post_db_id: scrimPostDbId,
        guild_id: messageRow.guild_id,
        channel_id: messageRow.channel_id,
        message_id: messageRow.message_id,
        event_type: eventType,
      },
      'low',
    );
    logger.info('scrimMessagePolicy: message supprimé', {
      scrim_post_db_id: scrimPostDbId,
      guild_id: messageRow.guild_id,
      channel_id: messageRow.channel_id,
      message_id: messageRow.message_id,
      event_type: eventType,
    });
    return true;
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? /** @type {{ code?: unknown }} */ (err).code
        : undefined;

    // Message déjà supprimé : non bloquant, considéré comme succès
    if (code === DISCORD_UNKNOWN_MESSAGE) {
      logger.info('scrimMessagePolicy: message déjà supprimé — ignoré', {
        scrim_post_db_id: scrimPostDbId,
        guild_id: messageRow.guild_id,
        message_id: messageRow.message_id,
        event_type: eventType,
      });
      return true;
    }

    logger.warn('scrimMessagePolicy: échec suppression — fallback édition', {
      scrim_post_db_id: scrimPostDbId,
      guild_id: messageRow.guild_id,
      channel_id: messageRow.channel_id,
      message_id: messageRow.message_id,
      event_type: eventType,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

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
