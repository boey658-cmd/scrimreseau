import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { UI_PRIMARY_GAME_KEY } from '../config/games.js';
import { broadcastScrimRequest } from '../services/broadcast.js';
import {
  allocateScrimPublicId,
  MS_TOO_MANY,
} from '../services/scrimLifecycle.js';
import {
  checkScrimChannel,
  checkScrimPermissions,
} from '../services/scrimGuildRestrictions.js';
import {
  buildFormatAutocompleteChoices,
  buildRankAutocompleteChoices,
  resolveGameKeyForAutocomplete,
  serializeSlashOptionsData,
} from '../utils/rechercheScrimAutocomplete.js';
import {
  parseAndNormalizeTime,
  parseScrimSearchDate,
  validateContactUser,
  validateFormat,
  validateOptionalFlexibleEndTime,
  validateRank,
} from '../utils/validation.js';
import {
  checkActiveScrimLimit,
  checkGlobalBlacklist,
  checkScrimCreationWindowLimit,
  checkScrimCreationBurstCooldown,
  GLOBAL_BLACKLIST_SERVICE_UNAVAILABLE_MESSAGE,
  GLOBAL_BLACKLIST_USER_MESSAGE,
  MAX_ACTIVE_SCRIMS_PER_USER,
  scrimModerationEnvWindowLimit,
  scrimModerationEnvWindowMs,
} from '../services/scrimModeration.js';
import {
  beginScrimRequest,
  endScrimRequest,
  hasActiveScrimRequest,
} from '../utils/scrimRequestLock.js';
import { validateMultiOpggUrl } from '../utils/validateMultiOpgg.js';
import { computeScheduledAtIso } from '../utils/scrimScheduledAt.js';
import {
  interactAutocompleteRespond,
  interactEditReply,
  interactReply,
} from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';
import { checkScrimReseauPublicGuildMembership } from '../utils/scrimPublicGuildGate.js';
import {
  FORMAT_SCRIM_SERIE_KEY,
  getScrimCommunityServerUrlFromEnv,
  scrimDbRowToEmbedPayload,
} from '../services/scrimEmbedBuilder.js';

/** Lien affiché dans l’astuce post-publication si `SCRIM_COMMUNITY_SERVER_URL` est absent ou invalide. */
const DEFAULT_SCRIM_COMMUNITY_TIP_URL = 'https://discord.gg/ton-invite';

/**
 * `tags` : JSON `{ fearless, nombre_de_games? }` — pas de migration SQLite.
 * @param {string} fearlessStored `oui` | `non` | `nimporte`
 * @param {number | null} nombreDeGamesOpt
 * @param {boolean} includeNombre
 */
function buildScrimTagsJson(fearlessStored, nombreDeGamesOpt, includeNombre) {
  /** @type {Record<string, unknown>} */
  const o = { fearless: fearlessStored };
  if (includeNombre && nombreDeGamesOpt != null) {
    o.nombre_de_games = nombreDeGamesOpt;
  }
  return JSON.stringify(o);
}

const NOMBRE_DE_GAMES_CHOICES = [2, 3, 4, 5, 6, 7, 8, 9, 10];

const MSG_ACTIVE_SCRIM_LIMIT =
  `❌ Tu as déjà ${MAX_ACTIVE_SCRIMS_PER_USER} recherches de scrim actives. Ferme-en une ou attends qu’elle expire avant d’en créer une nouvelle.`;

const DEBUG_AUTOCOMPLETE = 'DEBUG recherche-scrim autocomplete';
const DEBUG_VALIDATION_RANK_FORMAT = 'DEBUG recherche-scrim validation finale rang/format';

