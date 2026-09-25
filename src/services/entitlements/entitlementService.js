/**
 * Entitlement service — Phase 1 (résolution réelle + fail-closed FREE).
 *
 * APIs stables :
 * - getPlan / getEffectivePlan
 * - getPlanDefinition
 * - getLimit
 * - canUseFeature
 * - getEntitlementSnapshot
 *
 * Invariants :
 * 1. absence grant = FREE
 * 2. erreur DB / resolver = FREE (jamais Premium accidentel)
 * 3. feature inconnue = false
 * 4. limite inconnue = 0 (sauf reception_channels fallback 1)
 * 5. aucun plan décidé par le frontend
 */

import { logger } from '../../utils/logger.js';
import {
  bindEntitlementStore,
  getBoundEntitlementStmts,
  getCachedEffectiveEntitlement,
} from './entitlementCache.js';
import { resolveEffectiveEntitlement, syntheticFreeSnapshot } from './entitlementResolver.js';
import { PLAN_FREE, resolvePlanDefinition } from './planCatalog.js';

export { bindEntitlementStore };

/**
 * @param {string | null | undefined} guildId
 * @param {{ nowMs?: number, stmts?: ReturnType<import('../../database/db.js')['prepareStatements']>, bypassCache?: boolean }} [opts]
 * @returns {import('./entitlementResolver.js').EffectiveEntitlementSnapshot}
 */
export function getEntitlementSnapshot(guildId, opts = {}) {
  try {
    const stmts = opts.stmts ?? getBoundEntitlementStmts();
    if (opts.bypassCache) {
      return resolveEffectiveEntitlement(stmts, guildId, opts.nowMs ?? Date.now());
    }
    return getCachedEffectiveEntitlement(guildId, {
      nowMs: opts.nowMs,
      stmts,
    });
  } catch (err) {
    try {
      logger.warn('entitlementService.getEntitlementSnapshot: fallback FREE', {
        guild_id: guildId ?? null,
        message: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* ignore */
    }
    return syntheticFreeSnapshot(guildId ?? '');
  }
}

/**
 * @param {string | null | undefined} guildId
 * @param {{ nowMs?: number, stmts?: any }} [opts]
 * @returns {import('./planCatalog.js').PlanKey}
 */
export function getPlan(guildId, opts = {}) {
  try {
    return getEntitlementSnapshot(guildId, opts).planKey;
  } catch (err) {
    try {
      logger.warn('entitlementService.getPlan: fallback FREE', {
        message: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* ignore */
    }
    return 'FREE';
  }
}

/** Alias explicite. */
export const getEffectivePlan = getPlan;

/**
 * @param {string | null | undefined} guildId
 * @param {{ nowMs?: number, stmts?: any }} [opts]
 */
export function getPlanDefinition(guildId, opts = {}) {
  try {
    return resolvePlanDefinition(getPlan(guildId, opts));
  } catch (err) {
    try {
      logger.warn('entitlementService.getPlanDefinition: fallback FREE', {
        guild_id: guildId ?? null,
        message: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* ignore */
    }
    return PLAN_FREE;
  }
}

/**
 * @param {string | null | undefined} guildId
 * @param {string} featureKey
 * @param {{ nowMs?: number, stmts?: any }} [opts]
 */
export function canUseFeature(guildId, featureKey, opts = {}) {
  try {
    const plan = getPlanDefinition(guildId, opts);
    if (!featureKey || typeof featureKey !== 'string') return false;
    return plan.features[featureKey] === true;
  } catch (err) {
    try {
      logger.warn('entitlementService.canUseFeature: fail-closed', {
        guild_id: guildId ?? null,
        feature: featureKey,
        message: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* ignore */
    }
    return false;
  }
}

/**
 * @param {string | null | undefined} guildId
 * @param {string} limitKey
 * @param {{ nowMs?: number, stmts?: any }} [opts]
 * @returns {number}
 */
export function getLimit(guildId, limitKey, opts = {}) {
  try {
    const plan = getPlanDefinition(guildId, opts);
    if (limitKey === 'reception_channels') {
      const n = plan.limits.reception_channels;
      return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
    }
    return 0;
  } catch (err) {
    try {
      logger.warn('entitlementService.getLimit: fallback FREE reception=1', {
        guild_id: guildId ?? null,
        limit: limitKey,
        message: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* ignore */
    }
    if (limitKey === 'reception_channels') return 1;
    return 0;
  }
}
