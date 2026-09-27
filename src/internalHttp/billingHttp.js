/**
 * Routes billing internes bot (Phase 7B) — checkout / portal / paddle webhook tunnel.
 */

import { ConfigWriteError } from '../services/configWriteError.js';
import {
  getGuildBillingPublicView,
  listBillingCatalogPublic,
  parsePaddleSandboxConfig,
  createPaddleBillingProvider,
  createOrReuseCheckoutIntent,
  processPaddleWebhook,
  isPaddleBillingConfigured,
} from '../services/billing/index.js';
import { assertActorCanWriteGuildConfig } from '../services/guildConfigWriteAuthz.js';
import { parseGuildIdParam } from './guildId.js';
import { readJsonBodyBounded } from './configPatch.js';
import { logger } from '../utils/logger.js';

const PADDLE_WEBHOOK_MAX_BYTES = 256 * 1024;

/** @type {ReturnType<typeof createPaddleBillingProvider> | null} */
let cachedProvider = null;

function getPaddleProvider() {
  const config = parsePaddleSandboxConfig();
  if (!cachedProvider) {
    cachedProvider = createPaddleBillingProvider(config);
  }
  return { provider: cachedProvider, config };
}

/**
 * Reset cache (tests).
 */
export function resetPaddleProviderCache() {
  cachedProvider = null;
}

/**
 * @param {{
 *   client?: import('discord.js').Client | null,
 *   db: import('better-sqlite3').Database,
 *   stmts: ReturnType<import('../database/db.js')['prepareStatements']>,
 * }} deps
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} rawGuildId
 * @param {(res: import('node:http').ServerResponse, status: number, body: object) => void} sendJson
 */
