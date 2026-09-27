/**
 * Paddle Billing Provider (Phase 7B) — SANDBOX ONLY.
 *
 * Paddle SDK → normalize → Billing Core.
 * Aucune écriture directe entitlement_grants / features.
 *
 * PCI : aucun numéro de carte stocké.
 */

import { createHash, randomBytes } from 'node:crypto';
import { Paddle, Environment } from '@paddle/paddle-node-sdk';
import { ConfigWriteError } from '../configWriteError.js';
import { resolveBillingProduct } from './billingCatalog.js';
import {
  assertPaddleSandboxOnly,
  parsePaddleSandboxConfig,
  assertPaddlePriceMatchesCatalog,
} from './paddleConfig.js';
import { BILLING_GRACE_MS } from './billingTypes.js';
import { logger } from '../../utils/logger.js';

/**
 * @typedef {import('./billingCore.js').NormalizedBillingEvent} NormalizedBillingEvent
 */

/**
 * @param {import('./paddleConfig.js').ReturnType<typeof parsePaddleSandboxConfig> | ReturnType<typeof parsePaddleSandboxConfig>} config
 * @param {{ paddleClient?: InstanceType<typeof Paddle> | null }} [deps]
 */
export function createPaddleBillingProvider(config, deps = {}) {
  assertPaddleSandboxOnly();
  if (config.environment !== 'sandbox') {
    throw new ConfigWriteError(500, 'PADDLE_LIVE_FORBIDDEN', 'sandbox only');
  }

  /** @type {InstanceType<typeof Paddle> | null} */
  let client = deps.paddleClient ?? null;

  function getClient() {
    if (client) return client;
    if (!config.configured || !config.apiKey) {
      throw new ConfigWriteError(503, 'PADDLE_NOT_CONFIGURED', 'Paddle sandbox credentials absents');
    }
    client = new Paddle(config.apiKey, {
      environment: Environment.sandbox,
    });
    return client;
  }

  /**
   * @param {string} rawBody
   * @param {string} signature
   */
  async function verifyAndUnmarshal(rawBody, signature) {
    if (!config.webhookSecret) {
      throw new ConfigWriteError(503, 'PADDLE_NOT_CONFIGURED', 'webhook secret absent');
    }
    if (typeof rawBody !== 'string' || !rawBody) {
      throw new ConfigWriteError(400, 'INVALID_SIGNATURE', 'raw body requis');
    }
    if (typeof signature !== 'string' || !signature.trim()) {
      throw new ConfigWriteError(400, 'INVALID_SIGNATURE', 'Paddle-Signature manquant');
    }
    try {
      const paddle = getClient();
      return await paddle.webhooks.unmarshal(rawBody, config.webhookSecret, signature.trim());
    } catch (err) {
      throw new ConfigWriteError(400, 'INVALID_SIGNATURE', 'signature Paddle invalide');
    }
  }

  /**
   * @param {unknown} eventData — événement Paddle unmarshalé ou fixture
   * @param {{
   *   resolveGuildFromCustomData?: (custom: Record<string, unknown>) => { guildId: string, intentId?: string | null } | null,
   *   nowMs?: number,
   * }} [opts]
   * @returns {NormalizedBillingEvent | { skip: true, reason: string } | NormalizedBillingEvent[]}
   */
  function normalizeWebhookEvent(eventData, opts = {}) {
    if (!eventData || typeof eventData !== 'object') {
      throw new ConfigWriteError(400, 'MALFORMED_EVENT', 'event Paddle null');
    }
    const ev = /** @type {Record<string, any>} */ (eventData);
    const eventType = String(ev.eventType ?? ev.event_type ?? '');
    const eventId = String(ev.eventId ?? ev.event_id ?? '');
    const occurredAt = parsePaddleTime(ev.occurredAt ?? ev.occurred_at) ?? (opts.nowMs ?? Date.now());
    const data = ev.data ?? {};

    if (!eventId) {
      throw new ConfigWriteError(400, 'MALFORMED_EVENT', 'event_id manquant');
    }

    if (eventType === 'adjustment.created' || eventType === 'adjustment.updated') {
      return normalizeAdjustment(eventId, occurredAt, data, opts, config);
    }
    if (eventType === 'transaction.completed') {
      return normalizeTransactionCompleted(eventId, occurredAt, data, opts, config);
    }
    if (eventType === 'transaction.payment_failed' || eventType === 'transaction.past_due') {
      return normalizeTransactionPaymentSignal(eventId, occurredAt, data, eventType, opts, config);
    }
    if (eventType === 'transaction.paid') {
      return { skip: true, reason: 'transaction.paid_ignored_await_completed' };
    }
    if (eventType.startsWith('subscription.')) {
      return normalizeSubscriptionEvent(eventId, occurredAt, data, eventType, opts, config);
    }
    return { skip: true, reason: `unhandled_event:${eventType}` };
  }

  /**
   * @param {string} providerSubscriptionId
   */
  async function retrieveSubscription(providerSubscriptionId) {
    const paddle = getClient();
    try {
      const sub = await paddle.subscriptions.get(providerSubscriptionId);
      return mapPaddleSubscriptionToProviderState(sub, config);
    } catch (err) {
      mapPaddleApiError(err);
    }
  }

  /**
   * @param {{ customerId: string, subscriptionId?: string | null }} input
   */
  async function createPortal(input) {
    const paddle = getClient();
    try {
      const body = input.subscriptionId
        ? { subscriptionIds: [input.subscriptionId] }
        : undefined;
      const session = await paddle.customers.createPortalSession(input.customerId, body);
      const url =
        session?.urls?.general?.overview
        ?? session?.urls?.subscriptions?.[0]?.cancelSubscription
        ?? null;
      if (!url || typeof url !== 'string') {
        throw new ConfigWriteError(502, 'PADDLE_UNAVAILABLE', 'portal URL absente');
      }
      // Ne jamais logger/cacher l'URL (token temporaire)
      return { url };
    } catch (err) {
      if (err instanceof ConfigWriteError) throw err;
      mapPaddleApiError(err);
    }
  }

  /**
   * Checkout overlay : le price ID est validé serveur ; Paddle.js ouvre le checkout.
   * createCheckout côté provider retourne les données pour le frontend (pas d'URL API obligatoire).
   * @param {{
   *   guildId: string,
   *   productKey: string,
   *   intentId: string,
   *   actorUserId: string,
   * }} input
   */
  function createCheckout(input) {
    const priceId = config.productToPrice[input.productKey];
    if (!priceId) {
      throw new ConfigWriteError(503, 'PADDLE_NOT_CONFIGURED', 'price mapping incomplet');
    }
    if (!config.clientToken) {
      throw new ConfigWriteError(503, 'PADDLE_NOT_CONFIGURED', 'client token absent');
    }
    const product = resolveBillingProduct(input.productKey);
    return {
      environment: 'sandbox',
      clientToken: config.clientToken,
      priceId,
      productKey: input.productKey,
      planKey: product.planKey,
      interval: product.interval,
      amountMinor: product.amountMinor,
      currency: 'EUR',
      customData: {
        scrim_intent_id: input.intentId,
        scrim_guild_id: input.guildId,
        scrim_product_key: input.productKey,
        // Binding opaque supplémentaire (anti-tamper soft — vérifié vs intent DB)
        scrim_binding: hashBinding(input.intentId, input.guildId, input.productKey),
      },
    };
  }

  /**
   * Vérifie via API Paddle que le price ID mappé matche le catalogue (montant + EUR).
   * Sandbox E2E : empêche un mauvais mapping env silencieux.
   * @param {string} productKey
   */
  async function assertProductPriceMatchesCatalog(productKey) {
    const priceId = config.productToPrice[productKey];
    if (!priceId) {
      throw new ConfigWriteError(503, 'PADDLE_PRICE_MAP_INCOMPLETE', 'price mapping incomplet');
    }
    const paddle = getClient();
    try {
      const price = await paddle.prices.get(priceId);
      assertPaddlePriceMatchesCatalog(productKey, {
        unitPriceAmount: price?.unitPrice?.amount,
        currencyCode: price?.unitPrice?.currencyCode,
      });
    } catch (err) {
      if (err instanceof ConfigWriteError) throw err;
      mapPaddleApiError(err);
    }
  }

  return {
    providerName: 'paddle',
    verifyAndUnmarshal,
    normalizeWebhookEvent,
    retrieveSubscription,
    createPortal,
    createCheckout,
    assertProductPriceMatchesCatalog,
    verifyWebhook: async (raw, signature) => {
      try {
        await verifyAndUnmarshal(String(raw), String(signature ?? ''));
        return true;
      } catch {
        return false;
      }
    },
    getConfigPublic() {
      return {
        environment: config.environment,
        configured: config.configured,
        pricesComplete: config.pricesComplete,
        clientTokenPresent: Boolean(config.clientToken),
      };
    },
  };
}

