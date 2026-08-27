import { MessageFlags } from 'discord.js';
import { getGuildLocale, t } from '../i18n/index.js';
import { unblacklistUserGlobally } from '../services/scrimModeration.js';
import {
  botDevForbiddenMessage,
  botDevUnconfiguredMessage,
  resolveBotDevId,
} from '../utils/botDevConfig.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeUnblacklistCore(interaction, ctx) {
  const locale = getGuildLocale(interaction.guildId, ctx.stmts);
  try {
    const dev = resolveBotDevId();
    if (!dev.ok) {
      try {
        logger.warn('unblacklist — BOT_DEV_ID absent ou invalide (commande refusée)', {
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
    unblacklistUserGlobally(ctx.stmts, user.id, interaction.user.id);

    await interactReply(interaction, {
      content: t(locale, 'dev.unblacklistOk'),
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    logger.error('unblacklist', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    try {
      await interactReply(interaction, {
        content: t(locale, 'dev.unblacklistError'),
        flags: MessageFlags.Ephemeral,
      });
    } catch {
      /* ignore */
    }
  }
}
