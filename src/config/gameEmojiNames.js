import { GAMES } from './games.js';

/**
 * Noms d’emote Discord (2–32 caractères, [a-z0-9_]).
 * Raccourcis explicites pour les clés longues ; les autres jeux utilisent un slug dérivé de `gameKey`.
 * Aligné sur les clés de `GAMES` — source de vérité : games.js.
 */
const OVERRIDES = Object.freeze({
  league_of_legends: 'lol',
  rocket_league: 'rl',
  rainbow_six_siege: 'r6',
  teamfight_tactics: 'tft',
  overwatch_2: 'ow2',
  apex_legends: 'apex',
  dota_2: 'dota2',
});

function defaultSlug(gameKey) {
  return gameKey.replace(/_/g, '');
}

/**
 * @param {string} gameKey — clé présente dans `GAMES`
 * @returns {string | null} null si clé inconnue
 */
export function getDiscordEmojiNameForGame(gameKey) {
  if (typeof gameKey !== 'string' || !GAMES[gameKey]) return null;
  const raw = OVERRIDES[gameKey] ?? defaultSlug(gameKey);
  const sanitized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 32);
  if (sanitized.length < 2) return null;
  return sanitized;
}