/**
 * @param {string} intentId
 * @param {string} guildId
 * @param {string} productKey
 */
export function hashBinding(intentId, guildId, productKey) {
  return createHash('sha256')
    .update(`${intentId}|${guildId}|${productKey}|scrim-paddle-v1`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * @param {unknown} err
 * @returns {never}
 */
function mapPaddleApiError(err) {
  const code = err && typeof err === 'object' && 'code' in err ? String(/** @type {any} */ (err).code) : '';
  const status = err && typeof err === 'object' && 'status' in err ? Number(/** @type {any} */ (err).status) : 0;
  if (status === 429 || code.includes('rate')) {
    throw new ConfigWriteError(503, 'PADDLE_RATE_LIMITED', 'Paddle rate limit');
  }
  if (status >= 500 || status === 0) {
    throw new ConfigWriteError(503, 'PADDLE_UNAVAILABLE', 'Paddle API indisponible');
  }
  throw new ConfigWriteError(400, 'MALFORMED_EVENT', 'erreur Paddle API');
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function parsePaddleTime(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value) : Math.floor(value * 1000);
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * @param {Record<string, any>} data
 * @param {{ resolveGuildFromCustomData?: Function }} opts
 */
function extractGuildContext(data, opts) {
  const custom = data.customData ?? data.custom_data ?? {};
  if (opts.resolveGuildFromCustomData) {
    const resolved = opts.resolveGuildFromCustomData(custom);
    if (resolved?.guildId) return resolved;
  }
  const guildId = custom.scrim_guild_id ?? custom.guild_id;
  const intentId = custom.scrim_intent_id ?? null;
  if (typeof guildId === 'string' && /^\d{17,20}$/.test(guildId)) {
    return { guildId, intentId };
  }
  return null;
}

/**
 * @param {string} priceId
 * @param {ReturnType<typeof parsePaddleSandboxConfig>} config
 */
function resolveProductFromPriceId(priceId, config) {
  const productKey = config.priceToProduct[priceId];
  if (!productKey) {
    throw new ConfigWriteError(400, 'UNKNOWN_PRODUCT', 'price Paddle non mappé');
  }
  return resolveBillingProduct(productKey);
}

function normalizeSubscriptionEvent(eventId, occurredAt, data, paddleEventType, opts, config) {
  const ctx = extractGuildContext(data, opts);
  if (!ctx) {
    throw new ConfigWriteError(400, 'MALFORMED_EVENT', 'guild mapping absent (custom_data)');
  }

  const items = data.items ?? [];
  if (!Array.isArray(items) || items.length !== 1) {
    throw new ConfigWriteError(400, 'MALFORMED_EVENT', 'subscription items invalides');
  }
  const priceId = items[0]?.price?.id ?? items[0]?.priceId ?? items[0]?.price_id;
  if (typeof priceId !== 'string') {
    throw new ConfigWriteError(400, 'UNKNOWN_PRODUCT', 'price_id manquant');
  }
  const product = resolveProductFromPriceId(priceId, config);

  const period = data.currentBillingPeriod ?? data.current_billing_period ?? {};
  const periodStart = parsePaddleTime(period.startsAt ?? period.starts_at) ?? occurredAt;
  const periodEnd = parsePaddleTime(period.endsAt ?? period.ends_at);
  if (!periodEnd || periodEnd <= periodStart) {
    throw new ConfigWriteError(400, 'MALFORMED_EVENT', 'billing period invalide');
  }

  const paddleStatus = String(data.status ?? '');
  const scheduled = data.scheduledChange ?? data.scheduled_change ?? null;

  let eventType = 'subscription.renewed';
  let status = 'active';
  let cancelAtPeriodEnd = false;
  let pendingPlanKey = null;
  let pendingPlanEffectiveAt = null;

  if (paddleEventType === 'subscription.created') eventType = 'subscription.created';
  if (paddleEventType === 'subscription.activated') eventType = 'subscription.created';
  if (paddleEventType === 'subscription.past_due') {
    eventType = 'payment.failed';
    status = 'past_due';
  }
  if (paddleEventType === 'subscription.canceled') {
    eventType = 'subscription.canceled';
    status = 'canceled';
    cancelAtPeriodEnd = false;
  }
  if (paddleEventType === 'subscription.paused') {
    eventType = 'subscription.paused';
    status = 'expired';
  }
  if (paddleEventType === 'subscription.trialing') {
    throw new ConfigWriteError(400, 'MALFORMED_EVENT', 'trial non supporté V1');
  }
  if (paddleStatus === 'active') status = 'active';
  if (paddleStatus === 'past_due') {
    eventType = 'payment.failed';
    status = 'past_due';
  }
  if (paddleStatus === 'canceled') {
    eventType = 'subscription.canceled';
    status = 'canceled';
  }
  if (paddleStatus === 'paused') {
    eventType = 'subscription.paused';
    status = 'expired';
  }

  // Cancel / downgrade scheduled
  if (scheduled && typeof scheduled === 'object') {
    const action = String(scheduled.action ?? '');
    const effectiveAt = parsePaddleTime(scheduled.effectiveAt ?? scheduled.effective_at);
    if (action === 'cancel') {
      cancelAtPeriodEnd = true;
      eventType = 'subscription.canceled';
      status = 'active';
    }
    if ((action === 'update' || action === 'downgrade') && effectiveAt) {
      const nextItems = scheduled.items ?? scheduled.priceId ?? null;
      // Si items futurs disponibles
      const nextPrice =
        scheduled.items?.[0]?.price?.id
        ?? scheduled.items?.[0]?.priceId
        ?? null;
      if (nextPrice) {
        const nextProduct = resolveProductFromPriceId(nextPrice, config);
        if (nextProduct.planKey !== product.planKey || nextProduct.interval !== product.interval) {
          eventType = 'subscription.downgrade_scheduled';
          pendingPlanKey = nextProduct.planKey;
          pendingPlanEffectiveAt = effectiveAt;
          // Conserve plan actuel jusqu'à effective
        }
      }
    }
  }

  return {
    provider: 'paddle',
    providerEventId: eventId,
    eventType,
    providerEventAt: occurredAt,
    guildId: ctx.guildId,
    providerCustomerId: data.customerId ?? data.customer_id ?? `ctm_unknown_${ctx.guildId}`,
    providerSubscriptionId: data.id,
    planKey: product.planKey,
    interval: product.interval,
    productKey: product.productKey,
    status,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd,
    graceEndsAt: status === 'past_due' || status === 'grace' ? periodEnd + BILLING_GRACE_MS : null,
    pendingPlanKey,
    pendingPlanEffectiveAt,
    amountMinor: product.amountMinor,
    currency: 'EUR',
    rawNormalized: {
      paddle_event: paddleEventType,
      intent_id: ctx.intentId ?? null,
    },
  };
}

/**
 * Période de facturation d'une transaction Paddle.
 * SDK notification (unmarshal) : data.billingPeriod.{startsAt,endsAt}
 * Payload brut / fixtures : data.billing_period.{starts_at,ends_at}
 * @param {Record<string, any>} data
 * @returns {{ start: number, end: number } | null}
 */
function extractTransactionBillingPeriod(data) {
  const period = data.billingPeriod ?? data.billing_period ?? null;
  if (!period || typeof period !== 'object') return null;
  const start = parsePaddleTime(period.startsAt ?? period.starts_at);
  const end = parsePaddleTime(period.endsAt ?? period.ends_at);
  if (start == null || end == null || end <= start) return null;
  return { start, end };
}

function normalizeTransactionCompleted(eventId, occurredAt, data, opts, config) {
  const ctx = extractGuildContext(data, opts);
  if (!ctx) {
    throw new ConfigWriteError(400, 'MALFORMED_EVENT', 'guild mapping absent sur transaction');
  }
  const subId = data.subscriptionId ?? data.subscription_id;
  if (!subId) {
    // Transaction sans subscription (one-shot) — ignorer pour Premium récurrent
    return { skip: true, reason: 'transaction_without_subscription' };
  }
  const items = data.items ?? [];
  const priceId = items[0]?.price?.id ?? items[0]?.priceId ?? items[0]?.price_id;
  if (typeof priceId !== 'string') {
    throw new ConfigWriteError(400, 'UNKNOWN_PRODUCT', 'price_id transaction manquant');
  }
  const product = resolveProductFromPriceId(priceId, config);
  // Ne pas comparer total TTC taxé au catalogue — uniquement price ID
  void (data.details ?? {});

  // Pas de placeholder +30j/+365j : uniquement la période Paddle réelle.
  // Si absente/invalide → skip ; subscription.* (currentBillingPeriod) ou reconcile fournira les dates.
  const billingPeriod = extractTransactionBillingPeriod(data);
  if (!billingPeriod) {
    return { skip: true, reason: 'transaction_completed_missing_billing_period' };
  }

  return {
    provider: 'paddle',
    providerEventId: eventId,
    eventType: 'subscription.created',
    providerEventAt: occurredAt,
    guildId: ctx.guildId,
    providerCustomerId: data.customerId ?? data.customer_id ?? `ctm_unknown_${ctx.guildId}`,
    providerSubscriptionId: String(subId),
    planKey: product.planKey,
    interval: product.interval,
    productKey: product.productKey,
    status: 'active',
    currentPeriodStart: billingPeriod.start,
    currentPeriodEnd: billingPeriod.end,
    cancelAtPeriodEnd: false,
    amountMinor: product.amountMinor,
    currency: 'EUR',
    rawNormalized: { from: 'transaction.completed', intent_id: ctx.intentId ?? null },
  };
}

function normalizeTransactionPaymentSignal(eventId, occurredAt, data, paddleEventType, opts, config) {
  const ctx = extractGuildContext(data, opts);
  const subId = data.subscriptionId ?? data.subscription_id;
  if (!ctx || !subId) {
    return { skip: true, reason: 'payment_signal_without_subscription' };
  }
  const items = data.items ?? [];
  const priceId = items[0]?.price?.id ?? items[0]?.priceId ?? items[0]?.price_id;
  let product = null;
  try {
    if (typeof priceId === 'string') product = resolveProductFromPriceId(priceId, config);
  } catch {
    product = null;
  }
  if (!product) {
    return { skip: true, reason: 'payment_signal_unknown_price' };
  }

  // Ne jamais tronquer la période à occurredAt (ça forçait grace immédiat).
  // Utiliser billingPeriod transaction ; sinon skip → subscription.past_due rattrape.
  const billingPeriod = extractTransactionBillingPeriod(data);
  if (!billingPeriod) {
    return { skip: true, reason: 'payment_signal_missing_billing_period' };
  }

  return {
    provider: 'paddle',
    providerEventId: eventId,
    eventType: 'payment.failed',
    providerEventAt: occurredAt,
    guildId: ctx.guildId,
    providerCustomerId: data.customerId ?? data.customer_id ?? `ctm_unknown_${ctx.guildId}`,
    providerSubscriptionId: String(subId),
    planKey: product.planKey,
    interval: product.interval,
    productKey: product.productKey,
    status: 'past_due',
    currentPeriodStart: billingPeriod.start,
    currentPeriodEnd: billingPeriod.end,
    graceEndsAt: billingPeriod.end + BILLING_GRACE_MS,
    amountMinor: product.amountMinor,
    currency: 'EUR',
    rawNormalized: { from: paddleEventType },
  };
}

function normalizeAdjustment(eventId, occurredAt, data, opts, config) {
  const action = String(data.action ?? '');
  const status = String(data.status ?? '');

  // Resolve subscription / transaction linkage
  const subId = data.subscriptionId ?? data.subscription_id
    ?? data.transactionId /* may need lookup */ ?? null;
  const ctx = extractGuildContext(data, opts);

  // Chargebacks
  if (action === 'chargeback' || action === 'chargeback_warning') {
    if (!ctx?.guildId || !data.subscriptionId && !data.subscription_id) {
      // Essayer custom / related
      throw new ConfigWriteError(400, 'MALFORMED_EVENT', 'chargeback sans guild/subscription');
    }
    const subscriptionId = data.subscriptionId ?? data.subscription_id;
    // Besoin plan — si absent, utiliser P1 placeholder + status expired (revoke)
    // Prefer items
    let product = resolveBillingProduct('P1_MONTHLY');
    try {
      const priceId = data.items?.[0]?.priceId ?? data.items?.[0]?.price_id;
      if (priceId) product = resolveProductFromPriceId(priceId, config);
    } catch { /* keep fallback */ }

    return {
      provider: 'paddle',
      providerEventId: eventId,
      eventType: 'dispute.opened',
      providerEventAt: occurredAt,
      guildId: ctx.guildId,
      providerCustomerId: data.customerId ?? data.customer_id ?? `ctm_unknown_${ctx.guildId}`,
      providerSubscriptionId: String(subscriptionId),
      planKey: product.planKey,
      interval: product.interval,
      productKey: product.productKey,
      status: 'expired',
      currentPeriodStart: occurredAt - 1,
      currentPeriodEnd: occurredAt,
      amountMinor: product.amountMinor,
      currency: 'EUR',
      rawNormalized: { adjustment_action: action, adjustment_status: status },
    };
  }

  if (action === 'chargeback_reverse' || action === 'chargeback_warning_reverse') {
    if (!ctx?.guildId) {
      throw new ConfigWriteError(400, 'MALFORMED_EVENT', 'reverse sans guild');
    }
    const subscriptionId = data.subscriptionId ?? data.subscription_id;
    if (!subscriptionId) {
      throw new ConfigWriteError(400, 'MALFORMED_EVENT', 'reverse sans subscription');
    }
    // JAMAIS inventer période / active. Le webhook processor doit retrieve+reconcile.
    return {
      reconcileOnly: true,
      provider: 'paddle',
      providerEventId: eventId,
      providerEventAt: occurredAt,
      guildId: ctx.guildId,
      providerSubscriptionId: String(subscriptionId),
      providerCustomerId: data.customerId ?? data.customer_id ?? `ctm_unknown_${ctx.guildId}`,
      adjustmentAction: action,
      adjustmentStatus: status,
    };
  }

  if (action === 'refund') {
    if (!ctx?.guildId) {
      return { skip: true, reason: 'refund_without_guild' };
    }
    const subscriptionId = data.subscriptionId ?? data.subscription_id;
    if (!subscriptionId) {
      // Refund transaction sans sub (ex. doublon) → no-op sûr
      return { skip: true, reason: 'refund_without_subscription_fail_safe' };
    }

    let product = resolveBillingProduct('P1_MONTHLY');
    let priceResolved = false;
    try {
      const priceId = data.items?.[0]?.price?.id ?? data.items?.[0]?.priceId;
      if (priceId) {
        product = resolveProductFromPriceId(priceId, config);
        priceResolved = true;
      }
    } catch { /* keep fallback */ }

    const typeRaw = typeof data.type === 'string' ? data.type.trim().toLowerCase() : '';
    const isPartial = typeRaw === 'partial' || data.partial === true
      || (Array.isArray(data.items) && data.items.some((it) => it.partial === true));
    const isFull = typeRaw === 'full';

    let eventType = 'refund.pending';
    if (status === 'rejected' || status === 'reversed') eventType = 'refund.rejected';
    else if (status === 'pending_approval' || status === 'pending') eventType = 'refund.pending';
    else if (status === 'approved') {
      if (isPartial) eventType = 'refund.partial';
      else if (isFull) eventType = 'refund.full_approved';
      else {
        // FAIL-SAFE : type absent/inconnu → pas de revoke automatique
        eventType = 'refund.ambiguous';
      }
    }

    // Full revoke seulement si binding prix fiable (évite inventer plan + kill naïf)
    if (eventType === 'refund.full_approved' && !priceResolved && !data.subscriptionId && !data.subscription_id) {
      eventType = 'refund.ambiguous';
    }

    return {
      provider: 'paddle',
      providerEventId: eventId,
      eventType,
      providerEventAt: occurredAt,
      guildId: ctx.guildId,
      providerCustomerId: data.customerId ?? data.customer_id ?? `ctm_unknown_${ctx.guildId}`,
      providerSubscriptionId: String(subscriptionId),
      planKey: product.planKey,
      interval: product.interval,
      productKey: product.productKey,
      status: eventType === 'refund.full_approved' ? 'expired' : undefined,
      currentPeriodStart: occurredAt - 1,
      currentPeriodEnd: occurredAt,
      amountMinor: product.amountMinor,
      currency: 'EUR',
      rawNormalized: {
        adjustment_id: data.id,
        adjustment_status: status,
        adjustment_type: typeRaw || null,
        is_partial: isPartial,
        is_full: isFull,
        manual_review: eventType === 'refund.ambiguous',
        transaction_id: data.transactionId ?? data.transaction_id ?? null,
      },
    };
  }

  return { skip: true, reason: `adjustment_action_unhandled:${action}` };
}

/**
 * @param {any} sub
 * @param {ReturnType<typeof parsePaddleSandboxConfig>} config
 */
export function mapPaddleSubscriptionToProviderState(sub, config) {
  const items = sub.items ?? [];
  const priceId = items[0]?.price?.id ?? items[0]?.priceId;
  if (!priceId) {
    throw new ConfigWriteError(400, 'UNKNOWN_PRODUCT', 'subscription sans price');
  }
  const product = resolveProductFromPriceId(priceId, config);
  const period = sub.currentBillingPeriod ?? sub.current_billing_period ?? {};
  const custom = sub.customData ?? sub.custom_data ?? {};
  const guildId = custom.scrim_guild_id;
  if (typeof guildId !== 'string') {
    throw new ConfigWriteError(400, 'MALFORMED_EVENT', 'subscription retrieve sans guild');
  }

  let status = 'active';
  const paddleStatus = String(sub.status ?? '');
  if (paddleStatus === 'past_due') status = 'past_due';
  if (paddleStatus === 'canceled') status = 'canceled';
  if (paddleStatus === 'paused') status = 'expired';
  if (paddleStatus === 'active') status = 'active';

  const periodStart = parsePaddleTime(period.startsAt ?? period.starts_at);
  const periodEnd = parsePaddleTime(period.endsAt ?? period.ends_at);
  if (periodStart == null || periodEnd == null || periodEnd <= periodStart) {
    throw new ConfigWriteError(400, 'MALFORMED_EVENT', 'subscription retrieve sans billing period');
  }

  return {
    guildId,
    planKey: product.planKey,
    interval: product.interval,
    status,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: Boolean(sub.scheduledChange?.action === 'cancel' || sub.scheduled_change?.action === 'cancel'),
    graceEndsAt: status === 'past_due' ? periodEnd + BILLING_GRACE_MS : null,
    providerEventAt: Date.now(),
    providerSubscriptionId: sub.id,
    providerCustomerId: sub.customerId ?? sub.customer_id,
  };
}

/**
 * Génère un id d'intent opaque.
 */
export function generateCheckoutIntentId() {
  return `bci_${randomBytes(16).toString('hex')}`;
}

export { assertPaddlePriceMatchesCatalog };
