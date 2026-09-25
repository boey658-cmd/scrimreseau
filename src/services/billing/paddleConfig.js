/**
 * Configuration Paddle Billing — SANDBOX ONLY en Phase 7B.
 *
 * LIVE INTERDIT : toute tentative de Environment.production throw.
 * Ne log jamais API key / webhook secret / client token.
 */

import { ConfigWriteError } from '../configWriteError.js';
import { BILLING_CATALOG, BILLING_PRODUCT_KEYS } from './billingCatalog.js';

/** @typedef {'sandbox'} PaddleEnvironment */

const PRICE_ENV_KEYS = Object.freeze({
  P1_MONTHLY: 'PADDLE_PRICE_P1_MONTHLY',
  P1_YEARLY: 'PADDLE_PRICE_P1_YEARLY',
  P2_MONTHLY: 'PADDLE_PRICE_P2_MONTHLY',
  P2_YEARLY: 'PADDLE_PRICE_P2_YEARLY',
  P3_MONTHLY: 'PADDLE_PRICE_P3_MONTHLY',
  P3_YEARLY: 'PADDLE_PRICE_P3_YEARLY',
});

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isPaddleBillingConfigured(env = process.env) {
  const apiKey = env.PADDLE_API_KEY?.trim();
  const webhook = env.PADDLE_WEBHOOK_SECRET?.trim();
  const client = env.PADDLE_CLIENT_TOKEN?.trim();
  return Boolean(apiKey && webhook && client);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function assertPaddleSandboxOnly(env = process.env) {
  const raw = (env.PADDLE_ENVIRONMENT ?? 'sandbox').trim().toLowerCase();
  if (raw === 'production' || raw === 'live') {
    throw new ConfigWriteError(
      500,
      'PADDLE_LIVE_FORBIDDEN',
      'Paddle Live interdit en Phase 7B — PADDLE_ENVIRONMENT=sandbox requis',
    );
  }
  if (raw !== 'sandbox') {
    throw new ConfigWriteError(500, 'PADDLE_ENV_INVALID', 'PADDLE_ENVIRONMENT doit être sandbox');
  }

  const apiKey = env.PADDLE_API_KEY?.trim() ?? '';
  // Heuristique anti-misconfig : clés live Paddle commencent souvent par pdl_live / live_
  if (/^pdl_live/i.test(apiKey) || /^live_/i.test(apiKey)) {
    throw new ConfigWriteError(
      500,
      'PADDLE_LIVE_KEY_FORBIDDEN',
      'API key ressemble à une clé Live — sandbox uniquement',
    );
  }
  const client = env.PADDLE_CLIENT_TOKEN?.trim() ?? '';
  if (client && !/^test_/i.test(client) && !/^live_/i.test(client)) {
    // Tokens Paddle.js : test_* sandbox, live_* production
  }
  if (/^live_/i.test(client)) {
    throw new ConfigWriteError(
      500,
      'PADDLE_LIVE_TOKEN_FORBIDDEN',
      'Client token Live interdit — utiliser test_* sandbox',
    );
  }
  return /** @type {PaddleEnvironment} */ ('sandbox');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Readonly<Record<string, string>>} productKey → priceId
 */
export function loadPaddlePriceMapFromEnv(env = process.env) {
  /** @type {Record<string, string>} */
  const map = {};
  for (const productKey of BILLING_PRODUCT_KEYS) {
    const envKey = PRICE_ENV_KEYS[productKey];
    const priceId = env[envKey]?.trim();
    if (priceId) {
      if (!/^pri_[a-z0-9]+$/i.test(priceId)) {
        throw new ConfigWriteError(500, 'PADDLE_PRICE_INVALID', `${envKey} format invalide`);
      }
      map[productKey] = priceId;
    }
  }
  return Object.freeze(map);
}

/**
 * Inverse priceId → productKey
 * @param {Readonly<Record<string, string>>} productToPrice
 */
export function invertPaddlePriceMap(productToPrice) {
  /** @type {Record<string, string>} */
  const inv = {};
  for (const [productKey, priceId] of Object.entries(productToPrice)) {
    if (inv[priceId]) {
      throw new ConfigWriteError(500, 'PADDLE_PRICE_DUPLICATE', 'price ID mappé deux fois');
    }
    inv[priceId] = productKey;
  }
  return Object.freeze(inv);
}

/**
 * Parse config Paddle sandbox. Si secrets absents → configured=false (code OK, sandbox réel NOT RUN).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function parsePaddleSandboxConfig(env = process.env) {
  const environment = assertPaddleSandboxOnly(env);
  const configured = isPaddleBillingConfigured(env);
  const productToPrice = loadPaddlePriceMapFromEnv(env);
  const priceToProduct = invertPaddlePriceMap(productToPrice);
  const pricesComplete = BILLING_PRODUCT_KEYS.every((k) => Boolean(productToPrice[k]));

  return Object.freeze({
    environment,
    configured,
    pricesComplete,
    apiKey: configured ? env.PADDLE_API_KEY.trim() : null,
    webhookSecret: configured ? env.PADDLE_WEBHOOK_SECRET.trim() : null,
    clientToken: configured ? env.PADDLE_CLIENT_TOKEN.trim() : null,
    productToPrice,
    priceToProduct,
    priceEnvKeys: PRICE_ENV_KEYS,
    catalog: BILLING_CATALOG,
  });
}

/**
 * Valide qu'un price Paddle (unit amount) matche le catalogue.
 * @param {string} productKey
 * @param {{ unitPriceAmount?: string | number | null, currencyCode?: string | null }} paddlePrice
 */
export function assertPaddlePriceMatchesCatalog(productKey, paddlePrice) {
  const entry = BILLING_CATALOG[productKey];
  if (!entry) {
    throw new ConfigWriteError(400, 'UNKNOWN_PRODUCT', 'product inconnu');
  }
  const currency = String(paddlePrice.currencyCode ?? '').toUpperCase();
  if (currency !== 'EUR') {
    throw new ConfigWriteError(400, 'UNSUPPORTED_CURRENCY', 'price Paddle non EUR');
  }
  const amount = Number(paddlePrice.unitPriceAmount);
  if (!Number.isInteger(amount) || amount !== entry.amountMinor) {
    throw new ConfigWriteError(400, 'PADDLE_AMOUNT_MISMATCH', 'montant catalogue ≠ price Paddle');
  }
  return entry;
}

export { PRICE_ENV_KEYS as PADDLE_PRICE_ENV_KEYS };
