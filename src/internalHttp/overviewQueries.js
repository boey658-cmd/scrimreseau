/**
 * Lectures dashboard guild overview — scrim_posts (+ config légère pour flags).
 * Aucune table broadcast / lifecycle / queue.
 */

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 */
export function fetchGuildOverview(db, guildId) {
  const publishedRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM scrim_posts WHERE origin_guild_id = ?`,
    )
    .get(guildId);
  const published_count = Number(publishedRow?.n ?? 0);

  const closedRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM scrim_posts
       WHERE origin_guild_id = ?
         AND status IN ('closed_manual', 'closed_expired')`,
    )
    .get(guildId);
  const closed_count = Number(closedRow?.n ?? 0);

  /** @type {Array<{ scrim_public_id: unknown, status: unknown, created_at: unknown, game_key: unknown, rank_key: unknown }>} */
  const recentRows = db
    .prepare(
      `SELECT scrim_public_id, status, created_at, game_key, rank_key
       FROM scrim_posts
       WHERE origin_guild_id = ?
       ORDER BY created_at DESC
       LIMIT 10`,
    )
    .all(guildId);

  const recent = recentRows.map((row) => ({
    public_id: row.scrim_public_id,
    status: row.status,
    created_at: formatCreatedAt(row.created_at),
    game_key: row.game_key,
    rank_key: row.rank_key,
  }));

  const configuredRow = db
    .prepare(
      `SELECT guild_id FROM guild_game_channels WHERE guild_id = ? LIMIT 1`,
    )
    .get(guildId);
  const configured = Boolean(configuredRow);

  return {
    published_count,
    closed_count,
    recent,
    configured,
  };
}

/**
 * Sérialise created_at SQLite (epoch ms) en ISO string (partagé guild/network overview).
 * @param {unknown} createdAt
 * @returns {string}
 */
export function formatCreatedAt(createdAt) {
  const ms = Number(createdAt);
  if (!Number.isFinite(ms) || ms <= 0) {
    return '';
  }
  return new Date(ms).toISOString();
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isSqliteBusyError(err) {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const code = /** @type {{ code?: unknown }} */ (err).code;
  if (code === 'SQLITE_BUSY') {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('SQLITE_BUSY');
}
