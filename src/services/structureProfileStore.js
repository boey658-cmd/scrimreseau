/**
 * Persistence structure_profiles (Phase 5).
 */

/**
 * @typedef {{
 *   guild_id: string,
 *   display_name: string | null,
 *   description: string | null,
 *   logo_url: string | null,
 *   website_url: string | null,
 *   country_code: string | null,
 *   languages: string[] | null,
 *   socials: Array<{ provider: string, url: string }> | null,
 *   created_at: number,
 *   updated_at: number,
 * }} StructureProfileRow
 */

/**
 * @param {unknown} raw
 * @returns {string[] | null}
 */
function parseLanguagesJson(raw) {
  if (raw == null || raw === '') return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x) => typeof x === 'string');
  } catch {
    return null;
  }
}

/**
 * @param {unknown} raw
 * @returns {Array<{ provider: string, url: string }> | null}
 */
function parseSocialsJson(raw) {
  if (raw == null || raw === '') return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return null;
    /** @type {Array<{ provider: string, url: string }>} */
    const out = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const provider = /** @type {{ provider?: unknown, url?: unknown }} */ (item).provider;
      const url = /** @type {{ provider?: unknown, url?: unknown }} */ (item).url;
      if (typeof provider === 'string' && typeof url === 'string') {
        out.push({ provider, url });
      }
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @returns {StructureProfileRow | null}
 */
export function getStructureProfile(db, guildId) {
  /** @type {{
   *   guild_id: unknown,
   *   display_name: unknown,
   *   description: unknown,
   *   logo_url: unknown,
   *   website_url: unknown,
   *   country_code: unknown,
   *   languages_json: unknown,
   *   socials_json: unknown,
   *   created_at: unknown,
   *   updated_at: unknown,
   * } | undefined}
   */
  let row;
  try {
    row = db
      .prepare(
        `SELECT guild_id, display_name, description, logo_url, website_url,
                country_code, languages_json, socials_json, created_at, updated_at
         FROM structure_profiles WHERE guild_id = ? LIMIT 1`,
      )
      .get(guildId);
  } catch {
    return null;
  }
  if (!row) return null;
  return {
    guild_id: String(row.guild_id),
    display_name: row.display_name == null ? null : String(row.display_name),
    description: row.description == null ? null : String(row.description),
    logo_url: row.logo_url == null ? null : String(row.logo_url),
    website_url: row.website_url == null ? null : String(row.website_url),
    country_code: row.country_code == null ? null : String(row.country_code),
    languages: parseLanguagesJson(row.languages_json),
    socials: parseSocialsJson(row.socials_json),
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} guildIds
 * @returns {Map<string, StructureProfileRow>}
 */
export function getStructureProfilesByGuildIds(db, guildIds) {
  /** @type {Map<string, StructureProfileRow>} */
  const map = new Map();
  if (!Array.isArray(guildIds) || guildIds.length === 0) return map;

  const unique = [...new Set(guildIds.map((id) => String(id)).filter(Boolean))];
  // SQLite variable limit — batch by 400
  const chunkSize = 400;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    /** @type {Array<Record<string, unknown>>} */
    let rows = [];
    try {
      rows = db
        .prepare(
          `SELECT guild_id, display_name, description, logo_url, website_url,
                  country_code, languages_json, socials_json, created_at, updated_at
           FROM structure_profiles WHERE guild_id IN (${placeholders})`,
        )
        .all(...chunk);
    } catch {
      continue;
    }
    for (const row of rows) {
      const guildId = String(row.guild_id ?? '');
      if (!guildId) continue;
      map.set(guildId, {
        guild_id: guildId,
        display_name: row.display_name == null ? null : String(row.display_name),
        description: row.description == null ? null : String(row.description),
        logo_url: row.logo_url == null ? null : String(row.logo_url),
        website_url: row.website_url == null ? null : String(row.website_url),
        country_code: row.country_code == null ? null : String(row.country_code),
        languages: parseLanguagesJson(row.languages_json),
        socials: parseSocialsJson(row.socials_json),
        created_at: Number(row.created_at) || 0,
        updated_at: Number(row.updated_at) || 0,
      });
    }
  }
  return map;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @param {{
 *   display_name: string | null,
 *   description: string | null,
 *   logo_url: string | null,
 *   website_url: string | null,
 *   country_code: string | null,
 *   languages: string[] | null,
 *   socials: Array<{ provider: string, url: string }> | null,
 * }} data
 * @param {number} [nowMs]
 */
export function upsertStructureProfile(db, guildId, data, nowMs = Date.now()) {
  const languagesJson = data.languages == null ? null : JSON.stringify(data.languages);
  const socialsJson = data.socials == null ? null : JSON.stringify(data.socials);
  db.prepare(
    `INSERT INTO structure_profiles (
       guild_id, display_name, description, logo_url, website_url,
       country_code, languages_json, socials_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET
       display_name = excluded.display_name,
       description = excluded.description,
       logo_url = excluded.logo_url,
       website_url = excluded.website_url,
       country_code = excluded.country_code,
       languages_json = excluded.languages_json,
       socials_json = excluded.socials_json,
       updated_at = excluded.updated_at`,
  ).run(
    guildId,
    data.display_name,
    data.description,
    data.logo_url,
    data.website_url,
    data.country_code,
    languagesJson,
    socialsJson,
    nowMs,
    nowMs,
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 */
export function deleteStructureProfile(db, guildId) {
  db.prepare(`DELETE FROM structure_profiles WHERE guild_id = ?`).run(guildId);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} guildIds
 * @returns {Map<string, string | null>}
 */
export function getStructureInviteUrlsByGuildIds(db, guildIds) {
  /** @type {Map<string, string | null>} */
  const map = new Map();
  if (!Array.isArray(guildIds) || guildIds.length === 0) return map;
  const unique = [...new Set(guildIds.map((id) => String(id)).filter(Boolean))];
  const chunkSize = 400;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    /** @type {Array<{ guild_id: unknown, discord_invite_url: unknown }>} */
    let rows = [];
    try {
      rows = db
        .prepare(
          `SELECT guild_id, discord_invite_url FROM structure_discord_links
           WHERE guild_id IN (${placeholders})`,
        )
        .all(...chunk);
    } catch {
      continue;
    }
    for (const row of rows) {
      const id = String(row.guild_id ?? '');
      if (!id) continue;
      map.set(
        id,
        row.discord_invite_url == null ? null : String(row.discord_invite_url),
      );
    }
  }
  return map;
}
