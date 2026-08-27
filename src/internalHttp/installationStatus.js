/**
 * POST /internal/guilds/installation-status — batch bot_installed (cache only).
 * Aucun SQLite, aucun Discord REST.
 */

import { ConfigWriteError } from '../services/configWriteError.js';
import { GUILD_ID_PATTERN } from './guildId.js';
import { logger } from '../utils/logger.js';

export const INSTALLATION_STATUS_MAX_GUILD_IDS = 200;

/**
 * @param {unknown} body
 * @returns {string[]} guild ids dédupliqués (ordre d'entrée conservé)
 */
export function parseInstallationStatusBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'body objet requis');
  }

  /** @type {Record<string, unknown>} */
  const obj = /** @type {Record<string, unknown>} */ (body);
  const keys = Object.keys(obj);
  if (keys.length !== 1 || keys[0] !== 'guild_ids') {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'guild_ids requis uniquement');
  }

  if (!('guild_ids' in obj)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'guild_ids absent');
  }

  const raw = obj.guild_ids;
  if (!Array.isArray(raw)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'guild_ids non-array');
  }

  if (raw.length > INSTALLATION_STATUS_MAX_GUILD_IDS) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'trop de guild_ids');
  }

  /** @type {string[]} */
  const out = [];
  const seen = new Set();

  for (const item of raw) {
    if (typeof item !== 'string' || !GUILD_ID_PATTERN.test(item.trim())) {
      throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'snowflake invalide');
    }
    const id = item.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }

  return out;
}

/**
 * Source de vérité : client.guilds.cache.has uniquement.
 *
 * @param {{
 *   client?: { guilds?: { cache?: { has: (id: string) => boolean } } } | null,
 * }} deps
 * @param {string[]} guildIds
 * @returns {{ guilds: Array<{ guild_id: string, bot_installed: boolean }> }}
 */
export function resolveInstallationStatus(deps, guildIds) {
  const cache = deps.client?.guilds?.cache;
  if (!cache || typeof cache.has !== 'function') {
    throw new ConfigWriteError(503, 'service_unavailable', 'client/cache indisponible');
  }

  return {
    guilds: guildIds.map((guild_id) => ({
      guild_id,
      bot_installed: Boolean(cache.has(guild_id)),
    })),
  };
}

/**
 * @param {{
 *   client?: { guilds?: { cache?: { has: (id: string) => boolean } } } | null,
 *   body: unknown,
 * }} p
 */
export function handleInstallationStatus(p) {
  const guildIds = parseInstallationStatusBody(p.body);
  const payload = resolveInstallationStatus({ client: p.client }, guildIds);

  try {
    logger.event('internalHttp.installation_status', {
      guild_id_count: guildIds.length,
      outcome: 'ok',
    });
  } catch {
    /* ignore */
  }

  return payload;
}
