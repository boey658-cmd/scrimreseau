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
import { getLimit, canUseFeature } from './entitlements/index.js';
import { isValidLolFilterRankKey } from './rankTaxonomy.js';
import { parseStructureProfilePatchBody } from './structureProfileValidation.js';
import {
  deleteStructureProfile,
  getStructureProfile,
  upsertStructureProfile,
} from './structureProfileStore.js';
import {
  normalizeOptionalEmbedColor,
  normalizeLineEmojisFromPatch,
  normalizePresetName,
} from './embedCustomizationValidation.js';
import {
  applyEmbedPreset,
  createEmbedPreset,
  deleteEmbedCustomization,
  deleteEmbedPreset,
  getEmbedCustomization,
  updateEmbedPreset,
  upsertEmbedCustomization,
} from './embedCustomizationStore.js';
import { logger } from '../utils/logger.js';

export { SCRIM_ALLOWED_ROLES_MAX };

const CHANNEL_ID_RE = /^\d{17,20}$/;
const MAX_REORDER_IDS = 32;

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
    case 'reception_channels_add':
      return writeReceptionChannelsAdd(ctx, patch);
    case 'reception_channels_remove':
      return writeReceptionChannelsRemove(ctx, patch);
    case 'reception_channels_reorder':
      return writeReceptionChannelsReorder(ctx, patch);
    case 'reception_channels_set_enabled':
      return writeReceptionChannelsSetEnabled(ctx, patch);
    case 'reception_channel_filter':
      return writeReceptionChannelFilter(ctx, patch);
    case 'command_channel':
      return writeCommandChannel(ctx, patch);
    case 'inactive_message_policy':
      return writeInactiveMessagePolicy(ctx, patch);
    case 'structure_link':
      return writeStructureLink(ctx, patch);
    case 'structure_profile':
      return writeStructureProfile(ctx, patch);
    case 'embed_customization':
      return writeEmbedCustomization(ctx, patch);
    case 'embed_customization_reset':
      return writeEmbedCustomizationReset(ctx);
    case 'embed_preset_create':
      return writeEmbedPresetCreate(ctx, patch);
    case 'embed_preset_update':
      return writeEmbedPresetUpdate(ctx, patch);
    case 'embed_preset_delete':
      return writeEmbedPresetDelete(ctx, patch);
    case 'embed_preset_apply':
      return writeEmbedPresetApply(ctx, patch);
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

  const current = fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts });
  if (current.language === language) {
    return { noop: true, config: current };
  }

  ctx.stmts.upsertGuildLanguage.run(ctx.guildId, language);
  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
}

/**
 * Legacy section `reception_channel` :
 * - null → wipe all for game
 * - limit === 1 → REPLACE (FREE UX : changer le salon)
 * - limit > 1 → ADD (délégué à add race-safe)
 *
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
  const current = fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts });
  const gameRows = current.reception_channels.filter((c) => c.game_key === gameKey);

  if (channelIdRaw === null) {
    if (gameRows.length === 0) {
      return { noop: true, config: current };
    }
    try {
      const wipe = ctx.db.transaction(() => {
        ctx.stmts.deleteGuildChannelsByGuildGame.run(ctx.guildId, gameKey);
        if (ctx.stmts.deleteReceptionChannelEloFiltersByGuildGame) {
          ctx.stmts.deleteReceptionChannelEloFiltersByGuildGame.run(ctx.guildId, gameKey);
        }
      });
      wipe();
    } catch (err) {
      if (isSqliteBusyError(err)) {
        throw new ConfigWriteError(503, 'BOT_BUSY');
      }
      throw err;
    }
    try {
      logger.info('receptionChannels: wipe game channels', {
        guild_id: ctx.guildId,
        game_key: gameKey,
      });
    } catch {
      /* ignore */
    }
    scheduleNetworkDashboardUpdate(ctx.client, ctx.stmts);
    return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
  }

  const channelId = channelIdRaw.trim();
  if (!CHANNEL_ID_RE.test(channelId)) {
    throw new ConfigWriteError(400, 'INVALID_CHANNEL');
  }

  const existing = ctx.stmts.getGuildGameChannelByChannelId.get(ctx.guildId, channelId);
  if (existing && String(existing.game_key) === gameKey && Number(existing.enabled) === 1) {
    return { noop: true, config: current };
  }

  const limit = getLimit(ctx.guildId, 'reception_channels', { stmts: ctx.stmts });
  if (limit <= 1) {
    // FREE : replace unique salon
    await assertReceptionChannelEligible(ctx, channelId);
    const now = Date.now();
    const replace = ctx.db.transaction(() => {
      ctx.stmts.deleteGuildChannelsByGuildGame.run(ctx.guildId, gameKey);
      ctx.stmts.upsertGuildChannel.run({
        guild_id: ctx.guildId,
        channel_id: channelId,
        game_key: gameKey,
        created_at: now,
      });
    });
    try {
      replace();
    } catch (err) {
      if (isSqliteBusyError(err)) {
        throw new ConfigWriteError(503, 'BOT_BUSY');
      }
      throw err;
    }
    try {
      logger.info('receptionChannels: FREE replace', {
        guild_id: ctx.guildId,
        channel_id: channelId,
      });
    } catch {
      /* ignore */
    }
    scheduleNetworkDashboardUpdate(ctx.client, ctx.stmts);
    return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
  }

  // Premium : même chemin que add (pas de wipe)
  return writeReceptionChannelsAdd(ctx, { channel_id: channelId });
}

