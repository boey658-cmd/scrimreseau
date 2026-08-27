/**
 * Writes config guild — logique métier unique (slash + PATCH HTTP Web5B).
 * Network await AVANT transaction SQLite ; jamais d'await dans une trx.
 */

import { ChannelType } from 'discord.js';
import { UI_PRIMARY_GAME_KEY } from '../config/games.js';
import { ENABLED_GUILD_LOCALES, normalizeEnabledGuildLocale } from '../i18n/index.js';
import {
  SCRIM_ALLOWED_ROLES_MAX,
  transactionReplaceScrimAllowedRoles,
  transactionSetEveryoneMode,
} from '../commands/configScrimPermissions.js';
import { assertBotCanPostInChannel } from './channelPermissions.js';
import { ConfigWriteError } from './configWriteError.js';
import { withDiscordTimeout } from './guildConfigWriteAuthz.js';
import { scheduleNetworkDashboardUpdate } from './networkDashboard.js';
import {
  LIFECYCLE_POLICY_DELETE,
  LIFECYCLE_POLICY_KEEP,
} from './scrimMessagePolicy.js';
import { mayConfigureScrimReceptionChannel } from '../utils/guildScrimReceptionGate.js';
import { validateDiscordInviteUrl } from '../utils/validation.js';
import { fetchGuildConfig } from '../internalHttp/configQueries.js';
import { isSqliteBusyError } from '../internalHttp/overviewQueries.js';

export { SCRIM_ALLOWED_ROLES_MAX };

/**
 * @typedef {{
 *   client: import('discord.js').Client,
 *   guild: import('discord.js').Guild,
 *   db: import('better-sqlite3').Database,
 *   stmts: ReturnType<import('../database/db.js')['prepareStatements']>,
 *   guildId: string,
 *   actorDiscordUserId: string,
 * }} GuildConfigWriteCtx
 */

/**
 * @param {GuildConfigWriteCtx} ctx
 * @param {{ section: string } & Record<string, unknown>} patch
 * @returns {Promise<{ noop: boolean, config: ReturnType<typeof fetchGuildConfig> }>}
 */
export async function applyGuildConfigSectionWrite(ctx, patch) {
  const section = patch.section;
  switch (section) {
    case 'language':
      return writeLanguage(ctx, patch);
    case 'reception_channel':
      return writeReceptionChannel(ctx, patch);
    case 'command_channel':
      return writeCommandChannel(ctx, patch);
    case 'inactive_message_policy':
      return writeInactiveMessagePolicy(ctx, patch);
    case 'structure_link':
      return writeStructureLink(ctx, patch);
    case 'command_permissions':
      return writeCommandPermissions(ctx, patch);
    default:
      throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'section inconnue');
  }
}

/**
 * @param {GuildConfigWriteCtx} ctx
 * @param {Record<string, unknown>} patch
 */
function writeLanguage(ctx, patch) {
  const raw = patch.language;
  if (typeof raw !== 'string' || !ENABLED_GUILD_LOCALES.includes(/** @type {any} */ (raw))) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'language invalide');
  }
  const language = normalizeEnabledGuildLocale(raw);
  if (!ENABLED_GUILD_LOCALES.includes(language)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'language invalide');
  }

  const current = fetchGuildConfig(ctx.db, ctx.guildId);
  if (current.language === language) {
    return { noop: true, config: current };
  }

  ctx.stmts.upsertGuildLanguage.run(ctx.guildId, language);
  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId) };
}

/**
 * @param {GuildConfigWriteCtx} ctx
 * @param {Record<string, unknown>} patch
 */
