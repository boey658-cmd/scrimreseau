/**
 * Sélection round-robin des partenaires visibles sur le dashboard réseau.
 * Logique pure, sans I/O — testable unitairement.
 */

/** Nombre max de logos partenaires dessinés simultanément. */
export const MAX_VISIBLE_PARTNERS = 14;

/**
 * Fenêtre circulaire de partenaires à afficher.
 *
 * @param {readonly string[]} partnerIds Liste ordonnée (ex. ORDER BY guild_id)
 * @param {number} offset Curseur de rotation (≥ 0)
 * @param {number} [limit=MAX_VISIBLE_PARTNERS]
 * @returns {string[]}
 */
export function selectVisiblePartnerIds(partnerIds, offset, limit = MAX_VISIBLE_PARTNERS) {
  const n = Array.isArray(partnerIds) ? partnerIds.length : 0;
  if (n === 0) return [];

  const safeLimit = Math.max(0, Math.floor(Number(limit)) || 0);
  if (safeLimit === 0) return [];

  if (n <= safeLimit) {
    return [...partnerIds];
  }

  let start = Math.floor(Number(offset));
  if (!Number.isFinite(start) || start < 0) start = 0;
  start = start % n;

  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < safeLimit; i++) {
    out.push(partnerIds[(start + i) % n]);
  }
  return out;
}

/**
 * Avance le curseur de rotation (modulo N).
 * Si N === 0, retourne 0.
 *
 * @param {number} offset
 * @param {number} partnerCount
 * @param {number} [step=MAX_VISIBLE_PARTNERS]
 * @returns {number}
 */
export function advanceRotationOffset(offset, partnerCount, step = MAX_VISIBLE_PARTNERS) {
  const n = Math.floor(Number(partnerCount));
  if (!Number.isFinite(n) || n <= 0) return 0;

  let cur = Math.floor(Number(offset));
  if (!Number.isFinite(cur) || cur < 0) cur = 0;

  let s = Math.floor(Number(step));
  if (!Number.isFinite(s) || s < 0) s = 0;

  return (cur + s) % n;
}
