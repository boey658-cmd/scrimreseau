/**
 * Types / enums Billing Core (Phase 7A + 7B).
 *
 * Billing = état commercial. Entitlement = droits produit.
 * Le provider ne doit jamais écrire entitlement_grants ni features.
 */

/** @typedef {'pending' | 'active' | 'past_due' | 'grace' | 'canceled' | 'expired' | 'paused'} BillingSubscriptionStatus */
/** @typedef {'month' | 'year'} BillingInterval */
/** @typedef {'received' | 'processing' | 'processed' | 'ignored_stale' | 'failed'} BillingEventProcessingStatus */

/** @type {readonly BillingSubscriptionStatus[]} */
export const BILLING_SUBSCRIPTION_STATUSES = Object.freeze([
  'pending',
  'active',
  'past_due',
  'grace',
  'canceled',
  'expired',
  'paused',
]);

/** Statuts considérés « commerciaux vivants » (une seule principale / guild). */
export const BILLING_LIVE_STATUSES = Object.freeze(
  /** @type {const} */ (['pending', 'active', 'past_due', 'grace']),
);

/** @type {readonly BillingInterval[]} */
export const BILLING_INTERVALS = Object.freeze(/** @type {const} */ (['month', 'year']));

/**
 * Types d'événements normalisés (provider-agnostic).
 * Phase 7B : refunds / disputes / pause avec règles produit.
 */
export const BILLING_EVENT_TYPES = Object.freeze(/** @type {const} */ ([
  'subscription.created',
  'subscription.renewed',
  'subscription.upgraded',
  'subscription.downgraded',
  'subscription.downgrade_scheduled',
  'subscription.canceled',
  'subscription.expired',
  'subscription.paused',
  'payment.failed',
  'payment.recovered',
  'refund.pending',
  'refund.rejected',
  'refund.partial',
  'refund.ambiguous',
  'refund.full_approved',
  'dispute.opened',
  'dispute.reversed',
]));

/** @type {readonly BillingEventProcessingStatus[]} */
export const BILLING_EVENT_PROCESSING_STATUSES = Object.freeze([
  'received',
  'processing',
  'processed',
  'ignored_stale',
  'failed',
]);

/** Erreurs terminales (pas de retry auto). */
export const BILLING_TERMINAL_ERROR_CODES = Object.freeze([
  'MALFORMED_EVENT',
  'UNKNOWN_PRODUCT',
  'INVALID_SIGNATURE',
  'UNSUPPORTED_CURRENCY',
  'INVALID_PLAN',
  'INVALID_INTERVAL',
  'INVALID_STATUS',
  'DUPLICATE_LIVE_SUBSCRIPTION',
  'PADDLE_LIVE_FORBIDDEN',
  'PADDLE_AMOUNT_MISMATCH',
  'CHECKOUT_CONFLICT',
  'CHECKOUT_EXPIRED',
]);

/** Erreurs retryables. */
export const BILLING_RETRYABLE_ERROR_CODES = Object.freeze([
  'SQLITE_BUSY',
  'TEMPORARY_PROVIDER',
  'CRASH_INJECTED',
  'PADDLE_RATE_LIMITED',
  'PADDLE_UNAVAILABLE',
]);

export const MAX_PROVIDER_ID_LENGTH = 191;
export const MAX_PROVIDER_NAME_LENGTH = 32;
export const MAX_EVENT_TYPE_LENGTH = 64;

/**
 * Grâce paiement échoué : 7 jours (aligné PAID_GRACE_MS entitlement).
 * Importé depuis planCatalog pour une seule source numérique.
 */
export { PAID_GRACE_MS as BILLING_GRACE_MS } from '../entitlements/planCatalog.js';

/**
 * @param {unknown} status
 * @returns {status is BillingSubscriptionStatus}
 */
export function isBillingSubscriptionStatus(status) {
  return typeof status === 'string' && BILLING_SUBSCRIPTION_STATUSES.includes(/** @type {any} */ (status));
}

/**
 * @param {unknown} interval
 * @returns {interval is BillingInterval}
 */
export function isBillingInterval(interval) {
  return interval === 'month' || interval === 'year';
}

/**
 * @param {unknown} eventType
 * @returns {boolean}
 */
export function isBillingEventType(eventType) {
  return typeof eventType === 'string' && BILLING_EVENT_TYPES.includes(/** @type {any} */ (eventType));
}

/**
 * Accès Premium commercial encore dû.
 * paused/expired/canceled final → pas d'accès paid.
 * cancel_at_period_end=true + status=active ⇒ accès jusqu'à period_end.
 * @param {BillingSubscriptionStatus} status
 */
export function subscriptionStatusGrantsAccess(status) {
  return status === 'active' || status === 'past_due' || status === 'grace' || status === 'pending';
}
