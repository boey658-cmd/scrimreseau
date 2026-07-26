/**
 * Précision d'élo — source de vérité unique.
 *
 * Importé par :
 *  - src/commands/rechercheScrim.js    (définition de l'option slash)
 *  - src/services/scrimEmbedBuilder.js (affichage dans les embeds)
 *  - src/services/listeScrimsQuery.js  (affichage dans /liste-scrims)
 *  - src/commands/mesDemandes.js       (affichage dans /mes-demandes-scrim)
 *
 * Règle : ne jamais dupliquer la liste des valeurs dans un autre fichier.
 */

/**
 * Liste complète des options de précision d'élo, dans l'ordre d'affichage.
 * La valeur `none` correspond à l'absence de précision (stocké NULL en DB).
 *
 * @type {ReadonlyArray<{ readonly value: string, readonly label: string }>}
 */
export const ELO_PRECISION_OPTIONS = Object.freeze([
  { value: 'none',        label: 'Non précisé',   label_en: 'Not specified' },
  { value: 'low',         label: 'Low' },
  { value: 'high',        label: 'High' },
  { value: 'lp_100_199',  label: '100\u2013199 LP' },
  { value: 'lp_200_299',  label: '200\u2013299 LP' },
  { value: 'lp_300_399',  label: '300\u2013399 LP' },
  { value: 'lp_400_499',  label: '400\u2013499 LP' },
  { value: 'lp_500_599',  label: '500\u2013599 LP' },
  { value: 'lp_600_699',  label: '600\u2013699 LP' },
  { value: 'lp_700_799',  label: '700\u2013799 LP' },
  { value: 'lp_800_899',  label: '800\u2013899 LP' },
  { value: 'lp_900_plus', label: '900 LP et plus', label_en: '900+ LP' },
]);

/** Valeur interne représentant l'absence de précision. */
export const ELO_PRECISION_NONE = 'none';

/** Set des valeurs internes valides pour une précision réelle (hors 'none'). */
const VALID_PRECISION_SET = new Set(
  ELO_PRECISION_OPTIONS.filter((o) => o.value !== ELO_PRECISION_NONE).map((o) => o.value),
);

/**
 * Retourne le label affiché d'une précision, ou `null` si absente / inconnue.
 *
 * `null`, `undefined`, `''`, `'none'` → `null` (rien à afficher)
 * valeur inconnue → `null` (défensif, ne lève pas)
 *
 * @param {string | null | undefined} precision
 * @param {string} [locale] 'fr' (défaut) ou 'en'
 * @returns {string | null}
 */
export function getEloPrecisionLabel(precision, locale = 'fr') {
  if (!precision || precision === ELO_PRECISION_NONE) return null;
  const opt = ELO_PRECISION_OPTIONS.find((o) => o.value === precision);
  if (!opt) return null;
  if (locale === 'en' && opt.label_en) return opt.label_en;
  return opt.label;
}

/**
 * Normalise une valeur brute reçue depuis Discord (option slash ou DB).
 *
 * - `null` / `undefined` / `''` / `'none'` → `null` (pas de précision)
 * - valeur connue → chaîne normalisée
 * - valeur inconnue → `null` (défensif, ne crash pas, pas d'exposition)
 *
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function normalizeEloPrecision(raw) {
  if (!raw || raw.trim() === '' || raw.trim() === ELO_PRECISION_NONE) return null;
  const trimmed = raw.trim();
  if (VALID_PRECISION_SET.has(trimmed)) return trimmed;
  return null;
}

/**
 * Construit le texte du rang avec précision optionnelle.
 *
 * - rang + précision connue : `"Émeraude — High"` (FR) / `"Emerald — High"` (EN)
 * - rang seul :               `"Émeraude"` (FR) / `"Emerald"` (EN)
 *
 * Ne lève jamais. Toujours retourne au moins le rang tel quel.
 *
 * @param {string} rank  Valeur interne (ex. `'Platine'`)
 * @param {string | null | undefined} eloPrecision
 * @param {string} [locale] 'fr' (défaut) ou 'en'
 * @returns {string}
 */
export function formatRankWithPrecision(rank, eloPrecision, locale = 'fr') {
  const label = getEloPrecisionLabel(eloPrecision, locale);
  if (!label) return rank;
  return `${rank} \u2014 ${label}`;
}
