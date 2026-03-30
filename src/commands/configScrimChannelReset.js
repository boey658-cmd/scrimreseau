import { MessageFlags } from 'discord.js';
import {
  interactDeferReply,
  interactEditReply,
  interactReply,
} from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

const MSG_NEED_GUILD =
  '❌ Cette commande doit être utilisée sur un serveur.';

const MSG_DB_ERROR =
  '❌ Impossible de mettre à jour la configuration. Réessayez plus tard.';

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeConfigScrimChannelResetCore(interaction, ctx) {
    try {
      if (!interaction.inGuild()) {
        await interactReply(interaction, {
          content: MSG_NEED_GUILD,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interactDeferReply(interaction, { flags: MessageFlags.Ephemeral });

      const guildId = interaction.guildId;

      try {
        ctx.stmts.deleteScrimUsageChannel.run(guildId);
      } catch (err) {
        logger.error('config-scrim-channel-reset — DB', {
          guild_id: guildId,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        await interactEditReply(interaction, { content: MSG_DB_ERROR });
        return;
      }

      logger.info('config-scrim-channel-reset', {
        guild_id: guildId,
        user_id: interaction.user.id,
      });

      await interactEditReply(interaction, {
        content:
          '✅ La restriction de salon pour /recherche-scrim a été supprimée.',
      });
    } catch (err) {
      logger.error('config-scrim-channel-reset — execute', {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      try {
        if (interaction.deferred) {
          await interactEditReply(interaction, { content: MSG_DB_ERROR });
        } else if (!interaction.replied) {
          await interactReply(interaction, {
            content: MSG_DB_ERROR,
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (replyErr) {
        logger.error('config-scrim-channel-reset — réponse impossible', {
          message:
            replyErr instanceof Error ? replyErr.message : String(replyErr),
        });
      }
    }
}
