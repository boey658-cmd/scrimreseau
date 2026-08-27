import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { DateTime } from 'luxon';
import { getEmbedColorForGame } from '../config/gameEmbedColors.js';
import { localizeRank } from '../config/games.js';
import { formatParisScrimListSchedule } from '../services/scrimEmbedBuilder.js';
import { formatRankWithPrecision } from '../config/eloPrecision.js';
import { SCRIM_PUBLIC_ID_MAX } from '../services/scrimLifecycle.js';
import { SCRIM_TIMEZONE } from '../utils/scrimScheduledAt.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';
import { getGuildLocale, t } from '../i18n/index.js';
import {
  applyDescriptionLocalizations,
  slashMeta,
} from '../i18n/slashLocalizations.js';

// FOOTER_HINT → t(locale)

/**
 * @param {{
 *   scheduled_at: string | null,
 *   scheduled_at_end?: string | null,
 *   scheduled_date: string,
 *   scheduled_time: string,
 * }} row
 */
/**
 * @param {typeof row} row
 * @param {string} [locale]
 */
function formatScheduleLine(row, locale = 'fr') {
  const schedule = formatParisScrimListSchedule(row, locale);
  const sep = t(locale, 'listeQuery.at');
  return `${schedule.dateStr}${sep}${schedule.timeStr}`;
}

/**
 * @param {number} ms
 * @param {string} [locale]
 */
function formatCreatedParis(ms, locale = 'fr') {
  const fmt = t(locale, 'myScrims.createdAtFormat');
  return DateTime.fromMillis(ms, { zone: SCRIM_TIMEZONE }).toFormat(fmt);
}

export const mesDemandes = {
  data: applyDescriptionLocalizations(
    new SlashCommandBuilder().setName('my-scrims'),
    slashMeta.myScrims.description,
  ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
   */
  async execute(interaction, ctx) {
    const userId = interaction.user.id;
    const locale = getGuildLocale(interaction.guildId, ctx.stmts);

    try {
      const rows = ctx.stmts.listActiveScrimPostsByAuthor.all(userId);

      if (!rows.length) {
        await interactReply(interaction, {
          content: t(locale, 'myScrims.empty'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const lines = rows.map((row) => {
        const pid = Number(row.scrim_public_id);
        const idStr = Number.isFinite(pid)
          ? String(pid).padStart(3, '0')
          : String(row.scrim_public_id ?? '');
        const sched = formatScheduleLine(row, locale);
        const rankRaw = String(row.rank_key);
        const eloPrecision = typeof row.elo_precision === 'string' && row.elo_precision.trim()
          ? row.elo_precision.trim()
          : null;
        const localizedRankStr = localizeRank(rankRaw, locale);
        const rankWithPrec = formatRankWithPrecision(localizedRankStr, eloPrecision, locale);
        const fmt = String(row.format_key);
        const created =
          typeof row.created_at === 'number'
            ? ` \u00b7 ${t(locale, 'myScrims.createdAt', { date: formatCreatedParis(row.created_at, locale) })}`
            : '';
        return `- **ID ${idStr}** \u2014 ${sched} \u2014 ${rankWithPrec} \u2014 ${fmt}${created}`;
      });

      const description = lines.join('\n').slice(0, 4096);
      const firstGame = rows[0]?.game_key;
      const colorKey =
        typeof firstGame === 'string' && firstGame.length > 0 ? firstGame : '';

      const embed = new EmbedBuilder()
        .setTitle(t(locale, 'myScrims.embedTitle'))
        .setDescription(description)
        .setColor(getEmbedColorForGame(colorKey))
        .setFooter({ text: t(locale, 'myScrims.footerHint', { max: SCRIM_PUBLIC_ID_MAX }) })
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
          content: t(locale, 'myScrims.error'),
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
