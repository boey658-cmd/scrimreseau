/**
 * Règle : configuration du salon de **réception** des scrims (pas /recherche-scrim).
 * Discord : `Guild#memberCount` uniquement (aucun intent membre supplémentaire).
 */

const SCRIM_RECEPTION_MIN_MEMBERS_FALLBACK = 150;

const REFUSAL_BEFORE_THRESHOLD =
  '❌ Ce serveur ne remplit pas encore les conditions pour configurer un salon scrim sur le réseau.\n\n';

const REFUSAL_AFTER_THRESHOLD =
  '👉 Vous pouvez toujours poster vos recherches de scrim normalement et utiliser le réseau.\n' +
  'Seule la réception des scrims sur votre serveur est limitée.\n\n' +
  '💬 Si votre serveur est actif et sérieux, vous pouvez faire une demande manuelle via ticket sur le serveur de liaison :\n';

/**
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
 * @param {number | null | undefined} memberCount `interaction.guild.memberCount`
 * @param {{ bypass_member_minimum?: number | null } | undefined} bypassRow
 */
export function mayConfigureScrimReceptionChannel(memberCount, bypassRow) {
  if (isGuildReceptionBypassActive(bypassRow)) return true;
  const n = Number(memberCount);
  if (!Number.isFinite(n)) return false;
  return n >= getScrimReceptionMinMembers();
}

/**
 * Dernière ligne : `SCRIM_RECEPTION_TICKET_URL` si défini (HTTPS), sinon `[ton lien]`.
 */
export function buildScrimReceptionConfigRefusalContent() {
  const min = getScrimReceptionMinMembers();
  const url = process.env.SCRIM_RECEPTION_TICKET_URL?.trim();
  const linkLine = url && /^https?:\/\//i.test(url) ? url : '[ton lien]';
  return (
    REFUSAL_BEFORE_THRESHOLD +
    `Un minimum de ${min} membres est requis pour activer la réception des scrims.\n\n` +
    REFUSAL_AFTER_THRESHOLD +
    linkLine
  );
}
