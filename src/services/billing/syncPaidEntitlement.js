/**
 * Porte d'entrée UNIQUE Billing → Entitlement (Phase 7A).
 *
 * syncPaidEntitlementFromSubscription(...)
 *   → upsert grant source=paid
 *
 * Aucun chemin billing ne doit appeler get/set reception channels,
 * embed customization, filters, profiles, etc.
 *
 * Invariant : un abonnement = un grant paid (external_ref stable).
 * Les renouvellements mettent à jour ends_at — pas N grants.
 */

import { ConfigWriteError } from '../configWriteError.js';
import { invalidateEntitlementCache } from '../entitlements/entitlementCache.js';
import { resolveEffectiveEntitlement } from '../entitlements/entitlementResolver.js';
import { notifyEntitlementChanged } from '../entitlements/entitlementGrants.js';
import { upsertPaidEntitlementGrant } from '../entitlements/entitlementStore.js';
import { BILLING_GRACE_MS, subscriptionStatusGrantsAccess } from './billingTypes.js';
import { logger } from '../../utils/logger.js';

/** Acteur système pour grants billing (snowflake fictif interne). */
export const BILLING_SYSTEM_ACTOR_ID = '1000000000000000001';

/**
 * @param {{
 *   id: number,
 *   guild_id: string,
 *   provider: string,
 *   provider_subscription_id: string,
 *   plan_key: string,
 *   status: string,
 *   current_period_start: number,
 *   current_period_end: number,
 *   grace_ends_at: number | null,
 *   pending_plan_key?: string | null,
 *   pending_plan_effective_at?: number | null,
 * }} subscription
 * @param {number} nowMs
 */
export function resolveEffectivePaidPlanKey(subscription, nowMs) {
  const pending = subscription.pending_plan_key;
  const effectiveAt = subscription.pending_plan_effective_at;
  if (
    pending
    && effectiveAt != null
    && Number.isFinite(Number(effectiveAt))
    && nowMs >= Number(effectiveAt)
  ) {
    return pending;
  }
  return subscription.plan_key;
}

/**
 * @param {string} provider
 * @param {string} providerSubscriptionId
 */
export function paidExternalRefForSubscription(provider, providerSubscriptionId) {
  return `billing:${provider}:${providerSubscriptionId}`;
}

/**
 * @param {Parameters<typeof resolveEffectivePaidPlanKey>[0]} subscription
 * @param {number} nowMs
 */
export function computePaidEntitlementWindow(subscription, nowMs) {
  const planKey = resolveEffectivePaidPlanKey(subscription, nowMs);
  const startsAt = Number(subscription.current_period_start);
  const endsAt = Number(subscription.current_period_end);
  const status = subscription.status;

  if (!subscriptionStatusGrantsAccess(/** @type {any} */ (status))) {
    return {
      planKey,
      startsAt,
      endsAt,
      graceEndsAt: null,
      grantStatus: 'expired',
      clearAccess: true,
    };
  }

  let graceEndsAt = subscription.grace_ends_at != null
    ? Number(subscription.grace_ends_at)
    : endsAt + BILLING_GRACE_MS;

  if (status === 'active' || status === 'pending') {
    graceEndsAt = endsAt + BILLING_GRACE_MS;
  }

  return {
    planKey,
    startsAt,
    endsAt,
    graceEndsAt,
    grantStatus: nowMs < startsAt ? 'scheduled' : 'active',
    clearAccess: false,
  };
}

/**
 * Applique l'état commercial sur entitlement_grants (source=paid uniquement).
 *
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   stmts: ReturnType<import('../../database/db.js')['prepareStatements']>,
 *   subscription: Parameters<typeof resolveEffectivePaidPlanKey>[0],
 *   nowMs?: number,
 *   skipCacheInvalidate?: boolean,
 *   alreadyInTransaction?: boolean,
 * }} p
 */
export function syncPaidEntitlementFromSubscription(p) {
  const nowMs = p.nowMs ?? Date.now();
  const sub = p.subscription;
  if (!sub || typeof sub.guild_id !== 'string') {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'subscription billing invalide');
  }

  const window = computePaidEntitlementWindow(sub, nowMs);
  const externalRef = paidExternalRefForSubscription(sub.provider, sub.provider_subscription_id);
  const guildId = sub.guild_id;

  const oldSnap = resolveEffectiveEntitlement(p.stmts, guildId, nowMs);

  const apply = () => upsertPaidEntitlementGrant({
    stmts: p.stmts,
    guildId,
    planKey: window.planKey,
    startsAt: window.startsAt,
    endsAt: window.clearAccess
      ? Math.max(window.startsAt + 1, nowMs)
      : window.endsAt,
    graceEndsAt: window.clearAccess ? null : window.graceEndsAt,
    status: window.grantStatus,
    grantedBy: BILLING_SYSTEM_ACTOR_ID,
    reason: `billing sync sub=${sub.id} status=${sub.status}`,
    externalRef,
    provider: sub.provider,
    nowMs,
    clearAccess: window.clearAccess,
  });

  const row = p.alreadyInTransaction ? apply() : p.db.transaction(apply)();

  if (!p.skipCacheInvalidate) {
    invalidateEntitlementCache(guildId);
  }

  const newSnap = resolveEffectiveEntitlement(p.stmts, guildId, nowMs);
  notifyEntitlementChanged(guildId, oldSnap, newSnap);

  try {
    logger.info('billing: paid entitlement synced', {
      guild_id: guildId,
      subscription_id: sub.id,
      grant_id: row.id,
      plan_key: row.plan_key,
      ends_at: row.ends_at,
      grace_ends_at: row.grace_ends_at,
      clear_access: window.clearAccess,
    });
  } catch {
    /* ignore */
  }

  return row;
}
