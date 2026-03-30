import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GENERATED_PATH = path.join(__dirname, '..', 'config', 'gameEmojis.generated.json');

const FALLBACK_UNICODE = '🎮';

/** @type {Record<string, { emojiName?: string, emojiId?: string, emojiTag?: string }> | null} */
let cache = null;

function loadMap() {
  if (cache !== null) return cache;
  try {
    const raw = fs.readFileSync(GENERATED_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    cache =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : {};
  } catch {
    cache = {};
  }
  return cache;
}

/**
 * Retourne la balise d’emote custom (`<:name:id>`) si présente dans le mapping généré, sinon 🎮.
 * Ne lève jamais d’exception (fichier absent, JSON invalide, jeu inconnu).
 * @param {string | null | undefined} gameKey
 * @returns {string}
 */
export function getGameEmoji(gameKey) {
  if (typeof gameKey !== 'string' || !gameKey.trim()) return FALLBACK_UNICODE;
  const map = loadMap();
  const entry = map[gameKey.trim()];
  if (
    entry
    && typeof entry.emojiTag === 'string'
    && entry.emojiTag.length > 0
  ) {
    return entry.emojiTag;
  }
  return FALLBACK_UNICODE;
}

/** Pour tests ou après régénération du JSON sans redémarrer le processus. */
export function invalidateGameEmojiCache() {
  cache = null;
}
