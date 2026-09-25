/**
 * Mutations grants Premium (Phase 1) — owner/dev only côté appelant.
 *
 * Aucun endpoint HTTP public. Service testable + appelable depuis outils owner.
 */

import { ConfigWriteError } from '../configWriteError.js';
import { resolveBotDevId } from '../../utils/botDevConfig.js';
import { logger } from '../../utils/logger.js';
import { invalidateEntitlementCache } from './entitlementCache.js';
import {
  insertEntitlementGrant,
  softRevokeEntitlementGrant,
} from './entitlementStore.js';
import { resolveEffectiveEntitlement } from './entitlementResolver.js';

/** @type {Set<(guildId: string, oldSnap: unknown, newSnap: unknown) => void>} */
const changeListeners = new Set();

/**
 * Hook découplé pour Phase 2 (aucun side-effect produit en Phase 1).
 * @param {(guildId: string, oldSnap: unknown, newSnap: unknown) => void} fn
 */
export function onEntitlementChanged(fn) {
  if (typeof fn === 'function') changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

/**
 * @param {string} guildId
 * @param {unknown} oldSnap
 * @param {unknown} newSnap
 */
function emitChanged(guildId, oldSnap, newSnap) {
  for (const fn of changeListeners) {
    try {
      fn(guildId, oldSnap, newSnap);
    } catch (err) {
      try {
        logger.warn('entitlementGrants: listener error', {
          message: err instanceof Error ? err.message : String(err),
        });
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Notification manuelle après sync billing (même bus que gifts/grants).
 * @param {string} guildId
 * @param {unknown} oldSnap
 * @param {unknown} newSnap
 */
export function notifyEntitlementChanged(guildId, oldSnap, newSnap) {
  emitChanged(guildId, oldSnap, newSnap);
}

/**
 * Autorise BOT_DEV_ID ou SCRIMRESEAU_OWNER_ID.
 * @param {string} actorId
 */
export function assertInternalPremiumAdmin(actorId) {
  const trimmed = typeof actorId === 'string' ? actorId.trim() : '';
  const ownerId = process.env.SCRIMRESEAU_OWNER_ID?.trim() ?? '';
  const dev = resolveBotDevId();
  const okOwner = Boolean(ownerId) && trimmed === ownerId;
  const okDev = dev.ok && trimmed === dev.devId;
  if (!okOwner && !okDev) {
    throw new ConfigWriteError(403, 'FORBIDDEN', 'premium admin interne requis');
  }
  return trimmed;
}

/**
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   stmts: ReturnType<import('../../database/db.js')['prepareStatements']>,
 *   guildId: string,
 *   planKey: string,
 *   startsAt: number,
 *   endsAt: number,
 *   grantedBy: string,
 *   reason: string,
 *   idempotencyKey?: string | null,
 *   skipAdminCheck?: boolean,
 *   nowMs?: number,
 * }} p
 */
export function grantPremiumGift(p) {
  if (!p.skipAdminCheck) {
    assertInternalPremiumAdmin(p.grantedBy);
  }

  const oldSnap = resolveEffectiveEntitlement(p.stmts, p.guildId, p.nowMs ?? Date.now());

  const run = p.db.transaction(() => insertEntitlementGrant({
    db: p.db,
    stmts: p.stmts,
    guildId: p.guildId,
    planKey: p.planKey,
    source: 'gift',
    startsAt: p.startsAt,
    endsAt: p.endsAt,
    grantedBy: p.grantedBy,
    reason: p.reason,
    idempotencyKey: p.idempotencyKey ?? null,
    nowMs: p.nowMs,
  }));

  const row = run();
  invalidateEntitlementCache(p.guildId);
  const newSnap = resolveEffectiveEntitlement(p.stmts, p.guildId, p.nowMs ?? Date.now());
  emitChanged(p.guildId, oldSnap, newSnap);

  try {
    logger.info('entitlement: gift granted', {
      guild_id: p.guildId,
      grant_id: row.id,
      plan_key: row.plan_key,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      granted_by: row.granted_by,
    });
  } catch {
    /* ignore */
  }

  return row;
}

/**
 * Grant paid/manual pour tests / future billing (pas Stripe).
 * @param {Parameters<typeof grantPremiumGift>[0] & { source?: 'paid' | 'manual', externalRef?: string | null, provider?: string | null }} p
 */
export function grantPremiumAccess(p) {
  if (!p.skipAdminCheck) {
    assertInternalPremiumAdmin(p.grantedBy);
  }
  const source = p.source === 'manual' ? 'manual' : 'paid';
  const oldSnap = resolveEffectiveEntitlement(p.stmts, p.guildId, p.nowMs ?? Date.now());

  const run = p.db.transaction(() => insertEntitlementGrant({
    db: p.db,
    stmts: p.stmts,
    guildId: p.guildId,
    planKey: p.planKey,
    source,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
    grantedBy: p.grantedBy,
    reason: p.reason,
    idempotencyKey: p.idempotencyKey ?? null,
    externalRef: p.externalRef ?? null,
    provider: p.provider ?? null,
    nowMs: p.nowMs,
  }));

  const row = run();
  invalidateEntitlementCache(p.guildId);
  const newSnap = resolveEffectiveEntitlement(p.stmts, p.guildId, p.nowMs ?? Date.now());
  emitChanged(p.guildId, oldSnap, newSnap);

  try {
    logger.info('entitlement: access granted', {
      guild_id: p.guildId,
      grant_id: row.id,
      plan_key: row.plan_key,
      source: row.source,
      granted_by: row.granted_by,
    });
  } catch {
    /* ignore */
  }

  return row;
}

/**
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   stmts: ReturnType<import('../../database/db.js')['prepareStatements']>,
 *   grantId: number,
 *   revokedBy: string,
 *   revokeReason: string,
 *   skipAdminCheck?: boolean,
 *   nowMs?: number,
 * }} p
 */
export function revokePremiumGrant(p) {
  if (!p.skipAdminCheck) {
    assertInternalPremiumAdmin(p.revokedBy);
  }

  const existing = p.stmts.getEntitlementGrantById.get(p.grantId);
  if (!existing) {
    throw new ConfigWriteError(404, 'NOT_FOUND', 'grant introuvable');
  }
  const guildId = String(existing.guild_id);
  const oldSnap = resolveEffectiveEntitlement(p.stmts, guildId, p.nowMs ?? Date.now());

  const run = p.db.transaction(() => softRevokeEntitlementGrant({
    db: p.db,
    stmts: p.stmts,
    grantId: p.grantId,
    revokedBy: p.revokedBy,
    revokeReason: p.revokeReason,
    nowMs: p.nowMs,
  }));

  const row = run();
  invalidateEntitlementCache(guildId);
  const newSnap = resolveEffectiveEntitlement(p.stmts, guildId, p.nowMs ?? Date.now());
  emitChanged(guildId, oldSnap, newSnap);

  try {
    logger.info('entitlement: grant revoked', {
      guild_id: guildId,
      grant_id: row.id,
      revoked_by: row.revoked_by,
    });
  } catch {
    /* ignore */
  }

  return row;
}

/** Alias produit. */
export const revokeGift = revokePremiumGrant;
