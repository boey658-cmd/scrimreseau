/**
 * Règle : configuration du salon de **réception** des scrims (pas /recherche-scrim).
 * Autorisation uniquement via validation manuelle (`guild_scrim_reception_bypass`).
 */

const SCRIM_RECEPTION_MIN_MEMBERS_FALLBACK = 150;

const REFUSAL_BODY =
  'Pour garder un réseau propre, la réception des scrims sur serveur est validée manuellement.\n' +
  'Ouvrez un ticket sur le Discord ScrimRéseau avec le lien de votre serveur pour faire la demande.';

/**
 * Compatibilité — n’est plus utilisé pour autoriser la configuration réception.
 * Seuil effectif : `SCRIM_RECEPTION_MIN_MEMBERS` (entier > 0) ou 150 si absent / invalide.
 */
export function getScrimReceptionMinMembers() {
  const raw = process.env.SCRIM_RECEPTION_MIN_MEMBERS;
  if (raw === undefined || raw === null) return SCRIM_RECEPTION_MIN_MEMBERS_FALLBACK;
  const s = String(raw).trim();
  if (!s) return SCRIM_RECEPTION_MIN_MEMBERS_FALLBACK;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return SCRIM_RECEPTION_MIN_MEMBERS_FALLBACK;
  }
  return n;
}

/**
 * @param {{ bypass_member_minimum?: number | null } | undefined} row
 */
export function isGuildReceptionBypassActive(row) {
  return Boolean(row && Number(row.bypass_member_minimum) === 1);
}

/**
 * @param {number | null | undefined} _memberCount Conservé pour compatibilité d’appel ; ignoré.
 * @param {{ bypass_member_minimum?: number | null } | undefined} bypassRow
 */
export function mayConfigureScrimReceptionChannel(_memberCount, bypassRow) {
  return isGuildReceptionBypassActive(bypassRow);
}

/**
 * Dernière ligne : `SCRIM_RECEPTION_TICKET_URL` si défini (HTTPS), sinon `[ton lien]`.
 */
export function buildScrimReceptionConfigRefusalContent() {
  const url = process.env.SCRIM_RECEPTION_TICKET_URL?.trim();
  const linkLine = url && /^https?:\/\//i.test(url) ? url : '[ton lien]';
  return `${REFUSAL_BODY}\n\n${linkLine}`;
}
