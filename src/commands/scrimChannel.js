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
import { scheduleNetworkDashboardUpdate } from '../services/networkDashboard.js';
import { removeScrimReceptionDestination } from '../services/scrimDestinationCleanup.js';
import {
  MSG_BOT_DEV_FORBIDDEN,
  MSG_BOT_DEV_UNCONFIGURED,
  resolveBotDevId,
} from '../utils/botDevConfig.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

/** Snowflake Discord : 17–22 chiffres (aligné sur botDevConfig). */
const SNOWFLAKE_RE = /^\d{17,22}$/;

const MSG_DENIED = '❌ Cette commande est réservée au développeur du bot.';

/**
 * @param {string} raw
 * @returns {string | null}
 */
export function parseDiscordSnowflakeId(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!SNOWFLAKE_RE.test(s)) return null;
  return s;
}

const data = new SlashCommandBuilder()
  .setName('scrim-channel')
  .setDescription('Dev only — remove a scrim reception destination by guild/channel ID')
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
  );

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
async function execute(interaction, ctx) {
  const devGuildId = process.env.DEV_GUILD_ID?.trim() ?? '';

  // 1) Guilde de développement uniquement (fail-closed)
  if (!interaction.inGuild()) {
    await interactReply(interaction, {
      content: MSG_DENIED,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!devGuildId || interaction.guildId !== devGuildId) {
    await interactReply(interaction, {
      content: MSG_DENIED,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // 2) Identité développeur (BOT_DEV_ID) — jamais Administrator
  const dev = resolveBotDevId();
  if (!dev.ok) {
    logger.warn('scrim-channel — BOT_DEV_ID absent ou invalide', { reason: dev.reason });
    await interactReply(interaction, {
      content: MSG_BOT_DEV_UNCONFIGURED,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.user.id !== dev.devId) {
    await interactReply(interaction, {
      content: MSG_BOT_DEV_FORBIDDEN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sub = interaction.options.getSubcommand(true);
  if (sub !== 'remove') {
    await interactReply(interaction, {
      content: '❌ Sous-commande inconnue.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildId = parseDiscordSnowflakeId(interaction.options.getString('guild_id', true));
  const channelId = parseDiscordSnowflakeId(interaction.options.getString('channel_id', true));
  if (!guildId || !channelId) {
    await interactReply(interaction, {
      content:
        '❌ `guild_id` / `channel_id` invalides. Indique des snowflakes Discord (17–22 chiffres).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Lookup DB uniquement — aucun fetch Discord du salon
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
      content: '❌ Erreur lors de la lecture de la base.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!existing) {
    await interactReply(interaction, {
      content:
        `ℹ️ Aucune destination scrim pour guild \`${guildId}\` / channel \`${channelId}\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Sécurité relationnelle : l’entrée lue doit correspondre exactement au couple fourni
  if (String(existing.guild_id) !== guildId || String(existing.channel_id) !== channelId) {
    await interactReply(interaction, {
      content: '❌ Incohérence DB : la destination ne correspond pas aux IDs fournis.',
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
      content:
        `ℹ️ Aucune destination scrim pour guild \`${guildId}\` / channel \`${channelId}\`.`,
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
    content:
      `✅ Destination retirée.\n` +
      `• guild_id : \`${guildId}\`\n` +
      `• channel_id : \`${channelId}\`\n` +
      `Les prochaines diffusions n’utiliseront plus ce salon.`,
    flags: MessageFlags.Ephemeral,
  });
}

export const scrimChannel = { data, execute };
