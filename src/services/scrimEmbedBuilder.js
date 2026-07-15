import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { getScrimEmoji } from '../utils/emojis.js';
import { SCRIM_TIMEZONE } from '../utils/scrimScheduledAt.js';

/** Embed scrim disponible (publication / réseau). */
export const SCRIM_EMBED_COLOR_ACTIVE = 0x57f287;
/** Embed fermé manuellement (/scrim-trouve). */
export const SCRIM_EMBED_COLOR_CLOSED_MANUAL = 0xed4245;
/** Embed fermé par expiration automatique. */
export const SCRIM_EMBED_COLOR_CLOSED_EXPIRED = 0x4f545c;
/** Ancienne annonce réseau remplacée par un repost (gris foncé — pas « trouvé »). */
export const SCRIM_EMBED_COLOR_SUPERSEDED = 0x4f545c;

const SCRIM_STATUS_LINE_ACTIVE = '🟢 Recherche en cours';
const SCRIM_STATUS_LINE_CLOSED_MANUAL = '🔴 Scrim trouvé — indisponible';
const SCRIM_STATUS_LINE_CLOSED_EXPIRED = '⚫ Scrim expiré — indisponible';
const SCRIM_STATUS_LINE_SUPERSEDED =
  '🔴 Ancienne annonce — une nouvelle annonce a été repostée';

// ---------------------------------------------------------------------------
// Emojis custom rangs + OP.GG
// ---------------------------------------------------------------------------

/** Balises custom Discord pour les rangs et OP.GG. */
const CUSTOM_EMOJIS = Object.freeze({
  iron:        '<:iron:1521794187006316615>',
  bronze:      '<:bronze:1521794229951660053>',
  silver:      '<:silver:1521794275702997032>',
  gold:        '<:gold:1521794312642232400>',
  platinum:    '<:platinum:1521794349539655770>',
  emerald:     '<:emerald:1521794386642337822>',
  diamond:     '<:diamond:1521794418787749938>',
  master:      '<:master:1521794452111364228>',
  grandmaster: '<:grandmaster:1521794486102134824>',
  challenger:  '<:challenger:1521794520860069988>',
  opgg:        '<:opgg:1521794035990138921>',
  heure:       '<:heur:1521799737412419725>',
  fearless:    '<:fearless:1521804294062608505>',
});

/**
 * Tiers du rang, du plus bas (index 0) au plus élevé (index 9).
 * `keys` : noms français et anglais reconnus (comparaison exacte, insensible à la casse).
 *
 * @type {ReadonlyArray<{ readonly keys: readonly string[], readonly tier: keyof typeof CUSTOM_EMOJIS }>}
 */
const RANK_TIERS = Object.freeze([
  { keys: Object.freeze(['fer', 'iron']),                                                    tier: 'iron' },
  { keys: Object.freeze(['bronze']),                                                         tier: 'bronze' },
  { keys: Object.freeze(['argent', 'silver']),                                               tier: 'silver' },
  { keys: Object.freeze(['or', 'gold']),                                                     tier: 'gold' },
  { keys: Object.freeze(['platine', 'platinum']),                                            tier: 'platinum' },
  { keys: Object.freeze(['émeraude', 'emeraude', 'emerald']),                               tier: 'emerald' },
  { keys: Object.freeze(['diamant', 'diamond']),                                             tier: 'diamond' },
  { keys: Object.freeze(['master']),                                                         tier: 'master' },
  { keys: Object.freeze(['grandmaster', 'grand maître', 'grand maitre', 'grand-maître']),   tier: 'grandmaster' },
  { keys: Object.freeze(['challenger']),                                                     tier: 'challenger' },
]);

/**
 * Indice de tier (0 = plus bas) pour un segment de rang normalisé.
 * Comparaison exacte sur le segment complet (évite le match 'master' dans 'grandmaster').
 * @param {string} segment
 * @returns {number} -1 si inconnu
 */
function getRankTierIndex(segment) {
  const norm = segment.toLowerCase().trim();
  for (let i = 0; i < RANK_TIERS.length; i++) {
    if (/** @type {readonly string[]} */ (RANK_TIERS[i].keys).includes(norm)) return i;
  }
  return -1;
}

