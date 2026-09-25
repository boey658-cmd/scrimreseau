/**
 * Traitement webhook Paddle → Billing Core (Phase 7B).
 *
 * Stratégie ACK :
 * - signature invalide → 400 (pas de retry utile)
 * - skip unhandled → 200 (ACK, no-op)
 * - processed / duplicate → 200
 * - SQLITE_BUSY / Paddle retryable → 503 (Paddle retry)
 * - dispute reverse → retrieve + reconcile (jamais période inventée)
 *
 * Ne marque jamais processed avant commit Billing Core.
 */

import { ConfigWriteError } from '../configWriteError.js';
import { processNormalizedBillingEvent } from './billingCore.js';
import { reconcileSubscription } from './billingReconcile.js';
import { resolveGuildFromCheckoutCustomData } from './billingCheckout.js';
import { resolveBillingProductByPlanInterval } from './billingCatalog.js';
import { logger } from '../../utils/logger.js';

/**
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   stmts: ReturnType<import('../../database/db.js')['prepareStatements']>,
 *   provider: ReturnType<import('./paddleBillingProvider.js')['createPaddleBillingProvider']>,
 *   rawBody: string,
 *   signature: string,
 *   nowMs?: number,
 * }} p
 */
export async function processPaddleWebhook(p) {
  const nowMs = p.nowMs ?? Date.now();

  let eventData;
  try {
    eventData = await p.provider.verifyAndUnmarshal(p.rawBody, p.signature);
  } catch (err) {
    if (err instanceof ConfigWriteError && err.code === 'INVALID_SIGNATURE') {
      try {
        logger.warn('billing: paddle signature invalid', {});
      } catch { /* ignore */ }
      return { httpStatus: 400, ok: false, error: 'INVALID_SIGNATURE' };
    }
    throw err;
  }

  const normalizedOrSkip = p.provider.normalizeWebhookEvent(eventData, {
    nowMs,
    resolveGuildFromCustomData: (custom) => {
      try {
        return resolveGuildFromCheckoutCustomData(p.stmts, custom, nowMs);
      } catch (err) {
        if (err instanceof ConfigWriteError) throw err;
        return null;
      }
    },
  });

  if (normalizedOrSkip && typeof normalizedOrSkip === 'object' && 'reconcileOnly' in normalizedOrSkip && normalizedOrSkip.reconcileOnly) {
    return processDisputeReverseReconcile({
      db: p.db,
      stmts: p.stmts,
      provider: p.provider,
      marker: /** @type {any} */ (normalizedOrSkip),
      nowMs,
    });
  }

  if (normalizedOrSkip && typeof normalizedOrSkip === 'object' && 'skip' in normalizedOrSkip && normalizedOrSkip.skip) {
    try {
      logger.info('billing: paddle event skipped', {
        reason: normalizedOrSkip.reason,
        event_id: eventData?.eventId ?? eventData?.event_id ?? null,
      });
    } catch { /* ignore */ }
    return { httpStatus: 200, ok: true, skipped: true, reason: normalizedOrSkip.reason };
  }

  const result = processNormalizedBillingEvent({
    db: p.db,
    stmts: p.stmts,
    event: /** @type {any} */ (normalizedOrSkip),
    nowMs,
  });

  if (result.ok) {
    const intentId = /** @type {any} */ (normalizedOrSkip)?.rawNormalized?.intent_id;
    if (intentId && typeof intentId === 'string') {
      try {
        p.stmts.consumeCheckoutIntent.run({
          id: intentId,
          paddle_transaction_id: null,
        });
      } catch { /* ignore */ }
    }

    try {
      logger.info('billing: paddle event processed', {
        event_id: /** @type {any} */ (normalizedOrSkip).providerEventId,
        event_type: /** @type {any} */ (normalizedOrSkip).eventType,
        duplicate: result.duplicate ?? false,
        processing_status: result.processingStatus,
      });
    } catch { /* ignore */ }

    return {
      httpStatus: 200,
      ok: true,
      duplicate: result.duplicate ?? false,
      processingStatus: result.processingStatus,
    };
  }

  if (result.errorCode === 'SQLITE_BUSY' || result.errorCode === 'PADDLE_RATE_LIMITED' || result.errorCode === 'PADDLE_UNAVAILABLE') {
    return {
      httpStatus: 503,
      ok: false,
      error: result.errorCode,
    };
  }

  // Terminal malformed after signature OK — ACK 200 to avoid infinite retry storms
  try {
    logger.warn('billing: paddle event terminal failure', {
      error: result.errorCode,
      message: result.message,
    });
  } catch { /* ignore */ }

  return {
    httpStatus: result.errorCode === 'INVALID_SIGNATURE' ? 400 : 200,
    ok: false,
    error: result.errorCode ?? 'PROCESSING_FAILED',
  };
}

