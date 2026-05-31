/** Borne haute inclusive du numéro d’ID public Recherche Joueur (J1 … J9999). */
export const PLAYER_SEARCH_PUBLIC_ID_MAX = 9999;

/** @type {RegExp} */
export const PLAYER_SEARCH_PUBLIC_ID_PATTERN = /^J(\d+)$/i;

/**
 * Normalise une saisie utilisateur en ID public canonique (`J3`).
 * @param {string} raw
 * @returns {string | null} `null` si format invalide ou hors plage
 */
export function normalizePlayerSearchPublicId(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  const m = PLAYER_SEARCH_PUBLIC_ID_PATTERN.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1 || n > PLAYER_SEARCH_PUBLIC_ID_MAX) return null;
  return `J${n}`;
}

/**
 * @param {string} publicId ID canonique `J{n}`
 * @returns {number | null}
 */
export function parsePlayerSearchPublicIdNumber(publicId) {
  const normalized = normalizePlayerSearchPublicId(publicId);
  if (!normalized) return null;
  const m = PLAYER_SEARCH_PUBLIC_ID_PATTERN.exec(normalized);
  if (!m) return null;
  return Number(m[1]);
}

/**
 * @param {number} n
 * @returns {string}
 */
export function formatPlayerSearchPublicId(n) {
  if (!Number.isFinite(n) || n < 1 || n > PLAYER_SEARCH_PUBLIC_ID_MAX) {
    throw new RangeError(
      `player_search_public_id hors plage (1–${PLAYER_SEARCH_PUBLIC_ID_MAX})`,
    );
  }
  return `J${Math.floor(n)}`;
}

/**
 * Plus petit ID public libre parmi les recherches `active` uniquement.
 * @param {{ listActivePlayerSearchPublicIds: import('better-sqlite3').Statement }} stmts
 * @returns {string | null} ex. `J1`, ou `null` si le pool est épuisé
 */
export function allocatePlayerSearchPublicId(stmts) {
  const rows = stmts.listActivePlayerSearchPublicIds.all();
  /** @type {Set<number>} */
  const used = new Set();
  for (const row of rows) {
    const n = parsePlayerSearchPublicIdNumber(String(row.player_search_public_id ?? ''));
    if (n != null) used.add(n);
  }

  for (let n = 1; n <= PLAYER_SEARCH_PUBLIC_ID_MAX; n += 1) {
    if (!used.has(n)) return formatPlayerSearchPublicId(n);
  }
  return null;
}
