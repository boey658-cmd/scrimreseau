import { EmbedBuilder } from 'discord.js';
import { UI_PRIMARY_GAME_KEY } from '../config/games.js';
import { logger } from '../utils/logger.js';
import { runTransientDiscord } from './discordApiGuard.js';

let jobStarted = false;
let jobShuttingDown = false;

/** @type {ReturnType<typeof setInterval> | null} */
let intervalHandle = null;

const MS_24H = 24 * 60 * 60 * 1000;

/**
 * Métriques désynchronisation DB / Discord (éditions embeds fermeture scrim).
 * Chaque requête est isolée : en cas d’échec → log + valeur affichée « — ».
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} cutoff24hIso instant ISO (maintenant − 24 h)
 * @returns {{
 *   activeRetries: number | null,
 *   abandoned24h: number | null,
 *   topAbandonedErrorCode: string | null,
 * }}
 */
function computeDiscordEditSyncMetrics(db, cutoff24hIso) {
  /** @type {number | null} */
  let activeRetries = null;
  /** @type {number | null} */
  let abandoned24h = null;
  /** @type {string | null} */
  let topAbandonedErrorCode = null;

  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM discord_message_edit_retries
         WHERE resolved_at IS NULL AND abandoned_at IS NULL`,
      )
      .get();
    activeRetries = Number(row?.n ?? 0);
  } catch (err) {
    try {
      logger.error('Job rapport dev — métrique éditions en retry (active)', {
        message: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* ignore */
    }
  }

  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM discord_message_edit_retries
         WHERE abandoned_at IS NOT NULL AND abandoned_at >= ?`,
      )
      .get(cutoff24hIso);
    abandoned24h = Number(row?.n ?? 0);
  } catch (err) {
    try {
      logger.error('Job rapport dev — métrique abandons 24h', {
        message: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* ignore */
    }
  }

  try {
    const row = db
      .prepare(
        `SELECT last_error_code AS code FROM discord_message_edit_retries
         WHERE abandoned_at IS NOT NULL AND abandoned_at >= ?
           AND last_error_code IS NOT NULL AND trim(last_error_code) != ''
         GROUP BY last_error_code
         ORDER BY COUNT(*) DESC
         LIMIT 1`,
      )
      .get(cutoff24hIso);
    if (row && typeof row.code === 'string' && row.code.trim() !== '') {
      topAbandonedErrorCode = row.code.trim();
    }
  } catch (err) {
    try {
      logger.error('Job rapport dev — métrique erreur principale (abandons 24h)', {
        message: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* ignore */
    }
  }

  return { activeRetries, abandoned24h, topAbandonedErrorCode };
}

/**
 * @param {{
 *   activeRetries: number | null,
 *   abandoned24h: number | null,
 *   topAbandonedErrorCode: string | null,
 * }} sync
 */
function formatDiscordSyncFieldValue(sync) {
  const line = (label, v) => {
    const disp =
      v === null ? '—' : typeof v === 'number' ? String(v) : v;
    return `• ${label} : ${disp}`;
  };
  const err =
    sync.topAbandonedErrorCode == null || sync.topAbandonedErrorCode === ''
      ? '—'
      : sync.topAbandonedErrorCode;
  return [
    line('Éditions en retry', sync.activeRetries),
    line('Éditions abandonnées (24h)', sync.abandoned24h),
    `• Erreur principale (abandons 24h) : ${err}`,
  ].join('\n');
}

/**
 * Agrégats sur la fenêtre glissante 24 h (read-only).
 *
 * @param {import('better-sqlite3').Database} db
 */
export function computeDailyDevReportMetrics(db) {
  const now = Date.now();
  const createdCutoffMs = now - MS_24H;
  const closedCutoffIso = new Date(createdCutoffMs).toISOString();

  const rowCreated = db
    .prepare(
      `SELECT COUNT(*) AS n FROM scrim_posts WHERE created_at >= ?`,
    )
    .get(createdCutoffMs);
  const rowManual = db
    .prepare(
      `SELECT COUNT(*) AS n FROM scrim_posts
       WHERE status = 'closed_manual'
         AND closed_at IS NOT NULL AND trim(closed_at) != ''
         AND closed_at >= ?`,
    )
    .get(closedCutoffIso);
  const rowExpired = db
    .prepare(
      `SELECT COUNT(*) AS n FROM scrim_posts
       WHERE status = 'closed_expired'
         AND closed_at IS NOT NULL AND trim(closed_at) != ''
         AND closed_at >= ?`,
    )
    .get(closedCutoffIso);
  const rowGuilds = db
    .prepare(
      `SELECT COUNT(DISTINCT guild_id) AS n
       FROM guild_game_channels
       WHERE game_key = ?`,
    )
    .get(UI_PRIMARY_GAME_KEY);

  return {
    scrimsCreated: Number(rowCreated?.n ?? 0),
    scrimsFound: Number(rowManual?.n ?? 0),
    scrimsExpired: Number(rowExpired?.n ?? 0),
    guildsConfigured: Number(rowGuilds?.n ?? 0),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} reportIso
 */
function buildDailyDevReportEmbed(db, reportIso) {
  const m = computeDailyDevReportMetrics(db);
  const cutoff24hIso = new Date(new Date(reportIso).getTime() - MS_24H).toISOString();
  const sync = computeDiscordEditSyncMetrics(db, cutoff24hIso);
  const reportParis = new Date(reportIso).toLocaleString('fr-FR', {
    timeZone: 'Europe/Paris',
    dateStyle: 'short',
    timeStyle: 'short',
  });

  return new EmbedBuilder()
    .setTitle('ScrimRéseau — Résumé 24h')
    .setColor(0x5865f2)
    .addFields(
      { name: 'Scrims créées', value: String(m.scrimsCreated), inline: true },
      { name: 'Scrims trouvées', value: String(m.scrimsFound), inline: true },
      { name: 'Scrims expirées', value: String(m.scrimsExpired), inline: true },
      {
        name: 'Serveurs configurés',
        value: String(m.guildsConfigured),
        inline: true,
      },
      {
        name: 'État des synchronisations Discord',
        value: formatDiscordSyncFieldValue(sync),
        inline: false,
      },
      {
        name: 'Nouveaux serveurs configurés',
        value:
          'Non disponible — pas de date de première config fiable (`created_at` écrasé à chaque changement de salon).',
        inline: false,
      },
    )
    .setFooter({
      text: `Fenêtre : dernières 24 h · Rapport : ${reportParis} (Paris)`,
    })
    .setTimestamp(new Date(reportIso));
}

/**
 * @param {import('discord.js').Client} client
 * @param {import('better-sqlite3').Database} db
 */
async function runDailyDevReportOnce(client, db) {
  if (jobShuttingDown) return;

  const rawId = process.env.DEV_DAILY_REPORT_CHANNEL_ID?.trim();
  if (!rawId) return;

  const reportIso = new Date().toISOString();
  const embed = buildDailyDevReportEmbed(db, reportIso);

  try {
    const ch = await runTransientDiscord(
      () => client.channels.fetch(rawId),
      { kind: 'daily_dev_report_fetch_channel', metadata: { channel_id: rawId } },
    ).catch(() => null);

    if (!ch?.isTextBased()) {
      logger.warn('Job rapport dev quotidien — salon introuvable ou non textuel', {
        channel_id: rawId,
      });
      return;
    }

    await runTransientDiscord(
      () => ch.send({ embeds: [embed] }),
      { kind: 'daily_dev_report_send', metadata: { channel_id: rawId } },
    );
  } catch (err) {
    logger.error('Job rapport dev quotidien — échec envoi', {
      message: err instanceof Error ? err.message : String(err),
      channel_id: rawId,
    });
  }
}

/**
 * @param {import('discord.js').Client} client
 * @param {import('better-sqlite3').Database} db
 */
export function startDailyDevReportJob(client, db) {
  if (jobStarted) {
    logger.warn('startDailyDevReportJob: déjà démarré, ignoré');
    return;
  }

  const rawId = process.env.DEV_DAILY_REPORT_CHANNEL_ID?.trim();
  if (!rawId) {
    try {
      logger.info(
        'Job rapport dev quotidien — désactivé (DEV_DAILY_REPORT_CHANNEL_ID vide)',
      );
    } catch {
      /* ignore */
    }
    return;
  }

  jobStarted = true;
  jobShuttingDown = false;

  logger.info('Job rapport dev quotidien — démarrage', {
    interval_hours: 24,
    channel_id: rawId,
    first_send: 'immédiat puis toutes les 24 h',
  });

  const tick = () => {
    if (jobShuttingDown) return;
    void runDailyDevReportOnce(client, db);
  };

  /** Premier rapport dès le ready (une fois), puis récurrence uniquement via l’intervalle 24 h. */
  tick();

  intervalHandle = setInterval(tick, MS_24H);
  intervalHandle.unref();
}

export function stopDailyDevReportJob() {
  jobShuttingDown = true;
  if (intervalHandle != null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  jobStarted = false;
  try {
    logger.info('Job rapport dev quotidien — arrêté');
  } catch {
    /* ignore */
  }
}
