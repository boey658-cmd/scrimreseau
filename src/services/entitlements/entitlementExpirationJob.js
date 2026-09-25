/**
 * Job maintenance entitlement — normalise status expired + invalide cache.
 * Les dates restent la source de vérité pour resolveEffectiveEntitlement.
 */

import { logger } from '../../utils/logger.js';
import { invalidateEntitlementCache } from './entitlementCache.js';
import { normalizeExpiredGrantStatuses } from './entitlementStore.js';

/** @type {ReturnType<typeof setInterval> | null} */
let intervalHandle = null;
let tickRunning = false;
let lastTickAt = 0;
let lastNormalized = 0;

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * @param {ReturnType<import('../../database/db.js')['prepareStatements']>} stmts
 * @param {number} [nowMs]
 */
export function runEntitlementExpirationPass(stmts, nowMs = Date.now()) {
  const result = normalizeExpiredGrantStatuses(stmts, nowMs);
  for (const guildId of result.guildIds) {
    invalidateEntitlementCache(guildId);
  }
  if (result.normalized > 0) {
    try {
      logger.info('entitlementExpirationJob: normalized', {
        normalized: result.normalized,
        guilds: result.guildIds.length,
      });
    } catch {
      /* ignore */
    }
  }
  lastTickAt = nowMs;
  lastNormalized = result.normalized;
  return result;
}

export function getEntitlementExpirationJobHealthSnapshot() {
  return {
    running: intervalHandle != null,
    tick_running: tickRunning,
    last_tick_at: lastTickAt || null,
    last_normalized: lastNormalized,
  };
}

export async function stopEntitlementExpirationJob() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  const deadline = Date.now() + 5_000;
  while (tickRunning && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * @param {import('discord.js').Client} _client
 * @param {import('better-sqlite3').Database} _db
 * @param {ReturnType<import('../../database/db.js')['prepareStatements']>} stmts
 * @param {{ intervalMs?: number }} [opts]
 */
export function startEntitlementExpirationJob(_client, _db, stmts, opts = {}) {
  if (intervalHandle) {
    logger.warn('startEntitlementExpirationJob: déjà démarré, ignoré');
    return;
  }
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  const tick = () => {
    if (tickRunning) return;
    tickRunning = true;
    try {
      runEntitlementExpirationPass(stmts, Date.now());
    } catch (err) {
      try {
        logger.error('entitlementExpirationJob tick', {
          message: err instanceof Error ? err.message : String(err),
        });
      } catch {
        /* ignore */
      }
    } finally {
      tickRunning = false;
    }
  };

  tick();
  intervalHandle = setInterval(tick, intervalMs);
  if (typeof intervalHandle.unref === 'function') {
    intervalHandle.unref();
  }
}
