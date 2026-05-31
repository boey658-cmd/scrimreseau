import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { PLAYER_SEARCH_EMBED_COLOR_ACTIVE } from '../services/playerSearchEmbedBuilder.js';
import { assertGuildAdministrator } from '../utils/guildAdministratorGuard.js';
import { interactReply } from '../utils/interactionDiscord.js';

const FIELD_JOUEUR_CONFIG =
  '**• channel → set**\n' +
  'Définit le salon où sont diffusées les annonces Recherche Joueur.\n\n' +
  '**• channel → remove**\n' +
  'Retire ce salon de diffusion.\n\n' +
  '**• view**\n' +
  'Affiche la configuration Recherche Joueur du serveur.';

const FIELD_ISOLATION =
  '• Salon **dédié**, distinct des annonces scrim (`guild_player_search_channels`)\n' +
  '• Les recherches joueur **ne passent jamais** par `guild_game_channels`\n' +
  '• **Aucun repost** automatique\n' +
  '• Expiration automatique **3 h après** l’horaire prévu de la session';

export const helpAdminJoueur = {
  data: new SlashCommandBuilder()
    .setName('helpadmin-joueur')
    .setDescription('Aide admin — configuration Recherche Joueur')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {Record<string, unknown>} _ctx
   */
  async execute(interaction, _ctx) {
    const ok = await assertGuildAdministrator(interaction);
    if (!ok) return;

    const embed = new EmbedBuilder()
      .setTitle('🛠️ ScrimRéseau — Aide Admin Recherche Joueur')
      .setDescription(
        'Configuration du salon dédié aux annonces Recherche Joueur sur votre serveur.',
      )
      .setColor(PLAYER_SEARCH_EMBED_COLOR_ACTIVE)
      .addFields(
        { name: '⚙️ /joueur-config', value: FIELD_JOUEUR_CONFIG },
        { name: '🔒 Isolation scrim', value: FIELD_ISOLATION },
        {
          name: '💡 Conseil',
          value:
            'Un salon dédié clair évite de mélanger scrims et recherches joueur ponctuelles.',
        },
      );

    await interactReply(interaction, {
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
    });
  },
};
