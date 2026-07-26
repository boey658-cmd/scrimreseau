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
 * Crée un résultat d'erreur de validation avec code stable pour i18n.
 * Le champ `error` reste pour la rétrocompatibilité.
 * @param {string} errorCode  Clé i18n stable (ex. 'validation.date.required')
 * @param {string} error      Texte français de fallback
 * @returns {{ ok: false, errorCode: string, error: string }}
 */
function validErr(errorCode, error) {
  return { ok: false, errorCode, error };
}

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
 * @returns {{ ok: true, value: string } | { ok: false, errorCode: string, error: string }}
 */
export function parseAndNormalizeDate(raw) {
  if (typeof raw !== 'string') {
    return validErr('validation.date.not_string', 'La date doit être une chaîne de caractères.');
  }
  const s = raw.trim();
  if (!s) return validErr('validation.date.required', 'La date est obligatoire.');

  const normalized = s.replace(/-/g, '/');
  const parts = normalized.split('/').map((p) => p.trim()).filter(Boolean);

  if (parts.length !== 2 && parts.length !== 3) {
    return validErr(
      'validation.date.invalid_format',
      'Format de date invalide. Utilisez JJ/MM, JJ-MM ou JJ/MM/AAAA.',
    );
  }

  const day = Number(parts[0]);
  const month = Number(parts[1]);
  const year = parts.length === 3 ? Number(parts[2]) : null;

  if (!Number.isInteger(day) || !Number.isInteger(month)) {
    return validErr('validation.date.invalid_numbers', 'La date contient des nombres invalides.');
  }
  if (parts.length === 3 && (!Number.isInteger(year) || year < 2000 || year > 2100)) {
    return validErr('validation.date.invalid_year', 'Année invalide (attendu entre 2000 et 2100).');
  }
  if (month < 1 || month > 12) return validErr('validation.date.invalid_month', 'Mois invalide (1–12).');
  if (day < 1 || day > 31) return validErr('validation.date.invalid_day', 'Jour invalide.');

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
 * Validation /recherche-scrim : format FR, inférence d'année (JJ/MM), fenêtre [aujourd'hui ; +30 j] en Europe/Paris.
 *
 * @param {string} raw
 * @param {{ referenceDateTime?: DateTime }} [options]
 * @returns {{ ok: true, value: string } | { ok: false, errorCode: string, error: string }}
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
      return validErr('validation.date.invalid_calendar', 'Date invalide (jour ou mois incorrect).');
    }
    if (dt < today) {
      return validErr('validation.date.past', ERR_DATE_PAST);
    }
    if (dt > maxDay) {
      return validErr('validation.date.window', ERR_DATE_WINDOW);
    }
    return {
      ok: true,
      value: `${pad2(dt.day)}/${pad2(dt.month)}/${dt.year}`,
    };
  }

  const y0 = today.year;
  const dt0 = calendarStartParis(y0, month, day);
  if (!dt0.isValid) {
    return validErr('validation.date.invalid_calendar', 'Date invalide (jour ou mois incorrect).');
  }

  /** @type {DateTime} */
  let candidate;
  if (dt0 >= today) {
    candidate = dt0;
  } else {
    const dt1 = calendarStartParis(y0 + 1, month, day);
    if (!dt1.isValid) {
      return validErr('validation.date.invalid_calendar', 'Date invalide (jour ou mois incorrect).');
    }
    candidate = dt1;
  }

  if (candidate < today) {
    return validErr('validation.date.past', ERR_DATE_PAST);
  }
  if (candidate > maxDay) {
    return validErr('validation.date.window', ERR_DATE_WINDOW);
  }

  return {
    ok: true,
    value: `${pad2(candidate.day)}/${pad2(candidate.month)}/${candidate.year}`,
  };
}

/**
 * Date pour filtres /liste-scrims : même inférence JJ/MM → année (Paris), sans contrainte de fenêtre.
 *
 * @param {string} raw
 * @param {{ referenceDateTime?: DateTime }} [options]
 * @returns {{ ok: true, value: string } | { ok: false, errorCode: string, error: string }}
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
      return validErr('validation.date.invalid_calendar', 'Date invalide (jour ou mois incorrect).');
    }
    return {
      ok: true,
      value: `${pad2(dt.day)}/${pad2(dt.month)}/${dt.year}`,
    };
  }

  const y0 = today.year;
  const dt0 = calendarStartParis(y0, month, day);
  if (!dt0.isValid) {
    return validErr('validation.date.invalid_calendar', 'Date invalide (jour ou mois incorrect).');
  }

  /** @type {DateTime} */
  let candidate;
  if (dt0 >= today) {
    candidate = dt0;
  } else {
    const dt1 = calendarStartParis(y0 + 1, month, day);
    if (!dt1.isValid) {
      return validErr('validation.date.invalid_calendar', 'Date invalide (jour ou mois incorrect).');
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
 * @returns {{ ok: true, value: string } | { ok: false, errorCode: string, error: string }}
 */
export function parseAndNormalizeTime(raw) {
  if (typeof raw !== 'string') {
    return validErr('validation.time.not_string', 'L\u2019heure doit \u00eatre une cha\u00eene de caract\u00e8res.');
  }
  let s = raw.trim().toLowerCase().replace(/h/gi, ':');
  if (!s) return validErr('validation.time.required', 'L\u2019heure est obligatoire.');

  const parts = s.split(':').map((p) => p.trim()).filter((p) => p.length > 0);

  if (parts.length === 1) {
    const h = Number(parts[0]);
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      return validErr('validation.time.invalid_hour', 'Heure invalide (0\u201323).');
    }
    return { ok: true, value: `${pad2(h)}:00` };
  }

  if (parts.length === 2) {
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      return validErr('validation.time.invalid_hours', 'Heures invalides (0\u201323).');
    }
    if (!Number.isInteger(m) || m < 0 || m > 59) {
      return validErr('validation.time.invalid_minutes', 'Minutes invalides (0\u201359).');
    }
    return { ok: true, value: `${pad2(h)}:${pad2(m)}` };
  }

  return validErr(
    'validation.time.invalid_format',
    'Format d\u2019heure invalide. Ex.\u00a0: 20:30, 20h30, 20h.',
  );
}

