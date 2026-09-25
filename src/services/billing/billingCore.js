/**
 * Billing Core — traitement d'événements normalisés (Phase 7A).
 *
 * Provider → Adapter → Billing Event → Billing Core → Subscription → syncPaidEntitlement
 *
 * Invariants :
 * - Pas de données carte / PCI
 * - Idempotence via (provider, provider_event_id) UNIQUE
 * - Subscription + entitlement sync dans une transaction SQLite
 * - Cache entitlement invalidé APRÈS commit
 * - Events hors-ordre (provider_event_at < last) → ignored_stale
 * - Phase 7B : refund full approved / chargeback → revoke paid ; partial/pending → no-op
 */

import { ConfigWriteError } from '../configWriteError.js';
import { invalidateEntitlementCache } from '../entitlements/entitlementCache.js';
import { isPremiumPlanKey } from '../entitlements/planCatalog.js';
import { assertValidGuildId } from '../entitlements/entitlementStore.js';
import {
  assertCatalogAmount,
  resolveBillingProductByPlanInterval,
  resolveBillingProduct,
  isBillingProductKey,
} from './billingCatalog.js';
import { hashBillingPayload } from './billingHash.js';
import {
  BILLING_GRACE_MS,
  BILLING_LIVE_STATUSES,
  isBillingEventType,
  isBillingInterval,
  isBillingSubscriptionStatus,
  MAX_PROVIDER_ID_LENGTH,
  MAX_PROVIDER_NAME_LENGTH,
} from './billingTypes.js';
import { syncPaidEntitlementFromSubscription } from './syncPaidEntitlement.js';
import { logger } from '../../utils/logger.js';

/** Events qui n'altèrent pas l'état commercial (ACK only). */
const NOOP_EVENT_TYPES = new Set([
  'refund.pending',
  'refund.rejected',
  'refund.partial',
  'refund.ambiguous',
  /** Reverse : jamais inventer Premium — reconcile séparée via retrieve Paddle. */
  'dispute.reversed',
]);

/** Events qui coupent immédiatement l'accès paid. */
const REVOKE_EVENT_TYPES = new Set([
  'refund.full_approved',
  'dispute.opened',
  'subscription.paused',
]);

/**
 * @typedef {{
 *   provider: string,
 *   providerEventId: string,
 *   eventType: string,
 *   providerEventAt: number,
 *   guildId: string,
 *   providerCustomerId?: string | null,
 *   providerSubscriptionId: string,
 *   planKey: string,
 *   interval: string,
 *   productKey?: string | null,
 *   status?: string | null,
 *   currentPeriodStart: number,
 *   currentPeriodEnd: number,
 *   cancelAtPeriodEnd?: boolean,
 *   canceledAt?: number | null,
 *   graceEndsAt?: number | null,
 *   pendingPlanKey?: string | null,
 *   pendingPlanEffectiveAt?: number | null,
 *   contactUserId?: string | null,
 *   amountMinor?: number | null,
 *   currency?: string | null,
 *   rawNormalized?: Record<string, unknown>,
 * }} NormalizedBillingEvent
 */

/**
 * @param {unknown} id
 * @param {string} label
 */
function assertProviderId(id, label) {
  if (typeof id !== 'string' || !id.trim() || id.trim().length > MAX_PROVIDER_ID_LENGTH) {
    throw new ConfigWriteError(400, 'MALFORMED_EVENT', `${label} invalide`);
  }
  if (!/^[\w.:\-]+$/.test(id.trim())) {
    throw new ConfigWriteError(400, 'MALFORMED_EVENT', `${label} caractères invalides`);
  }
  return id.trim();
}

/**
 * @param {unknown} provider
 */
function assertProviderName(provider) {
  if (typeof provider !== 'string' || !provider.trim() || provider.trim().length > MAX_PROVIDER_NAME_LENGTH) {
    throw new ConfigWriteError(400, 'MALFORMED_EVENT', 'provider invalide');
  }
  return provider.trim();
}

/**
 * @param {unknown} ms
 * @param {string} label
 */
function assertMs(ms, label) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || !Number.isInteger(ms) || ms < 0) {
    throw new ConfigWriteError(400, 'MALFORMED_EVENT', `${label} invalide`);
  }
  return ms;
}

/**
 * Valide et normalise un événement entrant (fail terminal si malformé).
 * @param {Partial<NormalizedBillingEvent>} raw
 * @returns {NormalizedBillingEvent}
 */
