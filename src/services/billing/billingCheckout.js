/**
 * Checkout intents locaux — liaison sûre guild ↔ product ↔ Paddle checkout (Phase 7B).
 */

import { ConfigWriteError } from '../configWriteError.js';
import { assertValidGuildId } from '../entitlements/entitlementStore.js';
import { isBillingProductKey, resolveBillingProduct } from './billingCatalog.js';
import { generateCheckoutIntentId, hashBinding } from './paddleBillingProvider.js';
import { BILLING_LIVE_STATUSES } from './billingTypes.js';

/** TTL intent actif (abandon checkout). */
export const CHECKOUT_INTENT_TTL_MS = 30 * 60 * 1000;

/**
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   stmts: ReturnType<import('../../database/db.js')['prepareStatements']>,
 *   guildId: string,
 *   actorUserId: string,
 *   productKey: string,
 *   expectedPriceId: string,
 *   nowMs?: number,
 * }} p
 */
export function createOrReuseCheckoutIntent(p) {
  const nowMs = p.nowMs ?? Date.now();
  const guildId = assertValidGuildId(p.guildId);
  if (!isBillingProductKey(p.productKey)) {
    throw new ConfigWriteError(400, 'UNKNOWN_PRODUCT', 'product_key invalide');
  }
  if (typeof p.actorUserId !== 'string' || !/^\d{17,20}$/.test(p.actorUserId.trim())) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'actor invalide');
  }
  if (typeof p.expectedPriceId !== 'string' || !/^pri_/i.test(p.expectedPriceId)) {
    throw new ConfigWriteError(400, 'PADDLE_PRICE_INVALID', 'price_id invalide');
  }

  const live = p.stmts.getLiveBillingSubscriptionByGuild.get(guildId);
  if (live && BILLING_LIVE_STATUSES.includes(/** @type {any} */ (live.status))) {
    throw new ConfigWriteError(409, 'CHECKOUT_CONFLICT', 'subscription live déjà présente');
  }

  const existing = p.stmts.getActiveCheckoutIntentByGuild.get(guildId, nowMs);
  if (existing) {
    if (existing.internal_product_key === p.productKey && existing.expected_price_id === p.expectedPriceId) {
      return existing;
    }
    throw new ConfigWriteError(409, 'CHECKOUT_CONFLICT', 'checkout intent actif différent');
  }

  const id = generateCheckoutIntentId();
  const expiresAt = nowMs + CHECKOUT_INTENT_TTL_MS;
  const product = resolveBillingProduct(p.productKey);
  p.stmts.insertCheckoutIntent.run({
    id,
    guild_id: guildId,
    actor_user_id: p.actorUserId.trim(),
    internal_product_key: p.productKey,
    expected_price_id: p.expectedPriceId,
    status: 'open',
    binding_hash: hashBinding(id, guildId, p.productKey),
    paddle_transaction_id: null,
    created_at: nowMs,
    expires_at: expiresAt,
  });
  void product;
  return p.stmts.getCheckoutIntentById.get(id);
}

/**
 * @param {ReturnType<import('../../database/db.js')['prepareStatements']>} stmts
 * @param {string} intentId
 * @param {number} nowMs
 */
export function assertCheckoutIntentValid(stmts, intentId, nowMs) {
  const row = stmts.getCheckoutIntentById.get(intentId);
  if (!row) {
    throw new ConfigWriteError(400, 'CHECKOUT_EXPIRED', 'intent introuvable');
  }
  if (row.status !== 'open') {
    throw new ConfigWriteError(400, 'CHECKOUT_EXPIRED', 'intent non ouvert');
  }
  if (Number(row.expires_at) < nowMs) {
    stmts.expireCheckoutIntent.run({ id: row.id, updated_at: nowMs });
    throw new ConfigWriteError(400, 'CHECKOUT_EXPIRED', 'intent expiré');
  }
  return row;
}

/**
 * Valide custom_data webhook contre intent local.
 * @param {ReturnType<import('../../database/db.js')['prepareStatements']>} stmts
 * @param {Record<string, unknown>} custom
 * @param {number} nowMs
 */
export function resolveGuildFromCheckoutCustomData(stmts, custom, nowMs) {
  const intentId = custom?.scrim_intent_id;
  const guildId = custom?.scrim_guild_id;
  const productKey = custom?.scrim_product_key;
  const binding = custom?.scrim_binding;
  if (typeof intentId !== 'string' || typeof guildId !== 'string') {
    return null;
  }
  const intent = stmts.getCheckoutIntentById.get(intentId);
  if (!intent) return null;
  if (intent.guild_id !== guildId) {
    throw new ConfigWriteError(400, 'MALFORMED_EVENT', 'custom_data guild mismatch');
  }
  if (typeof productKey === 'string' && intent.internal_product_key !== productKey) {
    throw new ConfigWriteError(400, 'MALFORMED_EVENT', 'custom_data product mismatch');
  }
  if (typeof binding === 'string' && intent.binding_hash !== binding) {
    throw new ConfigWriteError(400, 'MALFORMED_EVENT', 'custom_data binding mismatch');
  }
  // Intent peut être expiré au moment du webhook (paiement lent) — on accepte si créé < 24h
  if (Number(intent.created_at) < nowMs - 24 * 60 * 60 * 1000) {
    throw new ConfigWriteError(400, 'CHECKOUT_EXPIRED', 'intent trop ancien');
  }
  return { guildId: intent.guild_id, intentId: intent.id, productKey: intent.internal_product_key };
}
