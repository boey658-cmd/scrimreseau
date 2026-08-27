import { MessageFlags } from 'discord.js';
import { DateTime } from 'luxon';
import { getGuildLocale, t } from '../i18n/index.js';
import {
  blacklistUserGlobally,
  parseBlacklistDurationChoice,
} from '../services/scrimModeration.js';
import {
  botDevForbiddenMessage,
  botDevUnconfiguredMessage,
  resolveBotDevId,
} from '../utils/botDevConfig.js';
import { SCRIM_TIMEZONE } from '../utils/scrimScheduledAt.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeBlacklistCore(interaction, ctx) {
  const locale = getGuildLocale(interaction.guildId, ctx.stmts);
  try {
    const dev = resolveBotDevId();
    if (!dev.ok) {
      try {
        logger.warn('blacklist — BOT_DEV_ID absent ou invalide (commande refusée)', {
          reason: dev.reason,
        });
      } catch {
        /* ignore */
      }
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

    const user = interaction.options.getUser('user', true);
    const durationKey = interaction.options.getString('duration', true);
    const reason = interaction.options.getString('reason') ?? undefined;

    if (user.id === interaction.client.user?.id) {
      await interactReply(interaction, {
        content: t(locale, 'dev.blacklistBot'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const parsed = parseBlacklistDurationChoice(durationKey);
    if (parsed.expiresAt === undefined) {
      await interactReply(interaction, {
        content: t(locale, 'dev.blacklistInvalidDuration'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const expiresIso =
      parsed.expiresAt === null ? null : parsed.expiresAt.toISOString();

    blacklistUserGlobally(
      ctx.stmts,
      user.id,
      expiresIso,
      reason,
      interaction.user.id,
      durationKey,
    );

    if (parsed.expiresAt === null) {
      await interactReply(interaction, {
        content: t(locale, 'dev.blacklistPermanent'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const until = DateTime.fromJSDate(parsed.expiresAt)
      .setZone(SCRIM_TIMEZONE)
      .toFormat("dd/MM/yyyy à HH'h'mm (Europe/Paris)");
    await interactReply(interaction, {
      content: t(locale, 'dev.blacklistUntil', { until }),
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    logger.error('blacklist', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    try {
      await interactReply(interaction, {
        content: t(locale, 'dev.blacklistError'),
        flags: MessageFlags.Ephemeral,
      });
    } catch {
      /* ignore */
    }
  }
}
