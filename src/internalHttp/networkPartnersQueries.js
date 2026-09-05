/**
 * Lectures READ-ONLY partenaires publics (page site /network).
 * Source : guild_game_channels − exclusions − guilds absentes du cache Discord.
 * Aucun couplage avec le dashboard Discord (rotation / PNG / config).
 */

import { buildPublicNetworkPartners } from '../services/publicNetworkPartners.js';
import { isSqliteBusyError } from './overviewQueries.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   guilds?: {
 *     cache?: {
 *       get: (id: string) => {
 *         name?: string | null,
 *         iconURL?: (opts?: { extension?: string, size?: number }) => string | null,
 *       } | undefined,
 *     },
 *   },
 * } | null | undefined} client
 * @returns {{ partners: Array<{ name: string, icon_url: string | null }>, count: number }}
 */
export function fetchNetworkPartners(db, client) {
  /** @type {Array<{ guild_id: unknown }>} */
  const partnerRows = db
    .prepare(`SELECT DISTINCT guild_id FROM guild_game_channels ORDER BY guild_id`)
    .all();

  /** @type {Array<{ guild_id: unknown }>} */
  const exclusionRows = db
    .prepare(`SELECT guild_id FROM network_public_exclusions`)
    .all();

  /** @type {Set<string>} */
  const excludedIds = new Set(
    exclusionRows.map((r) => String(r.guild_id)),
  );

  const partnerIds = partnerRows.map((r) => String(r.guild_id));

  return buildPublicNetworkPartners(partnerIds, excludedIds, (guildId) => {
    const guild = client?.guilds?.cache?.get(guildId);
    if (!guild) return null;

    const name = String(guild.name ?? '').trim();
    if (!name) return null;

    let icon_url = null;
    try {
      if (typeof guild.iconURL === 'function') {
        const url = guild.iconURL({ extension: 'png', size: 128 });
        icon_url = url ? String(url) : null;
      }
    } catch {
      icon_url = null;
    }

    return { name, icon_url };
  });
}

export { isSqliteBusyError };
