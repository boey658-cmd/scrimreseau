import { EmbedBuilder } from 'discord.js';
import { DateTime } from 'luxon';
import {
  buildPlayerSearchMainPhrase,
  formatPlayerSearchDatePhrase,
  formatPlayerSearchRankForEmbed,
  formatPlayerSearchRoleLabel,
  parsePlayerSearchDbDateToParisDateTime,
} from '../utils/playerSearchValidation.js';
import { SCRIM_TIMEZONE } from '../utils/scrimScheduledAt.js';
import {
  formatParisScrimListSchedule,
} from './scrimEmbedBuilder.js';

/** Embed Recherche Joueur disponible. */
export const PLAYER_SEARCH_EMBED_COLOR_ACTIVE = 0x57f287;
/** Embed fermé manuellement (/joueur-trouve). */
export const PLAYER_SEARCH_EMBED_COLOR_CLOSED_MANUAL = 0xed4245;
/** Embed fermé par expiration automatique. */
export const PLAYER_SEARCH_EMBED_COLOR_CLOSED_EXPIRED = 0x4f545c;

const CLOSED_PREFIX_MANUAL = '🔴 Joueurs trouvés';

const MAX_CONTACT_DISPLAY_NAME_LEN = 200;

/**
 * Ligne contact Recherche Joueur : mention + displayName (style scrim, séparateur ·).
 *
 * @param {string} contactUserId
 * @param {string | null | undefined} contactDisplayName
 * @returns {string}
 */
export function buildPlayerSearchContactLine(
  contactUserId,
  contactDisplayName,
) {
  const u =
    typeof contactDisplayName === 'string' ? contactDisplayName.trim() : '';
  const safe =
    u.length > MAX_CONTACT_DISPLAY_NAME_LEN
      ? `${u.slice(0, MAX_CONTACT_DISPLAY_NAME_LEN)}…`
      : u;
  if (safe) {
    return `👤 <@${contactUserId}> · ${safe}`;
  }
  return `👤 <@${contactUserId}>`;
}

/**
 * @param {string | null | undefined} json
 * @returns {string[]}
 */