export function validateNormalizedBillingEvent(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigWriteError(400, 'MALFORMED_EVENT', 'event null');
  }
  const provider = assertProviderName(raw.provider);
  const providerEventId = assertProviderId(raw.providerEventId, 'provider_event_id');
  if (!isBillingEventType(raw.eventType)) {
    throw new ConfigWriteError(400, 'MALFORMED_EVENT', 'event_type inconnu');
  }
  const providerEventAt = assertMs(raw.providerEventAt, 'provider_event_at');
  const guildId = assertValidGuildId(raw.guildId);
  const providerSubscriptionId = assertProviderId(raw.providerSubscriptionId, 'provider_subscription_id');

  if (!isPremiumPlanKey(raw.planKey)) {
    throw new ConfigWriteError(400, 'INVALID_PLAN', 'plan_key invalide');
  }
  if (!isBillingInterval(raw.interval)) {
    throw new ConfigWriteError(400, 'INVALID_INTERVAL', 'interval invalide');
  }

  let productKey = raw.productKey;
  if (productKey != null && productKey !== '') {
    if (!isBillingProductKey(productKey)) {
      throw new ConfigWriteError(400, 'UNKNOWN_PRODUCT', 'product_key inconnu');
    }
  } else {
    productKey = resolveBillingProductByPlanInterval(raw.planKey, raw.interval).productKey;
  }

  const product = resolveBillingProduct(productKey);
  if (product.planKey !== raw.planKey || product.interval !== raw.interval) {
    throw new ConfigWriteError(400, 'UNKNOWN_PRODUCT', 'product/plan incohérents');
  }

  if (raw.currency != null || raw.amountMinor != null) {
    assertCatalogAmount(raw.planKey, raw.interval, raw.amountMinor, raw.currency ?? 'EUR');
  }

  const currentPeriodStart = assertMs(raw.currentPeriodStart, 'current_period_start');
  const currentPeriodEnd = assertMs(raw.currentPeriodEnd, 'current_period_end');
  if (currentPeriodEnd <= currentPeriodStart) {
    throw new ConfigWriteError(400, 'MALFORMED_EVENT', 'période inversée');
  }

  if (raw.status != null && !isBillingSubscriptionStatus(raw.status)) {
    throw new ConfigWriteError(400, 'INVALID_STATUS', 'status invalide');
  }

  if (raw.pendingPlanKey != null && raw.pendingPlanKey !== '' && !isPremiumPlanKey(raw.pendingPlanKey)) {
    throw new ConfigWriteError(400, 'INVALID_PLAN', 'pending_plan_key invalide');
  }

  return {
    provider,
    providerEventId,
    eventType: /** @type {string} */ (raw.eventType),
    providerEventAt,
    guildId,
    providerCustomerId: raw.providerCustomerId
      ? assertProviderId(raw.providerCustomerId, 'provider_customer_id')
      : `cust_${guildId}`,
    providerSubscriptionId,
    planKey: /** @type {string} */ (raw.planKey),
    interval: /** @type {string} */ (raw.interval),
    productKey,
    status: raw.status ?? null,
    currentPeriodStart,
    currentPeriodEnd,
    cancelAtPeriodEnd: Boolean(raw.cancelAtPeriodEnd),
    canceledAt: raw.canceledAt != null ? assertMs(raw.canceledAt, 'canceled_at') : null,
    graceEndsAt: raw.graceEndsAt != null ? assertMs(raw.graceEndsAt, 'grace_ends_at') : null,
    pendingPlanKey: raw.pendingPlanKey || null,
    pendingPlanEffectiveAt: raw.pendingPlanEffectiveAt != null
      ? assertMs(raw.pendingPlanEffectiveAt, 'pending_plan_effective_at')
      : null,
    contactUserId: raw.contactUserId && typeof raw.contactUserId === 'string' ? raw.contactUserId.trim() : null,
    amountMinor: product.amountMinor,
    currency: 'EUR',
    rawNormalized: raw.rawNormalized ?? {},
  };
}

/**
 * @param {NormalizedBillingEvent} event
 * @param {number} nowMs
 */
