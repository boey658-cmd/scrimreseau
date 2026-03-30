import { DateTime } from 'luxon';
import { getGame } from '../config/games.js';
import { SCRIM_TIMEZONE } from './scrimScheduledAt.js';

/** Fenêtre calendaire : aujourd'hui (Paris) inclus jusqu'à aujourd'hui + 30 jours inclus. */
const SCRIM_SEARCH_MAX_DAYS_AHEAD = 30;

const ERR_DATE_PAST =
  'La date choisie ne peut pas être antérieure à aujourd\'hui.';
const ERR_DATE_WINDOW =
  'La date choisie doit être comprise entre aujourd\'hui et les 30 prochains jours.';

/**
 * @param {readonly string[]} list
 * @param {string} value
 * @returns {string | null} valeur canonique de la liste
 */
function matchFromList(list, value) {
  const v = value.trim();
  if (!v) return null;
  const lower = v.toLowerCase();
  for (const item of list) {
    if (item.toLowerCase() === lower) return item;
  }
  return null;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Normalise une date saisie (FR) vers DD/MM ou DD/MM/YYYY.
 * @param {string} raw
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function parseAndNormalizeDate(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'La date doit être une chaîne de caractères.' };
  }
  const s = raw.trim();
  if (!s) return { ok: false, error: 'La date est obligatoire.' };

  const normalized = s.replace(/-/g, '/');
  const parts = normalized.split('/').map((p) => p.trim()).filter(Boolean);

  if (parts.length !== 2 && parts.length !== 3) {
    return {
      ok: false,
      error: 'Format de date invalide. Utilisez JJ/MM, JJ-MM ou JJ/MM/AAAA.',
    };
  }

  const day = Number(parts[0]);
  const month = Number(parts[1]);
  const year = parts.length === 3 ? Number(parts[2]) : null;

  if (!Number.isInteger(day) || !Number.isInteger(month)) {
    return { ok: false, error: 'La date contient des nombres invalides.' };
  }
  if (parts.length === 3 && (!Number.isInteger(year) || year < 2000 || year > 2100)) {
    return { ok: false, error: 'Année invalide (attendu entre 2000 et 2100).' };
  }
  if (month < 1 || month > 12) return { ok: false, error: 'Mois invalide (1–12).' };
  if (day < 1 || day > 31) return { ok: false, error: 'Jour invalide.' };

  const value =
    year === null
      ? `${pad2(day)}/${pad2(month)}`
      : `${pad2(day)}/${pad2(month)}/${year}`;

  return { ok: true, value };
}

/**
 * @param {number} y
 * @param {number} m
 * @param {number} d
 */
function calendarStartParis(y, m, d) {
  return DateTime.fromObject(
    { year: y, month: m, day: d },
    { zone: SCRIM_TIMEZONE },
  ).startOf('day');
}

