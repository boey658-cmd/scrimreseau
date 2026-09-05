/**
 * Helpers autocomplete pour /dashboard-admin exclude-* (max 25 choix Discord).
 */

export const EXCLUDE_AUTOCOMPLETE_MAX = 25;
export const EXCLUDE_CHOICE_NAME_MAX = 100;
export const EXCLUDE_REASON_MAX = 100;

/**
 * @param {string} name
 * @param {number} [max]
 * @returns {string}
 */
export function truncateAutocompleteName(name, max = EXCLUDE_CHOICE_NAME_MAX) {
  const s = String(name ?? '');
  if (s.length <= max) return s;
  if (max <= 3) return s.slice(0, max);
  return `${s.slice(0, max - 3)}...`;
}

/**
 * Filtre et tronque une liste de choix autocomplete.
 *
 * @param {readonly { name: string, value: string }[]} entries
 * @param {string} query
 * @param {number} [limit]
 * @returns {{ name: string, value: string }[]}
 */
export function filterAutocompleteChoices(entries, query, limit = EXCLUDE_AUTOCOMPLETE_MAX) {
  const list = Array.isArray(entries) ? entries : [];
  const q = String(query ?? '').trim().toLowerCase();
  const max = Math.max(0, Math.floor(Number(limit)) || 0);

  /** @type {{ name: string, value: string }[]} */
  const filtered = [];
  for (const entry of list) {
    const name = String(entry?.name ?? '');
    const value = String(entry?.value ?? '');
    if (!value) continue;
    if (q && !name.toLowerCase().includes(q) && !value.toLowerCase().includes(q)) {
      continue;
    }
    filtered.push({
      name: truncateAutocompleteName(name || value),
      value: value.slice(0, EXCLUDE_CHOICE_NAME_MAX),
    });
    if (filtered.length >= max) break;
  }
  return filtered;
}

/**
 * @param {string | null | undefined} reason
 * @returns {string | null}
 */
export function normalizeExclusionReason(reason) {
  if (reason == null) return null;
  const trimmed = String(reason).trim();
  if (!trimmed) return null;
  return trimmed.slice(0, EXCLUDE_REASON_MAX);
}

/**
 * Snowflake Discord approximatif (17–20 chiffres).
 * @param {string} raw
 * @returns {string | null}
 */
export function parseGuildIdOption(raw) {
  const id = String(raw ?? '').trim();
  if (!/^\d{17,20}$/.test(id)) return null;
  return id;
}
