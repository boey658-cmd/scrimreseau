/**
 * Authz write live Discord pour PATCH config interne (Web5B).
 * Ne fait jamais confiance à un flag admin client.
 */

import { PermissionFlagsBits } from 'discord.js';
import { ConfigWriteError } from './configWriteError.js';

const DISCORD_FETCH_TIMEOUT_MS = 8_000;

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
export async function withDiscordTimeout(promise, ms = DISCORD_FETCH_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error('Discord fetch timeout');
          /** @type {any} */ (err).code = 'TIMEOUT';
          reject(err);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isUnknownGuildError(err) {
  const code = typeof err === 'object' && err !== null && 'code' in err
    ? /** @type {{ code?: unknown }} */ (err).code
    : undefined;
  return code === 10004;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isUnknownMemberError(err) {
  const code = typeof err === 'object' && err !== null && 'code' in err
    ? /** @type {{ code?: unknown }} */ (err).code
    : undefined;
  return code === 10007;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isTimeoutOrNetworkError(err) {
  if (!err || typeof err !== 'object') return false;
  const code = /** @type {{ code?: unknown }} */ (err).code;
  if (code === 'TIMEOUT' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') {
    return true;
  }
  const status = /** @type {{ status?: unknown }} */ (err).status;
  return status === 503 || status === 504;
}

/**
 * Vérifie que l'acteur peut gérer la config du guild (live Discord).
 *
 * @param {{
 *   client: import('discord.js').Client,
 *   guildId: string,
 *   actorDiscordUserId: string,
 * }} p
 * @returns {Promise<import('discord.js').Guild>}
 */
export async function assertActorCanManageGuildConfig(p) {
  const { client, guildId, actorDiscordUserId } = p;

  if (!client?.guilds) {
    throw new ConfigWriteError(503, 'BOT_UNAVAILABLE');
  }

  /** @type {import('discord.js').Guild | null} */
  let guild = client.guilds.cache.get(guildId) ?? null;
  if (!guild) {
    try {
      guild = await withDiscordTimeout(client.guilds.fetch(guildId));
    } catch (err) {
      if (isUnknownGuildError(err)) {
        throw new ConfigWriteError(409, 'BOT_NOT_INSTALLED');
      }
      if (isTimeoutOrNetworkError(err)) {
        throw new ConfigWriteError(503, 'BOT_UNAVAILABLE');
      }
      throw new ConfigWriteError(503, 'BOT_UNAVAILABLE');
    }
  }

  if (!guild) {
    throw new ConfigWriteError(409, 'BOT_NOT_INSTALLED');
  }

  /** @type {import('discord.js').GuildMember | null} */
  let member = null;
  try {
    member = await withDiscordTimeout(guild.members.fetch(actorDiscordUserId));
  } catch (err) {
    if (isUnknownMemberError(err)) {
      throw new ConfigWriteError(403, 'GUILD_NOT_MANAGEABLE');
    }
    if (isTimeoutOrNetworkError(err)) {
      throw new ConfigWriteError(503, 'BOT_UNAVAILABLE');
    }
    throw new ConfigWriteError(503, 'BOT_UNAVAILABLE');
  }

  if (!member) {
    throw new ConfigWriteError(403, 'GUILD_NOT_MANAGEABLE');
  }

  const isOwner = guild.ownerId === actorDiscordUserId;
  const perms = member.permissions;
  const canManage = Boolean(
    isOwner
    || perms?.has(PermissionFlagsBits.Administrator)
    || perms?.has(PermissionFlagsBits.ManageGuild),
  );

  if (!canManage) {
    throw new ConfigWriteError(403, 'GUILD_NOT_MANAGEABLE');
  }

  return guild;
}