/**
 * chargeback_reverse : ACK reverse (noop) + retrieve Paddle + reconcile.
 * Provider timeout → 503, paid reste suspendu.
 *
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   stmts: ReturnType<import('../../database/db.js')['prepareStatements']>,
 *   provider: ReturnType<import('./paddleBillingProvider.js')['createPaddleBillingProvider']>,
 *   marker: {
 *     providerEventId: string,
 *     providerEventAt: number,
 *     guildId: string,
 *     providerSubscriptionId: string,
 *     providerCustomerId?: string,
 *     adjustmentAction?: string,
 *   },
 *   nowMs: number,
 * }} p
 */
async function processDisputeReverseReconcile(p) {
  const { marker, nowMs } = p;

  const existing = p.stmts.getBillingEventByProviderIds.get('paddle', marker.providerEventId);
  if (existing && (existing.processing_status === 'processed' || existing.processing_status === 'ignored_stale')) {
    return {
      httpStatus: 200,
      ok: true,
      duplicate: true,
      processingStatus: existing.processing_status,
    };
  }

  let remote;
  try {
    remote = await p.provider.retrieveSubscription(marker.providerSubscriptionId);
  } catch (err) {
    if (
      err instanceof ConfigWriteError
      && (err.code === 'PADDLE_UNAVAILABLE' || err.code === 'PADDLE_RATE_LIMITED' || err.status === 503)
    ) {
      try {
        logger.warn('billing: dispute reverse reconcile deferred (provider)', {
          event_id: marker.providerEventId,
          code: err.code,
        });
      } catch { /* ignore */ }
      // Ne pas ACK l’event → Paddle peut retry ; paid reste suspendu
      return { httpStatus: 503, ok: false, error: err.code, reconcile_pending: true };
    }
    try {
      logger.warn('billing: dispute reverse retrieve failed', {
        event_id: marker.providerEventId,
        message: err instanceof Error ? err.message : String(err),
      });
    } catch { /* ignore */ }
    remote = null;
  }

  const placeholder = resolveBillingProductByPlanInterval('P1', 'month');
  const reverseAck = processNormalizedBillingEvent({
    db: p.db,
    stmts: p.stmts,
    nowMs,
    event: {
      provider: 'paddle',
      providerEventId: marker.providerEventId,
      eventType: 'dispute.reversed',
      providerEventAt: marker.providerEventAt,
      guildId: marker.guildId,
      providerCustomerId: marker.providerCustomerId ?? `ctm_unknown_${marker.guildId}`,
      providerSubscriptionId: marker.providerSubscriptionId,
      planKey: placeholder.planKey,
      interval: placeholder.interval,
      productKey: placeholder.productKey,
      currentPeriodStart: marker.providerEventAt - 1,
      currentPeriodEnd: marker.providerEventAt,
      amountMinor: placeholder.amountMinor,
      currency: 'EUR',
      rawNormalized: {
        adjustment_action: marker.adjustmentAction ?? 'chargeback_reverse',
        requires_reconcile: true,
        no_invented_period: true,
        remote_retrieved: Boolean(remote),
      },
    },
  });

  if (!reverseAck.ok) {
    if (reverseAck.errorCode === 'SQLITE_BUSY') {
      return { httpStatus: 503, ok: false, error: 'SQLITE_BUSY' };
    }
    return { httpStatus: 200, ok: false, error: reverseAck.errorCode ?? 'PROCESSING_FAILED' };
  }

  if (!remote || typeof remote !== 'object') {
    return {
      httpStatus: 200,
      ok: true,
      processingStatus: 'processed',
      reconcile: 'missing_remote_keep_suspended',
    };
  }

  try {
    const out = reconcileSubscription({
      db: p.db,
      stmts: p.stmts,
      provider: 'paddle',
      providerSubscriptionId: marker.providerSubscriptionId,
      providerState: {
        guildId: remote.guildId ?? marker.guildId,
        planKey: remote.planKey,
        interval: remote.interval,
        status: remote.status,
        currentPeriodStart: remote.currentPeriodStart,
        currentPeriodEnd: remote.currentPeriodEnd,
        cancelAtPeriodEnd: remote.cancelAtPeriodEnd,
        graceEndsAt: remote.graceEndsAt ?? null,
        pendingPlanKey: remote.pendingPlanKey ?? null,
        pendingPlanEffectiveAt: remote.pendingPlanEffectiveAt ?? null,
        providerEventAt: Math.max(marker.providerEventAt, remote.providerEventAt ?? nowMs),
      },
      nowMs,
    });
    try {
      logger.info('billing: dispute reverse reconciled', {
        event_id: marker.providerEventId,
        repaired: out.repaired,
        remote_status: remote.status,
      });
    } catch { /* ignore */ }
    return {
      httpStatus: 200,
      ok: true,
      processingStatus: 'processed',
      reconcile: out.repaired ? 'repaired' : 'matched',
      remote_status: remote.status,
    };
  } catch (err) {
    if (err instanceof ConfigWriteError && err.code === 'SQLITE_BUSY') {
      return { httpStatus: 503, ok: false, error: 'SQLITE_BUSY' };
    }
    throw err;
  }
}