/**
 * Retourne l'emoji custom du rang le plus élevé trouvé dans la chaîne.
 * Accepte les formats "Or", "Or / Platine", "Émeraude / Diamant", etc.
 * Si aucun rang reconnu : fallback `🏆`.
 *
 * @param {string | null | undefined} rankStr
 * @returns {string}
 */
export function getRankEmoji(rankStr) {
  if (typeof rankStr !== 'string' || !rankStr.trim()) return '🏆';

  let highestIndex = -1;
  let highestTier  = /** @type {keyof typeof CUSTOM_EMOJIS | null} */ (null);

  for (const segment of rankStr.split('/')) {
    const idx = getRankTierIndex(segment);
    if (idx > highestIndex) {
      highestIndex = idx;
      highestTier  = RANK_TIERS[idx].tier;
    }
  }

  return highestTier !== null ? CUSTOM_EMOJIS[highestTier] : '🏆';
}

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
const FEARLESS_LINE_PREFIX = CUSTOM_EMOJIS.fearless;

/**
 * Texte Fearless pour la ligne format, sans emoji (ex. "Fearless : Oui").
 * Retourne null si fearless absent / inconnu.
 * @param {string | null | undefined} fearless
 * @returns {string | null}
 */
function getFearlessText(fearless) {
  if (fearless === FEARLESS_VALUE_OUI) return 'Fearless : Oui';
  if (fearless === FEARLESS_VALUE_NON) return 'Fearless : Non';
  if (fearless === FEARLESS_VALUE_NIMPORTE) return "Fearless : N'importe";
  return null;
}

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
 *   structureNameSnapshot?: string | null,
 *   structureInviteUrl?: string | null,
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
  '👉 Rejoignez le serveur ScrimRéseau avec le bouton ci-dessous',
  '👉 Cela permet généralement de rendre la mention cliquable',
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
 * Boutons de diffusion scrim : lien serveur ScrimRéseau + bouton OP.GG optionnel.
 * @param {string | null | undefined} [multiOpggUrl] URL Multi OP.GG (si présente, bouton ajouté)
 * @returns {import('discord.js').ActionRowBuilder<import('discord.js').ButtonBuilder>[]}
 */
