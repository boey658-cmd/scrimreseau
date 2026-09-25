/**
 * Authz live Discord pour HTTP interne config (GET / PATCH).
 *
 * Trust boundary BFF :
 * - Bearer = machine-to-machine
 * - actor_discord_user_id = identité Discord authentifiée par le BFF
 * - Jamais de confiance au frontend pour roles / plan / guild_id seul
 *
 * Phase 0.5 :
 * - GET (lecture) : owner ∪ Administrator ∪ ManageGuild
 * - PATCH / writes dashboard : Administrator uniquement (owner Discord inclus via bits)
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
 * @param {{
 *   client: import('discord.js').Client,
 *   guildId: string,
 *   actorDiscordUserId: string,
 * }} p
 * @returns {Promise<{ guild: import('discord.js').Guild, member: import('discord.js').GuildMember }>}
 */
async function fetchGuildAndMember(p) {
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

  return { guild, member };
}

/**
 * Lecture config / overview (GET) — ManageGuild ∪ Administrator ∪ owner.
 *
 * @param {{
 *   client: import('discord.js').Client,
 *   guildId: string,
 *   actorDiscordUserId: string,
 * }} p
 * @returns {Promise<import('discord.js').Guild>}
 */
export async function assertActorCanReadGuildConfig(p) {
  const { guild, member } = await fetchGuildAndMember(p);
  const isOwner = guild.ownerId === p.actorDiscordUserId;
  const perms = member.permissions;
  const canRead = Boolean(
    isOwner
    || perms?.has(PermissionFlagsBits.Administrator)
    || perms?.has(PermissionFlagsBits.ManageGuild),
  );
  if (!canRead) {
    throw new ConfigWriteError(403, 'GUILD_NOT_MANAGEABLE');
  }
  return guild;
}

/**
 * Écriture config dashboard (PATCH) — Administrator uniquement.
 * (Le propriétaire Discord dispose typiquement de tous les bits via Discord.js.)
 *
 * @param {{
 *   client: import('discord.js').Client,
 *   guildId: string,
 *   actorDiscordUserId: string,
 * }} p
 * @returns {Promise<import('discord.js').Guild>}
 */
export async function assertActorCanWriteGuildConfig(p) {
  const { guild, member } = await fetchGuildAndMember(p);
  const isOwner = guild.ownerId === p.actorDiscordUserId;
  const perms = member.permissions;
  const canWrite = Boolean(
    isOwner || perms?.has(PermissionFlagsBits.Administrator),
  );
  if (!canWrite) {
    throw new ConfigWriteError(403, 'GUILD_NOT_MANAGEABLE');
  }
  return guild;
}

/**
 * @deprecated Prefer assertActorCanWriteGuildConfig (PATCH) or assertActorCanReadGuildConfig (GET).
 * Alias write (Phase 0.5) pour compat imports existants.
 */
export async function assertActorCanManageGuildConfig(p) {
  return assertActorCanWriteGuildConfig(p);
}
