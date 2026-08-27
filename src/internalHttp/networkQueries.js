/**
 * Lectures READ-ONLY network overview (Web4B).
 * Agrégats anonymes — aucune identité guild/user/message.
 */

import { formatCreatedAt } from './overviewQueries.js';

/**
 * @param {import('better-sqlite3').Database} db
 */
export function fetchNetworkOverview(db) {
  const configuredRow = db
    .prepare(`SELECT COUNT(DISTINCT guild_id) AS n FROM guild_game_channels`)
    .get();
  const configured_guilds_count = Number(configuredRow?.n ?? 0);

  const publishedRow = db.prepare(`SELECT COUNT(*) AS n FROM scrim_posts`).get();
  const published_scrims_count = Number(publishedRow?.n ?? 0);

  const closedRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM scrim_posts
       WHERE status IN ('closed_manual', 'closed_expired')`,
    )
    .get();
  const closed_scrims_count = Number(closedRow?.n ?? 0);

  const activeRow = db
    .prepare(`SELECT COUNT(*) AS n FROM scrim_posts WHERE status = 'active'`)
    .get();
  const active_scrims_count = Number(activeRow?.n ?? 0);

  /** @type {Array<{ scrim_public_id: unknown, status: unknown, created_at: unknown, game_key: unknown, rank_key: unknown }>} */
  const recentRows = db
    .prepare(
      `SELECT scrim_public_id, status, created_at, game_key, rank_key
       FROM scrim_posts
       ORDER BY created_at DESC
       LIMIT 10`,
    )
    .all();

  const recent = recentRows.map((row) => ({
    public_id: row.scrim_public_id,
    status: row.status,
    created_at: formatCreatedAt(row.created_at),
    game_key: row.game_key,
    rank_key: row.rank_key,
  }));

  return {
    configured_guilds_count,
    published_scrims_count,
    closed_scrims_count,
    active_scrims_count,
    recent,
  };
}