/**
 * @param {GuildConfigWriteCtx} ctx
 * @param {Record<string, unknown>} patch
 */
async function writeReceptionChannelsAdd(ctx, patch) {
  if (!('channel_id' in patch)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'channel_id requis');
  }
  if (typeof patch.channel_id !== 'string') {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'channel_id invalide');
  }
  const channelId = patch.channel_id.trim();
  if (!CHANNEL_ID_RE.test(channelId)) {
    throw new ConfigWriteError(400, 'INVALID_CHANNEL');
  }

  const gameKey = UI_PRIMARY_GAME_KEY;
  const current = fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts });
  const existing = ctx.stmts.getGuildGameChannelByChannelId.get(ctx.guildId, channelId);
  if (existing && String(existing.game_key) === gameKey) {
    throw new ConfigWriteError(409, 'RECEPTION_CHANNEL_ALREADY_EXISTS');
  }

  await assertReceptionChannelEligible(ctx, channelId);

  const now = Date.now();
  const tx = ctx.db.transaction(() => {
    // Lock write : count + insert atomiques (race-safe quota)
    const limit = getLimit(ctx.guildId, 'reception_channels', { stmts: ctx.stmts });
    const max = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
    const countRow = ctx.stmts.countConfiguredChannelsByGuildGame.get(ctx.guildId, gameKey);
    const configured = Number(countRow?.n ?? 0);
    if (configured >= max) {
      throw new ConfigWriteError(403, 'RECEPTION_CHANNEL_LIMIT_REACHED');
    }

    // Double-check absence sous lock
    const again = ctx.stmts.getGuildGameChannelByChannelId.get(ctx.guildId, channelId);
    if (again && String(again.game_key) === gameKey) {
      throw new ConfigWriteError(409, 'RECEPTION_CHANNEL_ALREADY_EXISTS');
    }

    const maxSortRow = ctx.stmts.maxSortOrderByGuildGame.get(ctx.guildId, gameKey);
    const nextSort = Number(maxSortRow?.max_sort ?? -1) + 1;
    ctx.stmts.insertReceptionChannelAtOrder.run({
      guild_id: ctx.guildId,
      channel_id: channelId,
      game_key: gameKey,
      enabled: 1,
      sort_order: nextSort,
      created_at: now,
    });
  });

  try {
    tx();
  } catch (err) {
    if (isConfigWriteError(err)) throw err;
    if (isSqliteBusyError(err)) {
      throw new ConfigWriteError(503, 'BOT_BUSY');
    }
    throw err;
  }

  try {
    logger.info('receptionChannels: channel added', {
      guild_id: ctx.guildId,
      channel_id: channelId,
    });
  } catch {
    /* ignore */
  }
  scheduleNetworkDashboardUpdate(ctx.client, ctx.stmts);
  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
}

/**
 * @param {GuildConfigWriteCtx} ctx
 * @param {Record<string, unknown>} patch
 */
