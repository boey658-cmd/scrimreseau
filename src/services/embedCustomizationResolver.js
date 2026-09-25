/**
 * Résolution style embed destination (Phase 6).
 * Fail-closed Premium → style défaut. Jamais de mutation du payload scrim global.
 */

import { canUseFeature } from './entitlements/index.js';
import {
  embedColorHexToInt,
} from './embedCustomizationValidation.js';
import {
  getEmbedCustomization,
  getEmbedPreset,
  getEmbedStylesBatch,
  listEmbedPresets,
} from './embedCustomizationStore.js';
import { isScrimReseauPublicGuildId } from '../utils/scrimPublicGuildGate.js';
import { logger } from '../utils/logger.js';

/**
 * @typedef {{
 *   colorHex: string | null,
 *   colorInt: number | null,
 *   emoji: string | null,
 *   source: 'default' | 'direct' | 'preset',
 *   active_preset_id: number | null,
 *   feature_available: boolean,
 * }} EffectiveEmbedStyle
 */

/**
 * @param {string | null | undefined} colorHex
 * @param {string | null | undefined} emoji
 * @param {'default' | 'direct' | 'preset'} source
 * @param {number | null} activePresetId
 * @param {boolean} featureAvailable
 * @returns {EffectiveEmbedStyle}
 */
function buildStyle(colorHex, emoji, source, activePresetId, featureAvailable) {
  let colorInt = null;
  if (colorHex) {
    try {
      colorInt = embedColorHexToInt(colorHex);
    } catch {
      colorInt = null;
      colorHex = null;
    }
  }
  return {
    colorHex: colorHex ?? null,
    colorInt,
    emoji: emoji ?? null,
    source,
    active_preset_id: activePresetId,
    feature_available: featureAvailable,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @param {{ nowMs?: number, stmts?: any, batch?: Map<string, any> }} [opts]
 * @returns {EffectiveEmbedStyle}
 */
export function resolveEffectiveEmbedStyle(db, guildId, opts = {}) {
  let featureOk = false;
  try {
    featureOk = canUseFeature(guildId, 'local_embed_customization', {
      nowMs: opts.nowMs,
      stmts: opts.stmts,
    });
  } catch (err) {
    logger.warn('embed style: entitlement error → default', {
      guild_id: guildId,
      message: err instanceof Error ? err.message : String(err),
    });
    return buildStyle(null, null, 'default', null, false);
  }

  if (!featureOk) {
    return buildStyle(null, null, 'default', null, false);
  }

  try {
    const batchEntry = opts.batch?.get(String(guildId));
    const cust = batchEntry
      ? batchEntry.customization
      : getEmbedCustomization(db, guildId);
    if (!cust) {
      return buildStyle(null, null, 'default', null, true);
    }

    if (cust.active_preset_id != null) {
      const preset = batchEntry
        ? batchEntry.presetsById.get(Number(cust.active_preset_id)) ?? null
        : getEmbedPreset(db, guildId, Number(cust.active_preset_id));
      if (preset) {
        return buildStyle(
          preset.color_hex,
          preset.emoji,
          'preset',
          preset.id,
          true,
        );
      }
      // orphelin → fallback direct fields
    }

    return buildStyle(cust.color_hex, cust.emoji, 'direct', null, true);
  } catch (err) {
    logger.warn('embed style: resolve error → default', {
      guild_id: guildId,
      message: err instanceof Error ? err.message : String(err),
    });
    return buildStyle(null, null, 'default', null, false);
  }
}

/**
 * Options destinataire pour buildScrimEmbed / closed / superseded.
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   guildId: string,
 *   nowMs?: number,
 *   stmts?: any,
 *   batch?: Map<string, any>,
 *   status?: 'active' | 'closed_manual' | 'closed_expired' | 'superseded_repost',
 * }} args
 */
export function resolveDestinationEmbedOptions(args) {
  const isOfficial = isScrimReseauPublicGuildId(args.guildId);
  const style = resolveEffectiveEmbedStyle(args.db, args.guildId, {
    nowMs: args.nowMs,
    stmts: args.stmts,
    batch: args.batch,
  });

  const status = args.status ?? 'active';
  const includeContactInEmbed = !isOfficial;
  const includeContactHints = !isOfficial && status === 'active';

  return {
    isOfficial,
    includeContactInEmbed,
    includeContactHints,
    colorInt: style.colorInt,
    emojiPrefix: style.emoji,
    style,
  };
}

/**
 * Vue dashboard.
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @param {{ nowMs?: number, stmts?: any }} [opts]
 */
export function buildDashboardEmbedCustomizationView(db, guildId, opts = {}) {
  let featureCustomization = false;
  let featurePresets = false;
  let featurePreview = false;
  try {
    featureCustomization = canUseFeature(guildId, 'local_embed_customization', opts);
  } catch {
    featureCustomization = false;
  }
  try {
    featurePresets = canUseFeature(guildId, 'embed_presets', opts);
  } catch {
    featurePresets = false;
  }
  try {
    featurePreview = canUseFeature(guildId, 'live_preview', opts);
  } catch {
    featurePreview = false;
  }

  const storedCust = getEmbedCustomization(db, guildId);
  const presets = listEmbedPresets(db, guildId);
  const effective = resolveEffectiveEmbedStyle(db, guildId, opts);

  return {
    stored: {
      color_hex: storedCust?.color_hex ?? null,
      emoji: storedCust?.emoji ?? null,
      active_preset_id: storedCust?.active_preset_id ?? null,
    },
    effective: {
      color_hex: effective.colorHex,
      emoji: effective.emoji,
      source: effective.source,
      active_preset_id: effective.active_preset_id,
    },
    presets: presets.map((p) => ({
      id: p.id,
      name: p.name,
      color_hex: p.color_hex,
      emoji: p.emoji,
    })),
    feature_available: featureCustomization,
    presets_available: featurePresets,
    preview_available: featurePreview,
  };
}

export { getEmbedStylesBatch };