function parseJsonStringArray(json) {
  if (typeof json !== 'string' || !json.trim()) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v) => typeof v === 'string')
      .map((v) => v.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * @param {string[]} roles
 * @returns {string}
 */
function formatRolesTitle(roles) {
  return roles.map(formatPlayerSearchRoleLabel).join(' / ') || 'Joueur';
}

/**
 * @param {string} scheduledTime
 * @param {{ dateStr: string, timeStr: string }} schedule
 * @returns {string}
 */
function formatSessionTimePhrase(scheduledTime, schedule) {
  const raw = String(scheduledTime ?? '').trim();
  if (raw && !raw.includes('-')) {
    return raw.replace(/\s*\(heure française\)\s*$/i, '').trim() || schedule.timeStr;
  }
  const timeStr = String(schedule.timeStr ?? '').trim();
  if (timeStr) return timeStr;
  return raw || '—';
}

/**
 * @typedef {{
 *   roles: string[],
 *   ranks: string[],
 *   playerCount: number,
 *   sessionType: string,
 *   ambiance: string,
 *   description?: string | null,
 *   contactUserId: string,
 *   contactDisplayName?: string | null,
 *   scheduledDate: string,
 *   scheduledTime: string,
 *   scheduledAtIso?: string | null,
 *   scheduledAtEndIso?: string | null,
 * }} PlayerSearchEmbedPayload
 */

/**
 * @param {Record<string, unknown>} row
 * @returns {PlayerSearchEmbedPayload}
 */
export function playerSearchDbRowToEmbedPayload(row) {
  const roles = parseJsonStringArray(
    typeof row.roles_json === 'string' ? row.roles_json : '[]',
  );
  const ranks = parseJsonStringArray(
    typeof row.ranks_json === 'string' ? row.ranks_json : '[]',
  );

  const scheduledAt =
    typeof row.scheduled_at === 'string' && row.scheduled_at.trim()
      ? row.scheduled_at.trim()
      : null;
  const scheduledAtEnd =
    typeof row.scheduled_at_end === 'string' && row.scheduled_at_end.trim()
      ? row.scheduled_at_end.trim()
      : null;

  const playerCountRaw = Number(row.player_count);
  const playerCount =
    Number.isFinite(playerCountRaw) && playerCountRaw >= 1
      ? Math.floor(playerCountRaw)
      : Math.max(roles.length, 1);

  return {
    roles,
    ranks,
    playerCount,
    sessionType: String(row.session_type ?? '').trim() || 'Session',
    ambiance: String(row.ambiance ?? '').trim() || '—',
    description:
      typeof row.description === 'string' && row.description.trim()
        ? row.description.trim()
        : null,
    contactUserId: String(row.contact_user_id ?? ''),
    contactDisplayName:
      typeof row.contact_display_name === 'string'
        ? row.contact_display_name
        : null,
    scheduledDate: String(row.scheduled_date ?? ''),
    scheduledTime: String(row.scheduled_time ?? ''),
    scheduledAtIso: scheduledAt,
    scheduledAtEndIso: scheduledAtEnd,
  };
}

/**
 * @param {PlayerSearchEmbedPayload} payload
 * @param {string | null} closedPrefix null = embed actif
 * @param {{ pastTense?: boolean }} [options]
 * @returns {string}
 */
export function buildPlayerSearchEmbedDescription(
  payload,
  closedPrefix = null,
  options = {},
) {
  const schedule = formatParisScrimListSchedule({
    scheduled_at: payload.scheduledAtIso ?? null,
    scheduled_at_end: payload.scheduledAtEndIso ?? null,
    scheduled_date: payload.scheduledDate,
    scheduled_time: payload.scheduledTime,
  });
  const timePhrase = formatSessionTimePhrase(payload.scheduledTime, schedule);

  const scheduledDateTime =
    parsePlayerSearchDbDateToParisDateTime(payload.scheduledDate) ??
    (payload.scheduledAtIso
      ? DateTime.fromISO(payload.scheduledAtIso, { zone: SCRIM_TIMEZONE }).startOf(
          'day',
        )
      : DateTime.now().setZone(SCRIM_TIMEZONE).startOf('day'));
  const datePhrase = formatPlayerSearchDatePhrase(scheduledDateTime);

  const mainLine = buildPlayerSearchMainPhrase({
    roles: payload.roles,
    ranks: payload.ranks,
    rankLabel: formatPlayerSearchRankForEmbed(payload.ranks),
    playerCount: payload.playerCount,
    sessionType: payload.sessionType,
    datePhrase,
    timePhrase,
    pastTense: options.pastTense ?? false,
  });

  /** @type {string[]} */
  const lines = [];
  if (closedPrefix) {
    lines.push(closedPrefix, '');
  }
  lines.push(
    mainLine,
    `🎯 ${payload.ambiance}`,
    buildPlayerSearchContactLine(
      payload.contactUserId,
      payload.contactDisplayName,
    ),
  );

  return lines.join('\n');
}

/**
 * @param {PlayerSearchEmbedPayload} payload
 * @param {number} color
 * @param {string | null} closedPrefix
 * @returns {EmbedBuilder}
 */
function buildPlayerSearchEmbedWithStatus(payload, color, closedPrefix = null) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`🔎 Recherche ${formatRolesTitle(payload.roles)}`)
    .setDescription(buildPlayerSearchEmbedDescription(payload, closedPrefix));
}

/**
 * @param {PlayerSearchEmbedPayload} payload
 * @returns {EmbedBuilder}
 */
export function buildPlayerSearchEmbed(payload) {
  return buildPlayerSearchEmbedWithStatus(
    payload,
    PLAYER_SEARCH_EMBED_COLOR_ACTIVE,
    null,
  );
}

/**
 * @param {'closed_manual' | 'closed_expired'} status
 * @param {Record<string, unknown>} dbRow
 * @returns {{ content: null, embeds: EmbedBuilder[], components: [] }}
 */
export function buildPlayerSearchClosedMessageEditOptions(status, dbRow) {
  const payload = playerSearchDbRowToEmbedPayload(dbRow);

  if (status === 'closed_manual') {
    return {
      content: null,
      embeds: [
        buildPlayerSearchEmbedWithStatus(
          payload,
          PLAYER_SEARCH_EMBED_COLOR_CLOSED_MANUAL,
          CLOSED_PREFIX_MANUAL,
        ),
      ],
      components: [],
    };
  }
  if (status === 'closed_expired') {
    const description = buildPlayerSearchEmbedDescription(payload, null, {
      pastTense: true,
    });
    return {
      content: null,
      embeds: [
        new EmbedBuilder()
          .setColor(PLAYER_SEARCH_EMBED_COLOR_CLOSED_EXPIRED)
          .setTitle('⚫ Recherche expirée')
          .setDescription(description),
      ],
      components: [],
    };
  }
  throw new Error(
    `buildPlayerSearchClosedMessageEditOptions: statut inconnu (${String(status)})`,
  );
}