export function buildScrimCommunityServerActionRows(multiOpggUrl) {
  const communityUrl = getScrimCommunityServerUrlFromEnv();

  /** @type {import('discord.js').ButtonBuilder[]} */
  const buttons = [];

  if (communityUrl) {
    buttons.push(
      new ButtonBuilder()
        .setLabel('🔗 Rejoindre le serveur ScrimRéseau')
        .setStyle(ButtonStyle.Link)
        .setURL(communityUrl),
    );
  }

  if (typeof multiOpggUrl === 'string' && multiOpggUrl.length > 0) {
    buttons.push(
      new ButtonBuilder()
        .setLabel('Multi OP.GG')
        .setEmoji({ name: 'opgg', id: '1521794035990138921' })
        .setStyle(ButtonStyle.Link)
        .setURL(multiOpggUrl),
    );
  }

  if (buttons.length === 0) return [];
  return [/** @type {any} */ (new ActionRowBuilder().addComponents(...buttons))];
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
 * @param {ScrimEmbedPayload} payload
 * @returns {{ dateStr: string, timeStr: string }}
 */
function resolveScrimDisplaySchedule(payload) {
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

  return { dateStr, timeStr };
}

/**
 * @param {ScrimEmbedPayload} payload
 * @param {string} statusLine
 * @param {{ includeContactHints?: boolean }} [options]
 * @returns {string}
 */
function buildScrimEmbedDescription(payload, options = {}) {
  const { dateStr, timeStr } = resolveScrimDisplaySchedule(payload);

  const formatLine = formatScrimFormatLineForEmbed(
    payload.format,
    payload.nombreDeGames ?? null,
  );

  // ── Ligne 1 : date • heure (heure inline, pas d'emoji séparé) ───────
  const line1 = `${getScrimEmoji('date')} ${dateStr} • ${timeStr}`;

  // ── Ligne 2 : format (• Fearless texte si présent) ──────────────────
  const fearlessText = getFearlessText(payload.fearless ?? null);
  const line2 = fearlessText
    ? `${getScrimEmoji('format')} ${formatLine} • ${fearlessText}`
    : `${getScrimEmoji('format')} ${formatLine}`;

  // ── Ligne 3 : rang (emoji + texte, ligne dédiée) ────────────────────
  const rankEmoji = getRankEmoji(payload.rank);
  const line3 = `${rankEmoji} ${payload.rank}`;

  // ── Ligne 4 : contact ───────────────────────────────────────────────
  const contactLine = buildScrimContactDescriptionLines(
    payload.contactUserId,
    payload.contactDisplayName ?? null,
  )[0] ?? '';

  /** @type {string[]} */
  const lines = [line1, line2, line3, contactLine];

  // ── Ligne 5 (optionnelle) : structure (avec lien cliquable si disponible) ──
  if (payload.structureNameSnapshot) {
    const name = payload.structureNameSnapshot;
    const url = payload.structureInviteUrl ?? null;
    let structurePart;
    if (url) {
      // Échappement des caractères markdown dans le nom pour éviter l'injection de liens
      const safeName = name.replace(/[\[\]()]/g, '\\$&');
      structurePart = `[${safeName}](${url})`;
    } else {
      structurePart = name;
    }
    lines.push(`\uD83C\uDF10 Structure : ${structurePart}`);
  }

  if (options.includeContactHints) {
    lines.push(...SCRIM_CONTACT_BUTTON_HINT_LINES);
  }

  return lines.join('\n');
}

/**
 * @param {ScrimEmbedPayload} payload
 * @param {number} color
 * @param {string} statusLine
 * @param {{ includeContactHints?: boolean }} [options]
 * @returns {EmbedBuilder}
 */
function buildScrimEmbedWithStatus(payload, color, _statusLine, options = {}) {
  return new EmbedBuilder()
    .setColor(color)
    .setDescription(buildScrimEmbedDescription(payload, options));
}

/**
 * Édition Discord : vague réseau remplacée par un repost (scrim toujours actif en DB).
 * @param {Record<string, unknown>} dbRow ligne `scrim_posts`
 * @returns {{ content: null, embeds: EmbedBuilder[], components: [] }}
 */
export function buildScrimSupersededMessageEditOptions(dbRow) {
  const payload = scrimDbRowToEmbedPayload(dbRow);
  return {
    content: null,
    embeds: [
      buildScrimEmbedWithStatus(
        payload,
        SCRIM_EMBED_COLOR_SUPERSEDED,
        SCRIM_STATUS_LINE_SUPERSEDED,
      ),
    ],
    components: [],
  };
}

/**
 * Édition Discord après fermeture : embed coloré + statut (conserve les infos utiles).
 * @param {'closed_manual' | 'closed_expired'} status
 * @param {Record<string, unknown>} dbRow ligne `scrim_posts` après fermeture
 * @returns {{ content: null, embeds: EmbedBuilder[], components: [] }}
 */
export function buildScrimClosedMessageEditOptions(status, dbRow) {
  const payload = scrimDbRowToEmbedPayload(dbRow);

  if (status === 'closed_manual') {
    return {
      content: null,
      embeds: [
        buildScrimEmbedWithStatus(
          payload,
          SCRIM_EMBED_COLOR_CLOSED_MANUAL,
          SCRIM_STATUS_LINE_CLOSED_MANUAL,
        ),
      ],
      /** Retire le bouton lien éventuellement présent sur l’annonce ouverte. */
      components: [],
    };
  }
  if (status === 'closed_expired') {
    return {
      content: null,
      embeds: [
        buildScrimEmbedWithStatus(
          payload,
          SCRIM_EMBED_COLOR_CLOSED_EXPIRED,
          SCRIM_STATUS_LINE_CLOSED_EXPIRED,
        ),
      ],
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
  return buildScrimEmbedWithStatus(
    payload,
    SCRIM_EMBED_COLOR_ACTIVE,
    SCRIM_STATUS_LINE_ACTIVE,
    { includeContactHints: true },
  );
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
    structureNameSnapshot:
      typeof row.structure_name_snapshot === 'string' && row.structure_name_snapshot.trim()
        ? row.structure_name_snapshot.trim()
        : null,
    structureInviteUrl:
      typeof row.structure_invite_url_snapshot === 'string' && row.structure_invite_url_snapshot.trim()
        ? row.structure_invite_url_snapshot.trim()
        : null,
  };
}
