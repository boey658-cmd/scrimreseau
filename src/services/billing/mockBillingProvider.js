/**
 * Mock Billing Provider — TEST/DEV uniquement (Phase 7A).
 *
 * DENY BY DEFAULT. Autorisé uniquement si TOUTES les conditions sont vraies :
 * - ALLOW_BILLING_MOCK === "1" (opt-in explicite ; trim whitespace seulement)
 * - NODE_ENV !== "production"
 * - BILLING_LIVE_PROVIDER absent / vide
 *
 * Aucun réseau, aucun secret PSP.
 */

import { ConfigWriteError } from '../configWriteError.js';
import { resolveBillingProductByPlanInterval } from './billingCatalog.js';
import { BILLING_GRACE_MS } from './billingTypes.js';
import { processNormalizedBillingEvent } from './billingCore.js';

/**
 * @returns {boolean}
 */
export function isMockBillingAllowed() {
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.BILLING_LIVE_PROVIDER) return false;
  const allow = typeof process.env.ALLOW_BILLING_MOCK === 'string'
    ? process.env.ALLOW_BILLING_MOCK.trim()
    : '';
  return allow === '1';
}

export function assertMockBillingAllowed() {
  if (!isMockBillingAllowed()) {
    throw new ConfigWriteError(
      403,
      'FORBIDDEN',
      'mock billing interdit (deny-by-default / prod / live provider)',
    );
  }
}

/**
 * Interface conceptuelle Billing Adapter (Phase 7B branchera Stripe/Paddle ici).
 * @typedef {{
 *   normalizeWebhookEvent(raw: unknown): import('./billingCore.js').NormalizedBillingEvent,
 *   createCheckout(input: unknown): never,
 *   createPortal(input: unknown): never,
 *   retrieveSubscription(providerSubscriptionId: string): object | null,
 *   verifyWebhook(raw: unknown, signature: unknown): boolean,
 * }} BillingProviderAdapter
 */

/** @type {Map<string, object>} */
const mockSubscriptionStore = new Map();

export function clearMockBillingProviderState() {
  mockSubscriptionStore.clear();
}

/**
 * @param {string} providerSubscriptionId
 */
export function mockRetrieveSubscription(providerSubscriptionId) {
  assertMockBillingAllowed();
  return mockSubscriptionStore.get(providerSubscriptionId) ?? null;
}

/**
 * Met à jour le miroir mock provider (pour reconciliation).
 * @param {object} state
 */
export function mockPutSubscriptionState(state) {
  assertMockBillingAllowed();
  mockSubscriptionStore.set(state.providerSubscriptionId, { ...state });
}

/**
 * @returns {BillingProviderAdapter}
 */
export function createMockBillingProvider() {
  assertMockBillingAllowed();
  return {
    normalizeWebhookEvent(raw) {
      assertMockBillingAllowed();
      if (!raw || typeof raw !== 'object') {
        throw new ConfigWriteError(400, 'MALFORMED_EVENT', 'raw mock invalide');
      }
      const r = /** @type {Record<string, unknown>} */ (raw);
      return /** @type {any} */ ({
        provider: 'mock',
        providerEventId: r.providerEventId,
        eventType: r.eventType,
        providerEventAt: r.providerEventAt,
        guildId: r.guildId,
        providerCustomerId: r.providerCustomerId ?? `mock_cust_${r.guildId}`,
        providerSubscriptionId: r.providerSubscriptionId,
        planKey: r.planKey,
        interval: r.interval,
        productKey: r.productKey,
        status: r.status,
        currentPeriodStart: r.currentPeriodStart,
        currentPeriodEnd: r.currentPeriodEnd,
        cancelAtPeriodEnd: r.cancelAtPeriodEnd,
        canceledAt: r.canceledAt,
        graceEndsAt: r.graceEndsAt,
        pendingPlanKey: r.pendingPlanKey,
        pendingPlanEffectiveAt: r.pendingPlanEffectiveAt,
        contactUserId: r.contactUserId,
        amountMinor: r.amountMinor,
        currency: r.currency ?? 'EUR',
      });
    },
    createCheckout() {
      throw new ConfigWriteError(501, 'NOT_IMPLEMENTED', 'checkout non disponible Phase 7A');
    },
    createPortal() {
      throw new ConfigWriteError(501, 'NOT_IMPLEMENTED', 'portal non disponible Phase 7A');
    },
    retrieveSubscription(id) {
      return mockRetrieveSubscription(id);
    },
    verifyWebhook() {
      assertMockBillingAllowed();
      return true;
    },
  };
}

