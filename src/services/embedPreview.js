/**
 * Preview embed (Phase 6) — même moteur que production, aucun write DB.
 */

import { buildScrimEmbed } from './scrimEmbedBuilder.js';
import {
  normalizeOptionalEmbedColor,
  normalizeOptionalEmbedEmoji,
  embedColorHexToInt,
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
  let emoji = null;

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
  } else if ('color_hex' in body || 'emoji' in body) {
    colorHex = normalizeOptionalEmbedColor(body.color_hex);
    emoji = normalizeOptionalEmbedEmoji(body.emoji);
  } else {
    const effective = resolveEffectiveEmbedStyle(db, guildId, {
      nowMs: body.nowMs,
      stmts: body.stmts,
    });
    colorHex = effective.colorHex;
    emoji = effective.emoji;
  }

  const colorInt = colorHex ? embedColorHexToInt(colorHex) : null;
  const locale = typeof body.locale === 'string' && body.locale.trim() ? body.locale.trim() : 'fr';
  const sample = buildSampleScrimEmbedPayload();
  const embed = buildScrimEmbed(sample, locale, {
    includeContactInEmbed: true,
    includeContactHints: true,
    color: colorInt,
    emojiPrefix: emoji,
  });

  return {
    color_hex: colorHex,
    emoji,
    embed: embed.toJSON(),
  };
}