function writeReceptionChannelsRemove(ctx, patch) {
  if (!('channel_id' in patch) || typeof patch.channel_id !== 'string') {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'channel_id requis');
  }
  const channelId = patch.channel_id.trim();
  if (!CHANNEL_ID_RE.test(channelId)) {
    throw new ConfigWriteError(400, 'INVALID_CHANNEL');
  }

  const gameKey = UI_PRIMARY_GAME_KEY;
  const current = fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts });
  const existing = ctx.stmts.getGuildGameChannelByChannelId.get(ctx.guildId, channelId);
  if (!existing || String(existing.game_key) !== gameKey) {
    return { noop: true, config: current };
  }

  const now = Date.now();
  const tx = ctx.db.transaction(() => {
    ctx.stmts.deleteGuildChannelByChannelId.run(ctx.guildId, channelId);
    if (ctx.stmts.deleteReceptionChannelEloFilter) {
      ctx.stmts.deleteReceptionChannelEloFilter.run(ctx.guildId, channelId);
    }
    const remaining = ctx.stmts.listAllChannelsByGuildGame.all(ctx.guildId, gameKey) ?? [];
    let i = 0;
    for (const row of remaining) {
      if (Number(row.sort_order) !== i) {
        ctx.stmts.setReceptionChannelSortOrder.run({
          guild_id: ctx.guildId,
          channel_id: row.channel_id,
          sort_order: i,
          updated_at: now,
        });
      }
      i += 1;
    }
  });

  try {
    tx();
  } catch (err) {
    if (isSqliteBusyError(err)) {
      throw new ConfigWriteError(503, 'BOT_BUSY');
    }
    throw err;
  }

  try {
    logger.info('receptionChannels: channel removed', {
      guild_id: ctx.guildId,
      channel_id: channelId,
    });
  } catch {
    /* ignore */
  }
  scheduleNetworkDashboardUpdate(ctx.client, ctx.stmts);
  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
}

/**
 * @param {GuildConfigWriteCtx} ctx
 * @param {Record<string, unknown>} patch
 */
function writeReceptionChannelsReorder(ctx, patch) {
  if (!('channel_ids' in patch) || !Array.isArray(patch.channel_ids)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'channel_ids requis');
  }
  if (patch.channel_ids.length === 0) {
    throw new ConfigWriteError(400, 'INVALID_ORDER', 'channel_ids vide');
  }
  if (patch.channel_ids.length > MAX_REORDER_IDS) {
    throw new ConfigWriteError(400, 'INVALID_ORDER', 'trop de channel_ids');
  }

  /** @type {string[]} */
  const ordered = [];
  const seen = new Set();
  for (const raw of patch.channel_ids) {
    if (typeof raw !== 'string' || !CHANNEL_ID_RE.test(raw.trim())) {
      throw new ConfigWriteError(400, 'INVALID_CHANNEL');
    }
    const id = raw.trim();
    if (seen.has(id)) {
      throw new ConfigWriteError(400, 'INVALID_ORDER', 'channel_ids en doublon');
    }
    seen.add(id);
    ordered.push(id);
  }

  const gameKey = UI_PRIMARY_GAME_KEY;
  const current = fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts });
  const existingRows = ctx.stmts.listAllChannelsByGuildGame.all(ctx.guildId, gameKey) ?? [];
  const existingIds = new Set(existingRows.map((r) => String(r.channel_id)));

  if (ordered.length !== existingIds.size) {
    throw new ConfigWriteError(400, 'INVALID_ORDER', 'liste incohérente avec rows existantes');
  }
  for (const id of ordered) {
    if (!existingIds.has(id)) {
      throw new ConfigWriteError(400, 'RECEPTION_CHANNEL_NOT_FOUND');
    }
  }

  const currentOrder = existingRows.map((r) => String(r.channel_id));
  if (
    currentOrder.length === ordered.length
    && currentOrder.every((id, i) => id === ordered[i])
  ) {
    return { noop: true, config: current };
  }

  const now = Date.now();
  const tx = ctx.db.transaction(() => {
    let tmp = -1000;
    for (const id of ordered) {
      ctx.stmts.setReceptionChannelSortOrder.run({
        guild_id: ctx.guildId,
        channel_id: id,
        sort_order: tmp,
        updated_at: now,
      });
      tmp -= 1;
    }
    let i = 0;
    for (const id of ordered) {
      ctx.stmts.setReceptionChannelSortOrder.run({
        guild_id: ctx.guildId,
        channel_id: id,
        sort_order: i,
        updated_at: now,
      });
      i += 1;
    }
  });

  try {
    tx();
  } catch (err) {
    if (isSqliteBusyError(err)) {
      throw new ConfigWriteError(503, 'BOT_BUSY');
    }
    throw err;
  }

  try {
    logger.info('receptionChannels: reorder', {
      guild_id: ctx.guildId,
      count: ordered.length,
    });
  } catch {
    /* ignore */
  }
  scheduleNetworkDashboardUpdate(ctx.client, ctx.stmts);
  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
}

