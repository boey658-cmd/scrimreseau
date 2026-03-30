import { DateTime } from 'luxon';
import { getGame } from '../config/games.js';
import { SCRIM_TIMEZONE } from '../utils/scrimScheduledAt.js';
import { logger } from '../utils/logger.js';

/** Réponse — utilisateur blacklisté (/recherche-scrim, /scrim-trouve). */
export const GLOBAL_BLACKLIST_USER_MESSAGE =
  '❌ Tu es actuellement blacklist de ScrimRéseau.\nSi tu penses que c’est une erreur, contacte le support.';

/** Fail-closed — erreur lors du contrôle blacklist (commandes sensibles uniquement). */
export const GLOBAL_BLACKLIST_SERVICE_UNAVAILABLE_MESSAGE =
  '❌ Le service est momentanément indisponible. Réessaie plus tard.';

function logModerationSafe(/** @type {() => void} */ fn) {
  try {
    fn();
  } catch {
    /* ne jamais faire échouer le flux métier à cause du logger */
  }
}

export function scrimModerationEnvBurstMs() {
  const s = Number(process.env.SCRIM_CREATION_BURST_COOLDOWN_SECONDS);
  return Number.isFinite(s) && s > 0 ? Math.floor(s * 1000) : 45_000;
}

export function scrimModerationEnvWindowMs() {
  const m = Number(process.env.SCRIM_CREATION_WINDOW_MINUTES);
  return Number.isFinite(m) && m > 0 ? Math.floor(m * 60_000) : 30 * 60_000;
}

