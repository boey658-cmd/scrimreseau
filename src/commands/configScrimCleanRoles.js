import { MessageFlags } from 'discord.js';
import { cleanInvalidRoles } from '../services/scrimGuildRestrictions.js';
import {
  interactDeferReply,
  interactEditReply,
  interactReply,
} from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

const MSG_NEED_GUILD =
  '❌ Cette commande doit être utilisée sur un serveur.';

const MSG_DB_ERROR =
  '❌ Impossible de nettoyer la configuration. Réessayez plus tard.';

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeConfigScrimCleanRolesCore(interaction, ctx) {
    try {
      if (!interaction.inGuild() || !interaction.guild) {
        await interactReply(interaction, { content: MSG_NEED_GUILD, flags: MessageFlags.Ephemeral });
        return;
      }

      await interactDeferReply(interaction, { flags: MessageFlags.Ephemeral });

      const guildId = interaction.guildId;
      const guild = interaction.guild;

      const result = cleanInvalidRoles(guildId, guild, ctx.stmts);

      if (!result.ok) {
        logger.error('config-scrim-clean-roles — cleanInvalidRoles', {
          guild_id: guildId,
          error: result.error,
        });
        await interactEditReply(interaction, { content: MSG_DB_ERROR });
        return;
      }

      const { removed } = result;
      const content =
        removed > 0
          ? removed === 1
            ? '✅ 1 rôle supprimé de la configuration.'
            : `✅ ${removed} rôles supprimés de la configuration.`
          : '✅ Aucun rôle invalide trouvé.';

      await interactEditReply(interaction, { content });

      logger.info('config-scrim-clean-roles', {
        guild_id: guildId,
        user_id: interaction.user.id,
        removed,
      });
    } catch (err) {
      logger.error('config-scrim-clean-roles — execute', {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      try {
        if (interaction.deferred) {
          await interactEditReply(interaction, { content: MSG_DB_ERROR });
        } else if (!interaction.replied) {
          await interactReply(interaction, { content: MSG_DB_ERROR, flags: MessageFlags.Ephemeral });
        }
      } catch (replyErr) {
        logger.error('config-scrim-clean-roles — réponse impossible', {
          message:
            replyErr instanceof Error ? replyErr.message : String(replyErr),
        });
      }
    }
}
