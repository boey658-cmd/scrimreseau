import { MessageFlags } from 'discord.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ playerSearchStmts: ReturnType<import('../database/db.js')['preparePlayerSearchStatements']> }} ctx
 */
export async function executeRemoveJoueurChannelCore(interaction, ctx) {
  if (!interaction.inGuild()) {
    await interactReply(interaction, {
      content: '❌ Cette commande doit être utilisée sur un serveur.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const info = ctx.playerSearchStmts.deleteGuildPlayerSearchChannel.run(
    interaction.guildId,
  );
  const removed = info.changes > 0;

  logger.info('player_search:remove-channel', {
    guild_id: interaction.guildId,
    removed,
    user_id: interaction.user.id,
  });

  if (!removed) {
    await interactReply(interaction, {
      content: 'ℹ️ Aucun salon Recherche Joueur n’était configuré sur ce serveur.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interactReply(interaction, {
    content: '✅ Le salon Recherche Joueur a été supprimé.',
    flags: MessageFlags.Ephemeral,
  });
}
