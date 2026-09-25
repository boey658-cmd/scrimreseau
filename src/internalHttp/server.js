import http from 'node:http';
import { extractBearerToken, verifyInternalHttpToken } from './auth.js';
import { INTERNAL_HTTP_HOST, isInternalHttpEnabled, parseInternalHttpConfig } from './config.js';
import {
  handleGuildConfigPatch,
  isConfigWriteError,
  readJsonBodyBounded,
} from './configPatch.js';
import { fetchGuildConfig } from './configQueries.js';
import { GUILD_ID_PATTERN, parseGuildIdParam } from './guildId.js';
import { handleInstallationStatus } from './installationStatus.js';
import { fetchNetworkOverview } from './networkQueries.js';
import { fetchNetworkPartners } from './networkPartnersQueries.js';
import { fetchGuildOverview, isSqliteBusyError } from './overviewQueries.js';
import { assertActorCanReadGuildConfig, assertActorCanWriteGuildConfig } from '../services/guildConfigWriteAuthz.js';
import { buildGuildEmbedPreview } from '../services/embedPreview.js';
import {
  getGuildBillingPublicView,
  listBillingCatalogPublic,
  isMockBillingAllowed,
  mockEmitAndProcess,
} from '../services/billing/index.js';
import {
  handleBillingCheckoutPrepare,
  handleBillingPortal,
  handlePaddleWebhookTunnel,
} from './billingHttp.js';
import { assertInternalPremiumAdmin } from '../services/entitlements/entitlementGrants.js';
import { logger } from '../utils/logger.js';

const OVERVIEW_ROUTE = /^\/internal\/guilds\/([^/]+)\/overview\/?$/;
const CONFIG_ROUTE = /^\/internal\/guilds\/([^/]+)\/config\/?$/;
const EMBED_PREVIEW_ROUTE = /^\/internal\/guilds\/([^/]+)\/embed-preview\/?$/;
const BILLING_ROUTE = /^\/internal\/guilds\/([^/]+)\/billing\/?$/;
const BILLING_CHECKOUT_ROUTE = /^\/internal\/guilds\/([^/]+)\/billing\/checkout\/?$/;
const BILLING_PORTAL_ROUTE = /^\/internal\/guilds\/([^/]+)\/billing\/portal\/?$/;
const BILLING_CATALOG_ROUTE = /^\/internal\/billing\/catalog\/?$/;
const BILLING_MOCK_ROUTE = /^\/internal\/dev\/billing\/mock\/?$/;
const PADDLE_WEBHOOK_TUNNEL_ROUTE = /^\/internal\/billing\/paddle\/webhook\/?$/;
const NETWORK_OVERVIEW_ROUTE = /^\/internal\/network\/overview\/?$/;
const NETWORK_PARTNERS_ROUTE = /^\/internal\/network\/partners\/?$/;
const INSTALLATION_STATUS_ROUTE = /^\/internal\/guilds\/installation-status\/?$/;

/**
 * @param {{
 *   client?: import('discord.js').Client | null,
 *   db: import('better-sqlite3').Database,
 *   stmts?: ReturnType<import('../database/db.js')['prepareStatements']>,
 *   config?: ReturnType<typeof parseInternalHttpConfig>,
 * }} deps
 */
