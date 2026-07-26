import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getPrimaryGameRankChoicesForSlash } from '../config/games.js';
import {
  buildDiscordMessageUrl,
  expandRankKeysForListeFilter,
  formatListeScrimLine,
  LISTE_DISPLAY_MAX,
  LISTE_FETCH_LIMIT,
  runActiveScrimsListeQuery,
  runCountActiveScrimsListe,
} from '../services/listeScrimsQuery.js';
import { logger } from '../utils/logger.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { getGuildLocale, t } from '../i18n/index.js';
import {
  parseAndNormalizeTime,
  parseListeScrimDateFilter,
} from '../utils/validation.js';

/**
 * Traduit un résultat d'erreur de validation (utilise errorCode si disponible, sinon fallback).
 * @param {{ errorCode?: string, error: string }} res
 * @param {string} locale
 */
function validationMsg(res, locale) {
  return res.errorCode ? t(locale, res.errorCode) : `❌ ${res.error}`;
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
 */
export async function executeListeScrimsCore(interaction, ctx) {
  if (!interaction.inGuild()) {
    await interactReply(interaction, { content: t('fr', 'listScrims.guildOnly'), flags: MessageFlags.Ephemeral });
    return;
  }

  const guildId = interaction.guildId;
  const locale = getGuildLocale(guildId, ctx.stmts);

  const eloRaw = interaction.options.getString('elo');
  const dateRaw = interaction.options.getString('date');
  const heureDebutRaw = interaction.options.getString('heure_debut');
  const heureFinRaw = interaction.options.getString('heure_fin');

  if ((heureDebutRaw?.trim() || heureFinRaw?.trim()) && !dateRaw?.trim()) {
    await interactReply(interaction, {
      content: t(locale, 'listScrims.dateRequiredForTime'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  /** @type {{ rankKeys?: string[], scheduledDate?: string, timeMin?: string, timeMax?: string }} */
  const filters = {};

  if (eloRaw != null && eloRaw.trim() !== '') {
    filters.rankKeys = expandRankKeysForListeFilter(eloRaw);
  }

  if (dateRaw?.trim()) {
    const dateRes = parseListeScrimDateFilter(dateRaw);
    if (!dateRes.ok) {
      await interactReply(interaction, {
        content: validationMsg(dateRes, locale),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    filters.scheduledDate = dateRes.value;
  }

  let tMin;
  let tMax;
  if (heureDebutRaw?.trim()) {
    const r = parseAndNormalizeTime(heureDebutRaw);
    if (!r.ok) {
      await interactReply(interaction, { content: validationMsg(r, locale), flags: MessageFlags.Ephemeral });
      return;
    }
    tMin = r.value;
  }
  if (heureFinRaw?.trim()) {
    const r = parseAndNormalizeTime(heureFinRaw);
    if (!r.ok) {
      await interactReply(interaction, { content: validationMsg(r, locale), flags: MessageFlags.Ephemeral });
      return;
    }
    tMax = r.value;
  }

  if (tMin != null && tMax != null && tMin > tMax) {
    await interactReply(interaction, {
      content: t(locale, 'listScrims.hourOrder'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (tMin != null) filters.timeMin = tMin;
  if (tMax != null) filters.timeMax = tMax;

  const rows = runActiveScrimsListeQuery(ctx.db, filters);
  let total = rows.length;
  if (rows.length === LISTE_FETCH_LIMIT) {
    total = runCountActiveScrimsListe(ctx.db, filters);
  }

  if (total === 0) {
    await interactReply(interaction, { content: t(locale, 'listScrims.none'), flags: MessageFlags.Ephemeral });
    return;
  }

  const displayRows = rows.slice(0, LISTE_DISPLAY_MAX);

  const lines = displayRows.map((row) => {
    const tagsStr = typeof row.tags === 'string' ? row.tags : '';
    const dbId = Number(row.id);
    let messageUrl = null;
    if (Number.isFinite(dbId)) {
      const linkRow = ctx.stmts.getScrimPostMessageForGuild.get(dbId, guildId);
      if (
        linkRow &&
        typeof linkRow.channel_id === 'string' &&
        typeof linkRow.message_id === 'string'
      ) {
        messageUrl = buildDiscordMessageUrl(
          guildId,
          linkRow.channel_id,
          linkRow.message_id,
        );
      }
    }
    return formatListeScrimLine(row, tagsStr, messageUrl, locale);
  });

  let content = `${t(locale, 'listScrims.header', { total })}\n\n${lines.join('\n')}`;
  if (total > LISTE_DISPLAY_MAX) {
    content += t(locale, 'listScrims.truncated', { total });
  }

  if (content.length > 2000) {
    content = `${content.slice(0, 1990)}…`;
  }

  await interactReply(interaction, { content, flags: MessageFlags.Ephemeral });

  try {
    logger.info('liste-scrims', {
      guild_id: guildId,
      user_id: interaction.user.id,
      total,
      filters: {
        elo_rank_keys: filters.rankKeys ?? null,
        date: filters.scheduledDate ?? null,
        heure_debut: filters.timeMin ?? null,
        heure_fin: filters.timeMax ?? null,
      },
    });
  } catch {
    /* ignore */
  }
}

export const listeScrims = {
  data: new SlashCommandBuilder()
    .setName('list-scrims')
    .setDescription('List active scrim searches.')
    .addStringOption((opt) =>
      opt
        .setName('elo')
        .setDescription('Filter by rank.')
        .setRequired(false)
        .addChoices(...getPrimaryGameRankChoicesForSlash()),
    )
    .addStringOption((opt) =>
      opt
        .setName('date')
        .setDescription('Filter by date (DD/MM or DD/MM/YYYY).')
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName('heure_debut')
        .setDescription('Minimum start time (requires date).')
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName('heure_fin')
        .setDescription('Maximum start time (requires date).')
        .setRequired(false),
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
   */
  async execute(interaction, ctx) {
    await executeListeScrimsCore(interaction, ctx);
  },
};
