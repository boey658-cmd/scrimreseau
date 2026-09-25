export {
  PLAN_FREE,
  PLAN_P1,
  PLAN_P2,
  PLAN_P3,
  PLAN_CATALOG,
  PLAN_KEYS,
  PREMIUM_PLAN_KEYS,
  PLAN_PRICE_HINTS,
  PAID_GRACE_MS,
  resolvePlanDefinition,
  getFreeLimit,
  getPlanTier,
  isPlanKey,
  isPremiumPlanKey,
} from './planCatalog.js';

export {
  getPlan,
  getEffectivePlan,
  getPlanDefinition,
  canUseFeature,
  getLimit,
  getEntitlementSnapshot,
  bindEntitlementStore,
} from './entitlementService.js';

export {
  resolveEffectiveEntitlement,
  evaluateGrantAccess,
  syntheticFreeSnapshot,
} from './entitlementResolver.js';

export {
  grantPremiumGift,
  grantPremiumAccess,
  revokePremiumGrant,
  revokeGift,
  assertInternalPremiumAdmin,
  onEntitlementChanged,
  notifyEntitlementChanged,
} from './entitlementGrants.js';

export {
  invalidateEntitlementCache,
  clearEntitlementCache,
  getCachedEffectiveEntitlement,
  computeNextEntitlementTransitionAt,
  computeEntitlementCacheExpiresAt,
  ENTITLEMENT_CACHE_TTL_MS,
  _entitlementCacheSize,
  _getEntitlementCacheEntry,
} from './entitlementCache.js';

export {
  startEntitlementExpirationJob,
  stopEntitlementExpirationJob,
  runEntitlementExpirationPass,
  getEntitlementExpirationJobHealthSnapshot,
} from './entitlementExpirationJob.js';
