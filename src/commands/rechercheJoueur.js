import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { broadcastPlayerSearchRequest } from '../services/playerSearchBroadcast.js';
import { playerSearchDbRowToEmbedPayload } from '../services/playerSearchEmbedBuilder.js';
import {
  MS_TOO_MANY,
  rollbackPlayerSearchPostCreation,
} from '../services/playerSearchLifecycle.js';
import { allocatePlayerSearchPublicId } from '../services/playerSearchPublicId.js';
import {
  checkGlobalBlacklist,
  GLOBAL_BLACKLIST_SERVICE_UNAVAILABLE_MESSAGE,
  GLOBAL_BLACKLIST_USER_MESSAGE,
} from '../services/scrimModeration.js';
import {
  collectPlayerSearchRolesFromSlashValues,
  PLAYER_SEARCH_NOMBRE_SLASH_CHOICES,
  PLAYER_SEARCH_RANK_SLASH_CHOICES,
  PLAYER_SEARCH_ROLE_SLASH_CHOICES,
  parsePlayerSearchDate,
  parsePlayerSearchHoraire,
  resolvePlayerSearchRankFromSlashValue,
  validatePlayerSearchRoleCountMatch,
} from '../utils/playerSearchValidation.js';
import { computeScheduledAtIso } from '../utils/scrimScheduledAt.js';
import {
  interactDeferReply,
  interactEditReply,
  interactReply,
} from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

const SESSION_CHOICES = [
  { name: 'Scrim BO1', value: 'Scrim BO1' },
  { name: 'Scrim BO3', value: 'Scrim BO3' },
  { name: 'Scrim BO5', value: 'Scrim BO5' },
  { name: 'Quelques games', value: 'Quelques games' },
  { name: 'Flex', value: 'Flex' },
  { name: 'Clash', value: 'Clash' },
  { name: 'Tournoi', value: 'Tournoi' },
  { name: 'Autre', value: 'Autre' },
];

const AMBIANCE_CHOICES = [
  { name: 'Chill', value: 'Chill' },
  { name: 'Tryhard', value: 'Tryhard' },
  { name: 'Fun', value: 'Fun' },
  { name: 'Chill + Tryhard', value: 'Chill + Tryhard' },
];

const MSG_NO_GUILD =
  '❌ Cette commande doit être utilisée sur un serveur.';
const MSG_NO_CHANNELS =
  '❌ Aucun salon Recherche Joueur n’est configuré sur le réseau. Un admin doit d’abord utiliser `/joueur-config channel set`.';

/**
 * DisplayName Discord du contact (nickname serveur si dispo).
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('discord.js').User} contactUser
 * @returns {Promise<string | null>}
 */
async function resolvePlayerSearchContactDisplayName(interaction, contactUser) {
  if (interaction.inGuild() && interaction.guild) {
    try {
      const member = await interaction.guild.members.fetch(contactUser.id);
      const name = member.displayName?.trim();
      if (name) return name;
    } catch {
      /* fallback ci-dessous */
    }
  }
  const fromUser = contactUser.displayName?.trim();
  return fromUser || null;
}

/**
 * @param {import('discord.js').SlashCommandStringOption} opt
 */
function addRoleChoiceOption(opt, index, required) {
  return opt
    .setName(`role_${index}`)
    .setDescription(
      index === 1
        ? 'Premier rôle recherché'
        : `Rôle supplémentaire ${index} (optionnel)`,
    )
    .setRequired(required)
    .addChoices(...PLAYER_SEARCH_ROLE_SLASH_CHOICES);
}