/**
 * Validation /recherche-scrim : format FR, inférence d’année (JJ/MM), fenêtre [aujourd’hui ; +30 j] en Europe/Paris.
 * Sans année : année courante (Paris), puis année suivante si la date est déjà passée ; la date finale doit entrer dans la fenêtre.
 *
 * @param {string} raw
 * @param {{ referenceDateTime?: DateTime }} [options] tests uniquement — « maintenant » simulé (timezone Paris appliquée).
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function parseScrimSearchDate(raw, options = {}) {
  const basic = parseAndNormalizeDate(raw);
  if (!basic.ok) return basic;

  const normalized = basic.value.trim();
  const parts = normalized.split('/').map((p) => p.trim()).filter(Boolean);
  const day = Number(parts[0]);
  const month = Number(parts[1]);
  const explicitYear = parts.length === 3 ? Number(parts[2]) : null;

  const ref = options.referenceDateTime
    ? options.referenceDateTime.setZone(SCRIM_TIMEZONE)
    : DateTime.now().setZone(SCRIM_TIMEZONE);
  const today = ref.startOf('day');
  const maxDay = today.plus({ days: SCRIM_SEARCH_MAX_DAYS_AHEAD });

  if (explicitYear !== null) {
    const dt = calendarStartParis(explicitYear, month, day);
    if (!dt.isValid) {
      return { ok: false, error: 'Date invalide (jour ou mois incorrect).' };
    }
    if (dt < today) {
      return { ok: false, error: ERR_DATE_PAST };
    }
    if (dt > maxDay) {
      return { ok: false, error: ERR_DATE_WINDOW };
    }
    return {
      ok: true,
      value: `${pad2(dt.day)}/${pad2(dt.month)}/${dt.year}`,
    };
  }

  const y0 = today.year;
  const dt0 = calendarStartParis(y0, month, day);
  if (!dt0.isValid) {
    return { ok: false, error: 'Date invalide (jour ou mois incorrect).' };
  }

  /** @type {DateTime} */
  let candidate;
  if (dt0 >= today) {
    candidate = dt0;
  } else {
    const dt1 = calendarStartParis(y0 + 1, month, day);
    if (!dt1.isValid) {
      return { ok: false, error: 'Date invalide (jour ou mois incorrect).' };
    }
    candidate = dt1;
  }

  if (candidate < today) {
    return { ok: false, error: ERR_DATE_PAST };
  }
  if (candidate > maxDay) {
    return { ok: false, error: ERR_DATE_WINDOW };
  }

  return {
    ok: true,
    value: `${pad2(candidate.day)}/${pad2(candidate.month)}/${candidate.year}`,
  };
}

/**
 * Date pour filtres /liste-scrims : même inférence JJ/MM → année (Paris) que la recherche,
 * sans contrainte de fenêtre « 30 jours » (simple jour calendaire pour filtrer).
 *
 * @param {string} raw
 * @param {{ referenceDateTime?: DateTime }} [options]
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function parseListeScrimDateFilter(raw, options = {}) {
  const basic = parseAndNormalizeDate(raw);
  if (!basic.ok) return basic;

  const normalized = basic.value.trim();
  const parts = normalized.split('/').map((p) => p.trim()).filter(Boolean);
  const day = Number(parts[0]);
  const month = Number(parts[1]);
  const explicitYear = parts.length === 3 ? Number(parts[2]) : null;

  const ref = options.referenceDateTime
    ? options.referenceDateTime.setZone(SCRIM_TIMEZONE)
    : DateTime.now().setZone(SCRIM_TIMEZONE);
  const today = ref.startOf('day');

  if (explicitYear !== null) {
    const dt = calendarStartParis(explicitYear, month, day);
    if (!dt.isValid) {
      return { ok: false, error: 'Date invalide (jour ou mois incorrect).' };
    }
    return {
      ok: true,
      value: `${pad2(dt.day)}/${pad2(dt.month)}/${dt.year}`,
    };
  }

  const y0 = today.year;
  const dt0 = calendarStartParis(y0, month, day);
  if (!dt0.isValid) {
    return { ok: false, error: 'Date invalide (jour ou mois incorrect).' };
  }

  /** @type {DateTime} */
  let candidate;
  if (dt0 >= today) {
    candidate = dt0;
  } else {
    const dt1 = calendarStartParis(y0 + 1, month, day);
    if (!dt1.isValid) {
      return { ok: false, error: 'Date invalide (jour ou mois incorrect).' };
    }
    candidate = dt1;
  }

  return {
    ok: true,
    value: `${pad2(candidate.day)}/${pad2(candidate.month)}/${candidate.year}`,
  };
}

/**
 * Normalise une heure vers HH:MM.
 * @param {string} raw
 */
export function parseAndNormalizeTime(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'L’heure doit être une chaîne de caractères.' };
  }
  let s = raw.trim().toLowerCase().replace(/h/gi, ':');
  if (!s) return { ok: false, error: 'L’heure est obligatoire.' };

  const parts = s.split(':').map((p) => p.trim()).filter((p) => p.length > 0);

  if (parts.length === 1) {
    const h = Number(parts[0]);
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      return { ok: false, error: 'Heure invalide (0–23).' };
    }
    return { ok: true, value: `${pad2(h)}:00` };
  }

  if (parts.length === 2) {
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      return { ok: false, error: 'Heures invalides (0–23).' };
    }
    if (!Number.isInteger(m) || m < 0 || m > 59) {
      return { ok: false, error: 'Minutes invalides (0–59).' };
    }
    return { ok: true, value: `${pad2(h)}:${pad2(m)}` };
  }

  return {
    ok: false,
    error: 'Format d’heure invalide. Ex. : 20:30, 20h30, 20h.',
  };
}

