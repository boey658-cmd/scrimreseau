/**
 * Résolution profil public / dashboard (Phase 5).
 * Backend = source de vérité ; fail-safe FREE.
 */

import { canUseFeature } from './entitlements/index.js';
import { getStructureProfile } from './structureProfileStore.js';

/**
 * @typedef {{
 *   display_name: string | null,
 *   description: string | null,
 *   logo_url: string | null,
 *   website_url: string | null,
 *   country_code: string | null,
 *   languages: string[] | null,
 *   socials: Array<{ provider: string, url: string }> | null,
 * }} StructureProfileFields
 */

/**
 * @param {string} guildId
 * @param {{ nowMs?: number, stmts?: any }} [opts]
 */
export function getStructureProfileFeatureFlags(guildId, opts = {}) {
  let enriched = false;
  let badge = false;
  let featured = false;
  try {
    enriched = canUseFeature(guildId, 'enhanced_structure_profile', opts);
  } catch {
    enriched = false;
  }
  try {
    badge = canUseFeature(guildId, 'premium_badge', opts);
  } catch {
    badge = false;
  }
  try {
    featured = canUseFeature(guildId, 'directory_featured', opts);
  } catch {
    featured = false;
  }
  return {
    enriched_profile: Boolean(enriched),
    premium_badge: Boolean(badge),
    directory_featured: Boolean(featured),
  };
}

/**
 * @param {StructureProfileFields | null | undefined} stored
 * @returns {StructureProfileFields}
 */
export function emptyStoredProfile() {
  return {
    display_name: null,
    description: null,
    logo_url: null,
    website_url: null,
    country_code: null,
    languages: null,
    socials: null,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @param {{ nowMs?: number, stmts?: any }} [opts]
 */
export function buildDashboardStructureProfileView(db, guildId, opts = {}) {
  const row = getStructureProfile(db, guildId);
  const stored = row
    ? {
        display_name: row.display_name,
        description: row.description,
        logo_url: row.logo_url,
        website_url: row.website_url,
        country_code: row.country_code,
        languages: row.languages,
        socials: row.socials,
      }
    : emptyStoredProfile();

  const flags = getStructureProfileFeatureFlags(guildId, opts);
  const effective = flags.enriched_profile
    ? { ...stored }
    : emptyStoredProfile();

  return {
    stored,
    effective,
    feature_available: flags.enriched_profile,
    premium_badge: flags.premium_badge,
    directory_featured: flags.directory_featured,
  };
}

/**
 * @param {{
 *   guildId: string,
 *   discordName: string,
 *   discordIconUrl: string | null,
 *   inviteUrl: string | null,
 *   stored: StructureProfileFields | null,
 *   flags: ReturnType<typeof getStructureProfileFeatureFlags>,
 * }} p
 */
export function resolvePublicStructurePartner(p) {
  const baseName = String(p.discordName ?? '').trim();
  const stored = p.stored ?? emptyStoredProfile();
  const enriched = p.flags.enriched_profile;

  const name =
    enriched && stored.display_name && stored.display_name.trim()
      ? stored.display_name.trim()
      : baseName;

  const logo_url = enriched && stored.logo_url ? stored.logo_url : null;
  const icon_url = p.discordIconUrl || null;

  return {
    name,
    icon_url,
    logo_url,
    invite_url: p.inviteUrl || null,
    description: enriched ? stored.description : null,
    website_url: enriched ? stored.website_url : null,
    country_code: enriched ? stored.country_code : null,
    languages: enriched && stored.languages ? [...stored.languages] : null,
    socials: enriched && stored.socials
      ? stored.socials.map((s) => ({ provider: s.provider, url: s.url }))
      : null,
    premium_badge: Boolean(p.flags.premium_badge),
    premium_featured: Boolean(p.flags.directory_featured),
    /** interne tri uniquement — jamais exposé public */
    _sort_guild_id: String(p.guildId),
  };
}

/**
 * Tri public : Premium featured d’abord, puis alphabétique, tie-break guild_id.
 * @param {Array<ReturnType<typeof resolvePublicStructurePartner>>} partners
 */
export function sortPublicNetworkPartners(partners) {
  return [...partners].sort((a, b) => {
    if (a.premium_featured !== b.premium_featured) {
      return a.premium_featured ? -1 : 1;
    }
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    if (byName !== 0) return byName;
    return String(a._sort_guild_id).localeCompare(String(b._sort_guild_id));
  });
}

/**
 * Strip champs internes avant réponse HTTP publique.
 * @param {ReturnType<typeof resolvePublicStructurePartner>} partner
 */
export function toPublicNetworkPartnerPayload(partner) {
  return {
    name: partner.name,
    icon_url: partner.icon_url,
    logo_url: partner.logo_url,
    invite_url: partner.invite_url,
    description: partner.description,
    website_url: partner.website_url,
    country_code: partner.country_code,
    languages: partner.languages,
    socials: partner.socials,
    premium_badge: partner.premium_badge,
    premium_featured: partner.premium_featured,
  };
}