/**
 * Désactivation / réactivation volontaire admin (`enabled` = user_enabled).
 * Upgrade ne réactive PAS un salon user-disabled.
 *
 * @param {GuildConfigWriteCtx} ctx
 * @param {Record<string, unknown>} patch
 */
function writeReceptionChannelsSetEnabled(ctx, patch) {
  if (!('channel_id' in patch) || typeof patch.channel_id !== 'string') {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'channel_id requis');
  }
  if (!('enabled' in patch) || typeof patch.enabled !== 'boolean') {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'enabled boolean requis');
  }
  const channelId = patch.channel_id.trim();
  if (!CHANNEL_ID_RE.test(channelId)) {
    throw new ConfigWriteError(400, 'INVALID_CHANNEL');
  }

  const gameKey = UI_PRIMARY_GAME_KEY;
  const current = fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts });
  const existing = ctx.stmts.getGuildGameChannelByChannelId.get(ctx.guildId, channelId);
  if (!existing || String(existing.game_key) !== gameKey) {
    throw new ConfigWriteError(404, 'RECEPTION_CHANNEL_NOT_FOUND');
  }

  const wantEnabled = patch.enabled ? 1 : 0;
  if (Number(existing.enabled) === wantEnabled) {
    return { noop: true, config: current };
  }

  const now = Date.now();
  try {
    ctx.stmts.setReceptionChannelUserEnabled.run({
      guild_id: ctx.guildId,
      channel_id: channelId,
      enabled: wantEnabled,
      updated_at: now,
    });
  } catch (err) {
    if (isSqliteBusyError(err)) {
      throw new ConfigWriteError(503, 'BOT_BUSY');
    }
    throw err;
  }

  try {
    logger.info('receptionChannels: set user enabled', {
      guild_id: ctx.guildId,
      channel_id: channelId,
      enabled: wantEnabled === 1,
    });
  } catch {
    /* ignore */
  }
  scheduleNetworkDashboardUpdate(ctx.client, ctx.stmts);
  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
}

/**
 * Set / unset filtre Elo salon (Phase 3).
 * Payload : { channel_id, elo_rank_key: string | null }
 *
 * @param {GuildConfigWriteCtx} ctx
 * @param {Record<string, unknown>} patch
 */
