/**
 * Accès DB entitlement_grants (Phase 1).
 */

import { ConfigWriteError } from '../configWriteError.js';
import {
  ENTITLEMENT_SOURCES,
  GUILD_ID_RE,
  MAX_EXTERNAL_REF_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_REASON_LENGTH,
  PERSISTED_GRANT_STATUSES,
} from './entitlementTypes.js';
import { isPremiumPlanKey, PAID_GRACE_MS } from './planCatalog.js';

/**
 * @typedef {{
 *   id: number,
 *   guild_id: string,
 *   plan_key: string,
 *   source: string,
 *   status: string,
 *   starts_at: number,
 *   ends_at: number,
 *   grace_ends_at: number | null,
 *   granted_by: string,
 *   reason: string,
 *   external_ref: string | null,
 *   idempotency_key: string | null,
 *   provider: string | null,
 *   revoked_at: number | null,
 *   revoked_by: string | null,
 *   revoke_reason: string | null,
 *   created_at: number,
 *   updated_at: number,
 * }} EntitlementGrantRow
 */

/**
 * @param {unknown} guildId
 * @returns {string}
 */
export function assertValidGuildId(guildId) {
  if (typeof guildId !== 'string' || !GUILD_ID_RE.test(guildId.trim())) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'guild_id invalide');
  }
  return guildId.trim();
}

/**
 * @param {unknown} actorId
 * @returns {string}
 */
export function assertValidActorId(actorId) {
  if (typeof actorId !== 'string' || !GUILD_ID_RE.test(actorId.trim())) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'granted_by/actor invalide');
  }
  return actorId.trim();
}

/**
 * @param {unknown} reason
 * @returns {string}
 */
export function assertValidReason(reason) {
  if (typeof reason !== 'string') {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'reason requis');
  }
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'reason vide');
  }
  if (trimmed.length > MAX_REASON_LENGTH) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'reason trop long');
  }
  return trimmed;
}

/**
 * @param {unknown} planKey
 * @returns {import('./planCatalog.js').PlanKey}
 */
export function assertPremiumPlanKey(planKey) {
  if (!isPremiumPlanKey(planKey)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'plan_key invalide');
  }
  return /** @type {import('./planCatalog.js').PlanKey} */ (planKey);
}

/**
 * @param {unknown} source
 * @returns {import('./entitlementTypes.js').EntitlementSource}
 */
export function assertSource(source) {
  if (typeof source !== 'string' || !ENTITLEMENT_SOURCES.includes(/** @type {any} */ (source))) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'source invalide');
  }
  return /** @type {import('./entitlementTypes.js').EntitlementSource} */ (source);
}

/**
 * @param {unknown} ms
 * @param {string} label
 * @returns {number}
 */
export function assertEpochMs(ms, label) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || !Number.isInteger(ms)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', `${label} invalide`);
  }
  if (ms < 0 || ms > 4102444800000) {
    // ~2100-01-01
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', `${label} hors plage`);
  }
  return ms;
}

/**
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   stmts: ReturnType<import('../../database/db.js')['prepareStatements']>,
 *   guildId: string,
 *   planKey: string,
 *   source: string,
 *   startsAt: number,
 *   endsAt: number,
 *   grantedBy: string,
 *   reason: string,
 *   externalRef?: string | null,
 *   idempotencyKey?: string | null,
 *   provider?: string | null,
 *   nowMs?: number,
 * }} p
 * @returns {EntitlementGrantRow}
 */