function deriveStatusFromEvent(event, nowMs) {
  if (event.status && isBillingSubscriptionStatus(event.status)) {
    return event.status;
  }

  switch (event.eventType) {
    case 'subscription.created':
    case 'subscription.renewed':
    case 'subscription.upgraded':
    case 'payment.recovered':
      return 'active';
    case 'subscription.downgraded':
    case 'subscription.downgrade_scheduled':
      return 'active';
    case 'payment.failed':
      return nowMs >= event.currentPeriodEnd ? 'grace' : 'past_due';
    case 'subscription.canceled':
      if (event.cancelAtPeriodEnd && nowMs < event.currentPeriodEnd) {
        return 'active';
      }
      return nowMs < event.currentPeriodEnd ? 'active' : 'canceled';
    case 'subscription.expired':
    case 'subscription.paused':
    case 'refund.full_approved':
    case 'dispute.opened':
      return 'expired';
    case 'dispute.reversed':
    case 'refund.pending':
    case 'refund.rejected':
    case 'refund.partial':
    case 'refund.ambiguous':
      // No-op : ne devrait pas arriver ici (court-circuité)
      return event.status && isBillingSubscriptionStatus(event.status) ? event.status : 'active';
    default:
      return 'active';
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<import('../../database/db.js')['prepareStatements']>} stmts
 * @param {NormalizedBillingEvent} event
 * @param {number} nowMs
 */
function ensureCustomer(stmts, event, nowMs) {
  const existing = stmts.getBillingCustomerByProviderIds.get(event.provider, event.providerCustomerId);
  if (existing) return existing;
  const info = stmts.insertBillingCustomer.run({
    guild_id: event.guildId,
    provider: event.provider,
    provider_customer_id: event.providerCustomerId,
    contact_user_id: event.contactUserId,
    created_at: nowMs,
    updated_at: nowMs,
  });
  return stmts.getBillingCustomerById.get(Number(info.lastInsertRowid));
}

/**
 * @param {ReturnType<import('../../database/db.js')['prepareStatements']>} stmts
 * @param {string} guildId
 * @param {number | null} excludeId
 */
function assertNoConflictingLiveSubscription(stmts, guildId, excludeId) {
  const live = stmts.getLiveBillingSubscriptionByGuild.get(guildId);
  if (live && excludeId != null && Number(live.id) !== Number(excludeId)) {
    throw new ConfigWriteError(
      409,
      'DUPLICATE_LIVE_SUBSCRIPTION',
      'guild a déjà une subscription commerciale live',
    );
  }
  if (live && excludeId == null) {
    // Creating new — conflict
    throw new ConfigWriteError(
      409,
      'DUPLICATE_LIVE_SUBSCRIPTION',
      'guild a déjà une subscription commerciale live',
    );
  }
}

/**
 * Applique un événement déjà claimé (dans transaction).
 * @returns {{ subscription: object, outcome: string }}
 */
function applyEventToSubscription(stmts, event, nowMs) {
  const customer = ensureCustomer(stmts, event, nowMs);
  let sub = stmts.getBillingSubscriptionByProviderIds.get(event.provider, event.providerSubscriptionId);

  // Stale / out-of-order
  if (sub && sub.last_provider_event_at != null && event.providerEventAt < Number(sub.last_provider_event_at)) {
    return { subscription: sub, outcome: 'ignored_stale' };
  }

  const status = deriveStatusFromEvent(event, nowMs);
  let graceEndsAt = event.graceEndsAt;
  if (event.eventType === 'payment.failed') {
    graceEndsAt = event.graceEndsAt ?? (event.currentPeriodEnd + BILLING_GRACE_MS);
  }
  if (event.eventType === 'payment.recovered' || event.eventType === 'subscription.renewed') {
    graceEndsAt = null;
  }

  let pendingPlanKey = event.pendingPlanKey;
  let pendingPlanEffectiveAt = event.pendingPlanEffectiveAt;
  let planKey = event.planKey;

  if (event.eventType === 'subscription.downgrade_scheduled') {
    pendingPlanKey = event.pendingPlanKey ?? event.planKey;
    pendingPlanEffectiveAt = event.pendingPlanEffectiveAt ?? event.currentPeriodEnd;
    // Conserve le plan actuel sur la row jusqu'à effective_at
    if (sub) planKey = sub.plan_key;
  }

  if (event.eventType === 'subscription.downgraded' || event.eventType === 'subscription.upgraded') {
    pendingPlanKey = null;
    pendingPlanEffectiveAt = null;
    planKey = event.planKey;
  }

  // Appliquer pending si échéance atteinte
  if (
    pendingPlanKey == null
    && sub?.pending_plan_key
    && sub.pending_plan_effective_at != null
    && nowMs >= Number(sub.pending_plan_effective_at)
    && event.eventType === 'subscription.renewed'
  ) {
    planKey = sub.pending_plan_key;
    pendingPlanKey = null;
    pendingPlanEffectiveAt = null;
  }

  const product = resolveBillingProductByPlanInterval(planKey, event.interval);
  const cancelAtPeriodEnd = event.eventType === 'subscription.canceled'
    ? (event.cancelAtPeriodEnd !== false)
    : Boolean(event.cancelAtPeriodEnd);
  const canceledAt = event.eventType === 'subscription.canceled'
    ? (event.canceledAt ?? nowMs)
    : (cancelAtPeriodEnd ? (sub?.canceled_at ?? event.canceledAt ?? nowMs) : null);

  if (!sub) {
    if (BILLING_LIVE_STATUSES.includes(/** @type {any} */ (status))) {
      assertNoConflictingLiveSubscription(stmts, event.guildId, null);
    }
    const info = stmts.insertBillingSubscription.run({
      guild_id: event.guildId,
      customer_id: customer.id,
      provider: event.provider,
      provider_subscription_id: event.providerSubscriptionId,
      plan_key: planKey,
      interval: event.interval,
      product_key: product.productKey,
      status,
      current_period_start: event.currentPeriodStart,
      current_period_end: event.currentPeriodEnd,
      cancel_at_period_end: cancelAtPeriodEnd ? 1 : 0,
      canceled_at: canceledAt,
      grace_ends_at: graceEndsAt,
      pending_plan_key: pendingPlanKey,
      pending_plan_effective_at: pendingPlanEffectiveAt,
      last_provider_event_at: event.providerEventAt,
      created_at: nowMs,
      updated_at: nowMs,
    });
    sub = stmts.getBillingSubscriptionById.get(Number(info.lastInsertRowid));
  } else {
    if (BILLING_LIVE_STATUSES.includes(/** @type {any} */ (status))) {
      assertNoConflictingLiveSubscription(stmts, event.guildId, sub.id);
    }
    stmts.updateBillingSubscription.run({
      id: sub.id,
      plan_key: planKey,
      interval: event.interval,
      product_key: product.productKey,
      status,
      current_period_start: event.currentPeriodStart,
      current_period_end: event.currentPeriodEnd,
      cancel_at_period_end: cancelAtPeriodEnd ? 1 : 0,
      canceled_at: canceledAt,
      grace_ends_at: graceEndsAt,
      pending_plan_key: pendingPlanKey,
      pending_plan_effective_at: pendingPlanEffectiveAt,
      last_provider_event_at: event.providerEventAt,
      updated_at: nowMs,
    });
    sub = stmts.getBillingSubscriptionById.get(sub.id);
  }

  return { subscription: sub, outcome: 'applied' };
}

/**
 * Point d'entrée principal : claim → apply → sync entitlement → mark processed.
 *
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   stmts: ReturnType<import('../../database/db.js')['prepareStatements']>,
 *   event: Partial<NormalizedBillingEvent>,
 *   nowMs?: number,
 *   crashAfter?: null | 'claim' | 'subscription' | 'entitlement' | 'before_processed',
 * }} p
 */
export function processNormalizedBillingEvent(p) {
  const nowMs = p.nowMs ?? Date.now();
  let validated;
  try {
    validated = validateNormalizedBillingEvent(p.event);
  } catch (err) {
    if (err instanceof ConfigWriteError) {
      return {
        ok: false,
        duplicate: false,
        terminal: true,
        errorCode: err.code,
        message: err.message,
      };
    }
    throw err;
  }

  const payloadHash = hashBillingPayload({
    type: validated.eventType,
    guild: validated.guildId,
    sub: validated.providerSubscriptionId,
    plan: validated.planKey,
    interval: validated.interval,
    status: validated.status,
    cps: validated.currentPeriodStart,
    cpe: validated.currentPeriodEnd,
    at: validated.providerEventAt,
  });

  // Duplicate already finalized?
  const existing = p.stmts.getBillingEventByProviderIds.get(validated.provider, validated.providerEventId);
  if (existing && (existing.processing_status === 'processed' || existing.processing_status === 'ignored_stale')) {
    try {
      logger.info('billing: duplicate event', {
        provider: validated.provider,
        provider_event_id: validated.providerEventId,
        status: existing.processing_status,
      });
    } catch { /* ignore */ }
    return {
      ok: true,
      duplicate: true,
      eventId: existing.id,
      processingStatus: existing.processing_status,
      subscription: validated.providerSubscriptionId
        ? p.stmts.getBillingSubscriptionByProviderIds.get(validated.provider, validated.providerSubscriptionId)
        : null,
    };
  }

  /** @type {number | null} */
  let eventId = existing?.id ?? null;
  /** @type {string | null} */
  let guildToInvalidate = null;
  /** @type {object | null} */
  let resultSub = null;
  /** @type {string} */
  let finalStatus = 'processed';

  try {
    const run = p.db.transaction(() => {
      if (!eventId) {
        try {
          const info = p.stmts.claimBillingEvent.run({
            provider: validated.provider,
            provider_event_id: validated.providerEventId,
            event_type: validated.eventType,
            provider_event_at: validated.providerEventAt,
            guild_id: validated.guildId,
            provider_subscription_id: validated.providerSubscriptionId,
            received_at: nowMs,
            payload_hash: payloadHash,
            created_at: nowMs,
          });
          eventId = Number(info.lastInsertRowid);
        } catch (err) {
          // Race duplicate claim
          const raced = p.stmts.getBillingEventByProviderIds.get(validated.provider, validated.providerEventId);
          if (raced && (raced.processing_status === 'processed' || raced.processing_status === 'ignored_stale')) {
            return { duplicate: true, eventId: raced.id, processingStatus: raced.processing_status };
          }
          if (isSqliteBusy(err)) {
            throw new ConfigWriteError(503, 'SQLITE_BUSY', 'sqlite busy');
          }
          throw err;
        }
      }

      if (p.crashAfter === 'claim') {
        throw new ConfigWriteError(500, 'CRASH_INJECTED', 'crash after claim');
      }

      p.stmts.markBillingEventProcessing.run(eventId);

      // Full refund sans subscription locale connue → fail-safe (doublon / binding douteux)
      if (validated.eventType === 'refund.full_approved') {
        const known = p.stmts.getBillingSubscriptionByProviderIds.get(
          validated.provider,
          validated.providerSubscriptionId,
        );
        if (!known) {
          p.stmts.insertBillingAudit.run({
            guild_id: validated.guildId,
            subscription_id: null,
            event_id: eventId,
            action: 'refund.ambiguous',
            from_plan_key: null,
            to_plan_key: null,
            from_status: null,
            to_status: null,
            detail_json: JSON.stringify({
              manual_review: true,
              reason: 'full_refund_without_local_subscription',
            }),
            created_at: nowMs,
          });
          p.stmts.markBillingEventProcessed.run({
            id: eventId,
            processing_status: 'processed',
            processed_at: nowMs,
          });
          return {
            duplicate: false,
            eventId,
            processingStatus: 'processed',
            subscription: null,
            noop: true,
            ambiguous: true,
          };
        }
      }

      // No-op commercial (partial/pending/rejected/ambiguous refund, dispute.reversed) : ACK sans side-effect
      if (NOOP_EVENT_TYPES.has(validated.eventType)) {
        const existingSub = p.stmts.getBillingSubscriptionByProviderIds.get(
          validated.provider,
          validated.providerSubscriptionId,
        );
        p.stmts.insertBillingAudit.run({
          guild_id: validated.guildId,
          subscription_id: existingSub?.id ?? null,
          event_id: eventId,
          action: validated.eventType,
          from_plan_key: existingSub?.plan_key ?? null,
          to_plan_key: existingSub?.plan_key ?? null,
          from_status: existingSub?.status ?? null,
          to_status: existingSub?.status ?? null,
          detail_json: JSON.stringify({ noop: true }),
          created_at: nowMs,
        });
        p.stmts.markBillingEventProcessed.run({
          id: eventId,
          processing_status: 'processed',
          processed_at: nowMs,
        });
        return {
          duplicate: false,
          eventId,
          processingStatus: 'processed',
          subscription: existingSub,
          noop: true,
        };
      }

      const { subscription, outcome } = applyEventToSubscription(p.stmts, validated, nowMs);
      resultSub = subscription;
      guildToInvalidate = subscription.guild_id;

      if (p.crashAfter === 'subscription') {
        throw new ConfigWriteError(500, 'CRASH_INJECTED', 'crash after subscription');
      }

      if (outcome === 'ignored_stale') {
        finalStatus = 'ignored_stale';
        p.stmts.markBillingEventProcessed.run({
          id: eventId,
          processing_status: 'ignored_stale',
          processed_at: nowMs,
        });
        return { duplicate: false, eventId, processingStatus: 'ignored_stale', subscription };
      }

      const fromPlan = subscription.plan_key;
      const fromStatus = subscription.status;

      syncPaidEntitlementFromSubscription({
        db: p.db,
        stmts: p.stmts,
        subscription,
        nowMs,
        skipCacheInvalidate: true,
        alreadyInTransaction: true,
      });

      if (p.crashAfter === 'entitlement' || p.crashAfter === 'before_processed') {
        throw new ConfigWriteError(500, 'CRASH_INJECTED', 'crash before processed');
      }

      p.stmts.insertBillingAudit.run({
        guild_id: subscription.guild_id,
        subscription_id: subscription.id,
        event_id: eventId,
        action: validated.eventType,
        from_plan_key: fromPlan,
        to_plan_key: subscription.plan_key,
        from_status: fromStatus,
        to_status: subscription.status,
        detail_json: JSON.stringify({
          interval: subscription.interval,
          period_end: subscription.current_period_end,
          cancel_at_period_end: subscription.cancel_at_period_end,
          grace_ends_at: subscription.grace_ends_at,
        }),
        created_at: nowMs,
      });

      p.stmts.markBillingEventProcessed.run({
        id: eventId,
        processing_status: 'processed',
        processed_at: nowMs,
      });

      return { duplicate: false, eventId, processingStatus: 'processed', subscription };
    });

    const out = run();

    if (out.duplicate) {
      return {
        ok: true,
        duplicate: true,
        eventId: out.eventId,
        processingStatus: out.processingStatus,
        subscription: p.stmts.getBillingSubscriptionByProviderIds.get(
          validated.provider,
          validated.providerSubscriptionId,
        ),
      };
    }

    // Cache APRÈS commit
    if (guildToInvalidate && out.processingStatus === 'processed') {
      invalidateEntitlementCache(guildToInvalidate);
    }

    try {
      logger.info('billing: event processed', {
        provider: validated.provider,
        provider_event_id: validated.providerEventId,
        event_type: validated.eventType,
        guild_id: validated.guildId,
        processing_status: out.processingStatus,
      });
    } catch { /* ignore */ }

    return {
      ok: true,
      duplicate: false,
      eventId: out.eventId,
      processingStatus: out.processingStatus,
      subscription: out.subscription,
      noop: out.noop === true,
      ambiguous: out.ambiguous === true,
    };
  } catch (err) {
    const code = err instanceof ConfigWriteError ? err.code : 'INTERNAL_ERROR';
    const retryable = code === 'SQLITE_BUSY' || code === 'CRASH_INJECTED' || code === 'TEMPORARY_PROVIDER';

    if (eventId) {
      try {
        p.stmts.markBillingEventFailed.run({
          id: eventId,
          error_code: code,
          processed_at: nowMs,
        });
      } catch {
        /* ignore */
      }
    }

    try {
      logger.warn('billing: event failed', {
        provider: validated.provider,
        provider_event_id: validated.providerEventId,
        error_code: code,
        retryable,
      });
    } catch { /* ignore */ }

    return {
      ok: false,
      duplicate: false,
      terminal: !retryable,
      retryable,
      errorCode: code,
      eventId,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * @param {unknown} err
 */
export function isSqliteBusy(err) {
  if (!err || typeof err !== 'object') return false;
  const code = /** @type {{ code?: string, message?: string }} */ (err).code;
  const message = /** @type {{ message?: string }} */ (err).message ?? '';
  return code === 'SQLITE_BUSY' || /SQLITE_BUSY|database is locked/i.test(String(message));
}

/**
 * Lecture publique dashboard (sans IDs provider).
 * @param {ReturnType<import('../../database/db.js')['prepareStatements']>} stmts
 * @param {string} guildId
 */
export function getGuildBillingPublicView(stmts, guildId) {
  const id = assertValidGuildId(guildId);
  const live = stmts.getLiveBillingSubscriptionByGuild.get(id);
  const all = stmts.listBillingSubscriptionsByGuild.all(id) ?? [];
  const sub = live ?? all[all.length - 1] ?? null;
  if (!sub) {
    return {
      has_subscription: false,
      plan: null,
      billing_status: null,
      interval: null,
      current_period_end: null,
      cancel_at_period_end: false,
      grace_ends_at: null,
      pending_plan_key: null,
      pending_plan_effective_at: null,
    };
  }
  return {
    has_subscription: true,
    plan: sub.plan_key,
    billing_status: sub.status,
    interval: sub.interval,
    current_period_end: sub.current_period_end,
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
    grace_ends_at: sub.grace_ends_at,
    pending_plan_key: sub.pending_plan_key,
    pending_plan_effective_at: sub.pending_plan_effective_at,
  };
}
