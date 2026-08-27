import { fr } from '../i18n/fr.js';
import { t } from '../i18n/index.js';

/** Identifiant développeur Discord attendu dans BOT_DEV_ID (snowflake numérique). */
const BOT_DEV_SNOWFLAKE_RE = /^\d{17,22}$/;

/** @deprecated Prefer t(locale, 'dev.unconfigured') */
export const MSG_BOT_DEV_UNCONFIGURED = fr['dev.unconfigured'];

/** @deprecated Prefer t(locale, 'dev.forbidden') */
export const MSG_BOT_DEV_FORBIDDEN = fr['dev.forbidden'];

/**
 * @param {string} [locale]
 * @returns {string}
 */
export function botDevUnconfiguredMessage(locale = 'fr') {
  return t(locale, 'dev.unconfigured');
}

/**
 * @param {string} [locale]
 * @returns {string}
 */
export function botDevForbiddenMessage(locale = 'fr') {
  return t(locale, 'dev.forbidden');
}

/**
 * @returns {{ ok: true, devId: string } | { ok: false, reason: 'missing' | 'invalid' }}
 */
export function resolveBotDevId() {
  const raw = process.env.BOT_DEV_ID;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    return { ok: false, reason: 'missing' };
  }
  if (!BOT_DEV_SNOWFLAKE_RE.test(trimmed)) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, devId: trimmed };
}