/**
 * Helper test : émet un événement mock et le traite via Billing Core.
 *
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   stmts: ReturnType<import('../../database/db.js')['prepareStatements']>,
 *   eventType: string,
 *   guildId: string,
 *   providerSubscriptionId: string,
 *   planKey: string,
 *   interval?: 'month' | 'year',
 *   currentPeriodStart: number,
 *   currentPeriodEnd: number,
 *   providerEventId: string,
 *   providerEventAt: number,
 *   nowMs?: number,
 *   cancelAtPeriodEnd?: boolean,
 *   pendingPlanKey?: string,
 *   pendingPlanEffectiveAt?: number,
 *   status?: string,
 *   graceEndsAt?: number,
 *   crashAfter?: Parameters<typeof processNormalizedBillingEvent>[0]['crashAfter'],
 *   providerCustomerId?: string,
 * }} p
 */
export function mockEmitAndProcess(p) {
  assertMockBillingAllowed();
  const interval = p.interval ?? 'month';
  const product = resolveBillingProductByPlanInterval(p.planKey, interval);

  const normalized = {
    provider: 'mock',
    providerEventId: p.providerEventId,
    eventType: p.eventType,
    providerEventAt: p.providerEventAt,
    guildId: p.guildId,
    providerCustomerId: p.providerCustomerId ?? `mock_cust_${p.guildId}`,
    providerSubscriptionId: p.providerSubscriptionId,
    planKey: p.planKey,
    interval,
    productKey: product.productKey,
    status: p.status,
    currentPeriodStart: p.currentPeriodStart,
    currentPeriodEnd: p.currentPeriodEnd,
    cancelAtPeriodEnd: p.cancelAtPeriodEnd,
    graceEndsAt: p.graceEndsAt,
    pendingPlanKey: p.pendingPlanKey,
    pendingPlanEffectiveAt: p.pendingPlanEffectiveAt,
    amountMinor: product.amountMinor,
    currency: 'EUR',
  };

  // Miroir provider pour reconciliation
  mockPutSubscriptionState({
    providerSubscriptionId: p.providerSubscriptionId,
    guildId: p.guildId,
    planKey: p.planKey,
    interval,
    status: p.status ?? deriveMockStatus(p.eventType, p),
    currentPeriodStart: p.currentPeriodStart,
    currentPeriodEnd: p.currentPeriodEnd,
    cancelAtPeriodEnd: Boolean(p.cancelAtPeriodEnd),
    graceEndsAt: p.graceEndsAt ?? (
      p.eventType === 'payment.failed' ? p.currentPeriodEnd + BILLING_GRACE_MS : null
    ),
    pendingPlanKey: p.pendingPlanKey ?? null,
    pendingPlanEffectiveAt: p.pendingPlanEffectiveAt ?? null,
    providerEventAt: p.providerEventAt,
  });

  return processNormalizedBillingEvent({
    db: p.db,
    stmts: p.stmts,
    event: normalized,
    nowMs: p.nowMs,
    crashAfter: p.crashAfter,
  });
}

/**
 * @param {string} eventType
 * @param {object} p
 */
function deriveMockStatus(eventType, p) {
  if (p.status) return p.status;
  if (eventType === 'payment.failed') return 'grace';
  if (eventType === 'subscription.expired') return 'expired';
  if (eventType === 'subscription.canceled' && !p.cancelAtPeriodEnd) return 'canceled';
  return 'active';
}
