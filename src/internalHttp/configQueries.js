/**
 * Lectures READ-ONLY config guild (Web3B).
 * Tables config métier uniquement — aucune queue / lifecycle / broadcast.
 */

import { normalizeEnabledGuildLocale } from '../i18n/index.js';
import { validateDiscordInviteUrl } from '../utils/validation.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 */
export function fetchGuildConfig(db, guildId) {
  const language = readLanguage(db, guildId);
  const reception_channels = readReceptionChannels(db, guildId);
  const command_channel_id = readCommandChannelId(db, guildId);
  const inactive_message_policy = readInactiveMessagePolicy(db, guildId);
  const structure_invite_url = readStructureInviteUrl(db, guildId);
  const command_permissions = readCommandPermissions(db, guildId);

  return {
    guild_id: guildId,
    language,
    reception_channels,
    command_channel_id,
    inactive_message_policy,
    structure_invite_url,
    command_permissions,
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
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @returns {Array<{ game_key: string, channel_id: string }>}
 */
function readReceptionChannels(db, guildId) {
  /** @type {Array<{ game_key: unknown, channel_id: unknown }>} */
  const rows = db
    .prepare(
      `SELECT game_key, channel_id
       FROM guild_game_channels
       WHERE guild_id = ?
       ORDER BY game_key ASC`,
    )
    .all(guildId);

  return rows.map((row) => ({
    game_key: String(row.game_key ?? ''),
    channel_id: String(row.channel_id ?? ''),
  }));
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
