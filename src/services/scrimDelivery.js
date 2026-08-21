import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { assertBotCanPostInChannel } from './channelPermissions.js';
import {
  buildScrimCommunityServerActionRows,
  buildScrimEmbed,
} from './scrimEmbedBuilder.js';
import { getGuildLocale } from '../i18n/index.js';
import { classifyDiscordEditError } from './discordRetryPolicy.js';
import { enqueueDiscordTask } from './discordTaskQueue.js';
import { runTransientDiscord } from './discordApiGuard.js';
import { removeScrimReceptionDestination } from './scrimDestinationCleanup.js';

/**
 * @typedef {{
 *   outcome: 'sent' | 'blocked' | 'terminal_error' | 'retryable_error' | 'cancelled' | 'unknown_outcome',
 *   message?: import('discord.js').Message,
 *   errorCode?: string,
 *   errorMessage?: string,
 *   terminal?: boolean,
 * }} DeliveryResult
 */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Codes Discord terminaux fréquents → libellés stables pour logs / DB.
 * @param {string | number | null | undefined} code
 * @returns {string}
 */
export function mapDiscordTerminalErrorCode(code) {
  const n = typeof code === 'number' ? code : Number(code);
  if (n === RESTJSONErrorCodes.UnknownChannel) return 'UNKNOWN_CHANNEL';
  if (n === RESTJSONErrorCodes.UnknownGuild) return 'GUILD_NOT_FOUND';
  if (n === RESTJSONErrorCodes.MissingPermissions) return 'MISSING_PERMISSIONS';
  if (n === RESTJSONErrorCodes.MissingAccess) return 'MISSING_ACCESS';
  if (code == null || code === '') return 'TERMINAL';
  return String(code);
}

/**
 * Délivre un embed scrim à une destination (guilde + salon) unique.
 * Ne prend pas de décision de retry ou de rollback.
 * La locale est résolue depuis la DB, jamais injectée.
 *
 * @param {{
 *   client: import('discord.js').Client,
 *   stmts: ReturnType<import('../database/db.js')['prepareStatements']>,
 *   row: { guild_id: string, channel_id: string },
 *   authorUserId: string,
 *   payload: object,
 *   delayMs?: number,
 *   sendMode?: 'queued' | 'direct',
 *   discordMaxAttempts?: number,
 * }} args
 * @returns {Promise<DeliveryResult>}
 */
