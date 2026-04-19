import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { getEmbedColorForGame } from '../config/gameEmbedColors.js';
import { getScrimEmoji } from '../utils/emojis.js';
import { SCRIM_TIMEZONE } from '../utils/scrimScheduledAt.js';

/** Contenu du message Discord une fois la scrim fermée (embeds supprimés). */
export const SCRIM_CLOSED_MESSAGE_CONTENT = '────────────';

/** @type {Intl.DateTimeFormat} */
let _parisDateFormatter;
/** @type {Intl.DateTimeFormat} */
let _parisTimeFormatter;

function getParisDateFormatter() {
  if (!_parisDateFormatter) {
    _parisDateFormatter = new Intl.DateTimeFormat('fr-FR', {
      timeZone: SCRIM_TIMEZONE,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  }
  return _parisDateFormatter;
}

function getParisTimeFormatter() {
  if (!_parisTimeFormatter) {
    _parisTimeFormatter = new Intl.DateTimeFormat('fr-FR', {
      timeZone: SCRIM_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
  return _parisTimeFormatter;
}

/**
 * @param {Date} d
 * @returns {string} ex. 19h ou 19h30
 */
function formatParisHourMinuteCompact(d) {
  const timeParts = getParisTimeFormatter().formatToParts(d);
  const pick = (/** @type {Intl.DateTimeFormatPart[]} */ parts, type) =>
    parts.find((p) => p.type === type)?.value ?? '';
  const hour = parseInt(pick(timeParts, 'hour'), 10);
  const minute = parseInt(pick(timeParts, 'minute'), 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return '—';
  }
  if (minute === 0) return `${hour}h`;
  return `${hour}h${String(minute).padStart(2, '0')}`;
}

/**
 * Plage horaire compacte Paris (début–fin), pour horaire flexible.
 * @param {string} startIsoUtc
 * @param {string} endIsoUtc
 * @returns {string | null}
 */
export function formatParisFlexibleTimeRange(startIsoUtc, endIsoUtc) {
  try {
    const a = new Date(startIsoUtc);
    const b = new Date(endIsoUtc);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
    return `${formatParisHourMinuteCompact(a)}–${formatParisHourMinuteCompact(b)}`;
  } catch {
    return null;
  }
}

/**
 * Date + fragment horaire pour /mes-demandes et /liste-scrims (fixe ou plage).
 * @param {{
 *   scheduled_at: string | null | undefined,
 *   scheduled_at_end?: string | null | undefined,
 *   scheduled_date: string,
 *   scheduled_time: string,
 * }} row
 * @returns {{ dateStr: string, timeStr: string }}
 */
export function formatParisScrimListSchedule(row) {
  const startIso =
    typeof row.scheduled_at === 'string' && row.scheduled_at.trim()
      ? row.scheduled_at.trim()
      : null;
  const endIso =
    typeof row.scheduled_at_end === 'string' &&
    row.scheduled_at_end.trim()
      ? row.scheduled_at_end.trim()
      : null;

  if (startIso && endIso) {
    const d = formatParisDisplayFromUtcIso(startIso);
    const range = formatParisFlexibleTimeRange(startIso, endIso);
    if (d && range) {
      return { dateStr: d.dateStr, timeStr: range };
    }
  }

  if (startIso) {
    const d = formatParisDisplayFromUtcIso(startIso);
    if (d) {
      const rawT = d.timeStr.replace(' (heure française)', '');
      const timePart = /^(\d{1,2})h(\d{2})$/.test(rawT)
        ? rawT.replace(/^(\d{1,2})h(\d{2})$/, (_, h, m) =>
            `${String(h).padStart(2, '0')}:${m}`,
          )
        : rawT;
      return { dateStr: d.dateStr, timeStr: timePart };
    }
  }
  const st = String(row.scheduled_time ?? '').trim();
  return { dateStr: String(row.scheduled_date), timeStr: st };
}

/**
 * À partir d’un instant UTC (ISO), lignes d’affichage date + heure Paris.
 * @param {string | null | undefined} isoString
 * @returns {{ dateStr: string, timeStr: string } | null} null si instant illisible
 */
export function formatParisDisplayFromUtcIso(isoString) {
  try {
    if (typeof isoString !== 'string' || !isoString.trim()) return null;
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return null;

    const dateParts = getParisDateFormatter().formatToParts(d);
    const timeParts = getParisTimeFormatter().formatToParts(d);

    const pick = (parts, type) =>
      parts.find((p) => p.type === type)?.value ?? '';

    const day = pick(dateParts, 'day').padStart(2, '0');
    const month = pick(dateParts, 'month').padStart(2, '0');
    const year = pick(dateParts, 'year');

    const hour = pick(timeParts, 'hour').padStart(2, '0');
    const minute = pick(timeParts, 'minute').padStart(2, '0');

    return {
      dateStr: `${day}/${month}/${year}`,
      timeStr: `${hour}h${minute} (heure française)`,
    };
  } catch {
    return null;
  }
}

/**
 * Libellé stocké en `format_key` pour une série (aligné sur `games.js`).
 */
export const FORMAT_SCRIM_SERIE_KEY = 'Scrim série';

/** Valeurs stockées en `tags.fearless` (choix slash, minuscules). */
export const FEARLESS_VALUE_OUI = 'oui';
export const FEARLESS_VALUE_NON = 'non';
export const FEARLESS_VALUE_NIMPORTE = 'nimporte';

/** Préfixe ligne Fearless dans la description d’embed (emoji custom du serveur). */
const FEARLESS_LINE_PREFIX = '<:fearless:1484869493992849519>';

/**
 * @typedef {{
 *   gameKey: string,
 *   rank: string,
 *   dateStr: string,
 *   timeStr: string,
 *   format: string,
 *   contactUserId: string,
 *   contactDisplayName?: string | null,
 *   multiOpggUrl?: string | null,
 *   scheduledAtIso?: string | null,
 *   scheduledAtEndIso?: string | null,
 *   nombreDeGames?: number | null,
 *   fearless?: string | null,
 * }} ScrimEmbedPayload
 */

/**
 * @param {string | null | undefined} tagsStr
 * @returns {Record<string, unknown> | null}
 */
function parseTagsObject(tagsStr) {
  if (typeof tagsStr !== 'string') return null;
  const t = tagsStr.trim();
  if (t === '' || t === '[]') return null;
  try {
    const o = JSON.parse(t);
    if (Array.isArray(o)) return null;
    if (o && typeof o === 'object') return /** @type {Record<string, unknown>} */ (o);
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * @param {string | null | undefined} tagsStr
 * @returns {number | null}
 */
export function parseNombreDeGamesFromTags(tagsStr) {
  const o = parseTagsObject(tagsStr);
  if (!o) return null;
  if (Number.isFinite(o.nombre_de_games)) {
    const n = Math.floor(Number(o.nombre_de_games));
    if (n >= 2 && n <= 10) return n;
  }
  return null;
}

/**
 * Lit `tags.fearless`. Legacy sans clé → `null` (rien à afficher).
 * @param {string | null | undefined} tagsStr
 * @returns {typeof FEARLESS_VALUE_OUI | typeof FEARLESS_VALUE_NON | typeof FEARLESS_VALUE_NIMPORTE | null}
 */
export function parseFearlessFromTags(tagsStr) {
  const o = parseTagsObject(tagsStr);
  if (!o || !Object.prototype.hasOwnProperty.call(o, 'fearless')) return null;
  const v = o.fearless;
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  if (t === FEARLESS_VALUE_NIMPORTE) return FEARLESS_VALUE_NIMPORTE;
  if (t === FEARLESS_VALUE_OUI) return FEARLESS_VALUE_OUI;
  if (t === FEARLESS_VALUE_NON) return FEARLESS_VALUE_NON;
  return null;
}

/**
 * @param {string | null | undefined} fearless
 * @returns {string | null} ligne description ou null si absent (legacy) / valeur inconnue
 */
export function formatFearlessLineForEmbed(fearless) {
  if (fearless == null) return null;
  if (fearless === FEARLESS_VALUE_OUI) {
    return `${FEARLESS_LINE_PREFIX} Fearless : Oui`;
  }
  if (fearless === FEARLESS_VALUE_NON) {
    return `${FEARLESS_LINE_PREFIX} Fearless : Non`;
  }
  if (fearless === FEARLESS_VALUE_NIMPORTE) {
    return `${FEARLESS_LINE_PREFIX} Fearless : N'importe`;
  }
  return null;
}

const MAX_CONTACT_USERNAME_LEN = 200;

/**
 * Ligne contact : mention + pseudo Discord sur une seule ligne si connu.
 * @param {string} contactUserId
 * @param {string | null | undefined} contactUsername
 * @returns {string[]}
 */
function buildScrimContactDescriptionLines(contactUserId, contactUsername) {
  const u = typeof contactUsername === 'string' ? contactUsername.trim() : '';
  const safe =
    u.length > MAX_CONTACT_USERNAME_LEN
      ? `${u.slice(0, MAX_CONTACT_USERNAME_LEN)}…`
      : u;
  if (safe) {
    return [`👤 <@${contactUserId}> • ${safe}`];
  }
  return [`👤 <@${contactUserId}>`];
}

/** Explication courte sous le contact (bouton lien sous le message). */
const SCRIM_CONTACT_BUTTON_HINT_LINES = [
  "⚠️ Si la mention du contact ci-dessus n'est pas cliquable",
  '👉 rejoignez le serveur ScrimRéseau avec le bouton ci-dessous',
  '👉 cela permet généralement de rendre la mention cliquable',
];

/**
 * URL HTTP(S) valide pour le bouton « serveur ScrimRéseau », ou null si absente / invalide.
 * Ne lève pas : safe au démarrage si la variable d’environnement est mal formée.
 * @param {string | undefined} raw valeur brute (ex. process.env.SCRIM_COMMUNITY_SERVER_URL)
 * @returns {string | null}
 */
export function parseScrimCommunityServerUrl(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Lit l’URL depuis l’environnement (aucune URL en dur dans le code source).
 * @returns {string | null}
 */
export function getScrimCommunityServerUrlFromEnv() {
  return parseScrimCommunityServerUrl(process.env.SCRIM_COMMUNITY_SERVER_URL);
}

/**
 * Bouton lien vers le serveur ScrimRéseau (messages de diffusion scrim).
 * @returns {import('discord.js').ActionRowBuilder<import('discord.js').ButtonBuilder>[]}
 */
export function buildScrimCommunityServerActionRows() {
  const url = getScrimCommunityServerUrlFromEnv();
  if (!url) return [];

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('🔗 Rejoindre le serveur ScrimRéseau')
      .setStyle(ButtonStyle.Link)
      .setURL(url),
  );
  return [row];
}

/**
 * Ligne « format » dans l’embed : inchangée si pas de nombre, sinon suffixe pour série.
 * @param {string} formatKey
 * @param {number | null | undefined} nombreDeGames
 * @returns {string}
 */
export function formatScrimFormatLineForEmbed(formatKey, nombreDeGames) {
  if (
    formatKey === FORMAT_SCRIM_SERIE_KEY &&
    nombreDeGames != null &&
    Number.isFinite(nombreDeGames)
  ) {
    return `${FORMAT_SCRIM_SERIE_KEY} — ${nombreDeGames} games`;
  }
  return formatKey;
}

/**
 * Édition Discord après fermeture : texte minimal, aucun embed (remplace l’embed actif).
 * @param {'closed_manual' | 'closed_expired'} status
 * @returns {{ content: string, embeds: [] }}
 */
export function buildScrimClosedMessageEditOptions(status) {
  if (status === 'closed_manual' || status === 'closed_expired') {
    return {
      content: SCRIM_CLOSED_MESSAGE_CONTENT,
      embeds: [],
      /** Retire le bouton lien éventuellement présent sur l’annonce ouverte. */
      components: [],
    };
  }
  throw new Error(`buildScrimClosedMessageEditOptions: statut inconnu (${String(status)})`);
}

/**
 * @param {ScrimEmbedPayload} payload
 * @returns {EmbedBuilder}
 */
export function buildScrimEmbed(payload) {
  let dateStr = payload.dateStr;
  let timeStr = payload.timeStr;

  if (payload.scheduledAtIso) {
    try {
      const startIso = payload.scheduledAtIso;
      const endIso = payload.scheduledAtEndIso?.trim() || null;
      if (endIso) {
        const paris = formatParisDisplayFromUtcIso(startIso);
        const range = formatParisFlexibleTimeRange(startIso, endIso);
        if (paris && range) {
          dateStr = paris.dateStr;
          timeStr = range;
        } else {
          timeStr = 'Heure inconnue';
        }
      } else {
        const paris = formatParisDisplayFromUtcIso(startIso);
        if (paris) {
          dateStr = paris.dateStr;
          timeStr = paris.timeStr;
        } else {
          timeStr = 'Heure inconnue';
        }
      }
    } catch {
      timeStr = 'Heure inconnue';
    }
  }

  const formatLine = formatScrimFormatLineForEmbed(
    payload.format,
    payload.nombreDeGames ?? null,
  );

  const fearlessLine = formatFearlessLineForEmbed(
    payload.fearless ?? null,
  );

  const formatBlock = `${getScrimEmoji('format')} ${formatLine}`;
  const formatAndFearlessLine = fearlessLine
    ? `${formatBlock} • ${fearlessLine}`
    : formatBlock;

  const description = [
    `${getScrimEmoji('date')} ${dateStr}`,
    `${getScrimEmoji('heure')} ${timeStr}`,
    formatAndFearlessLine,
    `${getScrimEmoji('rang')} ${payload.rank}`,
    ...buildScrimContactDescriptionLines(
      payload.contactUserId,
      payload.contactDisplayName ?? null,
    ),
    '',
    ...SCRIM_CONTACT_BUTTON_HINT_LINES,
  ].join('\n');

  const color = getEmbedColorForGame(payload.gameKey);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setDescription(description);

  const multiUrl = payload.multiOpggUrl;
  if (typeof multiUrl === 'string' && multiUrl.length > 0) {
    embed.addFields({
      name: '\u200B',
      value: `Multi OP.GG : [Ouvrir](${multiUrl})`,
      inline: false,
    });
  }

  return embed;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {ScrimEmbedPayload}
 */
export function scrimDbRowToEmbedPayload(row) {
  const scheduledAt =
    typeof row.scheduled_at === 'string' && row.scheduled_at.trim()
      ? row.scheduled_at
      : null;
  const scheduledAtEnd =
    typeof row.scheduled_at_end === 'string' && row.scheduled_at_end.trim()
      ? row.scheduled_at_end.trim()
      : null;

  const tagsRaw =
    typeof row.tags === 'string' && row.tags.trim() ? row.tags : '[]';

  return {
    gameKey: /** @type {string} */ (row.game_key),
    rank: /** @type {string} */ (row.rank_key),
    dateStr: /** @type {string} */ (row.scheduled_date),
    timeStr: /** @type {string} */ (row.scheduled_time),
    format: /** @type {string} */ (row.format_key),
    contactUserId: /** @type {string} */ (row.contact_user_id),
    multiOpggUrl: row.multi_opgg_url ?? null,
    scheduledAtIso: scheduledAt,
    scheduledAtEndIso: scheduledAtEnd,
    nombreDeGames: parseNombreDeGamesFromTags(tagsRaw),
    fearless: parseFearlessFromTags(tagsRaw),
  };
}
