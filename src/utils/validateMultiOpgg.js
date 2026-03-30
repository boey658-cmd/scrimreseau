/**
 * Validation stricte du champ optionnel « multi OP.GG » (League of Legends uniquement).
 */

import { logger } from './logger.js';

export const LEAGUE_GAME_KEY = 'league_of_legends';

export const MSG_MULTI_OPGG_INVALID =
  'Le lien multi OP.GG est invalide. Merci de fournir une URL HTTPS valide provenant uniquement de op.gg.';

export const MSG_MULTI_OPGG_WRONG_GAME =
  'Le champ multi OP.GG est disponible uniquement pour League of Legends.';

/** Taille max entrée / href normalisé. */
export const MULTI_OPGG_MAX_LEN = 500;

const ALLOWED_HOSTS = new Set(['op.gg', 'www.op.gg']);

/**
 * @param {string} reason
 * @param {Record<string, unknown>} [meta]
 */
function logReject(reason, meta = {}) {
  logger.warn('validateMultiOpggUrl: refus', { reason, ...meta });
}

/**
 * Bloc embed : texte fixe, URL déjà validée (aucun contenu utilisateur dans le label).
 * @param {string} validatedHttpsUrl URL normalisée (`url.href`)
 * @returns {string}
 */
export function buildMultiOpggEmbedFieldValue(validatedHttpsUrl) {
  return `[Ouvrir le multi OP.GG](${validatedHttpsUrl})`;
}

/**
 * @param {string | null | undefined} raw
 * @param {string} gameKey
 * @returns {{ ok: true, value: string | null } | { ok: false, error: string }}
 */
export function validateMultiOpggUrl(raw, gameKey) {
  const isLoL = gameKey === LEAGUE_GAME_KEY;

  const hasNonEmptyString =
    typeof raw === 'string' && raw.trim().length > 0;

  if (!isLoL) {
    if (!hasNonEmptyString) {
      return { ok: true, value: null };
    }
    logReject('wrong_game', { game_key: gameKey });
    return { ok: false, error: MSG_MULTI_OPGG_WRONG_GAME };
  }

  if (raw == null || typeof raw !== 'string') {
    return { ok: true, value: null };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }

  if (trimmed.length > MULTI_OPGG_MAX_LEN) {
    logReject('too_long', { length: trimmed.length });
    return { ok: false, error: MSG_MULTI_OPGG_INVALID };
  }

  if (/\s/.test(trimmed)) {
    logReject('multi_value_or_whitespace');
    return { ok: false, error: MSG_MULTI_OPGG_INVALID };
  }

  if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
    logReject('control_chars');
    return { ok: false, error: MSG_MULTI_OPGG_INVALID };
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    logReject('url_parse_error');
    return { ok: false, error: MSG_MULTI_OPGG_INVALID };
  }

  if (url.protocol !== 'https:') {
    logReject('protocol', { protocol: url.protocol });
    return { ok: false, error: MSG_MULTI_OPGG_INVALID };
  }

  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    logReject('host_not_allowed', { host });
    return { ok: false, error: MSG_MULTI_OPGG_INVALID };
  }

  if (url.username !== '' || url.password !== '') {
    logReject('userinfo_present');
    return { ok: false, error: MSG_MULTI_OPGG_INVALID };
  }

  const port = url.port;
  if (port !== '' && port !== '443') {
    logReject('non_default_port', { port });
    return { ok: false, error: MSG_MULTI_OPGG_INVALID };
  }

  const normalized = url.href;

  if (normalized.length > MULTI_OPGG_MAX_LEN) {
    logReject('href_too_long', { length: normalized.length });
    return { ok: false, error: MSG_MULTI_OPGG_INVALID };
  }

  if (/[\])\\]/.test(normalized)) {
    logReject('unsafe_href_for_embed');
    return { ok: false, error: MSG_MULTI_OPGG_INVALID };
  }

  return { ok: true, value: normalized };
}
