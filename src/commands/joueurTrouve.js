import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { closePlayerSearchPostByPublicIdForAuthor } from '../services/playerSearchLifecycle.js';
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

export const joueurTrouve = {
  data: new SlashCommandBuilder()
    .setName('joueur-trouve')
    .setDescription('Marque ta recherche de joueur comme terminée')
    .addStringOption((opt) =>
      opt
        .setName('id')
        .setDescription('Identifiant public (ex. J1, J2)')
        .setRequired(true),
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{
   *   db: import('better-sqlite3').Database,
   *   stmts: ReturnType<import('../database/db.js')['prepareStatements']>,
   *   playerSearchStmts: ReturnType<import('../database/db.js')['preparePlayerSearchStatements']>,
   * }} ctx
   */
  async execute(interaction, ctx) {
    const rawId = interaction.options.getString('id', true);

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

      const result = await closePlayerSearchPostByPublicIdForAuthor(
        interaction.client,
        ctx.db,
        ctx.playerSearchStmts,
        rawId,
        interaction.user.id,
      );

      await interactEditReply(interaction, {
        content: result.message,
        flags: MessageFlags.Ephemeral,
      });

      if (result.ok) {
        logger.event('player_search:joueur-trouve', {
          user_id: interaction.user.id,
          player_search_public_id: result.publicId,
        });
      }
    } catch (err) {
      logger.error('player_search:joueur-trouve', {
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
      } catch {
        /* ignore */
      }
    }
  },
};