const commandData = new SlashCommandBuilder()
  .setName('recherche-joueur')
  .setDescription('Publie une recherche de joueur ponctuelle sur le réseau')
  .addIntegerOption((opt) =>
    opt
      .setName('nombre')
      .setDescription('Nombre de joueurs recherchés')
      .setRequired(true)
      .addChoices(...PLAYER_SEARCH_NOMBRE_SLASH_CHOICES),
  )
  .addStringOption((opt) => addRoleChoiceOption(opt, 1, true))
  .addStringOption((opt) =>
    opt
      .setName('rang')
      .setDescription('Niveau recherché')
      .setRequired(true)
      .addChoices(...PLAYER_SEARCH_RANK_SLASH_CHOICES),
  )
  .addStringOption((opt) =>
    opt
      .setName('date')
      .setDescription(
        'Date (aujourd\'hui, demain, JJ/MM, JJ/MM/AAAA, JJ-MM, JJ-MM-AAAA)',
      )
      .setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName('horaire')
      .setDescription('Horaire (ex. 21h, 21h00, 21h-23h)')
      .setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName('session')
      .setDescription('Type de session')
      .setRequired(true)
      .addChoices(...SESSION_CHOICES),
  )
  .addStringOption((opt) =>
    opt
      .setName('ambiance')
      .setDescription('Ambiance recherchée')
      .setRequired(true)
      .addChoices(...AMBIANCE_CHOICES),
  )
  .addStringOption((opt) => addRoleChoiceOption(opt, 2, false))
  .addStringOption((opt) => addRoleChoiceOption(opt, 3, false))
  .addStringOption((opt) => addRoleChoiceOption(opt, 4, false))
  .addStringOption((opt) => addRoleChoiceOption(opt, 5, false))
  .addUserOption((opt) =>
    opt
      .setName('contact')
      .setDescription('Contact (défaut : toi)'),
  );

