import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { getEmbedColorForGame } from '../config/gameEmbedColors.js';
import { assertGuildAdministrator } from '../utils/guildAdministratorGuard.js';
import { interactReply } from '../utils/interactionDiscord.js';

const EMBED_COLOR = getEmbedColorForGame('');

const FIELD_SCRIM_CONFIG =
  '**• channel → set**\n' +
  'Définit le salon où sont diffusées les annonces de scrim League of Legends.\n\n' +
  '**• channel → remove**\n' +
  'Retire ce salon de diffusion.\n\n' +
  '**• command-channel → set**\n' +
  'Limite l’utilisation de `/recherche-scrim` à un salon précis.\n\n' +
  '**• command-channel → reset**\n' +
  'Supprime cette restriction (commande utilisable partout selon la config).\n\n' +
  '**• permissions → set**\n' +
  'Définit qui peut utiliser `/recherche-scrim` (tout le monde ou rôles précis).\n\n' +
  '**• permissions → remove**\n' +
  'Supprime la restriction de permissions.\n\n' +
  '**• view**\n' +
  'Affiche la configuration actuelle du serveur.';

const FIELD_MODERATION =
  '**• user → bloquer**\n' +
  'Empêche un utilisateur d’utiliser les scrims sur ce serveur.\n\n' +
  '**• user → débloquer**\n' +
  'Réautorise un utilisateur.';

const FIELD_SPAMMER =
  'Commande admin pour signaler un joueur pour spam de scrims.\n\n' +
  'Le bot applique des vérifications :\n' +
  '- impossible de se signaler soi-même\n' +
  '- impossible de signaler un bot\n' +
  '- protections anti-abus';

const FIELD_BONNES_PRATIQUES =
  '- Vérifiez que le bot peut envoyer **et** modifier ses messages\n' +
  '- Évitez de supprimer les messages du bot sauf nécessité\n' +
  '- Gardez un seul salon scrim propre et lisible\n' +
  '- Vérifiez régulièrement la configuration avec `/scrim-config view`';

export const helpAdmin = {
  data: new SlashCommandBuilder()
    .setName('helpadmin')
    .setDescription('Aide administrateur — configuration et modération')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} _ctx
   */
  async execute(interaction, _ctx) {
    const ok = await assertGuildAdministrator(interaction);
    if (!ok) return;

    const embed = new EmbedBuilder()
      .setTitle('🛠️ ScrimRéseau — Aide Admin')
      .setDescription(
        'Configuration et modération du réseau de scrims pour votre serveur.',
      )
      .setColor(EMBED_COLOR)
      .addFields(
        { name: '⚙️ /scrim-config', value: FIELD_SCRIM_CONFIG },
        {
          name: '🛡️ /scrim-moderation',
          value: 'Modération locale des scrims :\n\n' + FIELD_MODERATION,
        },
        { name: '🚨 /spammer', value: FIELD_SPAMMER },
        { name: '⚠️ Bonnes pratiques', value: FIELD_BONNES_PRATIQUES },
        {
          name: '💡 Conseil',
          value: 'Un bon setup = un salon clair + permissions bien définies',
        },
      );

    await interactReply(interaction, {
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
    });
  },
};
