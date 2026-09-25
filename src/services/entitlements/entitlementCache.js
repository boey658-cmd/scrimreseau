/**
 * Cache court TTL par guildId pour snapshots entitlement.
 *
 * Plafond TTL = 30s, mais expiration réelle :
 *   min(now + TTL, nextEntitlementTransitionAt)
 *
 * Les frontières temporelles (starts_at / ends_at / grace_ends_at) priment
 * toujours sur le TTL — aucun Premium stale après une frontière.
 *
 * Fail-safe : miss → resolve ; erreur résolution → FREE ;
 * erreur calcul transition → n'écrit pas de cache long (expire immédiat).
 */

import { logger } from '../../utils/logger.js';
import { listGrantsForGuild } from './entitlementStore.js';
import { resolveEffectiveEntitlement, syntheticFreeSnapshot } from './entitlementResolver.js';

/** @type {Map<string, { expiresAt: number, snapshot: import('./entitlementResolver.js').EffectiveEntitlementSnapshot }>} */
const cache = new Map();

export const ENTITLEMENT_CACHE_TTL_MS = 30_000;
const DEFAULT_TTL_MS = ENTITLEMENT_CACHE_TTL_MS;

/** @type {ReturnType<import('../../database/db.js')['prepareStatements']> | null} */
let stmtsRef = null;

/**
 * Branche les stmts globaux (bot ready / tests).
 * @param {ReturnType<import('../../database/db.js')['prepareStatements']> | null} stmts
 */
export function bindEntitlementStore(stmts) {
  stmtsRef = stmts;
  clearEntitlementCache();
}

export function getBoundEntitlementStmts() {
  return stmtsRef;
}

/**
 * @param {string} guildId
 */
export function invalidateEntitlementCache(guildId) {
  if (guildId == null) return;
  cache.delete(String(guildId));
  try {
    logger.info('entitlementCache: invalidated', { guild_id: String(guildId) });
  } catch {
    /* ignore */
  }
}

export function clearEntitlementCache() {
  cache.clear();
}

/**
 * Prochaine frontière temporelle (> nowMs) capable de modifier le plan effectif.
 * Considère tous les grants non-revoked : starts_at, ends_at, grace_ends_at (paid/manual).
 *
 * @param {Array<import('./entitlementStore.js').EntitlementGrantRow | null | undefined>} grants
 * @param {number} nowMs
 * @returns {number | null} epoch ms, ou null si aucune frontière future
 */
export function computeNextEntitlementTransitionAt(grants, nowMs) {
  if (!Array.isArray(grants) || !Number.isFinite(nowMs)) return null;

  /** @type {number | null} */
  let next = null;

  const consider = (ts) => {
    if (!Number.isFinite(ts) || ts <= nowMs) return;
    next = next == null ? ts : Math.min(next, ts);
  };

  for (const grant of grants) {
    if (!grant || grant.status === 'revoked') continue;

    const startsAt = Number(grant.starts_at);
    const endsAt = Number(grant.ends_at);
    const graceEndsAt = grant.grace_ends_at != null ? Number(grant.grace_ends_at) : NaN;

    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
      continue;
    }

    consider(startsAt);
    consider(endsAt);

    if (
      (grant.source === 'paid' || grant.source === 'manual')
      && Number.isFinite(graceEndsAt)
    ) {
      consider(graceEndsAt);
    }
  }

  return next;
}

/**
 * Expiration cache : min(now + ttl, prochaine frontière).
 * Fail-closed : si calcul impossible → nowMs (pas de prolongation Premium).
 *
 * @param {Array<import('./entitlementStore.js').EntitlementGrantRow>} grants
 * @param {number} nowMs
 * @param {number} [ttlMs]
 * @returns {number}
 */
export function computeEntitlementCacheExpiresAt(grants, nowMs, ttlMs = DEFAULT_TTL_MS) {
  try {
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;
    const ceiling = nowMs + ttl;
    const nextAt = computeNextEntitlementTransitionAt(grants, nowMs);
    if (nextAt == null) return ceiling;
    if (!Number.isFinite(nextAt)) return nowMs;
    if (nextAt <= nowMs) return nowMs;
    return Math.min(ceiling, nextAt);
  } catch {
    return nowMs;
  }
}

/**
 * @param {string | null | undefined} guildId
 * @param {{ nowMs?: number, ttlMs?: number, stmts?: typeof stmtsRef }} [opts]
 * @returns {import('./entitlementResolver.js').EffectiveEntitlementSnapshot}
 */
export function getCachedEffectiveEntitlement(guildId, opts = {}) {
  try {
    const nowMs = opts.nowMs ?? Date.now();
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const stmts = opts.stmts ?? stmtsRef;
    const key = guildId == null ? '' : String(guildId);

    if (key) {
      const hit = cache.get(key);
      if (hit && hit.expiresAt > nowMs) {
        return hit.snapshot;
      }
    }

    const snapshot = resolveEffectiveEntitlement(stmts, guildId, nowMs);

    if (key) {
      let expiresAt = nowMs;
      try {
        if (stmts) {
          const grants = listGrantsForGuild(stmts, key);
          expiresAt = computeEntitlementCacheExpiresAt(grants, nowMs, ttlMs);
        } else {
          // Pas de stmts : snapshot FREE — TTL standard sans prolongation Premium
          expiresAt = nowMs + (Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS);
        }
      } catch (err) {
        // Fail-closed : ne pas cacher longtemps un éventuel Premium
        expiresAt = nowMs;
        try {
          logger.warn('entitlementCache: transition calc failed — no long cache', {
            guild_id: key,
            message: err instanceof Error ? err.message : String(err),
          });
        } catch {
          /* ignore */
        }
      }

      // expiresAt === nowMs ⇒ entrée morte immédiatement (re-resolve au prochain appel)
      if (expiresAt > nowMs) {
        cache.set(key, { expiresAt, snapshot });
      } else {
        cache.delete(key);
      }
    }

    return snapshot;
  } catch (err) {
    try {
      logger.warn('entitlementCache: fallback FREE', {
        guild_id: guildId ?? null,
        message: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* ignore */
    }
    return syntheticFreeSnapshot(guildId ?? '');
  }
}

/** @internal tests */
export function _entitlementCacheSize() {
  return cache.size;
}

/**
 * @internal tests
 * @param {string} guildId
 * @returns {{ expiresAt: number, snapshot: import('./entitlementResolver.js').EffectiveEntitlementSnapshot } | undefined}
 */
export function _getEntitlementCacheEntry(guildId) {
  return cache.get(String(guildId));
}
