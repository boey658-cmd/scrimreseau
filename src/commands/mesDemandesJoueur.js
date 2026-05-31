import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { formatPlayerSearchActiveSummaryLine } from '../utils/playerSearchValidation.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

const MSG_EMPTY = 'Tu n’as aucune recherche joueur active.';
const FOOTER_HINT = 'Pour fermer une recherche : /joueur-trouve id:J1';

export const mesDemandesJoueur = {
  data: new SlashCommandBuilder()
    .setName('mes-demandes-joueur')
    .setDescription('Affiche tes recherches de joueur actives'),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{
   *   playerSearchStmts: ReturnType<import('../database/db.js')['preparePlayerSearchStatements']>,
   * }} ctx
   */
  async execute(interaction, ctx) {
    const userId = interaction.user.id;

    try {
      const rows = ctx.playerSearchStmts.listActivePlayerSearchPostsByAuthor.all(
        userId,
      );

      if (!rows.length) {
        await interactReply(interaction, {
          content: MSG_EMPTY,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const lines = rows.map((row) => formatPlayerSearchActiveSummaryLine(row));
      const content = `Tes recherches joueur actives :\n\n${lines.join('\n')}\n\n${FOOTER_HINT}`;

      await interactReply(interaction, {
        content: content.slice(0, 2000),
        flags: MessageFlags.Ephemeral,
      });

      logger.info('mes-demandes-joueur', {
        user_id: userId,
        count: rows.length,
      });
    } catch (err) {
      logger.error('mes-demandes-joueur', {
        user_id: userId,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      try {
        await interactReply(interaction, {
          content:
            '❌ Impossible de charger tes recherches joueur pour le moment. Réessaie plus tard.',
          flags: MessageFlags.Ephemeral,
        });
      } catch (replyErr) {
        logger.error('mes-demandes-joueur — réponse impossible', {
          message:
            replyErr instanceof Error ? replyErr.message : String(replyErr),
        });
      }
    }
  },
};
