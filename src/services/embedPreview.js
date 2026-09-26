/**
 * Preview embed (Phase 6) — même moteur que production, aucun write DB.
 */

import { buildScrimEmbed } from './scrimEmbedBuilder.js';
import {
  normalizeOptionalEmbedColor,
  normalizeOptionalEmbedEmoji,
  normalizeLineEmojisFromPatch,
  embedColorHexToInt,
  shouldUseLegacyEmojiPrefix,
} from './embedCustomizationValidation.js';
import { getEmbedPreset } from './embedCustomizationStore.js';
import { canUseFeature } from './entitlements/index.js';
import { ConfigWriteError } from './configWriteError.js';
import { resolveEffectiveEmbedStyle } from './embedCustomizationResolver.js';

/**
 * Scrim fictif contrôlé serveur (pas de données utilisateur).
 * @returns {import('./scrimEmbedBuilder.js').ScrimEmbedPayload}
 */
export function buildSampleScrimEmbedPayload() {
  return {
    gameKey: 'league_of_legends',
    rank: 'Or',
    dateStr: '01/01/2026',
    timeStr: '21:00',
    format: 'BO1',
    contactUserId: '1000000000000000001',
    contactDisplayName: 'PreviewPlayer',
    multiOpggUrl: null,
    scheduledAtIso: '2026-01-01T20:00:00.000Z',
    scheduledAtEndIso: null,
    nombreDeGames: 1,
    fearless: null,
    eloPrecision: null,
    structureNameSnapshot: 'Structure Preview',
    structureInviteUrl: null,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @param {{
 *   color_hex?: unknown,
 *   emoji?: unknown,
 *   emoji_date?: unknown,
 *   emoji_format?: unknown,
 *   emoji_rank?: unknown,
 *   emoji_contact?: unknown,
 *   emoji_structure?: unknown,
 *   preset_id?: unknown,
 *   locale?: string,
 *   nowMs?: number,
 *   stmts?: any,
 * }} body
 */
export function buildGuildEmbedPreview(db, guildId, body = {}) {
  if (!canUseFeature(guildId, 'live_preview', { nowMs: body.nowMs, stmts: body.stmts })) {
    throw new ConfigWriteError(403, 'FEATURE_NOT_AVAILABLE');
  }

  let colorHex = null;
  /** @type {string | null} */
  let emoji = null;
  let lineEmojis = {
    emoji_date: null,
    emoji_format: null,
    emoji_rank: null,
    emoji_contact: null,
    emoji_structure: null,
  };

  const hasLineKeys =
    'emoji_date' in body
    || 'emoji_format' in body
    || 'emoji_rank' in body
    || 'emoji_contact' in body
    || 'emoji_structure' in body;

  if (body.preset_id != null) {
    const presetId = Number(body.preset_id);
    if (!Number.isInteger(presetId) || presetId < 1) {
      throw new ConfigWriteError(400, 'PRESET_NOT_FOUND');
    }
    const preset = getEmbedPreset(db, guildId, presetId);
    if (!preset) {
      throw new ConfigWriteError(404, 'PRESET_NOT_FOUND');
    }
    colorHex = preset.color_hex;
    emoji = preset.emoji;
    lineEmojis = {
      emoji_date: preset.emoji_date,
      emoji_format: preset.emoji_format,
      emoji_rank: preset.emoji_rank,
      emoji_contact: preset.emoji_contact,
      emoji_structure: preset.emoji_structure,
    };
  } else if ('color_hex' in body || 'emoji' in body || hasLineKeys) {
    colorHex = normalizeOptionalEmbedColor(body.color_hex);
    // New UX preview: ignore legacy emoji write; only use line fields.
    if (hasLineKeys) {
      emoji = null;
      lineEmojis = normalizeLineEmojisFromPatch(body);
    } else {
      emoji = normalizeOptionalEmbedEmoji(body.emoji);
    }
  } else {
    const effective = resolveEffectiveEmbedStyle(db, guildId, {
      nowMs: body.nowMs,
      stmts: body.stmts,
    });
    colorHex = effective.colorHex;
    emoji = effective.useLegacyPrefix ? effective.emoji : null;
    lineEmojis = {
      emoji_date: effective.emoji_date,
      emoji_format: effective.emoji_format,
      emoji_rank: effective.emoji_rank,
      emoji_contact: effective.emoji_contact,
      emoji_structure: effective.emoji_structure,
    };
  }

  const colorInt = colorHex ? embedColorHexToInt(colorHex) : null;
  const locale = typeof body.locale === 'string' && body.locale.trim() ? body.locale.trim() : 'fr';
  const sample = buildSampleScrimEmbedPayload();
  const useLegacy = shouldUseLegacyEmojiPrefix({
    emoji,
    ...lineEmojis,
  });
  const embed = buildScrimEmbed(sample, locale, {
    includeContactInEmbed: true,
    includeContactHints: true,
    color: colorInt,
    emojiPrefix: useLegacy ? emoji : null,
    lineEmojis: {
      date: lineEmojis.emoji_date,
      format: lineEmojis.emoji_format,
      rank: lineEmojis.emoji_rank,
      contact: lineEmojis.emoji_contact,
      structure: lineEmojis.emoji_structure,
    },
  });

  return {
    color_hex: colorHex,
    emoji: useLegacy ? emoji : null,
    ...lineEmojis,
    embed: embed.toJSON(),
  };
}
