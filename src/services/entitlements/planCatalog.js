/**
 * Catalogue des plans Premium — source unique des limites / features.
 *
 * Ordre canonique : FREE < P1 < P2 < P3 (via `tier`, jamais comparaison de strings).
 * Aucun magic number 2/4/10 hors de ce fichier.
 */

/** @typedef {'FREE' | 'P1' | 'P2' | 'P3'} PlanKey */

/**
 * @typedef {{
 *   planKey: PlanKey,
 *   tier: number,
 *   limits: Readonly<{ reception_channels: number }>,
 *   features: Readonly<Record<string, boolean>>,
 * }} PlanDefinition
 */

const PREMIUM_FEATURES_OFF = Object.freeze({
  multi_reception_channels: false,
  elo_channel_filters: false,
  enhanced_structure_profile: false,
  structure_profile_enriched: false,
  premium_badge: false,
  directory_featured: false,
  local_embed_customization: false,
  embed_presets: false,
  live_preview: false,
  embed_live_preview: false,
});

/** @type {Readonly<PlanDefinition>} */
export const PLAN_FREE = Object.freeze({
  planKey: 'FREE',
  tier: 0,
  limits: Object.freeze({ reception_channels: 1 }),
  features: PREMIUM_FEATURES_OFF,
});

/** @type {Readonly<PlanDefinition>} */
export const PLAN_P1 = Object.freeze({
  planKey: 'P1',
  tier: 1,
  limits: Object.freeze({ reception_channels: 2 }),
  features: Object.freeze({
    ...PREMIUM_FEATURES_OFF,
    multi_reception_channels: true,
    elo_channel_filters: true,
    enhanced_structure_profile: true,
    structure_profile_enriched: true,
    premium_badge: true,
    directory_featured: true,
  }),
});

/** @type {Readonly<PlanDefinition>} */
export const PLAN_P2 = Object.freeze({
  planKey: 'P2',
  tier: 2,
  limits: Object.freeze({ reception_channels: 4 }),
  features: Object.freeze({
    ...PREMIUM_FEATURES_OFF,
    multi_reception_channels: true,
    elo_channel_filters: true,
    enhanced_structure_profile: true,
    structure_profile_enriched: true,
    premium_badge: true,
    directory_featured: true,
    local_embed_customization: true,
    embed_presets: true,
    live_preview: true,
    embed_live_preview: true,
  }),
});

/** @type {Readonly<PlanDefinition>} */
export const PLAN_P3 = Object.freeze({
  planKey: 'P3',
  tier: 3,
  limits: Object.freeze({ reception_channels: 10 }),
  features: Object.freeze({
    ...PREMIUM_FEATURES_OFF,
    multi_reception_channels: true,
    elo_channel_filters: true,
    enhanced_structure_profile: true,
    structure_profile_enriched: true,
    premium_badge: true,
    directory_featured: true,
    local_embed_customization: true,
    embed_presets: true,
    live_preview: true,
    embed_live_preview: true,
  }),
});

/** @type {Readonly<Record<PlanKey, PlanDefinition>>} */
export const PLAN_CATALOG = Object.freeze({
  FREE: PLAN_FREE,
  P1: PLAN_P1,
  P2: PLAN_P2,
  P3: PLAN_P3,
});

/** @type {readonly PlanKey[]} */
export const PLAN_KEYS = Object.freeze(/** @type {const} */ (['FREE', 'P1', 'P2', 'P3']));

/** @type {readonly Exclude<PlanKey, 'FREE'>[]} */
export const PREMIUM_PLAN_KEYS = Object.freeze(/** @type {const} */ (['P1', 'P2', 'P3']));

/**
 * @param {unknown} planKey
 * @returns {planKey is PlanKey}
 */
export function isPlanKey(planKey) {
  return typeof planKey === 'string' && Object.prototype.hasOwnProperty.call(PLAN_CATALOG, planKey);
}

/**
 * @param {unknown} planKey
 * @returns {planKey is Exclude<PlanKey, 'FREE'>}
 */
export function isPremiumPlanKey(planKey) {
  return planKey === 'P1' || planKey === 'P2' || planKey === 'P3';
}

/**
 * @param {unknown} planKey
 * @returns {PlanDefinition}
 */
export function resolvePlanDefinition(planKey) {
  if (isPlanKey(planKey)) {
    return PLAN_CATALOG[planKey];
  }
  // Inconnu / null → FREE (fail-safe cœur gratuit)
  return PLAN_FREE;
}

/**
 * @param {unknown} planKey
 * @returns {number}
 */
export function getPlanTier(planKey) {
  return resolvePlanDefinition(planKey).tier;
}

/**
 * @param {string} limitKey
 * @returns {number | null}
 */
export function getFreeLimit(limitKey) {
  if (limitKey === 'reception_channels') return PLAN_FREE.limits.reception_channels;
  return null;
}

/** @deprecated Preférer `listBillingCatalogPublic` / billingCatalog (centimes). Hints float doc-only. */
export const PLAN_PRICE_HINTS = Object.freeze({
  P1: Object.freeze({ monthly_eur: 4.99, yearly_eur: 49.99 }),
  P2: Object.freeze({ monthly_eur: 9.99, yearly_eur: 99.99 }),
  P3: Object.freeze({ monthly_eur: 14.99, yearly_eur: 149.99 }),
});

/** Grâce billing paid : 7 jours (ms). */
export const PAID_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
