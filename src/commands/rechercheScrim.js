import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { UI_PRIMARY_GAME_KEY } from '../config/games.js';
import { broadcastScrimRequest } from '../services/broadcast.js';
import { deliverScrimToDestination } from '../services/scrimDelivery.js';
import { enqueueDiscordTask } from '../services/discordTaskQueue.js';
import { isPersistentBroadcastEnabled } from '../utils/persistentBroadcastFlag.js';
import {
  allocateScrimPublicId,
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
  MAX_ACTIVE_SCRIMS_PER_USER,
  scrimModerationEnvWindowLimit,
  scrimModerationEnvWindowMs,
} from '../services/scrimModeration.js';
import { getGuildLocale, t } from '../i18n/index.js';
import {
  applyDescriptionLocalizations,
  applyOptionLocalizations,
  localizedChoice,
  slashMeta,
} from '../i18n/slashLocalizations.js';
import {
  beginScrimRequest,
  endScrimRequest,
  hasActiveScrimRequest,
} from '../utils/scrimRequestLock.js';
import { validateMultiOpggUrl } from '../utils/validateMultiOpgg.js';
import {
  ELO_PRECISION_OPTIONS,
  normalizeEloPrecision,
} from '../config/eloPrecision.js';
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
 * Traduit un résultat d'erreur de validation.
 * Utilise l'errorCode i18n si disponible ; sinon retourne `❌ ${res.error}`.
 * @param {{ errorCode?: string, error: string }} res
 * @param {string} locale
 */
function validationMsg(res, locale) {
  return res.errorCode ? t(locale, res.errorCode) : `❌ ${res.error}`;
}

/**
 * Génère les suggestions autocomplete pour le champ `structure`.
 * Retourne max 25 guildes partenaires (ayant un salon de réception scrim configuré),
 * filtrées selon la saisie de l'utilisateur.
 *
 * @param {import('discord.js').Client} client
 * @param {ReturnType<import('../database/db.js')['prepareStatements']> | null} stmts
 * @param {string} query valeur tapée par l'utilisateur
 * @returns {{ name: string, value: string }[]}
 */
