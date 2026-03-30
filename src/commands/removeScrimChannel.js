import { MessageFlags } from 'discord.js';
import { UI_PRIMARY_GAME_KEY } from '../config/games.js';
import { interactReply } from '../utils/interactionDiscord.js';
import { logger } from '../utils/logger.js';

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ stmts: ReturnType<import('../database/db.js')['prepareStatements']> }} ctx
 */
export async function executeRemoveScrimChannelCore(interaction, ctx) {
  if (!interaction.inGuild()) {
    await interactReply(interaction, {
      content: '❌ Cette commande doit être utilisée sur un serveur.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const gameKey = UI_PRIMARY_GAME_KEY;

  const info = ctx.stmts.deleteGuildChannel.run(interaction.guildId, gameKey);
  const removed = info.changes > 0;

  logger.info('remove-scrim-channel', {
    guild_id: interaction.guildId,
    game_key: gameKey,
    removed,
    user_id: interaction.user.id,
  });

  if (!removed) {
    await interactReply(interaction, {
      content:
        'ℹ️ Aucun salon de diffusion des scrims League of Legends n’était configuré sur ce serveur.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interactReply(interaction, {
    content:
      '✅ Le salon de diffusion des scrims League of Legends a été supprimé.',
    flags: MessageFlags.Ephemeral,
  });
}
