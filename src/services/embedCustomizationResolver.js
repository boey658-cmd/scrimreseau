/**
 * Résolution style embed destination (Phase 6 + line emojis).
 * Fail-closed Premium → style défaut. Jamais de mutation du payload scrim global.
 */

import { canUseFeature } from './entitlements/index.js';
import {
  embedColorHexToInt,
  shouldUseLegacyEmojiPrefix,
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
 *   emoji_date: string | null,
 *   emoji_format: string | null,
 *   emoji_rank: string | null,
 *   emoji_contact: string | null,
 *   emoji_structure: string | null,
 *   useLegacyPrefix: boolean,
 *   source: 'default' | 'direct' | 'preset',
 *   active_preset_id: number | null,
 *   feature_available: boolean,
 * }} EffectiveEmbedStyle
 */

/**
 * @param {{
 *   colorHex?: string | null,
 *   emoji?: string | null,
 *   emoji_date?: string | null,
 *   emoji_format?: string | null,
 *   emoji_rank?: string | null,
 *   emoji_contact?: string | null,
 *   emoji_structure?: string | null,
 * }} fields
 * @param {'default' | 'direct' | 'preset'} source
 * @param {number | null} activePresetId
 * @param {boolean} featureAvailable
 * @returns {EffectiveEmbedStyle}
 */
function buildStyle(fields, source, activePresetId, featureAvailable) {
  let colorHex = fields.colorHex ?? null;
  let colorInt = null;
  if (colorHex) {
    try {
      colorInt = embedColorHexToInt(colorHex);
    } catch {
      colorInt = null;
      colorHex = null;
    }
  }
  const row = {
    emoji: fields.emoji ?? null,
    emoji_date: fields.emoji_date ?? null,
    emoji_format: fields.emoji_format ?? null,
    emoji_rank: fields.emoji_rank ?? null,
    emoji_contact: fields.emoji_contact ?? null,
    emoji_structure: fields.emoji_structure ?? null,
  };
  return {
    colorHex,
    colorInt,
    emoji: row.emoji,
    emoji_date: row.emoji_date,
    emoji_format: row.emoji_format,
    emoji_rank: row.emoji_rank,
    emoji_contact: row.emoji_contact,
    emoji_structure: row.emoji_structure,
    useLegacyPrefix: shouldUseLegacyEmojiPrefix(row),
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
    return buildStyle({}, 'default', null, false);
  }

  if (!featureOk) {
    return buildStyle({}, 'default', null, false);
  }

  try {
    const batchEntry = opts.batch?.get(String(guildId));
    const cust = batchEntry
      ? batchEntry.customization
      : getEmbedCustomization(db, guildId);
    if (!cust) {
      return buildStyle({}, 'default', null, true);
    }

    if (cust.active_preset_id != null) {
      const preset = batchEntry
        ? batchEntry.presetsById.get(Number(cust.active_preset_id)) ?? null
        : getEmbedPreset(db, guildId, Number(cust.active_preset_id));
      if (preset) {
        return buildStyle(
          {
            colorHex: preset.color_hex,
            emoji: preset.emoji,
            emoji_date: preset.emoji_date,
            emoji_format: preset.emoji_format,
            emoji_rank: preset.emoji_rank,
            emoji_contact: preset.emoji_contact,
            emoji_structure: preset.emoji_structure,
          },
          'preset',
          preset.id,
          true,
        );
      }
    }

    return buildStyle(
      {
        colorHex: cust.color_hex,
        emoji: cust.emoji,
        emoji_date: cust.emoji_date,
        emoji_format: cust.emoji_format,
        emoji_rank: cust.emoji_rank,
        emoji_contact: cust.emoji_contact,
        emoji_structure: cust.emoji_structure,
      },
      'direct',
      null,
      true,
    );
  } catch (err) {
    logger.warn('embed style: resolve error → default', {
      guild_id: guildId,
      message: err instanceof Error ? err.message : String(err),
    });
    return buildStyle({}, 'default', null, false);
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
    emojiPrefix: style.useLegacyPrefix ? style.emoji : null,
    lineEmojis: {
      date: style.emoji_date,
      format: style.emoji_format,
      rank: style.emoji_rank,
      contact: style.emoji_contact,
      structure: style.emoji_structure,
    },
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

  const lineFields = (row) => ({
    emoji_date: row?.emoji_date ?? null,
    emoji_format: row?.emoji_format ?? null,
    emoji_rank: row?.emoji_rank ?? null,
    emoji_contact: row?.emoji_contact ?? null,
    emoji_structure: row?.emoji_structure ?? null,
  });

  return {
    stored: {
      color_hex: storedCust?.color_hex ?? null,
      emoji: storedCust?.emoji ?? null,
      ...lineFields(storedCust),
      active_preset_id: storedCust?.active_preset_id ?? null,
    },
    effective: {
      color_hex: effective.colorHex,
      emoji: effective.useLegacyPrefix ? effective.emoji : null,
      ...lineFields(effective),
      source: effective.source,
      active_preset_id: effective.active_preset_id,
    },
    presets: presets.map((p) => ({
      id: p.id,
      name: p.name,
      color_hex: p.color_hex,
      emoji: p.emoji,
      ...lineFields(p),
    })),
    feature_available: featureCustomization,
    presets_available: featurePresets,
    preview_available: featurePreview,
  };
}

export { getEmbedStylesBatch };
