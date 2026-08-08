import { logger } from '../utils/logger.js';

/**
 * Retire l’inscription d’un salon de réception scrim en DB (guild_id + channel_id).
 * Ne dépend pas de l’existence Discord du salon.
 * Réutilise le modèle existant (DELETE) — pas de colonnes soft-disable dans le schéma.
 *
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {string} guildId
 * @param {string} channelId
 * @param {string} reason ex. UNKNOWN_CHANNEL | ADMIN_REMOVE
 * @returns {boolean} true si une ligne a été supprimée
 */
export function removeScrimReceptionDestination(stmts, guildId, channelId, reason) {
  if (!stmts?.deleteGuildChannelByChannelId) return false;
  if (typeof guildId !== 'string' || typeof channelId !== 'string') return false;
  const gid = guildId.trim();
  const cid = channelId.trim();
  // Refuse les paramètres vides pour éviter un DELETE non ciblé.
  if (!gid || !cid) return false;
  try {
    const info = stmts.deleteGuildChannelByChannelId.run(gid, cid);
    if (info.changes > 0) {
      logger.info('Destination scrim désactivée : salon retiré de la configuration', {
        guild_id: gid,
        channel_id: cid,
        reason,
      });
      return true;
    }
  } catch (err) {
    logger.error('removeScrimReceptionDestination: échec DELETE', {
      guild_id: gid,
      channel_id: cid,
      reason,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return false;
}