export async function handleBillingCheckoutPrepare(deps, req, res, rawGuildId, sendJson) {
  const guildId = parseGuildIdParam(decodeURIComponent(rawGuildId));
  if (!guildId) {
    sendJson(res, 400, { error: 'VALIDATION_ERROR' });
    return;
  }
  if (!isPaddleBillingConfigured()) {
    sendJson(res, 503, { error: 'PADDLE_NOT_CONFIGURED' });
    return;
  }

  try {
    const body = /** @type {Record<string, unknown>} */ (await readJsonBodyBounded(req));
    const actor = body.actor_discord_user_id;
    const productKey = body.product_key;
    if (typeof actor !== 'string' || typeof productKey !== 'string') {
      sendJson(res, 400, { error: 'VALIDATION_ERROR' });
      return;
    }
    const allowed = new Set(['actor_discord_user_id', 'product_key', 'request_id']);
    for (const key of Object.keys(body)) {
      if (!allowed.has(key)) {
        sendJson(res, 400, { error: 'VALIDATION_ERROR' });
        return;
      }
    }

    await assertActorCanWriteGuildConfig({
      client: /** @type {import('discord.js').Client} */ (deps.client),
      guildId,
      actorDiscordUserId: actor,
    });

    const { provider, config } = getPaddleProvider();
    if (!config.pricesComplete) {
      sendJson(res, 503, { error: 'PADDLE_PRICE_MAP_INCOMPLETE' });
      return;
    }

    const priceId = config.productToPrice[productKey];
    if (!priceId) {
      sendJson(res, 400, { error: 'UNKNOWN_PRODUCT' });
      return;
    }

    try {
      await provider.assertProductPriceMatchesCatalog(productKey);
    } catch (err) {
      if (err instanceof ConfigWriteError) {
        sendJson(res, err.status, { error: err.code });
        return;
      }
      throw err;
    }

    const intent = createOrReuseCheckoutIntent({
      db: deps.db,
      stmts: deps.stmts,
      guildId,
      actorUserId: actor,
      productKey,
      expectedPriceId: priceId,
    });

    const checkout = provider.createCheckout({
      guildId,
      productKey,
      intentId: intent.id,
      actorUserId: actor,
    });

    sendJson(res, 200, {
      intent_id: intent.id,
      expires_at: intent.expires_at,
      ...checkout,
      // Ne pas exposer de secrets hors clientToken sandbox
    });
  } catch (err) {
    if (err instanceof ConfigWriteError) {
      sendJson(res, err.status, { error: err.code });
      return;
    }
    logger.warn('billing checkout prepare failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, { error: 'INTERNAL_ERROR' });
  }
}

/**
 * @param {Parameters<typeof handleBillingCheckoutPrepare>[0]} deps
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} rawGuildId
 * @param {(res: import('node:http').ServerResponse, status: number, body: object) => void} sendJson
 */
export async function handleBillingPortal(deps, req, res, rawGuildId, sendJson) {
  const guildId = parseGuildIdParam(decodeURIComponent(rawGuildId));
  if (!guildId) {
    sendJson(res, 400, { error: 'VALIDATION_ERROR' });
    return;
  }
  if (!isPaddleBillingConfigured()) {
    sendJson(res, 503, { error: 'PADDLE_NOT_CONFIGURED' });
    return;
  }

  try {
    const body = /** @type {Record<string, unknown>} */ (await readJsonBodyBounded(req));
    const actor = body.actor_discord_user_id;
    if (typeof actor !== 'string') {
      sendJson(res, 400, { error: 'VALIDATION_ERROR' });
      return;
    }
    await assertActorCanWriteGuildConfig({
      client: /** @type {import('discord.js').Client} */ (deps.client),
      guildId,
      actorDiscordUserId: actor,
    });

    const sub = deps.stmts.getLiveBillingSubscriptionByGuild.get(guildId)
      ?? deps.stmts.listBillingSubscriptionsByGuild.all(guildId).at(-1);
    if (!sub || sub.provider !== 'paddle') {
      sendJson(res, 404, { error: 'NOT_FOUND' });
      return;
    }
    const customer = deps.stmts.getBillingCustomerById.get(sub.customer_id);
    if (!customer) {
      sendJson(res, 404, { error: 'NOT_FOUND' });
      return;
    }

    const { provider } = getPaddleProvider();
    const portal = await provider.createPortal({
      customerId: customer.provider_customer_id,
      subscriptionId: sub.provider_subscription_id,
    });
    // URL temporaire — ne pas logger
    sendJson(res, 200, { url: portal.url });
  } catch (err) {
    if (err instanceof ConfigWriteError) {
      sendJson(res, err.status, { error: err.code });
      return;
    }
    sendJson(res, 500, { error: 'INTERNAL_ERROR' });
  }
}

/**
 * Tunnel webhook : BFF envoie { raw_body, paddle_signature }.
 * @param {Parameters<typeof handleBillingCheckoutPrepare>[0]} deps
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {(res: import('node:http').ServerResponse, status: number, body: object) => void} sendJson
 */
export async function handlePaddleWebhookTunnel(deps, req, res, sendJson) {
  if (!isPaddleBillingConfigured()) {
    sendJson(res, 503, { error: 'PADDLE_NOT_CONFIGURED' });
    return;
  }

  try {
    const body = /** @type {Record<string, unknown>} */ (
      await readJsonBodyBounded(req, PADDLE_WEBHOOK_MAX_BYTES)
    );
    const rawBody = body.raw_body;
    const signature = body.paddle_signature;
    if (typeof rawBody !== 'string' || typeof signature !== 'string') {
      sendJson(res, 400, { error: 'VALIDATION_ERROR' });
      return;
    }
    if (Buffer.byteLength(rawBody, 'utf8') > PADDLE_WEBHOOK_MAX_BYTES) {
      sendJson(res, 400, { error: 'VALIDATION_ERROR' });
      return;
    }

    const { provider } = getPaddleProvider();
    const result = await processPaddleWebhook({
      db: deps.db,
      stmts: deps.stmts,
      provider,
      rawBody,
      signature,
    });
    sendJson(res, result.httpStatus, {
      ok: result.ok,
      skipped: result.skipped ?? false,
      duplicate: result.duplicate ?? false,
      error: result.error ?? null,
    });
  } catch (err) {
    if (err instanceof ConfigWriteError) {
      sendJson(res, err.status, { error: err.code });
      return;
    }
    sendJson(res, 500, { error: 'INTERNAL_ERROR' });
  }
}

export { listBillingCatalogPublic, getGuildBillingPublicView };
