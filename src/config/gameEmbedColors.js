import { GAMES } from './games.js';

/**
 * Couleurs d’embed par jeu (hex). Clés alignées sur `GAMES` ; défaut Discord « blurple ».
 */
const HEX_BY_GAME = Object.freeze({
  league_of_legends: '#C89B3C',
  valorant: '#FF4655',
  cs2: '#DE9B35',
  rocket_league: '#0079F2',
  rainbow_six_siege: '#FF3D00',
  overwatch_2: '#FF9C00',
  apex_legends: '#DA292A',
  fortnite: '#9D4DFF',
  teamfight_tactics: '#C8AA6E',
  dota_2: '#D32C2C',
});

const DEFAULT = 0x5865f2;

/**
 * @param {string} gameKey
 * @returns {number} entier couleur pour EmbedBuilder.setColor
 */
export function getEmbedColorForGame(gameKey) {
  if (typeof gameKey !== 'string' || !GAMES[gameKey]) return DEFAULT;
  const hex = HEX_BY_GAME[gameKey];
  if (typeof hex !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(hex)) return DEFAULT;
  return Number.parseInt(hex.slice(1), 16);
}
