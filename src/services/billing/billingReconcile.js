/**
 * Reconciliation Billing (Phase 7A).
 *
 * Compare : provider-normalized state vs billing DB vs entitlement paid grant.
 * Répare uniquement via Billing Core (processNormalizedBillingEvent).
 *
 * Pas de job réseau réel — mécanique testable pour Phase 7B.
 */

import { ConfigWriteError } from '../configWriteError.js';
import { paidExternalRefForSubscription } from './syncPaidEntitlement.js';
import { processNormalizedBillingEvent } from './billingCore.js';
import { BILLING_GRACE_MS } from './billingTypes.js';
import { resolveBillingProductByPlanInterval } from './billingCatalog.js';
import { logger } from '../../utils/logger.js';

/**
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   stmts: ReturnType<import('../../database/db.js')['prepareStatements']>,
 *   provider: string,
 *   providerSubscriptionId: string,
 *   providerState: {
 *     guildId: string,
 *     planKey: string,
 *     interval: 'month' | 'year',
 *     status: string,
 *     currentPeriodStart: number,
 *     currentPeriodEnd: number,
 *     cancelAtPeriodEnd?: boolean,
 *     graceEndsAt?: number | null,
 *     pendingPlanKey?: string | null,
 *     pendingPlanEffectiveAt?: number | null,
 *     providerEventAt: number,
 *   },
 *   nowMs?: number,
 * }} p
 */
export function reconcileSubscription(p) {
  const nowMs = p.nowMs ?? Date.now();
  const dbSub = p.stmts.getBillingSubscriptionByProviderIds.get(p.provider, p.providerSubscriptionId);
  const providerState = p.providerState;

  const mismatches = [];

  if (!dbSub) {
    mismatches.push('missing_local_subscription');
  } else {
    if (dbSub.plan_key !== providerState.planKey) mismatches.push('plan_key');
    if (dbSub.status !== providerState.status) mismatches.push('status');
    if (Number(dbSub.current_period_end) !== Number(providerState.currentPeriodEnd)) {
      mismatches.push('current_period_end');
    }
    if (Number(dbSub.current_period_start) !== Number(providerState.currentPeriodStart)) {
      mismatches.push('current_period_start');
    }
  }

  const externalRef = paidExternalRefForSubscription(p.provider, p.providerSubscriptionId);
  const grant = p.stmts.getEntitlementGrantByExternalRef.get(externalRef);
  const providerGrantsAccess = ['active', 'past_due', 'grace', 'pending'].includes(providerState.status);

  if (providerGrantsAccess) {
    if (!grant || grant.source !== 'paid') {
      mismatches.push('missing_paid_grant');
    } else if (grant.plan_key !== providerState.planKey) {
      mismatches.push('grant_plan_key');
    } else if (Number(grant.ends_at) !== Number(providerState.currentPeriodEnd)) {
      mismatches.push('grant_ends_at');
    }
  } else if (grant && grant.status !== 'expired' && grant.status !== 'revoked') {
    // Provider dit expired — grant ne doit plus donner accès
    const endsAt = Number(grant.ends_at);
    const grace = grant.grace_ends_at != null ? Number(grant.grace_ends_at) : endsAt;
    if (nowMs < Math.max(endsAt, grace)) {
      mismatches.push('grant_still_active');
    }
  }

  if (mismatches.length === 0) {
    return { ok: true, repaired: false, mismatches: [] };
  }

  try {
    logger.warn('billing: reconciliation mismatch', {
      provider: p.provider,
      provider_subscription_id: p.providerSubscriptionId,
      mismatches,
    });
  } catch { /* ignore */ }

  const product = resolveBillingProductByPlanInterval(providerState.planKey, providerState.interval);
  const eventType = mapStatusToReconcileEvent(providerState.status);

  const result = processNormalizedBillingEvent({
    db: p.db,
    stmts: p.stmts,
    nowMs,
    event: {
      provider: p.provider,
      providerEventId: `reconcile:${p.provider}:${p.providerSubscriptionId}:${providerState.providerEventAt}:${providerState.status}:${providerState.planKey}:${providerState.currentPeriodEnd}`,
      eventType,
      providerEventAt: providerState.providerEventAt,
      guildId: providerState.guildId,
      providerSubscriptionId: p.providerSubscriptionId,
      planKey: providerState.planKey,
      interval: providerState.interval,
      productKey: product.productKey,
      status: providerState.status,
      currentPeriodStart: providerState.currentPeriodStart,
      currentPeriodEnd: providerState.currentPeriodEnd,
      cancelAtPeriodEnd: providerState.cancelAtPeriodEnd,
      graceEndsAt: providerState.graceEndsAt ?? (
        providerState.status === 'grace' || providerState.status === 'past_due'
          ? providerState.currentPeriodEnd + BILLING_GRACE_MS
          : null
      ),
      pendingPlanKey: providerState.pendingPlanKey,
      pendingPlanEffectiveAt: providerState.pendingPlanEffectiveAt,
      amountMinor: product.amountMinor,
      currency: 'EUR',
    },
  });

  if (!result.ok) {
    throw new ConfigWriteError(500, result.errorCode ?? 'INTERNAL_ERROR', result.message ?? 'reconcile failed');
  }

  return { ok: true, repaired: true, mismatches, result };
}

/**
 * @param {string} status
 */
function mapStatusToReconcileEvent(status) {
  switch (status) {
    case 'expired':
      return 'subscription.expired';
    case 'canceled':
      return 'subscription.canceled';
    case 'grace':
    case 'past_due':
      return 'payment.failed';
    default:
      return 'subscription.renewed';
  }
}

/**
 * Batch mécanique (pas de réseau) — itère subscriptions live + retrieve adapter.
 *
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   stmts: ReturnType<import('../../database/db.js')['prepareStatements']>,
 *   retrieve: (provider: string, providerSubscriptionId: string) => object | null,
 *   nowMs?: number,
 * }} p
 */
export function runBillingReconciliationPass(p) {
  const nowMs = p.nowMs ?? Date.now();
  const live = p.stmts.listLiveBillingSubscriptions.all() ?? [];
  const results = [];

  for (const sub of live) {
    const remote = p.retrieve(sub.provider, sub.provider_subscription_id);
    if (!remote) {
      results.push({
        providerSubscriptionId: sub.provider_subscription_id,
        skipped: true,
        reason: 'provider_missing',
      });
      continue;
    }
    try {
      const out = reconcileSubscription({
        db: p.db,
        stmts: p.stmts,
        provider: sub.provider,
        providerSubscriptionId: sub.provider_subscription_id,
        providerState: {
          guildId: remote.guildId ?? sub.guild_id,
          planKey: remote.planKey,
          interval: remote.interval,
          status: remote.status,
          currentPeriodStart: remote.currentPeriodStart,
          currentPeriodEnd: remote.currentPeriodEnd,
          cancelAtPeriodEnd: remote.cancelAtPeriodEnd,
          graceEndsAt: remote.graceEndsAt,
          pendingPlanKey: remote.pendingPlanKey,
          pendingPlanEffectiveAt: remote.pendingPlanEffectiveAt,
          providerEventAt: remote.providerEventAt ?? (nowMs),
        },
        nowMs,
      });
      results.push({
        providerSubscriptionId: sub.provider_subscription_id,
        ...out,
      });
    } catch (err) {
      results.push({
        providerSubscriptionId: sub.provider_subscription_id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { checked: live.length, results };
}