export function insertEntitlementGrant(p) {
  const guildId = assertValidGuildId(p.guildId);
  const planKey = assertPremiumPlanKey(p.planKey);
  const source = assertSource(p.source);
  const startsAt = assertEpochMs(p.startsAt, 'starts_at');
  const endsAt = assertEpochMs(p.endsAt, 'ends_at');
  if (endsAt <= startsAt) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'ends_at doit être > starts_at');
  }
  const grantedBy = assertValidActorId(p.grantedBy);
  const reason = assertValidReason(p.reason);
  const nowMs = p.nowMs ?? Date.now();

  let externalRef = null;
  if (p.externalRef != null) {
    if (typeof p.externalRef !== 'string' || p.externalRef.length > MAX_EXTERNAL_REF_LENGTH) {
      throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'external_ref invalide');
    }
    externalRef = p.externalRef.trim() || null;
  }

  let idempotencyKey = null;
  if (p.idempotencyKey != null) {
    if (typeof p.idempotencyKey !== 'string' || p.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'idempotency_key invalide');
    }
    const k = p.idempotencyKey.trim();
    idempotencyKey = k || null;
  }

  let provider = null;
  if (p.provider != null) {
    if (typeof p.provider !== 'string' || p.provider.length > 64) {
      throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'provider invalide');
    }
    provider = p.provider.trim() || null;
  }

  /** Grace auto pour paid/manual billing-like ; jamais pour gift. */
  const graceEndsAt = source === 'gift' ? null : endsAt + PAID_GRACE_MS;

  const initialStatus = nowMs < startsAt ? 'scheduled' : 'active';

  if (idempotencyKey) {
    const existing = p.stmts.getEntitlementGrantByIdempotencyKey.get(idempotencyKey);
    if (existing) {
      return /** @type {EntitlementGrantRow} */ (existing);
    }
  }

  const info = p.stmts.insertEntitlementGrant.run({
    guild_id: guildId,
    plan_key: planKey,
    source,
    status: initialStatus,
    starts_at: startsAt,
    ends_at: endsAt,
    grace_ends_at: graceEndsAt,
    granted_by: grantedBy,
    reason,
    external_ref: externalRef,
    idempotency_key: idempotencyKey,
    provider,
    created_at: nowMs,
    updated_at: nowMs,
  });

  const row = p.stmts.getEntitlementGrantById.get(Number(info.lastInsertRowid));
  if (!row) {
    throw new ConfigWriteError(500, 'INTERNAL_ERROR', 'grant introuvable après insert');
  }
  return /** @type {EntitlementGrantRow} */ (row);
}

/**
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   stmts: ReturnType<import('../../database/db.js')['prepareStatements']>,
 *   grantId: number,
 *   revokedBy: string,
 *   revokeReason: string,
 *   nowMs?: number,
 * }} p
 * @returns {EntitlementGrantRow}
 */
/**
 * Upsert grant paid piloté exclusivement par Billing Core.
 * Un seul grant lifecycle par external_ref (renouvellements = UPDATE, pas N inserts).
 *
 * @param {{
 *   stmts: ReturnType<import('../../database/db.js')['prepareStatements']>,
 *   guildId: string,
 *   planKey: string,
 *   startsAt: number,
 *   endsAt: number,
 *   graceEndsAt: number | null,
 *   status: string,
 *   grantedBy: string,
 *   reason: string,
 *   externalRef: string,
 *   provider: string,
 *   nowMs?: number,
 *   clearAccess?: boolean,
 * }} p
 * @returns {EntitlementGrantRow}
 */
export function upsertPaidEntitlementGrant(p) {
  const guildId = assertValidGuildId(p.guildId);
  const planKey = assertPremiumPlanKey(p.planKey);
  const startsAt = assertEpochMs(p.startsAt, 'starts_at');
  const endsAt = assertEpochMs(p.endsAt, 'ends_at');
  if (endsAt <= startsAt) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'ends_at doit être > starts_at');
  }
  if (typeof p.externalRef !== 'string' || !p.externalRef.trim() || p.externalRef.length > MAX_EXTERNAL_REF_LENGTH) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'external_ref invalide');
  }
  if (typeof p.provider !== 'string' || !p.provider.trim() || p.provider.length > 64) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'provider invalide');
  }
  const grantedBy = assertValidActorId(p.grantedBy);
  const reason = assertValidReason(p.reason);
  const nowMs = p.nowMs ?? Date.now();
  const externalRef = p.externalRef.trim();
  const provider = p.provider.trim();

  let graceEndsAt = null;
  if (p.graceEndsAt != null) {
    graceEndsAt = assertEpochMs(p.graceEndsAt, 'grace_ends_at');
  }

  const status = typeof p.status === 'string' && PERSISTED_GRANT_STATUSES.includes(/** @type {any} */ (p.status))
    ? p.status
    : (nowMs < startsAt ? 'scheduled' : 'active');

  if (p.clearAccess) {
    // Coupe l'accès paid immédiatement (expired commercial) sans toucher aux gifts.
    // ends_at = now pour que le resolver ignore ; status expired.
    const cutEnds = Math.max(startsAt + 1, nowMs);
    const existingCut = p.stmts.getEntitlementGrantByExternalRef.get(externalRef);
    if (existingCut && existingCut.source === 'paid') {
      p.stmts.updatePaidEntitlementGrant.run({
        id: existingCut.id,
        plan_key: planKey,
        status: 'expired',
        starts_at: startsAt,
        ends_at: cutEnds,
        grace_ends_at: null,
        reason,
        provider,
        updated_at: nowMs,
      });
      return /** @type {EntitlementGrantRow} */ (p.stmts.getEntitlementGrantById.get(existingCut.id));
    }
  }

  const existing = p.stmts.getEntitlementGrantByExternalRef.get(externalRef);
  if (existing && existing.source === 'paid') {
    p.stmts.updatePaidEntitlementGrant.run({
      id: existing.id,
      plan_key: planKey,
      status: status === 'revoked' ? 'active' : status,
      starts_at: startsAt,
      ends_at: endsAt,
      grace_ends_at: graceEndsAt,
      reason,
      provider,
      updated_at: nowMs,
    });
    // Clear revoke markers if reactivating
    if (existing.revoked_at != null) {
      p.stmts.clearEntitlementGrantRevoke.run({
        id: existing.id,
        updated_at: nowMs,
      });
    }
    const row = p.stmts.getEntitlementGrantById.get(existing.id);
    return /** @type {EntitlementGrantRow} */ (row);
  }

  const info = p.stmts.insertEntitlementGrant.run({
    guild_id: guildId,
    plan_key: planKey,
    source: 'paid',
    status,
    starts_at: startsAt,
    ends_at: endsAt,
    grace_ends_at: graceEndsAt,
    granted_by: grantedBy,
    reason,
    external_ref: externalRef,
    idempotency_key: null,
    provider,
    created_at: nowMs,
    updated_at: nowMs,
  });

  const row = p.stmts.getEntitlementGrantById.get(Number(info.lastInsertRowid));
  if (!row) {
    throw new ConfigWriteError(500, 'INTERNAL_ERROR', 'grant paid introuvable après upsert');
  }
  return /** @type {EntitlementGrantRow} */ (row);
}

