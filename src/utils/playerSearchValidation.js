import { DateTime } from 'luxon';
import { SCRIM_TIMEZONE } from './scrimScheduledAt.js';
import {
  parseAndNormalizeDate,
  parseAndNormalizeTime,
  validateOptionalFlexibleEndTime,
} from './validation.js';

/** Fenêtre calendaire Recherche Joueur : aujourd'hui (Paris) → +45 j inclus. */
const PLAYER_SEARCH_MAX_DAYS_AHEAD = 45;

export const MSG_PLAYER_SEARCH_DATE_WINDOW =
  'La date doit être aujourd\'hui ou dans les 45 prochains jours.';

const MSG_PLAYER_SEARCH_DATE_PAST =
  'La date choisie ne peut pas être antérieure à aujourd\'hui.';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * @param {DateTime} dt
 * @returns {string} DD/MM/YYYY (Paris)
 */
function formatPlayerSearchDateForDb(dt) {
  return `${pad2(dt.day)}/${pad2(dt.month)}/${dt.year}`;
}

/**
 * @param {string} raw
 * @returns {string}
 */
function normalizePlayerSearchDateKeyword(raw) {
  return raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/['']/g, '');
}

/**
 * @param {string} dbDate DD/MM ou DD/MM/YYYY
 * @returns {DateTime | null}
 */
export function parsePlayerSearchDbDateToParisDateTime(dbDate) {
  const normalized = String(dbDate ?? '')
    .trim()
    .replace(/-/g, '/');
  if (!normalized) return null;
  const parts = normalized.split('/').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const day = Number(parts[0]);
  const month = Number(parts[1]);
  const year =
    parts.length >= 3
      ? Number(parts[2])
      : DateTime.now().setZone(SCRIM_TIMEZONE).year;
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) {
    return null;
  }
  const dt = DateTime.fromObject(
    { year, month, day },
    { zone: SCRIM_TIMEZONE },
  ).startOf('day');
  return dt.isValid ? dt : null;
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
 * Validation date numérique Recherche Joueur (fenêtre 45 j, Paris).
 *
 * @param {string} raw
 * @param {{ referenceDateTime?: import('luxon').DateTime }} [options]
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
function parsePlayerSearchCalendarDate(raw, options = {}) {
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
  const maxDay = today.plus({ days: PLAYER_SEARCH_MAX_DAYS_AHEAD });

  if (explicitYear !== null) {
    const dt = calendarStartParis(explicitYear, month, day);
    if (!dt.isValid) {
      return { ok: false, error: 'Date invalide (jour ou mois incorrect).' };
    }
    if (dt < today) {
      return { ok: false, error: MSG_PLAYER_SEARCH_DATE_PAST };
    }
    if (dt > maxDay) {
      return { ok: false, error: MSG_PLAYER_SEARCH_DATE_WINDOW };
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

  /** @type {import('luxon').DateTime} */
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
    return { ok: false, error: MSG_PLAYER_SEARCH_DATE_PAST };
  }
  if (candidate > maxDay) {
    return { ok: false, error: MSG_PLAYER_SEARCH_DATE_WINDOW };
  }

  return {
    ok: true,
    value: `${pad2(candidate.day)}/${pad2(candidate.month)}/${candidate.year}`,
  };
}

/**
 * Parse la date slash Recherche Joueur (Paris, fenêtre 45 jours).
 * Formats : aujourd'hui, aujourdhui, demain, JJ/MM, JJ/MM/AAAA, JJ-MM, JJ-MM-AAAA.
 *
 * @param {string} raw
 * @param {{ referenceDateTime?: import('luxon').DateTime }} [options]
 * @returns {{
 *   ok: true,
 *   value: string,
 *   dateTime: import('luxon').DateTime,
 * } | { ok: false, error: string }}
 */
export function parsePlayerSearchDate(raw, options = {}) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'La date est obligatoire.' };
  }

  const ref = options.referenceDateTime
    ? options.referenceDateTime.setZone(SCRIM_TIMEZONE)
    : DateTime.now().setZone(SCRIM_TIMEZONE);
  const today = ref.startOf('day');
  const maxDay = today.plus({ days: PLAYER_SEARCH_MAX_DAYS_AHEAD });

  const keyword = normalizePlayerSearchDateKeyword(raw);
  if (keyword === 'aujourdhui') {
    return {
      ok: true,
      value: formatPlayerSearchDateForDb(today),
      dateTime: today,
    };
  }
  if (keyword === 'demain') {
    const tomorrow = today.plus({ days: 1 });
    if (tomorrow > maxDay) {
      return { ok: false, error: MSG_PLAYER_SEARCH_DATE_WINDOW };
    }
    return {
      ok: true,
      value: formatPlayerSearchDateForDb(tomorrow),
      dateTime: tomorrow,
    };
  }

  const parsed = parsePlayerSearchCalendarDate(raw, options);
  if (!parsed.ok) return parsed;

  const dt = parsePlayerSearchDbDateToParisDateTime(parsed.value);
  if (!dt) {
    return { ok: false, error: 'Date invalide (jour ou mois incorrect).' };
  }

  return { ok: true, value: parsed.value, dateTime: dt };
}

