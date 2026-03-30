/**
 * Verrou in-memory : une seule recherche scrim à la fois par utilisateur
 * (évite les courses parallèles pendant la création d’une recherche).
 */

/** @type {Set<string>} */
const activeUserIds = new Set();

/**
 * @param {string} userId
 * @returns {boolean}
 */
export function hasActiveScrimRequest(userId) {
  if (typeof userId !== 'string' || !userId) return false;
  return activeUserIds.has(userId);
}

/**
 * @param {string} userId
 */
export function beginScrimRequest(userId) {
  if (typeof userId === 'string' && userId) activeUserIds.add(userId);
}

/**
 * @param {string} userId
 */
export function endScrimRequest(userId) {
  if (typeof userId === 'string' && userId) activeUserIds.delete(userId);
}
