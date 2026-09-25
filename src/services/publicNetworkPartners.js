/**
 * Construction de la liste publique des partenaires réseau (page /network).
 * Phase 5 : profil enrichi + badge + tri Premium featured.
 * Indépendante du dashboard Discord (rotation, PNG, config message).
 */

import {
  resolvePublicStructurePartner,
  sortPublicNetworkPartners,
  toPublicNetworkPartnerPayload,
  getStructureProfileFeatureFlags,
} from './structureProfileResolver.js';

/**
 * @typedef {{
 *   name: string,
 *   icon_url: string | null,
 *   logo_url: string | null,
 *   invite_url: string | null,
 *   description: string | null,
 *   website_url: string | null,
 *   country_code: string | null,
 *   languages: string[] | null,
 *   socials: Array<{ provider: string, url: string }> | null,
 *   premium_badge: boolean,
 *   premium_featured: boolean,
 * }} PublicNetworkPartner
 */

/**
 * @param {readonly string[]} partnerIds
 * @param {ReadonlySet<string>} excludedIds
 * @param {(guildId: string) => { name: string, icon_url: string | null } | null} resolveGuild
 * @param {{
 *   getInviteUrl?: (guildId: string) => string | null,
 *   getStoredProfile?: (guildId: string) => import('./structureProfileResolver.js').StructureProfileFields | null,
 *   getFlags?: (guildId: string) => ReturnType<typeof getStructureProfileFeatureFlags>,
 *   nowMs?: number,
 *   stmts?: any,
 * }} [opts]
 */
export function buildPublicNetworkPartners(partnerIds, excludedIds, resolveGuild, opts = {}) {
  /** @type {Array<ReturnType<typeof resolvePublicStructurePartner>>} */
  const resolved = [];
  const ids = Array.isArray(partnerIds) ? partnerIds : [];
  const excluded = excludedIds instanceof Set ? excludedIds : new Set();

  for (const rawId of ids) {
    const guildId = String(rawId ?? '');
    if (!guildId || excluded.has(guildId)) continue;

    const info = resolveGuild(guildId);
    if (!info || typeof info !== 'object') continue;

    const discordName = String(info.name ?? '').trim();
    if (!discordName) continue;

    const iconRaw = info.icon_url;
    const discordIconUrl =
      iconRaw == null || iconRaw === '' ? null : String(iconRaw);

    const inviteUrl =
      typeof opts.getInviteUrl === 'function' ? opts.getInviteUrl(guildId) : null;
    const stored =
      typeof opts.getStoredProfile === 'function'
        ? opts.getStoredProfile(guildId)
        : null;
    let flags;
    try {
      flags =
        typeof opts.getFlags === 'function'
          ? opts.getFlags(guildId)
          : getStructureProfileFeatureFlags(guildId, {
              nowMs: opts.nowMs,
              stmts: opts.stmts,
            });
    } catch {
      flags = {
        enriched_profile: false,
        premium_badge: false,
        directory_featured: false,
      };
    }

    resolved.push(
      resolvePublicStructurePartner({
        guildId,
        discordName,
        discordIconUrl,
        inviteUrl,
        stored,
        flags,
      }),
    );
  }

  const sorted = sortPublicNetworkPartners(resolved);
  const partners = sorted.map(toPublicNetworkPartnerPayload);

  return {
    partners,
    count: partners.length,
  };
}
