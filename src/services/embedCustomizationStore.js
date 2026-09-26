/**
 * Persistence customization / presets embed (Phase 6 + line emojis).
 */

import {
  EMBED_PRESETS_MAX_PER_GUILD,
  coerceStoredColorHex,
  coerceStoredEmoji,
  coerceStoredLineEmojis,
  hasAnyLineEmoji,
} from './embedCustomizationValidation.js';
import { ConfigWriteError } from './configWriteError.js';

/**
 * @typedef {{
 *   guild_id: string,
 *   color_hex: string | null,
 *   emoji: string | null,
 *   emoji_date: string | null,
 *   emoji_format: string | null,
 *   emoji_rank: string | null,
 *   emoji_contact: string | null,
 *   emoji_structure: string | null,
 *   active_preset_id: number | null,
 *   created_at: number,
 *   updated_at: number,
 * }} EmbedCustomizationRow
 */

/**
 * @typedef {{
 *   id: number,
 *   guild_id: string,
 *   name: string,
 *   color_hex: string | null,
 *   emoji: string | null,
 *   emoji_date: string | null,
 *   emoji_format: string | null,
 *   emoji_rank: string | null,
 *   emoji_contact: string | null,
 *   emoji_structure: string | null,
 *   created_at: number,
 *   updated_at: number,
 * }} EmbedPresetRow
 */

const CUST_COLS =
  'guild_id, color_hex, emoji, emoji_date, emoji_format, emoji_rank, emoji_contact, emoji_structure, active_preset_id, created_at, updated_at';
const PRESET_COLS =
  'id, guild_id, name, color_hex, emoji, emoji_date, emoji_format, emoji_rank, emoji_contact, emoji_structure, created_at, updated_at';

/**
 * @param {Record<string, unknown>} row
 * @returns {EmbedCustomizationRow}
 */
function mapCustomizationRow(row) {
  const lines = coerceStoredLineEmojis(row);
  return {
    guild_id: String(row.guild_id),
    color_hex: coerceStoredColorHex(row.color_hex),
    emoji: coerceStoredEmoji(row.emoji),
    ...lines,
    active_preset_id:
      row.active_preset_id == null ? null : Number(row.active_preset_id),
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
  };
}

/**
 * @param {Record<string, unknown>} row
 * @returns {EmbedPresetRow}
 */
