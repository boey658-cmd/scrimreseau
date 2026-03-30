import { MessageFlags } from 'discord.js';
import { unblacklistUserGlobally } from '../services/scrimModeration.js';
import {
  MSG_BOT_DEV_FORBIDDEN,
  MSG_BOT_DEV_UNCONFIGURED,
  resolveBotDevId,
} from '../utils/botDevConfig.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeUnblacklistCore(interaction, ctx) {
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

      const user = interaction.options.getUser('user', true);
      unblacklistUserGlobally(ctx.stmts, user.id, interaction.user.id);

      await interactReply(interaction, {
        content: '✅ Utilisateur retiré de la blacklist.',
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      logger.error('unblacklist', {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      try {
        await interactReply(interaction, {
          content: '❌ Erreur lors du retrait de la blacklist.',
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        /* ignore */
      }
    }
}
