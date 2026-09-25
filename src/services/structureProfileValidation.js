/**
 * Profil structure Premium (Phase 5) — validation URLs / champs user-controlled.
 * Pas de HTML, HTTPS only, providers whitelist.
 */

import { ConfigWriteError } from './configWriteError.js';

export const STRUCTURE_PROFILE_DISPLAY_NAME_MAX = 80;
export const STRUCTURE_PROFILE_DESCRIPTION_MAX = 400;
export const STRUCTURE_PROFILE_URL_MAX = 512;
export const STRUCTURE_PROFILE_LANGUAGES_MAX = 8;
export const STRUCTURE_PROFILE_SOCIALS_MAX = 6;

/** @type {readonly string[]} */
export const STRUCTURE_PROFILE_SOCIAL_PROVIDERS = Object.freeze([
  'discord',
  'x',
  'twitch',
  'youtube',
  'instagram',
  'tiktok',
]);

/** @type {ReadonlySet<string>} */
const SOCIAL_PROVIDER_SET = new Set(STRUCTURE_PROFILE_SOCIAL_PROVIDERS);

/** Langues annuaire (alignées locales bot / site). */
export const STRUCTURE_PROFILE_LANGUAGE_CODES = Object.freeze([
  'fr',
  'en',
  'es',
  'de',
  'it',
  'pl',
  'pt',
]);

const LANGUAGE_SET = new Set(STRUCTURE_PROFILE_LANGUAGE_CODES);

const COUNTRY_CODE_RE = /^[A-Z]{2}$/;

/** Hosts bloqués (SSRF prep / abus). */
const BLOCKED_HOST_RE =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)$/i;

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeOptionalText(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'texte invalide');
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * @param {string} url
 * @returns {URL}
 */
function parseHttpsUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'URL invalide');
  }
  if (parsed.protocol !== 'https:') {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'URL HTTPS requise');
  }
  if (BLOCKED_HOST_RE.test(parsed.hostname)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'hôte URL interdit');
  }
  if (parsed.username || parsed.password) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'URL invalide');
  }
  return parsed;
}

/**
 * @param {unknown} raw
 * @param {string} field
 * @returns {string | null}
 */
export function validateOptionalHttpsUrl(raw, field = 'url') {
  const text = normalizeOptionalText(raw);
  if (text == null) return null;
  if (text.length > STRUCTURE_PROFILE_URL_MAX) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', `${field} trop long`);
  }
  const lower = text.toLowerCase();
  if (
    lower.startsWith('javascript:')
    || lower.startsWith('data:')
    || lower.startsWith('file:')
    || lower.startsWith('ftp:')
  ) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', `${field} schéma interdit`);
  }
  parseHttpsUrl(text);
  return text;
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
export function validateDisplayName(raw) {
  const text = normalizeOptionalText(raw);
  if (text == null) return null;
  if (text.length > STRUCTURE_PROFILE_DISPLAY_NAME_MAX) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'display_name trop long');
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'display_name caractères interdits');
  }
  return text;
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
export function validateDescription(raw) {
  const text = normalizeOptionalText(raw);
  if (text == null) return null;
  if (text.length > STRUCTURE_PROFILE_DESCRIPTION_MAX) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'description trop longue');
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'description caractères interdits');
  }
  return text;
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
export function validateCountryCode(raw) {
  const text = normalizeOptionalText(raw);
  if (text == null) return null;
  const upper = text.toUpperCase();
  if (!COUNTRY_CODE_RE.test(upper)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'country_code invalide');
  }
  return upper;
}

/**
 * @param {unknown} raw
 * @returns {string[] | null}
 */
export function validateLanguages(raw) {
  if (raw == null) return null;
  if (!Array.isArray(raw)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'languages doit être un tableau');
  }
  if (raw.length === 0) return null;
  if (raw.length > STRUCTURE_PROFILE_LANGUAGES_MAX) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'trop de languages');
  }
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'language invalide');
    }
    const code = item.trim().toLowerCase();
    if (!LANGUAGE_SET.has(code)) {
      throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'language non supportée');
    }
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out.length > 0 ? out : null;
}

/**
 * @param {unknown} raw
 * @returns {Array<{ provider: string, url: string }> | null}
 */
export function validateSocials(raw) {
  if (raw == null) return null;
  if (!Array.isArray(raw)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'socials doit être un tableau');
  }
  if (raw.length === 0) return null;
  if (raw.length > STRUCTURE_PROFILE_SOCIALS_MAX) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'trop de socials');
  }
  /** @type {Array<{ provider: string, url: string }>} */
  const out = [];
  const seenProviders = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'social invalide');
    }
    const keys = Object.keys(item);
    for (const k of keys) {
      if (k !== 'provider' && k !== 'url') {
        throw new ConfigWriteError(400, 'VALIDATION_ERROR', `champ social interdit: ${k}`);
      }
    }
    const providerRaw = /** @type {{ provider?: unknown, url?: unknown }} */ (item).provider;
    const urlRaw = /** @type {{ provider?: unknown, url?: unknown }} */ (item).url;
    if (typeof providerRaw !== 'string') {
      throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'provider social invalide');
    }
    const provider = providerRaw.trim().toLowerCase();
    if (!SOCIAL_PROVIDER_SET.has(provider)) {
      throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'provider social non autorisé');
    }
    if (seenProviders.has(provider)) {
      throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'provider social en doublon');
    }
    const url = validateOptionalHttpsUrl(urlRaw, 'social.url');
    if (!url) {
      throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'social.url requis');
    }
    seenProviders.add(provider);
    out.push({ provider, url });
  }
  return out.length > 0 ? out : null;
}

/**
 * Parse body PATCH structure_profile (whitelist).
 * @param {Record<string, unknown>} body
 */
export function parseStructureProfilePatchBody(body) {
  const allowed = new Set([
    'display_name',
    'description',
    'logo_url',
    'website_url',
    'country_code',
    'languages',
    'socials',
    'reset',
  ]);
  for (const key of Object.keys(body)) {
    if (
      key === 'section'
      || key === 'actor_discord_user_id'
      || key === 'request_id'
      || key === 'source'
    ) {
      continue;
    }
    if (!allowed.has(key)) {
      throw new ConfigWriteError(400, 'VALIDATION_ERROR', `champ interdit: ${key}`);
    }
  }

  if (body.reset === true) {
    return { reset: true };
  }
  if (body.reset != null && body.reset !== false) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'reset invalide');
  }

  return {
    reset: false,
    display_name: validateDisplayName(body.display_name),
    description: validateDescription(body.description),
    logo_url: validateOptionalHttpsUrl(body.logo_url, 'logo_url'),
    website_url: validateOptionalHttpsUrl(body.website_url, 'website_url'),
    country_code: validateCountryCode(body.country_code),
    languages: validateLanguages(body.languages),
    socials: validateSocials(body.socials),
  };
}
