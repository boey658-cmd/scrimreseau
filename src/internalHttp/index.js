/**
 * Serveur HTTP interne GET-only (Web2B) — localhost uniquement.
 */

import { logger } from '../utils/logger.js';
import { parseInternalHttpConfig, isInternalHttpEnabled } from './config.js';
import {
  closeInternalHttpServer,
  createInternalHttpServer,
  listenInternalHttpServer,
} from './server.js';

/** @type {import('node:http').Server | null} */
let activeServer = null;

/** @type {ReturnType<import('./server.js').createInternalHttpRequestListener> | null} */
let activeListener = null;

/**
 * @param {{
 *   client?: import('discord.js').Client | null,
 *   db: import('better-sqlite3').Database,
 *   config?: ReturnType<typeof parseInternalHttpConfig>,
 * }} deps
 * @returns {Promise<boolean>} true si démarré
 */
export async function startInternalHttpServer(deps) {
  if (activeServer) {
    return true;
  }

  const config = deps.config ?? parseInternalHttpConfig();
  if (!isInternalHttpEnabled(config)) {
    return false;
  }

  const { server, listener, host, port } = createInternalHttpServer({
    client: deps.client,
    db: deps.db,
    config,
  });

  const bound = await listenInternalHttpServer(server, host, port);
  activeServer = server;
  activeListener = listener;

  try {
    logger.info('HTTP interne démarré', {
      host: bound.host,
      port: bound.port,
    });
  } catch {
    /* ignore */
  }

  return true;
}

/**
 * @returns {Promise<void>}
 */
export async function stopInternalHttpServer() {
  if (activeListener && typeof activeListener.stopAccepting === 'function') {
    activeListener.stopAccepting();
  }

  const server = activeServer;
  activeServer = null;
  activeListener = null;

  if (!server) {
    return;
  }

  try {
    await closeInternalHttpServer(server);
    try {
      logger.info('HTTP interne arrêté', { phase: 'internal_http_stop' });
    } catch {
      /* ignore */
    }
  } catch (err) {
    try {
      logger.error('HTTP interne — échec arrêt', {
        message: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** @internal tests */
export function getInternalHttpServerForTests() {
  return activeServer;
}

export { parseInternalHttpConfig, isInternalHttpEnabled } from './config.js';
export { parseGuildIdParam, GUILD_ID_PATTERN } from './guildId.js';
export { fetchGuildOverview } from './overviewQueries.js';
export { verifyInternalHttpToken, extractBearerToken } from './auth.js';