function buildStructureAutocompleteChoices(client, stmts, query) {
  if (!stmts) return [];
  try {
    const rows = stmts.listDistinctPartnerGuildIds.all();
    const q = query.trim().toLowerCase();
    /** @type {{ name: string, value: string }[]} */
    const choices = [];
    for (const row of rows) {
      const guildId = String(row.guild_id);
      const guild = client.guilds.cache.get(guildId);
      const name = guild?.name ?? guildId;
      if (!q || name.toLowerCase().includes(q)) {
        choices.push({ name, value: guildId });
      }
      if (choices.length >= 25) break;
    }
    return choices;
  } catch (err) {
    logger.warn('structure autocomplete — erreur lecture DB', {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

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

const DEBUG_AUTOCOMPLETE = 'DEBUG find-scrim autocomplete';
const DEBUG_VALIDATION_RANK_FORMAT = 'DEBUG find-scrim validation finale rang/format';

function isScrimDebugAutocompleteEnabled() {
  const v = process.env.SCRIM_DEBUG_AUTOCOMPLETE?.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

export const rechercheScrim = {
  data: (() => {
    const meta = slashMeta.findScrim;
    const eloChoices = ELO_PRECISION_OPTIONS.map((o) => {
      if (o.value === 'none') return localizedChoice(o.value, meta.choices.eloNone);
      if (o.value === 'lp_900_plus') return localizedChoice(o.value, meta.choices.elo900);
      // Low / High / bandes LP : labels gaming EN partagés (naturels pour toutes les locales).
      return { name: o.label, value: o.value };
    });
    return applyDescriptionLocalizations(
      new SlashCommandBuilder()
        .setName('find-scrim')
        .addStringOption((opt) =>
          applyOptionLocalizations(
            opt.setName('rang').setRequired(true).setAutocomplete(true),
            meta.options.rang,
          ),
        )
        .addStringOption((opt) =>
          applyOptionLocalizations(
            opt.setName('date').setRequired(true),
            meta.options.date,
          ),
        )
        .addStringOption((opt) =>
          applyOptionLocalizations(
            opt.setName('heure').setRequired(true),
            meta.options.heure,
          ),
        )
        .addUserOption((opt) =>
          applyOptionLocalizations(
            opt.setName('contact').setRequired(true),
            meta.options.contact,
          ),
        )
        .addStringOption((opt) =>
          applyOptionLocalizations(
            opt.setName('format').setRequired(true).setAutocomplete(true),
            meta.options.format,
          ),
        )
        .addStringOption((opt) =>
          applyOptionLocalizations(
            opt
              .setName('fearless')
              .setRequired(true)
              .addChoices(
                localizedChoice('oui', meta.choices.fearlessOui),
                localizedChoice('non', meta.choices.fearlessNon),
                localizedChoice('nimporte', meta.choices.fearlessAny),
              ),
            meta.options.fearless,
          ),
        )
        .addStringOption((opt) =>
          applyOptionLocalizations(
            opt.setName('elo_precision').setRequired(false).addChoices(...eloChoices),
            meta.options.elo_precision,
          ),
        )
        .addStringOption((opt) =>
          applyOptionLocalizations(
            opt.setName('heure_max_debut').setRequired(false),
            meta.options.heure_max_debut,
          ),
        )
        .addStringOption((opt) =>
          applyOptionLocalizations(
            opt.setName('multi_opgg').setRequired(false),
            meta.options.multi_opgg,
          ),
        )
        .addStringOption((opt) =>
          applyOptionLocalizations(
            opt.setName('structure').setRequired(false).setAutocomplete(true),
            meta.options.structure,
          ),
        )
        .addIntegerOption((opt) =>
          applyOptionLocalizations(
            opt
              .setName('nombre_de_games')
              .setRequired(false)
              .addChoices(
                ...NOMBRE_DE_GAMES_CHOICES.map((n) => ({ name: String(n), value: n })),
              ),
            meta.options.nombre_de_games,
          ),
        ),
      meta.description,
    );
  })(),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} ctx
   */
  async execute(interaction, ctx) {
    const userId = interaction.user.id;
    const locale = getGuildLocale(interaction.guildId, ctx.stmts);

    if (hasActiveScrimRequest(userId)) {
      await interactReply(interaction, {
        content: t(locale, 'findScrim.lock'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    beginScrimRequest(userId);
    try {
      return await (async () => {
    const locale = getGuildLocale(interaction.guildId, ctx.stmts);
    if (!interaction.inGuild()) {
      await interactReply(interaction, {
        content: t(locale, 'findScrim.guildOnly'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const publicGuildGate = await checkScrimReseauPublicGuildMembership(
      interaction.client,
      interaction.user.id,
      locale,
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
        content: t(locale, 'generic.blacklistServiceUnavailable'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (blState.result === 'blocked') {
      await interactReply(interaction, {
        content: t(locale, 'generic.blacklistedUser'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guildId = interaction.guildId;
    const channelCheck = checkScrimChannel(
      guildId,
      interaction.channel,
      ctx.stmts,
      locale,
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
      locale,
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
    const eloPrecisionRaw = interaction.options.getString('elo_precision');
    const eloPrecision = normalizeEloPrecision(eloPrecisionRaw);

    const dateRes = parseScrimSearchDate(dateRaw);
    if (!dateRes.ok) {
      await interactReply(interaction, { content: validationMsg(dateRes, locale), flags: MessageFlags.Ephemeral });
      return;
    }

    const timeRes = parseAndNormalizeTime(timeRaw);
    if (!timeRes.ok) {
      await interactReply(interaction, { content: validationMsg(timeRes, locale), flags: MessageFlags.Ephemeral });
      return;
    }

    const flexEndRes = validateOptionalFlexibleEndTime(timeRes.value, timeMaxRaw);
    if (!flexEndRes.ok) {
      await interactReply(interaction, {
        content: validationMsg(flexEndRes, locale),
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
      await interactReply(interaction, { content: validationMsg(rankRes, locale), flags: MessageFlags.Ephemeral });
      return;
    }

    if (!formatRes.ok) {
      await interactReply(interaction, { content: validationMsg(formatRes, locale), flags: MessageFlags.Ephemeral });
      return;
    }

    const fearlessStored = fearlessRaw.trim().toLowerCase();

    const nombreDeGamesOpt = interaction.options.getInteger('nombre_de_games');
    if (nombreDeGamesOpt != null && formatRes.value !== FORMAT_SCRIM_SERIE_KEY) {
      await interactReply(interaction, {
        content:
          t(locale, 'findScrim.nombreDeGamesFormat'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const contactRes = validateContactUser(contact);
    if (!contactRes.ok) {
      await interactReply(interaction, { content: validationMsg(contactRes, locale), flags: MessageFlags.Ephemeral });
      return;
    }

    const multiOpggRes = validateMultiOpggUrl(multiOpggRaw, gameKey);
    if (!multiOpggRes.ok) {
      await interactReply(interaction, {
        content: validationMsg(multiOpggRes, locale),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const multiOpggUrl = multiOpggRes.value;

    // ── Structure partenaire (optionnelle) ──────────────────────────────
    const structureRaw = interaction.options.getString('structure');
    /** @type {string | null} */
    let structureGuildId = null;
    /** @type {string | null} */
    let structureNameSnapshot = null;
    /** @type {string | null} */
    let structureInviteUrlSnapshot = null;

    if (structureRaw) {
      const partnerRow = ctx.stmts.getPartnerGuildByGuildId.get(structureRaw.trim());
      if (!partnerRow) {
        await interactReply(interaction, {
          content: t(locale, 'findScrim.structureInvalid'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      structureGuildId = structureRaw.trim();
      const structureGuild = interaction.client.guilds.cache.get(structureGuildId);
      structureNameSnapshot = structureGuild?.name ?? structureGuildId;
      // Snapshot du lien Discord au moment de la création (stable même si retiré ensuite)
      const linkRow = ctx.stmts.getStructureDiscordLink.get(structureGuildId);
      structureInviteUrlSnapshot = (linkRow?.discord_invite_url ?? null) || null;
    }

    const activeLimit = checkActiveScrimLimit(ctx.stmts, interaction.user.id);
    if (!activeLimit.ok) {
      await interactReply(interaction, {
        content: t(locale, 'findScrim.activeLimit', { max: MAX_ACTIVE_SCRIMS_PER_USER }),
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
        content: t(locale, 'findScrim.cooldown', { seconds: burst.remainingSeconds }),
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
        content: t(locale, 'findScrim.windowLimit', { limit: winLimit, min: winMin }),
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
          t(locale, 'findScrim.noTargets'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interactReply(interaction, {
      content: t(locale, 'findScrim.sending'),
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
          t(locale, 'findScrim.scheduledAtError'),
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
            t(locale, 'findScrim.scheduledAtEndError'),
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
          contact_display_name: contact.username ?? null,
          scheduled_date: dateRes.value,
          scheduled_time: timeRes.value,
          scheduled_at: scheduledAtIso,
          scheduled_at_end: scheduledAtEndIso,
          tags: tagsForInsert,
          multi_opgg_url: multiOpggUrl,
          elo_precision: eloPrecision,
          structure_guild_id: structureGuildId,
          structure_name_snapshot: structureNameSnapshot,
          structure_invite_url_snapshot: structureInviteUrlSnapshot,
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
          t(locale, 'findScrim.dbError'),
      });
      return;
    }

    if (!created) {
      await interactEditReply(interaction, { content: t(locale, 'lifecycle.tooMany') });
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
          t(locale, 'findScrim.prepareError'),
      });
      return;
    }

    /** Même chemin que fermeture / expiration : payload depuis `tags` + colonnes scrim (dont contact_display_name). */
    const embedPayload = scrimDbRowToEmbedPayload(rowAfterInsert);

    if (isPersistentBroadcastEnabled()) {
      // PARCOURS PERSISTANT
      let batchId;
      try {
        const batchResult = ctx.db.transaction(() => {
          const nowStr = new Date().toISOString();
          const batchInfo = ctx.stmts.insertScrimBroadcastBatch.run({
            scrim_post_db_id: created.dbId,
            operation_type: 'initial',
            generation: 0,
            target_count: rows.length,
            created_at: nowStr,
            updated_at: nowStr,
          });
          const newBatchId = Number(batchInfo.lastInsertRowid);

          for (const r of rows) {
            const isOrigin = r.guild_id === originGuild;
            ctx.stmts.insertScrimBroadcastDelivery.run({
              batch_id: newBatchId,
              scrim_post_db_id: created.dbId,
              guild_id: r.guild_id,
              channel_id: r.channel_id,
              game_key: r.game_key ?? gameKey,
              operation_type: 'initial',
              generation: 0,
              priority: isOrigin ? 1 : 0,
              next_attempt_at: nowStr,
              created_at: nowStr,
              updated_at: nowStr,
            });
          }

          return newBatchId;
        })();
        batchId = batchResult;
      } catch (batchErr) {
        logger.error('recherche-scrim persistent — échec création batch', {
          scrim_post_db_id: created.dbId,
          message: batchErr instanceof Error ? batchErr.message : String(batchErr),
        });
        try {
          ctx.db.transaction((dbId) => {
            ctx.stmts.deleteScrimPostMessagesForPost.run(dbId);
            ctx.stmts.deleteScrimPostById.run(dbId);
          })(created.dbId);
        } catch { /* best effort */ }
        await interactEditReply(interaction, { content: t(locale, 'findScrim.dbError') });
        return;
      }

      // Bootstrap — essayer destinations jusqu'au premier succès
      const deliveries = ctx.stmts.listDeliveriesForBatch.all(batchId);
      let firstSuccess = false;
      const nowBootstrap = new Date().toISOString();

      for (let i = 0; i < deliveries.length; i++) {
        let result;
        try {
          const { runWithReservedBroadcastSlot, BROADCAST_POOL_STOPPING } = await import('../services/scrimBroadcastExecutionPool.js');
          result = await runWithReservedBroadcastSlot(async (token) => {
            const claimed = ctx.stmts.claimNextDeliveryForBatch.get({
              batch_id: batchId,
              now_iso: nowBootstrap,
              claimed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
            if (!claimed) {
              return { outcome: 'cancelled', _noClaim: true };
            }
            token.bindDelivery(Number(claimed.id));
            const delivRowInner = { guild_id: claimed.guild_id, channel_id: claimed.channel_id };
            const deliveryResult = await deliverScrimToDestination({
              client: interaction.client,
              stmts: ctx.stmts,
              row: delivRowInner,
              authorUserId: interaction.user.id,
              payload: embedPayload,
              delayMs: 0,
              sendMode: 'direct',
              discordMaxAttempts: 2,
              deliveryId: Number(claimed.id),
            });
            return { ...deliveryResult, _claimed: claimed, _delivRow: delivRowInner };
          });
        } catch (poolErr) {
          const code = poolErr && typeof poolErr === 'object' && 'code' in poolErr
            ? /** @type {{ code?: string }} */ (poolErr).code
            : undefined;
          logger.info('recherche-scrim persistent — slot pool indisponible / shutdown', {
            message: poolErr instanceof Error ? poolErr.message : String(poolErr),
            code: code ?? null,
            stopping: code === 'BROADCAST_POOL_STOPPING',
          });
          // Aucune delivery claimée — arrêter le bootstrap proprement
          break;
        }

        if (result && result._noClaim) break;
        const claimedDelivery = result._claimed;
        const delivRow = result._delivRow;
        if (!claimedDelivery) continue;

        const nowAfter = new Date().toISOString();

        if (result.outcome === 'sent') {
          try {
            ctx.db.transaction(() => {
              ctx.stmts.insertScrimPostMessage.run({
                scrim_post_db_id: created.dbId,
                guild_id: delivRow.guild_id,
                channel_id: delivRow.channel_id,
                message_id: result.message.id,
              });
              const markInfo = ctx.stmts.markDeliverySent.run({
                id: claimedDelivery.id,
                message_id: result.message.id,
                completed_at: nowAfter,
                updated_at: nowAfter,
              });
              if (markInfo.changes === 0) {
                throw new Error('markDeliverySent refused (not processing)');
              }
              ctx.stmts.setScrimBroadcastBatchActive.run({
                id: batchId,
                started_at: nowAfter,
                updated_at: nowAfter,
              });
            })();
            firstSuccess = true;
            logger.info('recherche-scrim persistent — première livraison confirmée', {
              scrim_post_db_id: created.dbId,
              batch_id: batchId,
              guild_id: delivRow.guild_id,
              message_id: result.message.id,
            });
            break;
          } catch (dbErr) {
            logger.error('recherche-scrim persistent — DB échouée après send', {
              scrim_post_db_id: created.dbId,
              guild_id: delivRow.guild_id,
              message_id: result.message.id,
              message: dbErr instanceof Error ? dbErr.message : String(dbErr),
            });
            try {
              await enqueueDiscordTask(
                () => result.message.delete(),
                { kind: 'persistent_bootstrap_rollback', guild_id: delivRow.guild_id },
                'high',
              );
            } catch { /* best effort */ }
            try {
              const unkInfo = ctx.stmts.markDeliveryUnknownOutcome.run({
                id: claimedDelivery.id,
                last_error_code: 'DB_INSERT_FAILED',
                last_error_message: (dbErr instanceof Error ? dbErr.message : String(dbErr)).slice(0, 200),
                completed_at: nowAfter,
                updated_at: nowAfter,
              });
              if (unkInfo.changes === 0) {
                logger.info('recherche-scrim persistent — markDeliveryUnknownOutcome (DB fail) sans effet', {
                  delivery_id: claimedDelivery.id,
                });
              }
            } catch { /* best effort */ }
          }
        } else if (result.outcome === 'terminal_error' || result.outcome === 'blocked') {
          const termInfo = ctx.stmts.markDeliveryTerminal.run({
            id: claimedDelivery.id,
            last_error_code: result.errorCode ?? 'TERMINAL',
            last_error_message: (result.errorMessage ?? '').slice(0, 200),
            completed_at: nowAfter,
            updated_at: nowAfter,
          });
          if (termInfo.changes === 0) {
            logger.info('recherche-scrim persistent — markDeliveryTerminal sans effet', {
              delivery_id: claimedDelivery.id,
              outcome: result.outcome,
            });
          }
        } else if (result.outcome === 'retryable_error') {
          const retryInfo = ctx.stmts.markDeliveryRetry.run({
            id: claimedDelivery.id,
            next_attempt_at: new Date(Date.now() + 60000).toISOString(),
            last_error_code: result.errorCode ?? 'RETRYABLE',
            last_error_message: (result.errorMessage ?? '').slice(0, 200),
            updated_at: nowAfter,
          });
          if (retryInfo.changes === 0) {
            logger.info('recherche-scrim persistent — markDeliveryRetry sans effet', {
              delivery_id: claimedDelivery.id,
            });
          }
        } else if (result.outcome === 'unknown_outcome') {
          const unkInfo = ctx.stmts.markDeliveryUnknownOutcome.run({
            id: claimedDelivery.id,
            last_error_code: result.errorCode ?? 'SEND_AMBIGUOUS',
            last_error_message: (result.errorMessage ?? '').slice(0, 200),
            completed_at: nowAfter,
            updated_at: nowAfter,
          });
          if (unkInfo.changes === 0) {
            logger.info('recherche-scrim persistent — markDeliveryUnknownOutcome sans effet', {
              delivery_id: claimedDelivery.id,
            });
          }
        } else if (result.outcome === 'cancelled') {
          // Aligné processDelivery — deliverScrimToDestination ne produit pas cancelled aujourd’hui.
          const cancelInfo = ctx.stmts.markDeliveryCancelled.run({
            id: claimedDelivery.id,
            completed_at: nowAfter,
            updated_at: nowAfter,
          });
          if (cancelInfo.changes === 0) {
            logger.info('recherche-scrim persistent — markDeliveryCancelled sans effet', {
              delivery_id: claimedDelivery.id,
            });
          }
        } else {
          // Outcome réellement inconnu — ne pas laisser processing
          const unkInfo = ctx.stmts.markDeliveryUnknownOutcome.run({
            id: claimedDelivery.id,
            last_error_code: 'UNEXPECTED_OUTCOME',
            last_error_message: `outcome=${String(result.outcome)}`.slice(0, 200),
            completed_at: nowAfter,
            updated_at: nowAfter,
          });
          if (unkInfo.changes === 0) {
            logger.info('recherche-scrim persistent — markDeliveryUnknownOutcome sans effet', {
              delivery_id: claimedDelivery.id,
              outcome: result.outcome,
            });
          }
        }
      }

      if (!firstSuccess) {
        try {
          ctx.db.transaction((dbId) => {
            ctx.stmts.cancelPendingDeliveriesForScrim.run({
              scrim_post_db_id: dbId,
              completed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
            ctx.stmts.setScrimBroadcastBatchCompleted.run({
              id: batchId,
              status: 'failed',
              completed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
            ctx.stmts.deleteScrimPostMessagesForPost.run(dbId);
            ctx.stmts.deleteScrimPostById.run(dbId);
          })(created.dbId);
        } catch (cleanErr) {
          logger.error('recherche-scrim persistent — rollback échoué', {
            scrim_post_db_id: created.dbId,
            message: cleanErr instanceof Error ? cleanErr.message : String(cleanErr),
          });
        }
        await interactEditReply(interaction, {
          content: t(locale, 'findScrim.bootstrapZeroDelivery', { targetCount: rows.length }),
        });
        return;
      }

      const tipInviteUrlP = getScrimCommunityServerUrlFromEnv() ?? DEFAULT_SCRIM_COMMUNITY_TIP_URL;
      await interactEditReply(interaction, {
        content: t(locale, 'findScrim.successPersistent', {
          targetCount: rows.length,
          id: created.publicId,
          url: tipInviteUrlP,
        }),
      });

      logger.event('recherche-scrim-persistent', {
        user_id: interaction.user.id,
        guild_id: interaction.guildId,
        game_key: gameKey,
        targets: rows.length,
        batch_id: batchId,
        scrim_post_db_id: created.dbId,
        scrim_public_id: created.publicId,
      });

      try {
        const jobMod = await import('./scrimBroadcastDeliveryJob.js').catch(() => null);
        jobMod?.wakeScrimBroadcastDeliveryJob?.();
      } catch { /* best effort */ }

    } else {
      // ANCIEN PARCOURS (inchangé)
      /** Nombre de serveurs où l'embed a été posté (best-effort, voir broadcastScrimRequest). */
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
        /** Rare : broadcastScrimRequest absorbe d'habitude les erreurs par cible. */
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
          content: t(locale, 'findScrim.broadcastError', { count: rows.length }),
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
            t(locale, 'findScrim.zeroDelivery', { count: rows.length }),
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
        content: t(locale, 'findScrim.success', { count: successCount, id: created.publicId, url: tipInviteUrl }),
      });
    }
      })();
    } finally {
      endScrimRequest(userId);
    }
  },

  /**
   * @param {import('discord.js').AutocompleteInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} [ctx]
   */
  async autocomplete(interaction, ctx) {
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
      } else if (focused.name === 'structure') {
        choices = buildStructureAutocompleteChoices(
          interaction.client,
          ctx?.stmts ?? null,
          focused.value,
        );
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
