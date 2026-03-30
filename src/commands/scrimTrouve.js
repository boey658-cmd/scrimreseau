import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import {
  closeScrimPostByPublicIdForAuthor,
  SCRIM_PUBLIC_ID_MAX,
} from '../services/scrimLifecycle.js';
import {
  checkGlobalBlacklist,
  GLOBAL_BLACKLIST_SERVICE_UNAVAILABLE_MESSAGE,
  GLOBAL_BLACKLIST_USER_MESSAGE,
} from '../services/scrimModeration.js';
import {
  interactDeferReply,
  interactEditReply,
  interactReply,
} from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

export const scrimTrouve = {
  data: new SlashCommandBuilder()
    .setName('scrim-trouve')
    .setDescription(
      'Marque ta recherche de scrim League of Legends comme terminée',
    )
    .addIntegerOption((opt) =>
      opt
        .setName('id')
        .setDescription(
          `Identifiant public de ta recherche (1–${SCRIM_PUBLIC_ID_MAX})`,
        )
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(SCRIM_PUBLIC_ID_MAX),
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
   */
  async execute(interaction, ctx) {
    const publicId = interaction.options.getInteger('id', true);

    try {
      const blState = checkGlobalBlacklist(ctx.stmts, interaction.user.id, {
        failClosedOnError: true,
      });
      if (blState.result === 'service_unavailable') {
        await interactReply(interaction, {
          content: GLOBAL_BLACKLIST_SERVICE_UNAVAILABLE_MESSAGE,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (blState.result === 'blocked') {
        await interactReply(interaction, {
          content: GLOBAL_BLACKLIST_USER_MESSAGE,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interactDeferReply(interaction, { flags: MessageFlags.Ephemeral });

      const result = await closeScrimPostByPublicIdForAuthor(
        interaction.client,
        ctx.db,
        ctx.stmts,
        publicId,
        interaction.user.id,
      );

      await interactEditReply(interaction, {
        content: result.message,
        flags: MessageFlags.Ephemeral,
      });

      if (result.ok) {
        logger.event('scrim-trouve', {
          user_id: interaction.user.id,
          scrim_public_id: publicId,
        });
      }
    } catch (err) {
      logger.error('scrim-trouve', {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      try {
        const payload = {
          content:
            '❌ Une erreur est survenue. Réessaie plus tard ou contacte un administrateur.',
          flags: MessageFlags.Ephemeral,
        };
        if (interaction.deferred || interaction.replied) {
          await interactEditReply(interaction, payload);
        } else {
          await interactReply(interaction, payload);
        }
      } catch (replyErr) {
        logger.error('scrim-trouve — réponse impossible', {
          message:
            replyErr instanceof Error ? replyErr.message : String(replyErr),
        });
      }
    }
  },
};