export function createInternalHttpRequestListener(deps) {
  const config = deps.config ?? parseInternalHttpConfig();
  if (!isInternalHttpEnabled(config)) {
    throw new Error('createInternalHttpRequestListener: HTTP interne désactivé');
  }

  /** @type {boolean} */
  let acceptingRequests = true;

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  function listener(req, res) {
    void handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'INTERNAL_ERROR' });
      }
    });
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handleRequest(req, res) {
    if (!acceptingRequests) {
      sendJson(res, 503, { error: 'service_unavailable' });
      return;
    }

    const method = req.method ?? 'GET';
    const pathname = normalizePath(req.url);

    const token = extractBearerToken(req.headers.authorization);
    if (!token || !verifyInternalHttpToken(token, config.token)) {
      // Auth avant 405 pour ne pas fuiter l'existence de routes sans bearer
      // (sauf qu'on veut 401 même pour PATCH sans token)
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (method === 'GET') {
      if (INSTALLATION_STATUS_ROUTE.test(pathname)) {
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      if (NETWORK_OVERVIEW_ROUTE.test(pathname)) {
        handleNetworkOverview(deps, res);
        return;
      }
      if (NETWORK_PARTNERS_ROUTE.test(pathname)) {
        handleNetworkPartners(deps, res);
        return;
      }
      if (BILLING_CATALOG_ROUTE.test(pathname)) {
        handleBillingCatalog(res);
        return;
      }
      const billingMatch = BILLING_ROUTE.exec(pathname);
      if (billingMatch) {
        await handleBillingGet(deps, req, res, billingMatch[1]);
        return;
      }
      const overviewMatch = OVERVIEW_ROUTE.exec(pathname);
      if (overviewMatch) {
        await handleOverview(deps, req, res, overviewMatch[1]);
        return;
      }
      const configMatch = CONFIG_ROUTE.exec(pathname);
      if (configMatch) {
        await handleConfigGet(deps, req, res, configMatch[1]);
        return;
      }
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    if (method === 'POST') {
      if (INSTALLATION_STATUS_ROUTE.test(pathname)) {
        await handleInstallationStatusPost(deps, req, res);
        return;
      }
      const previewMatch = EMBED_PREVIEW_ROUTE.exec(pathname);
      if (previewMatch) {
        await handleEmbedPreview(deps, req, res, previewMatch[1]);
        return;
      }
      if (BILLING_MOCK_ROUTE.test(pathname)) {
        await handleBillingMock(deps, req, res);
        return;
      }
      const checkoutMatch = BILLING_CHECKOUT_ROUTE.exec(pathname);
      if (checkoutMatch) {
        await handleBillingCheckoutPrepare(deps, req, res, checkoutMatch[1], sendJson);
        return;
      }
      const portalMatch = BILLING_PORTAL_ROUTE.exec(pathname);
      if (portalMatch) {
        await handleBillingPortal(deps, req, res, portalMatch[1], sendJson);
        return;
      }
      if (PADDLE_WEBHOOK_TUNNEL_ROUTE.test(pathname)) {
        await handlePaddleWebhookTunnel(deps, req, res, sendJson);
        return;
      }
      if (matchesKnownInternalRoute(pathname)) {
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    if (method === 'PATCH') {
      const configMatch = CONFIG_ROUTE.exec(pathname);
      if (!configMatch) {
        if (matchesKnownInternalRoute(pathname)) {
          sendJson(res, 405, { error: 'method_not_allowed' });
          return;
        }
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      await handleConfigPatch(deps, req, res, configMatch[1]);
      return;
    }

    if (matchesKnownInternalRoute(pathname)) {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  }

  listener.stopAccepting = () => {
    acceptingRequests = false;
  };

  return listener;
}

/**
 * @param {{
 *   client?: import('discord.js').Client | null,
 *   db: import('better-sqlite3').Database,
 *   stmts?: ReturnType<import('../database/db.js')['prepareStatements']>,
 * }} deps
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} rawGuildId
 */
async function handleConfigPatch(deps, req, res, rawGuildId) {
  const guildId = parseGuildIdParam(decodeURIComponent(rawGuildId));
  if (!guildId) {
    sendJson(res, 400, { error: 'VALIDATION_ERROR' });
    return;
  }

  try {
    const body = await readJsonBodyBounded(req);
    const result = await handleGuildConfigPatch({
      client: /** @type {import('discord.js').Client} */ (deps.client),
      db: deps.db,
      stmts: deps.stmts,
      guildId,
      body,
    });
    sendJson(res, 200, result.config);
  } catch (err) {
    if (isConfigWriteError(err)) {
      sendJson(res, err.status, { error: err.code });
      return;
    }
    if (isSqliteBusyError(err)) {
      sendJson(res, 503, { error: 'BOT_BUSY' });
      return;
    }
    sendJson(res, 500, { error: 'INTERNAL_ERROR' });
  }
}

/**
 * @param {{
 *   client?: { guilds?: { cache?: { has: (id: string) => boolean } } } | null,
 * }} deps
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleInstallationStatusPost(deps, req, res) {
  try {
    const body = await readJsonBodyBounded(req);
    const payload = handleInstallationStatus({
      client: deps.client,
      body,
    });
    sendJson(res, 200, payload);
  } catch (err) {
    if (isConfigWriteError(err)) {
      sendJson(res, err.status, { error: err.code });
      return;
    }
    sendJson(res, 500, { error: 'INTERNAL_ERROR' });
  }
}

/**
 * Trust boundary BFF (Phase 0) :
 * - Bearer = machine-to-machine (reverse-proxy / BFF local)
 * - actor_discord_user_id = identité Discord authentifiée par le BFF (jamais le frontend nu)
 * - GET config/overview : owner ∪ Admin ∪ ManageGuild (lecture)
 * - PATCH : Administrator uniquement (voir configPatch / assertActorCanWriteGuildConfig)
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string | null}
 */
function extractActorDiscordUserId(req) {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const raw = url.searchParams.get('actor_discord_user_id');
    if (typeof raw !== 'string') return null;
    const id = raw.trim();
    if (!GUILD_ID_PATTERN.test(id)) return null;
    return id;
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   client?: import('discord.js').Client | null,
 *   db: import('better-sqlite3').Database,
 *   stmts?: ReturnType<import('../database/db.js')['prepareStatements']>,
 * }} deps
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} rawGuildId
 */
async function handleOverview(deps, req, res, rawGuildId) {
  const guildId = parseGuildIdParam(decodeURIComponent(rawGuildId));
  if (!guildId) {
    sendJson(res, 400, { error: 'invalid_guild_id' });
    return;
  }

  const actorId = extractActorDiscordUserId(req);
  if (!actorId) {
    sendJson(res, 400, { error: 'VALIDATION_ERROR', message: 'actor_discord_user_id requis' });
    return;
  }

  try {
    await assertActorCanReadGuildConfig({
      client: deps.client,
      guildId,
      actorDiscordUserId: actorId,
    });
  } catch (err) {
    if (isConfigWriteError(err)) {
      try {
        logger.info('internalHttp.overview authz denied', {
          guild_id: guildId,
          actor_discord_user_id: actorId,
          code: err.code,
        });
      } catch {
        /* ignore */
      }
      sendJson(res, err.status, { error: err.code });
      return;
    }
    sendJson(res, 500, { error: 'internal_error' });
    return;
  }

  try {
    const stats = fetchGuildOverview(deps.db, guildId);
    const bot_installed = Boolean(deps.client?.guilds?.cache?.has(guildId));

    sendJson(res, 200, {
      guild_id: guildId,
      bot_installed,
      configured: stats.configured,
      published_count: stats.published_count,
      closed_count: stats.closed_count,
      recent: stats.recent,
    });
  } catch (err) {
    if (isSqliteBusyError(err)) {
      sendJson(res, 503, { error: 'service_unavailable' });
      return;
    }
    sendJson(res, 500, { error: 'internal_error' });
  }
}

/**
 * @param {{ db: import('better-sqlite3').Database }} deps
 * @param {import('node:http').ServerResponse} res
 */
function handleNetworkOverview(deps, res) {
  try {
    const payload = fetchNetworkOverview(deps.db);
    sendJson(res, 200, payload);
  } catch (err) {
    if (isSqliteBusyError(err)) {
      sendJson(res, 503, { error: 'service_unavailable' });
      return;
    }
    sendJson(res, 500, { error: 'internal_error' });
  }
}

/**
 * @param {{
 *   client?: import('discord.js').Client | null,
 *   db: import('better-sqlite3').Database,
 * }} deps
 * @param {import('node:http').ServerResponse} res
 */
function handleNetworkPartners(deps, res) {
  try {
    const payload = fetchNetworkPartners(deps.db, deps.client);
    sendJson(res, 200, payload);
  } catch (err) {
    if (isSqliteBusyError(err)) {
      sendJson(res, 503, { error: 'service_unavailable' });
      return;
    }
    sendJson(res, 500, { error: 'internal_error' });
  }
}

/**
 * @param {{
 *   client?: import('discord.js').Client | null,
 *   db: import('better-sqlite3').Database,
 *   stmts?: ReturnType<import('../database/db.js')['prepareStatements']>,
 * }} deps
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} rawGuildId
 */
async function handleConfigGet(deps, req, res, rawGuildId) {
  const guildId = parseGuildIdParam(decodeURIComponent(rawGuildId));
  if (!guildId) {
    sendJson(res, 400, { error: 'invalid_guild_id' });
    return;
  }

  const actorId = extractActorDiscordUserId(req);
  if (!actorId) {
    sendJson(res, 400, { error: 'VALIDATION_ERROR', message: 'actor_discord_user_id requis' });
    return;
  }

  try {
    await assertActorCanReadGuildConfig({
      client: deps.client,
      guildId,
      actorDiscordUserId: actorId,
    });
  } catch (err) {
    if (isConfigWriteError(err)) {
      try {
        logger.info('internalHttp.config.get authz denied', {
          guild_id: guildId,
          actor_discord_user_id: actorId,
          code: err.code,
        });
      } catch {
        /* ignore */
      }
      sendJson(res, err.status, { error: err.code });
      return;
    }
    sendJson(res, 500, { error: 'internal_error' });
    return;
  }

  try {
    const payload = fetchGuildConfig(deps.db, guildId);
    sendJson(res, 200, payload);
  } catch (err) {
    if (isSqliteBusyError(err)) {
      sendJson(res, 503, { error: 'service_unavailable' });
      return;
    }
    sendJson(res, 500, { error: 'internal_error' });
  }
}

/**
 * @param {string | undefined} rawUrl
 * @returns {string}
 */
function normalizePath(rawUrl) {
  if (!rawUrl) {
    return '/';
  }
  const pathOnly = rawUrl.split('?')[0] ?? '/';
  try {
    return decodeURIComponent(pathOnly);
  } catch {
    return pathOnly;
  }
}

/**
 * @param {string} pathname
 * @returns {boolean}
 */
function matchesKnownInternalRoute(pathname) {
  return (
    OVERVIEW_ROUTE.test(pathname)
    || CONFIG_ROUTE.test(pathname)
    || EMBED_PREVIEW_ROUTE.test(pathname)
    || BILLING_ROUTE.test(pathname)
    || BILLING_CHECKOUT_ROUTE.test(pathname)
    || BILLING_PORTAL_ROUTE.test(pathname)
    || BILLING_CATALOG_ROUTE.test(pathname)
    || BILLING_MOCK_ROUTE.test(pathname)
    || PADDLE_WEBHOOK_TUNNEL_ROUTE.test(pathname)
    || NETWORK_OVERVIEW_ROUTE.test(pathname)
    || NETWORK_PARTNERS_ROUTE.test(pathname)
    || INSTALLATION_STATUS_ROUTE.test(pathname)
  );
}

/**
 * Catalogue prix (centimes) — lecture publique interne authentifiée.
 * @param {import('node:http').ServerResponse} res
 */
function handleBillingCatalog(res) {
  sendJson(res, 200, {
    currency: 'EUR',
    products: listBillingCatalogPublic().map((p) => ({
      product_key: p.productKey,
      plan_key: p.planKey,
      interval: p.interval,
      amount_minor: p.amountMinor,
      currency: p.currency,
    })),
  });
}

/**
 * État billing guild — champs publics uniquement (pas d'IDs provider).
 * @param {{
 *   client?: import('discord.js').Client | null,
 *   db: import('better-sqlite3').Database,
 *   stmts?: ReturnType<import('../database/db.js')['prepareStatements']>,
 * }} deps
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} rawGuildId
 */
async function handleBillingGet(deps, req, res, rawGuildId) {
  const guildId = parseGuildIdParam(decodeURIComponent(rawGuildId));
  if (!guildId) {
    sendJson(res, 400, { error: 'VALIDATION_ERROR' });
    return;
  }
  if (!deps.stmts) {
    sendJson(res, 503, { error: 'service_unavailable' });
    return;
  }

  try {
    const url = new URL(req.url ?? '/', 'http://internal.local');
    const actor = url.searchParams.get('actor_discord_user_id');
    if (!actor || !/^\d{17,20}$/.test(actor)) {
      sendJson(res, 400, { error: 'VALIDATION_ERROR' });
      return;
    }
    await assertActorCanReadGuildConfig({
      client: /** @type {import('discord.js').Client} */ (deps.client),
      guildId,
      actorDiscordUserId: actor,
    });
    sendJson(res, 200, getGuildBillingPublicView(deps.stmts, guildId));
  } catch (err) {
    if (isConfigWriteError(err)) {
      sendJson(res, err.status, { error: err.code });
      return;
    }
    if (isSqliteBusyError(err)) {
      sendJson(res, 503, { error: 'SQLITE_BUSY' });
      return;
    }
    logger.warn('internalHttp.billing get failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, { error: 'INTERNAL_ERROR' });
  }
}

/**
 * Mock billing DEV/TEST + owner uniquement. Deny-by-default (ALLOW_BILLING_MOCK=1).
 * @param {{
 *   client?: import('discord.js').Client | null,
 *   db: import('better-sqlite3').Database,
 *   stmts?: ReturnType<import('../database/db.js')['prepareStatements']>,
 * }} deps
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleBillingMock(deps, req, res) {
  if (!isMockBillingAllowed()) {
    sendJson(res, 403, { error: 'FORBIDDEN' });
    return;
  }
  if (!deps.stmts) {
    sendJson(res, 503, { error: 'service_unavailable' });
    return;
  }

  try {
    const body = /** @type {Record<string, unknown>} */ (await readJsonBodyBounded(req));
    const actor = body.actor_discord_user_id;
    if (typeof actor !== 'string') {
      sendJson(res, 400, { error: 'VALIDATION_ERROR' });
      return;
    }
    assertInternalPremiumAdmin(actor);

    // Whitelist — aucun mass-assignment plan/status gratuit
    const allowed = new Set([
      'actor_discord_user_id',
      'event_type',
      'guild_id',
      'provider_subscription_id',
      'plan_key',
      'interval',
      'current_period_start',
      'current_period_end',
      'provider_event_id',
      'provider_event_at',
      'cancel_at_period_end',
      'pending_plan_key',
      'pending_plan_effective_at',
      'now_ms',
    ]);
    for (const key of Object.keys(body)) {
      if (!allowed.has(key)) {
        sendJson(res, 400, { error: 'VALIDATION_ERROR' });
        return;
      }
    }

    const result = mockEmitAndProcess({
      db: deps.db,
      stmts: deps.stmts,
      eventType: /** @type {string} */ (body.event_type),
      guildId: /** @type {string} */ (body.guild_id),
      providerSubscriptionId: /** @type {string} */ (body.provider_subscription_id),
      planKey: /** @type {string} */ (body.plan_key),
      interval: body.interval === 'year' ? 'year' : 'month',
      currentPeriodStart: /** @type {number} */ (body.current_period_start),
      currentPeriodEnd: /** @type {number} */ (body.current_period_end),
      providerEventId: /** @type {string} */ (body.provider_event_id),
      providerEventAt: /** @type {number} */ (body.provider_event_at),
      cancelAtPeriodEnd: Boolean(body.cancel_at_period_end),
      pendingPlanKey: typeof body.pending_plan_key === 'string' ? body.pending_plan_key : undefined,
      pendingPlanEffectiveAt: typeof body.pending_plan_effective_at === 'number'
        ? body.pending_plan_effective_at
        : undefined,
      nowMs: typeof body.now_ms === 'number' ? body.now_ms : undefined,
    });

    sendJson(res, result.ok ? 200 : (result.terminal ? 400 : 503), {
      ok: result.ok,
      duplicate: result.duplicate ?? false,
      error: result.errorCode ?? null,
      processing_status: result.processingStatus ?? null,
    });
  } catch (err) {
    if (isConfigWriteError(err)) {
      sendJson(res, err.status, { error: err.code });
      return;
    }
    sendJson(res, 500, { error: 'INTERNAL_ERROR' });
  }
}

/**
 * Preview embed — Administrator, feature live_preview, aucun write.
 * @param {{
 *   client?: import('discord.js').Client | null,
 *   db: import('better-sqlite3').Database,
 *   stmts?: ReturnType<import('../database/db.js')['prepareStatements']>,
 * }} deps
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} rawGuildId
 */
async function handleEmbedPreview(deps, req, res, rawGuildId) {
  const guildId = parseGuildIdParam(decodeURIComponent(rawGuildId));
  if (!guildId) {
    sendJson(res, 400, { error: 'VALIDATION_ERROR' });
    return;
  }

  try {
    const body = /** @type {Record<string, unknown>} */ (await readJsonBodyBounded(req));
    const actor = body.actor_discord_user_id;
    if (typeof actor !== 'string' || !/^\d{17,20}$/.test(actor)) {
      sendJson(res, 400, { error: 'VALIDATION_ERROR' });
      return;
    }

    // Whitelist keys only
    const allowed = new Set([
      'actor_discord_user_id',
      'request_id',
      'source',
      'color_hex',
      'emoji',
      'preset_id',
      'locale',
    ]);
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

    const preview = buildGuildEmbedPreview(deps.db, guildId, {
      color_hex: body.color_hex,
      emoji: body.emoji,
      preset_id: body.preset_id,
      locale: typeof body.locale === 'string' ? body.locale : 'fr',
      stmts: deps.stmts,
    });
    sendJson(res, 200, preview);
  } catch (err) {
    if (isConfigWriteError(err)) {
      sendJson(res, err.status, { error: err.code });
      return;
    }
    if (isSqliteBusyError(err)) {
      sendJson(res, 503, { error: 'BOT_BUSY' });
      return;
    }
    logger.warn('embed preview failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, { error: 'INTERNAL_ERROR' });
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {Record<string, unknown>} body
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/**
 * @param {{
 *   client?: import('discord.js').Client | null,
 *   db: import('better-sqlite3').Database,
 *   stmts?: ReturnType<import('../database/db.js')['prepareStatements']>,
 *   config?: ReturnType<typeof parseInternalHttpConfig>,
 *   port?: number,
 *   host?: string,
 * }} deps
 */
export function createInternalHttpServer(deps) {
  const config = deps.config ?? parseInternalHttpConfig();
  if (!isInternalHttpEnabled(config)) {
    throw new Error('createInternalHttpServer: HTTP interne désactivé');
  }

  const listener = createInternalHttpRequestListener(deps);
  const host = deps.host ?? INTERNAL_HTTP_HOST;
  const port = deps.port ?? config.port;

  const server = http.createServer(listener);

  return {
    server,
    listener,
    host,
    port,
  };
}

/**
 * @param {import('node:http').Server} server
 * @param {string} host
 * @param {number} port
 * @returns {Promise<{ host: string, port: number }>}
 */
export function listenInternalHttpServer(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve({ host: address.address, port: address.port });
      } else {
        resolve({ host, port });
      }
    });
  });
}

/**
 * @param {import('node:http').Server} server
 * @returns {Promise<void>}
 */
export function closeInternalHttpServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}
