import http from 'node:http';
import { extractBearerToken, verifyInternalHttpToken } from './auth.js';
import { INTERNAL_HTTP_HOST, isInternalHttpEnabled, parseInternalHttpConfig } from './config.js';
import { parseGuildIdParam } from './guildId.js';
import { fetchGuildOverview, isSqliteBusyError } from './overviewQueries.js';

const OVERVIEW_ROUTE = /^\/internal\/guilds\/([^/]+)\/overview\/?$/;

/**
 * @param {{
 *   client?: { guilds?: { cache?: { has: (id: string) => boolean } } } | null,
 *   db: import('better-sqlite3').Database,
 *   config?: ReturnType<typeof parseInternalHttpConfig>,
 *   now?: () => number,
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
    if (!acceptingRequests) {
      sendJson(res, 503, { error: 'service_unavailable' });
      return;
    }

    const method = req.method ?? 'GET';
    const pathname = normalizePath(req.url);

    if (method !== 'GET') {
      if (matchesKnownInternalRoute(pathname)) {
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    const token = extractBearerToken(req.headers.authorization);
    if (!token || !verifyInternalHttpToken(token, config.token)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    const overviewMatch = OVERVIEW_ROUTE.exec(pathname);
    if (!overviewMatch) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    const guildId = parseGuildIdParam(decodeURIComponent(overviewMatch[1]));
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

  listener.stopAccepting = () => {
    acceptingRequests = false;
  };

  return listener;
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
  return OVERVIEW_ROUTE.test(pathname);
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
 *   client?: { guilds?: { cache?: { has: (id: string) => boolean } } } | null,
 *   db: import('better-sqlite3').Database,
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
