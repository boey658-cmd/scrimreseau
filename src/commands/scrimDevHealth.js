import { MessageFlags } from 'discord.js';
import { getDiscordEditRetryJobHealthSnapshot } from '../services/discordEditRetryJob.js';
import { getDiscordTaskQueueHealthSnapshot } from '../services/discordTaskQueue.js';
import { getScrimExpirationJobHealthSnapshot } from '../services/scrimExpirationJob.js';
import { resolveBotDevId } from '../utils/botDevConfig.js';
import { getProcessHealthSnapshot } from '../utils/processHealth.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

const MSG_DENIED = '❌ Non autorisé.';

/**
 * @param {number} totalSec
 */
function formatDurationSeconds(totalSec) {
  const t = Math.max(0, Math.floor(totalSec));
  const d = Math.floor(t / 86400);
  const h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}j`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}min`);
  if (parts.length === 0) parts.push(`${s}s`);
  else if (s > 0) parts.push(`${s}s`);
  return parts.join(' ');
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeScrimDevHealthCore(interaction, ctx) {
  const devGuildId = process.env.DEV_GUILD_ID?.trim() ?? '';

  if (!interaction.inGuild()) {
    await interactReply(interaction, { content: MSG_DENIED, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!devGuildId || interaction.guildId !== devGuildId) {
    await interactReply(interaction, { content: MSG_DENIED, flags: MessageFlags.Ephemeral });
    return;
  }

  const dev = resolveBotDevId();
  if (!dev.ok || interaction.user.id !== dev.devId) {
    await interactReply(interaction, { content: MSG_DENIED, flags: MessageFlags.Ephemeral });
    return;
  }

  const processUptimeSec = process.uptime();
  const clientUptimeMs = interaction.client.uptime;
  const clientUptimeStr =
    clientUptimeMs == null
      ? '—'
      : formatDurationSeconds(clientUptimeMs / 1000);

  const guildCount = interaction.client.guilds.cache.size;

  let activeScrims = 0;
  try {
    const row = ctx.stmts.countActiveScrimPosts.get();
    activeScrims = Number(row?.n ?? 0);
  } catch (err) {
    logger.error('scrim-dev health — lecture scrims actives', {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  let pendingEditRetries = 0;
  try {
    const row = ctx.stmts.countPendingDiscordEditRetries.get();
    pendingEditRetries = Number(row?.n ?? 0);
  } catch (err) {
    logger.error('scrim-dev health — lecture file retry éditions', {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const exp = getScrimExpirationJobHealthSnapshot();
  const editRetry = getDiscordEditRetryJobHealthSnapshot();
  const dq = getDiscordTaskQueueHealthSnapshot();
  const proc = getProcessHealthSnapshot();
  const heapMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);

  const urLast =
    proc.lastUnhandledRejectionAtIso == null
      ? '—'
      : proc.lastUnhandledRejectionAtIso;
  const urPreview =
    proc.unhandledRejectionTotal === 0
      ? '—'
      : (proc.lastUnhandledRejectionPreview ?? '—');
  const urLine = `total ${proc.unhandledRejectionTotal} — dernier : ${urLast} — aperçu : ${urPreview}`;

  const ueLast =
    proc.uncaughtExceptionLastAt == null ? '—' : proc.uncaughtExceptionLastAt;
  const uePreview =
    proc.uncaughtExceptionTotal === 0
      ? '—'
      : (proc.uncaughtExceptionLastPreview ?? '—');
  const ueLine = `total ${proc.uncaughtExceptionTotal} — dernier : ${ueLast} — aperçu : ${uePreview}`;

  const expParts = [];
  if (!exp.started) expParts.push('inactif');
  else expParts.push('actif');
  if (exp.shuttingDown) expParts.push('arrêt demandé');
  if (exp.passInProgress) expParts.push('passe en cours');
  const expLine = `${expParts.join(' — ')} — intervalle ${exp.intervalMinutes} min`;

  const erParts = [];
  if (!editRetry.started) erParts.push('inactif');
  else erParts.push('actif');
  if (editRetry.shuttingDown) erParts.push('arrêt demandé');
  if (editRetry.passInProgress) erParts.push('passe en cours');
  const editRetryLine = `${erParts.join(' — ')} — intervalle ${editRetry.intervalMinutes} min`;

  const dqLine = `état ${dq.state} — file ${dq.queueLength} — tâche en cours : ${dq.currentTaskRunning ? 'oui' : 'non'} — délai ${dq.delayMsConfigured} ms`;

  const lines = [
    '**Santé du bot** (lecture seule)',
    `• Uptime process : ${formatDurationSeconds(processUptimeSec)}`,
    `• Uptime client Discord : ${clientUptimeStr}`,
    `• Guildes : ${guildCount}`,
    `• Scrims actives : ${activeScrims}`,
    `• File retry éditions embeds scrim (en attente) : ${pendingEditRetries}`,
    `• Job retry éditions : ${editRetryLine}`,
    `• File tâches Discord (scrim edits / diffusion) : ${dqLine}`,
    `• Job expiration : ${expLine}`,
    `• unhandledRejection (process) : ${urLine}`,
    `• uncaughtException (process) : ${ueLine}`,
    `• Node ${process.version} — heap ~${heapMb} Mo`,
  ];

  await interactReply(interaction, {
    content: lines.join('\n'),
    flags: MessageFlags.Ephemeral,
  });

  try {
    logger.health('scrim-dev health', {
      user_id: interaction.user.id,
      guild_id: interaction.guildId,
    });
  } catch {
    /* ignore */
  }
}