/**
 * @param {import('luxon').DateTime} dateTime jour cible (Paris)
 * @param {{ referenceDateTime?: import('luxon').DateTime }} [options]
 * @returns {string} aujourd'hui | demain | le jeudi 04/07
 */
export function formatPlayerSearchDatePhrase(dateTime, options = {}) {
  const ref = options.referenceDateTime
    ? options.referenceDateTime.setZone(SCRIM_TIMEZONE)
    : DateTime.now().setZone(SCRIM_TIMEZONE);
  const today = ref.startOf('day');
  const target = dateTime.setZone(SCRIM_TIMEZONE).startOf('day');

  if (target.hasSame(today, 'day')) {
    return "aujourd'hui";
  }
  if (target.hasSame(today.plus({ days: 1 }), 'day')) {
    return 'demain';
  }

  const weekday = target.setLocale('fr').toFormat('cccc');
  return `le ${weekday} ${pad2(target.day)}/${pad2(target.month)}`;
}

/**
 * Date compacte pour listes (/mes-demandes-joueur) : sans « le » devant le jour.
 *
 * @param {import('luxon').DateTime} dateTime
 * @param {{ referenceDateTime?: import('luxon').DateTime }} [options]
 * @returns {string}
 */
export function formatPlayerSearchListDatePhrase(dateTime, options = {}) {
  const phrase = formatPlayerSearchDatePhrase(dateTime, options);
  return phrase.startsWith('le ') ? phrase.slice(3) : phrase;
}

/**
 * @param {string | null | undefined} json
 * @returns {string[]}
 */
