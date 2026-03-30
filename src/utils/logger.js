import { EmbedBuilder } from 'discord.js';
import {
  classifyDiscordEditError,
  getDiscordRetryWaitMs,
} from '../services/discordRetryPolicy.js';
import { SCRIM_TIMEZONE } from './scrimScheduledAt.js';

const levels = ['info', 'warn', 'error'];

const COLOR_ERROR = 0xed4245;
const COLOR_WARNING = 0xfaa61a;
const COLOR_EVENT = 0x5865f2;
const COLOR_HEALTH = 0x57f287;

const MAX_MESSAGE_LEN = 2000;
/** Contenu JSON dans le bloc code (valeur de champ embed ≤ 1024 caractères au total). */
const MAX_META_JSON_LEN = 980;
const MAX_STACK_LEN = 500;

function sleepLogger(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry borné pour le transport Discord du logger (pas d’import de discordApiGuard : évite cycle).
 * @template T
 * @param {() => Promise<T>} fn
 */
async function resilientLoggerDiscordCall(fn) {
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const c = classifyDiscordEditError(err);
      if (c.kind === 'terminal') throw err;
      if (attempt >= maxAttempts) throw err;
      const delay = getDiscordRetryWaitMs(err) ?? 800 * attempt;
      await sleepLogger(delay);
    }
  }
  throw lastErr;
}

/** Empêche toute réentrance / récursion vers Discord depuis le transport Discord. */
let isSendingDiscordLog = false;

/** @type {import('discord.js').Client | null} */
let discordLogClient = null;

/** @type {import('discord.js').TextBasedChannel | null} */
let errorChannel = null;

/** @type {import('discord.js').TextBasedChannel | null} */
let warningChannel = null;

/** @type {import('discord.js').TextBasedChannel | null} */
let eventChannel = null;

/** @type {import('discord.js').TextBasedChannel | null} */
let healthChannel = null;

/** Anti-spam Discord : clé = catégorie + message, valeur = dernier envoi ms. */
const discordLogSpamMap = new Map();
const SPAM_WINDOW_MS = 10_000;
const SPAM_MAP_MAX_KEYS = 500;

/** Clés métadonnées à ne jamais envoyer sur Discord (noms normalisés en minuscules). */
const SENSITIVE_META_KEY_PARTS = [
  'token',
  'secret',
  'password',
  'authorization',
  'cookie',
  'api_key',
  'apikey',
  'client_secret',
  'discord_token',
  'refreshtoken',
  'access_token',
  'credential',
];

/**
 * @param {string} key
 */
function isSensitiveMetaKey(key) {
  const k = String(key).toLowerCase();
  return SENSITIVE_META_KEY_PARTS.some((p) => k.includes(p));
}

/** @type {Intl.DateTimeFormat} */
let _parisLogDateFmt;

