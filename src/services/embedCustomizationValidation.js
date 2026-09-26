/**
 * Validation personnalisation embed locale (Phase 6).
 * Couleur #RRGGBB + emoji Unicode OU balise Discord custom stricte.
 */

import { isDiscordCustomEmojiTag } from '../utils/emojis.js';
import { ConfigWriteError } from './configWriteError.js';

export const EMBED_COLOR_HEX_RE = /^#[0-9A-Fa-f]{6}$/;
/** Plafond global (Unicode court ou tag Discord <:name:id> / <a:name:id>). */
export const EMBED_EMOJI_MAX_CHARS = 64;
export const EMBED_EMOJI_MAX_GRAPHEMES = 4;
export const EMBED_PRESET_NAME_MAX = 40;
export const EMBED_PRESETS_MAX_PER_GUILD = 20;

/** Emojis configurables par ligne (Premium 2+). */
export const EMBED_LINE_EMOJI_KEYS = Object.freeze([
  'emoji_date',
  'emoji_format',
  'emoji_rank',
  'emoji_contact',
  'emoji_structure',
]);

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeOptionalEmbedColor(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') {
    throw new ConfigWriteError(400, 'INVALID_EMBED_COLOR', 'couleur invalide');
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!EMBED_COLOR_HEX_RE.test(trimmed)) {
    throw new ConfigWriteError(400, 'INVALID_EMBED_COLOR', 'couleur #RRGGBB requise');
  }
  return trimmed.toUpperCase();
}

/**
 * @param {string} colorHex
 * @returns {number}
 */
export function embedColorHexToInt(colorHex) {
  const n = Number.parseInt(colorHex.slice(1), 16);
  if (!Number.isFinite(n) || n < 0 || n > 0xffffff) {
    throw new ConfigWriteError(400, 'INVALID_EMBED_COLOR', 'couleur hors plage');
  }
  return n;
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeOptionalEmbedEmoji(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') {
    throw new ConfigWriteError(400, 'INVALID_EMOJI', 'emoji invalide');
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > EMBED_EMOJI_MAX_CHARS) {
    throw new ConfigWriteError(400, 'INVALID_EMOJI', 'emoji trop long');
  }

  // B) Discord custom — exact match only (<:name:id> | <a:name:id>)
  if (isDiscordCustomEmojiTag(trimmed)) {
    return trimmed;
  }

  // A) Unicode — refuse mentions / URLs / balises / texte libre ASCII
  const lower = trimmed.toLowerCase();
  if (
    lower.includes('@everyone')
    || lower.includes('@here')
    || /<@!?&?\d+>/.test(trimmed)
    || /<#\d+>/.test(trimmed)
    || trimmed.includes('`')
    || /https?:\/\//i.test(trimmed)
    || trimmed.includes('<')
    || trimmed.includes('>')
  ) {
    throw new ConfigWriteError(400, 'INVALID_EMOJI', 'emoji contenu interdit');
  }

  let graphemes = 0;
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      for (const _ of seg.segment(trimmed)) {
        graphemes += 1;
        if (graphemes > EMBED_EMOJI_MAX_GRAPHEMES) {
          throw new ConfigWriteError(400, 'INVALID_EMOJI', 'trop de graphemes');
        }
      }
    } else {
      graphemes = [...trimmed].length;
      if (graphemes > EMBED_EMOJI_MAX_GRAPHEMES) {
        throw new ConfigWriteError(400, 'INVALID_EMOJI', 'trop de graphemes');
      }
    }
  } catch (err) {
    if (err instanceof ConfigWriteError) throw err;
    throw new ConfigWriteError(400, 'INVALID_EMOJI', 'emoji invalide');
  }

  // Refuse ASCII-only "emojis" (texte libre)
  if (/^[\x20-\x7E]+$/.test(trimmed)) {
    throw new ConfigWriteError(400, 'INVALID_EMOJI', 'emoji Unicode requis');
  }

  return trimmed;
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizePresetName(raw) {
  if (typeof raw !== 'string') {
    throw new ConfigWriteError(400, 'PRESET_NAME_INVALID', 'nom invalide');
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > EMBED_PRESET_NAME_MAX) {
    throw new ConfigWriteError(400, 'PRESET_NAME_INVALID', 'nom invalide');
  }
  if (/[\u0000-\u001F]/.test(trimmed) || /@everyone|@here/i.test(trimmed)) {
    throw new ConfigWriteError(400, 'PRESET_NAME_INVALID', 'nom interdit');
  }
  return trimmed;
}

/**
 * Parse couleur stockée (fail soft pour builder).
 * @param {unknown} raw
 * @returns {string | null}
 */
export function coerceStoredColorHex(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!EMBED_COLOR_HEX_RE.test(t)) return null;
  return t.toUpperCase();
}

/**
 * Parse emoji stocké (fail soft).
 * @param {unknown} raw
 * @returns {string | null}
 */
export function coerceStoredEmoji(raw) {
  if (typeof raw !== 'string') return null;
  try {
    return normalizeOptionalEmbedEmoji(raw);
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown>} patch
 * @returns {{
 *   emoji_date: string | null,
 *   emoji_format: string | null,
 *   emoji_rank: string | null,
 *   emoji_contact: string | null,
 *   emoji_structure: string | null,
 * }}
 */
export function normalizeLineEmojisFromPatch(patch) {
  return {
    emoji_date: normalizeOptionalEmbedEmoji(patch.emoji_date),
    emoji_format: normalizeOptionalEmbedEmoji(patch.emoji_format),
    emoji_rank: normalizeOptionalEmbedEmoji(patch.emoji_rank),
    emoji_contact: normalizeOptionalEmbedEmoji(patch.emoji_contact),
    emoji_structure: normalizeOptionalEmbedEmoji(patch.emoji_structure),
  };
}

/**
 * @param {{
 *   emoji_date?: string | null,
 *   emoji_format?: string | null,
 *   emoji_rank?: string | null,
 *   emoji_contact?: string | null,
 *   emoji_structure?: string | null,
 * } | null | undefined} row
 * @returns {boolean}
 */
export function hasAnyLineEmoji(row) {
  if (!row) return false;
  return EMBED_LINE_EMOJI_KEYS.some((key) => {
    const v = row[key];
    return typeof v === 'string' && v.length > 0;
  });
}

/**
 * Préfixe legacy uniquement si `emoji` est set et aucun emoji ligne n'a été enregistré.
 * @param {{
 *   emoji?: string | null,
 *   emoji_date?: string | null,
 *   emoji_format?: string | null,
 *   emoji_rank?: string | null,
 *   emoji_contact?: string | null,
 *   emoji_structure?: string | null,
 * } | null | undefined} row
 * @returns {boolean}
 */
export function shouldUseLegacyEmojiPrefix(row) {
  if (!row) return false;
  return Boolean(row.emoji) && !hasAnyLineEmoji(row);
}

/**
 * @param {Record<string, unknown> | null | undefined} row
 * @returns {{
 *   emoji_date: string | null,
 *   emoji_format: string | null,
 *   emoji_rank: string | null,
 *   emoji_contact: string | null,
 *   emoji_structure: string | null,
 * }}
 */
export function coerceStoredLineEmojis(row) {
  return {
    emoji_date: coerceStoredEmoji(row?.emoji_date),
    emoji_format: coerceStoredEmoji(row?.emoji_format),
    emoji_rank: coerceStoredEmoji(row?.emoji_rank),
    emoji_contact: coerceStoredEmoji(row?.emoji_contact),
    emoji_structure: coerceStoredEmoji(row?.emoji_structure),
  };
}