export async function deliverScrimToDestination({
  client,
  stmts,
  row,
  authorUserId,
  payload,
  delayMs = 0,
  sendMode = 'queued',
  discordMaxAttempts,
}) {
  if (delayMs > 0) await sleep(delayMs);

  const transientOpts = discordMaxAttempts != null
    ? { maxAttempts: discordMaxAttempts }
    : {};

  try {
    // 1. Blocage local de l'auteur
    const blocked = stmts.isUserBlocked.get(row.guild_id, authorUserId);
    if (blocked) {
      return { outcome: 'blocked' };
    }

    // 2. Guilde — ne pas avaler les erreurs réseau en GUILD_NOT_FOUND
    let guild = client.guilds.cache.get(row.guild_id) ?? null;
    if (!guild) {
      try {
        guild = await runTransientDiscord(
          () => client.guilds.fetch(row.guild_id),
          { kind: 'delivery.fetch_guild', metadata: { guild_id: row.guild_id }, ...transientOpts },
        );
      } catch (fetchErr) {
        const c = classifyDiscordEditError(fetchErr);
        const errMsg = (fetchErr instanceof Error ? fetchErr.message : String(fetchErr)).slice(0, 200);
        if (c.kind === 'terminal') {
          const errorCode = mapDiscordTerminalErrorCode(c.code);
          return {
            outcome: 'terminal_error',
            errorCode: errorCode === 'TERMINAL' ? 'GUILD_NOT_FOUND' : errorCode,
            errorMessage: errMsg || 'Guilde introuvable',
            terminal: true,
          };
        }
        return {
          outcome: 'retryable_error',
          errorCode: c.code,
          errorMessage: errMsg,
          terminal: false,
        };
      }
    }
    if (!guild) {
      return { outcome: 'terminal_error', errorCode: 'GUILD_NOT_FOUND', errorMessage: 'Guilde introuvable', terminal: true };
    }

    // 3. Salon — ne pas avaler 10003 en « PERMISSIONS / Salon introuvable »
    let channel = guild.channels.cache.get(row.channel_id) ?? null;
    if (!channel) {
      try {
        channel = await runTransientDiscord(
          () => guild.channels.fetch(row.channel_id),
          { kind: 'delivery.fetch_channel', metadata: { guild_id: row.guild_id, channel_id: row.channel_id }, ...transientOpts },
        );
      } catch (fetchErr) {
        const c = classifyDiscordEditError(fetchErr);
        const errMsg = (fetchErr instanceof Error ? fetchErr.message : String(fetchErr)).slice(0, 200);
        if (c.kind === 'terminal') {
          const errorCode = mapDiscordTerminalErrorCode(c.code);
          if (errorCode === 'UNKNOWN_CHANNEL') {
            removeScrimReceptionDestination(stmts, row.guild_id, row.channel_id, 'UNKNOWN_CHANNEL');
          }
          return {
            outcome: 'terminal_error',
            errorCode,
            errorMessage: errMsg || 'Salon introuvable.',
            terminal: true,
          };
        }
        return {
          outcome: 'retryable_error',
          errorCode: c.code,
          errorMessage: errMsg,
          terminal: false,
        };
      }
    }

    if (!channel) {
      removeScrimReceptionDestination(stmts, row.guild_id, row.channel_id, 'UNKNOWN_CHANNEL');
      return {
        outcome: 'terminal_error',
        errorCode: 'UNKNOWN_CHANNEL',
        errorMessage: 'Salon introuvable.',
        terminal: true,
      };
    }

    // 4. Bot member — ne pas avaler les erreurs réseau en faux PERMISSIONS
    let botMember = guild.members.me;
    if (!botMember) {
      try {
        botMember = await runTransientDiscord(
          () => guild.members.fetchMe(),
          { kind: 'delivery.fetch_me', metadata: { guild_id: row.guild_id }, ...transientOpts },
        );
      } catch (fetchErr) {
        const c = classifyDiscordEditError(fetchErr);
        const errMsg = (fetchErr instanceof Error ? fetchErr.message : String(fetchErr)).slice(0, 200);
        if (c.kind === 'terminal') {
          return {
            outcome: 'terminal_error',
            errorCode: mapDiscordTerminalErrorCode(c.code),
            errorMessage: errMsg || 'Impossible de résoudre le membre bot',
            terminal: true,
          };
        }
        return {
          outcome: 'retryable_error',
          errorCode: c.code,
          errorMessage: errMsg,
          terminal: false,
        };
      }
    }

    // 5. Permissions
    const perm = assertBotCanPostInChannel(channel, botMember);
    if (!perm.ok) {
      return {
        outcome: 'terminal_error',
        errorCode: 'PERMISSIONS',
        errorMessage: perm.error?.slice(0, 200) ?? 'Permissions insuffisantes',
        terminal: true,
      };
    }

    // 6. Locale depuis DB (jamais injectée)
    const guildLocale = stmts.getGuildLanguage
      ? getGuildLocale(row.guild_id, stmts)
      : 'fr';

    // 7. Embed
    const embed = buildScrimEmbed(payload, guildLocale);
    const communityRows = buildScrimCommunityServerActionRows(
      /** @type {any} */ (payload).multiOpggUrl ?? null,
      guildLocale,
    );
    const sendPayload = communityRows.length > 0
      ? { embeds: [embed], components: communityRows }
      : { embeds: [embed] };

    // 8. Envoi
    // Persistant direct : at-most-once applicatif (1 seul channel.send).
    // Ambigu (timeout/5xx/réseau) → unknown_outcome, pas de retry auto.
    if (sendMode === 'direct') {
      try {
        const sent = /** @type {import('discord.js').Message} */ (await channel.send(sendPayload));
        return { outcome: 'sent', message: sent };
      } catch (sendErr) {
        const c = classifyDiscordEditError(sendErr);
        const errMsg = (sendErr instanceof Error ? sendErr.message : String(sendErr)).slice(0, 200);
        if (c.kind === 'terminal') {
          const errorCode = mapDiscordTerminalErrorCode(c.code);
          if (errorCode === 'UNKNOWN_CHANNEL') {
            try {
              removeScrimReceptionDestination(stmts, row.guild_id, row.channel_id, 'UNKNOWN_CHANNEL');
            } catch { /* best effort */ }
          }
          return { outcome: 'terminal_error', errorCode, errorMessage: errMsg, terminal: true };
        }
        // 429 / RATE_LIMIT : requête typiquement non acceptée → retry SQLite OK
        if (c.code === 'RATE_LIMIT' || String(c.code).includes('429')) {
          return {
            outcome: 'retryable_error',
            errorCode: c.code,
            errorMessage: errMsg,
            terminal: false,
          };
        }
        // Ambigu après tentative send — pas de resend applicatif
        return {
          outcome: 'unknown_outcome',
          errorCode: c.code ?? 'SEND_AMBIGUOUS',
          errorMessage: errMsg,
          terminal: false,
        };
      }
    }

    const sent = /** @type {import('discord.js').Message} */ (await enqueueDiscordTask(
      async () => channel.send(sendPayload),
      { kind: 'scrim_delivery_send', guild_id: row.guild_id, channel_id: row.channel_id },
      'high',
    ));

    return { outcome: 'sent', message: sent };

  } catch (err) {
    const c = classifyDiscordEditError(err);
    const errMsg = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    if (c.kind === 'terminal') {
      const errorCode = mapDiscordTerminalErrorCode(c.code);
      if (errorCode === 'UNKNOWN_CHANNEL') {
        try {
          removeScrimReceptionDestination(stmts, row.guild_id, row.channel_id, 'UNKNOWN_CHANNEL');
        } catch {
          /* best effort */
        }
      }
      return { outcome: 'terminal_error', errorCode, errorMessage: errMsg, terminal: true };
    }
    return { outcome: 'retryable_error', errorCode: c.code, errorMessage: errMsg, terminal: false };
  }
}
