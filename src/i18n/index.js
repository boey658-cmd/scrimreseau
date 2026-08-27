/**
 * Infrastructure de traduction ScrimRéseau.
 *
 *  - ALL_LOCALES : 7 locales techniques chargeables / testables.
 *  - ENABLED_GUILD_LOCALES : 7 locales persistables (/language, PATCH, SQLite).
 *
 * Fallback `t()` :
 *  - fr → fr
 *  - en missing → fr
 *  - es/de/it/pl/pt missing → en → fr
 *  - absente partout → `[key]`
 *
 * Autres règles :
 *  - Aucune condition `if (language === 'en')` dispersée dans les handlers.
 *  - Ne jamais utiliser `interaction.locale` pour les réponses bot.
 *  - Interpolation simple {variable} — sécurisée, pas d'exécution de code.
 *  - Snowflake Discord jamais convertis en Number.
 */

import { fr } from './fr.js';
import { en } from './en.js';
import { es } from './es.js';
import { de } from './de.js';
import { it } from './it.js';
import { pl } from './pl.js';
import { pt } from './pt.js';

/** Locales techniques (dictionnaires chargeables). @type {readonly ['fr','en','es','de','it','pl','pt']} */
export const ALL_LOCALES = Object.freeze(/** @type {const} */ (['fr', 'en', 'es', 'de', 'it', 'pl', 'pt']));

/**
 * Locales activées pour config guild (/language, PATCH, SQLite).
 * @type {readonly ['fr','en','es','de','it','pl','pt']}
 */
export const ENABLED_GUILD_LOCALES = Object.freeze(
  /** @type {const} */ (['fr', 'en', 'es', 'de', 'it', 'pl', 'pt']),
);

/** @typedef {'fr' | 'en' | 'es' | 'de' | 'it' | 'pl' | 'pt'} Locale */
/** @typedef {Locale} EnabledGuildLocale */

/** @deprecated Prefer ALL_LOCALES / ENABLED_GUILD_LOCALES — alias historique. */
const SUPPORTED_LOCALES = ENABLED_GUILD_LOCALES;

/**
 * Normalise vers une locale technique (7 valeurs).
 * Inconnue / absente → `'fr'`.
 * Ne pas utiliser pour décider ce qui est persistable en DB guild.
 *
 * @param {unknown} raw
 * @returns {Locale}
 */
export function normalizeLocale(raw) {
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (ALL_LOCALES.includes(/** @type {Locale} */ (v))) {
      return /** @type {Locale} */ (v);
    }
  }
  return 'fr';
}

/**
 * Normalise vers une locale guild activée (7 valeurs).
 * Toute valeur hors ENABLED_GUILD_LOCALES → `'fr'`.
 *
 * @param {unknown} raw
 * @returns {EnabledGuildLocale}
 */
export function normalizeEnabledGuildLocale(raw) {
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (ENABLED_GUILD_LOCALES.includes(/** @type {EnabledGuildLocale} */ (v))) {
      return /** @type {EnabledGuildLocale} */ (v);
    }
  }
  return 'fr';
}

/**
 * Lit la langue configurée pour une guilde depuis la DB.
 * Aucune ligne / valeur hors ENABLED_GUILD_LOCALES → français.
 *
 * @param {string | null | undefined} guildId
 * @param {{ getGuildLanguage?: import('better-sqlite3').Statement } | null | undefined} stmts
 * @returns {EnabledGuildLocale}
 */
export function getGuildLocale(guildId, stmts) {
  if (!guildId || !stmts?.getGuildLanguage) return 'fr';
  try {
    const row = stmts.getGuildLanguage.get(guildId);
    return normalizeEnabledGuildLocale(/** @type {any} */ (row)?.language);
  } catch {
    return 'fr';
  }
}

/** @type {Record<Locale, Readonly<Record<string, string>>>} */
const LOCALES = { fr, en, es, de, it, pl, pt };

/**
 * @param {Locale} locale
 * @returns {Readonly<Record<string, string>>[]}
 */
function catalogFallbackChain(locale) {
  if (locale === 'fr') return [fr];
  if (locale === 'en') return [en, fr];
  const primary = LOCALES[locale];
  if (primary) return [primary, en, fr];
  return [fr];
}

/**
 * Résout la chaîne brute (sans interpolation). Exposé pour tests de fallback.
 * @param {Locale} locale
 * @param {string} key
 * @param {Readonly<Record<string, string>>[] | null} [chainOverride]
 * @returns {string | undefined}
 */
export function lookupTranslationRaw(locale, key, chainOverride = null) {
  const chain = chainOverride ?? catalogFallbackChain(locale);
  for (const catalog of chain) {
    const value = catalog[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Traduit une clé dans la locale donnée.
 *
 * @param {Locale} locale
 * @param {string} key
 * @param {Record<string, string | number> | undefined} [vars]
 * @returns {string}
 */
export function t(locale, key, vars) {
  const resolvedLocale = ALL_LOCALES.includes(locale) ? locale : /** @type {Locale} */ ('fr');
  const raw = lookupTranslationRaw(resolvedLocale, key);
  if (raw === undefined) {
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
 * @param {Locale} locale
 * @returns {(key: string, vars?: Record<string, string | number>) => string}
 */
export function createTranslator(locale) {
  return (key, vars) => t(locale, key, vars);
}

/**
 * Mappe une locale bot vers un tag BCP 47 pour Intl (dates/nombres user-facing).
 * @param {string} [locale]
 * @returns {string}
 */
export function intlLocaleForBotLocale(locale = 'fr') {
  switch (locale) {
    case 'en':
      return 'en-GB';
    case 'es':
      return 'es-ES';
    case 'de':
      return 'de-DE';
    case 'it':
      return 'it-IT';
    case 'pl':
      return 'pl-PL';
    case 'pt':
      return 'pt-PT';
    case 'fr':
    default:
      return 'fr-FR';
  }
}

export { SUPPORTED_LOCALES };
export { fr, en, es, de, it, pl, pt };