export const rechercheJoueur = {
  data: commandData,

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{
   *   db: import('better-sqlite3').Database,
   *   stmts: ReturnType<import('../database/db.js')['prepareStatements']>,
   *   playerSearchStmts: ReturnType<import('../database/db.js')['preparePlayerSearchStatements']>,
   * }} ctx
   */
  async execute(interaction, ctx) {
    try {
      if (!interaction.inGuild()) {
        await interactReply(interaction, {
          content: MSG_NO_GUILD,
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

      await interactDeferReply(interaction, { flags: MessageFlags.Ephemeral });

      const rolesRes = collectPlayerSearchRolesFromSlashValues([
        interaction.options.getString('role_1'),
        interaction.options.getString('role_2'),
        interaction.options.getString('role_3'),
        interaction.options.getString('role_4'),
        interaction.options.getString('role_5'),
      ]);
      if (!rolesRes.ok) {
        await interactEditReply(interaction, { content: `❌ ${rolesRes.error}` });
        return;
      }

      const playerCount = interaction.options.getInteger('nombre', true);
      const countMatch = validatePlayerSearchRoleCountMatch(
        playerCount,
        rolesRes.value.length,
      );
      if (!countMatch.ok) {
        await interactEditReply(interaction, { content: `❌ ${countMatch.error}` });
        return;
      }

      const rankRes = resolvePlayerSearchRankFromSlashValue(
        interaction.options.getString('rang', true),
      );
      if (!rankRes.ok) {
        await interactEditReply(interaction, { content: `❌ ${rankRes.error}` });
        return;
      }

      const dateRes = parsePlayerSearchDate(
        interaction.options.getString('date', true),
      );
      if (!dateRes.ok) {
        await interactEditReply(interaction, { content: `❌ ${dateRes.error}` });
        return;
      }

      const horaireRes = parsePlayerSearchHoraire(
        interaction.options.getString('horaire', true),
      );
      if (!horaireRes.ok) {
        await interactEditReply(interaction, { content: `❌ ${horaireRes.error}` });
        return;
      }

      const sessionType = interaction.options.getString('session', true);
      const ambiance = interaction.options.getString('ambiance', true);
      const contactUser = interaction.options.getUser('contact') ?? interaction.user;

      const channelCount =
        ctx.playerSearchStmts.countGuildPlayerSearchChannels.get().n;
      if (!channelCount || Number(channelCount) === 0) {
        await interactEditReply(interaction, { content: MSG_NO_CHANNELS });
        return;
      }

      const rows = ctx.playerSearchStmts.listPlayerSearchChannels.all();
      if (!rows.length) {
        await interactEditReply(interaction, { content: MSG_NO_CHANNELS });
        return;
      }

      const now = Date.now();
      const dateStr = dateRes.value;

      let scheduledAtIso;
      let scheduledAtEndIso = null;
      try {
        scheduledAtIso = computeScheduledAtIso(
          dateStr,
          horaireRes.startNormalized,
          now,
        );
        if (horaireRes.endNormalized) {
          scheduledAtEndIso = computeScheduledAtIso(
            dateStr,
            horaireRes.endNormalized,
            now,
          );
        }
      } catch (schedErr) {
        logger.error('player_search:recherche-joueur — scheduled_at', {
          message: schedErr instanceof Error ? schedErr.message : String(schedErr),
        });
        await interactEditReply(interaction, {
          content:
            '❌ Horaire invalide pour le calendrier français. Vérifie ta saisie.',
        });
        return;
      }

      const originGuild = interaction.guildId;

      /** @type {{ publicId: string, dbId: number } | null} */
      let created;
      try {
        created = ctx.db.transaction(() => {
          const publicId = allocatePlayerSearchPublicId(ctx.playerSearchStmts);
          if (publicId == null) return null;

          const info = ctx.playerSearchStmts.insertPlayerSearchPostRow.run({
            player_search_public_id: publicId,
            author_user_id: interaction.user.id,
            origin_guild_id: originGuild,
            source_guild_id: originGuild,
            roles_json: JSON.stringify(rolesRes.value),
            ranks_json: JSON.stringify(rankRes.value),
            player_count: playerCount,
            session_type: sessionType,
            ambiance,
            description: null,
            contact_user_id: contactUser.id,
            scheduled_date: dateStr,
            scheduled_time: horaireRes.displayTime,
            scheduled_at: scheduledAtIso,
            scheduled_at_end: scheduledAtEndIso,
            tags_json: '{}',
            created_at: now,
            status: 'active',
          });

          return {
            publicId,
            dbId: Number(info.lastInsertRowid),
          };
        })();
      } catch (err) {
        logger.error('player_search:recherche-joueur — insert DB', {
          message: err instanceof Error ? err.message : String(err),
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

      const rowAfterInsert = ctx.playerSearchStmts.getPlayerSearchPostById.get(
        created.dbId,
      );
      if (!rowAfterInsert) {
        rollbackPlayerSearchPostCreation(
          ctx.db,
          ctx.playerSearchStmts,
          created.dbId,
        );
        await interactEditReply(interaction, {
          content:
            '❌ Impossible de préparer l’annonce. Réessayez plus tard.',
        });
        return;
      }

      const embedPayload = {
        ...playerSearchDbRowToEmbedPayload(rowAfterInsert),
        contactDisplayName: await resolvePlayerSearchContactDisplayName(
          interaction,
          contactUser,
        ),
      };

      let successCount = 0;
      try {
        successCount = await broadcastPlayerSearchRequest({
          client: interaction.client,
          rows,
          playerSearchStmts: ctx.playerSearchStmts,
          playerSearchPostDbId: created.dbId,
          payload: embedPayload,
        });
      } catch (err) {
        logger.error('player_search:recherche-joueur — diffusion', {
          message: err instanceof Error ? err.message : String(err),
          player_search_post_db_id: created.dbId,
        });
        rollbackPlayerSearchPostCreation(
          ctx.db,
          ctx.playerSearchStmts,
          created.dbId,
        );
        await interactEditReply(interaction, {
          content: `❌ Une erreur est survenue pendant l’envoi (cible : **${rows.length}** serveur(s)). Réessayez plus tard.`,
        });
        return;
      }

      if (successCount === 0) {
        logger.warn('player_search:recherche-joueur — zéro livraison', {
          user_id: interaction.user.id,
          targets: rows.length,
          player_search_post_db_id: created.dbId,
        });
        rollbackPlayerSearchPostCreation(
          ctx.db,
          ctx.playerSearchStmts,
          created.dbId,
        );
        await interactEditReply(interaction, {
          content: `⚠️ Aucune annonce n’a pu être livrée sur **${rows.length}** serveur(s) configuré(s) (permissions ou salons). Réessayez plus tard.`,
        });
        return;
      }

      logger.event('player_search:recherche-joueur', {
        user_id: interaction.user.id,
        guild_id: interaction.guildId,
        targets: rows.length,
        success: successCount,
        player_search_post_db_id: created.dbId,
        player_search_public_id: created.publicId,
      });

      await interactEditReply(interaction, {
        content: `Recherche joueur publiée.
ID : ${created.publicId}
Pour fermer : /joueur-trouve id:${created.publicId}`,
      });
    } catch (err) {
      logger.error('player_search:recherche-joueur', {
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