function formatFooterDateParis() {
  if (!_parisLogDateFmt) {
    _parisLogDateFmt = new Intl.DateTimeFormat('fr-FR', {
      timeZone: SCRIM_TIMEZONE,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
  const parts = _parisLogDateFmt.formatToParts(new Date());
  /** @param {string} t */
  const pick = (t) => parts.find((p) => p.type === t)?.value ?? '';
  const day = pick('day');
  const month = pick('month');
  const year = pick('year');
  let hour = pick('hour');
  let minute = pick('minute');
  if (hour.length === 1) hour = `0${hour}`;
  if (minute.length === 1) minute = `0${minute}`;
  return `${day}/${month}/${year} à ${hour}h${minute}`;
}

/**
 * Tronque une chaîne pour Discord / sécurité.
 * @param {string} s
 * @param {number} max
 */
function truncateStr(s, max) {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Retire les champs contexte du clone pour éviter doublon dans le JSON « Détails ».
 * @param {Record<string, unknown>} obj
 */
function stripContextKeysFromDetails(obj) {
  delete obj.guild_id;
  delete obj.guildId;
  delete obj.user_id;
  delete obj.userId;
}

/**
 * Métadonnées sûres pour Discord : pas de secrets, troncatures, stack limitée.
 * @param {unknown} meta
 * @param {{ stripContextKeys?: boolean }} [options] si `stripContextKeys: false`, conserve guild/user dans l’objet (ex. logs console).
 * @returns {{ sanitized: Record<string, unknown> | null; guildId: string | null; userId: string | null }}
 */
export function sanitizeMetadata(meta, options = {}) {
  const stripContextKeys = options.stripContextKeys !== false;
  if (meta === undefined || meta === null) {
    return { sanitized: null, guildId: null, userId: null };
  }

  let guildId = null;
  let userId = null;

  const walk = (v) => {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') return truncateStr(v, MAX_META_JSON_LEN);
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) {
      return v.slice(0, 50).map((item) => walk(item));
    }
    if (typeof v === 'object') {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (isSensitiveMetaKey(k)) {
          out[k] = '[redacted]';
          continue;
        }
        let next = val;
        if (k === 'stack' && typeof val === 'string') {
          next = truncateStr(val, MAX_STACK_LEN);
        }
        out[k] = walk(next);
      }
      return out;
    }
    return String(v);
  };

  /** @type {Record<string, unknown>} */
  let raw;
  try {
    raw =
      typeof meta === 'object' && meta !== null && !Array.isArray(meta)
        ? { .../** @type {Record<string, unknown>} */ (meta) }
        : { value: meta };
  } catch {
    return { sanitized: { _note: 'métadonnées non clonables' }, guildId: null, userId: null };
  }

  const g = raw.guild_id ?? raw.guildId ?? null;
  const u = raw.user_id ?? raw.userId ?? null;
  if (g != null && String(g).trim()) guildId = String(g).trim();
  if (u != null && String(u).trim()) userId = String(u).trim();

  const sanitized = /** @type {Record<string, unknown>} */ (walk(raw));
  if (stripContextKeys) {
    stripContextKeysFromDetails(sanitized);
  }

  const keys = Object.keys(sanitized).filter((k) => k !== '_note');
  if (keys.length === 0) {
    return { sanitized: null, guildId, userId };
  }

  return { sanitized, guildId, userId };
}

/**
 * @param {'error' | 'warn' | 'event' | 'health'} category
 * @param {string} message
 * @param {unknown} [meta]
 * @returns {EmbedBuilder}
 */
export function formatDiscordEmbed(category, message, meta) {
  const color =
    category === 'error'
      ? COLOR_ERROR
      : category === 'warn'
        ? COLOR_WARNING
        : category === 'event'
          ? COLOR_EVENT
          : COLOR_HEALTH;
  const title =
    category === 'error'
      ? '🚨 Erreur'
      : category === 'warn'
        ? '⚠️ Avertissement'
        : category === 'event'
          ? '📌 Événement'
          : '💚 Santé / cycle de vie';

  const safeMessage = truncateStr(String(message ?? ''), MAX_MESSAGE_LEN);
  const { sanitized, guildId, userId } = sanitizeMetadata(meta);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(`**Message**\n${safeMessage}`)
    .setFooter({
      text: `ScrimRéseau • ${formatFooterDateParis()}`,
    });

  /** @type {string[]} */
  const contextLines = [];
  if (guildId) {
    contextLines.push(`**Serveur** : \`${guildId}\``);
  }
  if (userId) {
    contextLines.push(`**Utilisateur** : <@${userId}>`);
  }
  if (contextLines.length > 0) {
    embed.addFields({
      name: 'Contexte',
      value: truncateStr(contextLines.join('\n'), 1024),
      inline: false,
    });
  }

  if (sanitized && Object.keys(sanitized).length > 0) {
    let json;
    try {
      json = JSON.stringify(sanitized, null, 0);
    } catch {
      json = '{"_erreur":"sérialisation JSON impossible"}';
    }
    json = truncateStr(json, MAX_META_JSON_LEN);
    const detailsBody = `\`\`\`json\n${json}\n\`\`\``;
    embed.addFields({
      name: 'Détails',
      value: truncateStr(detailsBody, 1024),
      inline: false,
    });
  }

  return embed;
}

/**
 * @param {'error' | 'warn' | 'event' | 'health'} category
 */
function spamKey(category, message) {
  return `${category}\0${String(message)}`;
}

function pruneSpamMap() {
  if (discordLogSpamMap.size > SPAM_MAP_MAX_KEYS) {
    discordLogSpamMap.clear();
  }
}

/**
 * @param {'error' | 'warn' | 'event' | 'health'} category
 */
function channelForCategory(category) {
  switch (category) {
    case 'error':
      return errorChannel;
    case 'warn':
      return warningChannel;
    case 'event':
      return eventChannel;
    case 'health':
      return healthChannel;
    default:
      return null;
  }
}

/**
 * @param {'error' | 'warn' | 'event' | 'health'} category
 * @param {string} message
 * @param {unknown} [meta]
 */
async function sendDiscordCategory(category, message, meta) {
  if (category !== 'error' && category !== 'warn' && category !== 'event' && category !== 'health') {
    return;
  }
  if (isSendingDiscordLog) return;

  const ch = channelForCategory(category);
  if (!ch || !discordLogClient) return;

  const key = spamKey(category, message);
  const now = Date.now();
  const last = discordLogSpamMap.get(key);
  if (last != null && now - last < SPAM_WINDOW_MS) {
    return;
  }

  isSendingDiscordLog = true;
  try {
    const embed = formatDiscordEmbed(category, message, meta);
    await resilientLoggerDiscordCall(() => ch.send({ embeds: [embed] }));
    discordLogSpamMap.set(key, now);
    pruneSpamMap();
  } catch (err) {
    try {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[logger] Échec envoi log Discord (transport secondaire) : ${msg}`);
    } catch {
      /* ignore */
    }
  } finally {
    isSendingDiscordLog = false;
  }
}

/**
 * @param {'error' | 'warn'} level
 * @param {string} message
 * @param {unknown} [meta]
 */
export async function sendDiscordLog(level, message, meta) {
  if (level !== 'error' && level !== 'warn') return;
  await sendDiscordCategory(level, message, meta);
}

/**
 * Récupère et valide les salons de logs ; best-effort, ne lance jamais.
 * @param {import('discord.js').Client} client
 */
export async function configureDiscordLogger(client) {
  errorChannel = null;
  warningChannel = null;
  eventChannel = null;
  healthChannel = null;
  discordLogClient = client;

  const errId =
    process.env.DISCORD_LOG_ERROR_CHANNEL_ID?.trim()
    ?? process.env.LOG_ERROR_CHANNEL_ID?.trim();
  const warnId =
    process.env.DISCORD_LOG_WARN_CHANNEL_ID?.trim()
    ?? process.env.LOG_WARNING_CHANNEL_ID?.trim();
  const eventId = process.env.DISCORD_LOG_EVENT_CHANNEL_ID?.trim();
  const healthId = process.env.DISCORD_LOG_HEALTH_CHANNEL_ID?.trim();

  if (!errId && !warnId && !eventId && !healthId) {
    return;
  }

  /**
   * @param {string | undefined} id
   * @param {'error' | 'warning' | 'event' | 'health'} kind
   */
  const load = async (id, kind) => {
    if (!id) return null;
    try {
      const raw = await resilientLoggerDiscordCall(() =>
        client.channels.fetch(id),
      );
      if (!raw?.isTextBased()) {
        try {
          console.warn(`[logger] Salon ${kind} (${id}) introuvable ou non textuel — ignoré.`);
        } catch {
          /* ignore */
        }
        return null;
      }
      return /** @type {import('discord.js').TextBasedChannel} */ (raw);
    } catch (e) {
      try {
        console.warn(`[logger] Impossible de charger le salon ${kind} (${id})`, {
          message: e instanceof Error ? e.message : String(e),
        });
      } catch {
        /* ignore */
      }
      return null;
    }
  };

  try {
    errorChannel = await load(errId, 'error');
    warningChannel = await load(warnId, 'warning');
    eventChannel = await load(eventId, 'event');
    healthChannel = await load(healthId, 'health');
  } catch (e) {
    try {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[logger] configureDiscordLogger : ${msg}`);
    } catch {
      /* ignore */
    }
  }

  if (errId && !errorChannel) {
    try {
      console.warn('[logger] Transport Discord erreur désactivé (salon invalide).');
    } catch {
      /* ignore */
    }
  }
  if (warnId && !warningChannel) {
    try {
      console.warn('[logger] Transport Discord avertissement désactivé (salon invalide).');
    } catch {
      /* ignore */
    }
  }
  if (eventId && !eventChannel) {
    try {
      console.warn('[logger] Transport Discord événements désactivé (salon invalide).');
    } catch {
      /* ignore */
    }
  }
  if (healthId && !healthChannel) {
    try {
      console.warn('[logger] Transport Discord santé désactivé (salon invalide).');
    } catch {
      /* ignore */
    }
  }

  if (errorChannel || warningChannel || eventChannel || healthChannel) {
    try {
      console.log(
        `[logger] Transport Discord — erreur: ${errorChannel ? 'oui' : 'non'}, avertissement: ${warningChannel ? 'oui' : 'non'}, événement: ${eventChannel ? 'oui' : 'non'}, santé: ${healthChannel ? 'oui' : 'non'}`,
      );
    } catch {
      /* ignore */
    }
  }
}

/** Métadonnées console : même redaction/troncature que Discord, avec conservation des champs contexte pour le debug. */
function formatMetaConsole(meta) {
  if (meta === undefined || meta === null) return '';
  try {
    const { sanitized } = sanitizeMetadata(meta, { stripContextKeys: false });
    if (!sanitized || Object.keys(sanitized).length === 0) return '';
    return ` ${JSON.stringify(sanitized)}`;
  } catch {
    return ' [meta non sérialisable]';
  }
}

function log(level, message, meta) {
  if (!levels.includes(level)) level = 'info';
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${message}${formatMetaConsole(meta)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  if ((level === 'error' || level === 'warn') && !isSendingDiscordLog) {
    void sendDiscordCategory(level, message, meta).catch((err) => {
      try {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[logger] sendDiscordCategory inattendu : ${msg}`);
      } catch {
        /* ignore */
      }
    });
  }
}

function logEvent(message, meta) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [EVENT] ${message}${formatMetaConsole(meta)}`;
  console.log(line);

  if (!isSendingDiscordLog) {
    void sendDiscordCategory('event', message, meta).catch((err) => {
      try {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[logger] sendDiscordCategory (event) inattendu : ${msg}`);
      } catch {
        /* ignore */
      }
    });
  }
}

function logHealth(message, meta) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [HEALTH] ${message}${formatMetaConsole(meta)}`;
  console.log(line);

  if (!isSendingDiscordLog) {
    void sendDiscordCategory('health', message, meta).catch((err) => {
      try {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[logger] sendDiscordCategory (health) inattendu : ${msg}`);
      } catch {
        /* ignore */
      }
    });
  }
}

export const logger = {
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta),
  /** Événements métier peu fréquents (salon EVENT si configuré). */
  event: (message, meta) => logEvent(message, meta),
  /** Cycle de vie / santé (salon HEALTH si configuré). */
  health: (message, meta) => logHealth(message, meta),
};
