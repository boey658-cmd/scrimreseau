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

const FIELD_SCRIM_CONFIGURER =
  `Ouvre le panneau de configuration interactif ScrimRéseau.\n\n` +
  `**📢 Salons** — salon des annonces (diffusion scrims) et salon des commandes (\`/recherche-scrim\`).\n\n` +
  `**🔑 Permissions** — rôles autorisés à utiliser \`/recherche-scrim\`, ou tout le monde.\n\n` +
  `**💬 Messages** — comportement des messages de scrims terminés ou remplacés (garder / supprimer).\n\n` +
  `**🔄 Réinitialiser** — réinitialise un paramètre ou toute la configuration (confirmation requise).\n\n` +
  `Le panneau est éphémère, interactif, et expire après 10 minutes.`;

const FIELD_MODERATION =
  `**• user → bloquer**\n` +
  `Empêche un utilisateur d'utiliser les scrims sur ce serveur.\n\n` +
  `**• user → débloquer**\n` +
  `Réautorise un utilisateur.`;

const FIELD_SPAMMER =
  `Commande admin pour signaler un joueur pour spam de scrims.\n\n` +
  `Le bot applique des vérifications :\n` +
  `- impossible de se signaler soi-même\n` +
  `- impossible de signaler un bot\n` +
  `- protections anti-abus`;

const FIELD_BONNES_PRATIQUES =
  `- Vérifiez que le bot peut envoyer **et** modifier ses messages\n` +
  `- Évitez de supprimer les messages du bot sauf nécessité\n` +
  `- Gardez un seul salon scrim propre et lisible\n` +
  `- Utilisez \`/scrim-configurer\` pour vérifier et ajuster la configuration`;

export const helpAdmin = {
  data: new SlashCommandBuilder()
    .setName('helpadmin-scrim')
    .setDescription(`Aide administrateur — configuration et modération scrim`)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']>, db: import('better-sqlite3').Database }} _ctx
   */
  async execute(interaction, _ctx) {
    const ok = await assertGuildAdministrator(interaction);
    if (!ok) return;

    const embed = new EmbedBuilder()
      .setTitle(`🛠️ ScrimRéseau — Aide Admin`)
      .setDescription(
        `Configuration et modération du réseau de scrims pour votre serveur.`,
      )
      .setColor(EMBED_COLOR)
      .addFields(
        { name: `⚙️ /scrim-configurer`, value: FIELD_SCRIM_CONFIGURER },
        {
          name: `🛡️ /scrim-moderation`,
          value: `Modération locale des scrims :\n\n` + FIELD_MODERATION,
        },
        { name: `🚨 /spammer`, value: FIELD_SPAMMER },
        { name: `⚠️ Bonnes pratiques`, value: FIELD_BONNES_PRATIQUES },
        {
          name: `💡 Conseil`,
          value: `Un bon setup = un salon clair + permissions bien définies`,
        },
      );

    await interactReply(interaction, {
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
    });
  },
};
