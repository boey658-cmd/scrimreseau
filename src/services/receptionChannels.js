/**
 * Découverte + vue effective des salons de réception (Phase 2).
 *
 * Modèle :
 * - `enabled` = user_enabled (volontaire admin) — JAMAIS basculé par le plan
 * - effectiveActive = enabled=1 AND rang < getLimit(reception_channels)
 * - pausedReason PLAN_LIMIT calculé à la lecture (aucun DELETE downgrade)
 *
 * Ordre déterministe : sort_order ASC, created_at ASC, channel_id ASC
 */

import { canUseFeature, getEntitlementSnapshot, getLimit } from './entitlements/index.js';
import { destinationAcceptsScrim } from './rankTaxonomy.js';
import { logger } from '../utils/logger.js';
import { UI_PRIMARY_GAME_KEY } from '../config/games.js';

/**
 * @typedef {{
 *   guild_id: string,
 *   channel_id: string,
 *   game_key?: string,
 *   enabled?: number,
 *   sort_order?: number,
 *   created_at?: number,
 * }} ReceptionChannelRow
 */

/**
 * @typedef {{
 *   channelId: string,
 *   gameKey: string,
 *   sortOrder: number,
 *   createdAt: number,
 *   userEnabled: boolean,
 *   effectiveActive: boolean,
 *   pausedReason: 'PLAN_LIMIT' | null,
 * }} ReceptionChannelView
 */

/**
 * @param {string} guildId
 * @param {ReceptionChannelRow[]} channelsSorted user-enabled only, already sorted
 * @param {{ nowMs?: number, stmts?: any }} [opts]
 * @returns {ReceptionChannelRow[]}
 */
export function applyReceptionChannelLimit(guildId, channelsSorted, opts = {}) {
  const limit = getLimit(guildId, 'reception_channels', opts);
  const max = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  if (!Array.isArray(channelsSorted) || channelsSorted.length === 0) return [];
  if (channelsSorted.length > max) {
    try {
      logger.info('receptionChannels: truncation par limite plan', {
        guild_id: guildId,
        user_enabled_rows: channelsSorted.length,
        limit: max,
      });
    } catch {
      /* ignore */
    }
  }
  return channelsSorted.slice(0, max);
}

/**
 * Destinations effectives pour un jeu (broadcast / repost).
 *
 * Ordre :
 * 1. user enabled
 * 2. plan limit (quota)
 * 3. filtre Elo (si `opts.scrimRankKey` fourni + feature Premium)
 *
 * @param {{
 *   listEnabledChannelsByGame: { all: (gameKey: string) => ReceptionChannelRow[] },
 *   listReceptionChannelEloFiltersByGame?: { all: (gameKey: string) => Array<{ guild_id: string, channel_id: string, elo_rank_key: string | null }> },
 * }} stmts
 * @param {string} gameKey
 * @param {{ nowMs?: number, scrimRankKey?: string | null }} [opts]
 * @returns {{ guild_id: string, channel_id: string }[]}
 */
export function listActiveReceptionDestinationsForGame(stmts, gameKey, opts = {}) {
  /** @type {ReceptionChannelRow[]} */
  let rows = [];
  try {
    rows = stmts.listEnabledChannelsByGame.all(gameKey) ?? [];
  } catch (err) {
    try {
      logger.error('receptionChannels.listActiveReceptionDestinationsForGame: lecture DB échouée', {
        game_key: gameKey,
        message: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* ignore */
    }
    return [];
  }

  /** @type {Map<string, ReceptionChannelRow[]>} */
  const byGuild = new Map();
  for (const row of rows) {
    const guildId = String(row?.guild_id ?? '');
    const channelId = String(row?.channel_id ?? '');
    if (!guildId || !channelId) continue;
    if (!byGuild.has(guildId)) byGuild.set(guildId, []);
    byGuild.get(guildId).push(row);
  }

  /** @type {{ guild_id: string, channel_id: string }[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const [guildId, channels] of byGuild) {
    const limited = applyReceptionChannelLimit(guildId, channels, {
      nowMs: opts.nowMs,
      stmts,
    });
    for (const ch of limited) {
      const key = `${guildId}:${ch.channel_id}`;
      if (seen.has(key)) {
        try {
          logger.warn('receptionChannels: duplicate destination ignorée', {
            guild_id: guildId,
            channel_id: ch.channel_id,
          });
        } catch {
          /* ignore */
        }
        continue;
      }
      seen.add(key);
      out.push({ guild_id: guildId, channel_id: String(ch.channel_id) });
    }
  }

  if (opts.scrimRankKey == null) {
    return out;
  }

  return filterDestinationsByElo(stmts, gameKey, out, {
    scrimRankKey: opts.scrimRankKey,
    nowMs: opts.nowMs,
  });
}