export function scrimModerationEnvWindowLimit() {
  const n = Number(process.env.SCRIM_CREATION_WINDOW_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8;
}

/** @param {number} createdAtMs */
function formatParisFromMs(createdAtMs) {
  return DateTime.fromMillis(createdAtMs, { zone: SCRIM_TIMEZONE }).toFormat(
    "dd/MM/yyyy HH'h'mm",
  );
}

/** @param {string} iso */
function formatParisFromIso(iso) {
  return DateTime.fromISO(iso, { zone: 'utc' })
    .setZone(SCRIM_TIMEZONE)
    .toFormat("dd/MM/yyyy HH'h'mm");
}

/**
 * Cooldown court : délai minimum entre deux **créations** (d’après la dernière ligne `scrim_posts` par date de création).
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {string} authorUserId
 */
export function checkScrimCreationBurstCooldown(stmts, authorUserId) {
  const burstMs = scrimModerationEnvBurstMs();
  /** @type {{ created_at?: number } | undefined} */
  const row = stmts.getLatestScrimCreationByAuthor.get(authorUserId);
  if (row == null || row.created_at == null) return { ok: true };
  const elapsed = Date.now() - Number(row.created_at);
  if (elapsed >= burstMs) return { ok: true };
  const sec = Math.max(1, Math.ceil((burstMs - elapsed) / 1000));
  return { ok: false, remainingSeconds: sec };
}

/**
 * Limite de **créations** sur la fenêtre glissante (compte les lignes avec `created_at` dans la fenêtre, tous statuts).
 * Distinct de {@link checkActiveScrimLimit} (compte les `status = 'active'` uniquement).
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {string} authorUserId
 */
export function checkScrimCreationWindowLimit(stmts, authorUserId) {
  const windowMs = scrimModerationEnvWindowMs();
  const limit = scrimModerationEnvWindowLimit();
  const cutoff = Date.now() - windowMs;
  /** @type {{ n?: number } | undefined} */
  const row = stmts.countScrimCreationsInWindowByAuthor.get(
    authorUserId,
    cutoff,
  );
  const n = Number(row?.n ?? 0);
  if (n < limit) return { ok: true };
  return { ok: false };
}

/** Nombre max de scrims `active` simultanés par auteur (hors création en cours). */
export const MAX_ACTIVE_SCRIMS_PER_USER = 10;

/**
 * Compte les lignes `status = 'active'` pour l’auteur (fermées / expirées exclues).
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {string} authorUserId
 */
export function checkActiveScrimLimit(stmts, authorUserId) {
  /** @type {{ n?: number } | undefined} */
  const row = stmts.countActiveScrimPostsByAuthor.get(authorUserId);
  const n = Number(row?.n ?? 0);
  if (n >= MAX_ACTIVE_SCRIMS_PER_USER) {
    return { ok: false };
  }
  return { ok: true };
}

/**
 * Purge entrée expirée si besoin.
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {string} userId
 * @param {{ failClosedOnError?: boolean }} [options] si true (/recherche-scrim, /scrim-trouve) → service_unavailable en cas d’erreur DB
 * @returns {{ result: 'allowed' | 'blocked' | 'service_unavailable' }}
 */
export function checkGlobalBlacklist(stmts, userId, options = {}) {
  const failClosed = options.failClosedOnError === true;
  try {
    /** @type {{ user_id: string, expires_at: string | null } | undefined} */
    const row = stmts.getGlobalBlacklistEntry.get(userId);
    if (!row) return { result: 'allowed' };
    if (row.expires_at == null || row.expires_at === '') {
      return { result: 'blocked' };
    }
    const exp = new Date(row.expires_at).getTime();
    if (Number.isNaN(exp)) {
      stmts.deleteGlobalBlacklistUser.run(userId);
      return { result: 'allowed' };
    }
    if (exp <= Date.now()) {
      stmts.deleteGlobalBlacklistUser.run(userId);
      return { result: 'allowed' };
    }
    return { result: 'blocked' };
  } catch (err) {
    logModerationSafe(() =>
      logger.error('checkGlobalBlacklist: erreur lecture blacklist', {
        message: err instanceof Error ? err.message : String(err),
        user_id: userId,
        fail_closed: failClosed,
      }),
    );
    if (failClosed) return { result: 'service_unavailable' };
    return { result: 'allowed' };
  }
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {string} guildId
 * @param {string} reporterUserId
 * @param {string} targetUserId
 */
export function createSpamReport(stmts, guildId, reporterUserId, targetUserId) {
  const createdAt = new Date().toISOString();
  stmts.insertSpamReport.run(guildId, reporterUserId, targetUserId, createdAt);
  logModerationSafe(() =>
    logger.info('Spam report created', {
      reporterId: reporterUserId,
      targetId: targetUserId,
      guildId,
    }),
  );
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {string} reporterUserId
 * @param {string} targetUserId
 * @returns {boolean}
 */
export function checkRecentSpamReport(stmts, reporterUserId, targetUserId) {
  const cutoff = new Date(Date.now() - 7 * 864e5).toISOString();
  const row = stmts.checkRecentSpamReport.get(
    reporterUserId,
    targetUserId,
    cutoff,
  );
  return Boolean(row?.id);
}

export function buildSpamReportHeader({
  targetTag,
  targetId,
  reporterTag,
  reporterId,
  guildName,
  guildId,
}) {
  const now = DateTime.now().setZone(SCRIM_TIMEZONE).toFormat(
    "dd/MM/yyyy HH'h'mm",
  );
  return (
    `🚨 Signalement spam scrim\n\n` +
    `Joueur : ${targetTag} (${targetId})\n` +
    `Signalé par : ${reporterTag} (${reporterId})\n` +
    `Serveur : ${guildName} (${guildId})\n` +
    `Date : ${now}`
  );
}

/**
 * @param {{ game_key: string, created_at: number, scheduled_at: string | null, scheduled_date: string, scheduled_time: string }} row
 */
export function formatModerationScrimHistoryLine(row) {
  const created = formatParisFromMs(row.created_at);
  const game = getGame(row.game_key)?.label ?? row.game_key;
  let schedStr;
  if (row.scheduled_at) {
    try {
      schedStr = formatParisFromIso(row.scheduled_at);
    } catch {
      schedStr = `${row.scheduled_date} ${row.scheduled_time}`;
    }
  } else {
    schedStr = `${row.scheduled_date} ${row.scheduled_time}`;
  }
  return `${created} → ${game} → scrim demandé pour ${schedStr}`;
}

/**
 * Découpe selon une marge ~1800, max 3 messages.
 * @param {string} header
 * @param {string[]} historyLines
 * @returns {string[]}
 */
export function buildSpamReportMessages(header, historyLines) {
  const MAX = 1800;
  const MAX_MSGS = 3;
  const TRUNC = '... historique tronqué (plus de 50 recherches)';
  const SUITE = 'Suite historique :\n\n';

  /** @type {string[]} */
  const messages = [];
  let buf = header + '\n\n';

  const flush = () => {
    const t = buf.trimEnd();
    if (t) messages.push(t);
    buf = '';
  };

  for (const line of historyLines) {
    const sep = buf === header + '\n\n' ? '' : '\n';
    const candidate = buf + sep + line;
    if (candidate.length <= MAX) {
      buf = candidate;
      continue;
    }
    if (buf.trim() && buf !== header + '\n\n') {
      flush();
      if (messages.length >= MAX_MSGS) {
        messages[MAX_MSGS - 1] = (
          messages[MAX_MSGS - 1] + '\n\n' + TRUNC
        ).slice(0, MAX);
        return messages;
      }
      buf = (messages.length > 0 ? SUITE : header + '\n\n') + line;
    } else if (buf === header + '\n\n') {
      buf =
        header +
        '\n\n' +
        line.slice(0, Math.max(0, MAX - header.length - 4)) +
        '…';
      continue;
    } else {
      buf = (messages.length > 0 ? SUITE : header + '\n\n') + line;
    }
    if (buf.length > MAX) {
      buf = buf.slice(0, MAX - TRUNC.length - 2).trimEnd() + '\n' + TRUNC;
      flush();
      if (messages.length >= MAX_MSGS) return messages;
    }
  }

  if (buf.trim()) {
    if (messages.length >= MAX_MSGS) {
      messages[MAX_MSGS - 1] = (
        messages[MAX_MSGS - 1] + '\n\n' + buf + '\n\n' + TRUNC
      ).slice(0, MAX);
    } else {
      flush();
    }
  }

  return messages.slice(0, MAX_MSGS);
}

/**
 * @param {string} value
 * @returns {{ expiresAt: Date | null } | { expiresAt: undefined }}
 */
export function parseBlacklistDurationChoice(value) {
  const now = Date.now();
  switch (value) {
    case '1d':
      return { expiresAt: new Date(now + 864e5) };
    case '7d':
      return { expiresAt: new Date(now + 7 * 864e5) };
    case '30d':
      return { expiresAt: new Date(now + 30 * 864e5) };
    case '3mo':
      return { expiresAt: new Date(now + 90 * 864e5) };
    case 'permanent':
      return { expiresAt: null };
    default:
      return { expiresAt: undefined };
  }
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {string} duration clé slash (ex. 1d, permanent)
 */
export function blacklistUserGlobally(
  stmts,
  /** @type {string} */ userId,
  /** @type {string | null} */ expiresAtIso,
  /** @type {string | undefined} */ reason,
  /** @type {string} */ createdBy,
  /** @type {string} */ duration,
) {
  const createdAt = new Date().toISOString();
  stmts.upsertGlobalBlacklist.run({
    user_id: userId,
    expires_at: expiresAtIso,
    reason: reason?.trim() ?? '',
    created_at: createdAt,
    created_by: createdBy,
  });
  logModerationSafe(() =>
    logger.event('User blacklisted', {
      targetId: userId,
      duration,
      by: createdBy,
    }),
  );
}

/**
 * @param {ReturnType<import('../database/db.js')['prepareStatements']>} stmts
 * @param {string} userId
 * @param {string} byUserId
 */
export function unblacklistUserGlobally(stmts, userId, byUserId) {
  stmts.deleteGlobalBlacklistUser.run(userId);
  logModerationSafe(() =>
    logger.event('User unblacklisted', {
      targetId: userId,
      by: byUserId,
    }),
  );
}