function parseJsonStringArray(json) {
  if (typeof json !== 'string' || !json.trim()) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v) => typeof v === 'string')
      .map((v) => v.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Ligne résumé pour /mes-demandes-joueur.
 *
 * @param {{
 *   player_search_public_id: string,
 *   roles_json: string,
 *   ranks_json: string,
 *   scheduled_date: string,
 *   scheduled_time: string,
 *   session_type: string,
 * }} row
 * @param {{ referenceDateTime?: import('luxon').DateTime }} [options]
 * @returns {string}
 */
export function formatPlayerSearchActiveSummaryLine(row, options = {}) {
  const roles = parseJsonStringArray(row.roles_json);
  const ranks = parseJsonStringArray(row.ranks_json);
  const rolesStr = formatPlayerSearchRolesSlashList(roles);
  const rankStr = ranks.length > 0 ? ranks[0] : '—';
  const dt = parsePlayerSearchDbDateToParisDateTime(row.scheduled_date);
  const dateStr = dt
    ? formatPlayerSearchListDatePhrase(dt, options)
    : String(row.scheduled_date ?? '').trim() || '—';
  const timeStr = String(row.scheduled_time ?? '').trim() || '—';
  const session = String(row.session_type ?? '').trim() || '—';
  const id = String(row.player_search_public_id ?? '').trim() || '—';
  return `${id} — ${rolesStr} — ${rankStr} — ${dateStr} ${timeStr} — ${session}`;
}

/**
 * @param {string} sessionType
 * @returns {string} ex. un scrim BO3, une flex, quelques games
 */
export function formatPlayerSearchSessionPhrase(sessionType) {
  const key = String(sessionType ?? '').trim();
  /** @type {Record<string, string>} */
  const phrases = {
    'Scrim BO1': 'un scrim BO1',
    'Scrim BO3': 'un scrim BO3',
    'Scrim BO5': 'un scrim BO5',
    'Quelques games': 'quelques games',
    Flex: 'une flex',
    Clash: 'un clash',
    Tournoi: 'un tournoi',
  };
  if (phrases[key]) return phrases[key];
  return key.toLowerCase() || 'une session';
}

/** @type {readonly string[]} */
export const PLAYER_SEARCH_ALLOWED_ROLES = Object.freeze([
  'top',
  'jungle',
  'mid',
  'adc',
  'support',
]);

/** @type {Record<string, string>} */
export const PLAYER_SEARCH_ROLE_LABELS = Object.freeze({
  top: 'Top',
  jungle: 'Jungle',
  mid: 'Mid',
  adc: 'ADC',
  support: 'Support',
});

/** @type {Record<string, string>} */
const ROLE_ALIASES = Object.freeze({
  top: 'top',
  jungle: 'jungle',
  jungleur: 'jungle',
  jgl: 'jungle',
  mid: 'mid',
  midlane: 'mid',
  adc: 'adc',
  adcarry: 'adc',
  bot: 'adc',
  support: 'support',
  supp: 'support',
  sup: 'support',
});

/** @type {readonly { key: string, label: string }[]} */
export const PLAYER_SEARCH_RANK_ENTRIES = Object.freeze([
  { key: 'iron', label: 'Iron' },
  { key: 'iron_bronze', label: 'Iron / Bronze' },
  { key: 'bronze', label: 'Bronze' },
  { key: 'bronze_silver', label: 'Bronze / Silver' },
  { key: 'silver', label: 'Silver' },
  { key: 'silver_gold', label: 'Silver / Gold' },
  { key: 'gold', label: 'Gold' },
  { key: 'gold_plat', label: 'Gold / Plat' },
  { key: 'plat', label: 'Plat' },
  { key: 'plat_emerald', label: 'Plat / Emerald' },
  { key: 'emerald', label: 'Emerald' },
  { key: 'emerald_diamond', label: 'Emerald / Diamond' },
  { key: 'diamond', label: 'Diamond' },
  { key: 'diamond_master', label: 'Diamond / Master' },
  { key: 'master_plus', label: 'Master+' },
]);

/** @type {readonly string[]} */
export const PLAYER_SEARCH_RANK_VALUES = Object.freeze(
  PLAYER_SEARCH_RANK_ENTRIES.map((e) => e.key),
);

/** @type {Record<string, string>} */
export const PLAYER_SEARCH_RANK_LABELS = Object.freeze(
  Object.fromEntries(PLAYER_SEARCH_RANK_ENTRIES.map((e) => [e.key, e.label])),
);

/** Choix slash Discord pour les rôles. */
export const PLAYER_SEARCH_ROLE_SLASH_CHOICES = Object.freeze(
  PLAYER_SEARCH_ALLOWED_ROLES.map((value) => ({
    name: PLAYER_SEARCH_ROLE_LABELS[value],
    value,
  })),
);

/** Choix slash Discord pour le rang unique. */
export const PLAYER_SEARCH_RANK_SLASH_CHOICES = Object.freeze(
  PLAYER_SEARCH_RANK_ENTRIES.map(({ key, label }) => ({
    name: label,
    value: key,
  })),
);

/** Choix slash Discord pour le nombre de joueurs. */
export const PLAYER_SEARCH_NOMBRE_SLASH_CHOICES = Object.freeze(
  [1, 2, 3, 4, 5].map((n) => ({
    name: String(n),
    value: n,
  })),
);

export const MSG_PLAYER_SEARCH_ROLE_COUNT_MISMATCH =
  'Le nombre de joueurs doit correspondre au nombre de rôles sélectionnés.';

/**
 * @param {string} rankKey
 * @returns {string}
 */
export function formatPlayerSearchRankLabel(rankKey) {
  const key = rankKey.trim().toLowerCase();
  return PLAYER_SEARCH_RANK_LABELS[key] ?? rankKey.trim();
}

/**
 * @param {string | null | undefined} raw valeur slash `rang`
 * @returns {{ ok: true, label: string, value: string[] } | { ok: false, error: string }}
 */
export function resolvePlayerSearchRankFromSlashValue(raw) {
  if (raw == null || !String(raw).trim()) {
    return { ok: false, error: 'Le rang est obligatoire.' };
  }
  const key = String(raw).trim().toLowerCase();
  if (!PLAYER_SEARCH_RANK_VALUES.includes(key)) {
    return { ok: false, error: `Rang invalide : « ${raw} ».` };
  }
  const label = formatPlayerSearchRankLabel(key);
  return { ok: true, label, value: [label] };
}

/**
 * @param {string[]} ranks labels stockés en DB (rang unique → 1 élément)
 * @returns {string}
 */
export function formatPlayerSearchRankForEmbed(ranks) {
  if (!Array.isArray(ranks) || ranks.length === 0) return '—';
  return ranks[0];
}

/**
 * @param {(string | null | undefined)[]} rawValues valeurs slash role_1…role_5
 * @returns {{ ok: true, value: string[], labels: string[] } | { ok: false, error: string }}
 */
export function collectPlayerSearchRolesFromSlashValues(rawValues) {
  /** @type {string[]} */
  const roles = [];
  for (const raw of rawValues) {
    if (raw == null || !String(raw).trim()) continue;
    const key = String(raw).trim().toLowerCase();
    if (!PLAYER_SEARCH_ALLOWED_ROLES.includes(key)) {
      return {
        ok: false,
        error: `Rôle invalide : « ${raw} ».`,
      };
    }
    if (!roles.includes(key)) roles.push(key);
  }
  if (roles.length === 0) {
    return { ok: false, error: 'Indique au moins un rôle recherché (role_1).' };
  }
  return {
    ok: true,
    value: roles,
    labels: roles.map(formatPlayerSearchRoleLabel),
  };
}

/**
 * @param {number} playerCount
 * @param {number} roleCount
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validatePlayerSearchRoleCountMatch(playerCount, roleCount) {
  if (playerCount !== roleCount) {
    return { ok: false, error: MSG_PLAYER_SEARCH_ROLE_COUNT_MISMATCH };
  }
  return { ok: true };
}

/**
 * @param {string[]} roles clés rôle
 * @returns {string} ex. ADC / Support
 */
export function formatPlayerSearchRolesSlashList(roles) {
  return roles.map(formatPlayerSearchRoleLabel).join(' / ');
}

/**
 * @param {string} roleKey
 * @returns {string}
 */
export function formatPlayerSearchRoleLabel(roleKey) {
  const key = roleKey.trim().toLowerCase();
  return PLAYER_SEARCH_ROLE_LABELS[key] ?? roleKey.trim();
}

/**
 * @param {string[]} items
 * @returns {string}
 */
export function formatPlayerSearchNaturalList(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} et ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} et ${items[items.length - 1]}`;
}

/**
 * @param {string} normalized HH:MM
 * @returns {string}
 */
function compactTimeFromNormalized(normalized) {
  const [hRaw, mRaw] = normalized.split(':');
  const h = Number(hRaw);
  const m = Number(mRaw);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return normalized;
  if (m === 0) return `${h}h`;
  return `${h}h${String(m).padStart(2, '0')}`;
}

/**
 * @param {string} raw
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
function resolveRoleToken(raw) {
  const key = raw.trim().toLowerCase();
  if (!key) return { ok: false, error: 'Rôle vide.' };
  if (ROLE_ALIASES[key]) {
    return { ok: true, value: ROLE_ALIASES[key] };
  }
  for (const role of PLAYER_SEARCH_ALLOWED_ROLES) {
    if (PLAYER_SEARCH_ROLE_LABELS[role].toLowerCase() === key) {
      return { ok: true, value: role };
    }
  }
  return {
    ok: false,
    error: `Rôle inconnu : « ${raw.trim()} ». Rôles autorisés : Top, Jungle, Mid, ADC, Support.`,
  };
}

/**
 * @param {string} raw ex. adc, support, adc/support, ADC Support
 * @returns {{ ok: true, value: string[], labels: string[] } | { ok: false, error: string }}
 */
export function parsePlayerSearchRoles(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'Les rôles sont obligatoires.' };
  }

  const tokens = raw
    .split(/[/,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return { ok: false, error: 'Indique au moins un rôle recherché.' };
  }

  /** @type {string[]} */
  const roles = [];
  for (const token of tokens) {
    const resolved = resolveRoleToken(token);
    if (!resolved.ok) return resolved;
    if (!roles.includes(resolved.value)) {
      roles.push(resolved.value);
    }
  }

  return {
    ok: true,
    value: roles,
    labels: roles.map(formatPlayerSearchRoleLabel),
  };
}

/**
 * @param {string} raw ex. 21h, 21h00, 21h-23h
 * @returns {{
 *   ok: true,
 *   displayTime: string,
 *   startNormalized: string,
 *   endNormalized: string | null,
 * } | { ok: false, error: string }}
 */
export function parsePlayerSearchHoraire(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'L’horaire est obligatoire.' };
  }

  const trimmed = raw.trim();

  if (trimmed.includes('-')) {
    const dashIdx = trimmed.indexOf('-');
    const startRaw = trimmed.slice(0, dashIdx).trim();
    const endRaw = trimmed.slice(dashIdx + 1).trim();
    if (!startRaw || !endRaw) {
      return {
        ok: false,
        error: 'Format d’horaire flexible invalide. Ex. : 21h-23h.',
      };
    }
    const startRes = parseAndNormalizeTime(startRaw);
    if (!startRes.ok) return startRes;
    const flexRes = validateOptionalFlexibleEndTime(startRes.value, endRaw);
    if (!flexRes.ok) return flexRes;
    const displayTime = `${compactTimeFromNormalized(startRes.value)}-${compactTimeFromNormalized(flexRes.value ?? endRaw)}`;
    return {
      ok: true,
      displayTime,
      startNormalized: startRes.value,
      endNormalized: flexRes.value,
    };
  }

  const startRes = parseAndNormalizeTime(trimmed);
  if (!startRes.ok) return startRes;
  return {
    ok: true,
    displayTime: compactTimeFromNormalized(startRes.value),
    startNormalized: startRes.value,
    endNormalized: null,
  };
}

/**
 * Phrase principale de l’embed (test unitaire).
 * @param {{
 *   roles: string[],
 *   ranks: string[],
 *   playerCount: number,
 *   sessionType: string,
 *   datePhrase: string,
 *   timePhrase: string,
 *   pastTense?: boolean,
 * }} args
 * @returns {string}
 */
export function buildPlayerSearchMainPhrase(args) {
  const rolesInline = formatPlayerSearchRolesSlashList(args.roles);
  const rankLabel =
    args.rankLabel ??
    (Array.isArray(args.ranks) && args.ranks.length > 0 ? args.ranks[0] : '—');
  const playerWord = args.playerCount > 1 ? 'joueurs' : 'joueur';
  const verb = args.pastTense ? 'cherchions' : 'cherchons';
  const sessionPhrase = formatPlayerSearchSessionPhrase(args.sessionType);
  return (
    `Nous ${verb} ${args.playerCount} ${playerWord} ${rolesInline} ` +
    `de niveau ${rankLabel} pour ${sessionPhrase} ${args.datePhrase} à ${args.timePhrase}.`
  );
}
