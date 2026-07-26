import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { t } from '../i18n/index.js';
import { interactReply } from './interactionDiscord.js';

/**
 * Vérifie que l'interaction a lieu en guilde et que l'auteur est administrateur.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string} [locale='fr'] Langue pour les messages d'erreur
 * @returns {Promise<boolean>} false si une réponse d'erreur a été envoyée
 */
export async function assertGuildAdministrator(interaction, locale = 'fr') {
  if (!interaction.inGuild()) {
    await interactReply(interaction, {
      content: t(locale, 'generic.guildOnly'),
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }
  if (
    !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  ) {
    await interactReply(interaction, {
      content: t(locale, 'generic.adminOnly'),
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }
  return true;
}