async function writeReceptionChannel(ctx, patch) {
  if (!('channel_id' in patch)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'channel_id requis');
  }
  const channelIdRaw = patch.channel_id;
  if (channelIdRaw !== null && typeof channelIdRaw !== 'string') {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'channel_id invalide');
  }

  const gameKey = UI_PRIMARY_GAME_KEY;
  const current = fetchGuildConfig(ctx.db, ctx.guildId);
  const currentLol = current.reception_channels.find((c) => c.game_key === gameKey)?.channel_id
    ?? null;

  if (channelIdRaw === null) {
    if (currentLol === null) {
      return { noop: true, config: current };
    }
    ctx.stmts.deleteGuildChannel.run(ctx.guildId, gameKey);
    scheduleNetworkDashboardUpdate(ctx.client, ctx.stmts);
    return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId) };
  }

  const channelId = channelIdRaw.trim();
  if (!/^\d{17,20}$/.test(channelId)) {
    throw new ConfigWriteError(400, 'INVALID_CHANNEL');
  }

  if (currentLol === channelId) {
    return { noop: true, config: current };
  }

  const bypassRow = ctx.stmts.getGuildScrimReceptionBypass.get(ctx.guildId);
  if (!mayConfigureScrimReceptionChannel(ctx.guild.memberCount, bypassRow)) {
    throw new ConfigWriteError(403, 'RECEPTION_NOT_ALLOWED');
  }

  const channel = await fetchGuildChannelLive(ctx.guild, channelId);
  assertChannelInGuild(channel, ctx.guildId);

  let botMember = ctx.guild.members.me ?? null;
  if (!botMember) {
    try {
      botMember = await withDiscordTimeout(ctx.guild.members.fetchMe());
    } catch {
      throw new ConfigWriteError(503, 'BOT_UNAVAILABLE');
    }
  }

  const check = assertBotCanPostInChannel(channel, botMember);
  if (!check.ok) {
    // Convention Web5B/Web5F : manque View/Send/Embed ou type hors texte/annonce
    // → 400 INVALID_CHANNEL (pas de code métier distinct).
    throw new ConfigWriteError(400, 'INVALID_CHANNEL', check.error ?? 'INVALID_CHANNEL');
  }

  ctx.stmts.upsertGuildChannel.run({
    guild_id: ctx.guildId,
    channel_id: channelId,
    game_key: gameKey,
    created_at: Date.now(),
  });
  scheduleNetworkDashboardUpdate(ctx.client, ctx.stmts);
  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId) };
}

/**
 * @param {GuildConfigWriteCtx} ctx
 * @param {Record<string, unknown>} patch
 */
async function writeCommandChannel(ctx, patch) {
  if (!('channel_id' in patch)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'channel_id requis');
  }
  const channelIdRaw = patch.channel_id;
  if (channelIdRaw !== null && typeof channelIdRaw !== 'string') {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'channel_id invalide');
  }

  const current = fetchGuildConfig(ctx.db, ctx.guildId);

  if (channelIdRaw === null) {
    if (current.command_channel_id === null) {
      return { noop: true, config: current };
    }
    ctx.stmts.deleteScrimUsageChannel.run(ctx.guildId);
    return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId) };
  }

  const channelId = channelIdRaw.trim();
  if (!/^\d{17,20}$/.test(channelId)) {
    throw new ConfigWriteError(400, 'INVALID_CHANNEL');
  }

  if (current.command_channel_id === channelId) {
    return { noop: true, config: current };
  }

  const channel = await fetchGuildChannelLive(ctx.guild, channelId);
  assertChannelInGuild(channel, ctx.guildId);
  if (
    channel.type !== ChannelType.GuildText
    && channel.type !== ChannelType.GuildAnnouncement
  ) {
    throw new ConfigWriteError(400, 'INVALID_CHANNEL', 'type salon invalide');
  }

  ctx.stmts.upsertScrimUsageChannel.run({
    guild_id: ctx.guildId,
    channel_id: channelId,
  });
  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId) };
}

/**
 * @param {GuildConfigWriteCtx} ctx
 * @param {Record<string, unknown>} patch
 */
function writeInactiveMessagePolicy(ctx, patch) {
  const policy = patch.policy;
  if (policy !== LIFECYCLE_POLICY_KEEP && policy !== LIFECYCLE_POLICY_DELETE) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'policy invalide');
  }

  const current = fetchGuildConfig(ctx.db, ctx.guildId);
  if (current.inactive_message_policy === policy) {
    return { noop: true, config: current };
  }

  ctx.stmts.upsertScrimMessageLifecyclePolicy.run({
    guild_id: ctx.guildId,
    policy,
    updated_at: new Date().toISOString(),
  });
  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId) };
}

/**
 * @param {GuildConfigWriteCtx} ctx
 * @param {Record<string, unknown>} patch
 */
function writeStructureLink(ctx, patch) {
  if (!('url' in patch)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'url requis');
  }
  const urlRaw = patch.url;
  if (urlRaw !== null && typeof urlRaw !== 'string') {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'url invalide');
  }

  const current = fetchGuildConfig(ctx.db, ctx.guildId);

  if (urlRaw === null) {
    if (current.structure_invite_url === null) {
      return { noop: true, config: current };
    }
    ctx.stmts.deleteStructureDiscordLink.run(ctx.guildId);
    return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId) };
  }

  const validated = validateDiscordInviteUrl(urlRaw);
  if (!validated.ok) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'url invite invalide');
  }

  if (current.structure_invite_url === validated.value) {
    return { noop: true, config: current };
  }

  ctx.stmts.upsertStructureDiscordLink.run({
    guild_id: ctx.guildId,
    discord_invite_url: validated.value,
    updated_at: new Date().toISOString(),
    updated_by: ctx.actorDiscordUserId,
  });
  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId) };
}

