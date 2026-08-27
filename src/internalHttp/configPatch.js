/**
 * Parse + orchestration PATCH /internal/guilds/:guildId/config (Web5B).
 */

import { prepareStatements } from '../database/db.js';
import { ConfigWriteError, isConfigWriteError } from '../services/configWriteError.js';
import { assertActorCanManageGuildConfig } from '../services/guildConfigWriteAuthz.js';
import { applyGuildConfigSectionWrite } from '../services/guildConfigWrites.js';
import { isSqliteBusyError } from './overviewQueries.js';
import { parseGuildIdParam, GUILD_ID_PATTERN } from './guildId.js';
import { logger } from '../utils/logger.js';

export const CONFIG_PATCH_MAX_BODY_BYTES = 32 * 1024;

const SECTIONS = new Set([
  'language',
  'reception_channel',
  'command_channel',
  'inactive_message_policy',
  'structure_link',
  'command_permissions',
]);

/** Clés autorisées par section (en plus de actor/request_id/source/section). */
const SECTION_KEYS = {
  language: new Set(['language']),
  reception_channel: new Set(['channel_id']),
  command_channel: new Set(['channel_id']),
  inactive_message_policy: new Set(['policy']),
  structure_link: new Set(['url']),
  command_permissions: new Set(['mode', 'role_ids']),
};

const BASE_KEYS = new Set([
  'actor_discord_user_id',
  'request_id',
  'source',
  'section',
]);

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<unknown>}
 */
export function readJsonBodyBounded(req, maxBytes = CONFIG_PATCH_MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers['content-type'] ?? '');
    if (!contentType.toLowerCase().includes('application/json')) {
      reject(new ConfigWriteError(400, 'VALIDATION_ERROR', 'Content-Type application/json requis'));
      return;
    }

    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        reject(new ConfigWriteError(400, 'VALIDATION_ERROR', 'body trop volumineux'));
        // Drainer sans destroy immédiat : laisse le handler envoyer 400.
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        reject(new ConfigWriteError(400, 'VALIDATION_ERROR', 'JSON invalide'));
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ConfigWriteError(400, 'VALIDATION_ERROR', 'JSON invalide'));
      }
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * @param {unknown} body
 * @returns {{
 *   actorDiscordUserId: string,
 *   requestId: string,
 *   source: string,
 *   section: string,
 *   patch: Record<string, unknown>,
 * }}
 */
export function parseConfigPatchBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'body objet requis');
  }

  /** @type {Record<string, unknown>} */
  const obj = /** @type {Record<string, unknown>} */ (body);
  const keys = Object.keys(obj);

  const actor = obj.actor_discord_user_id;
  if (typeof actor !== 'string' || !GUILD_ID_PATTERN.test(actor.trim())) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'actor_discord_user_id invalide');
  }

  const requestId = obj.request_id;
  if (typeof requestId !== 'string' || !requestId.trim()) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'request_id invalide');
  }

  const source = obj.source;
  if (source !== 'web') {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'source invalide');
  }

  const section = obj.section;
  if (typeof section !== 'string' || !SECTIONS.has(section)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'section invalide');
  }

  const allowed = SECTION_KEYS[/** @type {keyof typeof SECTION_KEYS} */ (section)];
  for (const key of keys) {
    if (BASE_KEYS.has(key)) continue;
    if (!allowed.has(key)) {
      throw new ConfigWriteError(400, 'VALIDATION_ERROR', `champ interdit: ${key}`);
    }
  }

  // Une seule section : pas de second discriminant
  for (const other of SECTIONS) {
    if (other === section) continue;
    // pas de champs croisés déjà couverts par allowed
  }

  return {
    actorDiscordUserId: actor.trim(),
    requestId: requestId.trim(),
    source,
    section,
    patch: obj,
  };
}

/**
 * @param {{
 *   client: import('discord.js').Client,
 *   db: import('better-sqlite3').Database,
 *   stmts?: ReturnType<import('../database/db.js')['prepareStatements']>,
 *   guildId: string,
 *   body: unknown,
 * }} p
 */
export async function handleGuildConfigPatch(p) {
  const guildId = parseGuildIdParam(p.guildId);
  if (!guildId) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'guild_id invalide');
  }

  const parsed = parseConfigPatchBody(p.body);
  const stmts = p.stmts ?? prepareStatements(p.db);

  if (!p.client) {
    throw new ConfigWriteError(503, 'BOT_UNAVAILABLE');
  }

  const guild = await assertActorCanManageGuildConfig({
    client: p.client,
    guildId,
    actorDiscordUserId: parsed.actorDiscordUserId,
  });

  try {
    const result = await applyGuildConfigSectionWrite(
      {
        client: p.client,
        guild,
        db: p.db,
        stmts,
        guildId,
        actorDiscordUserId: parsed.actorDiscordUserId,
      },
      parsed.patch,
    );

    try {
      logger.event('internalHttp.config.patch', {
        source: parsed.source,
        guild_id: guildId,
        actor_discord_user_id: parsed.actorDiscordUserId,
        section: parsed.section,
        request_id: parsed.requestId,
        noop: result.noop,
        outcome: 'ok',
      });
    } catch {
      /* ignore */
    }

    return result;
  } catch (err) {
    if (isConfigWriteError(err)) {
      try {
        logger.event('internalHttp.config.patch', {
          source: parsed.source,
          guild_id: guildId,
          actor_discord_user_id: parsed.actorDiscordUserId,
          section: parsed.section,
          request_id: parsed.requestId,
          noop: false,
          outcome: err.code,
        });
      } catch {
        /* ignore */
      }
      throw err;
    }
    if (isSqliteBusyError(err)) {
      throw new ConfigWriteError(503, 'BOT_BUSY');
    }
    throw new ConfigWriteError(500, 'INTERNAL_ERROR');
  }
}

export { isConfigWriteError, ConfigWriteError };
