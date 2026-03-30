import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { interactReply } from './interactionDiscord.js';

const MSG_NEED_GUILD =
  '❌ Cette commande doit être utilisée sur un serveur.';

const MSG_NEED_ADMIN =
  '❌ Tu dois être **administrateur** du serveur pour utiliser cette commande.';

/**
 * Vérifie que l’interaction a lieu en guilde et que l’auteur est administrateur.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @returns {Promise<boolean>} false si une réponse d’erreur a été envoyée
 */
export async function assertGuildAdministrator(interaction) {
  if (!interaction.inGuild()) {
    await interactReply(interaction, {
      content: MSG_NEED_GUILD,
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }
  if (
    !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  ) {
    await interactReply(interaction, {
      content: MSG_NEED_ADMIN,
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }
  return true;
}