export function softRevokeEntitlementGrant(p) {
  if (!Number.isInteger(p.grantId) || p.grantId < 1) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'grant_id invalide');
  }
  const revokedBy = assertValidActorId(p.revokedBy);
  const revokeReason = assertValidReason(p.revokeReason);
  const nowMs = p.nowMs ?? Date.now();

  const existing = p.stmts.getEntitlementGrantById.get(p.grantId);
  if (!existing) {
    throw new ConfigWriteError(404, 'NOT_FOUND', 'grant introuvable');
  }
  if (existing.status === 'revoked') {
    return /** @type {EntitlementGrantRow} */ (existing);
  }

  p.stmts.revokeEntitlementGrant.run({
    id: p.grantId,
    status: 'revoked',
    revoked_at: nowMs,
    revoked_by: revokedBy,
    revoke_reason: revokeReason,
    updated_at: nowMs,
  });

  const row = p.stmts.getEntitlementGrantById.get(p.grantId);
  return /** @type {EntitlementGrantRow} */ (row);
}

/**
 * @param {ReturnType<import('../../database/db.js')['prepareStatements']>} stmts
 * @param {string} guildId
 * @returns {EntitlementGrantRow[]}
 */
export function listGrantsForGuild(stmts, guildId) {
  try {
    const id = assertValidGuildId(guildId);
    return /** @type {EntitlementGrantRow[]} */ (stmts.listEntitlementGrantsByGuild.all(id) ?? []);
  } catch {
    return [];
  }
}

/**
 * Normalise status persisted pour grants dont la fenêtre d'accès est finie.
 * Idempotent. Ne touche pas revoked.
 *
 * @param {ReturnType<import('../../database/db.js')['prepareStatements']>} stmts
 * @param {number} nowMs
 * @returns {{ normalized: number, guildIds: string[] }}
 */
export function normalizeExpiredGrantStatuses(stmts, nowMs) {
  const rows = /** @type {EntitlementGrantRow[]} */ (
    stmts.listEntitlementGrantsNeedingExpire.all(nowMs, nowMs) ?? []
  );
  /** @type {Set<string>} */
  const guildIds = new Set();
  let normalized = 0;
  for (const row of rows) {
    if (row.status === 'revoked' || row.status === 'expired') continue;
    const graceEnd = row.grace_ends_at != null ? Number(row.grace_ends_at) : null;
    const accessEnd = graceEnd != null && graceEnd > row.ends_at ? graceEnd : row.ends_at;
    if (nowMs < accessEnd) continue;
    stmts.updateEntitlementGrantStatus.run({
      id: row.id,
      status: 'expired',
      updated_at: nowMs,
    });
    guildIds.add(String(row.guild_id));
    normalized += 1;
  }
  return { normalized, guildIds: [...guildIds] };
}

export { PERSISTED_GRANT_STATUSES };
