/**
 * Résolution du lien « Voir le message » pour une guild (compat multi-salon).
 *
 * Choix déterministe :
 * 1. Message dans le premier salon de réception actif (ordre sort_order/created_at)
 * 2. Sinon message le plus récent (id DESC) — comportement historique getScrimPostMessageForGuild
 *
 * Le lifecycle close/expire continue d'opérer sur TOUS les messages (listScrimPostMessagesByPostId).
 */

import { UI_PRIMARY_GAME_KEY } from '../config/games.js';
import { listActiveReceptionChannelsForGuild } from './receptionChannels.js';

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {number} scrimPostDbId
 * @param {string} guildId
 * @param {string} [gameKey]
 * @returns {{ channel_id: string, message_id: string } | null}
 */
export function resolvePreferredScrimPostMessageLink(
  stmts,
  scrimPostDbId,
  guildId,
  gameKey = UI_PRIMARY_GAME_KEY,
) {
  /** @type {Array<{ id: number, channel_id: string, message_id: string }>} */
  let messages = [];
  try {
    messages = stmts.listScrimPostMessagesByPostAndGuild.all(scrimPostDbId, guildId) ?? [];
  } catch {
    const legacy = stmts.getScrimPostMessageForGuild.get(scrimPostDbId, guildId);
    return legacy ?? null;
  }

  if (messages.length === 0) return null;
  if (messages.length === 1) {
    return { channel_id: messages[0].channel_id, message_id: messages[0].message_id };
  }

  const active = listActiveReceptionChannelsForGuild(stmts, guildId, gameKey);
  for (const ch of active) {
    const hit = messages.find((m) => String(m.channel_id) === String(ch.channel_id));
    if (hit) {
      return { channel_id: hit.channel_id, message_id: hit.message_id };
    }
  }

  // Fallback historique : plus récent
  return { channel_id: messages[0].channel_id, message_id: messages[0].message_id };
}