/**
 * Batch-load filtres + matching (évite N+1).
 *
 * @param {any} stmts
 * @param {string} gameKey
 * @param {{ guild_id: string, channel_id: string }[]} destinations
 * @param {{ scrimRankKey: string, nowMs?: number }} opts
 */
export function filterDestinationsByElo(stmts, gameKey, destinations, opts) {
  if (!Array.isArray(destinations) || destinations.length === 0) return [];

  /** @type {Map<string, string | null>} key guild:channel → elo_rank_key */
  const filterMap = new Map();
  try {
    if (stmts.listReceptionChannelEloFiltersByGame) {
      const filterRows = stmts.listReceptionChannelEloFiltersByGame.all(gameKey) ?? [];
      for (const fr of filterRows) {
        const g = String(fr.guild_id ?? '');
        const c = String(fr.channel_id ?? '');
        if (!g || !c) continue;
        filterMap.set(`${g}:${c}`, fr.elo_rank_key == null ? null : String(fr.elo_rank_key));
      }
    }
  } catch (err) {
    try {
      logger.warn('receptionChannels.filterDestinationsByElo: load filters failed — no elo filter', {
        message: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* ignore */
    }
    // Fail-open pour FREE comportement : sans table/query → pas de filtre
    return destinations;
  }

  /** @type {Map<string, boolean>} */
  const featureByGuild = new Map();
  /** @type {{ guild_id: string, channel_id: string }[]} */
  const accepted = [];
  let skipped = 0;

  for (const dest of destinations) {
    const guildId = dest.guild_id;
    if (!featureByGuild.has(guildId)) {
      let enabled = false;
      try {
        enabled = canUseFeature(guildId, 'elo_channel_filters', {
          nowMs: opts.nowMs,
          stmts,
        });
      } catch {
        enabled = false;
      }
      featureByGuild.set(guildId, enabled);
    }

    const featureOn = featureByGuild.get(guildId) === true;
    const eloKey = filterMap.has(`${guildId}:${dest.channel_id}`)
      ? filterMap.get(`${guildId}:${dest.channel_id}`)
      : null;

    const decision = destinationAcceptsScrim(
      {
        eloFilterRankKey: eloKey,
        filtersFeatureEnabled: featureOn,
      },
      { rankKey: opts.scrimRankKey },
    );

    if (decision.accept) {
      accepted.push(dest);
    } else {
      skipped += 1;
    }
  }

  if (skipped > 0) {
    try {
      logger.info('receptionChannels: elo filter skipped destinations', {
        game_key: gameKey,
        skipped,
        kept: accepted.length,
      });
    } catch {
      /* ignore */
    }
  }

  return accepted;
}

/**
 * Alias Phase 2.
 * @param {Parameters<typeof listActiveReceptionDestinationsForGame>[0]} stmts
 * @param {string} gameKey
 * @param {{ nowMs?: number }} [opts]
 */
export function listEffectiveReceptionDestinationsForGame(stmts, gameKey, opts = {}) {
  return listActiveReceptionDestinationsForGame(stmts, gameKey, opts);
}

/**
 * @param {{ listEnabledChannelsByGuildGame: { all: (guildId: string, gameKey: string) => ReceptionChannelRow[] } }} stmts
 * @param {string} guildId
 * @param {string} gameKey
 * @param {{ nowMs?: number }} [opts]
 */
export function listActiveReceptionChannelsForGuild(stmts, guildId, gameKey, opts = {}) {
  try {
    const rows = stmts.listEnabledChannelsByGuildGame.all(guildId, gameKey) ?? [];
    return applyReceptionChannelLimit(guildId, rows, { nowMs: opts.nowMs, stmts });
  } catch (err) {
    try {
      logger.error('receptionChannels.listActiveReceptionChannelsForGuild: lecture DB échouée', {
        guild_id: guildId,
        game_key: gameKey,
        message: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* ignore */
    }
    return [];
  }
}

/**
 * Vue dashboard : tous les salons configurés + état effectif.
 *
 * @param {{
 *   listAllChannelsByGuildGame: { all: (guildId: string, gameKey: string) => ReceptionChannelRow[] },
 *   listEnabledChannelsByGuildGame?: { all: (guildId: string, gameKey: string) => ReceptionChannelRow[] },
 * }} stmts
 * @param {string} guildId
 * @param {string} [gameKey]
 * @param {{ nowMs?: number }} [opts]
 */
export function buildReceptionChannelsDashboardView(
  stmts,
  guildId,
  gameKey = UI_PRIMARY_GAME_KEY,
  opts = {},
) {
  const limit = getLimit(guildId, 'reception_channels', { nowMs: opts.nowMs, stmts });
  const max = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  const entitlement = getEntitlementSnapshot(guildId, {
    nowMs: opts.nowMs,
    stmts,
    bypassCache: true,
  });

  /** @type {ReceptionChannelRow[]} */
  let allRows = [];
  try {
    if (stmts.listAllChannelsByGuildGame) {
      allRows = stmts.listAllChannelsByGuildGame.all(guildId, gameKey) ?? [];
    } else {
      allRows = stmts.listEnabledChannelsByGuildGame?.all(guildId, gameKey) ?? [];
    }
  } catch (err) {
    try {
      logger.error('receptionChannels.buildDashboardView: DB', {
        guild_id: guildId,
        message: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* ignore */
    }
    allRows = [];
  }

  const userEnabledSorted = allRows
    .filter((r) => Number(r.enabled) === 1)
    .sort((a, b) => {
      const so = (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
      if (so !== 0) return so;
      const ca = (Number(a.created_at) || 0) - (Number(b.created_at) || 0);
      if (ca !== 0) return ca;
      return String(a.channel_id).localeCompare(String(b.channel_id));
    });

  /** @type {Set<string>} */
  const effectiveIds = new Set(
    userEnabledSorted.slice(0, max).map((r) => String(r.channel_id)),
  );

  /** @type {ReceptionChannelView[]} */
  const receptionChannels = allRows
    .slice()
    .sort((a, b) => {
      const so = (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
      if (so !== 0) return so;
      const ca = (Number(a.created_at) || 0) - (Number(b.created_at) || 0);
      if (ca !== 0) return ca;
      return String(a.channel_id).localeCompare(String(b.channel_id));
    })
    .map((r) => {
      const userEnabled = Number(r.enabled) === 1;
      const channelId = String(r.channel_id);
      const effectiveActive = userEnabled && effectiveIds.has(channelId);
      /** @type {'PLAN_LIMIT' | null} */
      let pausedReason = null;
      if (userEnabled && !effectiveActive) pausedReason = 'PLAN_LIMIT';
      return {
        channelId,
        gameKey: String(r.game_key ?? gameKey),
        sortOrder: Number(r.sort_order) || 0,
        createdAt: Number(r.created_at) || 0,
        userEnabled,
        effectiveActive,
        pausedReason,
      };
    });

  return {
    receptionChannels,
    receptionChannelUsage: {
      configured: allRows.length,
      user_enabled: userEnabledSorted.length,
      active: effectiveIds.size,
      limit: max,
    },
    entitlement: {
      planKey: entitlement.planKey,
      source: entitlement.source,
      status: entitlement.status,
    },
  };
}