/** Écart max entre heure de début et heure max (flexible), en minutes (12 h). */
const SCRIM_FLEXIBLE_TIME_MAX_SPAN_MINUTES = 12 * 60;

/**
 * Heure max optionnelle pour créneau flexible : strictement après `startTimeNormalized` (HH:MM),
 * plage max {@link SCRIM_FLEXIBLE_TIME_MAX_SPAN_MINUTES}.
 *
 * @param {string} startTimeNormalized HH:MM (ex. sortie de {@link parseAndNormalizeTime})
 * @param {string | null | undefined} endRaw saisie brute ou vide
 * @returns {{ ok: true, value: string | null } | { ok: false, error: string }}
 */
export function validateOptionalFlexibleEndTime(startTimeNormalized, endRaw) {
  if (endRaw == null || (typeof endRaw === 'string' && !endRaw.trim())) {
    return { ok: true, value: null };
  }
  const endRes = parseAndNormalizeTime(String(endRaw));
  if (!endRes.ok) return endRes;

  const toMinutes = (/** @type {string} */ hhmm) => {
    const parts = hhmm.split(':').map((p) => Number(p.trim()));
    const h = parts[0];
    const m = parts[1];
    if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
    return h * 60 + m;
  };

  const startMin = toMinutes(startTimeNormalized);
  const endMin = toMinutes(endRes.value);
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin)) {
    return { ok: false, error: 'Heure de début ou heure max invalide.' };
  }
  if (endMin <= startMin) {
    return {
      ok: false,
      error:
        'L’heure max doit être strictement après l’heure de début.',
    };
  }
  if (endMin - startMin > SCRIM_FLEXIBLE_TIME_MAX_SPAN_MINUTES) {
    return {
      ok: false,
      error:
        'L’écart entre l’heure de début et l’heure max ne peut pas dépasser 12 heures.',
    };
  }
  return { ok: true, value: endRes.value };
}

/**
 * @param {string} gameKey
 * @param {string} rank
 */
export function validateRank(gameKey, rank) {
  const game = getGame(gameKey);
  if (!game) return { ok: false, error: 'Jeu inconnu.' };
  if (typeof rank !== 'string' || !rank.trim()) {
    return { ok: false, error: 'Le rang est obligatoire.' };
  }
  const canon = matchFromList(game.ranks, rank);
  if (!canon) {
    return {
      ok: false,
      error:
        'Le rang sélectionné ne correspond pas au jeu choisi. Merci de sélectionner un rang valide pour ce jeu.',
    };
  }
  return { ok: true, value: canon };
}

/**
 * @param {string} gameKey
 * @param {string} format
 */
export function validateFormat(gameKey, format) {
  const game = getGame(gameKey);
  if (!game) return { ok: false, error: 'Jeu inconnu.' };
  if (typeof format !== 'string' || !format.trim()) {
    return { ok: false, error: 'Le format est obligatoire.' };
  }
  const canon = matchFromList(game.formats, format);
  if (!canon) {
    return {
      ok: false,
      error:
        'Le format sélectionné ne correspond pas au jeu choisi. Merci de sélectionner un format valide pour ce jeu.',
    };
  }
  return { ok: true, value: canon };
}

/**
 * @param {import('discord.js').User | null | undefined} user
 */
export function validateContactUser(user) {
  if (!user) {
    return { ok: false, error: 'Contact Discord invalide (utilisateur manquant).' };
  }
  if (user.bot) {
    return { ok: false, error: 'Le contact ne peut pas être un bot.' };
  }
  return { ok: true, userId: user.id };
}