function writeReceptionChannelFilter(ctx, patch) {
  if (!canUseFeature(ctx.guildId, 'elo_channel_filters', { stmts: ctx.stmts })) {
    throw new ConfigWriteError(403, 'FEATURE_NOT_AVAILABLE');
  }

  if (!('channel_id' in patch) || typeof patch.channel_id !== 'string') {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'channel_id requis');
  }
  if (!('elo_rank_key' in patch)) {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'elo_rank_key requis');
  }

  const channelId = patch.channel_id.trim();
  if (!CHANNEL_ID_RE.test(channelId)) {
    throw new ConfigWriteError(400, 'INVALID_CHANNEL');
  }

  const eloRaw = patch.elo_rank_key;
  if (eloRaw !== null && typeof eloRaw !== 'string') {
    throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'elo_rank_key invalide');
  }

  /** @type {string | null} */
  let eloKey = null;
  if (typeof eloRaw === 'string') {
    const trimmed = eloRaw.trim();
    if (!trimmed) {
      eloKey = null;
    } else if (!isValidLolFilterRankKey(trimmed)) {
      throw new ConfigWriteError(400, 'VALIDATION_ERROR', 'elo_rank_key invalide');
    } else {
      eloKey = trimmed;
    }
  }

  const gameKey = UI_PRIMARY_GAME_KEY;
  const current = fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts });
  const channelRow = ctx.stmts.getGuildGameChannelByChannelId.get(ctx.guildId, channelId);
  if (!channelRow || String(channelRow.game_key) !== gameKey) {
    throw new ConfigWriteError(404, 'RECEPTION_CHANNEL_NOT_FOUND');
  }

  const existingFilter = ctx.stmts.getReceptionChannelEloFilter?.get(ctx.guildId, channelId);
  const currentKey = existingFilter?.elo_rank_key == null
    ? null
    : String(existingFilter.elo_rank_key);
  if (currentKey === eloKey) {
    return { noop: true, config: current };
  }

  const now = Date.now();
  try {
    if (eloKey == null) {
      ctx.stmts.deleteReceptionChannelEloFilter.run(ctx.guildId, channelId);
    } else {
      ctx.stmts.upsertReceptionChannelEloFilter.run({
        guild_id: ctx.guildId,
        channel_id: channelId,
        game_key: gameKey,
        elo_rank_key: eloKey,
        created_at: now,
        updated_at: now,
      });
    }
  } catch (err) {
    if (isSqliteBusyError(err)) {
      throw new ConfigWriteError(503, 'BOT_BUSY');
    }
    throw err;
  }

  try {
    logger.info(
      eloKey == null ? 'receptionChannels: filter removed' : 'receptionChannels: filter set',
      { guild_id: ctx.guildId, channel_id: channelId, elo_rank_key: eloKey },
    );
  } catch {
    /* ignore */
  }

  scheduleNetworkDashboardUpdate(ctx.client, ctx.stmts);
  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
}

/**
 * Gate réception + Discord live check.
 * @param {GuildConfigWriteCtx} ctx
 * @param {string} channelId
 */
async function assertReceptionChannelEligible(ctx, channelId) {
  const bypassRow = ctx.stmts.getGuildScrimReceptionBypass.get(ctx.guildId);
  if (!mayConfigureScrimReceptionChannel(ctx.guild.memberCount, bypassRow)) {
    throw new ConfigWriteError(403, 'RECEPTION_NOT_ALLOWED');
  }

  const channel = await fetchGuildChannelLive(ctx.guild, channelId);
  if (!channel) {
    throw new ConfigWriteError(400, 'INVALID_CHANNEL');
  }
  assertChannelInGuild(channel, ctx.guildId);

  const channelGuildId = channel.guild?.id ?? channel.guildId ?? null;
  if (channelGuildId != null && String(channelGuildId) !== ctx.guildId) {
    throw new ConfigWriteError(400, 'CHANNEL_NOT_IN_GUILD');
  }

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
    throw new ConfigWriteError(400, 'INVALID_CHANNEL', check.error ?? 'INVALID_CHANNEL');
  }
}

/**
 * @param {unknown} err
 * @returns {err is import('./configWriteError.js').ConfigWriteError}
 */
function isConfigWriteError(err) {
  return err instanceof ConfigWriteError;
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

  const current = fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts });

  if (channelIdRaw === null) {
    if (current.command_channel_id === null) {
      return { noop: true, config: current };
    }
    ctx.stmts.deleteScrimUsageChannel.run(ctx.guildId);
    return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
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
  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
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

  const current = fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts });
  if (current.inactive_message_policy === policy) {
    return { noop: true, config: current };
  }

  ctx.stmts.upsertScrimMessageLifecyclePolicy.run({
    guild_id: ctx.guildId,
    policy,
    updated_at: new Date().toISOString(),
  });
  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
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

  const current = fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts });

  if (urlRaw === null) {
    if (current.structure_invite_url === null) {
      return { noop: true, config: current };
    }
    ctx.stmts.deleteStructureDiscordLink.run(ctx.guildId);
    return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
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
  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
}

/**
 * Profil structure Premium (Phase 5) — write gated, downgrade ne delete pas.
 * @param {GuildConfigWriteCtx} ctx
 * @param {Record<string, unknown>} patch
 */
