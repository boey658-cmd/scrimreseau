/**
 * Types / constantes entitlement (Phase 1).
 */

/** @typedef {'paid' | 'gift' | 'manual'} EntitlementSource */
/** @typedef {'scheduled' | 'active' | 'grace' | 'expired' | 'canceled' | 'revoked'} EntitlementStatus */

/**
 * Statuts persistés en DB (commercial / lifecycle).
 * `grace` n'est PAS persisté : calculé à la résolution.
 * `canceled` = renouvellement arrêté, accès toujours possible jusqu'à ends_at (+ grace paid).
 */
export const PERSISTED_GRANT_STATUSES = Object.freeze([
  'scheduled',
  'active',
  'canceled',
  'revoked',
  'expired',
]);

export const ENTITLEMENT_SOURCES = Object.freeze(['paid', 'gift', 'manual']);

/** Snowflake Discord 17–22 digits. */
export const GUILD_ID_RE = /^\d{17,22}$/;

export const MAX_REASON_LENGTH = 500;
export const MAX_EXTERNAL_REF_LENGTH = 128;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/**
 * Priorité source pour tie-break à tier égal (plus haut = préféré).
 * Gift > paid > manual.
 * @type {Readonly<Record<EntitlementSource, number>>}
 */
export const SOURCE_TIE_PRIORITY = Object.freeze({
  gift: 3,
  paid: 2,
  manual: 1,
});
