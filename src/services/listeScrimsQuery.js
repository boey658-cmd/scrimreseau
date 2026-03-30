import { GAMES, UI_PRIMARY_GAME_KEY } from '../config/games.js';
import {
  FORMAT_SCRIM_SERIE_KEY,
  FEARLESS_VALUE_NIMPORTE,
  FEARLESS_VALUE_OUI,
  formatParisScrimListSchedule,
  parseFearlessFromTags,
  parseNombreDeGamesFromTags,
} from './scrimEmbedBuilder.js';

/** Récupéré pour détecter s’il y a plus de résultats. */
export const LISTE_FETCH_LIMIT = 21;
/** Nombre max de lignes affichées dans le message Discord. */
export const LISTE_DISPLAY_MAX = 20;

const MIX_NIVEAU = 'Mix niveau';

/**
 * Rang choisi (slash) → clés `rank_key` à inclure dans le filtre SQL.
 * - `Mix niveau` : uniquement cette valeur.
 * - Rang composite `A / B` : libellé complet + `A` + `B` (dédoublonné), inchangé.
 * - Rang simple (catalogue LoL) : ce rang + toute plage `X / Y` du catalogue dont une extrémité est ce rang
 *   (ex. `Bronze` → `Bronze`, `Bronze / Argent`).
 *
 * @param {string} selectedRank
 * @returns {string[]}
 */
export function expandRankKeysForListeFilter(selectedRank) {
  const full = String(selectedRank).trim();
  if (!full) return [];
  if (full === MIX_NIVEAU) return [MIX_NIVEAU];

  const parts = full
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 2) {
    return [...new Set([full, parts[0], parts[1]])];
  }

  const catalogRanks = GAMES[UI_PRIMARY_GAME_KEY].ranks;
  const keys = [full];
  const seen = new Set(keys);
  for (const r of catalogRanks) {
    if (!r.includes('/')) continue;
    const segs = r
      .split('/')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (segs.length !== 2) continue;
    if (segs[0] === full || segs[1] === full) {
      if (!seen.has(r)) {
        seen.add(r);
        keys.push(r);
      }
    }
  }
  return keys;
}

/**
 * @typedef {{
 *   rankKeys?: string[] | null,
 *   scheduledDate?: string | null,
 *   timeMin?: string | null,
 *   timeMax?: string | null,
 * }} ListeScrimsFilters
 */

/**
 * @param {ListeScrimsFilters} filters
 * @returns {{ sql: string, params: unknown[] }}
 */
export function buildActiveScrimsListeQuery(filters) {
  let sql = `
    SELECT id, scrim_public_id, rank_key, scheduled_date, scheduled_time, scheduled_at, scheduled_at_end, format_key, tags, game_key
    FROM scrim_posts
    WHERE status = 'active'`;
  const params = [];

  if (filters.rankKeys && filters.rankKeys.length > 0) {
    const placeholders = filters.rankKeys.map(() => '?').join(', ');
    sql += ` AND rank_key IN (${placeholders})`;
    params.push(...filters.rankKeys);
  }
  if (filters.scheduledDate) {
    sql += ' AND scheduled_date = ?';
    params.push(filters.scheduledDate);
  }
  if (filters.timeMin) {
    sql += ' AND scheduled_time >= ?';
    params.push(filters.timeMin);
  }
  if (filters.timeMax) {
    sql += ' AND scheduled_time <= ?';
    params.push(filters.timeMax);
  }

  sql += `
    ORDER BY
      CASE WHEN scheduled_at IS NOT NULL AND trim(scheduled_at) != '' THEN scheduled_at ELSE '9999-12-31T23:59:59.999Z' END ASC,
      scrim_public_id ASC
    LIMIT ${LISTE_FETCH_LIMIT}`;

  return { sql, params };
}

/**
 * @param {ListeScrimsFilters} filters
 * @returns {{ sql: string, params: unknown[] }}
 */
export function buildCountActiveScrimsListeQuery(filters) {
  let sql = `SELECT COUNT(*) AS n FROM scrim_posts WHERE status = 'active'`;
  const params = [];

  if (filters.rankKeys && filters.rankKeys.length > 0) {
    const placeholders = filters.rankKeys.map(() => '?').join(', ');
    sql += ` AND rank_key IN (${placeholders})`;
    params.push(...filters.rankKeys);
  }
  if (filters.scheduledDate) {
    sql += ' AND scheduled_date = ?';
    params.push(filters.scheduledDate);
  }
  if (filters.timeMin) {
    sql += ' AND scheduled_time >= ?';
    params.push(filters.timeMin);
  }
  if (filters.timeMax) {
    sql += ' AND scheduled_time <= ?';
    params.push(filters.timeMax);
  }

  return { sql, params };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {ListeScrimsFilters} filters
 */
export function runActiveScrimsListeQuery(db, filters) {
  const { sql, params } = buildActiveScrimsListeQuery(filters);
  return db.prepare(sql).all(...params);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {ListeScrimsFilters} filters
 */
export function runCountActiveScrimsListe(db, filters) {
  const { sql, params } = buildCountActiveScrimsListeQuery(filters);
  const row = /** @type {{ n?: number } | undefined} */ (
    db.prepare(sql).get(...params)
  );
  return Number(row?.n ?? 0);
}

/**
 * @param {{
 *   scheduled_at: string | null,
 *   scheduled_at_end?: string | null,
 *   scheduled_date: string,
 *   scheduled_time: string,
 * }} row
 * @returns {{ dateStr: string, timeStr: string }}
 */
function formatScheduleLine(row) {
  return formatParisScrimListSchedule(row);
}

/**
 * @param {string} formatKey
 * @param {number | null} nombreDeGames
 */
function formatFormatPart(formatKey, nombreDeGames) {
  if (
    formatKey === FORMAT_SCRIM_SERIE_KEY &&
    nombreDeGames != null &&
    Number.isFinite(nombreDeGames)
  ) {
    return `${formatKey} — ${nombreDeGames} games`;
  }
  return formatKey;
}

/**
 * @param {string} guildId
 * @param {string} channelId
 * @param {string} messageId
 */
export function buildDiscordMessageUrl(guildId, channelId, messageId) {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} tagsStr
 * @param {string | null} messageUrl
 */
export function formatListeScrimLine(row, tagsStr, messageUrl) {
  const rank = String(row.rank_key ?? '');
  const { dateStr, timeStr } = formatScheduleLine(row);
  const nombre = parseNombreDeGamesFromTags(tagsStr);
  const fmtPart = formatFormatPart(String(row.format_key ?? ''), nombre);

  const fearless = parseFearlessFromTags(tagsStr);
  let fearlessPart = '';
  if (fearless != null && fearless !== FEARLESS_VALUE_NIMPORTE) {
    fearlessPart =
      fearless === FEARLESS_VALUE_OUI
        ? ' — Fearless : Oui'
        : ' — Fearless : Non';
  }

  let line = `${rank} — ${dateStr} à ${timeStr} — ${fmtPart}${fearlessPart}`;
  if (messageUrl) {
    line += ` — [Voir le message](${messageUrl})`;
  }
  return line;
}
