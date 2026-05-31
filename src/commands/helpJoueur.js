import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { PLAYER_SEARCH_EMBED_COLOR_ACTIVE } from '../services/playerSearchEmbedBuilder.js';
import { interactReply } from '../utils/interactionDiscord.js';

export const helpJoueur = {
  data: new SlashCommandBuilder()
    .setName('help-joueur')
    .setDescription('Aide Recherche Joueur — ScrimRéseau'),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {Record<string, unknown>} _ctx
   */
  async execute(interaction, _ctx) {
    const embed = new EmbedBuilder()
      .setTitle('🔎 ScrimRéseau — Recherche Joueur')
      .setDescription(
        'Trouver un ou plusieurs joueurs ponctuellement pour compléter une session.',
      )
      .setColor(PLAYER_SEARCH_EMBED_COLOR_ACTIVE)
      .addFields(
        {
          name: '📢 Commandes',
          value:
            '`/recherche-joueur` → publie une recherche sur le réseau\n' +
            '`/mes-demandes-joueur` → liste tes recherches actives\n' +
            '`/joueur-trouve` → ferme une recherche quand tu as trouvé',
        },
        {
          name: '📌 À savoir',
          value:
            '• Salon dédié configuré par un admin (`/joueur-config`)\n' +
            '• La **date** est obligatoire (aujourd’hui, demain, JJ/MM…)\n' +
            '• Expiration automatique **3 h après** l’horaire prévu\n' +
            '• L’**ID public** (J1, J2…) n’apparaît que dans **ta** réponse éphémère',
        },
      );

    await interactReply(interaction, {
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
    });
  },
};
