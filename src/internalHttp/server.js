import http from 'node:http';
import { extractBearerToken, verifyInternalHttpToken } from './auth.js';
import { INTERNAL_HTTP_HOST, isInternalHttpEnabled, parseInternalHttpConfig } from './config.js';
import {
  handleGuildConfigPatch,
  isConfigWriteError,
  readJsonBodyBounded,
} from './configPatch.js';
import { fetchGuildConfig } from './configQueries.js';
import { parseGuildIdParam } from './guildId.js';
import { handleInstallationStatus } from './installationStatus.js';
import { fetchNetworkOverview } from './networkQueries.js';
import { fetchNetworkPartners } from './networkPartnersQueries.js';
import { fetchGuildOverview, isSqliteBusyError } from './overviewQueries.js';

const OVERVIEW_ROUTE = /^\/internal\/guilds\/([^/]+)\/overview\/?$/;
const CONFIG_ROUTE = /^\/internal\/guilds\/([^/]+)\/config\/?$/;
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
      const overviewMatch = OVERVIEW_ROUTE.exec(pathname);
      if (overviewMatch) {
        handleOverview(deps, res, overviewMatch[1]);
        return;
      }
      const configMatch = CONFIG_ROUTE.exec(pathname);
      if (configMatch) {
        handleConfigGet(deps, res, configMatch[1]);
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
 * @param {{
 *   client?: { guilds?: { cache?: { has: (id: string) => boolean } } } | null,
 *   db: import('better-sqlite3').Database,
 * }} deps
 * @param {import('node:http').ServerResponse} res
 * @param {string} rawGuildId
 */
function handleOverview(deps, res, rawGuildId) {
  const guildId = parseGuildIdParam(decodeURIComponent(rawGuildId));
  if (!guildId) {
    sendJson(res, 400, { error: 'invalid_guild_id' });
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
 * @param {{ db: import('better-sqlite3').Database }} deps
 * @param {import('node:http').ServerResponse} res
 * @param {string} rawGuildId
 */
function handleConfigGet(deps, res, rawGuildId) {
  const guildId = parseGuildIdParam(decodeURIComponent(rawGuildId));
  if (!guildId) {
    sendJson(res, 400, { error: 'invalid_guild_id' });
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
    || NETWORK_OVERVIEW_ROUTE.test(pathname)
    || NETWORK_PARTNERS_ROUTE.test(pathname)
    || INSTALLATION_STATUS_ROUTE.test(pathname)
  );
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
