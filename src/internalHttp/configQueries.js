/**
 * Lectures READ-ONLY config guild (Web3B + Phase 2 multi-salons).
 * Tables config métier uniquement — aucune queue / lifecycle / broadcast.
 *
 * Backend = source de vérité pour user_enabled / effective_active / quota.
 */

import { normalizeEnabledGuildLocale } from '../i18n/index.js';
import { validateDiscordInviteUrl } from '../utils/validation.js';
import { UI_PRIMARY_GAME_KEY } from '../config/games.js';
import { canUseFeature, getEntitlementSnapshot, getLimit } from '../services/entitlements/index.js';
import { getLolFilterRankOptions } from '../services/rankTaxonomy.js';
import { buildDashboardStructureProfileView } from '../services/structureProfileResolver.js';
import { buildDashboardEmbedCustomizationView } from '../services/embedCustomizationResolver.js';

/**
 * Features dashboard : `available` = entitled AND implemented produit.
 * Les features catalogue non branchées restent `implemented: false` (jamais « disponible »).
 * @type {ReadonlyArray<{ key: string, implemented: boolean }>}
 */
const DASHBOARD_FEATURE_SPECS = Object.freeze([
  Object.freeze({ key: 'multi_reception_channels', implemented: true }),
  Object.freeze({ key: 'elo_channel_filters', implemented: true }),
  Object.freeze({ key: 'enhanced_structure_profile', implemented: true }),
  Object.freeze({ key: 'premium_badge', implemented: true }),
  Object.freeze({ key: 'directory_featured', implemented: true }),
  Object.freeze({ key: 'local_embed_customization', implemented: true }),
  Object.freeze({ key: 'embed_presets', implemented: true }),
  Object.freeze({ key: 'live_preview', implemented: true }),
]);

/**
 * @param {number | null | undefined} ms
 * @returns {string | null}
 */
function msToIsoOrNull(ms) {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  return new Date(n).toISOString();
}

/**
 * Snapshot public Premium pour le dashboard (pas de grant_id / secrets).
 *
 * @param {string} guildId
 * @param {{ stmts?: any, nowMs?: number, receptionChannelsLimit?: number }} [opts]
 */
