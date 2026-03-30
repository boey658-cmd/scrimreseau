import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { DateTime } from 'luxon';
import { getEmbedColorForGame } from '../config/gameEmbedColors.js';
import { formatParisScrimListSchedule } from '../services/scrimEmbedBuilder.js';
import { SCRIM_PUBLIC_ID_MAX } from '../services/scrimLifecycle.js';
import { SCRIM_TIMEZONE } from '../utils/scrimScheduledAt.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

const MSG_EMPTY =
  'ℹ️ Tu n’as actuellement aucune recherche de scrim active.';

const FOOTER_HINT = `Utilise /scrim-trouve id:XXX (1–${SCRIM_PUBLIC_ID_MAX}) pour fermer une recherche.`;

/**
 * @param {{
 *   scheduled_at: string | null,
 *   scheduled_at_end?: string | null,
 *   scheduled_date: string,
 *   scheduled_time: string,
 * }} row
 */
function formatScheduleLine(row) {
  const { dateStr, timeStr } = formatParisScrimListSchedule(row);
  return `${dateStr} à ${timeStr}`;
}

/** @param {number} ms */
function formatCreatedParis(ms) {
  return DateTime.fromMillis(ms, { zone: SCRIM_TIMEZONE }).toFormat(
    "dd/MM/yyyy HH'h'mm",
  );
}

export const mesDemandes = {
  data: new SlashCommandBuilder()
    .setName('mes-demandes')
    .setDescription('Affiche tes recherches de scrim actives'),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
   */
  async execute(interaction, ctx) {
    const userId = interaction.user.id;

    try {
      const rows = ctx.stmts.listActiveScrimPostsByAuthor.all(userId);

      if (!rows.length) {
        await interactReply(interaction, {
          content: MSG_EMPTY,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const lines = rows.map((row) => {
        const pid = Number(row.scrim_public_id);
        const idStr = Number.isFinite(pid)
          ? String(pid).padStart(3, '0')
          : String(row.scrim_public_id ?? '');
        const sched = formatScheduleLine(row);
        const rank = String(row.rank_key);
        const fmt = String(row.format_key);
        const created =
          typeof row.created_at === 'number'
            ? ` · créée ${formatCreatedParis(row.created_at)}`
            : '';
        return `- **ID ${idStr}** — ${sched} — ${rank} — ${fmt}${created}`;
      });

      const description = lines.join('\n').slice(0, 4096);
      const firstGame = rows[0]?.game_key;
      const colorKey =
        typeof firstGame === 'string' && firstGame.length > 0 ? firstGame : '';

      const embed = new EmbedBuilder()
        .setTitle('📋 Tes demandes de scrim actives')
        .setDescription(description)
        .setColor(getEmbedColorForGame(colorKey))
        .setFooter({ text: FOOTER_HINT })
        .setTimestamp(new Date());

      await interactReply(interaction, {
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
      });

      logger.info('mes-demandes', {
        user_id: userId,
        count: rows.length,
      });
    } catch (err) {
      logger.error('mes-demandes', {
        user_id: userId,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      try {
        await interactReply(interaction, {
          content:
            '❌ Impossible de charger tes demandes pour le moment. Réessaie plus tard.',
          flags: MessageFlags.Ephemeral,
        });
      } catch (replyErr) {
        logger.error('mes-demandes — réponse impossible', {
          message:
            replyErr instanceof Error ? replyErr.message : String(replyErr),
        });
      }
    }
  },
};