/** Écart max entre heure de début et heure max (flexible), en minutes (12 h). */
const SCRIM_FLEXIBLE_TIME_MAX_SPAN_MINUTES = 12 * 60;

/**
 * Heure max optionnelle pour créneau flexible.
 *
 * @param {string} startTimeNormalized HH:MM
 * @param {string | null | undefined} endRaw
 * @returns {{ ok: true, value: string | null } | { ok: false, errorCode: string, error: string }}
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
    return validErr('validation.time.flex_parse_error', 'Heure de d\u00e9but ou heure max invalide.');
  }
  if (endMin <= startMin) {
    return validErr(
      'validation.time.flex_before_start',
      'L\u2019heure max doit \u00eatre strictement apr\u00e8s l\u2019heure de d\u00e9but.',
    );
  }
  if (endMin - startMin > SCRIM_FLEXIBLE_TIME_MAX_SPAN_MINUTES) {
    return validErr(
      'validation.time.flex_max_span',
      'L\u2019\u00e9cart entre l\u2019heure de d\u00e9but et l\u2019heure max ne peut pas d\u00e9passer 12 heures.',
    );
  }
  return { ok: true, value: endRes.value };
}

/**
 * @param {string} gameKey
 * @param {string} rank
 * @returns {{ ok: true, value: string } | { ok: false, errorCode: string, error: string }}
 */
export function validateRank(gameKey, rank) {
  const game = getGame(gameKey);
  if (!game) return validErr('validation.rank.unknown_game', 'Jeu inconnu.');
  if (typeof rank !== 'string' || !rank.trim()) {
    return validErr('validation.rank.required', 'Le rang est obligatoire.');
  }
  const canon = matchFromList(game.ranks, rank);
  if (!canon) {
    return validErr(
      'validation.rank.invalid',
      'Le rang s\u00e9lectionn\u00e9 ne correspond pas au jeu choisi. Merci de s\u00e9lectionner un rang valide pour ce jeu.',
    );
  }
  return { ok: true, value: canon };
}

/**
 * @param {string} gameKey
 * @param {string} format
 * @returns {{ ok: true, value: string } | { ok: false, errorCode: string, error: string }}
 */
export function validateFormat(gameKey, format) {
  const game = getGame(gameKey);
  if (!game) return validErr('validation.format.unknown_game', 'Jeu inconnu.');
  if (typeof format !== 'string' || !format.trim()) {
    return validErr('validation.format.required', 'Le format est obligatoire.');
  }
  const canon = matchFromList(game.formats, format);
  if (!canon) {
    return validErr(
      'validation.format.invalid',
      'Le format s\u00e9lectionn\u00e9 ne correspond pas au jeu choisi. Merci de s\u00e9lectionner un format valide pour ce jeu.',
    );
  }
  return { ok: true, value: canon };
}

/**
 * @param {import('discord.js').User | null | undefined} user
 * @returns {{ ok: true, userId: string } | { ok: false, errorCode: string, error: string }}
 */
export function validateContactUser(user) {
  if (!user) {
    return validErr('validation.contact.missing', 'Contact Discord invalide (utilisateur manquant).');
  }
  if (user.bot) {
    return validErr('validation.contact.bot', 'Le contact ne peut pas \u00eatre un bot.');
  }
  return { ok: true, userId: user.id };
}

/**
 * Valide et normalise un lien d'invitation Discord.
 *
 * @param {string | null | undefined} raw
 * @returns {{ ok: true, value: string } | { ok: false, errorCode: string, error: string }}
 */
export function validateDiscordInviteUrl(raw) {
  const errFr = 'Merci d\u2019indiquer un lien d\u2019invitation Discord valide (ex. https://discord.gg/xxxx).';
  const fail = () => validErr('validation.discordUrl.invalid', errFr);

  if (typeof raw !== 'string' || !raw.trim()) {
    return fail();
  }

  let input = raw.trim();

  // Normalisation discord.gg/code sans schéma
  if (/^discord\.gg\//i.test(input)) {
    input = `https://${input}`;
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return fail();
  }

  // Schéma obligatoirement https
  if (parsed.protocol !== 'https:') {
    return fail();
  }

  const host = parsed.hostname.toLowerCase();
  let code = null;

  if (host === 'discord.gg') {
    const match = parsed.pathname.match(/^\/(?:invite\/)?([A-Za-z0-9_-]+)\/?$/);
    if (match) code = match[1];
  } else if (host === 'discord.com' || host === 'discordapp.com') {
    const match = parsed.pathname.match(/^\/invite\/([A-Za-z0-9_-]+)\/?$/);
    if (match) code = match[1];
  }

  if (!code || code.length < 2) {
    return fail();
  }

  return { ok: true, value: `https://discord.gg/${code}` };
}
