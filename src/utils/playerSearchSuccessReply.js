import { getScrimCommunityServerUrlFromEnv } from '../services/scrimEmbedBuilder.js';

const DEFAULT_COMMUNITY_TIP_URL = 'https://discord.gg/dcjhQq5Ur9';

/**
 * @param {number} successCount
 * @returns {string}
 */
export function formatPlayerSearchDiffusionLine(successCount) {
  if (successCount === 1) {
    return '📡 Diffusée dans 1 serveur';
  }
  return `📡 Diffusée dans ${successCount} serveurs`;
}

/**
 * Réponse éphémère auteur après publication réussie.
 *
 * @param {string} publicId ex. J1
 * @param {number} successCount nombre de diffusions réussies
 * @returns {string}
 */
export function buildPlayerSearchSuccessReplyContent(publicId, successCount) {
  const inviteUrl =
    getScrimCommunityServerUrlFromEnv() ?? DEFAULT_COMMUNITY_TIP_URL;
  return (
    `✅ Ta recherche de joueur est en ligne sur le réseau !\n\n` +
    `${formatPlayerSearchDiffusionLine(successCount)}\n\n` +
    `🔴 Quand tu as trouvé tes joueurs :\n` +
    `/joueur-trouve id:${publicId}\n\n` +
    `💬 Pour éviter les problèmes de contact et faciliter les échanges entre joueurs :\n\n` +
    `${inviteUrl}\n\n` +
    `👉 Cela crée un Discord commun entre les joueurs.\n` +
    `👉 Tu peux continuer à utiliser le bot normalement depuis ton serveur.`
  );
}
