/**
 * Résolution du plan effectif (Phase 1).
 *
 * Règles temporelles (UTC ms) :
 * - starts_at INCLUSIF : now >= starts_at
 * - ends_at EXCLUSIF pour la période active : now < ends_at ⇒ active
 * - grace (paid/manual only) : ends_at <= now < grace_ends_at ⇒ grace
 * - gift : pas de grace, expire à ends_at
 *
 * Priorité :
 * parmi les grants VALABLES maintenant, meilleur `tier` (P3>P2>P1).
 * À tier égal : gift > paid > manual, puis ends_at DESC, puis id DESC.
 *
 * Un gift ne dégrade JAMAIS un paid supérieur (meilleur avantage gagne).
 */

import { logger } from '../../utils/logger.js';
import { SOURCE_TIE_PRIORITY } from './entitlementTypes.js';
import { getPlanTier, PLAN_FREE, resolvePlanDefinition } from './planCatalog.js';
import { listGrantsForGuild } from './entitlementStore.js';

/**
 * @typedef {{
 *   guildId: string,
 *   planKey: import('./planCatalog.js').PlanKey,
 *   source: import('./entitlementTypes.js').EntitlementSource | 'none',
 *   status: import('./entitlementTypes.js').EntitlementStatus,
 *   startsAt: number | null,
 *   endsAt: number | null,
 *   graceEndsAt: number | null,
 *   grantId: number | null,
 *   tier: number,
 * }} EffectiveEntitlementSnapshot
 */

/**
 * @param {import('./entitlementStore.js').EntitlementGrantRow} grant
 * @param {number} nowMs
 * @returns {{ valid: boolean, accessStatus: import('./entitlementTypes.js').EntitlementStatus }}
 */
export function evaluateGrantAccess(grant, nowMs) {
  if (!grant || grant.status === 'revoked' || grant.status === 'expired') {
    return { valid: false, accessStatus: grant?.status === 'revoked' ? 'revoked' : 'expired' };
  }

  const startsAt = Number(grant.starts_at);
  const endsAt = Number(grant.ends_at);
  const graceEndsAt = grant.grace_ends_at != null ? Number(grant.grace_ends_at) : null;

  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
    try {
      logger.warn('entitlementResolver: grant dates invalides ignoré', {
        grant_id: grant.id,
        guild_id: grant.guild_id,
      });
    } catch {
      /* ignore */
    }
    return { valid: false, accessStatus: 'expired' };
  }

  if (nowMs < startsAt) {
    return { valid: false, accessStatus: 'scheduled' };
  }

  if (nowMs < endsAt) {
    // canceled commercial reste valide jusqu'à ends_at
    return { valid: true, accessStatus: 'active' };
  }

  // Grace : paid/manual uniquement
  if (
    (grant.source === 'paid' || grant.source === 'manual')
    && graceEndsAt != null
    && Number.isFinite(graceEndsAt)
    && nowMs < graceEndsAt
  ) {
    return { valid: true, accessStatus: 'grace' };
  }

  return { valid: false, accessStatus: 'expired' };
}

/**
 * @returns {EffectiveEntitlementSnapshot}
 */
export function syntheticFreeSnapshot(guildId) {
  return {
    guildId: guildId == null ? '' : String(guildId),
    planKey: 'FREE',
    source: 'none',
    status: 'active',
    startsAt: null,
    endsAt: null,
    graceEndsAt: null,
    grantId: null,
    tier: PLAN_FREE.tier,
  };
}

/**
 * Compare deux candidats valides ; >0 si a meilleur que b.
 * @param {import('./entitlementStore.js').EntitlementGrantRow} a
 * @param {import('./entitlementStore.js').EntitlementGrantRow} b
 */
function compareValidGrants(a, b) {
  const tierA = getPlanTier(a.plan_key);
  const tierB = getPlanTier(b.plan_key);
  if (tierA !== tierB) return tierA - tierB;

  const srcA = SOURCE_TIE_PRIORITY[/** @type {keyof typeof SOURCE_TIE_PRIORITY} */ (a.source)] ?? 0;
  const srcB = SOURCE_TIE_PRIORITY[/** @type {keyof typeof SOURCE_TIE_PRIORITY} */ (b.source)] ?? 0;
  if (srcA !== srcB) return srcA - srcB;

  if (a.ends_at !== b.ends_at) return a.ends_at - b.ends_at;
  return a.id - b.id;
}

/**
 * @param {ReturnType<import('../../database/db.js')['prepareStatements']> | null | undefined} stmts
 * @param {string | null | undefined} guildId
 * @param {number} [nowMs]
 * @returns {EffectiveEntitlementSnapshot}
 */
export function resolveEffectiveEntitlement(stmts, guildId, nowMs = Date.now()) {
  try {
    if (!stmts || guildId == null || guildId === '') {
      return syntheticFreeSnapshot(guildId ?? '');
    }

    const grants = listGrantsForGuild(stmts, String(guildId));
    /** @type {import('./entitlementStore.js').EntitlementGrantRow | null} */
    let best = null;
    /** @type {import('./entitlementTypes.js').EntitlementStatus} */
    let bestAccess = 'active';

    for (const grant of grants) {
      const def = resolvePlanDefinition(grant.plan_key);
      if (def.planKey === 'FREE') {
        try {
          logger.warn('entitlementResolver: plan_key invalide ignoré', {
            grant_id: grant.id,
            plan_key: grant.plan_key,
          });
        } catch {
          /* ignore */
        }
        continue;
      }

      const { valid, accessStatus } = evaluateGrantAccess(grant, nowMs);
      if (!valid) continue;

      if (!best || compareValidGrants(grant, best) > 0) {
        best = grant;
        bestAccess = accessStatus;
      }
    }

    if (!best) {
      return syntheticFreeSnapshot(String(guildId));
    }

    const plan = resolvePlanDefinition(best.plan_key);
    return {
      guildId: String(guildId),
      planKey: plan.planKey,
      source: /** @type {any} */ (best.source),
      status: bestAccess,
      startsAt: Number(best.starts_at),
      endsAt: Number(best.ends_at),
      graceEndsAt: best.grace_ends_at != null ? Number(best.grace_ends_at) : null,
      grantId: Number(best.id),
      tier: plan.tier,
    };
  } catch (err) {
    try {
      logger.warn('entitlementResolver: fallback FREE', {
        guild_id: guildId ?? null,
        message: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* ignore */
    }
    return syntheticFreeSnapshot(guildId ?? '');
  }
}