/**
 * @param {GuildConfigWriteCtx} ctx
 * @param {Record<string, unknown>} patch
 */
async function writeCommandPermissions(ctx, patch) {
  const mode = patch.mode;
  if (mode !== 'everyone' && mode !== 'roles') {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'mode invalide');
  }

  const current = fetchGuildConfig(ctx.db, ctx.guildId);
  const writeCtx = { db: ctx.db, stmts: ctx.stmts };

  if (mode === 'everyone') {
    if (
      current.command_permissions.mode === 'everyone'
      && current.command_permissions.role_ids.length === 0
    ) {
      return { noop: true, config: current };
    }
    transactionSetEveryoneMode(writeCtx, ctx.guildId);
    return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId) };
  }

  if (!Array.isArray(patch.role_ids)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'role_ids requis');
  }

  /** @type {string[]} */
  const roleIds = [];
  const seen = new Set();
  for (const raw of patch.role_ids) {
    if (typeof raw !== 'string' || !/^\d{17,20}$/.test(raw.trim())) {
      throw new ConfigWriteError(400, 'INVALID_ROLE');
    }
    const id = raw.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    roleIds.push(id);
  }

  if (roleIds.length === 0) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'roles mode nécessite 1–5 rôles');
  }
  if (roleIds.length > SCRIM_ALLOWED_ROLES_MAX) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'trop de rôles');
  }

  // Network await AVANT toute transaction SQLite.
  for (const roleId of roleIds) {
    if (roleId === ctx.guildId) {
      throw new ConfigWriteError(400, 'INVALID_ROLE', '@everyone interdit');
    }
    const role = await fetchGuildRoleLive(ctx.guild, roleId);
    assertRoleInGuild(role, ctx.guildId);
  }

  const sorted = [...roleIds].sort();
  const currentSorted = [...current.command_permissions.role_ids].sort();
  if (
    current.command_permissions.mode === 'roles'
    && sorted.length === currentSorted.length
    && sorted.every((id, i) => id === currentSorted[i])
  ) {
    return { noop: true, config: current };
  }

  try {
    // Transaction sync courte uniquement (aucun await à l'intérieur).
    transactionReplaceScrimAllowedRoles(writeCtx, ctx.guildId, roleIds);
  } catch (err) {
    if (isSqliteBusyError(err)) {
      throw new ConfigWriteError(503, 'BOT_BUSY');
    }
    throw new ConfigWriteError(500, 'INTERNAL_ERROR');
  }

  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId) };
}

/**
 * @param {import('discord.js').GuildChannel | null | undefined} channel
 * @param {string} guildId
 */
function assertChannelInGuild(channel, guildId) {
  if (!channel) {
    throw new ConfigWriteError(400, 'INVALID_CHANNEL');
  }
  const channelGuildId = channel.guild?.id ?? channel.guildId ?? null;
  if (channelGuildId != null && String(channelGuildId) !== guildId) {
    throw new ConfigWriteError(400, 'INVALID_CHANNEL');
  }
}

/**
 * @param {import('discord.js').Role | null | undefined} role
 * @param {string} guildId
 */
function assertRoleInGuild(role, guildId) {
  if (!role) {
    throw new ConfigWriteError(400, 'INVALID_ROLE');
  }
  const roleGuildId = role.guild?.id ?? null;
  if (roleGuildId != null && String(roleGuildId) !== guildId) {
    throw new ConfigWriteError(400, 'INVALID_ROLE');
  }
}

/**
 * @param {import('discord.js').Guild} guild
 * @param {string} channelId
 */
async function fetchGuildChannelLive(guild, channelId) {
  try {
    let channel = guild.channels.cache.get(channelId) ?? null;
    if (!channel) {
      channel = await withDiscordTimeout(guild.channels.fetch(channelId));
    }
    return channel;
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? /** @type {{ code?: unknown }} */ (err).code
      : undefined;
    if (code === 'TIMEOUT' || code === 'ECONNRESET' || code === 'ETIMEDOUT') {
      throw new ConfigWriteError(503, 'BOT_UNAVAILABLE');
    }
    return null;
  }
}

/**
 * @param {import('discord.js').Guild} guild
 * @param {string} roleId
 */
async function fetchGuildRoleLive(guild, roleId) {
  try {
    let role = guild.roles.cache.get(roleId) ?? null;
    if (!role) {
      role = await withDiscordTimeout(guild.roles.fetch(roleId));
    }
    return role;
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? /** @type {{ code?: unknown }} */ (err).code
      : undefined;
    if (code === 'TIMEOUT' || code === 'ECONNRESET' || code === 'ETIMEDOUT') {
      throw new ConfigWriteError(503, 'BOT_UNAVAILABLE');
    }
    return null;
  }
}