function writeStructureProfile(ctx, patch) {
  if (!canUseFeature(ctx.guildId, 'enhanced_structure_profile', { stmts: ctx.stmts })) {
    throw new ConfigWriteError(403, 'FEATURE_NOT_AVAILABLE');
  }

  const parsed = parseStructureProfilePatchBody(patch);

  if (parsed.reset) {
    const existing = getStructureProfile(ctx.db, ctx.guildId);
    if (!existing) {
      return { noop: true, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
    }
    try {
      deleteStructureProfile(ctx.db, ctx.guildId);
    } catch (err) {
      if (isSqliteBusyError(err)) {
        throw new ConfigWriteError(503, 'SQLITE_BUSY');
      }
      throw err;
    }
    return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
  }

  const next = {
    display_name: parsed.display_name,
    description: parsed.description,
    logo_url: parsed.logo_url,
    website_url: parsed.website_url,
    country_code: parsed.country_code,
    languages: parsed.languages,
    socials: parsed.socials,
  };

  const current = getStructureProfile(ctx.db, ctx.guildId);
  if (
    current
    && current.display_name === next.display_name
    && current.description === next.description
    && current.logo_url === next.logo_url
    && current.website_url === next.website_url
    && current.country_code === next.country_code
    && JSON.stringify(current.languages) === JSON.stringify(next.languages)
    && JSON.stringify(current.socials) === JSON.stringify(next.socials)
  ) {
    return { noop: true, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
  }

  try {
    upsertStructureProfile(ctx.db, ctx.guildId, next);
  } catch (err) {
    if (isSqliteBusyError(err)) {
      throw new ConfigWriteError(503, 'SQLITE_BUSY');
    }
    throw err;
  }

  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
}

/**
 * @param {GuildConfigWriteCtx} ctx
 * @param {Record<string, unknown>} patch
 */
function writeEmbedCustomization(ctx, patch) {
  if (!canUseFeature(ctx.guildId, 'local_embed_customization', { stmts: ctx.stmts })) {
    throw new ConfigWriteError(403, 'FEATURE_NOT_AVAILABLE');
  }
  const color_hex = normalizeOptionalEmbedColor(patch.color_hex);
  // Nouvelle UX : écrit les 5 emojis ligne et force emoji legacy à NULL.
  const lines = normalizeLineEmojisFromPatch(patch);
  const emoji = null;
  const current = getEmbedCustomization(ctx.db, ctx.guildId);
  if (
    current
    && current.color_hex === color_hex
    && current.emoji === emoji
    && current.emoji_date === lines.emoji_date
    && current.emoji_format === lines.emoji_format
    && current.emoji_rank === lines.emoji_rank
    && current.emoji_contact === lines.emoji_contact
    && current.emoji_structure === lines.emoji_structure
    && current.active_preset_id == null
  ) {
    return { noop: true, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
  }
  try {
    upsertEmbedCustomization(ctx.db, ctx.guildId, {
      color_hex,
      emoji,
      ...lines,
      active_preset_id: null,
    });
    logger.info('embed customization saved', { guild_id: ctx.guildId });
  } catch (err) {
    if (isSqliteBusyError(err)) throw new ConfigWriteError(503, 'SQLITE_BUSY');
    throw err;
  }
  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
}

/**
 * @param {GuildConfigWriteCtx} ctx
 */
function writeEmbedCustomizationReset(ctx) {
  if (!canUseFeature(ctx.guildId, 'local_embed_customization', { stmts: ctx.stmts })) {
    throw new ConfigWriteError(403, 'FEATURE_NOT_AVAILABLE');
  }
  const current = getEmbedCustomization(ctx.db, ctx.guildId);
  if (!current) {
    return { noop: true, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
  }
  try {
    deleteEmbedCustomization(ctx.db, ctx.guildId);
    logger.info('embed customization reset', { guild_id: ctx.guildId });
  } catch (err) {
    if (isSqliteBusyError(err)) throw new ConfigWriteError(503, 'SQLITE_BUSY');
    throw err;
  }
  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
}

/**
 * @param {GuildConfigWriteCtx} ctx
 * @param {Record<string, unknown>} patch
 */
function writeEmbedPresetCreate(ctx, patch) {
  if (!canUseFeature(ctx.guildId, 'embed_presets', { stmts: ctx.stmts })) {
    throw new ConfigWriteError(403, 'FEATURE_NOT_AVAILABLE');
  }
  const name = normalizePresetName(patch.name);
  const color_hex = normalizeOptionalEmbedColor(patch.color_hex);
  const lines = normalizeLineEmojisFromPatch(patch);
  try {
    createEmbedPreset(ctx.db, ctx.guildId, {
      name,
      color_hex,
      emoji: null,
      ...lines,
    });
    logger.info('embed preset created', { guild_id: ctx.guildId });
  } catch (err) {
    if (err instanceof ConfigWriteError) throw err;
    if (isSqliteBusyError(err)) throw new ConfigWriteError(503, 'SQLITE_BUSY');
    throw err;
  }
  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
}

/**
 * @param {GuildConfigWriteCtx} ctx
 * @param {Record<string, unknown>} patch
 */
function writeEmbedPresetUpdate(ctx, patch) {
  if (!canUseFeature(ctx.guildId, 'embed_presets', { stmts: ctx.stmts })) {
    throw new ConfigWriteError(403, 'FEATURE_NOT_AVAILABLE');
  }
  const presetId = Number(patch.preset_id);
  if (!Number.isInteger(presetId) || presetId < 1) {
    throw new ConfigWriteError(400, 'PRESET_NOT_FOUND');
  }
  const name = normalizePresetName(patch.name);
  const color_hex = normalizeOptionalEmbedColor(patch.color_hex);
  const lines = normalizeLineEmojisFromPatch(patch);
  try {
    updateEmbedPreset(ctx.db, ctx.guildId, presetId, {
      name,
      color_hex,
      emoji: null,
      ...lines,
    });
  } catch (err) {
    if (err instanceof ConfigWriteError) throw err;
    if (isSqliteBusyError(err)) throw new ConfigWriteError(503, 'SQLITE_BUSY');
    throw err;
  }
  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
}

/**
 * @param {GuildConfigWriteCtx} ctx
 * @param {Record<string, unknown>} patch
 */
function writeEmbedPresetDelete(ctx, patch) {
  if (!canUseFeature(ctx.guildId, 'embed_presets', { stmts: ctx.stmts })) {
    throw new ConfigWriteError(403, 'FEATURE_NOT_AVAILABLE');
  }
  const presetId = Number(patch.preset_id);
  if (!Number.isInteger(presetId) || presetId < 1) {
    throw new ConfigWriteError(400, 'PRESET_NOT_FOUND');
  }
  try {
    deleteEmbedPreset(ctx.db, ctx.guildId, presetId);
    logger.info('embed preset deleted', { guild_id: ctx.guildId, preset_id: presetId });
  } catch (err) {
    if (err instanceof ConfigWriteError) throw err;
    if (isSqliteBusyError(err)) throw new ConfigWriteError(503, 'SQLITE_BUSY');
    throw err;
  }
  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
}

/**
 * @param {GuildConfigWriteCtx} ctx
 * @param {Record<string, unknown>} patch
 */
function writeEmbedPresetApply(ctx, patch) {
  if (!canUseFeature(ctx.guildId, 'embed_presets', { stmts: ctx.stmts })) {
    throw new ConfigWriteError(403, 'FEATURE_NOT_AVAILABLE');
  }
  if (!canUseFeature(ctx.guildId, 'local_embed_customization', { stmts: ctx.stmts })) {
    throw new ConfigWriteError(403, 'FEATURE_NOT_AVAILABLE');
  }
  const presetId = Number(patch.preset_id);
  if (!Number.isInteger(presetId) || presetId < 1) {
    throw new ConfigWriteError(400, 'PRESET_NOT_FOUND');
  }
  try {
    applyEmbedPreset(ctx.db, ctx.guildId, presetId);
    logger.info('embed preset applied', { guild_id: ctx.guildId, preset_id: presetId });
  } catch (err) {
    if (err instanceof ConfigWriteError) throw err;
    if (isSqliteBusyError(err)) throw new ConfigWriteError(503, 'SQLITE_BUSY');
    throw err;
  }
  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
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

  const current = fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts });
  const writeCtx = { db: ctx.db, stmts: ctx.stmts };

  if (mode === 'everyone') {
    if (
      current.command_permissions.mode === 'everyone'
      && current.command_permissions.role_ids.length === 0
    ) {
      return { noop: true, config: current };
    }
    transactionSetEveryoneMode(writeCtx, ctx.guildId);
    return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
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

  return { noop: false, config: fetchGuildConfig(ctx.db, ctx.guildId, { stmts: ctx.stmts }) };
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
