import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'scrimFieldEmojis.json');

/** @typedef {'rang'|'format'|'date'|'heure'|'contact'} ScrimFieldEmojiType */

const FALLBACK_UNICODE = Object.freeze({
  rang: '🏆',
  format: '⚔️',
  date: '📅',
  heure: '⏰',
  contact: '📩',
});

const VALID_TYPES = new Set(
  /** @type {ScrimFieldEmojiType[]} */ ([
    'rang',
    'format',
    'date',
    'heure',
    'contact',
  ]),
);

/** Tags custom Discord <:name:id> ou <a:name:id> (noms [a-zA-Z0-9_]{2,32}). */
export const DISCORD_CUSTOM_EMOJI_TAG_RE = /^<a?:([a-zA-Z0-9_]{2,32}):(\d+)>$/;

/** @type {Record<string, string> | null} */
let cache = null;

function loadRawMap() {
  if (cache !== null) return cache;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    cache =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? /** @type {Record<string, string>} */ (parsed)
        : {};
  } catch {
    cache = {};
  }
  return cache;
}

/**
 * @param {string | null | undefined} tag
 * @returns {boolean}
 */
export function isDiscordCustomEmojiTag(tag) {
  if (typeof tag !== 'string') return false;
  const t = tag.trim();
  return t.length > 0 && DISCORD_CUSTOM_EMOJI_TAG_RE.test(t);
}

/**
 * Emoji custom pour un libellé de champ « recherche scrim », ou unicode de secours.
 * Ne lève jamais d’exception.
 * Renseigner `src/config/scrimFieldEmojis.json` avec des balises copiées depuis Discord (ex. `<:rang:123…>`).
 *
 * @param {string | null | undefined} type
 * @returns {string}
 */
export function getScrimEmoji(type) {
  if (typeof type !== 'string' || !VALID_TYPES.has(type)) {
    return '';
  }

  const map = loadRawMap();
  const tag = map[type];

  if (isDiscordCustomEmojiTag(tag)) {
    return /** @type {string} */ (tag.trim());
  }

  return FALLBACK_UNICODE[type];
}

/** Après édition manuelle du JSON sans redémarrer le processus. */
export function invalidateScrimFieldEmojiCache() {
  cache = null;
}
