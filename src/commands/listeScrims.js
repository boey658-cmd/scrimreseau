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
import {
  parseAndNormalizeTime,
  parseListeScrimDateFilter,
} from '../utils/validation.js';

const MSG_NO_GUILD =
  '❌ Cette commande doit être utilisée sur un serveur.';
const MSG_DATE_REQUIRED_FOR_TIME =
  '❌ Indique une **date** pour filtrer sur les heures.';
const MSG_HEURE_ORDER =
  '❌ L’heure de début doit être avant ou égale à l’heure de fin.';
const MSG_NONE =
  'ℹ️ Aucune recherche de scrim active ne correspond à ces critères.';

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
 */
export async function executeListeScrimsCore(interaction, ctx) {
  if (!interaction.inGuild()) {
    await interactReply(interaction, { content: MSG_NO_GUILD, flags: MessageFlags.Ephemeral });
    return;
  }

  const eloRaw = interaction.options.getString('elo');
  const dateRaw = interaction.options.getString('date');
  const heureDebutRaw = interaction.options.getString('heure_debut');
  const heureFinRaw = interaction.options.getString('heure_fin');

  if ((heureDebutRaw?.trim() || heureFinRaw?.trim()) && !dateRaw?.trim()) {
    await interactReply(interaction, {
      content: MSG_DATE_REQUIRED_FOR_TIME,
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
        content: `❌ ${dateRes.error}`,
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
      await interactReply(interaction, { content: `❌ ${r.error}`, flags: MessageFlags.Ephemeral });
      return;
    }
    tMin = r.value;
  }
  if (heureFinRaw?.trim()) {
    const r = parseAndNormalizeTime(heureFinRaw);
    if (!r.ok) {
      await interactReply(interaction, { content: `❌ ${r.error}`, flags: MessageFlags.Ephemeral });
      return;
    }
    tMax = r.value;
  }

  if (tMin != null && tMax != null && tMin > tMax) {
    await interactReply(interaction, {
      content: MSG_HEURE_ORDER,
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
    await interactReply(interaction, { content: MSG_NONE, flags: MessageFlags.Ephemeral });
    return;
  }

  const guildId = interaction.guildId;
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
    return formatListeScrimLine(row, tagsStr, messageUrl);
  });

  let content = `Scrims actives trouvées : ${total}\n\n${lines.join('\n')}`;
  if (total > LISTE_DISPLAY_MAX) {
    content += `\n\n20 résultats affichés sur ${total}. Affine ta recherche si tu veux trouver plus précis.`;
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
    .setName('liste-scrims')
    .setDescription('Liste les recherches de scrim actives (filtres optionnels)')
    .addStringOption((opt) =>
      opt
        .setName('elo')
        .setDescription('Rang LoL (choix fermés, catalogue /recherche-scrim)')
        .setRequired(false)
        .addChoices(...getPrimaryGameRankChoicesForSlash()),
    )
    .addStringOption((opt) =>
      opt
        .setName('date')
        .setDescription('Date JJ/MM ou JJ/MM/AAAA (optionnel)')
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName('heure_debut')
        .setDescription('Heure minimum (20:30, 20h30…) — requiert date')
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName('heure_fin')
        .setDescription('Heure maximum — requiert date')
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
