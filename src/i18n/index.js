/**
 * Infrastructure de traduction ScrimRéseau.
 *
 * Règles :
 *  - Français = langue source et fallback.
 *  - Clé absente en anglais → texte français.
 *  - Clé absente en français → jamais vide (retourne la clé entre crochets).
 *  - Aucune condition `if (language === 'en')` dispersée dans les handlers.
 *  - Interpolation simple {variable} — sécurisée, pas d'exécution de code.
 *  - Snowflake Discord jamais convertis en Number.
 */

import { fr } from './fr.js';
import { en } from './en.js';

/** Locales supportées. @type {readonly ['fr', 'en']} */
const SUPPORTED_LOCALES = Object.freeze(['fr', 'en']);

/** @typedef {'fr' | 'en'} Locale */

/**
 * Normalise une valeur brute vers 'fr' | 'en'.
 * Toute valeur inconnue ou absente → 'fr'.
 * @param {unknown} raw
 * @returns {Locale}
 */
export function normalizeLocale(raw) {
  if (typeof raw === 'string' && SUPPORTED_LOCALES.includes(/** @type {any} */ (raw.trim().toLowerCase()))) {
    return /** @type {Locale} */ (raw.trim().toLowerCase());
  }
  return 'fr';
}

/**
 * Lit la langue configurée pour une guilde depuis la DB.
 * Aucune ligne = français. Valeur inconnue = français.
 *
 * @param {string | null | undefined} guildId
 * @param {{ getGuildLanguage?: import('better-sqlite3').Statement } | null | undefined} stmts
 * @returns {Locale}
 */
export function getGuildLocale(guildId, stmts) {
  if (!guildId || !stmts?.getGuildLanguage) return 'fr';
  try {
    const row = stmts.getGuildLanguage.get(guildId);
    return normalizeLocale(/** @type {any} */ (row)?.language);
  } catch {
    return 'fr';
  }
}

/** @type {Record<Locale, Record<string, string>>} */
const LOCALES = { fr, en };

/**
 * Traduit une clé dans la locale donnée.
 * Fallback : français. Si absent en français : retourne `[key]`.
 *
 * Supporte l'interpolation {variable} :
 *   t('fr', 'findScrim.cooldown', { seconds: 42 })
 *   → "❌ Tu dois attendre encore 42 seconde(s)…"
 *
 * @param {Locale} locale
 * @param {string} key
 * @param {Record<string, string | number> | undefined} [vars]
 * @returns {string}
 */
export function t(locale, key, vars) {
  const messages = LOCALES[locale] ?? fr;
  const raw = messages[key] ?? fr[key];
  if (raw === undefined) {
    // Clé absente partout — ne jamais retourner vide
    return `[${key}]`;
  }
  if (!vars || Object.keys(vars).length === 0) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k];
    return v !== undefined ? String(v) : `{${k}}`;
  });
}

/**
 * Crée un traducteur lié à une locale.
 * Pratique pour éviter de passer `locale` partout dans un même scope.
 *
 * @param {Locale} locale
 * @returns {(key: string, vars?: Record<string, string | number>) => string}
 */
export function createTranslator(locale) {
  return (key, vars) => t(locale, key, vars);
}
