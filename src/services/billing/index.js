/**
 * Billing Core public API (Phase 7A).
 *
 * PCI invariant : ScrimRéseau ne stocke JAMAIS de numéro de carte, CVC,
 * expiration carte, ni credentials bancaires. Le futur PSP gère PCI.
 */

export {
  BILLING_CATALOG,
  BILLING_PRODUCT_KEYS,
  PROVIDER_PRICE_MAP,
  listBillingCatalogPublic,
  resolveBillingProduct,
  resolveBillingProductByPlanInterval,
  resolveProductFromProviderPrice,
  assertCatalogAmount,
  assertBillingCurrency,
  isBillingProductKey,
} from './billingCatalog.js';

export {
  BILLING_SUBSCRIPTION_STATUSES,
  BILLING_LIVE_STATUSES,
  BILLING_INTERVALS,
  BILLING_EVENT_TYPES,
  BILLING_GRACE_MS,
  isBillingSubscriptionStatus,
  isBillingInterval,
  isBillingEventType,
  subscriptionStatusGrantsAccess,
} from './billingTypes.js';

export {
  processNormalizedBillingEvent,
  validateNormalizedBillingEvent,
  getGuildBillingPublicView,
  isSqliteBusy,
} from './billingCore.js';

export {
  syncPaidEntitlementFromSubscription,
  paidExternalRefForSubscription,
  computePaidEntitlementWindow,
  resolveEffectivePaidPlanKey,
  BILLING_SYSTEM_ACTOR_ID,
} from './syncPaidEntitlement.js';

export {
  isMockBillingAllowed,
  assertMockBillingAllowed,
  createMockBillingProvider,
  mockEmitAndProcess,
  mockRetrieveSubscription,
  mockPutSubscriptionState,
  clearMockBillingProviderState,
} from './mockBillingProvider.js';

export {
  reconcileSubscription,
  runBillingReconciliationPass,
} from './billingReconcile.js';

export {
  parsePaddleSandboxConfig,
  isPaddleBillingConfigured,
  assertPaddleSandboxOnly,
  loadPaddlePriceMapFromEnv,
  PADDLE_PRICE_ENV_KEYS,
} from './paddleConfig.js';

export {
  createPaddleBillingProvider,
  hashBinding,
  generateCheckoutIntentId,
  mapPaddleSubscriptionToProviderState,
} from './paddleBillingProvider.js';

export {
  createOrReuseCheckoutIntent,
  assertCheckoutIntentValid,
  resolveGuildFromCheckoutCustomData,
  CHECKOUT_INTENT_TTL_MS,
} from './billingCheckout.js';

export {
  processPaddleWebhook,
} from './paddleWebhookProcessor.js';
