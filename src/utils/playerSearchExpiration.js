import { DateTime } from 'luxon';

/** Marge après l’heure prévue avant expiration automatique. */
export const PLAYER_SEARCH_EXPIRATION_GRACE_HOURS = 3;

/**
 * Instant ISO UTC : scheduled_at + 3 h.
 *
 * @param {string} scheduledAtIso
 * @returns {string}
 */
export function computePlayerSearchExpirationAtIso(scheduledAtIso) {
  const raw = String(scheduledAtIso ?? '').trim();
  const dt = DateTime.fromISO(raw, { zone: 'utc' });
  if (!dt.isValid) {
    throw new Error(`scheduled_at invalide: ${scheduledAtIso}`);
  }
  return dt.plus({ hours: PLAYER_SEARCH_EXPIRATION_GRACE_HOURS }).toUTC().toISO();
}

/**
 * @param {{ scheduled_at?: string | null }} row
 * @param {string} [nowIso]
 * @returns {boolean}
 */
export function isPlayerSearchExpired(row, nowIso = new Date().toISOString()) {
  const scheduledAt =
    typeof row.scheduled_at === 'string' ? row.scheduled_at.trim() : '';
  if (!scheduledAt) return true;
  const expiresAt = computePlayerSearchExpirationAtIso(scheduledAt);
  return String(nowIso) >= expiresAt;
}