function isScrimDebugAutocompleteEnabled() {
  const v = process.env.SCRIM_DEBUG_AUTOCOMPLETE?.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

export const rechercheScrim = {
  data: new SlashCommandBuilder()
    .setName('recherche-scrim')
    .setDescription(
      'Diffuse une recherche de scrim League of Legends sur le réseau.',
    )
    .addStringOption((opt) =>
      opt
        .setName('rang')
        .setDescription('Rang LoL (saisie ou suggestions)')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt
        .setName('date')
        .setDescription('Date (ex. 23/03, 23-03, 23/03/2026)')
        .setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName('heure')
        .setDescription('Heure (ex. 20:30, 20h30, 20h)')
        .setRequired(true),
    )
    .addUserOption((opt) =>
      opt
        .setName('contact')
        .setDescription('Contact Discord pour organiser le scrim')
        .setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName('format')
        .setDescription('Format de match (suggestions selon le jeu)')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt
        .setName('fearless')
        .setDescription('Fearless (draft pick)')
        .setRequired(true)
        .addChoices(
          { name: 'Oui', value: 'oui' },
          { name: 'Non', value: 'non' },
          { name: 'N\'importe', value: 'nimporte' },
        ),
    )
    .addStringOption((opt) =>
      opt
        .setName('heure_max_debut')
        .setDescription('Heure max de début (si flexible)')
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName('multi_opgg')
        .setDescription('Lien HTTPS OP.GG uniquement')
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName('nombre_de_games')
        .setDescription('Nombre de games (uniquement avec le format scrim série)')
        .setRequired(false)
        .addChoices(
          ...NOMBRE_DE_GAMES_CHOICES.map((n) => ({ name: String(n), value: n })),
        ),
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
   */
  async execute(interaction, ctx) {
    const userId = interaction.user.id;

    if (hasActiveScrimRequest(userId)) {
      await interactReply(interaction, {
        content:
          '⏳ Une recherche de scrim est déjà en cours de traitement.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    beginScrimRequest(userId);
    try {
      return await (async () => {
    if (!interaction.inGuild()) {
      await interactReply(interaction, {
        content:
          '❌ Cette commande ne peut être utilisée que dans un serveur.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const publicGuildGate = await checkScrimReseauPublicGuildMembership(
      interaction.client,
      interaction.user.id,
    );
    if (!publicGuildGate.ok) {
      await interactReply(interaction, {
        content: publicGuildGate.content,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

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

    const guildId = interaction.guildId;
    const channelCheck = checkScrimChannel(
      guildId,
      interaction.channel,
      ctx.stmts,
    );
    if (!channelCheck.ok) {
      await interactReply(interaction, {
        content: channelCheck.error,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const permCheck = checkScrimPermissions(
      interaction.member,
      guildId,
      interaction.guild,
      ctx.stmts,
    );
    if (!permCheck.ok) {
      await interactReply(interaction, {
        content: permCheck.error,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const gameKey = UI_PRIMARY_GAME_KEY;
    const rankRaw = interaction.options.getString('rang', true);
    const dateRaw = interaction.options.getString('date', true);
    const timeRaw = interaction.options.getString('heure', true);
    const timeMaxRaw = interaction.options.getString('heure_max_debut');
    const contact = interaction.options.getUser('contact', true);
    const formatRaw = interaction.options.getString('format', true);
    const fearlessRaw = interaction.options.getString('fearless', true);
    const multiOpggRaw = interaction.options.getString('multi_opgg');

    const dateRes = parseScrimSearchDate(dateRaw);
    if (!dateRes.ok) {
      await interactReply(interaction, { content: `❌ ${dateRes.error}`, flags: MessageFlags.Ephemeral });
      return;
    }

    const timeRes = parseAndNormalizeTime(timeRaw);
    if (!timeRes.ok) {
      await interactReply(interaction, { content: `❌ ${timeRes.error}`, flags: MessageFlags.Ephemeral });
      return;
    }

    const flexEndRes = validateOptionalFlexibleEndTime(timeRes.value, timeMaxRaw);
    if (!flexEndRes.ok) {
      await interactReply(interaction, {
        content: `❌ ${flexEndRes.error}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const rankRes = validateRank(gameKey, rankRaw);
    const formatRes = validateFormat(gameKey, formatRaw);

    if (!rankRes.ok || !formatRes.ok) {
      logger.info(DEBUG_VALIDATION_RANK_FORMAT, {
        game_key: gameKey,
        rank_received: rankRaw,
        format_received: formatRaw,
        rank_valid: rankRes.ok,
        format_valid: formatRes.ok,
      });
    }

    if (!rankRes.ok) {
      await interactReply(interaction, { content: `❌ ${rankRes.error}`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (!formatRes.ok) {
      await interactReply(interaction, { content: `❌ ${formatRes.error}`, flags: MessageFlags.Ephemeral });
      return;
    }

    const fearlessStored = fearlessRaw.trim().toLowerCase();

    const nombreDeGamesOpt = interaction.options.getInteger('nombre_de_games');
    if (nombreDeGamesOpt != null && formatRes.value !== FORMAT_SCRIM_SERIE_KEY) {
      await interactReply(interaction, {
        content:
          '❌ Le nombre de games ne peut être utilisé qu’avec le format scrim série.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const contactRes = validateContactUser(contact);
    if (!contactRes.ok) {
      await interactReply(interaction, { content: `❌ ${contactRes.error}`, flags: MessageFlags.Ephemeral });
      return;
    }

    const multiOpggRes = validateMultiOpggUrl(multiOpggRaw, gameKey);
    if (!multiOpggRes.ok) {
      await interactReply(interaction, {
        content: `❌ ${multiOpggRes.error}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const multiOpggUrl = multiOpggRes.value;

    const activeLimit = checkActiveScrimLimit(ctx.stmts, interaction.user.id);
    if (!activeLimit.ok) {
      await interactReply(interaction, {
        content: MSG_ACTIVE_SCRIM_LIMIT,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const burst = checkScrimCreationBurstCooldown(
      ctx.stmts,
      interaction.user.id,
    );
    if (!burst.ok && burst.remainingSeconds != null) {
      await interactReply(interaction, {
        content: `❌ Tu dois attendre encore ${burst.remainingSeconds} seconde(s) avant de publier une nouvelle recherche.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const windowCheck = checkScrimCreationWindowLimit(
      ctx.stmts,
      interaction.user.id,
    );
    if (!windowCheck.ok) {
      const winMin = Math.round(scrimModerationEnvWindowMs() / 60000);
      const winLimit = scrimModerationEnvWindowLimit();
      await interactReply(interaction, {
        content: `❌ Tu as atteint la limite de créations de recherche de scrim (${winLimit} sur ${winMin} minutes). Réessaie un peu plus tard.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const rows = ctx.stmts.listChannelsByGame.all(gameKey);
    if (!rows.length) {
      logger.info('recherche-scrim — aucune cible', {
        game_key: gameKey,
        user_id: interaction.user.id,
      });
      await interactReply(interaction, {
        content:
          '❌ Aucun serveur du réseau n’a configuré de salon de diffusion pour le scrim League of Legends.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interactReply(interaction, {
      content: '⏳ Envoi de l’annonce…',
      flags: MessageFlags.Ephemeral,
    });

    const now = Date.now();
    const originGuild = interaction.guildId ?? 'DM';

    let scheduledAtIso;
    try {
      scheduledAtIso = computeScheduledAtIso(
        dateRes.value,
        timeRes.value,
        now,
      );
    } catch (schedErr) {
      logger.error('recherche-scrim — scheduled_at Europe/Paris', {
        message: schedErr instanceof Error ? schedErr.message : String(schedErr),
      });
      await interactEditReply(interaction, {
        content:
          '❌ Date ou heure invalide pour le calendrier français. Vérifie ta saisie.',
      });
      return;
    }

    /** @type {string | null} */
    let scheduledAtEndIso = null;
    if (flexEndRes.value != null) {
      try {
        scheduledAtEndIso = computeScheduledAtIso(
          dateRes.value,
          flexEndRes.value,
          now,
        );
      } catch (schedEndErr) {
        logger.error('recherche-scrim — scheduled_at_end Europe/Paris', {
          message:
            schedEndErr instanceof Error
              ? schedEndErr.message
              : String(schedEndErr),
        });
        await interactEditReply(interaction, {
          content:
            '❌ Heure max invalide pour le calendrier français. Vérifie ta saisie.',
        });
        return;
      }
    }

    /** @type {{ publicId: number, dbId: number } | null} */
    let created;
    try {
      created = ctx.db.transaction(() => {
        const publicId = allocateScrimPublicId(ctx.stmts);
        if (publicId == null) return null;
        const tagsForInsert = buildScrimTagsJson(
          fearlessStored,
          nombreDeGamesOpt,
          formatRes.value === FORMAT_SCRIM_SERIE_KEY && nombreDeGamesOpt != null,
        );

        const info = ctx.stmts.insertScrimPostRow.run({
          scrim_public_id: publicId,
          author_user_id: interaction.user.id,
          origin_guild_id: originGuild,
          source_guild_id: originGuild,
          game_key: gameKey,
          rank_key: rankRes.value,
          format_key: formatRes.value,
          contact_user_id: contactRes.userId,
          scheduled_date: dateRes.value,
          scheduled_time: timeRes.value,
          scheduled_at: scheduledAtIso,
          scheduled_at_end: scheduledAtEndIso,
          tags: tagsForInsert,
          multi_opgg_url: multiOpggUrl,
          created_at: now,
          status: 'active',
        });
        return {
          publicId,
          dbId: Number(info.lastInsertRowid),
        };
      })();
    } catch (err) {
      logger.error('recherche-scrim — échec création ligne scrim', {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      await interactEditReply(interaction, {
        content:
          '❌ Impossible d’enregistrer la recherche. Réessayez plus tard.',
      });
      return;
    }

    if (!created) {
      await interactEditReply(interaction, { content: MS_TOO_MANY });
      return;
    }

    const rowAfterInsert = ctx.stmts.getScrimPostById.get(created.dbId);
    if (!rowAfterInsert) {
      logger.error('recherche-scrim — ligne scrim introuvable après insert', {
        scrim_post_db_id: created.dbId,
      });
      try {
        ctx.db.transaction((dbId) => {
          ctx.stmts.deleteScrimPostMessagesForPost.run(dbId);
          ctx.stmts.deleteScrimPostById.run(dbId);
        })(created.dbId);
      } catch (delErr) {
        logger.error('recherche-scrim — nettoyage après lecture ligne manquante', {
          scrim_post_db_id: created.dbId,
          message: delErr instanceof Error ? delErr.message : String(delErr),
        });
      }
      await interactEditReply(interaction, {
        content:
          '❌ Impossible de préparer l’annonce. Réessayez plus tard.',
      });
      return;
    }

    /** Même chemin que fermeture / expiration : payload depuis `tags` + colonnes scrim. */
    const embedPayload = {
      ...scrimDbRowToEmbedPayload(rowAfterInsert),
      contactDisplayName: contact.username ?? null,
    };

    /** Nombre de serveurs où l’embed a été posté (best-effort, voir `broadcastScrimRequest`). */
    let successCount = 0;
    try {
      successCount = await broadcastScrimRequest({
        client: interaction.client,
        rows,
        stmts: ctx.stmts,
        authorUserId: interaction.user.id,
        scrimPostDbId: created.dbId,
        payload: embedPayload,
      });
    } catch (err) {
      /** Rare : `broadcastScrimRequest` absorbe d’habitude les erreurs par cible ; ce catch couvre surtout un throw amont (ex. construction embed). */
      logger.error('recherche-scrim — échec diffusion', {
        message: err instanceof Error ? err.message : String(err),
        scrim_post_db_id: created.dbId,
      });
      try {
        ctx.db.transaction((dbId) => {
          ctx.stmts.deleteScrimPostMessagesForPost.run(dbId);
          ctx.stmts.deleteScrimPostById.run(dbId);
        })(created.dbId);
      } catch (delErr) {
        logger.error('recherche-scrim — nettoyage après diffusion', {
          scrim_post_db_id: created.dbId,
          message: delErr instanceof Error ? delErr.message : String(delErr),
        });
      }
      await interactEditReply(interaction, {
        content: `❌ Une erreur est survenue pendant l’envoi (cible : **${rows.length}** serveur configuré(s)). Réessayez plus tard.`,
      });
      return;
    }

    if (successCount === 0) {
      logger.warn('recherche-scrim — zéro livraison', {
        user_id: interaction.user.id,
        guild_id: interaction.guildId,
        game_key: gameKey,
        targets: rows.length,
        scrim_post_db_id: created.dbId,
      });
      try {
        ctx.db.transaction((dbId) => {
          ctx.stmts.deleteScrimPostMessagesForPost.run(dbId);
          ctx.stmts.deleteScrimPostById.run(dbId);
        })(created.dbId);
      } catch (delErr) {
        logger.error('recherche-scrim — rollback scrim sans livraison', {
          scrim_post_db_id: created.dbId,
          message: delErr instanceof Error ? delErr.message : String(delErr),
        });
      }
      await interactEditReply(interaction, {
        content:
          `⚠️ Aucune annonce n’a pu être livrée sur **${rows.length}** serveur(s) configuré(s) (permissions, salons ou blocages). Réessayez plus tard.`,
      });
      return;
    }

    logger.event('recherche-scrim', {
      user_id: interaction.user.id,
      guild_id: interaction.guildId,
      game_key: gameKey,
      targets: rows.length,
      success: successCount,
      scrim_post_db_id: created.dbId,
      scrim_public_id: created.publicId,
    });

    const tipInviteUrl =
      getScrimCommunityServerUrlFromEnv() ?? DEFAULT_SCRIM_COMMUNITY_TIP_URL;

    await interactEditReply(interaction, {
      content: `✅ Ta recherche de scrim est en ligne sur le réseau !

📡 Diffusée dans ${successCount} serveurs

🛑 Quand tu as trouvé un scrim :
/scrim-trouve id:${created.publicId}

💬 Pour ne plus recevoir de messages inutiles et garder les salons propres.

💡 Astuce :

Pour éviter les problèmes de contact, pense à rejoindre le serveur ScrimRéseau :
${tipInviteUrl}
👉 Cela crée un discord commun entre les joueurs.
👉 Tu peux continuer à utiliser le bot normalement depuis ton serveur.`,
    });
      })();
    } finally {
      endScrimRequest(userId);
    }
  },

  /**
   * @param {import('discord.js').AutocompleteInteraction} interaction
   */
  async autocomplete(interaction) {
    let choices = [];
    try {
      const focused = interaction.options.getFocused(true);
      const data = interaction.options.data;
      const dataSerialized = serializeSlashOptionsData(data);
      const gameKeyResolved = resolveGameKeyForAutocomplete(interaction);

      if (isScrimDebugAutocompleteEnabled()) {
        logger.info(DEBUG_AUTOCOMPLETE, {
          commandName: interaction.commandName,
          focusedOptionName: focused.name,
          focusedOptionValue: focused.value,
          optionsData: dataSerialized,
          gameKeyResolvedFromLogic: gameKeyResolved,
        });
      }

      if (focused.name === 'rang') {
        choices = buildRankAutocompleteChoices(gameKeyResolved, focused.value);
      } else if (focused.name === 'format') {
        choices = buildFormatAutocompleteChoices(gameKeyResolved, focused.value);
      } else {
        choices = [];
      }

      if (isScrimDebugAutocompleteEnabled()) {
        logger.info(DEBUG_AUTOCOMPLETE, {
          gameKeyResolved,
          suggestionCount: choices.length,
          preview: choices.slice(0, 3).map((c) => c.value),
        });
      }

      await interactAutocompleteRespond(interaction, choices);
    } catch (err) {
      logger.error('recherche-scrim — autocomplete', {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      try {
        await interactAutocompleteRespond(interaction, []);
      } catch (respondErr) {
        logger.error('recherche-scrim — autocomplete respond impossible', {
          message:
            respondErr instanceof Error ? respondErr.message : String(respondErr),
        });
      }
    }
  },
};
