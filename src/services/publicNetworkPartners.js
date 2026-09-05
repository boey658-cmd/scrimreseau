/**
 * Construction de la liste publique des partenaires réseau (page /network).
 * Logique pure, sans I/O — testable unitairement.
 * Indépendante du dashboard Discord (rotation, PNG, config message).
 */

/**
 * @typedef {{ name: string, icon_url: string | null }} PublicNetworkPartner
 */

/**
 * Filtre, résout et trie les partenaires visibles sur le site public.
 *
 * - Retire les guild_id exclus (network_public_exclusions)
 * - Retire les guilds absentes du cache Discord (resolveGuild → null)
 * - N’expose jamais guild_id
 *
 * @param {readonly string[]} partnerIds Liste ordonnée (ex. ORDER BY guild_id)
 * @param {ReadonlySet<string>} excludedIds Guilds masquées du site uniquement
 * @param {(guildId: string) => PublicNetworkPartner | null} resolveGuild
 *   Retourne null si la guild n’est pas dans le cache bot
 * @returns {{ partners: PublicNetworkPartner[], count: number }}
 */
export function buildPublicNetworkPartners(partnerIds, excludedIds, resolveGuild) {
  /** @type {PublicNetworkPartner[]} */
  const partners = [];
  const ids = Array.isArray(partnerIds) ? partnerIds : [];
  const excluded = excludedIds instanceof Set ? excludedIds : new Set();

  for (const rawId of ids) {
    const guildId = String(rawId ?? '');
    if (!guildId || excluded.has(guildId)) continue;

    const info = resolveGuild(guildId);
    if (!info || typeof info !== 'object') continue;

    const name = String(info.name ?? '').trim();
    if (!name) continue;

    const iconRaw = info.icon_url;
    const icon_url = iconRaw == null || iconRaw === ''
      ? null
      : String(iconRaw);

    partners.push({ name, icon_url });
  }

  partners.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );

  return {
    partners,
    count: partners.length,
  };
}