function mapPresetRow(row) {
  const lines = coerceStoredLineEmojis(row);
  return {
    id: Number(row.id),
    guild_id: String(row.guild_id),
    name: String(row.name),
    color_hex: coerceStoredColorHex(row.color_hex),
    emoji: coerceStoredEmoji(row.emoji),
    ...lines,
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @returns {EmbedCustomizationRow | null}
 */
export function getEmbedCustomization(db, guildId) {
  try {
    const row = db
      .prepare(
        `SELECT ${CUST_COLS}
         FROM guild_embed_customization WHERE guild_id = ? LIMIT 1`,
      )
      .get(guildId);
    if (!row) return null;
    return mapCustomizationRow(row);
  } catch {
    return null;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @param {{
 *   color_hex: string | null,
 *   emoji: string | null,
 *   emoji_date: string | null,
 *   emoji_format: string | null,
 *   emoji_rank: string | null,
 *   emoji_contact: string | null,
 *   emoji_structure: string | null,
 *   active_preset_id: number | null,
 * }} data
 * @param {number} [nowMs]
 */
export function upsertEmbedCustomization(db, guildId, data, nowMs = Date.now()) {
  const lines = {
    emoji_date: data.emoji_date ?? null,
    emoji_format: data.emoji_format ?? null,
    emoji_rank: data.emoji_rank ?? null,
    emoji_contact: data.emoji_contact ?? null,
    emoji_structure: data.emoji_structure ?? null,
  };
  db.prepare(
    `INSERT INTO guild_embed_customization
       (guild_id, color_hex, emoji, emoji_date, emoji_format, emoji_rank, emoji_contact, emoji_structure, active_preset_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET
       color_hex = excluded.color_hex,
       emoji = excluded.emoji,
       emoji_date = excluded.emoji_date,
       emoji_format = excluded.emoji_format,
       emoji_rank = excluded.emoji_rank,
       emoji_contact = excluded.emoji_contact,
       emoji_structure = excluded.emoji_structure,
       active_preset_id = excluded.active_preset_id,
       updated_at = excluded.updated_at`,
  ).run(
    guildId,
    data.color_hex,
    data.emoji,
    lines.emoji_date,
    lines.emoji_format,
    lines.emoji_rank,
    lines.emoji_contact,
    lines.emoji_structure,
    data.active_preset_id,
    nowMs,
    nowMs,
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 */
export function deleteEmbedCustomization(db, guildId) {
  db.prepare(`DELETE FROM guild_embed_customization WHERE guild_id = ?`).run(guildId);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @returns {EmbedPresetRow[]}
 */
export function listEmbedPresets(db, guildId) {
  try {
    const rows = db
      .prepare(
        `SELECT ${PRESET_COLS}
         FROM guild_embed_presets WHERE guild_id = ?
         ORDER BY name COLLATE NOCASE ASC, id ASC`,
      )
      .all(guildId);
    return rows.map((row) => mapPresetRow(row));
  } catch {
    return [];
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @param {number} presetId
 * @returns {EmbedPresetRow | null}
 */
export function getEmbedPreset(db, guildId, presetId) {
  try {
    const row = db
      .prepare(
        `SELECT ${PRESET_COLS}
         FROM guild_embed_presets WHERE guild_id = ? AND id = ? LIMIT 1`,
      )
      .get(guildId, presetId);
    if (!row) return null;
    return mapPresetRow(row);
  } catch {
    return null;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} guildIds
 * @returns {Map<string, { customization: EmbedCustomizationRow | null, presetsById: Map<number, EmbedPresetRow> }>}
 */
export function getEmbedStylesBatch(db, guildIds) {
  /** @type {Map<string, { customization: EmbedCustomizationRow | null, presetsById: Map<number, EmbedPresetRow> }>} */
  const map = new Map();
  if (!Array.isArray(guildIds) || guildIds.length === 0) return map;

  const unique = [...new Set(guildIds.map((id) => String(id)).filter(Boolean))];
  for (const id of unique) {
    map.set(id, { customization: null, presetsById: new Map() });
  }

  const chunkSize = 400;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    try {
      const custRows = db
        .prepare(
          `SELECT ${CUST_COLS}
           FROM guild_embed_customization WHERE guild_id IN (${placeholders})`,
        )
        .all(...chunk);
      for (const row of custRows) {
        const gid = String(row.guild_id);
        const entry = map.get(gid);
        if (!entry) continue;
        entry.customization = mapCustomizationRow(row);
      }
    } catch {
      /* fail soft */
    }

    try {
      const presetRows = db
        .prepare(
          `SELECT ${PRESET_COLS}
           FROM guild_embed_presets WHERE guild_id IN (${placeholders})`,
        )
        .all(...chunk);
      for (const row of presetRows) {
        const gid = String(row.guild_id);
        const entry = map.get(gid);
        if (!entry) continue;
        const preset = mapPresetRow(row);
        entry.presetsById.set(preset.id, preset);
      }
    } catch {
      /* fail soft */
    }
  }

  return map;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @param {{
 *   name: string,
 *   color_hex: string | null,
 *   emoji: string | null,
 *   emoji_date: string | null,
 *   emoji_format: string | null,
 *   emoji_rank: string | null,
 *   emoji_contact: string | null,
 *   emoji_structure: string | null,
 * }} data
 * @param {number} [nowMs]
 * @returns {EmbedPresetRow}
 */
export function createEmbedPreset(db, guildId, data, nowMs = Date.now()) {
  const countRow = db
    .prepare(`SELECT COUNT(*) AS c FROM guild_embed_presets WHERE guild_id = ?`)
    .get(guildId);
  if (Number(countRow?.c ?? 0) >= EMBED_PRESETS_MAX_PER_GUILD) {
    throw new ConfigWriteError(400, 'PRESET_LIMIT_REACHED');
  }

  const payload = {
    name: data.name,
    color_hex: data.color_hex,
    emoji: data.emoji ?? null,
    emoji_date: data.emoji_date ?? null,
    emoji_format: data.emoji_format ?? null,
    emoji_rank: data.emoji_rank ?? null,
    emoji_contact: data.emoji_contact ?? null,
    emoji_structure: data.emoji_structure ?? null,
  };

  try {
    const info = db
      .prepare(
        `INSERT INTO guild_embed_presets
           (guild_id, name, color_hex, emoji, emoji_date, emoji_format, emoji_rank, emoji_contact, emoji_structure, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        guildId,
        payload.name,
        payload.color_hex,
        payload.emoji,
        payload.emoji_date,
        payload.emoji_format,
        payload.emoji_rank,
        payload.emoji_contact,
        payload.emoji_structure,
        nowMs,
        nowMs,
      );
    return {
      id: Number(info.lastInsertRowid),
      guild_id: guildId,
      ...payload,
      created_at: nowMs,
      updated_at: nowMs,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE/i.test(msg)) {
      throw new ConfigWriteError(400, 'PRESET_ALREADY_EXISTS');
    }
    throw err;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @param {number} presetId
 * @param {{
 *   name: string,
 *   color_hex: string | null,
 *   emoji: string | null,
 *   emoji_date: string | null,
 *   emoji_format: string | null,
 *   emoji_rank: string | null,
 *   emoji_contact: string | null,
 *   emoji_structure: string | null,
 * }} data
 * @param {number} [nowMs]
 * @returns {EmbedPresetRow}
 */
export function updateEmbedPreset(db, guildId, presetId, data, nowMs = Date.now()) {
  const existing = getEmbedPreset(db, guildId, presetId);
  if (!existing) {
    throw new ConfigWriteError(404, 'PRESET_NOT_FOUND');
  }
  try {
    db.prepare(
      `UPDATE guild_embed_presets
       SET name = ?, color_hex = ?, emoji = ?,
           emoji_date = ?, emoji_format = ?, emoji_rank = ?, emoji_contact = ?, emoji_structure = ?,
           updated_at = ?
       WHERE guild_id = ? AND id = ?`,
    ).run(
      data.name,
      data.color_hex,
      data.emoji,
      data.emoji_date,
      data.emoji_format,
      data.emoji_rank,
      data.emoji_contact,
      data.emoji_structure,
      nowMs,
      guildId,
      presetId,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE/i.test(msg)) {
      throw new ConfigWriteError(400, 'PRESET_ALREADY_EXISTS');
    }
    throw err;
  }
  return {
    ...existing,
    name: data.name,
    color_hex: data.color_hex,
    emoji: data.emoji,
    emoji_date: data.emoji_date,
    emoji_format: data.emoji_format,
    emoji_rank: data.emoji_rank,
    emoji_contact: data.emoji_contact,
    emoji_structure: data.emoji_structure,
    updated_at: nowMs,
  };
}

/**
 * Delete preset + clear active_preset_id if pointing to it (transaction).
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @param {number} presetId
 */
export function deleteEmbedPreset(db, guildId, presetId) {
  const trx = db.transaction(() => {
    const existing = getEmbedPreset(db, guildId, presetId);
    if (!existing) {
      throw new ConfigWriteError(404, 'PRESET_NOT_FOUND');
    }
    db.prepare(`DELETE FROM guild_embed_presets WHERE guild_id = ? AND id = ?`).run(
      guildId,
      presetId,
    );
    db.prepare(
      `UPDATE guild_embed_customization
       SET active_preset_id = NULL, updated_at = ?
       WHERE guild_id = ? AND active_preset_id = ?`,
    ).run(Date.now(), guildId, presetId);
  });
  trx();
}

/**
 * Apply preset as active style.
 * New-style presets (any line emoji) clear legacy `emoji`.
 * Legacy presets (emoji only) keep prefix behavior.
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @param {number} presetId
 * @param {number} [nowMs]
 */
export function applyEmbedPreset(db, guildId, presetId, nowMs = Date.now()) {
  const preset = getEmbedPreset(db, guildId, presetId);
  if (!preset) {
    throw new ConfigWriteError(404, 'PRESET_NOT_FOUND');
  }
  const lineMode = hasAnyLineEmoji(preset) || preset.emoji == null;
  upsertEmbedCustomization(
    db,
    guildId,
    {
      color_hex: preset.color_hex,
      emoji: lineMode ? null : preset.emoji,
      emoji_date: preset.emoji_date,
      emoji_format: preset.emoji_format,
      emoji_rank: preset.emoji_rank,
      emoji_contact: preset.emoji_contact,
      emoji_structure: preset.emoji_structure,
      active_preset_id: preset.id,
    },
    nowMs,
  );
}
