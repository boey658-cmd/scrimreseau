/**
 * Taxonomie Elo LoL — source unique pour ordre des tiers et matching filtres salon.
 *
 * Clés canoniques = valeurs catalogue `GAMES.league_of_legends.ranks`
 * (ex. `Or`, `Argent / Or`) — jamais labels localisés pour la logique métier.
 *
 * `elo_precision` (LP / High / Low) est hors scope matching destination (Phase 3).
 */

import { GAMES, UI_PRIMARY_GAME_KEY } from '../config/games.js';
import { logger } from '../utils/logger.js';

/**
 * Tiers ordonnés du plus bas (0) au plus élevé.
 * `keys` : formes reconnues (FR catalogue + alias EN), comparaison exacte case-insensitive.
 *
 * @type {ReadonlyArray<{ readonly keys: readonly string[], readonly catalogKey: string }>}
 */
export const LOL_RANK_TIERS = Object.freeze([
  { keys: Object.freeze(['fer', 'iron']), catalogKey: 'Fer' },
  { keys: Object.freeze(['bronze']), catalogKey: 'Bronze' },
  { keys: Object.freeze(['argent', 'silver']), catalogKey: 'Argent' },
  { keys: Object.freeze(['or', 'gold']), catalogKey: 'Or' },
  { keys: Object.freeze(['platine', 'platinum']), catalogKey: 'Platine' },
  { keys: Object.freeze(['émeraude', 'emeraude', 'emerald']), catalogKey: 'Émeraude' },
  { keys: Object.freeze(['diamant', 'diamond']), catalogKey: 'Diamant' },
  { keys: Object.freeze(['master']), catalogKey: 'Master' },
  {
    keys: Object.freeze(['grandmaster', 'grand maître', 'grand maitre', 'grand-maître']),
    catalogKey: 'Grandmaster',
  },
  { keys: Object.freeze(['challenger']), catalogKey: 'Challenger' },
]);

export const MIX_NIVEAU_RANK_KEY = 'Mix niveau';

/** Rangs mono-tier utilisables comme filtre salon (pas de plages, pas Mix). */
export const LOL_FILTER_RANK_KEYS = Object.freeze(
  LOL_RANK_TIERS.map((t) => t.catalogKey),
);

const FILTER_RANK_SET = new Set(LOL_FILTER_RANK_KEYS);

/**
 * Indice de tier (0 = plus bas) pour un segment.
 * @param {string} segment
 * @returns {number} -1 si inconnu
 */
export function getRankTierIndex(segment) {
  if (typeof segment !== 'string') return -1;
  const norm = segment.toLowerCase().trim();
  if (!norm) return -1;
  for (let i = 0; i < LOL_RANK_TIERS.length; i++) {
    if (LOL_RANK_TIERS[i].keys.includes(norm)) return i;
  }
  return -1;
}

/**
 * @param {unknown} rankKey
 * @returns {boolean}
 */
export function isValidLolFilterRankKey(rankKey) {
  return typeof rankKey === 'string' && FILTER_RANK_SET.has(rankKey);
}

/**
 * Options dashboard (clés canoniques uniquement).
 * @returns {ReadonlyArray<{ key: string }>}
 */
export function getLolFilterRankOptions() {
  return LOL_FILTER_RANK_KEYS.map((key) => Object.freeze({ key }));
}

/**
 * Parse une `rank_key` scrim en plage d'indices inclusifs.
 *
 * @param {string | null | undefined} scrimRankKey
 * @returns {{ kind: 'range', min: number, max: number } | { kind: 'mix' } | { kind: 'invalid' }}
 */
export function parseScrimRankRange(scrimRankKey) {
  if (typeof scrimRankKey !== 'string' || !scrimRankKey.trim()) {
    return { kind: 'invalid' };
  }
  const full = scrimRankKey.trim();
  if (full === MIX_NIVEAU_RANK_KEY) {
    return { kind: 'mix' };
  }

  const parts = full
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (parts.length === 1) {
    const idx = getRankTierIndex(parts[0]);
    if (idx < 0) return { kind: 'invalid' };
    return { kind: 'range', min: idx, max: idx };
  }

  if (parts.length === 2) {
    const a = getRankTierIndex(parts[0]);
    const b = getRankTierIndex(parts[1]);
    if (a < 0 || b < 0) return { kind: 'invalid' };
    return { kind: 'range', min: Math.min(a, b), max: Math.max(a, b) };
  }

  return { kind: 'invalid' };
}

/**
 * Le rang filtre (mono-tier) appartient-il à la plage du scrim ?
 *
 * Règles :
 * - filtre invalide → false (appelant décide fail-closed destination)
 * - scrim Mix niveau → false (filtre précis ne matche pas le catch-all ambigu)
 * - scrim invalide → false
 * - sinon min <= filterIdx <= max
 *
 * @param {string | null | undefined} filterRankKey  ex. `Or`
 * @param {string | null | undefined} scrimRankKey  ex. `Argent / Or`
 * @returns {boolean}
 */
export function isFilterRankIncludedInScrimRange(filterRankKey, scrimRankKey) {
  if (!isValidLolFilterRankKey(filterRankKey)) return false;
  const filterIdx = getRankTierIndex(/** @type {string} */ (filterRankKey));
  if (filterIdx < 0) return false;

  const range = parseScrimRankRange(scrimRankKey);
  if (range.kind === 'mix' || range.kind === 'invalid') return false;
  return filterIdx >= range.min && filterIdx <= range.max;
}

/**
 * Destination avec éventuel filtre Elo.
 *
 * @param {{
 *   eloFilterRankKey: string | null | undefined,
 *   filtersFeatureEnabled: boolean,
 * }} channelConfig
 * @param {{ rankKey: string | null | undefined }} scrim
 * @returns {{ accept: boolean, reason: 'no_filter' | 'feature_off' | 'match' | 'no_match' | 'invalid_filter' | 'invalid_scrim' }}
 */
export function destinationAcceptsScrim(channelConfig, scrim) {
  try {
    if (!channelConfig?.filtersFeatureEnabled) {
      return { accept: true, reason: 'feature_off' };
    }

    const raw = channelConfig.eloFilterRankKey;
    if (raw == null || raw === '') {
      return { accept: true, reason: 'no_filter' };
    }

    if (typeof raw !== 'string' || !isValidLolFilterRankKey(raw)) {
      try {
        logger.warn('rankTaxonomy: invalid stored filter — fail-closed skip', {
          elo_rank_key: typeof raw === 'string' ? raw : typeof raw,
        });
      } catch {
        /* ignore */
      }
      return { accept: false, reason: 'invalid_filter' };
    }

    const range = parseScrimRankRange(scrim?.rankKey);
    if (range.kind === 'invalid') {
      return { accept: false, reason: 'invalid_scrim' };
    }

    if (isFilterRankIncludedInScrimRange(raw, scrim?.rankKey)) {
      return { accept: true, reason: 'match' };
    }
    return { accept: false, reason: 'no_match' };
  } catch (err) {
    try {
      logger.warn('rankTaxonomy.destinationAcceptsScrim: error fail-closed', {
        message: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* ignore */
    }
    return { accept: false, reason: 'invalid_filter' };
  }
}

/**
 * Vérifie qu'une clé filtre est dans le catalogue LoL primaire.
 * @param {string} rankKey
 */
export function assertFilterRankInPrimaryCatalog(rankKey) {
  const ranks = GAMES[UI_PRIMARY_GAME_KEY]?.ranks ?? [];
  return ranks.includes(rankKey) && isValidLolFilterRankKey(rankKey);
}
