import { DateTime } from 'luxon';

export const SCRIM_TIMEZONE = 'Europe/Paris';

/**
 * Même logique de découpage horaire que la validation slash (heure seule ou HH:MM).
 * @param {string} timeStr
 */
function parseHourMinuteParts(timeStr) {
  let s = timeStr.trim().toLowerCase().replace(/h/gi, ':');
  const tparts = s.split(':').map((p) => p.trim()).filter((p) => p.length > 0);
  if (tparts.length === 1) {
    const h = Number(tparts[0]);
    return { hours: h, minutes: 0 };
  }
  if (tparts.length === 2) {
    return { hours: Number(tparts[0]), minutes: Number(tparts[1]) };
  }
  throw new Error('Format d’heure invalide.');
}

/**
 * Instant ISO 8601 en UTC : date + heure saisies par l’utilisateur sont interprétées
 * comme heure de Paris (IANA), puis converties en UTC (Luxon + base tz).
 *
 * @param {string} dateStr DD/MM ou DD/MM/YYYY
 * @param {string} timeStr HH:MM, 20h30, 20h, etc.
 * @param {number} createdAtMs année par défaut si date sans année
 * @returns {string}
 */
export function computeScheduledAtIso(dateStr, timeStr, createdAtMs) {
  const normalized = dateStr.trim().replace(/-/g, '/');
  const dparts = normalized.split('/').map((p) => p.trim()).filter(Boolean);
  const day = Number(dparts[0]);
  const month = Number(dparts[1]);
  const year =
    dparts.length === 3
      ? Number(dparts[2])
      : new Date(createdAtMs).getFullYear();

  const { hours, minutes } = parseHourMinuteParts(timeStr);

  const dt = DateTime.fromObject(
    {
      year,
      month,
      day,
      hour: hours,
      minute: minutes,
      second: 0,
      millisecond: 0,
    },
    { zone: SCRIM_TIMEZONE },
  );

  if (!dt.isValid) {
    throw new Error(dt.invalidReason ?? 'Date/heure invalide pour Europe/Paris.');
  }

  return dt.toUTC().toISO();
}
