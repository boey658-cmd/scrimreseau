import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { getEmbedColorForGame } from '../config/gameEmbedColors.js';
import { interactReply } from '../utils/interactionDiscord.js';

const EMBED_COLOR = getEmbedColorForGame('');

export const help = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Aide générale sur ScrimRéseau'),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} _ctx
   */
  async execute(interaction, _ctx) {
    const embed = new EmbedBuilder()
      .setTitle('🎮 ScrimRéseau — Aide')
      .setColor(EMBED_COLOR)
      .addFields(
        {
          name: '📢 Trouver un scrim',
          value:
            '`/recherche-scrim` → publie une recherche de scrim dans le réseau\n' +
            '`/liste-scrims` → affiche les scrims actuellement disponibles selon tes filtres',
        },
        {
          name: '📌 Gérer tes scrims',
          value:
            '`/mes-demandes` → affiche tes demandes de scrim en cours\n' +
            '`/scrim-trouve` → ferme une de tes demandes quand tu as trouvé un scrim',
        },
        {
          name: '💡 Astuce',
          value:
            'Les scrims expirent automatiquement une fois la date/heure dépassée, et les messages sont ensuite nettoyés pour garder les salons lisibles.',
        },
      );

    await interactReply(interaction, {
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
    });
  },
};