export function buildPublicEntitlementSnapshot(guildId, opts = {}) {
  const nowMs = opts.nowMs;
  const stmts = opts.stmts;
  const receptionLimit =
    opts.receptionChannelsLimit != null
      ? opts.receptionChannelsLimit
      : getLimit(guildId, 'reception_channels', { nowMs, stmts });
  const max =
    Number.isFinite(receptionLimit) && receptionLimit >= 1 ? Math.floor(receptionLimit) : 1;

  let snap;
  try {
    snap = getEntitlementSnapshot(guildId, { nowMs, stmts });
  } catch {
    snap = {
      planKey: 'FREE',
      source: 'none',
      status: 'active',
      startsAt: null,
      endsAt: null,
      graceEndsAt: null,
      tier: 0,
    };
  }

  /** @type {Record<string, { entitled: boolean, implemented: boolean, available: boolean }>} */
  const featureDetails = {};
  /** @type {Record<string, boolean>} */
  const featuresAvailable = {};

  for (const spec of DASHBOARD_FEATURE_SPECS) {
    let entitled = false;
    try {
      entitled = canUseFeature(guildId, spec.key, { nowMs, stmts });
    } catch {
      entitled = false;
    }
    const available = Boolean(entitled && spec.implemented);
    featureDetails[spec.key] = {
      entitled: Boolean(entitled),
      implemented: spec.implemented,
      available,
    };
    featuresAvailable[spec.key] = available;
  }

  return {
    plan_key: snap.planKey ?? 'FREE',
    tier: Number.isFinite(snap.tier) ? snap.tier : 0,
    status: snap.status ?? 'active',
    source: snap.source ?? 'none',
    starts_at: msToIsoOrNull(snap.startsAt),
    ends_at: msToIsoOrNull(snap.endsAt),
    grace_ends_at: msToIsoOrNull(snap.graceEndsAt),
    limits: {
      reception_channels: max,
    },
    /** Booléens « réellement utilisables » (entitled ∩ implemented) — source de vérité UI. */
    features: featuresAvailable,
    feature_details: featureDetails,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @param {{ stmts?: any, nowMs?: number }} [opts]
 */
export function fetchGuildConfig(db, guildId, opts = {}) {
  const language = readLanguage(db, guildId);
  const receptionView = readReceptionChannelsView(db, guildId, opts);
  const command_channel_id = readCommandChannelId(db, guildId);
  const inactive_message_policy = readInactiveMessagePolicy(db, guildId);
  const structure_invite_url = readStructureInviteUrl(db, guildId);
  const command_permissions = readCommandPermissions(db, guildId);
  const structure_profile = buildDashboardStructureProfileView(db, guildId, {
    nowMs: opts.nowMs,
    stmts: opts.stmts,
  });
  const embed_customization = buildDashboardEmbedCustomizationView(db, guildId, {
    nowMs: opts.nowMs,
    stmts: opts.stmts,
  });

  return {
    guild_id: guildId,
    language,
    reception_channels: receptionView.reception_channels,
    reception_channel_usage: receptionView.reception_channel_usage,
    elo_filter_rank_options: receptionView.elo_filter_rank_options,
    entitlement: receptionView.entitlement,
    command_channel_id,
    inactive_message_policy,
    structure_invite_url,
    command_permissions,
    structure_profile,
    embed_customization,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @returns {import('../i18n/index.js').EnabledGuildLocale}
 */
function readLanguage(db, guildId) {
  const row = db
    .prepare(`SELECT language FROM guild_languages WHERE guild_id = ? LIMIT 1`)
    .get(guildId);
  return normalizeEnabledGuildLocale(/** @type {any} */ (row)?.language);
}

/**
 * Tous les salons configurés (y compris user-disabled) + état effectif.
 * Quota `reception_channels` appliqué **par game_key**.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @param {{ stmts?: any, nowMs?: number }} [opts]
 */
function readReceptionChannelsView(db, guildId, opts = {}) {
  const limit = getLimit(guildId, 'reception_channels', {
    nowMs: opts.nowMs,
    stmts: opts.stmts,
  });
  const max = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;

  /** @type {Array<{
   *   game_key: unknown,
   *   channel_id: unknown,
   *   enabled: unknown,
   *   sort_order: unknown,
   *   created_at: unknown,
   * }>} */
  const rows = db
    .prepare(
      `SELECT game_key, channel_id, enabled, sort_order, created_at
       FROM guild_game_channels
       WHERE guild_id = ?
       ORDER BY game_key ASC, sort_order ASC, created_at ASC, channel_id ASC`,
    )
    .all(guildId);

  /** @type {Map<string, string[]>} game_key → channelIds user-enabled ordered */
  const enabledByGame = new Map();
  for (const row of rows) {
    if (Number(row.enabled) !== 1) continue;
    const gk = String(row.game_key ?? '');
    if (!enabledByGame.has(gk)) enabledByGame.set(gk, []);
    enabledByGame.get(gk).push(String(row.channel_id ?? ''));
  }

  /** @type {Set<string>} `${game}:${channel}` */
  const effectiveKeys = new Set();
  for (const [gk, ids] of enabledByGame) {
    for (const id of ids.slice(0, max)) {
      effectiveKeys.add(`${gk}:${id}`);
    }
  }

  /** @type {Map<string, string | null>} channel_id → elo_rank_key */
  const filterByChannel = new Map();
  try {
    /** @type {Array<{ channel_id: unknown, elo_rank_key: unknown }>} */
    const filterRows = db
      .prepare(
        `SELECT channel_id, elo_rank_key
         FROM guild_reception_channel_filters
         WHERE guild_id = ?`,
      )
      .all(guildId);
    for (const fr of filterRows) {
      const cid = String(fr.channel_id ?? '');
      if (!cid) continue;
      filterByChannel.set(
        cid,
        fr.elo_rank_key == null ? null : String(fr.elo_rank_key),
      );
    }
  } catch {
    // Table absente avant migration → aucun filtre
  }

  const filtersFeature = canUseFeature(guildId, 'elo_channel_filters', {
    nowMs: opts.nowMs,
    stmts: opts.stmts,
  });

  const reception_channels = rows.map((row) => {
    const gameKey = String(row.game_key ?? '');
    const channelId = String(row.channel_id ?? '');
    const userEnabled = Number(row.enabled) === 1;
    const effectiveActive = userEnabled && effectiveKeys.has(`${gameKey}:${channelId}`);
    /** @type {'PLAN_LIMIT' | null} */
    let paused_reason = null;
    if (userEnabled && !effectiveActive) paused_reason = 'PLAN_LIMIT';
    const storedFilter = filterByChannel.has(channelId)
      ? filterByChannel.get(channelId)
      : null;
    return {
      game_key: gameKey,
      channel_id: channelId,
      sort_order: Number(row.sort_order) || 0,
      user_enabled: userEnabled,
      effective_active: effectiveActive,
      paused_reason,
      elo_filter: storedFilter ?? null,
      elo_filter_effective: filtersFeature ? (storedFilter ?? null) : null,
    };
  });

  // Usage dashboard : jeu primaire (UI)
  const primaryKey = UI_PRIMARY_GAME_KEY;
  const primaryRows = rows.filter((r) => String(r.game_key) === primaryKey);
  const primaryEnabled = primaryRows.filter((r) => Number(r.enabled) === 1);
  const primaryActive = primaryEnabled.slice(0, max).length;
  const primaryPaused = Math.max(0, primaryEnabled.length - primaryActive);

  const entitlement = buildPublicEntitlementSnapshot(guildId, {
    nowMs: opts.nowMs,
    stmts: opts.stmts,
    receptionChannelsLimit: max,
  });
  // Garde cohérence filtres Elo (même source que feature_details)
  if (entitlement.features.elo_channel_filters !== filtersFeature) {
    entitlement.features.elo_channel_filters = filtersFeature;
    entitlement.feature_details.elo_channel_filters = {
      entitled: filtersFeature,
      implemented: true,
      available: filtersFeature,
    };
  }

  return {
    reception_channels,
    reception_channel_usage: {
      configured: primaryRows.length,
      enabled: primaryEnabled.length,
      user_enabled: primaryEnabled.length,
      active: primaryActive,
      paused: primaryPaused,
      limit: max,
      game_key: primaryKey,
    },
    elo_filter_rank_options: getLolFilterRankOptions().map((o) => ({ key: o.key })),
    entitlement,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @returns {string | null}
 */
function readCommandChannelId(db, guildId) {
  const row = db
    .prepare(`SELECT channel_id FROM guild_scrim_usage_channel WHERE guild_id = ?`)
    .get(guildId);
  const channelId = row?.channel_id;
  if (typeof channelId !== 'string' || !channelId.trim()) {
    return null;
  }
  return channelId.trim();
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @returns {'keep'|'delete'}
 */
function readInactiveMessagePolicy(db, guildId) {
  const row = db
    .prepare(
      `SELECT policy FROM guild_scrim_message_lifecycle_policy WHERE guild_id = ?`,
    )
    .get(guildId);
  const policy = row?.policy;
  if (policy === 'delete') return 'delete';
  return 'keep';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @returns {string | null}
 */
function readStructureInviteUrl(db, guildId) {
  const row = db
    .prepare(
      `SELECT discord_invite_url FROM structure_discord_links WHERE guild_id = ?`,
    )
    .get(guildId);
  const raw = row?.discord_invite_url;
  if (typeof raw !== 'string' || !raw.trim()) {
    return null;
  }
  const validated = validateDiscordInviteUrl(raw);
  if (!validated.ok) {
    return null;
  }
  return validated.value;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @returns {{ mode: 'everyone'|'roles', role_ids: string[] }}
 */
function readCommandPermissions(db, guildId) {
  const modeRow = db
    .prepare(`SELECT mode FROM guild_scrim_permissions WHERE guild_id = ?`)
    .get(guildId);
  const rawMode = modeRow?.mode;
  const mode = rawMode === 'roles' ? 'roles' : 'everyone';

  /** @type {Array<{ role_id: unknown }>} */
  const roleRows = db
    .prepare(
      `SELECT role_id FROM guild_scrim_allowed_roles
       WHERE guild_id = ?
       ORDER BY role_id ASC`,
    )
    .all(guildId);

  const role_ids = roleRows
    .map((r) => String(r.role_id ?? '').trim())
    .filter(Boolean);

  return { mode, role_ids };
}

// Réexport utile pour tests / debug
export { UI_PRIMARY_GAME_KEY as _PRIMARY_GAME_KEY_FOR_TESTS };
