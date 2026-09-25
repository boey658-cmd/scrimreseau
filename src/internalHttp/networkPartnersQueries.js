/**
 * Lectures READ-ONLY partenaires publics (page site /network).
 * Source : guild_game_channels − exclusions − guilds absentes du cache Discord.
 * Phase 5 : batch profils + invites + entitlements (fail-safe FREE).
 */

import { buildPublicNetworkPartners } from '../services/publicNetworkPartners.js';
import { getStructureProfileFeatureFlags } from '../services/structureProfileResolver.js';
import {
  getStructureInviteUrlsByGuildIds,
  getStructureProfilesByGuildIds,
} from '../services/structureProfileStore.js';
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
 * @param {{ nowMs?: number, stmts?: any }} [opts]
 */
export function fetchNetworkPartners(db, client, opts = {}) {
  /** @type {Array<{ guild_id: unknown }>} */
  const partnerRows = db
    .prepare(`SELECT DISTINCT guild_id FROM guild_game_channels ORDER BY guild_id`)
    .all();

  /** @type {Array<{ guild_id: unknown }>} */
  const exclusionRows = db
    .prepare(`SELECT guild_id FROM network_public_exclusions`)
    .all();

  /** @type {Set<string>} */
  const excludedIds = new Set(exclusionRows.map((r) => String(r.guild_id)));

  const partnerIds = partnerRows.map((r) => String(r.guild_id));

  const inviteByGuild = getStructureInviteUrlsByGuildIds(db, partnerIds);
  const profileByGuild = getStructureProfilesByGuildIds(db, partnerIds);

  return buildPublicNetworkPartners(
    partnerIds,
    excludedIds,
    (guildId) => {
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
    },
    {
      nowMs: opts.nowMs,
      stmts: opts.stmts,
      getInviteUrl: (guildId) => inviteByGuild.get(guildId) ?? null,
      getStoredProfile: (guildId) => {
        const row = profileByGuild.get(guildId);
        if (!row) return null;
        return {
          display_name: row.display_name,
          description: row.description,
          logo_url: row.logo_url,
          website_url: row.website_url,
          country_code: row.country_code,
          languages: row.languages,
          socials: row.socials,
        };
      },
      getFlags: (guildId) =>
        getStructureProfileFeatureFlags(guildId, {
          nowMs: opts.nowMs,
          stmts: opts.stmts,
        }),
    },
  );
}

export { isSqliteBusyError };
