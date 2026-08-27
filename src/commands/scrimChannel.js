/**
 * /scrim-channel — outil de maintenance développeur uniquement.
 *
 * Déploiement : DEV_GUILD_ID seulement (voir scripts/deploy-commands.js).
 * Exécution : BOT_DEV_ID (+ présence sur DEV_GUILD_ID), jamais Administrator.
 *
 * Permet de retirer une destination guild_game_channels par snowflakes,
 * même si le salon Discord n’existe plus.
 */

import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getGuildLocale, t } from '../i18n/index.js';
import {
  applyDescriptionLocalizations,
  slashMeta,
} from '../i18n/slashLocalizations.js';
import { scheduleNetworkDashboardUpdate } from '../services/networkDashboard.js';
import { removeScrimReceptionDestination } from '../services/scrimDestinationCleanup.js';
import {
  botDevForbiddenMessage,
  botDevUnconfiguredMessage,
  resolveBotDevId,
} from '../utils/botDevConfig.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

/** Snowflake Discord : 17–22 chiffres (aligné sur botDevConfig). */
const SNOWFLAKE_RE = /^\d{17,22}$/;

/**
 * @param {string} raw
 * @returns {string | null}
 */
export function parseDiscordSnowflakeId(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!SNOWFLAKE_RE.test(s)) return null;
  return s;
}

const data = applyDescriptionLocalizations(
  new SlashCommandBuilder()
    .setName('scrim-channel')
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a reception channel registration (works if the channel was deleted)')
        .addStringOption((opt) =>
          opt
            .setName('guild_id')
            .setDescription('Discord guild snowflake of the destination server')
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('channel_id')
            .setDescription('Discord channel snowflake to remove from configuration')
            .setRequired(true),
        ),
    ),
  slashMeta.scrimChannel.description,
);

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
async function execute(interaction, ctx) {
  const locale = getGuildLocale(interaction.guildId, ctx.stmts);
  const denied = t(locale, 'dev.forbidden');
  const devGuildId = process.env.DEV_GUILD_ID?.trim() ?? '';

  if (!interaction.inGuild()) {
    await interactReply(interaction, {
      content: denied,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!devGuildId || interaction.guildId !== devGuildId) {
    await interactReply(interaction, {
      content: denied,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const dev = resolveBotDevId();
  if (!dev.ok) {
    logger.warn('scrim-channel — BOT_DEV_ID absent ou invalide', { reason: dev.reason });
    await interactReply(interaction, {
      content: botDevUnconfiguredMessage(locale),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.user.id !== dev.devId) {
    await interactReply(interaction, {
      content: botDevForbiddenMessage(locale),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sub = interaction.options.getSubcommand(true);
  if (sub !== 'remove') {
    await interactReply(interaction, {
      content: t(locale, 'dev.unknownSubcommand'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildId = parseDiscordSnowflakeId(interaction.options.getString('guild_id', true));
  const channelId = parseDiscordSnowflakeId(interaction.options.getString('channel_id', true));
  if (!guildId || !channelId) {
    await interactReply(interaction, {
      content: t(locale, 'dev.scrimChannelInvalidIds'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let existing = null;
  try {
    existing = ctx.stmts.getGuildGameChannelByChannelId.get(guildId, channelId) ?? null;
  } catch (err) {
    logger.error('scrim-channel remove: erreur lecture DB', {
      guild_id: guildId,
      channel_id: channelId,
      message: err instanceof Error ? err.message : String(err),
    });
    await interactReply(interaction, {
      content: t(locale, 'dev.dbReadError'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!existing) {
    await interactReply(interaction, {
      content: t(locale, 'dev.scrimChannelNone', { guildId, channelId }),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (String(existing.guild_id) !== guildId || String(existing.channel_id) !== channelId) {
    await interactReply(interaction, {
      content: t(locale, 'dev.scrimChannelInconsistency'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const removed = removeScrimReceptionDestination(
    ctx.stmts,
    guildId,
    channelId,
    'DEV_REMOVE',
  );

  if (!removed) {
    await interactReply(interaction, {
      content: t(locale, 'dev.scrimChannelNone', { guildId, channelId }),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  scheduleNetworkDashboardUpdate(interaction.client, ctx.stmts);
  logger.event('scrim-channel.remove', {
    target_guild_id: guildId,
    channel_id: channelId,
    user_id: interaction.user.id,
    via_guild_id: interaction.guildId,
  });

  await interactReply(interaction, {
    content: t(locale, 'dev.scrimChannelRemoved', { guildId, channelId }),
    flags: MessageFlags.Ephemeral,
  });
}

export const scrimChannel = { data, execute };
