/**
 * Catalogue billing central (Phase 7A).
 *
 * Source UNIQUE des prix commerciaux. Montants en CENTIMES entiers (jamais float).
 * Devise V1 : EUR uniquement.
 *
 * Invariant PCI : aucun numéro de carte / CVC / IBAN ici ni ailleurs dans ScrimRéseau.
 */

import { ConfigWriteError } from '../configWriteError.js';
import { isPremiumPlanKey } from '../entitlements/planCatalog.js';

/** @typedef {'month' | 'year'} BillingInterval */
/** @typedef {'P1' | 'P2' | 'P3'} PaidPlanKey */

/**
 * @typedef {{
 *   productKey: string,
 *   planKey: PaidPlanKey,
 *   interval: BillingInterval,
 *   amountMinor: number,
 *   currency: 'EUR',
 * }} BillingCatalogEntry
 */

/** @type {readonly BillingCatalogEntry[]} */
const ENTRIES = Object.freeze([
  Object.freeze({ productKey: 'P1_MONTHLY', planKey: 'P1', interval: 'month', amountMinor: 499, currency: 'EUR' }),
  Object.freeze({ productKey: 'P1_YEARLY', planKey: 'P1', interval: 'year', amountMinor: 4999, currency: 'EUR' }),
  Object.freeze({ productKey: 'P2_MONTHLY', planKey: 'P2', interval: 'month', amountMinor: 999, currency: 'EUR' }),
  Object.freeze({ productKey: 'P2_YEARLY', planKey: 'P2', interval: 'year', amountMinor: 9999, currency: 'EUR' }),
  Object.freeze({ productKey: 'P3_MONTHLY', planKey: 'P3', interval: 'month', amountMinor: 1499, currency: 'EUR' }),
  Object.freeze({ productKey: 'P3_YEARLY', planKey: 'P3', interval: 'year', amountMinor: 14999, currency: 'EUR' }),
]);

/** @type {Readonly<Record<string, BillingCatalogEntry>>} */
export const BILLING_CATALOG = Object.freeze(
  Object.fromEntries(ENTRIES.map((e) => [e.productKey, e])),
);

/** @type {readonly string[]} */
export const BILLING_PRODUCT_KEYS = Object.freeze(ENTRIES.map((e) => e.productKey));

/**
 * Mapping futur provider_price_id → productKey (Phase 7B).
 * Phase 7A : vide volontairement — aucun ID Stripe/Paddle.
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const PROVIDER_PRICE_MAP = Object.freeze({
  mock: Object.freeze({
    mock_price_p1_month: 'P1_MONTHLY',
    mock_price_p1_year: 'P1_YEARLY',
    mock_price_p2_month: 'P2_MONTHLY',
    mock_price_p2_year: 'P2_YEARLY',
    mock_price_p3_month: 'P3_MONTHLY',
    mock_price_p3_year: 'P3_YEARLY',
  }),
});

/**
 * @param {unknown} productKey
 * @returns {productKey is string}
 */
export function isBillingProductKey(productKey) {
  return typeof productKey === 'string' && Object.prototype.hasOwnProperty.call(BILLING_CATALOG, productKey);
}

/**
 * @param {unknown} productKey
 * @returns {BillingCatalogEntry}
 */
export function resolveBillingProduct(productKey) {
  if (!isBillingProductKey(productKey)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'product_key billing inconnu');
  }
  return BILLING_CATALOG[productKey];
}

/**
 * @param {unknown} planKey
 * @param {unknown} interval
 * @returns {BillingCatalogEntry}
 */
export function resolveBillingProductByPlanInterval(planKey, interval) {
  if (!isPremiumPlanKey(planKey)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'plan_key billing invalide');
  }
  if (interval !== 'month' && interval !== 'year') {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'interval billing invalide');
  }
  const suffix = interval === 'month' ? 'MONTHLY' : 'YEARLY';
  return resolveBillingProduct(`${planKey}_${suffix}`);
}

/**
 * @param {string} provider
 * @param {string} providerPriceId
 * @returns {BillingCatalogEntry | null}
 */
export function resolveProductFromProviderPrice(provider, providerPriceId) {
  const map = PROVIDER_PRICE_MAP[provider];
  if (!map) return null;
  const productKey = map[providerPriceId];
  if (!productKey) return null;
  return BILLING_CATALOG[productKey] ?? null;
}

/**
 * Liste publique (dashboard) — montants en centimes, backend décide.
 * @returns {readonly BillingCatalogEntry[]}
 */
export function listBillingCatalogPublic() {
  return ENTRIES;
}

/**
 * @param {unknown} currency
 */
export function assertBillingCurrency(currency) {
  if (currency !== 'EUR') {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'currency non supportée (EUR uniquement)');
  }
  return 'EUR';
}

/**
 * Vérifie qu'un montant correspond exactement au catalogue (anti mass-assignment).
 * @param {PaidPlanKey} planKey
 * @param {BillingInterval} interval
 * @param {unknown} amountMinor
 * @param {unknown} currency
 */
export function assertCatalogAmount(planKey, interval, amountMinor, currency) {
  assertBillingCurrency(currency);
  const entry = resolveBillingProductByPlanInterval(planKey, interval);
  if (typeof amountMinor !== 'number' || !Number.isInteger(amountMinor) || amountMinor !== entry.amountMinor) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'amount_minor hors catalogue');
  }
  return entry;
}
